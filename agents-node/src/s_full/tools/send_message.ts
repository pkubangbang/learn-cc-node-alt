/**
 * send_message.ts - Send message to a teammate (s09)
 *
 * Scope: ['main', 'child'] - Available to lead and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

const VALID_MSG_TYPES = [
  'message',
  'broadcast',
  'shutdown_request',
  'shutdown_response',
  'plan_approval_response',
];

export const sendMessageTool: ToolDefinition = {
  name: 'send_message',
  description: 'Send a message to a teammate.',
  input_schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Recipient teammate name',
      },
      content: {
        type: 'string',
        description: 'Message content',
      },
      msg_type: {
        type: 'string',
        enum: VALID_MSG_TYPES,
        description: 'Message type',
      },
    },
    required: ['to', 'content'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const to = args.to as string;
    const content = args.content as string;
    const msgType = (args.msg_type as string) || 'message';
    ctx.brief('blue', 'msg', `-> ${to}`);
    ctx.teammateManager.sendTo(to, content, msgType);
    return `Sent ${msgType} to ${to}`;
  },
};