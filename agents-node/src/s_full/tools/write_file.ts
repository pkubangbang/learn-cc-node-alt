/**
 * write_file.ts - Write content to file
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition, AgentContext } from '../types.js';

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to file.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace',
      },
      content: {
        type: 'string',
        description: 'Content to write',
      },
    },
    required: ['path', 'content'],
  },
  scope: ['main', 'child', 'bg'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const filePath = args.path as string;
    const content = args.content as string;

    const safe = path.resolve(ctx.workdir, filePath);
    if (!safe.startsWith(ctx.workdir)) {
      return `Error: Path escapes workspace: ${filePath}`;
    }

    ctx.brief('green', 'write', `${filePath} (${content.length} bytes)`);

    try {
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, content, 'utf-8');
      return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};