#!/usr/bin/env node
/**
 * teammate-worker.ts - Worker process for autonomous teammates
 *
 * Runs as a child process. All communication goes through the lead process
 * via IPC (process.send/on('message')). The lead acts as message broker,
 * routing messages between teammates and maintaining real-time status.
 *
 * Lifecycle:
 *   1. Parent sends {type: 'spawn', name, role, prompt, teamName}
 *   2. Worker runs teammate loop (work/idle phases)
 *   3. Worker reports status changes via {type: 'status', status}
 *   4. Parent can send messages via {type: 'message', from, content, msgType}
 *   5. Worker exits on shutdown or idle timeout
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { type Message, type Tool } from 'ollama';
import { ollama, MODEL } from './ollama.js';
import chalk from 'chalk';

const WORKDIR = process.cwd();
const TASKS_DIR = path.join(WORKDIR, '.tasks');
const POLL_INTERVAL = 5000; // 5 seconds
const IDLE_TIMEOUT = 60000; // 60 seconds

// IPC Message types (Lead <-> Child)
// Parent → Child
type ParentMessage =
  | { type: 'spawn'; name: string; role: string; prompt: string; teamName: string }
  | { type: 'message'; from: string; content: string; msgType: string }
  | { type: 'shutdown' };

// Child → Parent
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

const VALID_MSG_TYPES = [
  'message',
  'broadcast',
  'shutdown_request',
  'shutdown_response',
  'plan_approval_response',
];

// -- Task board scanning (same as main process) --
interface Task {
  id: number;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  blockedBy?: number[];
}

function scanUnclaimedTasks(): Task[] {
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    return [];
  }
  const unclaimed: Task[] = [];
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith('task_') && f.endsWith('.json')).sort();
  for (const file of files) {
    const taskPath = path.join(TASKS_DIR, file);
    try {
      const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8')) as Task;
      if (task.status === 'pending' && !task.owner && !task.blockedBy?.length) {
        unclaimed.push(task);
      }
    } catch {
      // Skip malformed task files
    }
  }
  return unclaimed;
}

function claimTask(taskId: number, owner: string): string {
  const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);
  if (!fs.existsSync(taskPath)) {
    return `Error: Task ${taskId} not found`;
  }
  try {
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8')) as Task;
    task.owner = owner;
    task.status = 'in_progress';
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
    return `Claimed task #${taskId} for ${owner}`;
  } catch {
    return `Error: Failed to claim task ${taskId}`;
  }
}

// -- Identity re-injection after compression --
function makeIdentityBlock(name: string, role: string, teamName: string): Message {
  return {
    role: 'user',
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
  };
}

// -- Tool implementations --
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot'];
  if (dangerous.some((d) => command.includes(d))) {
    return 'Error: Dangerous command blocked';
  }
  try {
    const result = execSync(command, {
      cwd: WORKDIR,
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return (result || '(no output)').slice(0, 50000);
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    return (err.stderr || err.message || 'Unknown error').slice(0, 50000);
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    const safe = safePath(filePath);
    const content = fs.readFileSync(safe, 'utf-8');
    const lines = content.split('\n');
    if (limit && limit < lines.length) {
      return lines.slice(0, limit).join('\n') + `\n... (${lines.length - limit} more lines)`;
    }
    return content.slice(0, 50000);
  } catch (error: unknown) {
    return `Error: ${(error as Error).message}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const safe = safePath(filePath);
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, content, 'utf-8');
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (error: unknown) {
    return `Error: ${(error as Error).message}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const safe = safePath(filePath);
    const content = fs.readFileSync(safe, 'utf-8');
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(safe, content.replace(oldText, newText), 'utf-8');
    return `Edited ${filePath}`;
  } catch (error: unknown) {
    return `Error: ${(error as Error).message}`;
  }
}

// Send message to lead (will be routed to target)
function sendMessage(to: string, content: string, msgType: string = 'message'): void {
  const msg: ChildMessage = { type: 'message', to, content, msgType };
  process.send?.(msg);
}

// Send log to parent
function sendLog(message: string): void {
  process.send?.({ type: 'log', message });
}

// Send status update to parent
function sendStatus(status: 'working' | 'idle' | 'shutdown'): void {
  process.send?.({ type: 'status', status });
}

// Send error to parent
function sendError(error: string): void {
  process.send?.({ type: 'error', error });
}

// Shutdown request tracking (for responding to shutdown requests)
const shutdownRequests: Map<string, { target: string; status: 'pending' | 'approved' | 'rejected' }> = new Map();
const planRequests: Map<string, { from: string; plan: string; status: 'pending' | 'approved' | 'rejected' }> = new Map();

// Tool execution
function execTool(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'bash') {
    return runBash(args.command as string);
  }
  if (toolName === 'read_file') {
    return runRead(args.path as string, args.limit as number | undefined);
  }
  if (toolName === 'write_file') {
    return runWrite(args.path as string, args.content as string);
  }
  if (toolName === 'edit_file') {
    return runEdit(args.path as string, args.old_text as string, args.new_text as string);
  }
  if (toolName === 'send_message') {
    sendMessage(args.to as string, args.content as string, (args.msg_type as string) || 'message');
    return `Sent message to ${args.to}`;
  }
  if (toolName === 'read_inbox') {
    // Inbox is managed by parent via IPC messages
    const msgs = inboxMessages
      .filter(m => m.type === 'message')
      .map(m => ({ type: m.msgType, from: m.from, content: m.content, timestamp: Date.now() }));
    inboxMessages = inboxMessages.filter(m => m.type !== 'message');
    return JSON.stringify(msgs, null, 2);
  }
  if (toolName === 'shutdown_response') {
    const reqId = args.request_id as string;
    const approve = args.approve as boolean;
    const reason = (args.reason as string) || '';

    const req = shutdownRequests.get(reqId);
    if (req) {
      req.status = approve ? 'approved' : 'rejected';
    }

    sendMessage('lead', reason, 'shutdown_response');
    return `Shutdown ${approve ? 'approved' : 'rejected'}`;
  }
  if (toolName === 'plan_approval') {
    const planText = (args.plan as string) || '';
    const reqId = Math.random().toString(36).substring(2, 10);

    planRequests.set(reqId, { from: teammateName, plan: planText, status: 'pending' });
    sendMessage('lead', planText, 'plan_approval_response');
    return `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
  }
  if (toolName === 'claim_task') {
    return claimTask(args.task_id as number, teammateName);
  }
  return `Unknown tool: ${toolName}`;
}

// Get teammate tools (same as before)
function getTeammateTools(): Tool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'The shell command to execute' } },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read file contents.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace' },
            limit: { type: 'integer', description: 'Maximum lines to read' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Replace exact text in file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace' },
            old_text: { type: 'string', description: 'Text to replace' },
            new_text: { type: 'string', description: 'Replacement text' },
          },
          required: ['path', 'old_text', 'new_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_message',
        description: 'Send message to a teammate.',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient teammate name' },
            content: { type: 'string', description: 'Message content' },
            msg_type: {
              type: 'string',
              enum: VALID_MSG_TYPES,
              description: 'Message type',
            },
          },
          required: ['to', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_inbox',
        description: 'Read and drain your inbox.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'shutdown_response',
        description: 'Respond to a shutdown request. Approve to shut down, reject to keep working.',
        parameters: {
          type: 'object',
          properties: {
            request_id: { type: 'string', description: 'The request ID from shutdown_request' },
            approve: { type: 'boolean', description: 'Whether to approve shutdown' },
            reason: { type: 'string', description: 'Optional reason for response' },
          },
          required: ['request_id', 'approve'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'plan_approval',
        description: 'Submit a plan for lead approval. Provide plan text.',
        parameters: {
          type: 'object',
          properties: {
            plan: { type: 'string', description: 'Plan text to submit for approval' },
          },
          required: ['plan'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'idle',
        description: 'Signal that you have no more work. Enters idle polling phase where you will auto-claim new tasks.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'claim_task',
        description: 'Claim a task from the task board by ID.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'integer', description: 'Task ID to claim' },
          },
          required: ['task_id'],
        },
      },
    },
  ];
}

// Main teammate loop
async function teammateLoop(prompt: string): Promise<void> {
  const sysPrompt = `You are '${teammateName}', role: ${teammateRole}, team: ${teamName}, at ${WORKDIR}. Use idle tool when you have no more work. You will auto-claim new tasks.`;
  const messages: Message[] = [{ role: 'user', content: prompt }];
  const tools = getTeammateTools();

  // Report working status
  sendStatus('working');

  while (true) {
    // WORK PHASE
    let idleRequested = false;

    // Process queued inbox messages
    for (const msg of inboxMessages) {
      if (msg.type === 'message') {
        messages.push({ role: 'user', content: JSON.stringify({ type: msg.msgType, from: msg.from, content: msg.content }) });
      } else if (msg.type === 'shutdown') {
        sendStatus('shutdown');
        process.exit(0);
      }
    }
    inboxMessages = [];

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

        // If no tool calls, we're done with work phase
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          break;
        }

        // Execute tool calls
        for (const toolCall of assistantMessage.tool_calls) {
          const args = toolCall.function.arguments as Record<string, unknown>;
          const toolName = toolCall.function.name;

          let output: string;
          if (toolName === 'idle') {
            idleRequested = true;
            output = 'Entering idle phase. Will poll for new tasks.';
          } else {
            output = execTool(toolName, args);
          }

          sendLog(`${toolName}(${JSON.stringify(args).slice(0, 60)}): ${output.slice(0, 100)}`);
          messages.push({
            role: 'tool',
            content: `tool call ${toolName} finished. ${output}`,
          });

          // Check if shutdown was approved
          if (toolName === 'shutdown_response' && args.approve === true) {
            sendStatus('shutdown');
            process.exit(0);
          }
        }

        // If idle requested, break out of work phase
        if (idleRequested) {
          break;
        }
      } catch (err) {
        sendError((err as Error).message);
        return;
      }
    }

    // IDLE PHASE
    sendStatus('idle');

    // Wait for new work (poll inbox, timeout after IDLE_TIMEOUT)
    const startTime = Date.now();
    let resume = false;

    while (Date.now() - startTime < IDLE_TIMEOUT) {
      // Check inbox for new messages
      const newMessages = inboxMessages.filter(m => m.type === 'message');
      if (newMessages.length > 0) {
        for (const msg of newMessages) {
          if (msg.type === 'message') {
            messages.push({ role: 'user', content: JSON.stringify({ type: msg.msgType, from: msg.from, content: msg.content }) });
          }
        }
        inboxMessages = inboxMessages.filter(m => m.type !== 'message');
        resume = true;
        break;
      }

      // Check for shutdown messages
      const shutdownMsgs = inboxMessages.filter(m => m.type === 'shutdown');
      if (shutdownMsgs.length > 0) {
        sendStatus('shutdown');
        process.exit(0);
      }

      // Scan for unclaimed tasks
      const unclaimed = scanUnclaimedTasks();
      if (unclaimed.length > 0) {
        const task = unclaimed[0];
        claimTask(task.id, teammateName);
        const taskPrompt = `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ''}</auto-claimed>`;

        // Identity re-injection if messages are short (context was compressed)
        if (messages.length <= 3) {
          messages.unshift(makeIdentityBlock(teammateName, teammateRole, teamName));
          messages.splice(1, 0, { role: 'assistant', content: `I am ${teammateName}. Continuing.` });
        }

        messages.push({ role: 'user', content: taskPrompt });
        messages.push({ role: 'assistant', content: `Claimed task #${task.id}. Working on it.` });
        resume = true;
        break;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    if (!resume) {
      // Timeout - shutdown
      sendStatus('shutdown');
      process.exit(0);
    }

    // Resume work phase
    sendStatus('working');
  }
}

// Listen for parent messages
process.on('message', (msg: ParentMessage) => {
  if (msg.type === 'spawn') {
    teammateName = msg.name;
    teammateRole = msg.role;
    teamName = msg.teamName;
    teammateLoop(msg.prompt).catch((err) => {
      sendError(err.message);
      process.exit(1);
    });
  } else {
    // Queue message for teammate loop to process
    inboxMessages.push(msg);
  }
});

// Handle process disconnect (parent exited)
process.on('disconnect', () => {
  sendStatus('shutdown');
  process.exit(0);
});