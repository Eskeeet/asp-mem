import type {
  Memory,
  MemoryEvent,
  MemoryScope,
  RecallWeights,
} from "./types.js";

let fallbackIdCounter = 0;

export const DEFAULT_RECALL_WEIGHTS: RecallWeights = {
  semantic: 0.5,
  keyword: 0.2,
  importance: 0.1,
  recency: 0.05,
  temporal: 0.1,
  access: 0.05,
};

const SCOPE_FIELDS = [
  "tenantId",
  "organizationId",
  "userId",
  "agentId",
  "sessionId",
] as const;

export function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/gu, " ");
}

export function normalizeScope(
  ownerId: string,
  scope: MemoryScope = {},
): MemoryScope {
  const normalized: MemoryScope = { ...scope, userId: scope.userId ?? ownerId };
  for (const field of SCOPE_FIELDS) {
    const value = normalized[field];
    if (value !== undefined && value.trim().length === 0) {
      throw new TypeError(`scope.${field} must not be empty`);
    }
  }
  return normalized;
}

/** A memory is visible when every scope field it declares matches the request. */
export function scopeMatches(
  memoryScope: MemoryScope,
  requestScope: MemoryScope,
): boolean {
  return SCOPE_FIELDS.every(
    (field) =>
      memoryScope[field] === undefined ||
      memoryScope[field] === requestScope[field],
  );
}

/** True when a record lives inside the requested scope or one of its descendants. */
export function scopeContains(
  requestScope: MemoryScope,
  memoryScope: MemoryScope,
): boolean {
  return SCOPE_FIELDS.every(
    (field) =>
      requestScope[field] === undefined ||
      requestScope[field] === memoryScope[field],
  );
}

export function scopeKey(scope: MemoryScope): string {
  return SCOPE_FIELDS.map((field) => scope[field] ?? "").join("\u0001");
}

export function dedupeKey(
  ownerId: string,
  scope: MemoryScope,
  kind: string,
  content: string,
): string {
  return `${ownerId}\u0000${scopeKey(scope)}\u0000${kind}\u0000${normalizeContent(content).toLocaleLowerCase()}`;
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
    scope: { ...memory.scope },
    ...(memory.source ? { source: { ...memory.source } } : {}),
    metadata: { ...memory.metadata },
    links: memory.links.map((link) => ({ ...link })),
    ...(memory.embedding ? { embedding: [...memory.embedding] } : {}),
    observedAt: new Date(memory.observedAt),
    ...(memory.validFrom ? { validFrom: new Date(memory.validFrom) } : {}),
    ...(memory.validUntil ? { validUntil: new Date(memory.validUntil) } : {}),
    ...(memory.visibleUntil
      ? { visibleUntil: new Date(memory.visibleUntil) }
      : {}),
    ...(memory.expiresAt ? { expiresAt: new Date(memory.expiresAt) } : {}),
    ...(memory.purgeAt ? { purgeAt: new Date(memory.purgeAt) } : {}),
    access: {
      ...memory.access,
      ...(memory.access.lastAccessedAt
        ? { lastAccessedAt: new Date(memory.access.lastAccessedAt) }
        : {}),
      recentAccesses: memory.access.recentAccesses.map((date) => new Date(date)),
    },
    createdAt: new Date(memory.createdAt),
    updatedAt: new Date(memory.updatedAt),
  };
}

export function cloneMemoryEvent(event: MemoryEvent): MemoryEvent {
  return {
    ...event,
    ...(event.previous ? { previous: cloneMemory(event.previous) } : {}),
    ...(event.next ? { next: cloneMemory(event.next) } : {}),
    ...(event.actor
      ? { actor: { ...event.actor, ...(event.actor.roles ? { roles: [...event.actor.roles] } : {}) } }
      : {}),
    createdAt: new Date(event.createdAt),
  };
}

export function isMemoryVisible(
  memory: Memory,
  input: {
    now: Date;
    referenceTime?: Date;
    includeExpired?: boolean;
    includeInactive?: boolean;
  },
): boolean {
  const visibleUntil = memory.visibleUntil ?? memory.expiresAt;
  if (!input.includeExpired && visibleUntil && visibleUntil <= input.now) {
    return false;
  }
  if (input.includeInactive) return true;
  if (memory.status === "retracted") return false;

  const effectiveAt = input.referenceTime ?? input.now;
  const startsAt = memory.validFrom ?? memory.observedAt;
  if (startsAt > effectiveAt) return false;
  if (memory.validUntil && memory.validUntil <= effectiveAt) return false;

  // Historical recall can include the superseded observation that was valid then.
  return memory.status === "active" || input.referenceTime !== undefined;
}

export function tokenize(value: string): string[] {
  return (
    value
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((token) => token.length > 1);
}

export function recencyScore(memory: Memory, now: Date): number {
  const ageDays = Math.max(0, now.getTime() - memory.updatedAt.getTime()) / 86_400_000;
  return 2 ** (-ageDays / 90);
}

/** Bounded retrieval utility. It never changes explicit importance. */
export function accessFactor(memory: Memory, now: Date): number {
  if (!memory.access.lastAccessedAt || memory.access.count === 0) return 0.7;
  const ageDays = Math.max(
    0,
    now.getTime() - memory.access.lastAccessedAt.getTime(),
  ) / 86_400_000;
  const recency = 2 ** (-ageDays / 30);
  const frequency = 1 - Math.exp(-memory.access.count / 6);
  return clamp(0.3 + 0.7 * recency + 0.5 * frequency, 0.3, 1.5);
}

export function normalizedAccessScore(memory: Memory, now: Date): number {
  return clamp((accessFactor(memory, now) - 0.3) / 1.2);
}

export function temporalScore(
  memory: Memory,
  referenceTime: Date | undefined,
): number {
  if (!referenceTime) return memory.validFrom || memory.validUntil ? 0.75 : 0.5;
  const startsAt = memory.validFrom ?? memory.observedAt;
  if (startsAt <= referenceTime && (!memory.validUntil || memory.validUntil > referenceTime)) {
    return 1;
  }
  const distance = Math.min(
    Math.abs(referenceTime.getTime() - startsAt.getTime()),
    memory.validUntil
      ? Math.abs(referenceTime.getTime() - memory.validUntil.getTime())
      : Number.POSITIVE_INFINITY,
  );
  return 2 ** (-(distance / 86_400_000) / 30);
}

export function mergeWeights(overrides: Partial<RecallWeights> = {}): RecallWeights {
  return {
    semantic: clamp(overrides.semantic ?? DEFAULT_RECALL_WEIGHTS.semantic),
    keyword: clamp(overrides.keyword ?? DEFAULT_RECALL_WEIGHTS.keyword),
    importance: clamp(overrides.importance ?? DEFAULT_RECALL_WEIGHTS.importance),
    recency: clamp(overrides.recency ?? DEFAULT_RECALL_WEIGHTS.recency),
    temporal: clamp(overrides.temporal ?? DEFAULT_RECALL_WEIGHTS.temporal),
    access: clamp(overrides.access ?? DEFAULT_RECALL_WEIGHTS.access),
  };
}

export function escapePromptData(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}
