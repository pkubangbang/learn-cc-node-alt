/**
 * claim_task.ts - Claim a task from the board (s11)
 *
 * Scope: ['main', 'child'] - Available to lead and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const claimTaskTool: ToolDefinition = {
  name: 'claim_task',
  description: 'Claim a task from the task board by ID.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'integer',
        description: 'Task ID to claim',
      },
    },
    required: ['task_id'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const taskId = args.task_id as number;
    // Default owner to 'lead' for main, overridden by child
    const owner = args._owner as string || 'lead';
    ctx.brief('cyan', 'claim', `task #${taskId}`);
    return ctx.taskManager.claim(taskId, owner);
  },
};