import type {
  CleanupQuery,
  ForgetQuery,
  Memory,
  MemoryListQuery,
  MemorySearchQuery,
  MemoryStore,
  RememberResult,
  ScoredMemory,
  StoredMemoryInput,
} from "./types.js";
import {
  clamp,
  cloneMemory,
  cosineSimilarity,
  dedupeKey,
  normalizeContent,
} from "./utils.js";

function matchesListQuery(memory: Memory, query: MemoryListQuery): boolean {
  if (memory.ownerId !== query.ownerId) return false;
  if (memory.expiresAt && memory.expiresAt <= query.now) return false;
  if (query.kinds && !query.kinds.includes(memory.kind)) return false;
  if (query.sourceType && memory.source?.type !== query.sourceType) return false;
  if (query.sourceId && memory.source?.id !== query.sourceId) return false;
  return true;
}

function newestFirst(left: Memory, right: Memory): number {
  return right.createdAt.getTime() - left.createdAt.getTime();
}

export class InMemoryStore implements MemoryStore {
  readonly #memories = new Map<string, Memory>();
  readonly #dedupe = new Map<string, string>();

  async remember(input: StoredMemoryInput): Promise<RememberResult> {
    const content = normalizeContent(input.content);
    const key = dedupeKey(input.ownerId, input.kind, content);
    const existingId = this.#dedupe.get(key);
    const existing = existingId ? this.#memories.get(existingId) : undefined;

    if (existing) {
      const updated: Memory = {
        ...existing,
        importance: clamp(existing.importance + input.duplicateBoost),
        updatedAt: new Date(input.createdAt),
        ...(existing.embedding
          ? {}
          : input.embedding
            ? { embedding: [...input.embedding] }
            : {}),
      };
      this.#memories.set(existing.id, updated);
      return { memory: cloneMemory(updated), created: false };
    }

    const memory: Memory = {
      id: input.id,
      ownerId: input.ownerId,
      kind: input.kind,
      content,
      importance: clamp(input.importance),
      ...(input.source ? { source: { ...input.source } } : {}),
      ...(input.embedding ? { embedding: [...input.embedding] } : {}),
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
    };

    this.#memories.set(memory.id, memory);
    this.#dedupe.set(key, memory.id);
    return { memory: cloneMemory(memory), created: true };
  }

  async list(query: MemoryListQuery): Promise<Memory[]> {
    return [...this.#memories.values()]
      .filter((memory) => matchesListQuery(memory, query))
      .sort(
        (left, right) =>
          right.importance - left.importance || newestFirst(left, right),
      )
      .slice(0, query.limit)
      .map(cloneMemory);
  }

  async search(query: MemorySearchQuery): Promise<ScoredMemory[]> {
    return [...this.#memories.values()]
      .filter((memory) => matchesListQuery(memory, query))
      .flatMap((memory): ScoredMemory[] => {
        if (!memory.embedding || memory.embedding.length !== query.embedding.length) {
          return [];
        }
        const similarity = cosineSimilarity(memory.embedding, query.embedding);
        if (
          query.minSimilarity !== undefined &&
          similarity < query.minSimilarity
        ) {
          return [];
        }
        const score =
          similarity * (1 - query.importanceWeight) +
          memory.importance * query.importanceWeight;
        return [{ ...cloneMemory(memory), similarity, score }];
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.importance - left.importance ||
          newestFirst(left, right),
      )
      .slice(0, query.limit);
  }

  async boost(ids: readonly string[], amount: number): Promise<void> {
    for (const id of ids) {
      const memory = this.#memories.get(id);
      if (!memory) continue;
      this.#memories.set(id, {
        ...memory,
        importance: clamp(memory.importance + amount),
        updatedAt: new Date(),
      });
    }
  }

  async cleanup(query: CleanupQuery): Promise<number> {
    const ids = [...this.#memories.values()]
      .filter(
        (memory) =>
          memory.ownerId === query.ownerId &&
          ((memory.expiresAt !== undefined && memory.expiresAt <= query.now) ||
            (memory.importance < query.weakImportance &&
              memory.createdAt < query.weakBefore)),
      )
      .map((memory) => memory.id);
    return this.forget({ ownerId: query.ownerId, ids });
  }

  async forget(query: ForgetQuery): Promise<number> {
    let deleted = 0;
    for (const memory of [...this.#memories.values()]) {
      if (memory.ownerId !== query.ownerId) continue;
      if (query.ids && !query.ids.includes(memory.id)) continue;
      if (query.kinds && !query.kinds.includes(memory.kind)) continue;
      if (query.sourceType && memory.source?.type !== query.sourceType) continue;
      if (query.sourceId && memory.source?.id !== query.sourceId) continue;

      this.#memories.delete(memory.id);
      this.#dedupe.delete(dedupeKey(memory.ownerId, memory.kind, memory.content));
      deleted += 1;
    }
    return deleted;
  }
}
