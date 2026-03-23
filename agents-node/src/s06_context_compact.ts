#!/usr/bin/env node
/**
 * s06_context_compact.ts - Compact
 *
 * Harness: compression -- clean memory for infinite sessions.
 *
 * Three-layer compression pipeline so the agent can work forever:
 *
 *     Every turn:
 *     +------------------+
 *     | Tool call result |
 *     +------------------+
 *             |
 *             v
 *     [Layer 1: micro_compact]        (silent, every turn)
 *       Replace tool_result content older than last 3
 *       with "[Previous: used {tool_name}]"
 *             |
 *             v
 *     [Check: tokens > 50000?]
 *        |               |
 *        no              yes
 *        |               |
 *        v               v
 *     continue    [Layer 2: auto_compact]
 *                   Save full transcript to .transcripts/
 *                   Ask LLM to summarize conversation.
 *                   Replace all messages with [summary].
 *                         |
 *                         v
 *                 [Layer 3: compact tool]
 *                   Model calls compact -> immediate summarization.
 *                   Same as auto, triggered manually.
 *
 * Key insight: "The agent can forget strategically and keep working forever."
 */

import * as readline from 'readline';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { type Message, type Tool } from 'ollama';
import { ollama, MODEL } from './ollama.js';
import chalk from 'chalk';

const WORKDIR = process.cwd();
const TRANSCRIPT_DIR = path.join(WORKDIR, '.transcripts');
const THRESHOLD = 50000;
const KEEP_RECENT = 3;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

// -- Token estimation: ~4 chars per token --
function estimateTokens(messages: Message[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

// -- Layer 1: micro_compact - replace old tool results with placeholders --
interface ToolResultMessage {
  role: 'tool';
  content: string;
  tool_call_id?: string;
}

function microCompact(messages: Message[]): void {
  const toolResults = messages
    .map((msg, idx) => (msg.role === 'tool' ? { idx, msg: msg as ToolResultMessage } : null))
    .filter((r): r is { idx: number; msg: ToolResultMessage } => r !== null);

  if (toolResults.length <= KEEP_RECENT) return;

  // Build tool_call_id -> tool_name map
  const toolNameMap = messages
    .filter((msg): msg is Message & { role: 'assistant' } => msg.role === 'assistant' && !!msg.tool_calls)
    .flatMap((msg) => msg.tool_calls!)
    .reduce<Record<string, string>>((map, tc) => {
      const id = (tc as unknown as Record<string, unknown>).id as string | undefined;
      if (id) map[id] = tc.function.name;
      return map;
    }, {});

  // Compact old results
  toolResults.slice(0, -KEEP_RECENT).forEach(({ msg }) => {
    if (msg.content.length > 100) {
      msg.content = `[Previous: used ${toolNameMap[msg.tool_call_id || ''] || 'unknown'}]`;
    }
  });
}

// -- Layer 2: auto_compact - save transcript, summarize, replace messages --
async function autoCompact(messages: Message[]): Promise<Message[]> {
  // Ensure transcript directory exists
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

  // Save full transcript to disk
  const timestamp = Math.floor(Date.now() / 1000);
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${timestamp}.jsonl`);

  const writeStream = fs.createWriteStream(transcriptPath);
  for (const msg of messages) {
    writeStream.write(JSON.stringify(msg) + '\n');
  }
  writeStream.end();

  console.log(chalk.blue(`[transcript saved: ${transcriptPath}]`));

  // Ask LLM to summarize
  const conversationText = JSON.stringify(messages).slice(0, 80000);

  const response = await ollama.chat({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content:
          'Summarize this conversation for continuity. Include: ' +
          '1) What was accomplished, 2) Current state, 3) Key decisions made. ' +
          'Be concise but preserve critical details.\n\n' +
          conversationText,
      },
    ],
  });

  const summary = response.message.content || '(no summary)';
  return [
    {
      role: 'user',
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: 'assistant',
      content: 'Understood. I have the context from the summary. Continuing.',
    },
  ];
}

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
type ToolHandler = (args: Record<string, unknown>, messages: Message[]) => string | { compact: true; messages: Message[] };

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (args) => runBash(args.command as string),
  read_file: (args) => runRead(args.path as string, args.limit as number | undefined),
  write_file: (args) => runWrite(args.path as string, args.content as string),
  edit_file: (args) => runEdit(args.path as string, args.old_text as string, args.new_text as string),
  compact: () => 'Compressing...',
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
      name: 'compact',
      description: 'Trigger manual conversation compression.',
      parameters: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'What to preserve in the summary' },
        },
      },
    },
  },
];

/**
 * Agent loop with three-layer compression
 */
async function agentLoop(messages: Message[]): Promise<boolean> {
  while (true) {
    // Layer 1: micro_compact before each LLM call
    microCompact(messages);

    // Layer 2: auto_compact if token estimate exceeds threshold
    if (estimateTokens(messages) > THRESHOLD) {
      console.log(chalk.blue('[auto_compact triggered]'));
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
      return true; // Restart loop after auto compact
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
      return false;
    }

    // Execute each tool call
    let manualCompact = false;
    for (const toolCall of assistantMessage.tool_calls) {
      const args = toolCall.function.arguments as Record<string, unknown>;
      const toolName = toolCall.function.name;
      const handler = TOOL_HANDLERS[toolName];
      let output: string;

      try {
        const result = handler ? handler(args, messages) : `Unknown tool: ${toolName}`;
        output = typeof result === 'string' ? result : result.toString();
      } catch (error: unknown) {
        output = `Error: ${(error as Error).message}`;
      }

      if (toolName === 'compact') {
        manualCompact = true;
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
      } else {
        console.log(`> ${toolName}: ${output.slice(0, 200)}`);
      }

      const toolCallId = (toolCall as unknown as Record<string, unknown>).id || '<unknown>';
      messages.push({
        role: 'tool',
        content: output,
      } as ToolResultMessage);
    }

    // Layer 3: manual compact triggered by the compact tool
    if (manualCompact) {
      console.log(chalk.blue('[manual compact]'));
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
      return true; // Signal that we need to restart the loop
    }
  }
}

// REPL
async function main() {
  console.log(chalk.cyan(`s06 (Ollama: ${MODEL})`));
  console.log('Compression enabled: micro_compact + auto_compact + compact tool.\n');
  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt(chalk.cyan('s06 >> '));
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) {
        break;
      }
      history.push({ role: 'user', content: query });
      const needsRestart = await agentLoop(history);
      if (needsRestart) {
        continue; // Restart loop after manual compact
      }

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