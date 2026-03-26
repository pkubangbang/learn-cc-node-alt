/**
 * worktree_run.ts - Run command in a worktree (s12)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const worktreeRunTool: ToolDefinition = {
  name: 'worktree_run',
  description: 'Run a shell command in a named worktree directory.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Worktree name',
      },
      command: {
        type: 'string',
        description: 'Shell command to run',
      },
    },
    required: ['name', 'command'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const name = args.name as string;
    const command = args.command as string;
    ctx.brief('magenta', 'worktree', `run ${name}: ${command.slice(0, 40)}`);
    return ctx.worktreeManager.run(name, command);
  },
};