import type {
  CleanupQuery,
  ForgetQuery,
  Memory,
  MemoryEvent,
  MemoryHistoryQuery,
  MemoryListQuery,
  MemoryPatch,
  MemoryScoreDetails,
  MemorySearchQuery,
  MemoryStore,
  RememberResult,
  ScoredMemory,
  StoreRevisionInput,
  StoreSupersedeInput,
  StoredMemoryInput,
  SupersedeResult,
} from "./types.js";
import {
  accessFactor,
  clamp,
  cloneMemory,
  cloneMemoryEvent,
  cosineSimilarity,
  dedupeKey,
  defaultIdFactory,
  isMemoryVisible,
  normalizeContent,
  normalizedAccessScore,
  recencyScore,
  scopeContains,
  scopeMatches,
  temporalScore,
  tokenize,
} from "./utils.js";

function matchesListQuery(memory: Memory, query: MemoryListQuery): boolean {
  if (memory.ownerId !== query.ownerId) return false;
  if (!scopeMatches(memory.scope, query.scope)) return false;
  if (!isMemoryVisible(memory, query)) return false;
  if (query.kinds && !query.kinds.includes(memory.kind)) return false;
  if (query.sourceType && memory.source?.type !== query.sourceType) return false;
  if (query.sourceId && memory.source?.id !== query.sourceId) return false;
  return true;
}

function newestFirst(left: Memory, right: Memory): number {
  return right.createdAt.getTime() - left.createdAt.getTime();
}

function bm25Scores(memories: readonly Memory[], queryText: string): Map<string, number> {
  const queryTerms = [...new Set(tokenize(queryText))];
  if (queryTerms.length === 0 || memories.length === 0) return new Map();
  const documents = memories.map((memory) => tokenize(memory.content));
  const averageLength =
    documents.reduce((total, document) => total + document.length, 0) /
      documents.length || 1;
  const raw = new Map<string, number>();
  let maximum = 0;

  for (let index = 0; index < memories.length; index += 1) {
    const memory = memories[index];
    const document = documents[index] ?? [];
    const frequencies = new Map<string, number>();
    for (const term of document) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const documentFrequency = documents.filter((item) => item.includes(term)).length;
      const inverseFrequency = Math.log(
        1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
      );
      const denominator = frequency + 1.2 * (0.25 + 0.75 * document.length / averageLength);
      score += inverseFrequency * (frequency * 2.2) / denominator;
    }
    raw.set(memory?.id ?? "", score);
    maximum = Math.max(maximum, score);
  }

  if (maximum === 0) return raw;
  return new Map([...raw].map(([id, score]) => [id, score / maximum]));
}

function applyPatch(memory: Memory, patch: MemoryPatch, at: Date): Memory {
  const next = cloneMemory(memory);
  if (patch.content !== undefined) next.content = normalizeContent(patch.content);
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.importance !== undefined) next.importance = clamp(patch.importance);
  if (patch.confidence !== undefined) next.confidence = clamp(patch.confidence);
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.attributedTo === null) delete next.attributedTo;
  else if (patch.attributedTo !== undefined) next.attributedTo = patch.attributedTo;
  if (patch.source === null) delete next.source;
  else if (patch.source !== undefined) next.source = { ...patch.source };
  if (patch.metadata !== undefined) next.metadata = { ...patch.metadata };
  if (patch.links !== undefined) next.links = patch.links.map((link) => ({ ...link }));
  if (patch.embedding === null) delete next.embedding;
  else if (patch.embedding !== undefined) next.embedding = [...patch.embedding];
  if (patch.embeddingModel === null) delete next.embeddingModel;
  else if (patch.embeddingModel !== undefined) next.embeddingModel = patch.embeddingModel;
  if (patch.observedAt !== undefined) next.observedAt = new Date(patch.observedAt);
  if (patch.validFrom === null) delete next.validFrom;
  else if (patch.validFrom !== undefined) next.validFrom = new Date(patch.validFrom);
  if (patch.validUntil === null) delete next.validUntil;
  else if (patch.validUntil !== undefined) next.validUntil = new Date(patch.validUntil);
  if (patch.visibleUntil === null) {
    delete next.visibleUntil;
    delete next.expiresAt;
  } else if (patch.visibleUntil !== undefined) {
    next.visibleUntil = new Date(patch.visibleUntil);
    next.expiresAt = new Date(patch.visibleUntil);
  }
  if (patch.purgeAt === null) delete next.purgeAt;
  else if (patch.purgeAt !== undefined) next.purgeAt = new Date(patch.purgeAt);
  next.updatedAt = new Date(at);
  return next;
}

export class InMemoryStore implements MemoryStore {
  readonly #memories = new Map<string, Memory>();
  readonly #dedupe = new Map<string, string>();
  readonly #events = new Map<string, MemoryEvent[]>();

  #appendEvent(event: Omit<MemoryEvent, "id">): void {
    const events = this.#events.get(event.memoryId) ?? [];
    events.push({ id: defaultIdFactory(), ...event });
    this.#events.set(event.memoryId, events);
  }

  #set(memory: Memory, previous?: Memory): void {
    if (previous) {
      this.#dedupe.delete(
        dedupeKey(previous.ownerId, previous.scope, previous.kind, previous.content),
      );
    }
    this.#memories.set(memory.id, memory);
    if (memory.status === "active") {
      this.#dedupe.set(
        dedupeKey(memory.ownerId, memory.scope, memory.kind, memory.content),
        memory.id,
      );
    }
  }

  async remember(input: StoredMemoryInput): Promise<RememberResult> {
    const content = normalizeContent(input.content);
    const key = dedupeKey(input.ownerId, input.scope, input.kind, content);
    const existingId = this.#dedupe.get(key);
    const existing = existingId ? this.#memories.get(existingId) : undefined;

    if (existing?.status === "active") {
      const updated: Memory = {
        ...existing,
        confidence: clamp(existing.confidence + input.duplicateConfidenceBoost),
        updatedAt: new Date(input.createdAt),
        ...(existing.embedding
          ? {}
          : input.embedding
            ? { embedding: [...input.embedding] }
            : {}),
        ...(existing.embeddingModel
          ? {}
          : input.embeddingModel
            ? { embeddingModel: input.embeddingModel }
            : {}),
      };
      this.#set(updated, existing);
      this.#appendEvent({
        memoryId: updated.id,
        ownerId: updated.ownerId,
        action: "reinforce",
        previous: cloneMemory(existing),
        next: cloneMemory(updated),
        ...(input.actor ? { actor: input.actor } : {}),
        createdAt: new Date(input.createdAt),
      });
      return { memory: cloneMemory(updated), created: false };
    }

    const visibleUntil = input.visibleUntil ?? input.expiresAt;
    const memory: Memory = {
      id: input.id,
      ownerId: input.ownerId,
      scope: { ...input.scope },
      kind: input.kind,
      content,
      importance: clamp(input.importance),
      confidence: clamp(input.confidence),
      status: "active",
      ...(input.attributedTo ? { attributedTo: input.attributedTo } : {}),
      ...(input.source ? { source: { ...input.source } } : {}),
      metadata: { ...input.metadata },
      links: input.links.map((link) => ({ ...link })),
      ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
      ...(input.embedding ? { embedding: [...input.embedding] } : {}),
      ...(input.embeddingModel ? { embeddingModel: input.embeddingModel } : {}),
      observedAt: new Date(input.observedAt),
      ...(input.validFrom ? { validFrom: new Date(input.validFrom) } : {}),
      ...(input.validUntil ? { validUntil: new Date(input.validUntil) } : {}),
      ...(visibleUntil
        ? {
            visibleUntil: new Date(visibleUntil),
            expiresAt: new Date(visibleUntil),
          }
        : {}),
      ...(input.purgeAt ? { purgeAt: new Date(input.purgeAt) } : {}),
      access: { count: 0, recentAccesses: [] },
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
    };

    this.#set(memory);
    this.#appendEvent({
      memoryId: memory.id,
      ownerId: memory.ownerId,
      action: "add",
      next: cloneMemory(memory),
      ...(input.actor ? { actor: input.actor } : {}),
      createdAt: new Date(input.createdAt),
    });
    return { memory: cloneMemory(memory), created: true };
  }

  async get(query: MemoryHistoryQuery): Promise<Memory | null> {
    const memory = this.#memories.get(query.memoryId);
    return memory &&
      memory.ownerId === query.ownerId &&
      scopeMatches(memory.scope, query.scope)
      ? cloneMemory(memory)
      : null;
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
    const candidates = [...this.#memories.values()].filter((memory) =>
      matchesListQuery(memory, query),
    );
    const keywordScores = bm25Scores(candidates, query.queryText);

    const scored = candidates.flatMap((memory): ScoredMemory[] => {
      const semantic =
        query.embedding && memory.embedding
          ? clamp((cosineSimilarity(memory.embedding, query.embedding) + 1) / 2)
          : 0;
      const rawSimilarity =
        query.embedding && memory.embedding
          ? cosineSimilarity(memory.embedding, query.embedding)
          : undefined;
      if (
        rawSimilarity !== undefined &&
        query.minSimilarity !== undefined &&
        rawSimilarity < query.minSimilarity
      ) {
        return [];
      }
      const keyword = keywordScores.get(memory.id) ?? 0;
      const components = {
        semantic,
        keyword,
        importance: clamp(memory.importance),
        recency: recencyScore(memory, query.now),
        temporal: temporalScore(memory, query.referenceTime),
        access: normalizedAccessScore(memory, query.now),
      };
      const activeWeights: Partial<typeof query.weights> = {
        ...(query.embedding && memory.embedding
          ? { semantic: query.weights.semantic }
          : {}),
        ...(tokenize(query.queryText).length > 0
          ? { keyword: query.weights.keyword }
          : {}),
        importance: query.weights.importance,
        recency: query.weights.recency,
        temporal: query.weights.temporal,
        access: query.weights.access,
      };
      const weightTotal = Object.values(activeWeights).reduce(
        (total, weight) => total + (weight ?? 0),
        0,
      );
      const fused =
        weightTotal === 0
          ? 0
          : (Object.entries(activeWeights) as [keyof typeof components, number][])
              .reduce(
                (total, [component, weight]) =>
                  total + components[component] * weight,
                0,
              ) / weightTotal;
      if (query.minScore !== undefined && fused < query.minScore) return [];
      const details: MemoryScoreDetails = {
        ...components,
        accessFactor: accessFactor(memory, query.now),
        activeWeights,
        fused,
      };
      return [
        {
          ...cloneMemory(memory),
          score: fused,
          ...(rawSimilarity !== undefined ? { similarity: rawSimilarity } : {}),
          ...(query.explain ? { scoreDetails: details } : {}),
        },
      ];
    });

    return scored
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.importance - left.importance ||
          newestFirst(left, right),
      )
      .slice(0, Math.max(query.limit, query.overfetch));
  }

  async revise(input: StoreRevisionInput): Promise<Memory> {
    const current = await this.get(input);
    if (!current) throw new Error(`Memory not found: ${input.memoryId}`);
    if (input.patch.content !== undefined && normalizeContent(input.patch.content).length === 0) {
      throw new TypeError("content must not be empty");
    }
    const updated = applyPatch(current, input.patch, input.at);
    this.#set(updated, current);
    const action =
      updated.status === "retracted"
        ? "retract"
        : current.status === "retracted" && updated.status === "active"
          ? "restore"
          : "revise";
    this.#appendEvent({
      memoryId: current.id,
      ownerId: current.ownerId,
      action,
      previous: current,
      next: cloneMemory(updated),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: new Date(input.at),
    });
    return cloneMemory(updated);
  }

  async supersede(input: StoreSupersedeInput): Promise<SupersedeResult> {
    const current = await this.get(input);
    if (!current) throw new Error(`Memory not found: ${input.memoryId}`);
    if (current.status !== "active") {
      throw new Error(`Only active memories can be superseded: ${input.memoryId}`);
    }
    const previous = applyPatch(
      current,
      { status: "superseded", validUntil: input.at },
      input.at,
    );
    this.#set(previous, current);
    const result = await this.remember(input.replacement);
    if (!result.created) {
      // Restore a coherent link even when the replacement reinforced an existing fact.
      await this.revise({
        ownerId: input.ownerId,
        scope: input.scope,
        memoryId: result.memory.id,
        patch: {
          links: [
            ...result.memory.links,
            { memoryId: current.id, type: "updates" },
          ],
        },
        at: input.at,
        ...(input.actor ? { actor: input.actor } : {}),
        reason: input.reason ?? "supersede",
      });
    }
    const replacement = (await this.get({ ...input, memoryId: result.memory.id }))!;
    this.#appendEvent({
      memoryId: current.id,
      ownerId: current.ownerId,
      action: "supersede",
      previous: current,
      next: cloneMemory(previous),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: new Date(input.at),
    });
    return { previous: cloneMemory(previous), replacement };
  }

  async history(query: MemoryHistoryQuery): Promise<MemoryEvent[]> {
    const memory = await this.get(query);
    if (!memory) return [];
    return (this.#events.get(query.memoryId) ?? []).map(cloneMemoryEvent);
  }

  async recordAccess(ids: readonly string[], at: Date): Promise<void> {
    for (const id of ids) {
      const memory = this.#memories.get(id);
      if (!memory) continue;
      this.#memories.set(id, {
        ...memory,
        access: {
          count: memory.access.count + 1,
          lastAccessedAt: new Date(at),
          recentAccesses: [...memory.access.recentAccesses, new Date(at)].slice(-20),
        },
      });
    }
  }

  async cleanup(query: CleanupQuery): Promise<number> {
    const ids = [...this.#memories.values()]
      .filter(
        (memory) =>
          memory.ownerId === query.ownerId &&
          scopeContains(query.scope, memory.scope) &&
          ((memory.purgeAt !== undefined && memory.purgeAt <= query.now) ||
            (memory.importance < query.weakImportance &&
              memory.createdAt < query.weakBefore)),
      )
      .map((memory) => memory.id);
    return this.forget({ ownerId: query.ownerId, scope: query.scope, ids });
  }

  async forget(query: ForgetQuery): Promise<number> {
    let deleted = 0;
    for (const memory of [...this.#memories.values()]) {
      if (memory.ownerId !== query.ownerId) continue;
      if (!scopeContains(query.scope, memory.scope)) continue;
      if (query.ids && !query.ids.includes(memory.id)) continue;
      if (query.kinds && !query.kinds.includes(memory.kind)) continue;
      if (query.sourceType && memory.source?.type !== query.sourceType) continue;
      if (query.sourceId && memory.source?.id !== query.sourceId) continue;

      this.#memories.delete(memory.id);
      this.#events.delete(memory.id);
      this.#dedupe.delete(
        dedupeKey(memory.ownerId, memory.scope, memory.kind, memory.content),
      );
      deleted += 1;
    }
    return deleted;
  }
}
