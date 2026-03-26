/**
 * check_background.ts - Check background task status (s08)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const checkBackgroundTool: ToolDefinition = {
  name: 'check_background',
  description: 'Check background task status. Omit task_id to list all.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to check (optional)',
      },
    },
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const taskId = args.task_id as string | undefined;
    ctx.brief('blue', 'bg-check', taskId || 'all');
    return ctx.backgroundManager.check(taskId);
  },
};