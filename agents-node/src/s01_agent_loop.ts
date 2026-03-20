#!/usr/bin/env node
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * Harness: the loop -- the model's first connection to the real world.
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while stop_reason == "tool_use":
 *         response = LLM(messages, tools)
 *         execute tools
 *         append results
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Production agents layer
 * policy, hooks, and lifecycle controls on top.
 */

import * as readline from 'readline';
import { execSync } from 'child_process';
import { Ollama, type Message, type Tool } from 'ollama';
import 'dotenv/config';

// Configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const MODEL = process.env.OLLAMA_MODEL || 'glm-5:cloud';

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use bash to solve tasks. Act, don't explain.`;

// Initialize Ollama client
const ollama = new Ollama({
  host: OLLAMA_HOST,
  ...(OLLAMA_API_KEY ? { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` } } : {}),
});

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
];

// Tool implementation
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

/**
 * The core pattern: a while loop that calls tools until the model stops.
 */
async function agentLoop(messages: Message[]): Promise<void> {
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
      return;
    }

    // Execute each tool call, collect results
    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.function.name === 'bash') {
        const args = toolCall.function.arguments;
        const command = args.command as string;
        console.log(`\x1b[33m$ ${command}\x1b[0m`);
        const output = runBash(command);
        console.log(output.slice(0, 200));

        messages.push({
          role: 'tool',
          content: output,
        });
      }
    }
  }
}

// REPL
async function main() {
  console.log(`\x1b[36ms01 (Ollama: ${MODEL})\x1b[0m`);
  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt('\x1b[36ms01 >> \x1b[0m');
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
