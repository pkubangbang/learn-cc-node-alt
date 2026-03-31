/**
 * context.ts - Agent context and TeammateManager implementation
 *
 * Creates the AgentContext with all manager instances and provides
 * the TeammateManager class for child process management.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fork, ChildProcess, execSync } from 'child_process';
import type { Message } from 'ollama';
import chalk from 'chalk';
import {
  type AgentContext,
  TodoManager,
  SkillLoader,
  TaskManager,
  BackgroundManager,
  EventBus,
  WorktreeManager,
  DumbWorktreeManager,
  type TeamMember,
  type TeamConfig,
  type IWorktreeManager,
} from './types.js';

// Constants
const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, '.team');
const TASKS_DIR = path.join(WORKDIR, '.tasks');
const SKILLS_DIR = path.join(WORKDIR, 'skills');
const WORKTREES_DIR = path.join(WORKDIR, '.worktrees');
const TRANSCRIPTS_DIR = path.join(WORKDIR, '.transcripts');

// IPC Message types (Lead <-> Child)
export type ParentMessage =
  | { type: 'spawn'; name: string; role: string; prompt: string; teamName: string }
  | { type: 'message'; from: string; content: string; msgType: string }
  | { type: 'shutdown' };

export type ChildMessage =
  | { type: 'status'; status: 'working' | 'idle' | 'shutdown' }
  | { type: 'message'; to: string; content: string; msgType: string }
  | { type: 'log'; message: string }
  | { type: 'error'; error: string };

// Request trackers for shutdown/plan protocols
interface ShutdownRequest {
  target: string;
  status: 'pending' | 'approved' | 'rejected';
}

interface PlanRequest {
  from: string;
  plan: string;
  status: 'pending' | 'approved' | 'rejected';
}

/**
 * TeammateManager - Child process management with IPC message brokering
 *
 * Uses the Electron-style IPC pattern where the lead process acts as
 * message broker between teammate processes.
 */
export class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private processes: Map<string, ChildProcess> = new Map();
  public status: Map<string, 'working' | 'idle' | 'shutdown'> = new Map();
  public shutdownRequests: Map<string, ShutdownRequest> = new Map();
  public planRequests: Map<string, PlanRequest> = new Map();

  constructor(teamDir: string) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, 'config.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf-8')) as TeamConfig;
      } catch {
        console.error(`Warning: Failed to parse ${this.configPath}, using default config`);
        return { team_name: 'default', members: [] };
      }
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

    // Spawn child process
    const workerPath = path.join(__dirname, 'teammate-worker.js');
    const child = fork(workerPath, [], { cwd: WORKDIR, silent: true });

    // Track process and status
    this.processes.set(name, child);
    this.status.set(name, 'working');

    // Capture stdout/stderr
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

    // Track process exit
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
   * LEAD AS BROKER: Route messages between teammates
   */
  private handleChildMessage(sender: string, msg: ChildMessage): void {
    switch (msg.type) {
      case 'status':
        this.status.set(sender, msg.status);
        this.updateConfigStatus(sender, msg.status);
        console.log(chalk.gray(`[${sender}] status: ${msg.status}`));
        break;

      case 'message':
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
   * Get real-time status from in-memory map
   */
  getStatus(name: string): 'working' | 'idle' | 'shutdown' | undefined {
    return this.status.get(name);
  }

  /**
   * Get list of teammates currently in 'working' status
   */
  getWorkingTeammates(): string[] {
    return Array.from(this.status.entries())
      .filter(([_, s]) => s === 'working')
      .map(([name]) => name);
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

/**
 * Brief output helper for console logging
 */
export function brief(color: string, title: string, body: string): void {
  const colors: Record<string, (text: string) => string> = {
    yellow: chalk.yellow,
    green: chalk.green,
    cyan: chalk.cyan,
    magenta: chalk.magenta,
    blue: chalk.blue,
    red: chalk.red,
    gray: chalk.gray,
  };
  const colorFn = colors[color] || ((text: string) => text);
  const truncated = body.slice(0, 200);
  console.log(`${colorFn(`[${title}]`)} ${truncated}`);
}

/**
 * Create the full agent context with all managers
 */
export function createContext(): AgentContext {
  // Detect git repo root
  let repoRoot = WORKDIR;
  let isGitRepo = false;
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd: WORKDIR,
      encoding: 'utf-8',
      timeout: 10000,
    });
    const root = result.trim();
    if (fs.existsSync(root)) {
      repoRoot = root;
      isGitRepo = true;
    }
  } catch {
    // Not a git repo, use WORKDIR
  }

  if (!isGitRepo) {
    console.log(chalk.yellow('WARNING: Not in a git repo. Worktree functionalities will not work.'));
  }

  // Initialize managers
  const todoManager = new TodoManager();
  const skillLoader = new SkillLoader(SKILLS_DIR);
  const taskManager = new TaskManager(TASKS_DIR);
  const backgroundManager = new BackgroundManager();
  const eventBus = new EventBus(path.join(WORKTREES_DIR, 'events.jsonl'));
  const worktreeManager = isGitRepo
    ? new WorktreeManager(repoRoot, taskManager, eventBus)
    : new DumbWorktreeManager();
  const teammateManager = new TeammateManager(TEAM_DIR);

  // Ensure directories exist
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  return {
    workdir: WORKDIR,
    todoManager,
    skillLoader,
    taskManager,
    backgroundManager,
    teammateManager,
    worktreeManager,
    eventBus,
    brief,
  };
}