#!/usr/bin/env node
/**
 * s03_todo_write.ts - TodoWrite
 *
 * Harness: planning -- keeping the model on course without scripting the route.
 *
 * The model tracks its own progress via a TodoManager. A nag reminder
 * forces it to keep updating when it forgets.
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> | Tools   |
 *     |  prompt  |      |       |      | + todo  |
 *     +----------+      +---+---+      +----+----+
 *                          ^               |
 *                          |   tool_result |
 *                          +---------------+
 *                                |
 *                    +-----------+-----------+
 *                    | TodoManager state     |
 *                    | [ ] task A            |
 *                    | [>] task B <- doing   |
 *                    | [x] task C            |
 *                    +-----------------------+
 *                                |
 *                    if rounds_since_todo >= 3:
 *                      inject <reminder>
 *
 * Key insight: "The agent can track its own progress -- and I can see it."
 */

import * as readline from 'readline';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Ollama, type Message, type Tool } from 'ollama';
import 'dotenv/config';
import chalk from 'chalk';

// Configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const MODEL = process.env.OLLAMA_MODEL || 'glm-5:cloud';

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

// Initialize Ollama client
const ollama = new Ollama({
  host: OLLAMA_HOST,
  ...(OLLAMA_API_KEY ? { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` } } : {}),
});

// -- TodoManager: structured state the LLM writes to --
interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

class TodoManager {
  private items: TodoItem[] = [];

  update(items: Array<{ id?: string; text?: string; status?: string }>): string {
    if (items.length > 20) {
      throw new Error('Max 20 todos allowed');
    }

    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = String(item?.text ?? '').trim();
      const status = String(item?.status ?? 'pending').toLowerCase() as TodoItem['status'];
      const id = String(item?.id ?? String(i + 1));

      if (!text) {
        throw new Error(`Item ${id}: text required`);
      }
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }
      if (status === 'in_progress') {
        inProgressCount++;
      }

      validated.push({ id, text, status });
    }

    if (inProgressCount > 1) {
      throw new Error('Only one task can be in_progress at a time');
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) {
      return 'No todos.';
    }

    const markerMap: Record<string, string> = {
      pending: '[ ]',
      in_progress: '[>]',
      completed: '[x]',
    };

    const lines = this.items.map((item) => {
      const marker = markerMap[item.status];
      return `${marker} #${item.id}: ${item.text}`;
    });

    const done = this.items.filter((t) => t.status === 'completed').length;
    lines.push(`\n(${done}/${this.items.length} completed)`);

    return lines.join('\n');
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== 'completed');
  }
}

const TODO = new TodoManager();

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
  todo: (args) => {
    const items = args.items as Array<{ id?: string; text?: string; status?: string }>;
    return TODO.update(items);
  },
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
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
        },
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
      name: 'todo',
      description: 'Update task list. Track progress on multi-step tasks.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique task identifier' },
                text: { type: 'string', description: 'Task description' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Task status',
                },
              },
              required: ['id', 'text', 'status'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
];

/**
 * Agent loop with nag reminder injection
 */
async function agentLoop(messages: Message[]): Promise<number> {
  let roundsSinceTodo = 0;

  while (true) {
    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools: TOOLS,
    });

    const assistantMessage = response.message;

    // Append assistant message
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    // If no tool calls, we're done
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return roundsSinceTodo;
    }

    // Execute each tool call via dispatch map
    let usedTodo = false;
    const toolResults: Message[] = [];

    for (const toolCall of assistantMessage.tool_calls) {
      const handler = TOOL_HANDLERS[toolCall.function.name];
      let output: string;

      try {
        output = handler
          ? handler(toolCall.function.arguments as Record<string, unknown>)
          : `Unknown tool: ${toolCall.function.name}`;
      } catch (error: unknown) {
        output = `Error: ${(error as Error).message}`;
      }

      // Friendly console output
      const args = toolCall.function.arguments as Record<string, unknown>;
      const toolName = toolCall.function.name;

      if (toolName === 'todo') {
        console.log(chalk.cyan('[todo]') + ' updated');
        console.log(output);
        usedTodo = true;
      } else if (toolName === 'bash') {
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
      } else {
        console.log(`> ${toolName}: ${output.slice(0, 200)}`);
      }

      toolResults.push({
        role: 'tool',
        content: output,
      });
    }

    // Nag reminder: if todos exist and model hasn't updated in 3+ rounds
    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3 && TODO.hasOpenItems()) {
      console.log(chalk.yellow('[reminder] Update your todos.'));
      messages.push({
        role: 'user',
        content: '<reminder>Update your todos.</reminder>',
      });
    }

    messages.push(...toolResults);
  }
}

// REPL
async function main() {
  console.log(chalk.cyan(`s03 (Ollama: ${MODEL})`));
  console.log('Todo manager enabled. Use the todo tool to track progress.\n');
  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt(chalk.cyan('s03 >> '));
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
