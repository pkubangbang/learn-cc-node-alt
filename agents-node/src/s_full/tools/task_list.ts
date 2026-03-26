/**
 * task_list.ts - List all tasks (s07)
 *
 * Scope: ['main', 'child'] - Available to lead and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const taskListTool: ToolDefinition = {
  name: 'task_list',
  description: 'List all tasks.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    ctx.brief('cyan', 'tasks', 'list');
    return ctx.taskManager.listAll();
  },
};