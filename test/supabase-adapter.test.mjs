import assert from "node:assert/strict";
import test from "node:test";

import { AspMemory } from "../dist/index.js";
import { createSupabaseMemoryStore } from "../dist/supabase.js";

const ownerId = "2a487e8e-4b2a-4737-8f70-e2b0d73b68da";
const memoryId = "11111111-1111-4111-8111-111111111111";

function row(overrides = {}) {
  return {
    id: memoryId,
    owner_id: ownerId,
    scope_user_id: ownerId,
    kind: "preference",
    content: "Prefers tea",
    importance: 0.6,
    confidence: 0.8,
    status: "active",
    attributed_to: "user",
    source_type: "chat",
    source_id: "turn-1",
    metadata: { locale: "en" },
    links: [],
    observed_at: "2026-01-01T00:00:00.000Z",
    access_count: 0,
    recent_accesses: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("Supabase adapter maps v2 RPC payloads, nested search rows, and history", async () => {
  const calls = [];
  const client = {
    async rpc(name, parameters) {
      calls.push([name, parameters]);
      if (name === "remember_asp_memory_v2") {
        return { data: { created: true, memory: row() }, error: null };
      }
      if (name === "match_asp_memories_v2") {
        return {
          data: [{
            memory: row(),
            similarity: 0.9,
            score: 0.82,
            score_details: {
              semantic: 0,
              keyword: 1,
              importance: 0.6,
              recency: 1,
              temporal: 0.5,
              access: 0.3,
              accessFactor: 0.7,
              activeWeights: { keyword: 0.2 },
              fused: 0.82,
            },
          }],
          error: null,
        };
      }
      if (name === "record_asp_memory_access_v2") {
        return { data: null, error: null };
      }
      if (name === "history_asp_memory_v2") {
        return {
          data: [{
            id: "event-1",
            memory_id: memoryId,
            owner_id: ownerId,
            action: "add",
            next_snapshot: row(),
            created_at: "2026-01-01T00:00:00.000Z",
          }],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const memory = new AspMemory({
    store: createSupabaseMemoryStore(client),
    idFactory: () => memoryId,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  const saved = await memory.remember({
    ownerId,
    content: "Prefers tea",
    attributedTo: "user",
    source: { type: "chat", id: "turn-1" },
  });
  assert.equal(saved.memory.scope.userId, ownerId);
  assert.equal(calls[0][1].p_memory.scope.userId, ownerId);

  const recalled = await memory.recall(ownerId, {
    query: "tea preference",
    explain: true,
  });
  assert.equal(recalled[0].id, memoryId);
  assert.equal(recalled[0].score, 0.82);
  assert.equal(recalled[0].scoreDetails.keyword, 1);
  assert.equal(calls[2][0], "record_asp_memory_access_v2");

  const history = await memory.history(ownerId, memoryId);
  assert.equal(history[0].next.content, "Prefers tea");
});
