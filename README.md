# asp-mem

Lightweight, provider-agnostic long-term memory for conversational agents.

`asp-mem` provides a small memory loop without choosing your model, embedding provider, agent framework, or database. Version 0.2 adds the practices that matter most in current memory systems: temporal observations, auditable revision history, hierarchical scopes, hybrid retrieval, bounded access decay, explicit consolidation, token-aware context, and a reusable evaluation harness.

The core has no runtime dependencies and runs in Node.js and modern browsers. An in-memory store is included for prototypes and tests; a Supabase + pgvector adapter is available for persistence.

## What it does

- Stores observations with confidence, attribution, provenance, validity intervals, visibility, and purge dates.
- Preserves updates as superseded records with immutable event snapshots.
- Isolates memory by owner and optional tenant, organization, user, agent, and session scopes.
- Fuses semantic similarity, BM25-style lexical relevance, importance, recency, temporal fit, and bounded access utility.
- Explains every ranking component and supports an optional second-stage reranker.
- Builds prompt-safe context under character and token budgets while removing redundancy and preserving kind diversity.
- Plans consolidation as a reviewable dry-run before any merge, rewrite, or retraction is applied.
- Evaluates recall, updates, temporal behavior, contradictions, abstention, latency, and token cost.

## Status

Early `0.2.x` API. The package builds and packs from source; npm publication is a separate release step.

## Quick start

```bash
pnpm add asp-mem
```

```ts
import { AspMemory } from "asp-mem";

const memory = new AspMemory();

await memory.remember({
  ownerId: "user-123",
  kind: "preference",
  content: "Prefers direct, concise answers.",
  importance: 0.7,
  confidence: 0.95,
  attributedTo: "user",
  source: { type: "chat", id: "turn-42" },
});

const relevant = await memory.recall("user-123", {
  query: "How should I answer?",
  explain: true,
});

const memoryContext = await memory.context("user-123", {
  query: "How should I answer?",
  maxTokens: 600,
});
```

The default store is ephemeral. Use a persistent `MemoryStore` in production.

## Temporal updates and history

An update creates a replacement observation and closes the previous record's validity interval:

```ts
const original = await memory.remember({
  ownerId: "user-123",
  content: "Prefers tea.",
  validFrom: new Date("2025-01-01"),
});

await memory.supersede(
  "user-123",
  original.memory.id,
  { content: "Prefers coffee." },
  { reason: "The user explicitly changed their preference." },
);

// Current view: coffee.
await memory.recall("user-123");

// Historical view: tea.
await memory.recall("user-123", {
  referenceTime: new Date("2025-06-01"),
});

const events = await memory.history("user-123", original.memory.id);
```

`retract()` hides an invalid observation without deleting its history; `restore()` reverses that status. `forget()` is the explicit privacy deletion path and removes the selected records and their event history.

## Scopes and access policies

A memory declares the narrowest scope in which it is valid. A session query sees matching session memories plus broader agent/user memories; a user-only query cannot see session-specific records.

```ts
await memory.remember({
  ownerId: "user-123",
  scope: { organizationId: "org-1", agentId: "coach", sessionId: "chat-7" },
  content: "This session is about marathon planning.",
});

await memory.recall("user-123", {
  scope: { organizationId: "org-1", agentId: "coach", sessionId: "chat-7" },
});
```

`ownerId` remains the required authorization partition. For application-specific permissions, provide an access policy:

```ts
const memory = new AspMemory({
  accessPolicy: {
    authorize: async ({ operation, ownerId, scope, actor }) =>
      canAccessMemory({ operation, ownerId, scope, actor }),
  },
});
```

Server-side service roles can bypass database RLS, so authorization must also live at your service boundary.

## Hybrid and explainable recall

An embedder is optional:

```ts
const memory = new AspMemory({
  embedder: {
    model: "your-embedding-model",
    embed: async (text) => embedWithYourProvider(text),
  },
  reranker: {
    rerank: async ({ query, candidates, limit }) =>
      rerankWithYourProvider(query, candidates, limit),
  },
});
```

When vectors are available, recall fuses semantic and lexical evidence. Without an embedder—or when it fails—lexical, importance, recency, temporal, and access signals still work. Weights are configurable per instance or call:

```ts
const results = await memory.recall("user-123", {
  query: "marathon training",
  weights: { semantic: 0.45, keyword: 0.3 },
  minScore: 0.35,
  explain: true,
});

console.log(results[0]?.scoreDetails);
```

Access frequency and recency affect ranking through a bounded factor from `0.3` to `1.5`. Retrieval never permanently increases explicit importance.

## Capture facts with any model

```ts
import { createJsonExtractor } from "asp-mem";

const extractor = createJsonExtractor(async (prompt) => callYourModel(prompt));

void memory.captureTurn({
  ownerId: "user-123",
  userMessage: "I am training for my first marathon in October.",
  assistantMessage: "Let's make a gradual training plan.",
  extractor,
  source: { type: "chat", id: "conversation-456" },
}).catch(console.error);
```

Capture defaults to user-attributed facts only. Assistant or tool observations require an explicit `allowedAttributions` opt-in. The prompt resolves relative dates against an observation timestamp and rejects assistant guesses, secrets, and known duplicates. Add domain filters before `remember()` for high-risk use cases.

## Token-aware context

```ts
const context = await memory.context("user-123", {
  query: "What matters for this plan?",
  maxTokens: 800,
  estimateTokens: text => tokenizer.encode(text).length,
  includeProvenance: true,
});
```

The default estimator is conservative and dependency-free. Context is escaped, labelled as untrusted data, deduplicated, and selected across memory kinds. Prompt formatting is a defense-in-depth measure, not an authorization boundary.

## Reviewable consolidation

```ts
import { applyConsolidation, createJsonConsolidator, planConsolidation } from "asp-mem";

const consolidator = createJsonConsolidator(prompt => callYourModel(prompt));
const plan = await planConsolidation(memory, "user-123", consolidator);

// Inspect plan.actions, then explicitly apply all or selected actions.
const result = await applyConsolidation(memory, plan, {
  actionIds: plan.actions.map(action => action.id),
});
```

`consolidate()` is dry-run by default. Applied merges and rewrites preserve the old records as superseded observations and append history events.

## Evaluation harness

```ts
import { evaluateMemory } from "asp-mem";

const report = await evaluateMemory(memory, [{
  name: "recalls changed preference",
  category: "knowledge_update",
  ownerId: "evaluation-user",
  prepare: async instance => {
    await instance.remember({ ownerId: "evaluation-user", content: "Prefers coffee." });
  },
  query: "drink preference",
  expectedContents: ["Prefers coffee."],
  recall: { limit: 3, minScore: 0.25 },
}]);
```

The report includes recall@k, precision@k, mean reciprocal rank, abstention accuracy, p50/p95 latency, estimated tokens, per-case evidence, and metrics grouped by category.

## Supabase + pgvector

Apply both migrations in order:

1. [`supabase/001_asp_mem.sql`](supabase/001_asp_mem.sql)
2. [`supabase/002_temporal_hybrid_memory.sql`](supabase/002_temporal_hybrid_memory.sql)

Then pass your existing Supabase client:

```ts
import { createClient } from "@supabase/supabase-js";
import { AspMemory } from "asp-mem";
import { createSupabaseMemoryStore } from "asp-mem/supabase";

const supabase = createClient(url, anonKey);
const memory = new AspMemory({
  store: createSupabaseMemoryStore(supabase),
  embedder: { embed: embedWithYourProvider },
});
```

The reference schema uses 768-dimensional vectors and authenticated-user RLS. Change every `vector(768)` occurrence in both migrations before applying them if your provider uses another dimension. Migration 002 adds PostgreSQL full-text search, temporal/current views, scoped deduplication, access statistics, history, and v2 RPCs.

## Lifecycle and retention

```ts
await memory.remember({
  ownerId: "user-123",
  content: "Traveling in Tokyo this week.",
  visibleUntil: new Date("2026-08-01"), // soft hide
  purgeAt: new Date("2026-09-01"),      // hard-delete during cleanup
});

await memory.cleanup("user-123");
await memory.forget("user-123", { sourceId: "conversation-456" });
```

`visibleUntil` controls recall without destroying evidence. `purgeAt` controls hard retention. The deprecated `expiresAt` input remains a soft-visibility alias.

## Migrating from 0.1

- Custom `MemoryStore` adapters must implement `get`, `revise`, `supersede`, `history`, and `recordAccess`, and accept the expanded query types.
- Apply migration 002 and use the default v2 RPC names in `createSupabaseMemoryStore()`.
- Duplicate observations now reinforce `confidence`, not `importance`.
- Recall access no longer mutates importance. The old `recallBoost`, call-level `boost`, and `importanceWeight` options are replaced by `trackAccess` and `weights`.
- Expiration is soft visibility. Set `purgeAt` when cleanup should hard-delete a record.
- `duplicateBoost` still works as a deprecated alias for `duplicateConfidenceBoost`.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for invariants and ranking details, and [`SECURITY.md`](SECURITY.md) before using personal data in production.

## Development

```bash
pnpm install
pnpm check
pnpm pack --dry-run
```

The SQL smoke test in [`test/supabase-smoke.sql`](test/supabase-smoke.sql) runs after migrations 001 and 002 in a PostgreSQL 16 database with pgvector.

## Origin

This library is a provider-neutral extraction and rewrite of the memory design first used in the private Aspiritual conversational app. App-specific Flutter UI, prompts, spiritual-reading logic, credentials, and product data are intentionally excluded.

## License

MIT © Aspiritual
