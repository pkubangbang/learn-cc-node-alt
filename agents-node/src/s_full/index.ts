#!/usr/bin/env node
/**
 * s_full/index.ts - Full Reference Agent with Modular Tool Architecture
 *
 * Capstone implementation combining every mechanism from s03-s12.
 * Uses dynamic tool loading with scope-based visibility control.
 *
 *     +------------------------------------------------------------------+
 *     |                        FULL AGENT                                 |
 *     |                                                                   |
 *     |  System prompt (s05 skills, task-first + optional todo nag)      |
 *     |                                                                   |
 *     |  Before each LLM call:                                            |
 *     |  +--------------------+  +------------------+  +--------------+      |
 *     |  | Microcompact (s06) |  | Drain bg (s08)   |  | Check inbox  |      |
 *     |  | Auto-compact (s06) |  | notifications    |  | (s09)        |      |
 *     |  +--------------------+  +------------------+  +--------------+      |
 *     |                                                                   |
 *     |  Tool dispatch via ToolLoader:                                    |
 *     |  +--------+----------+----------+---------+-----------+            |
 *     |  | bash   | read     | write    | edit    | TodoWrite |            |
 *     |  | task   | load_sk  | compress | bg_run  | bg_check  |            |
 *     |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |            |
 *     |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |            |
 *     |  | plan   | idle     | claim    | wt_*    |           |            |
 *     |  +--------+----------+----------+---------+-----------+            |
 *     |                                                                   |
 *     |  Subagent (s04):  spawn -> work -> return summary                 |
 *     |  Teammate (s09):  spawn -> work -> idle -> auto-claim (s11)      |
 *     |  Shutdown (s10):  request_id handshake                           |
 *     |  Plan gate (s10): submit -> approve/reject                        |
 *     +------------------------------------------------------------------+
 *
 *     REPL commands: /compact /tasks /team /inbox /tools
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { type Message, type Tool } from 'ollama';
import { ollama, MODEL } from '../ollama.js';
import chalk from 'chalk';
import { type ToolScope, type ToolDefinition, type AgentContext } from './types.js';
import { createContext } from './context.js';
import { microCompact, autoCompact, estimateTokens } from './tools/compress.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKDIR = process.cwd();
const TOKEN_THRESHOLD = 50000;

// === ToolLoader: Dynamic tool loading with scope ===
class ToolLoader {
  private tools: Map<string, ToolDefinition> = new Map();

  async loadAll(toolsDir: string): Promise<void> {
    const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.ts') || f.endsWith('.js'));
    for (const file of files) {
      try {
        const modulePath = path.join(toolsDir, file);
        const module = await import(`file://${modulePath}`);
        // Try different export patterns
        const tool = module.default || Object.values(module).find((v) => typeof v === 'object' && v !== null && 'name' in v && 'handler' in v);
        if (tool && typeof tool === 'object' && 'name' in tool && 'handler' in tool) {
          const def = tool as ToolDefinition;
          this.tools.set(def.name, def);
        }
      } catch (error) {
        // Skip modules that fail to load
        console.error(chalk.yellow(`Warning: Failed to load tool from ${file}: ${(error as Error).message}`));
      }
    }
  }

  getToolsForScope(scope: ToolScope): Tool[] {
    return Array.from(this.tools.values())
      .filter((t) => t.scope.includes(scope))
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
  }

  execute(name: string, ctx: AgentContext, args: Record<string, unknown>): string | Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Unknown tool: ${name}`;
    return tool.handler(ctx, args);
  }

  listAll(): string {
    const byScope: Record<string, string[]> = { main: [], child: [], bg: [] };
    for (const [name, tool] of this.tools) {
      for (const s of tool.scope) {
        if (byScope[s]) {
          byScope[s].push(name);
        }
      }
    }
    return [
      `[main] ${byScope.main.join(', ')}`,
      `[child] ${byScope.child.join(', ')}`,
      `[bg] ${byScope.bg.join(', ')}`,
    ].join('\n');
  }
}

// === Agent Loop ===
async function agentLoop(
  messages: Message[],
  ctx: AgentContext,
  loader: ToolLoader,
  scope: ToolScope = 'main'
): Promise<{ manualCompact: boolean }> {
  let manualCompact = false;

  while (true) {
    // s06: microcompact + auto-compact
    microCompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log(chalk.blue('[auto-compact triggered]'));
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    // s08: drain background notifications
    const notifs = ctx.backgroundManager.drainNotifications();
    if (notifs.length > 0) {
      const notifText = notifs.map((n) => `[bg:${n.taskId}] ${n.status}: ${n.result}`).join('\n');
      messages.push({
        role: 'user',
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
      messages.push({ role: 'assistant', content: 'Noted background results.' });
    }

    // Build system prompt
    const skillsDesc = ctx.skillLoader.getDescriptions();
    const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${skillsDesc}`;

    // Get tools for scope
    const tools = loader.getToolsForScope(scope);

    // LLM call
    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools,
    });

    const assistantMessage = response.message;
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    // If no tool calls, bounce teammates
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const result = await ctx.teammateManager.bounce(messages, 30000, 1000);
      if (result.allSettled) {
        return { manualCompact: false }; // All teammates settled, exit loop
      }
      // Timeout - inject timeout message
      const stillWorking = ctx.teammateManager.getWorkingTeammates();
      messages.push({
        role: 'user',
        content: `Timeout waiting for teammates. Still working: ${stillWorking.join(', ')}. Summarize the current result and let me decide what to do.`,
      });
      // Continue loop to let agent respond to timeout
      continue;
    }

    // Execute tool calls
    const results: Message[] = [];
    for (const toolCall of assistantMessage.tool_calls) {
      const args = toolCall.function.arguments as Record<string, unknown>;
      const toolName = toolCall.function.name;

      let output: string;
      try {
        output = await loader.execute(toolName, ctx, args);
      } catch (error: unknown) {
        output = `Error: ${(error as Error).message}`;
      }

      // Check for manual compact
      if (toolName === 'compress') {
        manualCompact = true;
      }

      results.push({
        role: 'tool',
        content: `tool call ${toolName} finished. ${output}`,
      } as Message);
    }

    messages.push({ role: 'user', content: results.map((r) => r.content).join('\n') });

    // s06: manual compact
    if (manualCompact) {
      console.log(chalk.blue('[manual compact]'));
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
      return { manualCompact: true };
    }
  }
}

// === REPL ===
async function main() {
  console.log(chalk.cyan(`s_full (Ollama: ${MODEL})`));
  console.log('Modular tool architecture with scope-based visibility.\n');

  // Create context
  const ctx = createContext();

  // Load tools
  const loader = new ToolLoader();
  const toolsDir = path.join(__dirname, 'tools');
  await loader.loadAll(toolsDir);

  console.log('Loaded tools:');
  console.log(loader.listAll());
  console.log();

  // REPL commands
  const history: Message[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\nShutting down...'));
    ctx.teammateManager.killAll();
    rl.close();
    process.exit(0);
  });

  while (true) {
    try {
      const query = await prompt(chalk.cyan('s_full >> '));
      const trimmed = query.trim().toLowerCase();

      if (['q', 'exit', ''].includes(trimmed)) {
        break;
      }

      // REPL commands
      if (trimmed === '/tools') {
        console.log(loader.listAll());
        // Reload tools dynamically
        await loader.loadAll(toolsDir);
        console.log(chalk.gray('Tools reloaded.'));
        continue;
      }

      if (trimmed === '/tasks') {
        console.log(ctx.taskManager.listAll());
        continue;
      }

      if (trimmed === '/team') {
        console.log(ctx.teammateManager.listAll());
        continue;
      }

      if (trimmed === '/inbox') {
        // Lead inbox handled via IPC
        console.log('Lead inbox is handled via IPC messages from teammates.');
        continue;
      }

      if (trimmed === '/compact') {
        if (history.length > 0) {
          console.log(chalk.blue('[manual compact via /compact]'));
          const compacted = await autoCompact(history);
          history.splice(0, history.length, ...compacted);
        }
        continue;
      }

      history.push({ role: 'user', content: query });
      const result = await agentLoop(history, ctx, loader);

      // Print final response
      const lastMsg = history[history.length - 1];
      if (lastMsg.content) {
        console.log(lastMsg.content);
      }
      console.log();

      // If manual compact was triggered, restart loop
      if (result.manualCompact) {
        continue;
      }
    } catch (err) {
      console.error('Error:', err);
    }
  }

  ctx.teammateManager.killAll();
  rl.close();
}

main().catch(console.error);