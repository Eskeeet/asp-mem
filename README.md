# asp-mem

Lightweight long-term memory for conversational agents.

`asp-mem` keeps the useful memory loop small and explicit:

1. extract durable facts after a turn;
2. deduplicate and reinforce them;
3. recall by semantic relevance plus importance;
4. inject them into the next prompt as clearly marked, untrusted data;
5. expire, decay, export, or delete them on your terms.

The core has no runtime dependencies and no model, vector database, or agent-framework lock-in. It runs in Node.js and modern browsers. An in-memory store is included for prototyping, with an optional Supabase + pgvector adapter for persistence.

## Status

Early `0.1.x` API. The package is ready to build and pack from source; npm publication is a separate release step.

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
});

const memoryContext = await memory.context("user-123");

const messages = [
  { role: "system", content: `You are a helpful assistant.\n\n${memoryContext}` },
  { role: "user", content: "Help me plan my week." },
];
```

The default store is intentionally ephemeral. Use a persistent `MemoryStore` in production.

## Capture facts with any model

Bring a function that accepts a prompt and returns model text:

```ts
import { AspMemory, createJsonExtractor } from "asp-mem";

const extractor = createJsonExtractor(async (prompt) => {
  // OpenAI, Anthropic, Gemini, a local model, or your own endpoint.
  return callYourModel(prompt);
});

const memory = new AspMemory();

// Run after the response is sent; memory capture should not add chat latency.
void memory.captureTurn({
  ownerId: "user-123",
  userMessage: "I am training for my first marathon in October.",
  assistantMessage: "Let's make a gradual training plan.",
  extractor,
  source: { type: "chat", id: "conversation-456" },
}).catch(console.error);
```

The built-in extraction prompt tells the model to retain only facts the user explicitly shared, reject assistant-generated guesses, skip known duplicates, and return validated JSON. For high-risk domains, add application-specific filters before calling `remember`.

## Add semantic recall

An embedder is a single method:

```ts
const memory = new AspMemory({
  embedder: {
    embed: async (text) => embedWithYourProvider(text),
  },
});

const relevant = await memory.recall("user-123", {
  query: "What should I consider for this training plan?",
  limit: 6,
  importanceWeight: 0.3,
});
```

Semantic recall is best-effort. If embedding or vector search fails, `asp-mem` falls back to importance and recency. `shouldUseSemanticRecall()` can skip the embedding round-trip for tiny follow-ups such as “yes”.

## Supabase + pgvector

Apply [`supabase/001_asp_mem.sql`](supabase/001_asp_mem.sql), then pass your existing Supabase client:

```ts
import { createClient } from "@supabase/supabase-js";
import { AspMemory } from "asp-mem";
import { createSupabaseMemoryStore } from "asp-mem/supabase";

const supabase = createClient(url, anonKey);
const store = createSupabaseMemoryStore(supabase);

const memory = new AspMemory({
  store,
  embedder: { embed: embedWithYourProvider },
});
```

The reference migration uses 768-dimensional vectors and user-scoped row-level security. Change every `vector(768)` occurrence before applying it if your embedding provider uses a different size. Server-side service-role clients bypass RLS, so keep tenant checks in your own service boundary.

## Lifecycle and user control

```ts
// Optional TTL when storing ephemeral facts.
await memory.remember({
  ownerId: "user-123",
  content: "Traveling in Tokyo this week.",
  kind: "life_event",
  expiresAt: new Date("2026-08-01T00:00:00Z"),
});

// Remove expired records and records below 0.1 importance after 30 days.
await memory.cleanup("user-123");

// Delete a conversation's derived memories, selected kinds, selected IDs,
// or every memory owned by the user.
await memory.forget("user-123", { sourceId: "conversation-456" });
```

Retrieved memories receive a small importance boost by default. Disable that for read-only surfaces with `{ boost: false }`, or globally with `recallBoost: 0`.

## Design boundaries

- `AspMemory` owns the capture/recall/lifecycle policy.
- `MemoryStore` owns persistence and atomic deduplication.
- `Embedder` owns vector generation.
- `MemoryExtractor` owns model-based fact extraction.
- `renderMemoryContext` owns bounded, prompt-safe formatting.

This separation keeps the package useful with a plain `Map`, pgvector, or a custom database. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full pipeline and tradeoffs.

## Privacy and safety

Long-term memory often contains personal data. Obtain user consent, minimize what you store, set retention rules, and make deletion discoverable. Never treat recalled text as trusted instructions; the default renderer escapes markup and labels records as untrusted data. See [`SECURITY.md`](SECURITY.md).

## Development

```bash
pnpm install
pnpm check
pnpm pack --dry-run
```

Requires Node.js 20 or newer.

## Origin

This library is a provider-neutral extraction and rewrite of the memory design first used in the private Aspiritual conversational app. App-specific Flutter UI, prompts, spiritual-reading logic, credentials, and product data are intentionally excluded.

## License

MIT © Aspiritual
