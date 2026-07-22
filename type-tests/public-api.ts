import {
  AspMemory,
  applyConsolidation,
  createMemoryPracticeEvaluationCases,
  evaluateMemory,
  planConsolidation,
  type Consolidator,
  type MemoryAccessPolicy,
} from "../dist/index.js";
import { createSupabaseMemoryStore } from "../dist/supabase.js";

const policy: MemoryAccessPolicy = {
  authorize: ({ actor }) => actor?.roles?.includes("memory") ?? false,
};
const memory = new AspMemory({ accessPolicy: policy });
const actor = { id: "agent-1", roles: ["memory"] };

const saved = await memory.remember({
  ownerId: "user-1",
  scope: { agentId: "assistant-1", sessionId: "session-1" },
  actor,
  kind: "preference",
  content: "Prefers concise answers",
  confidence: 0.9,
  attributedTo: "user",
  validFrom: new Date(),
  visibleUntil: new Date(Date.now() + 60_000),
  purgeAt: new Date(Date.now() + 120_000),
});

const recalled = await memory.recall("user-1", {
  scope: { agentId: "assistant-1", sessionId: "session-1" },
  actor,
  query: "answer style",
  weights: { keyword: 0.3 },
  explain: true,
});
const keywordScore: number | undefined = recalled[0]?.scoreDetails?.keyword;
void keywordScore;

await memory.supersede(
  "user-1",
  saved.memory.id,
  { content: "Prefers detailed answers" },
  {
    scope: { agentId: "assistant-1", sessionId: "session-1" },
    actor,
    reason: "User changed preference",
  },
);
await memory.history("user-1", saved.memory.id, {
  scope: { agentId: "assistant-1", sessionId: "session-1" },
  actor,
});

const consolidator: Consolidator = { plan: async () => [] };
const plan = await planConsolidation(memory, "user-1", consolidator, { actor });
await applyConsolidation(memory, plan, { actor, actionIds: [] });

await evaluateMemory(memory, createMemoryPracticeEvaluationCases());
createSupabaseMemoryStore({ rpc: async () => ({ data: null, error: null }) });
