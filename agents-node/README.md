# agents-node

Node.js/TypeScript implementations of agent harness mechanisms using Ollama as the LLM provider.

This is the Node.js equivalent of the Python `agents/` directory, following the same progressive session structure (s01-s12 + s_full).

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Ollama

Install Ollama from [ollama.com](https://ollama.com) or run it via Docker:

```bash
# Using Docker
docker run -d -p 11434:11434 ollama/ollama

# Or install natively and run
ollama serve
```

Pull the model you want to use:

```bash
ollama pull glm-5:cloud
# or any other model like: ollama pull llama3
```

### 3. Configure Environment

Create a `.env` file (or copy from `.env.example`):

```env
# Ollama server URL (default: http://127.0.0.1:11434)
OLLAMA_HOST=http://127.0.0.1:11434

# Model to use (default: glm-5:cloud)
OLLAMA_MODEL=glm-5:cloud

# Optional: API key for authenticated Ollama instances
OLLAMA_API_KEY=your-api-key-here
```

### 4. Run Sessions

```bash
npm run s01    # Minimal agent loop
npm run s02    # Tool use
npm run s03    # TodoWrite
# ... up to s12 and s-full
```

## Architecture

Same progressive structure as Python agents:

| Session | Mechanism |
|---------|-----------|
| s01 | Agent Loop - core while loop with tool execution |
| s02 | Tool Use - dispatch map for multiple tools |
| s03 | TodoWrite - in-memory task tracking with nag |
| s04 | Subagents - context isolation via fresh messages |
| s05 | Skills - on-demand knowledge loading |
| s06 | Context Compact - microcompact + auto-compact |
| s07 | Task System - file-based CRUD with dependencies |
| s08 | Background Tasks - daemon threads + notifications |
| s09 | Agent Teams - persistent teammates + mailboxes |
| s10 | Team Protocols - shutdown + plan approval |
| s11 | Autonomous Agents - idle cycle + auto-claim |
| s12 | Worktree Isolation - task coordination |
| s_full | All mechanisms combined |

## Key Differences from Python

1. **Ollama API**: Uses `/api/chat` endpoint with OpenAI-compatible tool format
2. **Async/await**: TypeScript requires async patterns for API calls
3. **Tool response format**: Uses `role: 'tool'` messages instead of `tool_result` blocks
4. **File system**: Uses Node.js `fs` module instead of Python `pathlib`

## Core Pattern

```typescript
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    const response = await callOllama(messages);
    messages.push({ role: 'assistant', content: response.message.content, tool_calls: response.message.tool_calls });

    if (!response.message.tool_calls || response.message.tool_calls.length === 0) {
      return;
    }

    for (const toolCall of response.message.tool_calls) {
      const output = executeTool(toolCall.function.name, JSON.parse(toolCall.function.arguments));
      messages.push({ role: 'tool', content: output, tool_call_id: toolCall.id });
    }
  }
}
```

The loop never changes. Each session adds harness mechanisms around it.

---

# s_full Agent System

The `s_full` agent is a full-featured AI coding agent combining all mechanisms from s03-s12 into a single, production-ready system.

## Key Features

- **Modular Tool Architecture**: Tools are dynamically loaded with scope-based visibility (main/child/bg)
- **Subagent Delegation**: Spawn isolated subagents for focused exploration or work
- **Teammate System**: Spawn autonomous teammate processes that can work independently
- **Task Management**: File-based task board with dependencies, ownership, and auto-claim
- **Context Management**: Auto-compact and micro-compact for long conversations
- **Background Tasks**: Run long-running commands asynchronously
- **Worktree Isolation**: Create isolated git worktrees for parallel development
- **Skill Loading**: On-demand loading of specialized knowledge from SKILL.md files

## REPL Commands

| Command | Description |
|---------|-------------|
| `/compact` | Manually compress conversation context |
| `/tasks` | List all tasks on the task board |
| `/team` | List all teammates with their status |
| `/inbox` | Show inbox status (handled via IPC for teammates) |
| `/tools` | List all loaded tools by scope (reloads tools) |
| `q` / `exit` | Exit the agent |

## Available Tools

### File Operations
- `bash` - Run shell commands (scope: main, child, bg)
- `read_file` - Read file contents
- `write_file` - Write content to file
- `edit_file` - Replace exact text in file

### Task Management (s03, s07)
- `TodoWrite` - In-memory todo list (s03)
- `task_create` / `task_get` / `task_update` / `task_list` - File-based task board (s07)
- `claim_task` - Claim an unclaimed task

### Skill Loading (s05)
- `load_skill` - Load specialized knowledge from SKILL.md

### Context Compression (s06)
- `compress` - Manually trigger context compression

### Background Tasks (s08)
- `background_run` - Run command asynchronously
- `check_background` - Check background task status

### Teammate System (s09/s11)
- `spawn_teammate` - Spawn autonomous teammate process
- `list_teammates` - List teammates with status
- `send_message` - Send message to teammate
- `read_inbox` - Read queued messages
- `broadcast` - Send message to all teammates

### Protocols (s10)
- `shutdown_request` - Request graceful teammate shutdown
- `plan_approval` - Approve/reject teammate's plan

### Autonomous Agents (s11)
- `idle` - Signal no more work, enter polling phase

### Subagent (s04)
- `task` - Spawn subagent for isolated work

### Worktree Isolation (s12)
- `worktree_create` / `worktree_list` / `worktree_status`
- `worktree_run` / `worktree_remove` / `worktree_keep`
- `worktree_events` - View lifecycle events

## Tool Scopes

- **main**: Available to lead agent (all tools)
- **child**: Available to teammate processes (file ops, tasks, messaging, self-management)
- **bg**: Available to background workers (file ops only)

## Teammate System

Teammates run as child Node.js processes with their own agent loops. They:

1. Process inbox messages in work phase
2. Execute tools until work is done
3. Enter idle phase and poll for new tasks
4. Auto-claim unclaimed tasks with no blocking dependencies
5. Exit after 60s idle timeout

## Directory Structure

```
agents-node/src/s_full/
├── index.ts           # Main agent loop + REPL
├── context.ts         # Context creation + TeammateManager
├── types.ts           # Type definitions + managers
├── teammate-worker.ts # Child process worker
└── tools/             # Modular tool definitions
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `glm-5:cloud` | Model name to use |
| `OLLAMA_API_KEY` | - | API key for cloud Ollama |

## Troubleshooting

- **"Not in a git repository"**: Worktree tools require a git repository. Run `git init`.
- **"Unknown skill"**: Skills must be in `skills/{name}/SKILL.md`.
- **"Path escapes workspace"**: File operations are sandboxed. Use relative paths.
- **Context too large**: Auto-compact triggers at 50k tokens. Use `/compact`.
- **Background task timeout**: 5-minute timeout. Use worktrees for longer tasks.