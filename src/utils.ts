import type { Memory } from "./types.js";

let fallbackIdCounter = 0;

export function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/gu, " ");
}

export function dedupeKey(ownerId: string, kind: string, content: string): string {
  return `${ownerId}\u0000${kind}\u0000${normalizeContent(content).toLocaleLowerCase()}`;
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function defaultIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  fallbackIdCounter += 1;
  return `mem_${Date.now().toString(36)}_${fallbackIdCounter.toString(36)}`;
}

export function cloneMemory(memory: Memory): Memory {
  return {
    ...memory,
    ...(memory.source ? { source: { ...memory.source } } : {}),
    ...(memory.embedding ? { embedding: [...memory.embedding] } : {}),
    ...(memory.expiresAt ? { expiresAt: new Date(memory.expiresAt) } : {}),
    createdAt: new Date(memory.createdAt),
    updatedAt: new Date(memory.updatedAt),
  };
}

export function escapePromptData(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}
