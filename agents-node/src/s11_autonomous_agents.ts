#!/usr/bin/env node
/**
 * s11_autonomous_agents.ts - Autonomous Agents with Child Process Teammates
 *
 * Harness: autonomy -- models that find work without being told.
 *
 * Idle cycle with task board polling, auto-claiming unclaimed tasks, and
 * identity re-injection after context compression. Builds on s10's protocols.
 *
 * **NEW in this version**: Teammates run as child processes for true parallelism.
 * The lead process acts as a message broker (Electron-style IPC pattern).
 *
 *     Teammate lifecycle (now in child process):
 *     +-------+
 *     | spawn |  (fork child process, send spawn config via IPC)
 *     +---+---+
 *         |
 *         v
 *     +-------+  tool_use    +-------+
 *     | WORK  | <----------> |  LLM  |
 *     +---+---+              +-------+
 *         |
 *         | stop_reason != tool_use OR idle tool
 *         v
 *     +--------+
 *     | IDLE   | poll every 5s for up to 60s
 *     +---+----+
 *         |
 *         +---> check IPC inbox -> message? -> resume WORK
 *         |
 *         +---> scan .tasks/ -> unclaimed? -> claim -> resume WORK
 *         |
 *         +---> timeout (60s) -> exit process
 *
 * Key insight: "The agent finds work itself."
 *
 * IPC Architecture (Lead as Broker):
 *   Main Process (Lead) - Message Broker
 *   ├── TeammateManager
 *   │   ├── config.json (persisted state)
 *   │   ├── processes: Map<name, ChildProcess>
 *   │   └── status: Map<name, 'working' | 'idle' | 'shutdown'> (real-time)
 *   │
 *   ├── IPC Broker (routes all messages)
 *   │   ├── Lead → Child: {type: 'spawn'|'message'|'shutdown', ...}
 *   │   ├── Child → Lead: {type: 'status'|'message'|'log'|'error', ...}
 *   │   └── Lead → Child: forwards messages between teammates
 *   │
 *   └── In-memory status (no file polling needed)
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fork, ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import { type Message, type Tool } from 'ollama';
import { ollama, MODEL } from './ollama.js';
import chalk from 'chalk';

// ES module compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, '.team');
const TASKS_DIR = path.join(WORKDIR, '.tasks');
const TRANSCRIPTS_DIR = path.join(WORKDIR, '.transcripts');

const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves. 
Prefer not claiming tasks on your own but dispatching to teammates by "send_message".`;

const VALID_MSG_TYPES = [
  'message',
  'broadcast',
  'shutdown_request',
  'shutdown_response',
  'plan_approval_response',
];

// -- IPC Message Types (must match worker) --
// Parent → Child
type ParentMessage =
  | { type: 'spawn'; name: string; role: string; prompt: string; teamName: string }
  | { type: 'message'; from: string; content: string; msgType: string }
  | { type: 'shutdown' };

// Child → Parent
type ChildMessage =
  | { type: 'status'; status: 'working' | 'idle' | 'shutdown' }
  | { type: 'message'; to: string; content: string; msgType: string }
  | { type: 'log'; message: string }
  | { type: 'error'; error: string };

// -- Request trackers (for lead) --
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

// -- Task interface (shared with worker) --
interface Task {
  id: number;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  blockedBy?: number[];
}

function getNextTaskId(): number {
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    return 1;
  }
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith('task_') && f.endsWith('.json'));
  const ids = files.map((f) => parseInt(f.split('_')[1].split('.')[0], 10)).filter((n) => !isNaN(n));
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

function createTask(subject: string, description: string = ''): string {
  const id = getNextTaskId();
  const task: Task = {
    id,
    subject,
    description,
    status: 'pending',
    blockedBy: [],
    owner: undefined,
  };
  const taskPath = path.join(TASKS_DIR, `task_${id}.json`);
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
  return JSON.stringify(task, null, 2);
}

function claimTask(taskId: number, owner: string): string {
  const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);
  if (!fs.existsSync(taskPath)) {
    return `Error: Task ${taskId} not found`;
  }
  try {
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8')) as Task;
    task.owner = owner;
    task.status = 'in_progress';
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
    return `Claimed task #${taskId} for ${owner}`;
  } catch {
    return `Error: Failed to claim task ${taskId}`;
  }
}

function listTasksStr(): string {
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    return 'No tasks directory.';
  }
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith('task_') && f.endsWith('.json')).sort();
  if (files.length === 0) {
    return 'No tasks.';
  }
  const lines: string[] = [];
  for (const file of files) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf-8')) as Task;
      const marker: Record<string, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };
      const status = marker[task.status] || '[?]';
      const owner = task.owner ? ` @${task.owner}` : '';
      lines.push(`${status} #${task.id}: ${task.subject}${owner}`);
    } catch {
      // Skip malformed files
    }
  }
  return lines.join('\n');
}

// -- TeammateManager with Child Process Support --
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
  private processes: Map<string, ChildProcess> = new Map();
  private status: Map<string, 'working' | 'idle' | 'shutdown'> = new Map();

  /**
   * Get list of teammates currently in 'working' status
   */
  getWorkingTeammates(): string[] {
    return Array.from(this.status.entries())
      .filter(([_, s]) => s === 'working')
      .map(([name]) => name);
  }

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

  private updateConfigStatus(name: string, status: TeamMember['status']): void {
    const member = this.findMember(name);
    if (member && member.status !== 'shutdown') {
      member.status = status;
      this.saveConfig();
    }
  }

  /**
   * Spawn a teammate as a child process.
   * Process lifecycle is tracked via ChildProcess events, not spawn promises.
   */
  async spawn(name: string, role: string, prompt: string): Promise<string> {
    const member = this.findMember(name);
    if (member) {
      const currentStatus = this.status.get(name) || member.status;
      if (currentStatus !== 'idle' && currentStatus !== 'shutdown') {
        return `Error: '${name}' is currently ${currentStatus}`;
      }
    }

    // Update config
    if (member) {
      member.status = 'working';
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: 'working' });
    }
    this.saveConfig();

    // Spawn child process using Node.js fork (silent: true to prevent interleaved output)
    const workerPath = path.join(__dirname, 'teammate-worker.js');
    const child = fork(workerPath, [], { cwd: WORKDIR, silent: true });

    // Track process and status (no promises!)
    this.processes.set(name, child);
    this.status.set(name, 'working');

    // Capture child stdout/stderr (with silent: true, these are streams we control)
    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        console.log(chalk.gray(`[${name}] ${data.toString().trim()}`));
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        console.error(chalk.red(`[${name}] stderr: ${data.toString().trim()}`));
      });
    }

    // Handle IPC messages from child (LEAD AS BROKER)
    child.on('message', (msg: ChildMessage) => {
      this.handleChildMessage(name, msg);
    });

    // Track process exit for status updates
    child.on('exit', (code) => {
      this.status.set(name, 'shutdown');
      this.updateConfigStatus(name, 'shutdown');
      this.processes.delete(name);
      console.log(chalk.gray(`[${name}] process exited (code ${code})`));
    });

    // Handle errors
    child.on('error', (err) => {
      console.error(chalk.red(`[${name}] process error: ${err.message}`));
      this.status.set(name, 'shutdown');
      this.updateConfigStatus(name, 'shutdown');
      this.processes.delete(name);
    });

    // Send spawn config to child via IPC
    const spawnMsg: ParentMessage = {
      type: 'spawn',
      name,
      role,
      prompt,
      teamName: this.config.team_name,
    };
    child.send(spawnMsg);

    return `Spawned '${name}' (role: ${role}) as child process (pid: ${child.pid})`;
  }

  /**
   * LEAD AS BROKER: Route messages between teammates and handle status updates
   */
  private handleChildMessage(sender: string, msg: ChildMessage): void {
    switch (msg.type) {
      case 'status':
        this.status.set(sender, msg.status);
        this.updateConfigStatus(sender, msg.status);
        console.log(chalk.gray(`[${sender}] status: ${msg.status}`));
        break;

      case 'message':
        // Route message to target teammate
        const targetProcess = this.processes.get(msg.to);
        if (targetProcess && targetProcess.connected) {
          const routeMsg: ParentMessage = {
            type: 'message',
            from: sender,
            content: msg.content,
            msgType: msg.msgType,
          };
          targetProcess.send(routeMsg);
          console.log(chalk.blue(`[msg] ${sender} -> ${msg.to}`));
        } else {
          // Target not found or disconnected
          console.log(chalk.yellow(`[${sender}] message to '${msg.to}' failed: not found`));
        }
        break;

      case 'log':
        console.log(chalk.gray(`[${sender}] ${msg.message}`));
        break;

      case 'error':
        console.error(chalk.red(`[${sender}] Error: ${msg.error}`));
        break;
    }
  }

  /**
   * Send message from lead to teammate via IPC
   */
  sendTo(name: string, content: string, msgType: string = 'message'): void {
    const proc = this.processes.get(name);
    if (proc && proc.connected) {
      const msg: ParentMessage = { type: 'message', from: 'lead', content, msgType };
      proc.send(msg);
    } else {
      console.log(chalk.yellow(`[lead] message to '${name}' failed: not found`));
    }
  }

  /**
   * Broadcast to all teammates via IPC
   */
  broadcast(content: string, msgType: string = 'broadcast'): void {
    for (const [name, proc] of this.processes) {
      if (proc.connected) {
        proc.send({ type: 'message', from: 'lead', content, msgType });
      }
    }
  }

  /**
   * Request graceful shutdown via IPC
   */
  requestShutdown(name: string): void {
    const proc = this.processes.get(name);
    if (proc && proc.connected) {
      proc.send({ type: 'shutdown' });
    }
  }

  /**
   * Real-time status query from in-memory map
   */
  getStatus(name: string): 'working' | 'idle' | 'shutdown' | undefined {
    return this.status.get(name);
  }

  /**
   * List all teammates with their current status
   */
  listAll(): string {
    if (this.config.members.length === 0 && this.processes.size === 0) {
      return 'No teammates.';
    }
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      const liveStatus = this.status.get(m.name) || m.status;
      lines.push(`  ${m.name} (${m.role}): ${liveStatus}`);
    }
    return lines.join('\n');
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }

  /**
   * Nudge teammates to stop working and poll until all settle.
   * Returns status changes to be injected into agent messages.
   */
  async bounce(
    messages: Message[],
    timeoutMs: number = 30000,
    pollIntervalMs: number = 1000
  ): Promise<{ allSettled: boolean; statusChanges: string[] }> {
    const teammates = Array.from(this.status.entries());

    // If no teammates, return immediately
    if (teammates.length === 0) {
      return { allSettled: true, statusChanges: [] };
    }

    // Track previous status to detect changes
    const previousStatus = new Map<string, 'working' | 'idle' | 'shutdown'>();
    for (const [name, status] of teammates) {
      previousStatus.set(name, status);
    }

    // Send idle nudge to all working teammates (regular message type)
    for (const [name, status] of teammates) {
      if (status === 'working') {
        this.sendTo(name, 'Please finish your current work and enter idle state.', 'message');
      }
    }

    const startTime = Date.now();
    const statusChanges: string[] = [];

    while (Date.now() - startTime < timeoutMs) {
      // Check if all teammates are idle or shutdown
      const allSettled = Array.from(this.status.values()).every(
        (s) => s === 'idle' || s === 'shutdown'
      );

      // Track status changes for terminal output
      for (const [name, currentStatus] of this.status) {
        const prev = previousStatus.get(name);
        if (prev !== currentStatus) {
          const change = `${name}: ${prev || 'unknown'} → ${currentStatus}`;
          statusChanges.push(change);
          console.log(chalk.gray(`[${change}]`));
          previousStatus.set(name, currentStatus);
        }
      }

      if (allSettled) {
        // Inject summary into messages for LLM context
        if (statusChanges.length > 0) {
          messages.push({
            role: 'user',
            content: `Teammate status updates:\n${statusChanges.map((c) => `  - ${c}`).join('\n')}\n\nAll teammates have settled.`,
          });
        }
        return { allSettled: true, statusChanges };
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout - return with pending teammates info
    return { allSettled: false, statusChanges };
  }

  /**
   * Force kill all teammate processes (for cleanup)
   */
  killAll(): void {
    for (const [name, proc] of this.processes) {
      if (proc.connected) {
        proc.kill('SIGTERM');
      }
    }
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

// -- History store for dump functionality (lead only) --
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

// -- Base tool implementations (for lead) --
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
  TEAM.sendTo(teammate, 'Please shut down gracefully.', 'shutdown_request');
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback: string = ''): string {
  const req = planRequests.get(requestId);
  if (!req) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }
  req.status = approve ? 'approved' : 'rejected';
  TEAM.sendTo(req.from, feedback, 'plan_approval_response');
  return `Plan ${req.status} for '${req.from}'`;
}

function checkShutdownStatus(requestId: string): string {
  const req = shutdownRequests.get(requestId);
  if (!req) {
    return JSON.stringify({ error: 'not found' });
  }
  return JSON.stringify({ request_id: requestId, target: req.target, status: req.status });
}

// -- Lead tool dispatch (16 tools) --
type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (args) => runBash(args.command as string),
  read_file: (args) => runRead(args.path as string, args.limit as number | undefined),
  write_file: (args) => runWrite(args.path as string, args.content as string),
  edit_file: (args) => runEdit(args.path as string, args.old_text as string, args.new_text as string),
  spawn_teammate: async (args) => TEAM.spawn(args.name as string, args.role as string, args.prompt as string),
  list_teammates: () => TEAM.listAll(),
  list_tasks: () => listTasksStr(),
  create_task: (args) => createTask(args.subject as string, (args.description as string) || ''),
  send_message: (args) => {
    TEAM.sendTo(args.to as string, args.content as string, (args.msg_type as string) || 'message');
    return `Sent ${(args.msg_type as string) || 'message'} to ${args.to}`;
  },
  read_inbox: () => 'Lead inbox is handled via REPL commands (/inbox)',
  broadcast: (args) => {
    TEAM.broadcast(args.content as string);
    return `Broadcast to ${TEAM.memberNames().length} teammates`;
  },
  shutdown_request: (args) => handleShutdownRequest(args.teammate as string),
  shutdown_response: (args) => checkShutdownStatus(args.request_id as string),
  plan_approval: (args) =>
    handlePlanReview(args.request_id as string, args.approve as boolean, (args.feedback as string) || ''),
  idle: () => 'Lead does not idle.',
  claim_task: (args) => claimTask(args.task_id as number, 'lead'),
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
      description: 'Spawn an autonomous teammate as a child process.',
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
      description: 'List all teammates with their current status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List all tasks on the task board.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task on the task board.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Task subject/title' },
          description: { type: 'string', description: 'Task description (optional)' },
        },
        required: ['subject'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a message to a teammate via IPC.',
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
      description: "Read the lead's inbox (handled via /inbox command).",
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
  {
    type: 'function',
    function: {
      name: 'idle',
      description: 'Enter idle state (for lead -- rarely used).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claim_task',
      description: 'Claim a task from the board by ID.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'integer', description: 'Task ID to claim' },
        },
        required: ['task_id'],
      },
    },
  },
];

/**
 * Agent loop - processes messages from teammates via IPC
 */
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
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

    // If no tool calls, check if teammates have settled
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const result = await TEAM.bounce(messages, 30000, 1000);
      if (result.allSettled) {
        return; // All teammates settled, exit loop
      }
      // Timeout - inject timeout message
      const stillWorking = TEAM.getWorkingTeammates();
      messages.push({
        role: 'user',
        content: `Timeout waiting for teammates. Still working: ${stillWorking.join(', ')}. What would you like to do?`,
      });
      // Continue loop to let agent respond to timeout
      continue;
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
      } else if (toolName === 'list_tasks') {
        console.log(chalk.cyan('[tasks]'));
        console.log(output);
      } else if (toolName === 'create_task') {
        console.log(chalk.cyan('[create]') + ` task: ${(args.subject as string)}`);
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
      } else if (toolName === 'claim_task') {
        console.log(chalk.cyan('[claim]') + ` task #${args.task_id}`);
        console.log(output);
      } else if (toolName === 'read_file') {
        console.log(chalk.green('[read]') + ` ${(args.path as string)}`);
        console.log(output.slice(0, 300));
      } else if (toolName === 'write_file') {
        console.log(chalk.green('[write]') + ` ${(args.path as string)}`);
        console.log(output);
      } else if (toolName === 'edit_file') {
        console.log(chalk.green('[edit]') + ` ${(args.path as string)}`);
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

// -- List tasks command --
function listTasks(): void {
  if (!fs.existsSync(TASKS_DIR)) {
    console.log('No tasks directory.');
    return;
  }
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith('task_') && f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log('No tasks.');
    return;
  }
  for (const file of files) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf-8')) as Task;
      const marker: Record<string, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };
      const status = marker[task.status] || '[?]';
      const owner = task.owner ? ` @${task.owner}` : '';
      console.log(`  ${status} #${task.id}: ${task.subject}${owner}`);
    } catch {
      // Skip malformed files
    }
  }
}

// REPL
async function main() {
  console.log(chalk.cyan(`s11 (Ollama: ${MODEL})`));
  console.log('Autonomous agents enabled (child process mode). Teammates find work themselves.');
  console.log('Commands: /team, /tasks, /dump <name>\n');
  const history: Message[] = [];

  // Register lead's history for dump functionality
  histories.set('lead', history);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\nShutting down...'));
    TEAM.killAll();
    rl.close();
    process.exit(0);
  });

  while (true) {
    try {
      const query = await prompt(chalk.cyan('s11 >> '));
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) {
        break;
      }
      if (query.trim() === '/team') {
        console.log(TEAM.listAll());
        continue;
      }
      if (query.trim() === '/tasks') {
        listTasks();
        continue;
      }
      if (query.trim().startsWith('/dump ')) {
        const name = query.trim().slice(6).trim();
        console.log(dumpHistory(name));
        continue;
      }
      history.push({ role: 'user', content: query });
      await agentLoop(history);

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

  // Cleanup
  TEAM.killAll();
  rl.close();
}

main().catch(console.error);