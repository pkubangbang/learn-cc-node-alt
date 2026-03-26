/**
 * worktree_list.ts - List worktrees (s12)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const worktreeListTool: ToolDefinition = {
  name: 'worktree_list',
  description: 'List worktrees tracked in .worktrees/index.json.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    ctx.brief('magenta', 'worktrees', 'list');
    return ctx.worktreeManager.listAll();
  },
};