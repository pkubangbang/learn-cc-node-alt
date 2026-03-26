/**
 * worktree_keep.ts - Mark worktree as kept (s12)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const worktreeKeepTool: ToolDefinition = {
  name: 'worktree_keep',
  description: 'Mark a worktree as kept in lifecycle state without removing it.',
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
    ctx.brief('magenta', 'worktree', `keep ${name}`);
    return ctx.worktreeManager.keep(name);
  },
};