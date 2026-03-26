/**
 * worktree_create.ts - Create a git worktree (s12)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const worktreeCreateTool: ToolDefinition = {
  name: 'worktree_create',
  description: 'Create a git worktree and optionally bind it to a task.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Worktree name',
      },
      task_id: {
        type: 'integer',
        description: 'Task ID to bind (optional)',
      },
      base_ref: {
        type: 'string',
        description: 'Base ref (default: HEAD)',
      },
    },
    required: ['name'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const name = args.name as string;
    const taskId = args.task_id as number | undefined;
    const baseRef = (args.base_ref as string) || 'HEAD';
    ctx.brief('magenta', 'worktree', `create ${name}`);
    try {
      return ctx.worktreeManager.create(name, taskId, baseRef);
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};