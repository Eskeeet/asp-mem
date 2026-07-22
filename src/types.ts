export const DEFAULT_MEMORY_KINDS = [
  "preference",
  "insight",
  "life_event",
  "pattern",
  "summary",
  "episode",
  "procedure",
] as const;

export type DefaultMemoryKind = (typeof DEFAULT_MEMORY_KINDS)[number];
export type MemoryKind = DefaultMemoryKind | (string & {});

export interface MemoryScope {
  tenantId?: string;
  organizationId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
}

export interface MemoryActor {
  id: string;
  roles?: readonly string[];
}

export type MemoryOperation =
  | "remember"
  | "recall"
  | "revise"
  | "supersede"
  | "retract"
  | "restore"
  | "history"
  | "cleanup"
  | "forget"
  | "consolidate";

export interface MemoryAuthorizationRequest {
  operation: MemoryOperation;
  ownerId: string;
  scope: MemoryScope;
  actor?: MemoryActor;
  memoryId?: string;
}

export interface MemoryAccessPolicy {
  authorize(
    request: MemoryAuthorizationRequest,
  ): boolean | Promise<boolean>;
}

export interface MemorySource {
  type: string;
  id?: string;
  uri?: string;
  checksum?: string;
}

export type MemoryAttribution = "user" | "assistant" | "tool" | "system";
export type MemoryStatus = "active" | "superseded" | "retracted";
export type MemoryLinkType =
  | "related_to"
  | "supports"
  | "updates"
  | "contradicts"
  | (string & {});

export interface MemoryLink {
  memoryId: string;
  type: MemoryLinkType;
}

export interface MemoryAccessStats {
  count: number;
  lastAccessedAt?: Date;
  recentAccesses: readonly Date[];
}

export interface Memory {
  id: string;
  /** Authorization partition. Existing v0.1 callers can keep using this. */
  ownerId: string;
  /** Hierarchical visibility scope within the owner partition. */
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  attributedTo?: MemoryAttribution;
  source?: MemorySource;
  metadata: Readonly<Record<string, unknown>>;
  links: readonly MemoryLink[];
  supersedesId?: string;
  embedding?: readonly number[];
  embeddingModel?: string;
  observedAt: Date;
  validFrom?: Date;
  validUntil?: Date;
  /** Soft visibility cutoff. Hidden records remain addressable and auditable. */
  visibleUntil?: Date;
  /** @deprecated Use visibleUntil. */
  expiresAt?: Date;
  /** Hard deletion cutoff, enforced by cleanup(). */
  purgeAt?: Date;
  access: MemoryAccessStats;
  createdAt: Date;
  updatedAt: Date;
}

export interface RememberInput {
  ownerId: string;
  scope?: MemoryScope;
  actor?: MemoryActor;
  content: string;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  attributedTo?: MemoryAttribution;
  source?: MemorySource;
  metadata?: Readonly<Record<string, unknown>>;
  links?: readonly MemoryLink[];
  supersedesId?: string;
  embeddingModel?: string;
  observedAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
  visibleUntil?: Date;
  /** @deprecated Use visibleUntil. */
  expiresAt?: Date;
  purgeAt?: Date;
}

export interface StoredMemoryInput extends RememberInput {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  importance: number;
  confidence: number;
  metadata: Readonly<Record<string, unknown>>;
  links: readonly MemoryLink[];
  embedding?: readonly number[];
  observedAt: Date;
  visibleUntil?: Date;
  createdAt: Date;
  duplicateConfidenceBoost: number;
}

export interface RememberResult {
  memory: Memory;
  created: boolean;
}

export interface MemoryPatch {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  attributedTo?: MemoryAttribution | null;
  source?: MemorySource | null;
  metadata?: Readonly<Record<string, unknown>>;
  links?: readonly MemoryLink[];
  embedding?: readonly number[] | null;
  embeddingModel?: string | null;
  observedAt?: Date;
  validFrom?: Date | null;
  validUntil?: Date | null;
  visibleUntil?: Date | null;
  purgeAt?: Date | null;
}

export interface StoreRevisionInput {
  ownerId: string;
  scope: MemoryScope;
  memoryId: string;
  patch: MemoryPatch;
  at: Date;
  actor?: MemoryActor;
  reason?: string;
}

export interface StoreSupersedeInput {
  ownerId: string;
  scope: MemoryScope;
  memoryId: string;
  replacement: StoredMemoryInput;
  at: Date;
  actor?: MemoryActor;
  reason?: string;
}

export interface SupersedeResult {
  previous: Memory;
  replacement: Memory;
}

export type MemoryEventAction =
  | "add"
  | "reinforce"
  | "revise"
  | "supersede"
  | "retract"
  | "restore";

export interface MemoryEvent {
  id: string;
  memoryId: string;
  ownerId: string;
  action: MemoryEventAction;
  previous?: Memory;
  next?: Memory;
  actor?: MemoryActor;
  reason?: string;
  createdAt: Date;
}

export interface MemoryGetQuery {
  ownerId: string;
  scope: MemoryScope;
  memoryId: string;
}

export interface MemoryListQuery {
  ownerId: string;
  scope: MemoryScope;
  kinds?: readonly MemoryKind[];
  sourceType?: string;
  sourceId?: string;
  limit: number;
  now: Date;
  referenceTime?: Date;
  includeExpired?: boolean;
  includeInactive?: boolean;
}

export interface RecallWeights {
  semantic: number;
  keyword: number;
  importance: number;
  recency: number;
  temporal: number;
  access: number;
}

export interface MemoryScoreDetails {
  semantic: number;
  keyword: number;
  importance: number;
  recency: number;
  temporal: number;
  access: number;
  accessFactor: number;
  activeWeights: Partial<RecallWeights>;
  fused: number;
  reranker?: number;
}

export interface MemorySearchQuery extends MemoryListQuery {
  queryText: string;
  embedding?: readonly number[];
  weights: RecallWeights;
  minSimilarity?: number;
  minScore?: number;
  explain?: boolean;
  overfetch: number;
}

export interface ScoredMemory extends Memory {
  score: number;
  similarity?: number;
  scoreDetails?: MemoryScoreDetails;
}

export interface CleanupQuery {
  ownerId: string;
  scope: MemoryScope;
  now: Date;
  weakImportance: number;
  weakBefore: Date;
}

export interface ForgetQuery {
  ownerId: string;
  scope: MemoryScope;
  ids?: readonly string[];
  kinds?: readonly MemoryKind[];
  sourceType?: string;
  sourceId?: string;
}

export interface MemoryHistoryQuery {
  ownerId: string;
  scope: MemoryScope;
  memoryId: string;
}

export interface MemoryStore {
  remember(input: StoredMemoryInput): Promise<RememberResult>;
  get(query: MemoryGetQuery): Promise<Memory | null>;
  list(query: MemoryListQuery): Promise<Memory[]>;
  search(query: MemorySearchQuery): Promise<ScoredMemory[]>;
  revise(input: StoreRevisionInput): Promise<Memory>;
  supersede(input: StoreSupersedeInput): Promise<SupersedeResult>;
  history(query: MemoryHistoryQuery): Promise<MemoryEvent[]>;
  recordAccess(ids: readonly string[], at: Date): Promise<void>;
  cleanup(query: CleanupQuery): Promise<number>;
  forget(query: ForgetQuery): Promise<number>;
}

export interface Embedder {
  embed(text: string): Promise<readonly number[]>;
  model?: string;
}

export interface RerankResult {
  memoryId: string;
  score: number;
}

export interface Reranker {
  rerank(input: {
    query: string;
    candidates: readonly ScoredMemory[];
    limit: number;
  }): Promise<readonly RerankResult[]>;
}

export interface RecallOptions {
  scope?: MemoryScope;
  actor?: MemoryActor;
  query?: string;
  kinds?: readonly MemoryKind[];
  sourceType?: string;
  sourceId?: string;
  limit?: number;
  minSimilarity?: number;
  minScore?: number;
  weights?: Partial<RecallWeights>;
  referenceTime?: Date;
  includeExpired?: boolean;
  includeInactive?: boolean;
  trackAccess?: boolean;
  explain?: boolean;
  rerank?: boolean;
  overfetch?: number;
}

export type TokenEstimator = (text: string) => number;

export interface ContextOptions extends RecallOptions {
  maxCharacters?: number;
  maxTokens?: number;
  estimateTokens?: TokenEstimator;
  heading?: string;
  labels?: Readonly<Record<string, string>>;
  includeProvenance?: boolean;
}

export interface AspMemoryOptions {
  store?: MemoryStore;
  embedder?: Embedder;
  reranker?: Reranker;
  accessPolicy?: MemoryAccessPolicy;
  duplicateConfidenceBoost?: number;
  /** @deprecated Use duplicateConfidenceBoost. */
  duplicateBoost?: number;
  defaultWeights?: Partial<RecallWeights>;
  now?: () => Date;
  idFactory?: () => string;
  onError?: (error: unknown, operation: string) => void;
}

export interface CaptureTurnInput {
  ownerId: string;
  scope?: MemoryScope;
  actor?: MemoryActor;
  userMessage: string;
  assistantMessage: string;
  extractor: MemoryExtractor;
  source?: MemorySource;
  knownFacts?: string;
  allowedKinds?: readonly MemoryKind[];
  /** Defaults to user-only attribution. Assistant/tool memories require opt-in. */
  allowedAttributions?: readonly MemoryAttribution[];
  maxCandidates?: number;
}

export interface ExtractionRequest {
  userMessage: string;
  assistantMessage: string;
  existingMemories: readonly Memory[];
  knownFacts?: string;
  allowedKinds: readonly MemoryKind[];
  maxCandidates: number;
  observationDate: Date;
}

export interface ExtractedMemory {
  kind: MemoryKind;
  content: string;
  importance?: number;
  confidence?: number;
  attributedTo?: MemoryAttribution;
  observedAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
  visibleUntil?: Date;
  metadata?: Readonly<Record<string, unknown>>;
  links?: readonly MemoryLink[];
}

export interface MemoryExtractor {
  extract(request: ExtractionRequest): Promise<readonly ExtractedMemory[]>;
}

export type ConsolidationAction =
  | {
      id: string;
      type: "merge";
      memoryIds: readonly string[];
      content: string;
      kind?: MemoryKind;
      reason: string;
    }
  | {
      id: string;
      type: "rewrite";
      memoryId: string;
      content: string;
      reason: string;
    }
  | {
      id: string;
      type: "retract";
      memoryId: string;
      reason: string;
    };

export interface ConsolidationPlan {
  id: string;
  ownerId: string;
  scope: MemoryScope;
  createdAt: Date;
  reviewedMemoryIds: readonly string[];
  actions: readonly ConsolidationAction[];
}

export interface Consolidator {
  plan(input: {
    ownerId: string;
    scope: MemoryScope;
    memories: readonly Memory[];
    now: Date;
  }): Promise<readonly ConsolidationAction[]>;
}

export interface ConsolidationResult {
  plan: ConsolidationPlan;
  appliedActionIds: readonly string[];
  createdMemoryIds: readonly string[];
  revisedMemoryIds: readonly string[];
  dryRun: boolean;
}
