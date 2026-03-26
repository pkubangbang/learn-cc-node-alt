/**
 * bash.ts - Run shell commands
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
 */

import { execSync } from 'child_process';
import type { ToolDefinition, AgentContext } from '../types.js';

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Run a shell command (blocking).',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
    },
    required: ['command'],
  },
  scope: ['main', 'child', 'bg'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const command = args.command as string;
    const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
    if (dangerous.some((d) => command.includes(d))) {
      return 'Error: Dangerous command blocked';
    }
    ctx.brief('yellow', 'bash', command.slice(0, 60));
    try {
      const result = execSync(command, {
        cwd: ctx.workdir,
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024,
      });
      return (result || '(no output)').slice(0, 50000);
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      return (err.stderr || err.message || 'Unknown error').slice(0, 50000);
    }
  },
};