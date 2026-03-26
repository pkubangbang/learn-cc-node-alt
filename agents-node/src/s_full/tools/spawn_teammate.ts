/**
 * spawn_teammate.ts - Spawn an autonomous teammate (s09/s11)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const spawnTeammateTool: ToolDefinition = {
  name: 'spawn_teammate',
  description: 'Spawn an autonomous teammate as a child process.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Teammate name',
      },
      role: {
        type: 'string',
        description: 'Teammate role (e.g., coder, tester)',
      },
      prompt: {
        type: 'string',
        description: 'Initial task prompt',
      },
    },
    required: ['name', 'role', 'prompt'],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;
    const role = args.role as string;
    const prompt = args.prompt as string;
    ctx.brief('magenta', 'spawn', name);
    return await ctx.teammateManager.spawn(name, role, prompt);
  },
};