import { renderMemoryContext } from "./context.js";
import { InMemoryStore } from "./in-memory-store.js";
import type {
  AspMemoryOptions,
  CaptureTurnInput,
  CleanupQuery,
  ContextOptions,
  ForgetQuery,
  Memory,
  MemoryActor,
  MemoryAttribution,
  MemoryEvent,
  MemoryKind,
  MemoryListQuery,
  MemoryOperation,
  MemoryPatch,
  MemoryScope,
  MemorySearchQuery,
  RecallOptions,
  RememberInput,
  RememberResult,
  ScoredMemory,
  StoredMemoryInput,
  SupersedeResult,
} from "./types.js";
import {
  assertNonEmpty,
  clamp,
  defaultIdFactory,
  mergeWeights,
  normalizeContent,
  normalizeScope,
} from "./utils.js";

const CAPTURE_KINDS = ["preference", "insight", "life_event", "pattern"] as const;
const USER_ONLY_ATTRIBUTION: readonly MemoryAttribution[] = ["user"];

type ResolvedOptions = AspMemoryOptions & {
  store: NonNullable<AspMemoryOptions["store"]>;
  duplicateConfidenceBoost: number;
  now: () => Date;
  idFactory: () => string;
};

export interface MutationOptions {
  scope?: MemoryScope;
  actor?: MemoryActor;
  reason?: string;
}

export interface CleanupOptions extends MutationOptions {
  weakImportance?: number;
  weakAfterDays?: number;
}

export class AspMemory {
  readonly #options: ResolvedOptions;

  constructor(options: AspMemoryOptions = {}) {
    this.#options = {
      ...options,
      store: options.store ?? new InMemoryStore(),
      duplicateConfidenceBoost: clamp(
        options.duplicateConfidenceBoost ?? options.duplicateBoost ?? 0.1,
      ),
      defaultWeights: mergeWeights(options.defaultWeights),
      now: options.now ?? (() => new Date()),
      idFactory: options.idFactory ?? defaultIdFactory,
    };
  }

  async #authorize(
    operation: MemoryOperation,
    ownerId: string,
    scope: MemoryScope,
    actor?: MemoryActor,
    memoryId?: string,
  ): Promise<void> {
    if (!this.#options.accessPolicy) return;
    const allowed = await this.#options.accessPolicy.authorize({
      operation,
      ownerId,
      scope,
      ...(actor ? { actor } : {}),
      ...(memoryId ? { memoryId } : {}),
    });
    if (!allowed) throw new Error(`Memory access denied for ${operation}`);
  }

  async #embedding(content: string, operation: string): Promise<readonly number[] | undefined> {
    if (!this.#options.embedder) return undefined;
    try {
      const candidate = await this.#options.embedder.embed(content);
      return candidate.length > 0 && candidate.every(Number.isFinite)
        ? candidate
        : undefined;
    } catch (error) {
      this.#report(error, operation);
      return undefined;
    }
  }

  async #prepare(input: RememberInput, createdAt: Date): Promise<StoredMemoryInput> {
    assertNonEmpty(input.ownerId, "ownerId");
    assertNonEmpty(input.content, "content");
    const content = normalizeContent(input.content);
    const scope = normalizeScope(input.ownerId, input.scope);
    const observedAt = input.observedAt ?? createdAt;
    const visibleUntil = input.visibleUntil ?? input.expiresAt;
    if (input.validFrom && input.validUntil && input.validUntil <= input.validFrom) {
      throw new RangeError("validUntil must be later than validFrom");
    }
    const embedding = await this.#embedding(content, "embed:remember");
    const embeddingModel = input.embeddingModel ?? this.#options.embedder?.model;
    return {
      ...input,
      id: this.#options.idFactory(),
      scope,
      content,
      kind: input.kind ?? "insight",
      importance: clamp(input.importance ?? 0.5),
      confidence: clamp(input.confidence ?? 0.7),
      metadata: { ...(input.metadata ?? {}) },
      links: (input.links ?? []).map((link) => ({ ...link })),
      observedAt: new Date(observedAt),
      ...(visibleUntil ? { visibleUntil: new Date(visibleUntil) } : {}),
      ...(embedding ? { embedding } : {}),
      ...(embeddingModel ? { embeddingModel } : {}),
      createdAt: new Date(createdAt),
      duplicateConfidenceBoost: this.#options.duplicateConfidenceBoost,
    };
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const scope = normalizeScope(input.ownerId, input.scope);
    await this.#authorize("remember", input.ownerId, scope, input.actor);
    return this.#options.store.remember(await this.#prepare(input, this.#options.now()));
  }

  async rememberMany(inputs: readonly RememberInput[]): Promise<RememberResult[]> {
    const results: RememberResult[] = [];
    for (const input of inputs) results.push(await this.remember(input));
    return results;
  }

  async get(
    ownerId: string,
    memoryId: string,
    options: Pick<MutationOptions, "scope" | "actor"> = {},
  ): Promise<Memory | null> {
    assertNonEmpty(ownerId, "ownerId");
    assertNonEmpty(memoryId, "memoryId");
    const scope = normalizeScope(ownerId, options.scope);
    await this.#authorize("recall", ownerId, scope, options.actor, memoryId);
    return this.#options.store.get({ ownerId, scope, memoryId });
  }

  async recall(ownerId: string, options: RecallOptions = {}): Promise<ScoredMemory[]> {
    assertNonEmpty(ownerId, "ownerId");
    const now = this.#options.now();
    const scope = normalizeScope(ownerId, options.scope);
    await this.#authorize("recall", ownerId, scope, options.actor);
    const limit = Math.max(1, Math.floor(options.limit ?? 8));
    const common: MemoryListQuery = {
      ownerId,
      scope,
      limit,
      now,
      ...(options.kinds ? { kinds: options.kinds } : {}),
      ...(options.sourceType ? { sourceType: options.sourceType } : {}),
      ...(options.sourceId ? { sourceId: options.sourceId } : {}),
      ...(options.referenceTime ? { referenceTime: options.referenceTime } : {}),
      ...(options.includeExpired !== undefined
        ? { includeExpired: options.includeExpired }
        : {}),
      ...(options.includeInactive !== undefined
        ? { includeInactive: options.includeInactive }
        : {}),
    };
    let memories: ScoredMemory[];
    const queryText = options.query?.trim();

    if (queryText) {
      const embedding = await this.#embedding(queryText, "embed:recall");
      const searchQuery: MemorySearchQuery = {
        ...common,
        queryText,
        weights: mergeWeights({
          ...this.#options.defaultWeights,
          ...options.weights,
        }),
        overfetch: Math.max(limit, Math.floor(options.overfetch ?? limit * 3)),
        ...(embedding ? { embedding } : {}),
        ...(options.minSimilarity !== undefined
          ? { minSimilarity: options.minSimilarity }
          : {}),
        ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
        ...(options.explain !== undefined ? { explain: options.explain } : {}),
      };
      memories = await this.#options.store.search(searchQuery);

      if (this.#options.reranker && options.rerank !== false && memories.length > 0) {
        try {
          const candidates = memories;
          const rankings = await this.#options.reranker.rerank({
            query: queryText,
            candidates,
            limit,
          });
          const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
          const ranked: ScoredMemory[] = [];
          for (const ranking of rankings) {
            const candidate = byId.get(ranking.memoryId);
            if (!candidate) continue;
            byId.delete(ranking.memoryId);
            ranked.push({
              ...candidate,
              score: ranking.score,
              ...(candidate.scoreDetails
                ? {
                    scoreDetails: {
                      ...candidate.scoreDetails,
                      reranker: ranking.score,
                    },
                  }
                : {}),
            });
          }
          memories = [...ranked, ...byId.values()];
        } catch (error) {
          this.#report(error, "rerank:recall");
        }
      }
      memories = memories.slice(0, limit);
    } else {
      memories = (await this.#options.store.list(common)).map((memory) => ({
        ...memory,
        score: memory.importance,
      }));
    }

    if (options.trackAccess !== false && memories.length > 0) {
      try {
        await this.#options.store.recordAccess(
          memories.map((memory) => memory.id),
          now,
        );
      } catch (error) {
        this.#report(error, "access:recall");
      }
    }
    return memories;
  }

  async context(ownerId: string, options: ContextOptions = {}): Promise<string> {
    const memories = await this.recall(ownerId, options);
    return renderMemoryContext(memories, options);
  }

  async revise(
    ownerId: string,
    memoryId: string,
    patch: MemoryPatch,
    options: MutationOptions = {},
  ): Promise<Memory> {
    const scope = normalizeScope(ownerId, options.scope);
    await this.#authorize(
      patch.status === "retracted"
        ? "retract"
        : patch.status === "active"
          ? "restore"
          : "revise",
      ownerId,
      scope,
      options.actor,
      memoryId,
    );
    return this.#options.store.revise({
      ownerId,
      scope,
      memoryId,
      patch,
      at: this.#options.now(),
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    });
  }

  async retract(
    ownerId: string,
    memoryId: string,
    options: MutationOptions = {},
  ): Promise<Memory> {
    return this.revise(ownerId, memoryId, { status: "retracted" }, options);
  }

  async restore(
    ownerId: string,
    memoryId: string,
    options: MutationOptions = {},
  ): Promise<Memory> {
    const current = await this.get(ownerId, memoryId, options);
    if (!current) throw new Error(`Memory not found: ${memoryId}`);
    if (current.status !== "retracted") {
      throw new Error(`Only retracted memories can be restored: ${memoryId}`);
    }
    return this.revise(ownerId, memoryId, { status: "active" }, options);
  }

  async supersede(
    ownerId: string,
    memoryId: string,
    replacement: Omit<RememberInput, "ownerId" | "scope" | "actor" >,
    options: MutationOptions = {},
  ): Promise<SupersedeResult> {
    const scope = normalizeScope(ownerId, options.scope);
    await this.#authorize("supersede", ownerId, scope, options.actor, memoryId);
    const at = this.#options.now();
    const current = await this.#options.store.get({ ownerId, scope, memoryId });
    if (!current) throw new Error(`Memory not found: ${memoryId}`);
    if (current.status !== "active") {
      throw new Error(`Only active memories can be superseded: ${memoryId}`);
    }
    const links = [
      ...(replacement.links ?? []),
      { memoryId, type: "updates" as const },
    ];
    const replacementInput: RememberInput = {
        ...replacement,
        ownerId,
        scope,
        links,
        supersedesId: memoryId,
        validFrom: replacement.validFrom ?? at,
        ...(replacement.source ?? current.source
          ? { source: replacement.source ?? current.source }
          : {}),
      };
    const prepared = await this.#prepare(replacementInput, at);
    return this.#options.store.supersede({
      ownerId,
      scope,
      memoryId,
      replacement: prepared,
      at,
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    });
  }

  async history(
    ownerId: string,
    memoryId: string,
    options: Pick<MutationOptions, "scope" | "actor"> = {},
  ): Promise<MemoryEvent[]> {
    const scope = normalizeScope(ownerId, options.scope);
    await this.#authorize("history", ownerId, scope, options.actor, memoryId);
    return this.#options.store.history({ ownerId, scope, memoryId });
  }

  async captureTurn(input: CaptureTurnInput): Promise<RememberResult[]> {
    assertNonEmpty(input.ownerId, "ownerId");
    assertNonEmpty(input.userMessage, "userMessage");
    const scope = normalizeScope(input.ownerId, input.scope);
    const allowedKinds: readonly MemoryKind[] = input.allowedKinds ?? CAPTURE_KINDS;
    const allowedAttributions = new Set<MemoryAttribution>(
      input.allowedAttributions ?? USER_ONLY_ATTRIBUTION,
    );
    const maxCandidates = Math.max(0, Math.floor(input.maxCandidates ?? 5));
    const observationDate = this.#options.now();
    const existingMemories = await this.recall(input.ownerId, {
      scope,
      ...(input.actor ? { actor: input.actor } : {}),
      limit: 20,
      trackAccess: false,
    });
    const candidates = await input.extractor.extract({
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      existingMemories,
      ...(input.knownFacts ? { knownFacts: input.knownFacts } : {}),
      allowedKinds,
      maxCandidates,
      observationDate,
    });
    const allowed = new Set<string>(allowedKinds);

    return this.rememberMany(
      candidates
        .slice(0, maxCandidates)
        .filter((candidate) => {
          const attribution = candidate.attributedTo ?? "user";
          return (
            allowed.has(candidate.kind) &&
            allowedAttributions.has(attribution) &&
            normalizeContent(candidate.content).length > 0
          );
        })
        .map((candidate) => ({
          ownerId: input.ownerId,
          scope,
          ...(input.actor ? { actor: input.actor } : {}),
          kind: candidate.kind,
          content: candidate.content,
          importance: clamp(candidate.importance ?? 0.5),
          confidence: clamp(candidate.confidence ?? 0.7),
          attributedTo: candidate.attributedTo ?? "user",
          ...(input.source ? { source: input.source } : {}),
          ...(candidate.observedAt ? { observedAt: candidate.observedAt } : {}),
          ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
          ...(candidate.validUntil ? { validUntil: candidate.validUntil } : {}),
          ...(candidate.visibleUntil
            ? { visibleUntil: candidate.visibleUntil }
            : {}),
          ...(candidate.metadata ? { metadata: candidate.metadata } : {}),
          ...(candidate.links ? { links: candidate.links } : {}),
        })),
    );
  }

  async cleanup(ownerId: string, options: CleanupOptions = {}): Promise<number> {
    assertNonEmpty(ownerId, "ownerId");
    const now = this.#options.now();
    const scope = normalizeScope(ownerId, options.scope);
    await this.#authorize("cleanup", ownerId, scope, options.actor);
    const weakAfterDays = Math.max(0, options.weakAfterDays ?? 30);
    const query: CleanupQuery = {
      ownerId,
      scope,
      now,
      weakImportance: clamp(options.weakImportance ?? 0.1),
      weakBefore: new Date(now.getTime() - weakAfterDays * 86_400_000),
    };
    return this.#options.store.cleanup(query);
  }

  async forget(
    ownerId: string,
    filters: Omit<ForgetQuery, "ownerId" | "scope"> &
      Pick<MutationOptions, "scope" | "actor"> = {},
  ): Promise<number> {
    assertNonEmpty(ownerId, "ownerId");
    const scope = normalizeScope(ownerId, filters.scope);
    await this.#authorize("forget", ownerId, scope, filters.actor);
    const { actor: _actor, ...storeFilters } = filters;
    return this.#options.store.forget({ ownerId, scope, ...storeFilters });
  }

  #report(error: unknown, operation: string): void {
    this.#options.onError?.(error, operation);
  }
}
