/**
 * idle.ts - Signal that you have no more work (s11)
 *
 * Scope: ['child'] - Only available to child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const idleTool: ToolDefinition = {
  name: 'idle',
  description: 'Signal that you have no more work. Enters idle polling phase.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  scope: ['child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    // This tool is handled specially in the agent loop
    // It signals the child process to enter idle phase
    return 'Entering idle phase. Will poll for new tasks.';
  },
};