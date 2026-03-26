/**
 * task_create.ts - Create a persistent file task (s07)
 *
 * Scope: ['main', 'child'] - Available to lead and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const taskCreateTool: ToolDefinition = {
  name: 'task_create',
  description: 'Create a new task on the shared task board.',
  input_schema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Task subject/title',
      },
      description: {
        type: 'string',
        description: 'Task description (optional)',
      },
    },
    required: ['subject'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const subject = args.subject as string;
    const description = (args.description as string) || '';
    ctx.brief('cyan', 'create', `task: ${subject.slice(0, 50)}`);
    return ctx.taskManager.create(subject, description);
  },
};