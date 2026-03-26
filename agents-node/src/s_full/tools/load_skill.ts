/**
 * load_skill.ts - Load specialized knowledge (s05)
 *
 * Scope: ['main'] - Only available to lead agent
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const loadSkillTool: ToolDefinition = {
  name: 'load_skill',
  description: 'Load specialized knowledge by name.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill name to load',
      },
    },
    required: ['name'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const name = args.name as string;
    ctx.brief('magenta', 'skill', name);
    return ctx.skillLoader.getContent(name);
  },
};