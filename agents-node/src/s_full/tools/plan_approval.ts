/**
 * plan_approval.ts - Approve or reject a teammate's plan (s10)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const planApprovalTool: ToolDefinition = {
  name: 'plan_approval',
  description: 'Approve or reject a teammate plan.',
  input_schema: {
    type: 'object',
    properties: {
      request_id: {
        type: 'string',
        description: 'Plan request ID',
      },
      approve: {
        type: 'boolean',
        description: 'Whether to approve the plan',
      },
      feedback: {
        type: 'string',
        description: 'Optional feedback for the teammate',
      },
    },
    required: ['request_id', 'approve'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const requestId = args.request_id as string;
    const approve = args.approve as boolean;
    const feedback = (args.feedback as string) || '';

    const req = ctx.teammateManager.planRequests.get(requestId);
    if (!req) {
      return `Error: Unknown plan request_id '${requestId}'`;
    }

    req.status = approve ? 'approved' : 'rejected';
    ctx.teammateManager.sendTo(req.from, feedback, 'plan_approval_response');
    ctx.brief('green', 'plan', `${req.status} for ${req.from}`);
    return `Plan ${req.status} for '${req.from}'`;
  },
};