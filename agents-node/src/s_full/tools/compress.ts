/**
 * compress.ts - Manually compress conversation context (s06)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import * as fs from 'fs';
import * as path from 'path';
import { ollama, MODEL } from '../../ollama.js';
import type { Message } from 'ollama';
import type { ToolDefinition, AgentContext } from '../types.js';

const TRANSCRIPTS_DIR = path.join(process.cwd(), '.transcripts');

export const compressTool: ToolDefinition = {
  name: 'compress',
  description: 'Manually compress conversation context.',
  input_schema: {
    type: 'object',
    properties: {
      focus: {
        type: 'string',
        description: 'What to preserve in the summary',
      },
    },
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    // This tool triggers compression in the main loop, not directly
    // The actual compression is handled by the agent loop
    ctx.brief('blue', 'compress', 'triggered');
    return 'Compressing...';
  },
};

/**
 * Estimate tokens in messages
 */
export function estimateTokens(messages: Message[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

/**
 * Micro-compact: replace old tool results with placeholders
 */
export function microCompact(messages: Message[]): void {
  const KEEP_RECENT = 3;
  const toolResults = messages
    .map((msg, idx) => (msg.role === 'tool' ? { idx, msg } : null))
    .filter((r): r is { idx: number; msg: Message } => r !== null);

  if (toolResults.length <= KEEP_RECENT) return;

  // Build tool_call_id -> tool_name map
  const toolNameMap: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const id = (tc as unknown as Record<string, unknown>).id as string | undefined;
        if (id) toolNameMap[id] = tc.function.name;
      }
    }
  }

  // Compact old results
  for (const { msg } of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof msg.content === 'string' && msg.content.length > 100) {
      const toolCallId = (msg as unknown as Record<string, unknown>).tool_call_id as string | undefined;
      msg.content = `[Previous: used ${toolNameMap[toolCallId || ''] || 'unknown'}]`;
    }
  }
}

/**
 * Auto-compact: save transcript and summarize
 */
export async function autoCompact(messages: Message[]): Promise<Message[]> {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  const timestamp = Math.floor(Date.now() / 1000);
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `transcript_${timestamp}.jsonl`);

  const writeStream = fs.createWriteStream(transcriptPath);
  for (const msg of messages) {
    writeStream.write(JSON.stringify(msg) + '\n');
  }
  writeStream.end();

  console.log(`\x1b[34m[transcript saved: ${transcriptPath}]\x1b[0m`);

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