/**
 * list_teammates.ts - List all teammates (s09/s11)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const listTeammatesTool: ToolDefinition = {
  name: 'list_teammates',
  description: 'List all teammates with their current status.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    ctx.brief('magenta', 'team', 'list');
    return ctx.teammateManager.listAll();
  },
};