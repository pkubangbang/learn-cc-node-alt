/**
 * broadcast.ts - Send message to all teammates (s09)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const broadcastTool: ToolDefinition = {
  name: 'broadcast',
  description: 'Send a message to all teammates.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Message content',
      },
    },
    required: ['content'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const content = args.content as string;
    ctx.brief('blue', 'broadcast', 'to all');
    ctx.teammateManager.broadcast(content);
    return `Broadcast to ${ctx.teammateManager.memberNames().length} teammates`;
  },
};