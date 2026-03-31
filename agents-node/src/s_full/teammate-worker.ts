#!/usr/bin/env node
/**
 * teammate-worker.ts - Worker process for autonomous teammates
 *
 * Runs as a child process. Uses ToolLoader with 'child' scope to get
 * available tools. All communication goes through the lead process
 * via IPC (process.send/on('message')).
 *
 * Lifecycle:
 *   1. Parent sends {type: 'spawn', name, role, prompt, teamName}
 *   2. Worker runs teammate loop (work/idle phases)
 *   3. Worker reports status changes via {type: 'status', status}
 *   4. Parent can send messages via {type: 'message', from, content, msgType}
 *   5. Worker exits on shutdown or idle timeout
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { type Message, type Tool } from 'ollama';
import { ollama, MODEL } from '../ollama.js';
import { type ToolDefinition, type AgentContext } from './types.js';
import { createContext } from './context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKDIR = process.cwd();
const POLL_INTERVAL = 5000; // 5 seconds
const IDLE_TIMEOUT = 60000; // 60 seconds

// IPC Message types
type ParentMessage =
  | { type: 'spawn'; name: string; role: string; prompt: string; teamName: string }
  | { type: 'message'; from: string; content: string; msgType: string }
  | { type: 'shutdown' };

type ChildMessage =
  | { type: 'status'; status: 'working' | 'idle' | 'shutdown' }
  | { type: 'message'; to: string; content: string; msgType: string }
  | { type: 'log'; message: string }
  | { type: 'error'; error: string };

// State
let teammateName: string = '';
let teammateRole: string = '';
let teamName: string = '';
let inboxMessages: ParentMessage[] = [];

// === IPC helpers ===
function sendMessage(to: string, content: string, msgType: string = 'message'): void {
  process.send?.({ type: 'message', to, content, msgType } as ChildMessage);
}

function sendLog(message: string): void {
  process.send?.({ type: 'log', message } as ChildMessage);
}

function sendError(error: string): void {
  process.send?.({ type: 'error', error } as ChildMessage);
}

function sendStatus(status: 'working' | 'idle' | 'shutdown'): void {
  process.send?.({ type: 'status', status } as ChildMessage);
}

// === ToolLoader for child processes ===
class ChildToolLoader {
  private tools: Map<string, ToolDefinition> = new Map();

  async loadAll(toolsDir: string): Promise<void> {
    const files = await import('fs').then((fs) =>
      fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js'))
    );
    for (const file of files) {
      try {
        const modulePath = path.join(toolsDir, file);
        const module = await import(`file://${modulePath}`);
        const tool = module.default || Object.values(module).find(
          (v) => typeof v === 'object' && v !== null && 'name' in v && 'handler' in v
        );
        if (tool && typeof tool === 'object' && 'name' in tool && 'handler' in tool) {
          const def = tool as ToolDefinition;
          if (def.scope.includes('child')) {
            this.tools.set(def.name, def);
          }
        }
      } catch {
        // Skip modules that fail to load
      }
    }
  }

  getTools(): Tool[] {
    return Array.from(this.tools.values()).map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  execute(ctx: AgentContext, name: string, args: Record<string, unknown>): string | Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Unknown tool: ${name}`;
    return tool.handler(ctx, args);
  }
}

// === Identity re-injection after compression ===
function makeIdentityBlock(name: string, role: string, team: string): Message {
  return {
    role: 'user',
    content: `<identity>You are '${name}', role: ${role}, team: ${team}. Continue your work.</identity>`,
  };
}

// === Create child context with IPC-aware handlers ===
function createChildContext(): AgentContext {
  const base = createContext();

  // Override teammateManager methods to use IPC
  base.teammateManager.sendTo = (to: string, content: string, msgType?: string) => {
    sendMessage(to, content, msgType || 'message');
  };

  return base;
}

// === Main teammate loop ===
async function teammateLoop(prompt: string, ctx: AgentContext, loader: ChildToolLoader): Promise<void> {
  const sysPrompt = `You are '${teammateName}', role: ${teammateRole}, team: ${teamName}, at ${WORKDIR}.
Use idle tool when you have no more work. You will auto-claim new tasks during idle phase.
Available tools: bash, read_file, write_file, edit_file, todo_write, load_skill, compress, task_list, task_get, task_create, task_update, claim_task, send_message, read_inbox, idle.`;

  const messages: Message[] = [{ role: 'user', content: prompt }];
  const tools = loader.getTools();

  sendStatus('working');

  while (true) {
    // === WORK PHASE ===
    let idleRequested = false;

    // Process queued inbox messages before work
    // Atomically drain all messages from inbox (safe in single-threaded Node.js)
    const pendingMessages = [...inboxMessages];
    inboxMessages = [];

    for (const msg of pendingMessages) {
      if (msg.type === 'message') {
        messages.push({
          role: 'user',
          content: JSON.stringify({ type: msg.msgType, from: msg.from, content: msg.content }),
        });
      }
    }

    // Check for shutdown before work
    const hasShutdown = pendingMessages.some((m) => m.type === 'shutdown');
    if (hasShutdown) {
      sendStatus('shutdown');
      process.exit(0);
    }

    // Work loop
    while (true) {
      try {
        const response = await ollama.chat({
          model: MODEL,
          messages: [{ role: 'system', content: sysPrompt }, ...messages],
          tools,
        });

        const assistantMessage = response.message;
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: assistantMessage.tool_calls,
        });

        // No tool calls = work done
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          break;
        }

        // Execute all tool calls
        for (const toolCall of assistantMessage.tool_calls) {
          const args = toolCall.function.arguments as Record<string, unknown>;
          const toolName = toolCall.function.name;

          let output: string;

          // Special handling for IPC-dependent tools
          if (toolName === 'idle') {
            idleRequested = true;
            output = 'Entering idle phase. Will poll for new tasks.';
          } else if (toolName === 'claim_task') {
            // Inject owner name for claim
            args._owner = teammateName;
            output = await loader.execute(ctx, toolName, args);
          } else if (toolName === 'read_inbox') {
            // Drain inbox messages (atomically copy and clear)
            const allMsgs = [...inboxMessages];
            inboxMessages = [];
            const msgs = allMsgs
              .filter((m) => m.type === 'message')
              .map((m) => ({
                type: (m as { msgType: string }).msgType,
                from: (m as { from: string }).from,
                content: (m as { content: string }).content,
              }));
            output = msgs.length > 0 ? JSON.stringify(msgs, null, 2) : 'Inbox is empty.';
          } else {
            // All other tools go through loader
            output = await loader.execute(ctx, toolName, args);
          }

          sendLog(`${toolName}: ${output.slice(0, 100)}`);
          messages.push({
            role: 'tool',
            content: `tool call ${toolName} finished. ${output}`,
          });
        }

        if (idleRequested) {
          break;
        }
      } catch (err) {
        sendError((err as Error).message);
        return;
      }
    }

    // === IDLE PHASE ===
    sendStatus('idle');

    const startTime = Date.now();
    let resume = false;

    while (Date.now() - startTime < IDLE_TIMEOUT) {
      // Check inbox for new work (snapshot check)
      const hasMessages = inboxMessages.some((m) => m.type === 'message');
      if (hasMessages) {
        resume = true;
        break;
      }

      // Check for shutdown
      const hasShutdown = inboxMessages.some((m) => m.type === 'shutdown');
      if (hasShutdown) {
        sendStatus('shutdown');
        process.exit(0);
      }

      // Auto-claim unclaimed tasks using atomic tryClaim
      const tasks = ctx.taskManager.list();
      const unclaimed = tasks.filter(
        (t) => t.status === 'pending' && !t.owner && (!t.blockedBy || t.blockedBy.length === 0)
      );

      if (unclaimed.length > 0) {
        const task = unclaimed[0];

        // Use atomic tryClaim to prevent race conditions
        const result = ctx.taskManager.tryClaim(task.id, teammateName);

        if (result.success) {
          // Identity re-injection if context was compressed (short message history)
          if (messages.length <= 3) {
            messages.unshift(makeIdentityBlock(teammateName, teammateRole, teamName));
            messages.splice(1, 0, { role: 'assistant', content: `I am ${teammateName}. Continuing.` });
          }

          messages.push({
            role: 'user',
            content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ''}</auto-claimed>`,
          });

          resume = true;
          break;
        } else {
          // Task was claimed by someone else, log and try next
          sendLog(`Claim attempt failed: ${result.message}`);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    if (!resume) {
      // Timeout - exit
      sendStatus('shutdown');
      process.exit(0);
    }

    // Resume work phase
    sendStatus('working');
  }
}

// === IPC message handler ===
process.on('message', (msg: ParentMessage) => {
  if (msg.type === 'spawn') {
    teammateName = msg.name;
    teammateRole = msg.role;
    teamName = msg.teamName;

    // Create context with IPC-aware handlers
    const ctx = createChildContext();

    // Load child-scope tools
    const loader = new ChildToolLoader();
    const toolsDir = path.join(__dirname, 'tools');

    loader.loadAll(toolsDir).then(() => {
      teammateLoop(msg.prompt, ctx, loader).catch((err) => {
        sendError(err.message);
        process.exit(1);
      });
    });
  } else {
    // Queue message for teammate loop to process
    // Safe in Node.js single-threaded event loop
    inboxMessages.push(msg);
  }
});

// Handle process disconnect (parent exited)
process.on('disconnect', () => {
  sendStatus('shutdown');
  process.exit(0);
});