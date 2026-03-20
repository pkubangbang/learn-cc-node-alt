# agents-node

Node.js/TypeScript implementations of agent harness mechanisms using Ollama as the LLM provider.

This is the Node.js equivalent of the Python `agents/` directory, following the same progressive session structure (s01-s12 + s_full).

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment (already set up with defaults)
# Edit .env if needed
cat .env

# Run sessions
npm run s01    # Minimal agent loop
npm run s02    # Tool use
npm run s03    # TodoWrite
# ... up to s12 and s-full
```

## Environment

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=glm-5:cloud
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