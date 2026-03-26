/**
 * task.ts - Spawn subagent for isolated work (s04)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import { ollama, MODEL } from '../../ollama.js';
import type { Tool, Message } from 'ollama';
import type { ToolDefinition, AgentContext } from '../types.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Subagent tools (limited toolset)
const SUB_TOOLS: Tool[] = [
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
        properties: { path: { type: 'string', description: 'File path' } },
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
          path: { type: 'string', description: 'File path' },
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
          path: { type: 'string', description: 'File path' },
          old_text: { type: 'string', description: 'Text to replace' },
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
];

export const taskTool: ToolDefinition = {
  name: 'task',
  description: 'Spawn a subagent for isolated exploration or work.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task prompt for the subagent',
      },
      agent_type: {
        type: 'string',
        enum: ['Explore', 'general-purpose'],
        description: 'Type of agent (Explore has no write tools)',
      },
    },
    required: ['prompt'],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const prompt = args.prompt as string;
    const agentType = (args.agent_type as string) || 'Explore';

    // Select tools based on agent type
    const tools = agentType === 'Explore' ? SUB_TOOLS.slice(0, 2) : SUB_TOOLS;

    // Subagent handlers
    const subHandlers: Record<string, (args: Record<string, unknown>) => string> = {
      bash: (a) => {
        const cmd = a.command as string;
        const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
        if (dangerous.some((d) => cmd.includes(d))) return 'Error: Dangerous command blocked';
        try {
          const result = execSync(cmd, { cwd: ctx.workdir, encoding: 'utf-8', timeout: 120000 });
          return (result || '(no output)').slice(0, 50000);
        } catch (e: unknown) {
          const err = e as { stderr?: string; message?: string };
          return (err.stderr || err.message || 'Unknown error').slice(0, 50000);
        }
      },
      read_file: (a) => {
        const safe = path.resolve(ctx.workdir, a.path as string);
        if (!safe.startsWith(ctx.workdir)) return `Error: Path escapes workspace`;
        try {
          return fs.readFileSync(safe, 'utf-8').slice(0, 50000);
        } catch (e: unknown) {
          return `Error: ${(e as Error).message}`;
        }
      },
      write_file: (a) => {
        const safe = path.resolve(ctx.workdir, a.path as string);
        if (!safe.startsWith(ctx.workdir)) return `Error: Path escapes workspace`;
        try {
          fs.mkdirSync(path.dirname(safe), { recursive: true });
          fs.writeFileSync(safe, a.content as string, 'utf-8');
          return `Wrote ${(a.content as string).length} bytes`;
        } catch (e: unknown) {
          return `Error: ${(e as Error).message}`;
        }
      },
      edit_file: (a) => {
        const safe = path.resolve(ctx.workdir, a.path as string);
        if (!safe.startsWith(ctx.workdir)) return `Error: Path escapes workspace`;
        try {
          const content = fs.readFileSync(safe, 'utf-8');
          if (!content.includes(a.old_text as string)) return `Error: Text not found`;
          fs.writeFileSync(safe, content.replace(a.old_text as string, a.new_text as string), 'utf-8');
          return `Edited ${a.path}`;
        } catch (e: unknown) {
          return `Error: ${(e as Error).message}`;
        }
      },
    };

    ctx.brief('magenta', 'task', prompt.slice(0, 60));

    const messages: Message[] = [{ role: 'user', content: prompt }];
    let response = null;

    for (let i = 0; i < 30; i++) {
      try {
        response = await ollama.chat({
          model: MODEL,
          messages: [{ role: 'system', content: `You are a subagent at ${ctx.workdir}.` }, ...messages],
          tools,
        });
      } catch (e) {
        return `Subagent error: ${(e as Error).message}`;
      }

      messages.push({
        role: 'assistant',
        content: response.message.content || '',
        tool_calls: response.message.tool_calls,
      });

      if (!response.message.tool_calls || response.message.tool_calls.length === 0) {
        break;
      }

      const results: Message[] = [];
      for (const tc of response.message.tool_calls) {
        const handler = subHandlers[tc.function.name];
        const args = tc.function.arguments as Record<string, unknown>;
        const output = handler ? handler(args).slice(0, 50000) : `Unknown tool: ${tc.function.name}`;
        results.push({
          role: 'tool',
          content: output,
        } as Message);
      }
      messages.push({ role: 'user', content: results.map((r) => r.content).join('\n') } as Message);
    }

    if (response) {
      const text = response.message.content || '(no summary)';
      return text.slice(0, 10000);
    }
    return '(subagent failed)';
  },
};