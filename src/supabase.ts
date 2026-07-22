import type {
  CleanupQuery,
  ForgetQuery,
  Memory,
  MemoryEvent,
  MemoryHistoryQuery,
  MemoryListQuery,
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

interface SupabaseErrorLike {
  message?: string;
}

interface SupabaseResult<T> {
  data: T;
  error: SupabaseErrorLike | null;
}

interface ClientLike {
  rpc(
    functionName: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<SupabaseResult<unknown>>;
}

export interface SupabaseMemoryStoreOptions {
  rememberRpc?: string;
  getRpc?: string;
  listRpc?: string;
  matchRpc?: string;
  reviseRpc?: string;
  supersedeRpc?: string;
  historyRpc?: string;
  accessRpc?: string;
  cleanupRpc?: string;
  forgetRpc?: string;
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

function optionalDate(value: unknown): Date | undefined {
  return typeof value === "string" ? new Date(value) : undefined;
}

function jsonObject(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function rowToMemory(value: unknown): Memory {
  if (!value || typeof value !== "object") {
    throw new TypeError("Supabase returned an invalid memory row");
  }
  const row = value as Record<string, unknown>;
  const sourceType = typeof row.source_type === "string" ? row.source_type : undefined;
  const embedding = parseVector(row.embedding);
  const observedAt = optionalDate(row.observed_at) ?? new Date(String(row.created_at));
  const visibleUntil = optionalDate(row.visible_until ?? row.expires_at);
  const recentAccesses = Array.isArray(row.recent_accesses)
    ? row.recent_accesses.map((item) => new Date(String(item)))
    : [];
  const links = Array.isArray(row.links)
    ? row.links.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const link = item as Record<string, unknown>;
        return typeof link.memoryId === "string" && typeof link.type === "string"
          ? [{ memoryId: link.memoryId, type: link.type }]
          : [];
      })
    : [];

  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    scope: {
      ...(typeof row.scope_tenant_id === "string"
        ? { tenantId: row.scope_tenant_id }
        : {}),
      ...(typeof row.scope_organization_id === "string"
        ? { organizationId: row.scope_organization_id }
        : {}),
      ...(typeof row.scope_user_id === "string" ? { userId: row.scope_user_id } : {}),
      ...(typeof row.scope_agent_id === "string"
        ? { agentId: row.scope_agent_id }
        : {}),
      ...(typeof row.scope_session_id === "string"
        ? { sessionId: row.scope_session_id }
        : {}),
    },
    kind: String(row.kind),
    content: String(row.content),
    importance: Number(row.importance),
    confidence: Number(row.confidence ?? 0.7),
    status:
      row.status === "superseded" || row.status === "retracted"
        ? row.status
        : "active",
    ...(row.attributed_to === "user" ||
    row.attributed_to === "assistant" ||
    row.attributed_to === "tool" ||
    row.attributed_to === "system"
      ? { attributedTo: row.attributed_to }
      : {}),
    ...(sourceType
      ? {
          source: {
            type: sourceType,
            ...(typeof row.source_id === "string" ? { id: row.source_id } : {}),
            ...(typeof row.source_uri === "string" ? { uri: row.source_uri } : {}),
            ...(typeof row.source_checksum === "string"
              ? { checksum: row.source_checksum }
              : {}),
          },
        }
      : {}),
    metadata: jsonObject(row.metadata),
    links,
    ...(typeof row.supersedes_id === "string"
      ? { supersedesId: row.supersedes_id }
      : {}),
    ...(embedding ? { embedding } : {}),
    ...(typeof row.embedding_model === "string"
      ? { embeddingModel: row.embedding_model }
      : {}),
    observedAt,
    ...(optionalDate(row.valid_from) ? { validFrom: optionalDate(row.valid_from)! } : {}),
    ...(optionalDate(row.valid_until) ? { validUntil: optionalDate(row.valid_until)! } : {}),
    ...(visibleUntil
      ? { visibleUntil, expiresAt: new Date(visibleUntil) }
      : {}),
    ...(optionalDate(row.purge_at) ? { purgeAt: optionalDate(row.purge_at)! } : {}),
    access: {
      count: Number(row.access_count ?? 0),
      ...(optionalDate(row.last_accessed_at)
        ? { lastAccessedAt: optionalDate(row.last_accessed_at)! }
        : {}),
      recentAccesses,
    },
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function eventFromRow(value: unknown): MemoryEvent {
  if (!value || typeof value !== "object") throw new TypeError("Invalid memory event");
  const row = value as Record<string, unknown>;
  const actorRoles = Array.isArray(row.actor_roles)
    ? row.actor_roles.filter((role): role is string => typeof role === "string")
    : undefined;
  return {
    id: String(row.id),
    memoryId: String(row.memory_id),
    ownerId: String(row.owner_id),
    action: row.action as MemoryEvent["action"],
    ...(row.previous_snapshot ? { previous: rowToMemory(row.previous_snapshot) } : {}),
    ...(row.next_snapshot ? { next: rowToMemory(row.next_snapshot) } : {}),
    ...(typeof row.actor_id === "string"
      ? {
          actor: {
            id: row.actor_id,
            ...(actorRoles ? { roles: actorRoles } : {}),
          },
        }
      : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    createdAt: new Date(String(row.created_at)),
  };
}

function scopeParameters(scope: MemoryListQuery["scope"]): Record<string, unknown> {
  return { p_scope: scope };
}

export class SupabaseMemoryStore implements MemoryStore {
  readonly #client: ClientLike;
  readonly #options: Required<SupabaseMemoryStoreOptions>;

  constructor(client: object, options: SupabaseMemoryStoreOptions = {}) {
    this.#client = client as ClientLike;
    this.#options = {
      rememberRpc: options.rememberRpc ?? "remember_asp_memory_v2",
      getRpc: options.getRpc ?? "get_asp_memory_v2",
      listRpc: options.listRpc ?? "list_asp_memories_v2",
      matchRpc: options.matchRpc ?? "match_asp_memories_v2",
      reviseRpc: options.reviseRpc ?? "revise_asp_memory_v2",
      supersedeRpc: options.supersedeRpc ?? "supersede_asp_memory_v2",
      historyRpc: options.historyRpc ?? "history_asp_memory_v2",
      accessRpc: options.accessRpc ?? "record_asp_memory_access_v2",
      cleanupRpc: options.cleanupRpc ?? "cleanup_asp_memories_v2",
      forgetRpc: options.forgetRpc ?? "forget_asp_memories_v2",
    };
  }

  async #rpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.#client.rpc(name, parameters);
    fail(error, name);
    return data;
  }

  async remember(input: StoredMemoryInput): Promise<RememberResult> {
    const data = await this.#rpc(this.#options.rememberRpc, {
      p_memory: {
        id: input.id,
        ownerId: input.ownerId,
        actor: input.actor ?? null,
        scope: input.scope,
        kind: input.kind,
        content: input.content,
        importance: input.importance,
        confidence: input.confidence,
        attributedTo: input.attributedTo ?? null,
        source: input.source ?? null,
        metadata: input.metadata,
        links: input.links,
        supersedesId: input.supersedesId ?? null,
        embedding: input.embedding ?? null,
        embeddingModel: input.embeddingModel ?? null,
        observedAt: input.observedAt.toISOString(),
        validFrom: input.validFrom?.toISOString() ?? null,
        validUntil: input.validUntil?.toISOString() ?? null,
        visibleUntil: input.visibleUntil?.toISOString() ?? null,
        purgeAt: input.purgeAt?.toISOString() ?? null,
        createdAt: input.createdAt.toISOString(),
      },
      p_duplicate_confidence_boost: input.duplicateConfidenceBoost,
    });
    const result = data as { created?: unknown; memory?: unknown } | null;
    if (!result?.memory) throw new Error(`${this.#options.rememberRpc}: missing memory`);
    return { memory: rowToMemory(result.memory), created: result.created === true };
  }

  async get(query: MemoryHistoryQuery): Promise<Memory | null> {
    const data = await this.#rpc(this.#options.getRpc, {
      p_owner_id: query.ownerId,
      p_memory_id: query.memoryId,
      ...scopeParameters(query.scope),
    });
    return data ? rowToMemory(data) : null;
  }

  async list(query: MemoryListQuery): Promise<Memory[]> {
    const data = await this.#rpc(this.#options.listRpc, {
      p_owner_id: query.ownerId,
      ...scopeParameters(query.scope),
      p_match_count: query.limit,
      p_now: query.now.toISOString(),
      p_reference_time: query.referenceTime?.toISOString() ?? null,
      p_include_expired: query.includeExpired ?? false,
      p_include_inactive: query.includeInactive ?? false,
      p_kinds: query.kinds ?? null,
      p_source_type: query.sourceType ?? null,
      p_source_id: query.sourceId ?? null,
    });
    return ((data as unknown[]) ?? []).map(rowToMemory);
  }

  async search(query: MemorySearchQuery): Promise<ScoredMemory[]> {
    const data = await this.#rpc(this.#options.matchRpc, {
      p_owner_id: query.ownerId,
      ...scopeParameters(query.scope),
      p_query_text: query.queryText,
      p_query_embedding: query.embedding ?? null,
      p_weights: query.weights,
      p_match_count: Math.max(query.limit, query.overfetch),
      p_now: query.now.toISOString(),
      p_reference_time: query.referenceTime?.toISOString() ?? null,
      p_include_expired: query.includeExpired ?? false,
      p_include_inactive: query.includeInactive ?? false,
      p_min_similarity: query.minSimilarity ?? -1,
      p_min_score: query.minScore ?? -1,
      p_kinds: query.kinds ?? null,
      p_source_type: query.sourceType ?? null,
      p_source_id: query.sourceId ?? null,
    });
    return ((data as unknown[]) ?? []).map((value): ScoredMemory => {
      const row = value as Record<string, unknown>;
      const memoryRow = row.memory ?? row;
      const details = jsonObject(row.score_details);
      return {
        ...rowToMemory(memoryRow),
        score: Number(row.score),
        ...(typeof row.similarity === "number"
          ? { similarity: row.similarity }
          : {}),
        ...(query.explain && Object.keys(details).length > 0
          ? { scoreDetails: details as unknown as MemoryScoreDetails }
          : {}),
      };
    });
  }

  async revise(input: StoreRevisionInput): Promise<Memory> {
    const data = await this.#rpc(this.#options.reviseRpc, {
      p_owner_id: input.ownerId,
      ...scopeParameters(input.scope),
      p_memory_id: input.memoryId,
      p_patch: input.patch,
      p_at: input.at.toISOString(),
      p_actor: input.actor ?? null,
      p_reason: input.reason ?? null,
    });
    return rowToMemory(data);
  }

  async supersede(input: StoreSupersedeInput): Promise<SupersedeResult> {
    const data = await this.#rpc(this.#options.supersedeRpc, {
      p_owner_id: input.ownerId,
      ...scopeParameters(input.scope),
      p_memory_id: input.memoryId,
      p_replacement: {
        ...input.replacement,
        observedAt: input.replacement.observedAt.toISOString(),
        validFrom: input.replacement.validFrom?.toISOString() ?? null,
        validUntil: input.replacement.validUntil?.toISOString() ?? null,
        visibleUntil: input.replacement.visibleUntil?.toISOString() ?? null,
        purgeAt: input.replacement.purgeAt?.toISOString() ?? null,
        createdAt: input.replacement.createdAt.toISOString(),
      },
      p_at: input.at.toISOString(),
      p_actor: input.actor ?? null,
      p_reason: input.reason ?? null,
    });
    const result = data as { previous?: unknown; replacement?: unknown } | null;
    if (!result?.previous || !result.replacement) {
      throw new Error(`${this.#options.supersedeRpc}: invalid result`);
    }
    return {
      previous: rowToMemory(result.previous),
      replacement: rowToMemory(result.replacement),
    };
  }

  async history(query: MemoryHistoryQuery): Promise<MemoryEvent[]> {
    const data = await this.#rpc(this.#options.historyRpc, {
      p_owner_id: query.ownerId,
      ...scopeParameters(query.scope),
      p_memory_id: query.memoryId,
    });
    return ((data as unknown[]) ?? []).map(eventFromRow);
  }

  async recordAccess(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.#rpc(this.#options.accessRpc, {
      p_ids: ids,
      p_at: at.toISOString(),
    });
  }

  async cleanup(query: CleanupQuery): Promise<number> {
    const data = await this.#rpc(this.#options.cleanupRpc, {
      p_owner_id: query.ownerId,
      ...scopeParameters(query.scope),
      p_now: query.now.toISOString(),
      p_weak_importance: query.weakImportance,
      p_weak_before: query.weakBefore.toISOString(),
    });
    return Number(data ?? 0);
  }

  async forget(query: ForgetQuery): Promise<number> {
    const data = await this.#rpc(this.#options.forgetRpc, {
      p_owner_id: query.ownerId,
      ...scopeParameters(query.scope),
      p_ids: query.ids ?? null,
      p_kinds: query.kinds ?? null,
      p_source_type: query.sourceType ?? null,
      p_source_id: query.sourceId ?? null,
    });
    return Number(data ?? 0);
  }
}

export function createSupabaseMemoryStore(
  client: object,
  options?: SupabaseMemoryStoreOptions,
): SupabaseMemoryStore {
  return new SupabaseMemoryStore(client, options);
}
