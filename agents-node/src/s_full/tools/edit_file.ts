/**
 * edit_file.ts - Replace exact text in file
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition, AgentContext } from '../types.js';

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Replace exact text in file.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace',
      },
      old_text: {
        type: 'string',
        description: 'Text to replace',
      },
      new_text: {
        type: 'string',
        description: 'Replacement text',
      },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  scope: ['main', 'child', 'bg'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const filePath = args.path as string;
    const oldText = args.old_text as string;
    const newText = args.new_text as string;

    const safe = path.resolve(ctx.workdir, filePath);
    if (!safe.startsWith(ctx.workdir)) {
      return `Error: Path escapes workspace: ${filePath}`;
    }

    ctx.brief('green', 'edit', filePath);

    try {
      const content = fs.readFileSync(safe, 'utf-8');
      if (!content.includes(oldText)) {
        return `Error: Text not found in ${filePath}`;
      }
      fs.writeFileSync(safe, content.replace(oldText, newText), 'utf-8');
      return `Edited ${filePath}`;
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};