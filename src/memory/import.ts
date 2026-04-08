/**
 * memory/import.ts — Import/export memories and conversations.
 *
 * Conversation normalization from MemPalace: single function handles
 * Claude JSON, ChatGPT JSON, Claude Code JSONL, and plain text.
 *
 * Memory import/export uses simple JSON format.
 */

import type { Database } from "../db.js";
import { extractAndStore as _rawExtractAndStore } from "./extractor.js";
import { readFileSync, writeFileSync } from "node:fs";

// Break circular: memoryStore is resolved lazily at call time
async function getMemoryStore() {
  const mod = await import("./index.js");
  return mod.memoryStore;
}

async function extractAndStore(db: Database, text: string, scope?: string) {
  const store = await getMemoryStore();
  return _rawExtractAndStore(db, text, scope, store);
}

// =============================================================================
// Types
// =============================================================================

type ConversationMessage = {
  role: "user" | "assistant" | "system";
  text: string;
};

type ImportResult = {
  messages: number;
  memoriesStored: number;
  duplicates: number;
};

// =============================================================================
// Conversation format detection + normalization
// From MemPalace normalize.py — handles multiple export formats
// =============================================================================

function normalizeConversation(content: string): ConversationMessage[] {
  const trimmed = content.trim();

  // Try JSON parse first
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON — check for JSONL
    if (trimmed.startsWith("{")) {
      return normalizeJsonl(trimmed);
    }
    // Plain text — treat as user messages split by newlines
    return normalizePlainText(trimmed);
  }

  if (Array.isArray(parsed)) {
    // Could be ChatGPT conversations.json or Claude export
    const first = parsed[0];
    if (first && typeof first === "object") {
      if ("mapping" in first) return normalizeChatGPT(parsed);
      if ("uuid" in first) return normalizeClaudeExport(parsed);
      if ("role" in first && "content" in first) return normalizeOpenAIMessages(parsed);
    }
  }

  if (typeof parsed === "object" && parsed !== null) {
    // Single conversation object
    if ("mapping" in parsed) return normalizeChatGPT([parsed]);
    if ("chat_messages" in parsed) return normalizeClaudeChat(parsed as Record<string, unknown>);
  }

  return normalizePlainText(trimmed);
}

// ChatGPT conversations.json (tree structure)
function normalizeChatGPT(conversations: unknown[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const convo of conversations) {
    const mapping = (convo as Record<string, unknown>).mapping as Record<string, { message?: { author?: { role?: string }; content?: { parts?: string[] } } }> | undefined;
    if (!mapping) continue;
    for (const node of Object.values(mapping)) {
      const msg = node.message;
      if (!msg?.content?.parts?.length) continue;
      const role = msg.author?.role === "assistant" ? "assistant" : "user";
      const text = msg.content.parts.join("\n").trim();
      if (text.length > 10) messages.push({ role, text });
    }
  }
  return messages;
}

// Claude.ai export (array of conversation objects)
function normalizeClaudeExport(conversations: unknown[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const convo of conversations) {
    const chatMessages = (convo as Record<string, unknown>).chat_messages as Array<{ sender?: string; text?: string }> | undefined;
    if (!chatMessages) continue;
    for (const msg of chatMessages) {
      if (!msg.text || msg.text.length < 10) continue;
      const role = msg.sender === "assistant" ? "assistant" : "user";
      messages.push({ role, text: msg.text });
    }
  }
  return messages;
}

// Claude single chat object
function normalizeClaudeChat(convo: Record<string, unknown>): ConversationMessage[] {
  const chatMessages = convo.chat_messages as Array<{ sender?: string; text?: string }> | undefined;
  if (!chatMessages) return [];
  return chatMessages
    .filter(m => m.text && m.text.length >= 10)
    .map(m => ({ role: m.sender === "assistant" ? "assistant" as const : "user" as const, text: m.text! }));
}

// OpenAI messages format [{role, content}]
function normalizeOpenAIMessages(messages: unknown[]): ConversationMessage[] {
  return (messages as Array<{ role?: string; content?: string }>)
    .filter(m => m.content && m.content.length >= 10)
    .map(m => ({
      role: m.role === "assistant" ? "assistant" as const : "user" as const,
      text: m.content!,
    }));
}

// JSONL (one JSON object per line — Claude Code, OpenAI Codex)
function normalizeJsonl(content: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const role = obj.role === "assistant" ? "assistant" as const : "user" as const;
      const text = (obj.content || obj.text || obj.message || "") as string;
      if (text.length >= 10) messages.push({ role, text });
    } catch { continue; }
  }
  return messages;
}

// Plain text — split by double newlines, treat as user messages
function normalizePlainText(content: string): ConversationMessage[] {
  return content.split(/\n{2,}/)
    .map(chunk => chunk.trim())
    .filter(chunk => chunk.length >= 20)
    .map(chunk => ({ role: "user" as const, text: chunk }));
}

// =============================================================================
// Import conversation file → extract memories
// =============================================================================

export async function importConversation(
  db: Database,
  filePath: string,
  scope?: string,
): Promise<ImportResult> {
  const content = readFileSync(filePath, "utf-8");
  const messages = normalizeConversation(content);

  let memoriesStored = 0;
  let duplicates = 0;

  // Process in exchange pairs (user + assistant = one chunk)
  for (let i = 0; i < messages.length; i += 2) {
    const userMsg = messages[i];
    const assistantMsg = messages[i + 1];
    const chunk = [
      userMsg?.text || "",
      assistantMsg ? `Assistant: ${assistantMsg.text}` : "",
    ].filter(Boolean).join("\n\n");

    if (chunk.length < 30) continue;

    const result = await extractAndStore(db, chunk, scope);
    memoriesStored += result.stored;
    duplicates += result.duplicates;
  }

  return { messages: messages.length, memoriesStored, duplicates };
}

// =============================================================================
// Memory export/import (JSON format)
// =============================================================================

type ExportedMemory = {
  text: string;
  category: string;
  scope: string;
  importance: number;
  created_at: number;
  metadata?: string | null;
};

export function exportMemories(db: Database, filePath: string): number {
  const memories = db.prepare(`SELECT text, category, scope, importance, created_at, metadata FROM memories`).all() as ExportedMemory[];
  writeFileSync(filePath, JSON.stringify(memories, null, 2), "utf-8");
  return memories.length;
}

export async function importMemories(
  db: Database,
  filePath: string,
): Promise<{ imported: number; duplicates: number }> {
  const content = readFileSync(filePath, "utf-8");
  const memories = JSON.parse(content) as ExportedMemory[];

  let imported = 0;
  let duplicates = 0;

  for (const mem of memories) {
    const store = await getMemoryStore();
    const result = await store(db, {
      text: mem.text,
      category: mem.category as any,
      scope: mem.scope,
      importance: mem.importance,
    });
    if (result.status === "created") imported++;
    else duplicates++;
  }

  return { imported, duplicates };
}
