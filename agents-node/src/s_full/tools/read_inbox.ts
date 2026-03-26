/**
 * read_inbox.ts - Read and drain the lead's inbox (s09)
 *
 * Scope: ['main', 'child'] - Available to lead and child agents
 * Note: For child processes, inbox is managed via IPC in teammate-worker
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const readInboxTool: ToolDefinition = {
  name: 'read_inbox',
  description: "Read and drain your inbox.",
  input_schema: {
    type: 'object',
    properties: {},
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    // For main process, this returns a placeholder
    // Actual inbox reading is handled via IPC for children
    ctx.brief('blue', 'inbox', 'read');
    return 'Lead inbox is handled via REPL commands (/inbox)';
  },
};