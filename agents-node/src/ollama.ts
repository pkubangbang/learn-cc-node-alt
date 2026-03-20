/**
 * ollama.ts - Ollama client initialization utility
 *
 * Centralizes Ollama client configuration for all agent files.
 */

import { Ollama } from 'ollama';
import 'dotenv/config';

// Configuration
export const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
export const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
export const MODEL = process.env.OLLAMA_MODEL || 'glm-5:cloud';

// Initialize Ollama client
export const ollama = new Ollama({
  host: OLLAMA_HOST,
  ...(OLLAMA_API_KEY ? { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` } } : {}),
});
