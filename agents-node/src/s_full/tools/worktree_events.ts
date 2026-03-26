/**
 * worktree_events.ts - List recent worktree events (s12)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const worktreeEventsTool: ToolDefinition = {
  name: 'worktree_events',
  description: 'List recent worktree/task lifecycle events.',
  input_schema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'Number of events to return (default: 20)',
      },
    },
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const limit = (args.limit as number) || 20;
    ctx.brief('magenta', 'events', `last ${limit}`);
    return ctx.eventBus.listRecent(limit);
  },
};