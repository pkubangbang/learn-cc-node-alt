#!/usr/bin/env node
/**
 * s08_background_tasks.ts - Background Tasks
 *
 * Harness: background execution -- the model thinks while the harness waits.
 *
 * Run commands in background using Node.js async event loop. A notification
 * queue is drained before each LLM call to deliver results.
 *
 *     Main thread                Background task
 *     +-----------------+        +-----------------+
 *     | agent loop      |        | task executes  |
 *     | ...             |        | ...            |
 *     | [LLM call] <---+------- | enqueue(result) |
 *     |  ^drain queue   |        +-----------------+
 *     +-----------------+
 *
 *     Timeline:
 *     Agent ----[spawn A]----[spawn B]----[other work]----
 *                  |              |
 *                  v              v
 *               [A runs]      [B runs]        (parallel)
 *                  |              |
 *                  +-- notification queue --> [results injected]
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
 *
 * In Node.js, we use async functions naturally (no threads needed) since the
 * event loop handles concurrency. The `execa` package provides proper subprocess
 * management with promise-based API.
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { execa } from 'execa';
import { type Message, type Tool } from 'ollama';
import { ollama, MODEL } from './ollama.js';
import chalk from 'chalk';

const WORKDIR = process.cwd();

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

// -- BackgroundManager: async execution + notification queue --
interface Task {
  id: string;
  status: 'running' | 'completed' | 'timeout' | 'error';
  command: string;
  result?: string;
}

interface Notification {
  taskId: string;
  status: string;
  command: string;
  result: string;
}

class BackgroundManager {
  private tasks: Map<string, Task> = new Map();
  private notifications: Notification[] = [];

  /**
   * Start a background command, return task_id immediately.
   * Uses execa for proper subprocess management.
   */
  async run(command: string): Promise<string> {
    const taskId = this.generateId();
    this.tasks.set(taskId, {
      id: taskId,
      status: 'running',
      command,
    });

    // Fire and forget - run in background
    this.executeCommand(taskId, command).catch(() => {
      // Error handling is done in executeCommand
    });

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  /**
   * Execute command asynchronously and store result.
   */
  private async executeCommand(taskId: string, command: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    try {
      // Run with 300s timeout
      const result = await execa(command, {
        shell: true,
        cwd: WORKDIR,
        timeout: 300000, // 5 minutes
        reject: false, // Don't throw on non-zero exit
        all: true, // Combine stdout and stderr
      });

      const output = (result.all || result.stdout || result.stderr || '(no output)').slice(0, 50000);

      task.status = result.failed ? 'error' : 'completed';
      task.result = output;

      this.enqueueNotification({
        taskId,
        status: task.status,
        command: command.slice(0, 80),
        result: output.slice(0, 500),
      });
    } catch (error) {
      const err = error as Error & { timedOut?: boolean };
      if (err.timedOut) {
        task.status = 'timeout';
        task.result = 'Error: Timeout (300s)';
      } else {
        task.status = 'error';
        task.result = `Error: ${err.message}`;
      }

      this.enqueueNotification({
        taskId,
        status: task.status,
        command: command.slice(0, 80),
        result: task.result.slice(0, 500),
      });
    }
  }

  /**
   * Generate a short random ID.
   */
  private generateId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  /**
   * Add notification to queue.
   */
  private enqueueNotification(notif: Notification): void {
    this.notifications.push(notif);
  }

  /**
   * Check status of one task or list all.
   */
  check(taskId?: string): string {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) {
        return `Error: Unknown task ${taskId}`;
      }
      const result = task.result || '(running)';
      return `[${task.status}] ${task.command.slice(0, 60)}\n${result}`;
    }

    if (this.tasks.size === 0) {
      return 'No background tasks.';
    }

    const lines: string[] = [];
    this.tasks.forEach((t, id) => {
      lines.push(`${id}: [${t.status}] ${t.command.slice(0, 60)}`);
    });
    return lines.join('\n');
  }

  /**
   * Return and clear all pending completion notifications.
   */
  drainNotifications(): Notification[] {
    const notifs = [...this.notifications];
    this.notifications = [];
    return notifs;
  }

  /**
   * Check if there are any running tasks.
   */
  hasRunningTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if there are pending notifications to deliver.
   */
  hasPendingNotifications(): boolean {
    return this.notifications.length > 0;
  }
}

const BG = new BackgroundManager();

// -- Safe path handling --
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// -- Tool implementations --
function runBash(command: string): string {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
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

// -- The dispatch map: {tool_name: handler} --
type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (args) => runBash(args.command as string),
  read_file: (args) => runRead(args.path as string, args.limit as number | undefined),
  write_file: (args) => runWrite(args.path as string, args.content as string),
  edit_file: (args) => runEdit(args.path as string, args.old_text as string, args.new_text as string),
  background_run: async (args) => BG.run(args.command as string),
  check_background: (args) => BG.check(args.task_id as string | undefined),
};

// Tool definitions for Ollama
const TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command (blocking).',
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
      name: 'background_run',
      description: 'Run command in background. Returns task_id immediately.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run in background' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_background',
      description: 'Check background task status. Omit task_id to list all.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID to check (optional)' },
        },
      },
    },
  },
];

/**
 * Agent loop - drains notifications before each LLM call
 * Returns object with background task status
 */
async function agentLoop(messages: Message[]): Promise<{ running: boolean; pending: boolean }> {
  while (true) {
    // Drain background notifications and inject as system message before LLM call
    const notifs = BG.drainNotifications();
    if (notifs.length > 0 && messages.length > 0) {
      const notifText = notifs
        .map((n) => `[bg:${n.taskId}] ${n.status}: ${n.result}`)
        .join('\n');
      messages.push({
        role: 'user',
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
      messages.push({ role: 'assistant', content: 'Noted background results.' });
    }

    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools: TOOLS,
    });

    const assistantMessage = response.message;
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    // If no tool calls, we're done
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return {
        running: BG.hasRunningTasks(),
        pending: BG.hasPendingNotifications(),
      };
    }

    // Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      const args = toolCall.function.arguments as Record<string, unknown>;
      const toolName = toolCall.function.name;
      const handler = TOOL_HANDLERS[toolName];
      let output: string;

      try {
        // Handle both sync and async handlers
        output = handler ? await handler(args) : `Unknown tool: ${toolName}`;
      } catch (error: unknown) {
        output = `Error: ${(error as Error).message}`;
      }

      // Friendly console output
      if (toolName === 'bash') {
        console.log(chalk.yellow(`$ ${args.command}`));
        console.log(output.slice(0, 300));
      } else if (toolName === 'read_file') {
        const lines = output.split('\n').slice(0, 5).join('\n');
        const more = output.includes('\n') && output.split('\n').length > 5 ? '\n...' : '';
        console.log(chalk.green('[read]') + ` ${args.path}`);
        console.log(`${lines}${more}`);
      } else if (toolName === 'write_file') {
        console.log(
          chalk.green('[write]') + ` ${args.path} (${(args.content as string)?.length ?? 0} bytes)`
        );
        console.log(output);
      } else if (toolName === 'edit_file') {
        console.log(chalk.green('[edit]') + ` ${args.path}`);
        console.log(output);
      } else if (toolName === 'background_run') {
        console.log(chalk.blue('[bg]') + ` started`);
        console.log(output);
      } else if (toolName === 'check_background') {
        console.log(chalk.blue('[bg-check]'));
        console.log(output);
      } else {
        console.log(`> ${toolName}: ${output.slice(0, 200)}`);
      }

      const toolCallId = (toolCall as unknown as Record<string, unknown>).id || '<unknown>';
      messages.push({
        role: 'tool',
        content: `tool call ${toolName}#${toolCallId} finished. ${output}`,
      });
    }
  }
}

// REPL
async function main() {
  console.log(chalk.cyan(`s08 (Ollama: ${MODEL})`));
  console.log('Background tasks enabled. Use background_run for long-running commands.\n');
  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt(chalk.cyan('s08 >> '));
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) {
        break;
      }
      history.push({ role: 'user', content: query });
      const bgStatus = await agentLoop(history);

      // Print final response
      const lastMsg = history[history.length - 1];
      if (lastMsg.content) {
        console.log(lastMsg.content);
      }

      // Notify user about background task status
      if (bgStatus.running || bgStatus.pending) {
        console.log(chalk.yellow('\n⚠ Background tasks still running. Use check_background to monitor.'));
      }
      console.log();
    } catch (err) {
      console.error('Error:', err);
    }
  }
  rl.close();
}

main().catch(console.error);