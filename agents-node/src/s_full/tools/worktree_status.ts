/**
 * worktree_status.ts - Show git status for a worktree (s12)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const worktreeStatusTool: ToolDefinition = {
  name: 'worktree_status',
  description: 'Show git status for one worktree.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Worktree name',
      },
    },
    required: ['name'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const name = args.name as string;
    return ctx.worktreeManager.status(name);
  },
};