/**
 * task_get.ts - Get task details by ID (s07)
 *
 * Scope: ['main', 'child'] - Available to lead and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const taskGetTool: ToolDefinition = {
  name: 'task_get',
  description: 'Get task details by ID.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'integer',
        description: 'Task ID',
      },
    },
    required: ['task_id'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const taskId = args.task_id as number;
    return ctx.taskManager.get(taskId);
  },
};