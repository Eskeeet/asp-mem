# Architecture

## The memory loop

```text
user turn ──► agent response ──► fact extractor ──► remember
    ▲                                                │
    │                                                ▼
next prompt ◄── bounded context ◄── recall ◄── MemoryStore
```

Capture belongs off the response-critical path. Recall belongs before prompt assembly and should degrade cleanly when an embedding provider is slow or unavailable.

## What was generalized

The original Aspiritual implementation proved a compact set of useful behaviors:

- typed facts and conversation summaries;
- exact-content deduplication with reinforcement;
- semantic ranking blended with explicit importance;
- importance/recency fallback when embeddings fail;
- small recall boosts for frequently useful records;
- TTL and weak-memory cleanup;
- source IDs for traceability and deletion;
- summaries as a cutoff for long chat histories;
- short-follow-up heuristics that avoid needless embedding latency.

`asp-mem` separates those behaviors from Flutter, Supabase, Gemini, and the source product's domain-specific prompts. Kinds are open strings, providers are interfaces, and the core ships with no runtime dependency.

## Ranking

Stores that implement semantic search use:

```text
score = similarity × (1 - importanceWeight)
      + importance × importanceWeight
```

The default importance weight is `0.3`. Similarity is cosine similarity in the included in-memory and pgvector stores. A store without `search()` automatically uses importance then creation time.

## Deduplication

The in-memory and Supabase stores deduplicate on owner, kind, and whitespace-normalized, case-folded content. A duplicate reinforces the original record instead of creating another row. More advanced near-duplicate detection belongs in the extractor or a custom store because embedding-based merges can destroy legitimately distinct facts.

## Trust boundary

Memory content may contain prompt injection, whether malicious or accidental. `renderMemoryContext()` escapes XML-like markup, applies a hard character budget, and explicitly labels the block as untrusted data. The application must still place its actual instructions outside the block and enforce tool permissions independently of model text.

## Persistence contract

`MemoryStore` is intentionally small:

- `remember` performs an atomic insert-or-reinforce operation;
- `list` ranks by importance and recency;
- optional `search` performs vector recall;
- `boost` reinforces selected records;
- `cleanup` enforces TTL/decay;
- `forget` supports privacy and source-level deletion.

Custom adapters should preserve owner isolation and make `remember` atomic under concurrency.
