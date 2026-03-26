/**
 * worktree_remove.ts - Remove a worktree (s12)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const worktreeRemoveTool: ToolDefinition = {
  name: 'worktree_remove',
  description: 'Remove a worktree and optionally mark its bound task completed.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Worktree name',
      },
      force: {
        type: 'boolean',
        description: 'Force removal (optional)',
      },
      complete_task: {
        type: 'boolean',
        description: 'Mark bound task as completed (optional)',
      },
    },
    required: ['name'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const name = args.name as string;
    const force = (args.force as boolean) || false;
    const completeTask = (args.complete_task as boolean) || false;
    ctx.brief('magenta', 'worktree', `remove ${name}`);
    try {
      return ctx.worktreeManager.remove(name, force, completeTask);
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};