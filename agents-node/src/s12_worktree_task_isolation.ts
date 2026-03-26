#!/usr/bin/env node
/**
 * s12_worktree_task_isolation.ts - Worktree + Task Isolation
 *
 * Harness: directory isolation -- parallel execution lanes that never collide.
 * Tasks are the control plane and worktrees are the execution plane.
 *
 *     .tasks/task_12.json
 *       {
 *         "id": 12,
 *         "subject": "Implement auth refactor",
 *         "status": "in_progress",
 *         "worktree": "auth-refactor"
 *       }
 *
 *     .worktrees/index.json
 *       {
 *         "worktrees": [
 *           {
 *             "name": "auth-refactor",
 *             "path": ".../.worktrees/auth-refactor",
 *             "branch": "wt/auth-refactor",
 *             "task_id": 12,
 *             "status": "active"
 *           }
 *         ]
 *       }
 *
 * Key insight: "Isolate by directory, coordinate by task ID."
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { type Message, type Tool } from 'ollama';
import { ollama, MODEL } from './ollama.js';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKDIR = process.cwd();
const TASKS_DIR = path.join(WORKDIR, '.tasks');
const WORKTREES_DIR = path.join(WORKDIR, '.worktrees');

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use task + worktree tools for multi-task work.
For parallel or risky changes: create tasks, allocate worktree lanes,
run commands in those lanes, then choose keep/remove for closeout.
Use worktree_events when you need lifecycle visibility.`;

// -- Detect git repo root --
function detectRepoRoot(cwd: string): string | null {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
    });
    const root = result.trim();
    return fs.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

const REPO_ROOT = detectRepoRoot(WORKDIR) || WORKDIR;

// -- EventBus: append-only lifecycle events --
class EventBus {
  private path: string;

  constructor(eventLogPath: string) {
    this.path = eventLogPath;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (!fs.existsSync(this.path)) {
      fs.writeFileSync(this.path, '', 'utf-8');
    }
  }

  emit(event: string, task?: Record<string, unknown>, worktree?: Record<string, unknown>, error?: string): void {
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
    const lines = content.split('\n').filter((l) => l.trim());
    const recent = lines.slice(-n);
    const items = recent.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: 'parse_error', raw: line };
      }
    });
    return JSON.stringify(items, null, 2);
  }
}

// -- Task interface --
interface Task {
  id: number;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  worktree?: string;
  blockedBy?: number[];
  created_at?: number;
  updated_at?: number;
}

// -- TaskManager: persistent task board with worktree binding --
class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith('task_') && f.endsWith('.json'));
    const ids = files.map((f) => parseInt(f.split('_')[1].split('.')[0], 10)).filter((n) => !isNaN(n));
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

  update(taskId: number, status?: string, owner?: string): string {
    const task = this.load(taskId);
    if (status) {
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as Task['status'];
    }
    if (owner !== undefined) {
      task.owner = owner;
    }
    task.updated_at = Date.now();
    this.save(task);
    return JSON.stringify(task, null, 2);
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

  listAll(): string {
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith('task_') && f.endsWith('.json')).sort();
    if (files.length === 0) {
      return 'No tasks.';
    }
    const lines: string[] = [];
    for (const file of files) {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as Task;
        const marker: Record<string, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };
        const status = marker[task.status] || '[?]';
        const owner = task.owner ? ` owner=${task.owner}` : '';
        const wt = task.worktree ? ` wt=${task.worktree}` : '';
        lines.push(`${status} #${task.id}: ${task.subject}${owner}${wt}`);
      } catch {
        // Skip malformed files
      }
    }
    return lines.join('\n');
  }
}

// -- WorktreeEntry interface --
interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  task_id?: number;
  status: string;
  created_at?: number;
  removed_at?: number;
  kept_at?: number;
}

interface WorktreeIndex {
  worktrees: WorktreeEntry[];
}

// -- WorktreeManager: git worktree lifecycle --
class WorktreeManager {
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
    const idx = this.loadIndex();
    return idx.worktrees.find((wt) => wt.name === name);
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
    const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot'];
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

    this.events.emit(
      'worktree.remove.before',
      wt.task_id ? { id: wt.task_id } : undefined,
      { name, path: wt.path }
    );

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

      this.events.emit(
        'worktree.remove.after',
        wt.task_id ? { id: wt.task_id } : undefined,
        { name, path: wt.path, status: 'removed' }
      );

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

// -- Initialize managers --
const TASKS = new TaskManager(TASKS_DIR);
const EVENTS = new EventBus(path.join(WORKTREES_DIR, 'events.jsonl'));
const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

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

// -- Tool handlers --
type ToolHandler = (args: Record<string, unknown>) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (args) => runBash(args.command as string),
  read_file: (args) => runRead(args.path as string, args.limit as number | undefined),
  write_file: (args) => runWrite(args.path as string, args.content as string),
  edit_file: (args) => runEdit(args.path as string, args.old_text as string, args.new_text as string),
  task_create: (args) => TASKS.create(args.subject as string, (args.description as string) || ''),
  task_list: () => TASKS.listAll(),
  task_get: (args) => TASKS.get(args.task_id as number),
  task_update: (args) => TASKS.update(args.task_id as number, args.status as string | undefined, args.owner as string | undefined),
  task_bind_worktree: (args) => TASKS.bindWorktree(args.task_id as number, args.worktree as string, (args.owner as string) || ''),
  worktree_create: (args) => {
    try {
      return WORKTREES.create(
        args.name as string,
        args.task_id as number | undefined,
        (args.base_ref as string) || 'HEAD'
      );
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
  worktree_list: () => WORKTREES.listAll(),
  worktree_status: (args) => WORKTREES.status(args.name as string),
  worktree_run: (args) => WORKTREES.run(args.name as string, args.command as string),
  worktree_keep: (args) => WORKTREES.keep(args.name as string),
  worktree_remove: (args) => {
    try {
      return WORKTREES.remove(args.name as string, args.force as boolean, args.complete_task as boolean);
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
  worktree_events: (args) => EVENTS.listRecent((args.limit as number) || 20),
};

// -- Tools definition --
const TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the current workspace (blocking).',
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
      name: 'task_create',
      description: 'Create a new task on the shared task board.',
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
      name: 'task_list',
      description: 'List all tasks with status, owner, and worktree binding.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_get',
      description: 'Get task details by ID.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'integer', description: 'Task ID' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_update',
      description: 'Update task status or owner.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'integer', description: 'Task ID' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status' },
          owner: { type: 'string', description: 'Task owner' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_bind_worktree',
      description: 'Bind a task to a worktree name.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'integer', description: 'Task ID' },
          worktree: { type: 'string', description: 'Worktree name' },
          owner: { type: 'string', description: 'Task owner (optional)' },
        },
        required: ['task_id', 'worktree'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worktree_create',
      description: 'Create a git worktree and optionally bind it to a task.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Worktree name' },
          task_id: { type: 'integer', description: 'Task ID to bind (optional)' },
          base_ref: { type: 'string', description: 'Base ref (default: HEAD)' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worktree_list',
      description: 'List worktrees tracked in .worktrees/index.json.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worktree_status',
      description: 'Show git status for one worktree.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Worktree name' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worktree_run',
      description: 'Run a shell command in a named worktree directory.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Worktree name' },
          command: { type: 'string', description: 'Shell command to run' },
        },
        required: ['name', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worktree_remove',
      description: 'Remove a worktree and optionally mark its bound task completed.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Worktree name' },
          force: { type: 'boolean', description: 'Force removal (optional)' },
          complete_task: { type: 'boolean', description: 'Mark bound task as completed (optional)' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worktree_keep',
      description: 'Mark a worktree as kept in lifecycle state without removing it.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Worktree name' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worktree_events',
      description: 'List recent worktree/task lifecycle events from .worktrees/events.jsonl.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Number of events to return (default: 20)' } },
      },
    },
  },
];

// -- Agent loop --
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
        output = handler ? handler(args) : `Unknown tool: ${toolName}`;
      } catch (error: unknown) {
        output = `Error: ${(error as Error).message}`;
      }

      // Friendly console output
      if (toolName.startsWith('task_')) {
        console.log(chalk.cyan(`[${toolName}]`));
        console.log(output.slice(0, 500));
      } else if (toolName.startsWith('worktree_')) {
        console.log(chalk.magenta(`[${toolName}]`));
        console.log(output.slice(0, 500));
      } else if (toolName === 'bash') {
        console.log(chalk.yellow(`$ ${args.command}`));
        console.log(output.slice(0, 300));
      } else if (toolName === 'read_file') {
        console.log(chalk.green(`[read] ${args.path}`));
        console.log(output.slice(0, 300));
      } else if (toolName === 'write_file') {
        console.log(chalk.green(`[write] ${args.path}`));
        console.log(output);
      } else if (toolName === 'edit_file') {
        console.log(chalk.green(`[edit] ${args.path}`));
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

// -- Main --
async function main() {
  console.log(chalk.cyan(`s12 (Ollama: ${MODEL})`));
  console.log(`Repo root: ${REPO_ROOT}`);
  if (!WORKTREES['gitAvailable']) {
    console.log(chalk.yellow('Note: Not in a git repo. worktree_* tools will return errors.'));
  }
  console.log('Commands: /tasks, /worktrees, /events\n');

  const history: Message[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt(chalk.cyan('s12 >> '));
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) {
        break;
      }
      if (query.trim() === '/tasks') {
        console.log(TASKS.listAll());
        continue;
      }
      if (query.trim() === '/worktrees') {
        console.log(WORKTREES.listAll());
        continue;
      }
      if (query.trim() === '/events') {
        console.log(EVENTS.listRecent(20));
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

  rl.close();
}

main().catch(console.error);