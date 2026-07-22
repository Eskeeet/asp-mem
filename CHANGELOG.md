# Changelog

All notable changes to this project will be documented here.

## 0.2.0 - 2026-07-22

- Add temporal observations, current/historical recall, supersession, retraction, restoration, and immutable before/after history.
- Add tenant, organization, user, agent, and session scopes plus application-defined access policies.
- Replace vector-only ranking with explainable hybrid semantic, lexical, importance, recency, temporal, and bounded-access fusion.
- Separate duplicate confidence and retrieval access statistics from explicit importance.
- Add token-aware, redundancy-reducing, kind-diverse context assembly with optional provenance.
- Add reviewable consolidation planning, dry-run, selective application, and JSON model helpers.
- Add an evaluation harness for recall, update, temporal, contradiction, abstention, latency, and token fixtures.
- Add soft visibility and explicit hard-purge retention semantics.
- Add Supabase migration 002 with scoped deduplication, FTS, temporal fields, event history, access stats, and v2 RPCs.
- Expand tests with core behavioral coverage and a live PostgreSQL/pgvector smoke suite.

## 0.1.0 - 2026-07-22

- Add provider-agnostic capture, deduplication, recall, context, cleanup, and deletion APIs.
- Add a zero-dependency in-memory store.
- Add generic JSON extraction helpers and semantic-recall heuristics.
- Add an optional Supabase + pgvector adapter and reference schema.
- Add tests, CI, security guidance, and package metadata.
