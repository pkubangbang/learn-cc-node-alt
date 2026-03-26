/**
 * background_run.ts - Run command in background (s08)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const backgroundRunTool: ToolDefinition = {
  name: 'background_run',
  description: 'Run command in background. Returns task_id immediately.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to run in background',
      },
    },
    required: ['command'],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;
    ctx.brief('blue', 'bg', command.slice(0, 60));
    return await ctx.backgroundManager.run(command);
  },
};