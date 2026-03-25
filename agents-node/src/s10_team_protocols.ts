#!/usr/bin/env node
/**
 * s10_team_protocols.ts - Team Protocols
 *
 * Harness: protocols -- structured handshakes between models.
 *
 * Shutdown protocol and plan approval protocol, both using the same
 * request_id correlation pattern. Builds on s09's team messaging.
 *
 *     Shutdown FSM: pending -> approved | rejected
 *
 *     Lead                              Teammate
 *     +---------------------+          +---------------------+
 *     | shutdown_request     |          |                     |
 *     | {                    | -------> | receives request    |
 *     |   request_id: abc    |          | decides: approve?   |
 *     | }                    |          |                     |
 *     +---------------------+          +---------------------+
 *                                             |
 *     +---------------------+          +-------v-------------+
 *     | shutdown_response    | <------- | shutdown_response   |
 *     | {                    |          | {                   |
 *     |   request_id: abc    |          |   request_id: abc   |
 *     |   approve: true      |          |   approve: true     |
 *     | }                    |          | }                   |
 *     +---------------------+          +---------------------+
 *             |
 *             v
 *     status -> "shutdown", loop stops
 *
 *     Plan approval FSM: pending -> approved | rejected
 *
 *     Teammate                          Lead
 *     +---------------------+          +---------------------+
 *     | plan_approval        |          |                     |
 *     | submit: {plan:"..."}| -------> | reviews plan text   |
 *     +---------------------+          | approve/reject?     |
 *                                     +---------------------+
 *                                             |
 *     +---------------------+          +-------v-------------+
 *     | plan_approval_resp   | <------- | plan_approval       |
 *     | {approve: true}      |          | review: {req_id,    |
 *     +---------------------+          |   approve: true}     |
 *                                     +---------------------+
 *
 *     Trackers: {request_id: {"target|from": name, "status": "pending|..."}}
 *
 * Key insight: "Same request_id correlation pattern, two domains."
 *
 * In Node.js, we use async functions with the event loop for concurrency
 * instead of Python's threading module. No lock needed for shared state
 * since JavaScript is single-threaded.
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { type Message, type Tool } from 'ollama';
import { ollama, MODEL } from './ollama.js';
import chalk from 'chalk';

const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, '.team');
const INBOX_DIR = path.join(TEAM_DIR, 'inbox');
const TRANSCRIPTS_DIR = path.join(WORKDIR, '.transcripts');

const SYSTEM = `You are a team lead at ${WORKDIR}. Manage teammates with shutdown and plan approval protocols.`;

const VALID_MSG_TYPES = [
  'message',
  'broadcast',
  'shutdown_request',
  'shutdown_response',
  'plan_approval_response',
];

// -- Request trackers: correlate by request_id --
// In Node.js single-threaded event loop, no lock needed for shared state
interface ShutdownRequest {
  target: string;
  status: 'pending' | 'approved' | 'rejected';
}

interface PlanRequest {
  from: string;
  plan: string;
  status: 'pending' | 'approved' | 'rejected';
}

const shutdownRequests: Map<string, ShutdownRequest> = new Map();
const planRequests: Map<string, PlanRequest> = new Map();

// -- MessageBus: JSONL inbox per teammate --
interface MessagePayload {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: unknown;
}

class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType: string = 'message',
    extra?: Record<string, unknown>
  ): string {
    if (!VALID_MSG_TYPES.includes(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${VALID_MSG_TYPES.join(', ')}`;
    }
    const msg: MessagePayload = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now(),
      ...(extra || {}),
    };
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + '\n', 'utf-8');
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): MessagePayload[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) {
      return [];
    }
    const content = fs.readFileSync(inboxPath, 'utf-8').trim();
    if (!content) {
      return [];
    }
    const messages: MessagePayload[] = content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    // Drain inbox
    fs.writeFileSync(inboxPath, '', 'utf-8');
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, 'broadcast');
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

// -- TeammateManager with shutdown + plan approval --
interface TeamMember {
  name: string;
  role: string;
  status: 'working' | 'idle' | 'shutdown';
}

interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

interface ConfigJson {
  team_name: string;
  members: TeamMember[];
}

class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private teammates: Map<string, Promise<void>> = new Map();

  constructor(teamDir: string) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, 'config.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      const data = JSON.parse(fs.readFileSync(this.configPath, 'utf-8')) as ConfigJson;
      return data;
    }
    return { team_name: 'default', members: [] };
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  async spawn(name: string, role: string, prompt: string): Promise<string> {
    const member = this.findMember(name);
    if (member) {
      if (member.status !== 'idle' && member.status !== 'shutdown') {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = 'working';
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: 'working' });
    }
    this.saveConfig();

    // Start teammate as async function (fire and forget, but track the promise)
    const promise = this.teammateLoop(name, role, prompt).catch((err) => {
      console.error(chalk.red(`[${name}] Error: ${err.message}`));
    });
    this.teammates.set(name, promise);

    return `Spawned '${name}' (role: ${role})`;
  }

  private async teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}. Submit plans via plan_approval before major work. Respond to shutdown_request with shutdown_response.`;
    const messages: Message[] = [{ role: 'user', content: prompt }];
    const tools = this.getTeammateTools();

    // Register history for dump functionality
    histories.set(name, messages);

    // Teammate loop runs until no tool calls or shutdown approved
    // Shutdown is handled via protocol: lead sends shutdown_request,
    // teammate calls shutdown_response with approve=true, then exits
    while (true) {
      // Read inbox
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        if (msg.type === 'shutdown_request') {
          this.updateStatus(name, 'shutdown');
          return;
        }
        messages.push({ role: 'user', content: JSON.stringify(msg) });
      }

      try {
        const response = await ollama.chat({
          model: MODEL,
          messages: [{ role: 'system', content: sysPrompt }, ...messages],
          tools,
        });

        const assistantMessage = response.message;
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: assistantMessage.tool_calls,
        });

        // If no tool calls, we're done
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          break;
        }

        // Execute tool calls
        let shouldExit = false;
        for (const toolCall of assistantMessage.tool_calls) {
          const args = toolCall.function.arguments as Record<string, unknown>;
          const toolName = toolCall.function.name;
          const output = this.execTool(name, toolName, args);
          console.log(chalk.gray(`  [${name}] ${toolName}: ${output.slice(0, 120)}`));
          messages.push({
            role: 'tool',
            content: `tool call ${toolName} finished. ${output}`,
          });
          // Check if shutdown was approved
          if (toolName === 'shutdown_response' && args.approve === true) {
            shouldExit = true;
          }
        }

        if (shouldExit) {
          this.updateStatus(name, 'shutdown');
          return;
        }
      } catch {
        break;
      }
    }

    // Set status to idle when done
    this.updateStatus(name, 'idle');
  }

  private updateStatus(name: string, status: TeamMember['status']): void {
    const member = this.findMember(name);
    if (member && member.status !== 'shutdown') {
      member.status = status;
      this.saveConfig();
    }
  }

  private execTool(sender: string, toolName: string, args: Record<string, unknown>): string {
    // Base tools
    if (toolName === 'bash') {
      return runBash(args.command as string);
    }
    if (toolName === 'read_file') {
      return runRead(args.path as string, args.limit as number | undefined);
    }
    if (toolName === 'write_file') {
      return runWrite(args.path as string, args.content as string);
    }
    if (toolName === 'edit_file') {
      return runEdit(args.path as string, args.old_text as string, args.new_text as string);
    }
    if (toolName === 'send_message') {
      return BUS.send(sender, args.to as string, args.content as string, args.msg_type as string | undefined);
    }
    if (toolName === 'read_inbox') {
      return JSON.stringify(BUS.readInbox(sender), null, 2);
    }
    if (toolName === 'shutdown_response') {
      const reqId = args.request_id as string;
      const approve = args.approve as boolean;
      const reason = (args.reason as string) || '';

      // Update tracker
      const req = shutdownRequests.get(reqId);
      if (req) {
        req.status = approve ? 'approved' : 'rejected';
      }

      // Send response to lead
      BUS.send(
        sender,
        'lead',
        reason,
        'shutdown_response',
        { request_id: reqId, approve }
      );

      return `Shutdown ${approve ? 'approved' : 'rejected'}`;
    }
    if (toolName === 'plan_approval') {
      const planText = (args.plan as string) || '';
      const reqId = generateId();

      // Store in tracker
      planRequests.set(reqId, { from: sender, plan: planText, status: 'pending' });

      // Send to lead for approval
      BUS.send(
        sender,
        'lead',
        planText,
        'plan_approval_response',
        { request_id: reqId, plan: planText }
      );

      return `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
    }
    return `Unknown tool: ${toolName}`;
  }

  private getTeammateTools(): Tool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: 'The shell command to execute' } },
            required: ['command'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read file contents.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to workspace' },
              limit: { type: 'integer', description: 'Maximum lines to read' },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write content to file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to workspace' },
              content: { type: 'string', description: 'Content to write' },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'edit_file',
          description: 'Replace exact text in file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to workspace' },
              old_text: { type: 'string', description: 'Text to replace' },
              new_text: { type: 'string', description: 'Replacement text' },
            },
            required: ['path', 'old_text', 'new_text'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'send_message',
          description: 'Send message to a teammate.',
          parameters: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Recipient teammate name' },
              content: { type: 'string', description: 'Message content' },
              msg_type: {
                type: 'string',
                enum: VALID_MSG_TYPES,
                description: 'Message type',
              },
            },
            required: ['to', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_inbox',
          description: 'Read and drain your inbox.',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'shutdown_response',
          description: 'Respond to a shutdown request. Approve to shut down, reject to keep working.',
          parameters: {
            type: 'object',
            properties: {
              request_id: { type: 'string', description: 'The request ID from shutdown_request' },
              approve: { type: 'boolean', description: 'Whether to approve shutdown' },
              reason: { type: 'string', description: 'Optional reason for response' },
            },
            required: ['request_id', 'approve'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'plan_approval',
          description: 'Submit a plan for lead approval. Provide plan text.',
          parameters: {
            type: 'object',
            properties: {
              plan: { type: 'string', description: 'Plan text to submit for approval' },
            },
            required: ['plan'],
          },
        },
      },
    ];
  }

  listAll(): string {
    if (this.config.members.length === 0) {
      return 'No teammates.';
    }
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join('\n');
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }

  async waitForAll(timeoutMs: number = 30000): Promise<void> {
    const promises = Array.from(this.teammates.values());
    if (promises.length === 0) return;

    // Log after 1 second if still waiting (only show teammates still working)
    const logTimer = setTimeout(() => {
      const workingNames = this.config.members
        .filter(m => m.status === 'working')
        .map(m => m.name);
      if (workingNames.length > 0) {
        console.log(chalk.gray(`[hold] waiting for ${workingNames.join(', ')} to finish`));
      }
    }, 1000);

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`waitForAll timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    try {
      await Promise.race([Promise.all(promises), timeout]);
    } catch (err) {
      console.error(chalk.yellow(`Warning: ${(err as Error).message}`));
      // Don't throw - just return to prompt
    } finally {
      clearTimeout(logTimer);
    }
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

// -- History store for dump functionality --
const histories: Map<string, Message[]> = new Map();

// -- Utility functions --
function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function dumpHistory(name: string): string {
  const messages = histories.get(name);
  if (!messages) {
    return `Error: No history found for '${name}'`;
  }

  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `dump_${name}_${timestamp}.jsonl`;
  const filepath = path.join(TRANSCRIPTS_DIR, filename);

  const lines = messages.map((msg) => JSON.stringify(msg));
  fs.writeFileSync(filepath, lines.join('\n'), 'utf-8');

  return `Dumped ${messages.length} messages to ${filename}`;
}

// -- Base tool implementations --
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot'];
  if (dangerous.some((d) => command.includes(d))) {
    return 'Error: Dangerous command blocked';
  }
  try {
    const result = execSync(command, {
      cwd: WORKDIR,
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return (result || '(no output)').slice(0, 50000);
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    return (err.stderr || err.message || 'Unknown error').slice(0, 50000);
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    const safe = safePath(filePath);
    const content = fs.readFileSync(safe, 'utf-8');
    const lines = content.split('\n');
    if (limit && limit < lines.length) {
      return lines.slice(0, limit).join('\n') + `\n... (${lines.length - limit} more lines)`;
    }
    return content.slice(0, 50000);
  } catch (error: unknown) {
    return `Error: ${(error as Error).message}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const safe = safePath(filePath);
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, content, 'utf-8');
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (error: unknown) {
    return `Error: ${(error as Error).message}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const safe = safePath(filePath);
    const content = fs.readFileSync(safe, 'utf-8');
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(safe, content.replace(oldText, newText), 'utf-8');
    return `Edited ${filePath}`;
  } catch (error: unknown) {
    return `Error: ${(error as Error).message}`;
  }
}

// -- Lead-specific protocol handlers --
function handleShutdownRequest(teammate: string): string {
  const reqId = generateId();
  shutdownRequests.set(reqId, { target: teammate, status: 'pending' });
  BUS.send('lead', teammate, 'Please shut down gracefully.', 'shutdown_request', { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback: string = ''): string {
  const req = planRequests.get(requestId);
  if (!req) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }
  req.status = approve ? 'approved' : 'rejected';
  BUS.send('lead', req.from, feedback, 'plan_approval_response', {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}

function checkShutdownStatus(requestId: string): string {
  const req = shutdownRequests.get(requestId);
  if (!req) {
    return JSON.stringify({ error: 'not found' });
  }
  return JSON.stringify({ request_id: requestId, target: req.target, status: req.status });
}

// -- Lead tool dispatch (12 tools) --
type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (args) => runBash(args.command as string),
  read_file: (args) => runRead(args.path as string, args.limit as number | undefined),
  write_file: (args) => runWrite(args.path as string, args.content as string),
  edit_file: (args) => runEdit(args.path as string, args.old_text as string, args.new_text as string),
  spawn_teammate: async (args) => TEAM.spawn(args.name as string, args.role as string, args.prompt as string),
  list_teammates: () => TEAM.listAll(),
  send_message: (args) =>
    BUS.send('lead', args.to as string, args.content as string, args.msg_type as string | undefined),
  read_inbox: () => JSON.stringify(BUS.readInbox('lead'), null, 2),
  broadcast: (args) => BUS.broadcast('lead', args.content as string, TEAM.memberNames()),
  shutdown_request: (args) => handleShutdownRequest(args.teammate as string),
  shutdown_response: (args) => checkShutdownStatus(args.request_id as string),
  plan_approval: (args) =>
    handlePlanReview(args.request_id as string, args.approve as boolean, (args.feedback as string) || ''),
};

// Lead tools
const TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to execute' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
          limit: { type: 'integer', description: 'Maximum lines to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace exact text in file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
          old_text: { type: 'string', description: 'Text to replace' },
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_teammate',
      description: 'Spawn a persistent teammate.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Teammate name' },
          role: { type: 'string', description: 'Teammate role (e.g., coder, tester)' },
          prompt: { type: 'string', description: 'Initial task prompt' },
        },
        required: ['name', 'role', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_teammates',
      description: 'List all teammates.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a message to a teammate.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient teammate name' },
          content: { type: 'string', description: 'Message content' },
          msg_type: {
            type: 'string',
            enum: VALID_MSG_TYPES,
            description: 'Message type',
          },
        },
        required: ['to', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_inbox',
      description: "Read and drain the lead's inbox.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'broadcast',
      description: 'Send a message to all teammates.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Message content' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shutdown_request',
      description: 'Request a teammate to shut down gracefully. Returns a request_id for tracking.',
      parameters: {
        type: 'object',
        properties: {
          teammate: { type: 'string', description: 'Teammate name to shut down' },
        },
        required: ['teammate'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shutdown_response',
      description: 'Check the status of a shutdown request by request_id.',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'Request ID to check' },
        },
        required: ['request_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_approval',
      description: 'Approve or reject a teammate plan. Provide request_id + approve + optional feedback.',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'Plan request ID' },
          approve: { type: 'boolean', description: 'Whether to approve the plan' },
          feedback: { type: 'string', description: 'Optional feedback for the teammate' },
        },
        required: ['request_id', 'approve'],
      },
    },
  },
];

/**
 * Agent loop - checks inbox before each LLM call
 */
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    // Read inbox before each iteration
    const inbox = BUS.readInbox('lead');
    if (inbox.length > 0) {
      messages.push({
        role: 'user',
        content: `<inbox>\n${JSON.stringify(inbox, null, 2)}\n</inbox>`,
      });
      messages.push({ role: 'assistant', content: 'Noted inbox messages.' });
    }

    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools: TOOLS,
    });

    const assistantMessage = response.message;
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    // If no tool calls, we're done
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return;
    }

    // Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      const args = toolCall.function.arguments as Record<string, unknown>;
      const toolName = toolCall.function.name;
      const handler = TOOL_HANDLERS[toolName];
      let output: string;

      try {
        output = handler ? await handler(args) : `Unknown tool: ${toolName}`;
      } catch (error: unknown) {
        output = `Error: ${(error as Error).message}`;
      }

      // Friendly console output
      if (toolName === 'bash') {
        console.log(chalk.yellow(`$ ${args.command}`));
        console.log(output.slice(0, 300));
      } else if (toolName === 'spawn_teammate') {
        console.log(chalk.magenta('[spawn]') + ` ${(args.name as string)}`);
        console.log(output);
      } else if (toolName === 'list_teammates') {
        console.log(chalk.magenta('[team]'));
        console.log(output);
      } else if (toolName === 'send_message' || toolName === 'broadcast') {
        console.log(chalk.blue('[msg]') + ` -> ${(args.to as string) || 'all'}`);
        console.log(output);
      } else if (toolName === 'read_inbox') {
        console.log(chalk.blue('[inbox]'));
        console.log(output);
      } else if (toolName === 'shutdown_request') {
        console.log(chalk.red('[shutdown]') + ` request sent`);
        console.log(output);
      } else if (toolName === 'shutdown_response') {
        console.log(chalk.red('[shutdown]') + ` status check`);
        console.log(output);
      } else if (toolName === 'plan_approval') {
        console.log(chalk.green('[plan]') + ` review`);
        console.log(output);
      } else {
        console.log(`> ${toolName}: ${output.slice(0, 200)}`);
      }

      const toolCallId = (toolCall as unknown as Record<string, unknown>).id || '<unknown>';
      messages.push({
        role: 'tool',
        content: `tool call ${toolName}#${toolCallId} finished. ${output}`,
      });
    }
  }
}

// REPL
async function main() {
  console.log(chalk.cyan(`s10 (Ollama: ${MODEL})`));
  console.log('Team protocols enabled. Shutdown and plan approval protocols.');
  console.log('Commands: /team, /inbox, /dump <name>\n');
  const history: Message[] = [];

  // Register lead's history for dump functionality
  histories.set('lead', history);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt(chalk.cyan('s10 >> '));
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) {
        break;
      }
      if (query.trim() === '/team') {
        console.log(TEAM.listAll());
        continue;
      }
      if (query.trim() === '/inbox') {
        console.log(JSON.stringify(BUS.readInbox('lead'), null, 2));
        continue;
      }
      if (query.trim().startsWith('/dump ')) {
        const name = query.trim().slice(6).trim();
        console.log(dumpHistory(name));
        continue;
      }
      history.push({ role: 'user', content: query });
      await agentLoop(history);

      // Wait for all teammates to finish (with timeout)
      await TEAM.waitForAll(30000);

      // Print final response
      const lastMsg = history[history.length - 1];
      if (lastMsg.content) {
        console.log(lastMsg.content);
      }
      console.log();
    } catch (err) {
      console.error('Error:', err);
    }
  }
  rl.close();
}

main().catch(console.error);