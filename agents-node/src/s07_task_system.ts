#!/usr/bin/env node
/**
 * s07_task_system.ts - Tasks
 *
 * Harness: persistent tasks -- goals that outlive any single conversation.
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy/blocks).
 *
 *     .tasks/
 *       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *       task_3.json  {"id":3, "blockedBy":[2], "blocks":[], ...}
 *
 *     Dependency resolution:
 *     +----------+     +----------+     +----------+
 *     | task 1   | --> | task 2   | --> | task 3   |
 *     | complete |     | blocked  |     | blocked  |
 *     +----------+     +----------+     +----------+
 *          |                ^
 *          +--- completing task 1 removes it from task 2's blockedBy
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
 */

import * as readline from 'readline';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { type Message, type Tool } from 'ollama';
import { ollama, MODEL } from './ollama.js';
import chalk from 'chalk';

const WORKDIR = process.cwd();
const TASKS_DIR = path.join(WORKDIR, '.tasks');

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// -- Task interfaces --
interface TaskJson {
  id: number;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy: number[];
  blocks: number[];
  owner: string;
}

interface Task {
  id: number;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy: Set<number>;
  blocks: Set<number>;
  owner: string;
}

// -- TaskManager: CRUD with dependency graph, persisted as JSON files --
class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith('task_') && f.endsWith('.json'));
    const ids = files.map((f) => parseInt(f.split('_')[1].replace('.json', ''), 10));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  private load(taskId: number): Task {
    const filePath = path.join(this.dir, `task_${taskId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Task ${taskId} not found`);
    }
    const json: TaskJson = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      ...json,
      blockedBy: new Set(json.blockedBy),
      blocks: new Set(json.blocks),
    };
  }

  private save(task: Task): void {
    const json: TaskJson = {
      ...task,
      blockedBy: [...task.blockedBy],
      blocks: [...task.blocks],
    };
    const filePath = path.join(this.dir, `task_${task.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
  }

  create(subject: string, description = ''): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: 'pending',
      blockedBy: new Set(),
      blocks: new Set(),
      owner: '',
    };
    this.save(task);
    this.nextId++;
    return this.stringifyTask(task);
  }

  get(taskId: number): string {
    return this.stringifyTask(this.load(taskId));
  }

  private stringifyTask(task: Task): string {
    const lines = [
      `Task #${task.id}: ${task.subject}`,
      `Status: ${task.status}`,
      task.description && `Description: ${task.description}`,
      task.blockedBy.size > 0 && `Blocked by: ${[...task.blockedBy].join(', ')}`,
      task.blocks.size > 0 && `Blocks: ${[...task.blocks].join(', ')}`,
      task.owner && `Owner: ${task.owner}`,
    ].filter(Boolean);
    return lines.join('\n');
  }

  update(
    taskId: number,
    status?: 'pending' | 'in_progress' | 'completed',
    addBlockedBy?: number[],
    addBlocks?: number[]
  ): string {
    const task = this.load(taskId);

    if (status) {
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
      // When a task is completed, remove it from all other tasks' blockedBy
      if (status === 'completed') {
        this.clearDependency(taskId);
      }
    }

    if (addBlockedBy) {
      addBlockedBy.forEach((id) => task.blockedBy.add(id));
    }

    if (addBlocks) {
      addBlocks.forEach((blockedId) => {
        task.blocks.add(blockedId);
        // Bidirectional: also update the blocked tasks' blockedBy lists
        try {
          const blocked = this.load(blockedId);
          blocked.blockedBy.add(taskId);
          this.save(blocked);
        } catch {
          // Ignore if blocked task doesn't exist
        }
      });
    }

    this.save(task);
    return this.stringifyTask(task);
  }

  private clearDependency(completedId: number): void {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith('task_') && f.endsWith('.json'));

    for (const file of files) {
      const task = this.load(parseInt(file.match(/\d+/)?.[0] || '0', 10));
      if (task.blockedBy.has(completedId)) {
        task.blockedBy.delete(completedId);
        this.save(task);
      }
    }
  }

  listAll(): string {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith('task_') && f.endsWith('.json'))
      .sort();

    if (files.length === 0) {
      return 'No tasks.';
    }

    const lines: string[] = [];
    for (const file of files) {
      const task = this.load(parseInt(file.match(/\d+/)?.[0] || '0', 10));
      const marker: Record<string, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };
      const statusMarker = marker[task.status] || '[?]';
      const blocked =
        task.blockedBy.size > 0 ? ` (blocked by: ${[...task.blockedBy].join(', ')})` : '';
      lines.push(`${statusMarker} #${task.id}: ${task.subject}${blocked}`);
    }
    return lines.join('\n');
  }
}

const TASKS = new TaskManager(TASKS_DIR);

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
type ToolHandler = (args: Record<string, unknown>) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (args) => runBash(args.command as string),
  read_file: (args) => runRead(args.path as string, args.limit as number | undefined),
  write_file: (args) => runWrite(args.path as string, args.content as string),
  edit_file: (args) =>
    runEdit(args.path as string, args.old_text as string, args.new_text as string),
  task_create: (args) => TASKS.create(args.subject as string, args.description as string | undefined ?? ''),
  task_update: (args) =>
    TASKS.update(
      args.task_id as number,
      args.status as 'pending' | 'in_progress' | 'completed' | undefined,
      args.addBlockedBy as number[] | undefined,
      args.addBlocks as number[] | undefined
    ),
  task_list: () => TASKS.listAll(),
  task_get: (args) => TASKS.get(args.task_id as number),
};

// Tool definitions for Ollama
const TOOLS: Tool[] = [
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
      name: 'task_create',
      description: 'Create a new task.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Task subject/title' },
          description: { type: 'string', description: 'Detailed task description' },
        },
        required: ['subject'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_update',
      description: "Update a task's status or dependencies.",
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'integer', description: 'Task ID to update' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed'],
            description: 'New status',
          },
          addBlockedBy: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Task IDs that this task depends on',
          },
          addBlocks: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Task IDs that depend on this task',
          },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_list',
      description: 'List all tasks with status summary.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_get',
      description: 'Get full details of a task by ID.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'integer', description: 'Task ID' } },
        required: ['task_id'],
      },
    },
  },
];

/**
 * Agent loop
 */
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
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
      return;
    }

    // Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      const args = toolCall.function.arguments as Record<string, unknown>;
      const toolName = toolCall.function.name;
      const handler = TOOL_HANDLERS[toolName];
      let output: string;

      try {
        output = handler ? handler(args) : `Unknown tool: ${toolName}`;
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
      } else if (toolName.startsWith('task_')) {
        console.log(chalk.magenta(`[${toolName}]`));
        console.log(output.slice(0, 500));
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
  console.log(chalk.cyan(`s07 (Ollama: ${MODEL})`));
  console.log('Task system enabled. Tasks persist in .tasks/ directory.\n');
  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt(chalk.cyan('s07 >> '));
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) {
        break;
      }
      history.push({ role: 'user', content: query });
      await agentLoop(history);

      // Print final response
      const lastMsg = history[history.length - 1];
      if (lastMsg.content) {
        console.log(lastMsg.content);
      }
      console.log();
    } catch (err) {
      console.error('Error:', err);
    }
  }
  rl.close();
}

main().catch(console.error);