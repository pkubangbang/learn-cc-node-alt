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