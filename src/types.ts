export const DEFAULT_MEMORY_KINDS = [
  "preference",
  "insight",
  "life_event",
  "pattern",
  "summary",
] as const;

export type DefaultMemoryKind = (typeof DEFAULT_MEMORY_KINDS)[number];
export type MemoryKind = DefaultMemoryKind | (string & {});

export interface MemorySource {
  type: string;
  id?: string;
}

export interface Memory {
  id: string;
  ownerId: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  source?: MemorySource;
  embedding?: readonly number[];
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RememberInput {
  ownerId: string;
  content: string;
  kind?: MemoryKind;
  importance?: number;
  source?: MemorySource;
  expiresAt?: Date;
}

export interface StoredMemoryInput extends RememberInput {
  id: string;
  kind: MemoryKind;
  importance: number;
  embedding?: readonly number[];
  createdAt: Date;
  duplicateBoost: number;
}

export interface RememberResult {
  memory: Memory;
  created: boolean;
}

export interface MemoryListQuery {
  ownerId: string;
  kinds?: readonly MemoryKind[];
  sourceType?: string;
  sourceId?: string;
  limit: number;
  now: Date;
}

export interface MemorySearchQuery extends MemoryListQuery {
  embedding: readonly number[];
  importanceWeight: number;
  minSimilarity?: number;
}

export interface ScoredMemory extends Memory {
  score: number;
  similarity?: number;
}

export interface CleanupQuery {
  ownerId: string;
  now: Date;
  weakImportance: number;
  weakBefore: Date;
}

export interface ForgetQuery {
  ownerId: string;
  ids?: readonly string[];
  kinds?: readonly MemoryKind[];
  sourceType?: string;
  sourceId?: string;
}

export interface MemoryStore {
  remember(input: StoredMemoryInput): Promise<RememberResult>;
  list(query: MemoryListQuery): Promise<Memory[]>;
  search?(query: MemorySearchQuery): Promise<ScoredMemory[]>;
  boost(ids: readonly string[], amount: number): Promise<void>;
  cleanup(query: CleanupQuery): Promise<number>;
  forget(query: ForgetQuery): Promise<number>;
}

export interface Embedder {
  embed(text: string): Promise<readonly number[]>;
}

export interface RecallOptions {
  query?: string;
  kinds?: readonly MemoryKind[];
  sourceType?: string;
  sourceId?: string;
  limit?: number;
  importanceWeight?: number;
  minSimilarity?: number;
  boost?: boolean;
}

export interface ContextOptions extends RecallOptions {
  maxCharacters?: number;
  heading?: string;
  labels?: Readonly<Record<string, string>>;
}

export interface AspMemoryOptions {
  store?: MemoryStore;
  embedder?: Embedder;
  duplicateBoost?: number;
  recallBoost?: number;
  now?: () => Date;
  idFactory?: () => string;
  onError?: (error: unknown, operation: string) => void;
}

export interface CaptureTurnInput {
  ownerId: string;
  userMessage: string;
  assistantMessage: string;
  extractor: MemoryExtractor;
  source?: MemorySource;
  knownFacts?: string;
  allowedKinds?: readonly MemoryKind[];
  maxCandidates?: number;
}

export interface ExtractionRequest {
  userMessage: string;
  assistantMessage: string;
  existingMemories: readonly Memory[];
  knownFacts?: string;
  allowedKinds: readonly MemoryKind[];
  maxCandidates: number;
}

export interface ExtractedMemory {
  kind: MemoryKind;
  content: string;
  importance?: number;
  expiresAt?: Date;
}

export interface MemoryExtractor {
  extract(request: ExtractionRequest): Promise<readonly ExtractedMemory[]>;
}
