/**
 * types.ts - Core type definitions for s_full
 *
 * Defines the modular tool architecture with scope-based visibility control.
 */

import type { Message } from 'ollama';
import * as fs from 'fs';
import * as path from 'path';
import * as pathModule from 'path';
import { execSync } from 'child_process';

/**
 * Tool visibility scope
 * - 'main': Available to the lead agent
 * - 'child': Available to spawned teammate processes
 * - 'bg': Available to background task workers
 */
export type ToolScope = 'main' | 'child' | 'bg';

/**
 * Tool definition with handler function
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  scope: ToolScope[];
  handler: (ctx: AgentContext, args: Record<string, unknown>) => string | Promise<string>;
}

/**
 * Agent context passed to all tool handlers
 */
export interface AgentContext {
  // Core
  workdir: string;

  // s03: TodoWrite
  todoManager: TodoManager;

  // s05: Skills
  skillLoader: SkillLoader;

  // s07: Tasks
  taskManager: TaskManager;

  // s08: Background
  backgroundManager: BackgroundManager;

  // s09/s11: Teams (IPC messaging)
  teammateManager: ITeammateManager;

  // s12: Worktrees
  worktreeManager: IWorktreeManager;
  eventBus: EventBus;

  // Brief output helper
  brief: (color: string, title: string, body: string) => void;
}

// === Manager Interfaces ===

/**
 * s03: Todo management
 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export class TodoManager {
  private items: TodoItem[] = [];

  update(items: TodoItem[]): string {
    if (items.length > 20) {
      throw new Error('Max 20 todos allowed');
    }

    let inProgressCount = 0;
    const validated: TodoItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = String(item?.content ?? '').trim();
      const status = String(item?.status ?? 'pending').toLowerCase() as TodoItem['status'];
      const activeForm = String(item?.activeForm ?? '').trim();

      if (!content) {
        throw new Error(`Item ${i}: content required`);
      }
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new Error(`Item ${i}: invalid status '${status}'`);
      }
      if (!activeForm) {
        throw new Error(`Item ${i}: activeForm required`);
      }
      if (status === 'in_progress') {
        inProgressCount++;
      }

      validated.push({ content, status, activeForm });
    }

    if (inProgressCount > 1) {
      throw new Error('Only one task can be in_progress at a time');
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) {
      return 'No todos.';
    }

    const markerMap: Record<string, string> = {
      pending: '[ ]',
      in_progress: '[>]',
      completed: '[x]',
    };

    const lines = this.items.map((item) => {
      const marker = markerMap[item.status];
      const suffix = item.status === 'in_progress' ? ` <- ${item.activeForm}` : '';
      return `${marker} ${item.content}${suffix}`;
    });

    const done = this.items.filter((t) => t.status === 'completed').length;
    lines.push(`\n(${done}/${this.items.length} completed)`);

    return lines.join('\n');
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== 'completed');
  }
}

/**
 * s05: Skill loading
 */
export interface SkillMeta {
  name?: string;
  description?: string;
  tags?: string;
}

export interface Skill {
  meta: SkillMeta;
  body: string;
  path: string;
}

export class SkillLoader {
  private skillsDir: string;
  private skills: Map<string, Skill> = new Map();

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this.loadAll();
  }

  private loadAll(): void {
    if (!fs.existsSync(this.skillsDir)) {
      return;
    }

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillFile = path.join(this.skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      try {
        const text = fs.readFileSync(skillFile, 'utf-8');
        const { meta, body } = this.parseFrontmatter(text);
        const name = meta.name || entry.name;

        this.skills.set(name, {
          meta,
          body,
          path: skillFile,
        });
      } catch {
        // Skip malformed skill files
      }
    }
  }

  private parseFrontmatter(text: string): { meta: SkillMeta; body: string } {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
      return { meta: {}, body: text.trim() };
    }

    const meta: SkillMeta = {};
    for (const line of match[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim() as keyof SkillMeta;
        const value = line.slice(colonIdx + 1).trim();
        if (key === 'name' || key === 'description' || key === 'tags') {
          meta[key] = value;
        }
      }
    }

    return { meta, body: match[2].trim() };
  }

  getDescriptions(): string {
    if (this.skills.size === 0) {
      return '(no skills available)';
    }

    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const desc = skill.meta.description || 'No description';
      lines.push(`  - ${name}: ${desc}`);
    }
    return lines.join('\n');
  }

  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      const available = Array.from(this.skills.keys()).join(', ');
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

/**
 * s07: Task management
 */
export interface Task {
  id: number;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  worktree?: string;
  blockedBy?: number[];
  blocks?: number[];
  created_at?: number;
  updated_at?: number;
}

export class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const files = fs.readdirSync(this.dir).filter((f: string) => f.startsWith('task_') && f.endsWith('.json'));
    const ids = files.map((f: string) => parseInt(f.split('_')[1].split('.')[0], 10)).filter((n: number) => !isNaN(n));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  private path(taskId: number): string {
    return path.join(this.dir, `task_${taskId}.json`);
  }

  private load(taskId: number): Task {
    const p = this.path(taskId);
    if (!fs.existsSync(p)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Task;
  }

  private save(task: Task): void {
    fs.writeFileSync(this.path(task.id), JSON.stringify(task, null, 2), 'utf-8');
  }

  create(subject: string, description: string = ''): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: 'pending',
      owner: '',
      worktree: '',
      blockedBy: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  exists(taskId: number): boolean {
    return fs.existsSync(this.path(taskId));
  }

  update(
    taskId: number,
    status?: string,
    owner?: string,
    addBlockedBy?: number[],
    addBlocks?: number[]
  ): string {
    const task = this.load(taskId);
    if (status) {
      if (!['pending', 'in_progress', 'completed', 'deleted'].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as Task['status'];

      // If completed, remove from blockedBy of other tasks
      if (status === 'completed') {
        const files = fs.readdirSync(this.dir).filter((f: string) => f.startsWith('task_') && f.endsWith('.json'));
        for (const file of files) {
          const t = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as Task;
          if (t.blockedBy?.includes(taskId)) {
            t.blockedBy = t.blockedBy.filter((id) => id !== taskId);
            fs.writeFileSync(path.join(this.dir, `task_${t.id}.json`), JSON.stringify(t, null, 2), 'utf-8');
          }
        }
      }

      if (status === 'deleted') {
        fs.unlinkSync(this.path(taskId));
        return `Task ${taskId} deleted`;
      }
    }
    if (owner !== undefined) {
      task.owner = owner;
    }
    if (addBlockedBy) {
      task.blockedBy = [...new Set([...(task.blockedBy || []), ...addBlockedBy])];
    }
    if (addBlocks) {
      task.blocks = [...new Set([...(task.blocks || []), ...addBlocks])];
    }
    task.updated_at = Date.now();
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const files = fs.readdirSync(this.dir).filter((f: string) => f.startsWith('task_') && f.endsWith('.json')).sort();
    if (files.length === 0) {
      return 'No tasks.';
    }
    const lines: string[] = [];
    for (const file of files) {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as Task;
        const marker: Record<string, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };
        const status = marker[task.status] || '[?]';
        const owner = task.owner ? ` @${task.owner}` : '';
        const blocked = task.blockedBy?.length ? ` (blocked by: ${task.blockedBy.join(', ')})` : '';
        lines.push(`${status} #${task.id}: ${task.subject}${owner}${blocked}`);
      } catch {
        // Skip malformed files
      }
    }
    return lines.join('\n');
  }

  /**
   * List all tasks as Task objects (for programmatic access)
   */
  list(): Task[] {
    const files = fs.readdirSync(this.dir).filter((f: string) => f.startsWith('task_') && f.endsWith('.json')).sort();
    const tasks: Task[] = [];
    for (const file of files) {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as Task;
        tasks.push(task);
      } catch {
        // Skip malformed files
      }
    }
    return tasks;
  }

  claim(taskId: number, owner: string): string {
    const task = this.load(taskId);
    task.owner = owner;
    task.status = 'in_progress';
    task.updated_at = Date.now();
    this.save(task);
    return `Claimed task #${taskId} for ${owner}`;
  }

  bindWorktree(taskId: number, worktree: string, owner: string = ''): string {
    const task = this.load(taskId);
    task.worktree = worktree;
    if (owner) {
      task.owner = owner;
    }
    if (task.status === 'pending') {
      task.status = 'in_progress';
    }
    task.updated_at = Date.now();
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId: number): string {
    const task = this.load(taskId);
    task.worktree = '';
    task.updated_at = Date.now();
    this.save(task);
    return JSON.stringify(task, null, 2);
  }
}

/**
 * s08: Background task management
 */
export interface BackgroundTask {
  id: string;
  status: 'running' | 'completed' | 'timeout' | 'error';
  command: string;
  result?: string;
}

export interface BackgroundNotification {
  taskId: string;
  status: string;
  command: string;
  result: string;
}

export class BackgroundManager {
  private tasks: Map<string, BackgroundTask> = new Map();
  private notifications: BackgroundNotification[] = [];

  async run(command: string): Promise<string> {
    const taskId = this.generateId();
    this.tasks.set(taskId, {
      id: taskId,
      status: 'running',
      command,
    });

    // Fire and forget
    this.executeCommand(taskId, command).catch(() => {});

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  private async executeCommand(taskId: string, command: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const { execa } = await import('execa');

    try {
      const result = await execa(command, {
        shell: true,
        cwd: process.cwd(),
        timeout: 300000, // 5 minutes
        reject: false,
        all: true,
      });

      const output = (result.all || result.stdout || result.stderr || '(no output)').slice(0, 50000);
      task.status = result.failed ? 'error' : 'completed';
      task.result = output;

      this.enqueueNotification({
        taskId,
        status: task.status,
        command: command.slice(0, 80),
        result: output.slice(0, 500),
      });
    } catch (error) {
      const err = error as Error & { timedOut?: boolean };
      if (err.timedOut) {
        task.status = 'timeout';
        task.result = 'Error: Timeout (300s)';
      } else {
        task.status = 'error';
        task.result = `Error: ${err.message}`;
      }

      this.enqueueNotification({
        taskId,
        status: task.status,
        command: command.slice(0, 80),
        result: task.result!.slice(0, 500),
      });
    }
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  private enqueueNotification(notif: BackgroundNotification): void {
    this.notifications.push(notif);
  }

  check(taskId?: string): string {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) {
        return `Error: Unknown task ${taskId}`;
      }
      const result = task.result || '(running)';
      return `[${task.status}] ${task.command.slice(0, 60)}\n${result}`;
    }

    if (this.tasks.size === 0) {
      return 'No background tasks.';
    }

    const lines: string[] = [];
    this.tasks.forEach((t, id) => {
      lines.push(`${id}: [${t.status}] ${t.command.slice(0, 60)}`);
    });
    return lines.join('\n');
  }

  drainNotifications(): BackgroundNotification[] {
    const notifs = [...this.notifications];
    this.notifications = [];
    return notifs;
  }

  hasRunningTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        return true;
      }
    }
    return false;
  }

  hasPendingNotifications(): boolean {
    return this.notifications.length > 0;
  }
}

/**
 * s12: EventBus for lifecycle events
 */
export class EventBus {
  private path: string;

  constructor(eventLogPath: string) {
    this.path = eventLogPath;
    fs.mkdirSync(pathModule.dirname(this.path), { recursive: true });
    if (!fs.existsSync(this.path)) {
      fs.writeFileSync(this.path, '', 'utf-8');
    }
  }

  emit(
    event: string,
    task?: Record<string, unknown>,
    worktree?: Record<string, unknown>,
    error?: string
  ): void {
    const payload: Record<string, unknown> = {
      event,
      ts: Date.now(),
      task: task || {},
      worktree: worktree || {},
    };
    if (error) {
      payload.error = error;
    }
    fs.appendFileSync(this.path, JSON.stringify(payload) + '\n', 'utf-8');
  }

  listRecent(limit: number = 20): string {
    const n = Math.max(1, Math.min(limit, 200));
    const content = fs.readFileSync(this.path, 'utf-8');
    const lines = content.split('\n').filter((l: string) => l.trim());
    const recent = lines.slice(-n);
    const items = recent.map((line: string) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: 'parse_error', raw: line };
      }
    });
    return JSON.stringify(items, null, 2);
  }
}

/**
 * s12: Worktree management
 */
export interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  task_id?: number;
  status: string;
  created_at?: number;
  removed_at?: number;
  kept_at?: number;
}

export interface WorktreeIndex {
  worktrees: WorktreeEntry[];
}

/**
 * Interface for WorktreeManager operations
 */
export interface IWorktreeManager {
  create(name: string, taskId?: number, baseRef?: string): string;
  listAll(): string;
  status(name: string): string;
  run(name: string, command: string): string;
  remove(name: string, force?: boolean, completeTask?: boolean): string;
  keep(name: string): string;
}

export class WorktreeManager implements IWorktreeManager {
  private repoRoot: string;
  private tasks: TaskManager;
  private events: EventBus;
  private dir: string;
  private indexPath: string;
  private gitAvailable: boolean;

  constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = path.join(repoRoot, '.worktrees');
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexPath = path.join(this.dir, 'index.json');
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2), 'utf-8');
    }
    this.gitAvailable = this.isGitRepo();
  }

  private isGitRepo(): boolean {
    try {
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: this.repoRoot,
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  private runGit(args: string[]): string {
    if (!this.gitAvailable) {
      throw new Error('Not in a git repository. worktree tools require git.');
    }
    try {
      const result = execSync(`git ${args.join(' ')}`, {
        cwd: this.repoRoot,
        encoding: 'utf-8',
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return (result || '').trim() || '(no output)';
    } catch (error: unknown) {
      const err = error as { stderr?: string; stdout?: string; message?: string };
      const msg = (err.stderr || err.stdout || err.message || '').trim();
      throw new Error(msg || `git ${args[0]} failed`);
    }
  }

  private loadIndex(): WorktreeIndex {
    return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as WorktreeIndex;
  }

  private saveIndex(data: WorktreeIndex): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private find(name: string): WorktreeEntry | undefined {
    return this.loadIndex().worktrees.find((wt) => wt.name === name);
  }

  private validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || '')) {
      throw new Error('Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -');
    }
  }

  create(name: string, taskId?: number, baseRef: string = 'HEAD'): string {
    this.validateName(name);
    if (this.find(name)) {
      throw new Error(`Worktree '${name}' already exists in index`);
    }
    if (taskId !== undefined && !this.tasks.exists(taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }

    const wtPath = path.join(this.dir, name);
    const branch = `wt/${name}`;

    this.events.emit('worktree.create.before', taskId ? { id: taskId } : undefined, { name, base_ref: baseRef });

    try {
      this.runGit(['worktree', 'add', '-b', branch, wtPath, baseRef]);

      const entry: WorktreeEntry = {
        name,
        path: wtPath,
        branch,
        task_id: taskId,
        status: 'active',
        created_at: Date.now(),
      };

      const idx = this.loadIndex();
      idx.worktrees.push(entry);
      this.saveIndex(idx);

      if (taskId !== undefined) {
        this.tasks.bindWorktree(taskId, name);
      }

      this.events.emit('worktree.create.after', taskId ? { id: taskId } : undefined, {
        name,
        path: wtPath,
        branch,
        status: 'active',
      });

      return JSON.stringify(entry, null, 2);
    } catch (error: unknown) {
      this.events.emit(
        'worktree.create.failed',
        taskId ? { id: taskId } : undefined,
        { name, base_ref: baseRef },
        (error as Error).message
      );
      throw error;
    }
  }

  listAll(): string {
    const idx = this.loadIndex();
    const wts = idx.worktrees;
    if (wts.length === 0) {
      return 'No worktrees in index.';
    }
    const lines: string[] = [];
    for (const wt of wts) {
      const suffix = wt.task_id ? ` task=${wt.task_id}` : '';
      lines.push(`[${wt.status || 'unknown'}] ${wt.name} -> ${wt.path} (${wt.branch})${suffix}`);
    }
    return lines.join('\n');
  }

  status(name: string): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    if (!fs.existsSync(wt.path)) {
      return `Error: Worktree path missing: ${wt.path}`;
    }
    try {
      const result = execSync('git status --short --branch', {
        cwd: wt.path,
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return (result || '').trim() || 'Clean worktree';
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  }

  run(name: string, command: string): string {
    const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
    if (dangerous.some((d) => command.includes(d))) {
      return 'Error: Dangerous command blocked';
    }

    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    if (!fs.existsSync(wt.path)) {
      return `Error: Worktree path missing: ${wt.path}`;
    }

    try {
      const result = execSync(command, {
        cwd: wt.path,
        encoding: 'utf-8',
        timeout: 300000,
        maxBuffer: 50 * 1024 * 1024,
      });
      return (result || '(no output)').slice(0, 50000);
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      return (err.stderr || err.message || 'Unknown error').slice(0, 50000);
    }
  }

  remove(name: string, force: boolean = false, completeTask: boolean = false): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    this.events.emit('worktree.remove.before', wt.task_id ? { id: wt.task_id } : undefined, {
      name,
      path: wt.path,
    });

    try {
      const args = ['worktree', 'remove'];
      if (force) {
        args.push('--force');
      }
      args.push(wt.path);
      this.runGit(args);

      if (completeTask && wt.task_id !== undefined) {
        this.tasks.update(wt.task_id, 'completed');
        this.tasks.unbindWorktree(wt.task_id);
        this.events.emit('task.completed', {
          id: wt.task_id,
          status: 'completed',
        });
      }

      const idx = this.loadIndex();
      for (const item of idx.worktrees) {
        if (item.name === name) {
          item.status = 'removed';
          item.removed_at = Date.now();
        }
      }
      this.saveIndex(idx);

      this.events.emit('worktree.remove.after', wt.task_id ? { id: wt.task_id } : undefined, {
        name,
        path: wt.path,
        status: 'removed',
      });

      return `Removed worktree '${name}'`;
    } catch (error: unknown) {
      this.events.emit(
        'worktree.remove.failed',
        wt.task_id ? { id: wt.task_id } : undefined,
        { name, path: wt.path },
        (error as Error).message
      );
      throw error;
    }
  }

  keep(name: string): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    const idx = this.loadIndex();
    let kept: WorktreeEntry | undefined;
    for (const item of idx.worktrees) {
      if (item.name === name) {
        item.status = 'kept';
        item.kept_at = Date.now();
        kept = item;
      }
    }
    this.saveIndex(idx);

    this.events.emit('worktree.keep', wt.task_id ? { id: wt.task_id } : undefined, {
      name,
      path: wt.path,
      status: 'kept',
    });

    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}

/**
 * Stub WorktreeManager for non-git environments
 * Returns helpful error messages for all operations
 */
export class DumbWorktreeManager implements IWorktreeManager {
  create(_name: string, _taskId?: number, _baseRef?: string): string {
    return 'Error: Not in a git repository. Worktree tools require git.';
  }

  listAll(): string {
    return 'Error: Not in a git repository. Worktree tools require git.';
  }

  status(_name: string): string {
    return 'Error: Not in a git repository. Worktree tools require git.';
  }

  run(_name: string, _command: string): string {
    return 'Error: Not in a git repository. Worktree tools require git.';
  }

  remove(_name: string, _force?: boolean, _completeTask?: boolean): string {
    return 'Error: Not in a git repository. Worktree tools require git.';
  }

  keep(_name: string): string {
    return 'Error: Not in a git repository. Worktree tools require git.';
  }
}

/**
 * s09/s11: Teammate management (interface)
 * Implementation is in context.ts
 */
export interface TeamMember {
  name: string;
  role: string;
  status: 'working' | 'idle' | 'shutdown';
}

export interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

export interface ShutdownRequest {
  target: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface PlanRequest {
  from: string;
  plan: string;
  status: 'pending' | 'approved' | 'rejected';
}

// Interface for TeammateManager - actual implementation in context.ts
export interface ITeammateManager {
  status: Map<string, 'working' | 'idle' | 'shutdown'>;
  shutdownRequests: Map<string, ShutdownRequest>;
  planRequests: Map<string, PlanRequest>;
  spawn(name: string, role: string, prompt: string): Promise<string>;
  sendTo(name: string, content: string, msgType?: string): void;
  broadcast(content: string, msgType?: string): void;
  requestShutdown(name: string): void;
  getStatus(name: string): 'working' | 'idle' | 'shutdown' | undefined;
  getWorkingTeammates(): string[];
  listAll(): string;
  memberNames(): string[];
  bounce(messages: Message[], timeoutMs?: number, pollIntervalMs?: number): Promise<{ allSettled: boolean; statusChanges: string[] }>;
  killAll(): void;
}