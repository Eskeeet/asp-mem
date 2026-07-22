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

interface SupabaseErrorLike {
  message?: string;
}

interface SupabaseResult<T> {
  data: T;
  error: SupabaseErrorLike | null;
}

interface QueryLike<T = unknown> extends PromiseLike<SupabaseResult<T>> {
  select(columns?: string): QueryLike<unknown>;
  delete(): QueryLike<unknown>;
  eq(column: string, value: unknown): QueryLike<T>;
  in(column: string, values: readonly unknown[]): QueryLike<T>;
  or(filters: string): QueryLike<T>;
  order(column: string, options?: { ascending?: boolean }): QueryLike<T>;
  limit(count: number): QueryLike<T>;
}

interface ClientLike {
  from(table: string): QueryLike;
  rpc(functionName: string, parameters: Record<string, unknown>): PromiseLike<SupabaseResult<unknown>>;
}

export interface SupabaseMemoryStoreOptions {
  table?: string;
  rememberRpc?: string;
  matchRpc?: string;
  boostRpc?: string;
  cleanupRpc?: string;
}

function fail(error: SupabaseErrorLike | null, operation: string): void {
  if (error) throw new Error(`${operation}: ${error.message ?? "Supabase request failed"}`);
}

function parseVector(value: unknown): readonly number[] | undefined {
  if (Array.isArray(value)) {
    const values = value.filter((item): item is number => typeof item === "number");
    return values.length === value.length ? values : undefined;
  }
  if (typeof value !== "string") return undefined;
  const parsed = value
    .replace(/^\[|\]$/gu, "")
    .split(",")
    .filter(Boolean)
    .map(Number);
  return parsed.every(Number.isFinite) ? parsed : undefined;
}

function rowToMemory(value: unknown): Memory {
  if (!value || typeof value !== "object") {
    throw new TypeError("Supabase returned an invalid memory row");
  }
  const row = value as Record<string, unknown>;
  const sourceType = typeof row.source_type === "string" ? row.source_type : undefined;
  const sourceId = typeof row.source_id === "string" ? row.source_id : undefined;
  const embedding = parseVector(row.embedding);
  const expiresAt = typeof row.expires_at === "string" ? new Date(row.expires_at) : undefined;

  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    kind: String(row.kind),
    content: String(row.content),
    importance: Number(row.importance),
    ...(sourceType ? { source: { type: sourceType, ...(sourceId ? { id: sourceId } : {}) } } : {}),
    ...(embedding ? { embedding } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

export class SupabaseMemoryStore implements MemoryStore {
  readonly #client: ClientLike;
  readonly #options: Required<SupabaseMemoryStoreOptions>;

  constructor(client: object, options: SupabaseMemoryStoreOptions = {}) {
    this.#client = client as ClientLike;
    this.#options = {
      table: options.table ?? "asp_memories",
      rememberRpc: options.rememberRpc ?? "remember_asp_memory",
      matchRpc: options.matchRpc ?? "match_asp_memories",
      boostRpc: options.boostRpc ?? "boost_asp_memories",
      cleanupRpc: options.cleanupRpc ?? "cleanup_asp_memories",
    };
  }

  async remember(input: StoredMemoryInput): Promise<RememberResult> {
    const { data, error } = await this.#client.rpc(this.#options.rememberRpc, {
      p_id: input.id,
      p_owner_id: input.ownerId,
      p_kind: input.kind,
      p_content: input.content,
      p_importance: input.importance,
      p_source_type: input.source?.type ?? null,
      p_source_id: input.source?.id ?? null,
      p_embedding: input.embedding ?? null,
      p_expires_at: input.expiresAt?.toISOString() ?? null,
      p_duplicate_boost: input.duplicateBoost,
    });
    fail(error, this.#options.rememberRpc);
    const result = data as { created?: unknown; memory?: unknown } | null;
    if (!result?.memory) throw new Error(`${this.#options.rememberRpc}: missing memory`);
    return { memory: rowToMemory(result.memory), created: result.created === true };
  }

  async list(query: MemoryListQuery): Promise<Memory[]> {
    let request = this.#client
      .from(this.#options.table)
      .select("*")
      .eq("owner_id", query.ownerId)
      .or(`expires_at.is.null,expires_at.gt.${query.now.toISOString()}`)
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(query.limit);
    if (query.kinds) request = request.in("kind", query.kinds);
    if (query.sourceType) request = request.eq("source_type", query.sourceType);
    if (query.sourceId) request = request.eq("source_id", query.sourceId);

    const { data, error } = await request;
    fail(error, "list asp memories");
    return ((data as unknown[]) ?? []).map(rowToMemory);
  }

  async search(query: MemorySearchQuery): Promise<ScoredMemory[]> {
    const { data, error } = await this.#client.rpc(this.#options.matchRpc, {
      p_owner_id: query.ownerId,
      p_query_embedding: query.embedding,
      p_match_count: query.limit,
      p_importance_weight: query.importanceWeight,
      p_min_similarity: query.minSimilarity ?? -1,
      p_kinds: query.kinds ?? null,
      p_source_type: query.sourceType ?? null,
      p_source_id: query.sourceId ?? null,
    });
    fail(error, this.#options.matchRpc);
    return ((data as unknown[]) ?? []).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        ...rowToMemory(record),
        score: Number(record.score),
        similarity: Number(record.similarity),
      };
    });
  }

  async boost(ids: readonly string[], amount: number): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.#client.rpc(this.#options.boostRpc, {
      p_ids: ids,
      p_amount: amount,
    });
    fail(error, this.#options.boostRpc);
  }

  async cleanup(query: CleanupQuery): Promise<number> {
    const { data, error } = await this.#client.rpc(this.#options.cleanupRpc, {
      p_owner_id: query.ownerId,
      p_now: query.now.toISOString(),
      p_weak_importance: query.weakImportance,
      p_weak_before: query.weakBefore.toISOString(),
    });
    fail(error, this.#options.cleanupRpc);
    return Number(data ?? 0);
  }

  async forget(query: ForgetQuery): Promise<number> {
    let request = this.#client
      .from(this.#options.table)
      .delete()
      .eq("owner_id", query.ownerId);
    if (query.ids) request = request.in("id", query.ids);
    if (query.kinds) request = request.in("kind", query.kinds);
    if (query.sourceType) request = request.eq("source_type", query.sourceType);
    if (query.sourceId) request = request.eq("source_id", query.sourceId);

    const { data, error } = await request.select("id");
    fail(error, "forget asp memories");
    return ((data as unknown[]) ?? []).length;
  }
}

export function createSupabaseMemoryStore(
  client: object,
  options?: SupabaseMemoryStoreOptions,
): SupabaseMemoryStore {
  return new SupabaseMemoryStore(client, options);
}
