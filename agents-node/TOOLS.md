# Agent Tools Reference

This document summarizes all tools available to agents in the harness engineering project.

## Tool Architecture

Tools are organized by **scope**, which determines visibility to different agent types:

| Scope | Available To | Description |
|-------|--------------|-------------|
| `main` | Lead agent only | Primary orchestration tools |
| `child` | Child agents (teammates, subagents) | Limited toolset for isolated work |
| `bg` | Background tasks | Minimal toolset for background execution |

---

## Core Tools (s01-s02)

### bash
**Scope:** `main`, `child`, `bg`

Run a shell command (blocking).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| command | string | yes | The shell command to execute |

- Timeout: 120 seconds
- Output limit: 50,000 characters
- Dangerous commands blocked: `rm -rf /`, `sudo`, `shutdown`, `reboot`

---

### read_file
**Scope:** `main`, `child`, `bg`

Read file contents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | yes | File path (relative to workdir) |
| limit | integer | no | Max lines to read |

- Path validation: Must stay within workspace
- Output limit: 50,000 characters

---

### write_file
**Scope:** `main`, `child`, `bg`

Write content to file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | yes | File path |
| content | string | yes | Content to write |

- Creates parent directories if needed
- Path validation: Must stay within workspace

---

### edit_file
**Scope:** `main`, `child`, `bg`

Replace exact text in file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | yes | File path |
| old_text | string | yes | Text to replace (exact match) |
| new_text | string | yes | Replacement text |

- Only replaces first occurrence
- Path validation: Must stay within workspace

---

## Task Tracking Tools (s03)

### TodoWrite
**Scope:** `main`

Update in-memory task tracking list for the current session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| items | array | yes | Array of todo items |

**Todo item structure:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| content | string | yes | Task description |
| status | string | yes | One of: `pending`, `in_progress`, `completed` |
| activeForm | string | yes | Present continuous form (e.g., "Writing tests") |

- Maximum 20 items
- Only one item can be `in_progress` at a time
- Triggers nag reminder if open items exist and no TodoWrite for 3 rounds

---

## Subagent Tool (s04)

### task
**Scope:** `main`

Spawn a subagent for isolated exploration or work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| prompt | string | yes | The task prompt for the subagent |
| agent_type | string | no | One of: `Explore` (default), `general-purpose` |

**Agent types:**
- `Explore`: Read-only tools (bash, read_file) for research
- `general-purpose`: Read + write tools for implementation work

- Max 30 tool call rounds
- Summary returned to parent context

---

## Skill Loading (s05)

### load_skill
**Scope:** `main`

Load specialized knowledge from `skills/SKILL.md` files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | yes | Skill name (matches directory or `name` in frontmatter) |

- Returns skill content wrapped in `<skill>` tags
- Skills defined in `skills/` directory as `SKILL.md` files

---

## Context Management (s06)

### compress
**Scope:** `main`

Manually trigger conversation context compression.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|

- Saves transcript to `.transcripts/transcript_<timestamp>.jsonl`
- Replaces history with LLM-generated summary
- Auto-triggers when token estimate > 100,000 (Python) / 50,000 (Node)

---

## Background Tasks (s08)

### background_run
**Scope:** `main`

Run a command in a background thread. Returns immediately.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| command | string | yes | Shell command to run in background |
| timeout | integer | no | Timeout in seconds (default: 120) |

- Returns task_id immediately
- Notifications drained before next LLM call
- Output stored and retrieved via `check_background`

---

### check_background
**Scope:** `main`

Check status of background tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | string | no | Specific task ID (omit to list all) |

**Returns:**
- Without task_id: List of all background tasks with status
- With task_id: Status and result of specific task

---

## File-Based Task System (s07)

### task_create
**Scope:** `main`, `child`

Create a persistent task on the shared task board (`.tasks/task_<id>.json`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| subject | string | yes | Task subject/title |
| description | string | no | Detailed description |

- Tasks stored in `.tasks/` directory
- Auto-incrementing ID

---

### task_get
**Scope:** `main`, `child`

Get task details by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | integer | yes | Task ID |

---

### task_update
**Scope:** `main`, `child`

Update task status or dependencies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | integer | yes | Task ID |
| status | string | no | One of: `pending`, `in_progress`, `completed`, `deleted` |
| add_blocked_by | array[integer] | no | Task IDs that block this task |
| add_blocks | array[integer] | no | Task IDs this task blocks |

- Setting `completed` removes this task from other tasks' `blockedBy` lists
- Setting `deleted` removes the task file

---

### task_list
**Scope:** `main`, `child`

List all tasks on the board.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|

**Returns:** Formatted list showing:
- Status: `[ ]` pending, `[>]` in_progress, `[x]` completed
- Owner (if claimed)
- Blocked-by dependencies

---

### claim_task
**Scope:** `main`, `child`

Claim a task from the board.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task_id | integer | yes | Task ID to claim |

- Sets owner and status to `in_progress`

---

## Team Communication (s09)

### spawn_teammate
**Scope:** `main`

Spawn an autonomous teammate as a child process.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | yes | Unique teammate name |
| role | string | yes | Role description (e.g., "coder", "tester") |
| prompt | string | yes | Initial task prompt |

- Teammate runs in separate process with child-scoped tools
- Communicates via JSONL inbox files in `.team/inbox/`

---

### list_teammates
**Scope:** `main`

List all teammates and their status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|

**Returns:** Team name and member list with status:
- `working`: Actively processing
- `idle`: Waiting for new tasks
- `shutdown`: Terminated

---

### send_message
**Scope:** `main`, `child`

Send a message to a teammate.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| to | string | yes | Recipient name |
| content | string | yes | Message content |
| msg_type | string | no | Message type (default: `message`) |

**Valid message types:**
- `message`: Regular message
- `broadcast`: Broadcast message
- `shutdown_request`: Request shutdown
- `shutdown_response`: Shutdown acknowledgment
- `plan_approval_response`: Plan approval response

---

### read_inbox
**Scope:** `main`, `child`

Read and drain the agent's inbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|

- Returns all pending messages
- Clears inbox after reading

---

### broadcast
**Scope:** `main`

Send a message to all teammates at once.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| content | string | yes | Message content |

---

## Shutdown Protocol (s10)

### shutdown_request
**Scope:** `main`

Request a teammate to shut down gracefully.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| teammate | string | yes | Name of teammate to shut down |

- Sends `shutdown_request` message with unique request_id
- Waits for graceful shutdown

---

### plan_approval
**Scope:** `main`

Approve or reject a teammate's plan.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| request_id | string | yes | Plan request ID |
| approve | boolean | yes | Approve or reject |
| feedback | string | no | Optional feedback |

- Sends `plan_approval_response` to requesting teammate

---

## Autonomous Agent (s11)

### idle
**Scope:** `child`

Signal that the child agent has no more work. Enters idle polling phase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|

- Child enters idle phase (default 60 seconds)
- Polls for:
  1. New messages in inbox
  2. Unclaimed tasks on board
- Auto-exits if timeout expires without new work

---

## Worktree Isolation (s12)

### worktree_create
**Scope:** `main`

Create a git worktree for isolated execution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | yes | Worktree name |
| task_id | integer | no | Task ID to bind |
| base_ref | string | no | Base ref (default: `HEAD`) |

- Creates worktree in `.worktrees/<name>/`
- Optionally binds to a task for auto-cleanup

---

### worktree_list
**Scope:** `main`

List all worktrees.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|

---

### worktree_status
**Scope:** `main`

Check status of a worktree.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | yes | Worktree name |

---

### worktree_run
**Scope:** `main`

Run an agent in a worktree.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | yes | Worktree name |
| prompt | string | yes | Task prompt for the agent |

---

### worktree_remove
**Scope:** `main`

Remove a worktree.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | yes | Worktree name |
| discard_changes | boolean | no | Force removal with uncommitted changes |

---

### worktree_keep
**Scope:** `main`

Keep a worktree (remove binding but preserve directory).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | yes | Worktree name |

---

### worktree_events
**Scope:** `main`

Get events from a worktree's agent execution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | yes | Worktree name |

---

## Summary by Session

| Session | Tools Added |
|---------|-------------|
| s01 | `bash` |
| s02 | `read_file`, `write_file`, `edit_file` + dispatch pattern |
| s03 | `TodoWrite` |
| s04 | `task` (subagent) |
| s05 | `load_skill` |
| s06 | `compress` + auto-compact |
| s07 | `task_create`, `task_get`, `task_update`, `task_list`, `claim_task` |
| s08 | `background_run`, `check_background` |
| s09 | `spawn_teammate`, `list_teammates`, `send_message`, `read_inbox`, `broadcast` |
| s10 | `shutdown_request`, `plan_approval` |
| s11 | `idle` + auto-claim loop |
| s12 | `worktree_*` family |

---

## REPL Commands

| Command | Description |
|---------|-------------|
| `/compact` | Manually compress conversation history |
| `/tasks` | List all file-based tasks |
| `/team` | List teammates and status |
| `/inbox` | Show lead's inbox (Python) / handled via IPC (Node) |
| `/tools` | List all loaded tools with scope (Node only) |
| `q`, `exit`, or empty | Quit the REPL |