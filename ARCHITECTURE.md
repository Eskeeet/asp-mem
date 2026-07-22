# Architecture

## Memory loop

```text
user turn ──► agent response ──► extractor ──► observation store
    ▲                                                │
    │                                                ▼
next prompt ◄── token-bounded context ◄── hybrid recall ◄── current view
                                                        │
                                      history ◄── revisions/consolidation
```

Capture belongs off the response-critical path. Recall belongs before prompt assembly and must degrade cleanly when an embedding or reranking provider is unavailable.

## Core invariants

1. **Observations are traceable.** Records carry observation time, optional validity, attribution, source, metadata, and links. Every mutation appends before/after snapshots to history.
2. **Current truth is derived.** Active records form the current view. Supersession closes the previous validity interval and creates a linked replacement. Historical recall can reconstruct what was valid at a reference time.
3. **Visibility is not deletion.** `visibleUntil` hides a record; `purgeAt`, weak cleanup, or explicit `forget` deletes it. Privacy deletion also removes its event history.
4. **Importance is explicit.** Deduplication reinforces confidence. Retrieval writes access statistics. Neither silently changes importance.
5. **Scope narrows downward.** A query can see a record only when every scope field declared by that record matches. Narrow session facts therefore never leak into a broader user-only query.
6. **Model maintenance is reviewable.** Consolidation planning is read-only and dry-run by default. Applying a plan is explicit and auditable.

## Components

- `AspMemory` owns authorization, capture, recall, temporal mutation, lifecycle, and provider fallback.
- `MemoryStore` owns persistence, atomic deduplication, history, scoped filtering, and first-stage ranking.
- `Embedder` owns vector generation and model identity.
- `Reranker` optionally owns second-stage ranking.
- `MemoryExtractor` owns model-assisted observation extraction.
- `Consolidator` proposes bounded maintenance actions.
- `renderMemoryContext` owns redundant-free, token-bounded, prompt-safe formatting.
- `evaluateMemory` measures behavior and operational cost across application-defined fixtures.

## Hybrid ranking

The default first-stage weights are:

| Signal | Weight | Meaning |
|---|---:|---|
| semantic | 0.50 | normalized cosine similarity, when both vectors exist |
| keyword | 0.20 | BM25-style lexical relevance / PostgreSQL FTS |
| importance | 0.10 | application- or user-assigned salience |
| temporal | 0.10 | fit to the requested reference time |
| recency | 0.05 | 90-day half-life over last meaningful update |
| access | 0.05 | bounded frequency/recency utility |

Unavailable signals are removed and remaining weights are renormalized. This is why lexical recall continues to work without an embedding provider. A per-result `scoreDetails` object records components, active weights, fused score, access factor, and optional reranker score.

The bounded access factor is derived from a 30-day access-recency half-life and a saturating frequency term:

```text
factor = clamp(0.3 + 0.7 × access_recency + 0.5 × saturated_frequency, 0.3, 1.5)
```

It is normalized into the fused access component. It never writes to importance.

## Temporal model

`observedAt` says when the observation was recorded. `validFrom` and `validUntil` describe when its claim applies. They are intentionally separate: an agent may learn today that a preference changed last month.

Default recall returns only active, currently valid, visible records. With `referenceTime`, a superseded record is eligible when its interval contains that time. Retracted records require `includeInactive`; soft-expired records require `includeExpired`.

## Deduplication and provenance

Exact deduplication keys include owner, the full declared scope, kind, and normalized/case-folded content. A duplicate raises confidence by a bounded amount and records a `reinforce` event. Near-duplicate merging is not automatic because semantic similarity can erase legitimately distinct or time-varying facts; it belongs in an explicit consolidation plan.

History events contain immutable before/after snapshots. The active row is mutable for operational efficiency, while the event stream preserves the evidence needed for audit and reconstruction.

## Context assembly

Retrieved records are selected round-robin across kinds, exact and high-overlap duplicates are dropped, and every candidate is checked against both character and estimated-token budgets. The output escapes markup and labels memory as untrusted data. This prevents memory text from being confused with the enclosing prompt format, but tool authorization and system policy must remain outside model-controlled text.

## Persistence

The in-memory store is the reference semantics and test implementation. The Supabase adapter maps the same contract onto pgvector, PostgreSQL full-text search, RLS, scoped unique keys, temporal filters, event history, and atomic RPCs.

Custom adapters must make `remember` and `supersede` atomic under concurrency, enforce owner/scope isolation on every read and write, preserve event order, and keep hard deletion comprehensive.
