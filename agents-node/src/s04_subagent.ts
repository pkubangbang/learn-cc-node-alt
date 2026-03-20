#!/usr/bin/env node
/**
 * s04_subagent.ts - Subagents
 *
 * Harness: context isolation -- protecting the model's clarity of thought.
 *
 * Spawn a child agent with fresh messages=[]. The child works in its own
 * context, sharing the filesystem, then returns only a summary to the parent.
 *
 *     Parent agent                     Subagent
 *     +------------------+             +------------------+
 *     | messages=[...]   |             | messages=[]      |  <-- fresh
 *     |                  |  dispatch   |                  |
 *     | tool: task       | ---------->| while tool_use:  |
 *     |   prompt="..."   |            |   call tools     |
 *     |   description="" |            |   append results |
 *     |                  |  summary   |                  |
 *     |   result = "..." | <--------- | return last text |
 *     +------------------+             +------------------+
 *               |
 *     Parent context stays clean.
 *     Subagent context is discarded.
 *
 * Key insight: "Process isolation gives context isolation for free."
 */

import * as readline from 'readline';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { type Message, type Tool } from 'ollama';
import { ollama, MODEL } from './ollama.js';
import chalk from 'chalk';

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks. Act, don't explain.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

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
};

// Child tools: base tools only (no task tool - no recursive spawning)
const CHILD_TOOLS: Tool[] = [
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
];

// Parent tools: base tools + task dispatcher
const PARENT_TOOLS: Tool[] = [
  ...CHILD_TOOLS,
  {
    type: 'function',
    function: {
      name: 'task',
      description:
        'Spawn a subagent with fresh context. It shares the filesystem but not conversation history.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task prompt for the subagent' },
          description: { type: 'string', description: 'Short description of the task' },
        },
        required: ['prompt'],
      },
    },
  },
];

/**
 * Subagent: fresh context, filtered tools, summary-only return
 */
async function runSubagent(prompt: string): Promise<string> {
  const subMessages: Message[] = [{ role: 'user', content: prompt }];

  for (let i = 0; i < 30; i++) {
    // safety limit
    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'system', content: SUBAGENT_SYSTEM }, ...subMessages],
      tools: CHILD_TOOLS,
    });

    const assistantMessage = response.message;
    subMessages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    // If no tool calls, we're done - return summary
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return assistantMessage.content || '(no summary)';
    }

    // Execute tool calls
    for (const toolCall of assistantMessage.tool_calls) {
      const handler = TOOL_HANDLERS[toolCall.function.name];
      const output = handler
        ? handler(toolCall.function.arguments as Record<string, unknown>)
        : `Unknown tool: ${toolCall.function.name}`;

      const toolCallId = (toolCall as unknown as Record<string, unknown>).id || '<unknown>';
      subMessages.push({
        role: 'tool',
        content: `tool call ${toolCall.function.name}#${toolCallId} finished. ${output}`,
      });
    }
  }

  return '(subagent exceeded iteration limit)';
}

/**
 * Parent agent loop
 */
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools: PARENT_TOOLS,
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
      let output: string;

      if (toolName === 'task') {
        // Spawn subagent
        const desc = (args.description as string) || 'subtask';
        const taskPrompt = args.prompt as string;
        console.log(chalk.magenta(`[task]`) + ` (${desc}): ${taskPrompt.slice(0, 80)}`);
        output = await runSubagent(taskPrompt);
        console.log(chalk.dim('  ') + output.slice(0, 200));
      } else {
        // Regular tool
        const handler = TOOL_HANDLERS[toolName];
        output = handler ? handler(args) : `Unknown tool: ${toolName}`;

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
            chalk.green('[write]') +
              ` ${args.path} (${(args.content as string)?.length ?? 0} bytes)`
          );
          console.log(output);
        } else if (toolName === 'edit_file') {
          console.log(chalk.green('[edit]') + ` ${args.path}`);
          console.log(output);
        } else {
          console.log(`> ${toolName}: ${output.slice(0, 200)}`);
        }
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
  console.log(chalk.cyan(`s04 (Ollama: ${MODEL})`));
  console.log('Subagent support enabled. Use the task tool to delegate work.\n');
  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt(chalk.cyan('s04 >> '));
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
