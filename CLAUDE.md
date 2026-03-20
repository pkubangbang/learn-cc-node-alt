# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **learn-claude-code** - a teaching repository for **harness engineering**: building the environment (tools, knowledge, context management, permissions) that surrounds an AI agent model. The core philosophy: **the model IS the agent; the code is the harness**.

The repository contains progressive Python implementations (s01-s12) that each add one harness mechanism to a minimal agent loop, culminating in `s_full.py` which combines all mechanisms.

**Goal**: Add a Node.js equivalent implementation using Ollama as the LLM service provider, mirroring the Python agent architecture.
The working directory should be confined to `agents-node`, the programming language should be typescript.
The core library is `ollama`, the usage is explained in `OLLAMA-README.md`.

**Reference**: The reference project is in `agents` folder.

**CoAuthor**: This project use ollama with glm-5:cloud. When commiting the changes, notice the communication section.