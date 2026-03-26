/**
 * read_file.ts - Read file contents
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition, AgentContext } from '../types.js';

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read file contents.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace',
      },
      limit: {
        type: 'integer',
        description: 'Maximum lines to read',
      },
    },
    required: ['path'],
  },
  scope: ['main', 'child', 'bg'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const filePath = args.path as string;
    const limit = args.limit as number | undefined;

    const safe = path.resolve(ctx.workdir, filePath);
    if (!safe.startsWith(ctx.workdir)) {
      return `Error: Path escapes workspace: ${filePath}`;
    }

    ctx.brief('green', 'read', filePath);

    try {
      const content = fs.readFileSync(safe, 'utf-8');
      const lines = content.split('\n');
      if (limit && limit < lines.length) {
        return lines.slice(0, limit).join('\n') + `\n... (${lines.length - limit} more lines)`;
      }
      return content.slice(0, 50000);
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};