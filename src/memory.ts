import { renderMemoryContext } from "./context.js";
import { InMemoryStore } from "./in-memory-store.js";
import type {
  AspMemoryOptions,
  CaptureTurnInput,
  CleanupQuery,
  ContextOptions,
  ForgetQuery,
  Memory,
  MemoryKind,
  MemoryListQuery,
  MemorySearchQuery,
  RecallOptions,
  RememberInput,
  RememberResult,
} from "./types.js";
import {
  assertNonEmpty,
  clamp,
  defaultIdFactory,
  normalizeContent,
} from "./utils.js";

const CAPTURE_KINDS = ["preference", "insight", "life_event", "pattern"] as const;

export class AspMemory {
  readonly #options: Required<
    Pick<AspMemoryOptions, "duplicateBoost" | "recallBoost" | "now" | "idFactory">
  > &
    Omit<AspMemoryOptions, "duplicateBoost" | "recallBoost" | "now" | "idFactory">;

  constructor(options: AspMemoryOptions = {}) {
    this.#options = {
      ...options,
      store: options.store ?? new InMemoryStore(),
      duplicateBoost: clamp(options.duplicateBoost ?? 0.1),
      recallBoost: clamp(options.recallBoost ?? 0.01),
      now: options.now ?? (() => new Date()),
      idFactory: options.idFactory ?? defaultIdFactory,
    };
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    assertNonEmpty(input.ownerId, "ownerId");
    assertNonEmpty(input.content, "content");
    const content = normalizeContent(input.content);
    const now = this.#options.now();
    let embedding: readonly number[] | undefined;

    if (this.#options.embedder) {
      try {
        const candidate = await this.#options.embedder.embed(content);
        if (candidate.length > 0 && candidate.every(Number.isFinite)) {
          embedding = candidate;
        }
      } catch (error) {
        this.#report(error, "embed:remember");
      }
    }

    return this.#options.store!.remember({
      ...input,
      id: this.#options.idFactory(),
      content,
      kind: input.kind ?? "insight",
      importance: clamp(input.importance ?? 0.5),
      ...(embedding ? { embedding } : {}),
      createdAt: now,
      duplicateBoost: this.#options.duplicateBoost,
    });
  }

  async rememberMany(inputs: readonly RememberInput[]): Promise<RememberResult[]> {
    const results: RememberResult[] = [];
    for (const input of inputs) {
      results.push(await this.remember(input));
    }
    return results;
  }

  async recall(ownerId: string, options: RecallOptions = {}): Promise<Memory[]> {
    assertNonEmpty(ownerId, "ownerId");
    const now = this.#options.now();
    const limit = Math.max(1, Math.floor(options.limit ?? 8));
    const listQuery: MemoryListQuery = {
      ownerId,
      limit,
      now,
      ...(options.kinds ? { kinds: options.kinds } : {}),
      ...(options.sourceType ? { sourceType: options.sourceType } : {}),
      ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    };
    let memories: Memory[] = [];

    if (
      options.query?.trim() &&
      this.#options.embedder &&
      this.#options.store!.search
    ) {
      try {
        const embedding = await this.#options.embedder.embed(options.query.trim());
        const searchQuery: MemorySearchQuery = {
          ...listQuery,
          embedding,
          importanceWeight: clamp(options.importanceWeight ?? 0.3),
          ...(options.minSimilarity !== undefined
            ? { minSimilarity: options.minSimilarity }
            : {}),
        };
        memories = await this.#options.store!.search(searchQuery);
      } catch (error) {
        this.#report(error, "embed:recall");
      }
    }

    if (memories.length === 0) {
      memories = await this.#options.store!.list(listQuery);
    }

    if ((options.boost ?? true) && this.#options.recallBoost > 0) {
      try {
        await this.#options.store!.boost(
          memories.map((memory) => memory.id),
          this.#options.recallBoost,
        );
      } catch (error) {
        this.#report(error, "boost:recall");
      }
    }

    return memories;
  }

  async context(ownerId: string, options: ContextOptions = {}): Promise<string> {
    const memories = await this.recall(ownerId, options);
    return renderMemoryContext(memories, options);
  }

  async captureTurn(input: CaptureTurnInput): Promise<RememberResult[]> {
    assertNonEmpty(input.ownerId, "ownerId");
    assertNonEmpty(input.userMessage, "userMessage");
    const allowedKinds: readonly MemoryKind[] = input.allowedKinds ?? CAPTURE_KINDS;
    const maxCandidates = Math.max(0, Math.floor(input.maxCandidates ?? 5));
    const existingMemories = await this.recall(input.ownerId, {
      limit: 20,
      boost: false,
    });
    const candidates = await input.extractor.extract({
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      existingMemories,
      ...(input.knownFacts ? { knownFacts: input.knownFacts } : {}),
      allowedKinds,
      maxCandidates,
    });
    const allowed = new Set<string>(allowedKinds);

    return this.rememberMany(
      candidates
        .slice(0, maxCandidates)
        .filter(
          (candidate) =>
            allowed.has(candidate.kind) && normalizeContent(candidate.content).length > 0,
        )
        .map((candidate) => ({
          ownerId: input.ownerId,
          kind: candidate.kind,
          content: candidate.content,
          importance: clamp(candidate.importance ?? 0.5),
          ...(input.source ? { source: input.source } : {}),
          ...(candidate.expiresAt ? { expiresAt: candidate.expiresAt } : {}),
        })),
    );
  }

  async cleanup(
    ownerId: string,
    options: { weakImportance?: number; weakAfterDays?: number } = {},
  ): Promise<number> {
    assertNonEmpty(ownerId, "ownerId");
    const now = this.#options.now();
    const weakAfterDays = Math.max(0, options.weakAfterDays ?? 30);
    const query: CleanupQuery = {
      ownerId,
      now,
      weakImportance: clamp(options.weakImportance ?? 0.1),
      weakBefore: new Date(now.getTime() - weakAfterDays * 86_400_000),
    };
    return this.#options.store!.cleanup(query);
  }

  async forget(ownerId: string, filters: Omit<ForgetQuery, "ownerId"> = {}): Promise<number> {
    assertNonEmpty(ownerId, "ownerId");
    return this.#options.store!.forget({ ownerId, ...filters });
  }

  #report(error: unknown, operation: string): void {
    this.#options.onError?.(error, operation);
  }
}
