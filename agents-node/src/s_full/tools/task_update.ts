/**
 * task_update.ts - Update task status or dependencies (s07)
 *
 * Scope: ['main', 'child'] - Available to lead and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const taskUpdateTool: ToolDefinition = {
  name: 'task_update',
  description: 'Update task status or dependencies.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'integer',
        description: 'Task ID',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description: 'Task status',
      },
      owner: {
        type: 'string',
        description: 'Task owner',
      },
      add_blocked_by: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Task IDs that block this task',
      },
      add_blocks: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Task IDs that this task blocks',
      },
    },
    required: ['task_id'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const taskId = args.task_id as number;
    const status = args.status as string | undefined;
    const owner = args.owner as string | undefined;
    const addBlockedBy = args.add_blocked_by as number[] | undefined;
    const addBlocks = args.add_blocks as number[] | undefined;
    return ctx.taskManager.update(taskId, status, owner, addBlockedBy, addBlocks);
  },
};