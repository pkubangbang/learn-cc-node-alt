/**
 * shutdown_request.ts - Request teammate shutdown (s10)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export const shutdownRequestTool: ToolDefinition = {
  name: 'shutdown_request',
  description: 'Request a teammate to shut down gracefully.',
  input_schema: {
    type: 'object',
    properties: {
      teammate: {
        type: 'string',
        description: 'Teammate name to shut down',
      },
    },
    required: ['teammate'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const teammate = args.teammate as string;
    const reqId = generateId();
    ctx.teammateManager.shutdownRequests.set(reqId, {
      target: teammate,
      status: 'pending',
    });
    ctx.teammateManager.sendTo(teammate, 'Please shut down gracefully.', 'shutdown_request');
    ctx.brief('red', 'shutdown', `request ${reqId} -> ${teammate}`);
    return `Shutdown request ${reqId} sent to '${teammate}'`;
  },
};