/**
 * todo_write.ts - Update task tracking list (s03)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const todoWriteTool: ToolDefinition = {
  name: 'TodoWrite',
  description: 'Update task tracking list. Track progress on multi-step tasks.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Task description',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Task status',
            },
            activeForm: {
              type: 'string',
              description: 'Present continuous form shown when in_progress',
            },
          },
          required: ['content', 'status', 'activeForm'],
        },
      },
    },
    required: ['items'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const items = args.items as Array<{
      content?: string;
      status?: string;
      activeForm?: string;
    }>;
    try {
      const validatedItems = items.map((item) => ({
        content: String(item?.content ?? '').trim(),
        status: String(item?.status ?? 'pending').toLowerCase() as 'pending' | 'in_progress' | 'completed',
        activeForm: String(item?.activeForm ?? '').trim(),
      }));
      return ctx.todoManager.update(validatedItems);
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};