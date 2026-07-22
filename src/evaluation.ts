import type { AspMemory } from "./memory.js";
import type { Memory, MemoryScope, RecallOptions, TokenEstimator } from "./types.js";
import { estimateTokensConservatively } from "./context.js";
import { normalizeContent } from "./utils.js";

export type MemoryEvaluationCategory =
  | "recall"
  | "knowledge_update"
  | "temporal"
  | "contradiction"
  | "abstention"
  | (string & {});

export interface MemoryEvaluationCase {
  name: string;
  category: MemoryEvaluationCategory;
  ownerId: string;
  scope?: MemoryScope;
  prepare(memory: AspMemory): Promise<void>;
  query: string;
  expectedContents?: readonly string[];
  shouldAbstain?: boolean;
  recall?: Omit<RecallOptions, "query" | "scope">;
}

export interface MemoryEvaluationCaseResult {
  name: string;
  category: MemoryEvaluationCategory;
  expected: number;
  retrieved: number;
  relevantRetrieved: number;
  reciprocalRank: number;
  abstentionCorrect: boolean;
  latencyMs: number;
  estimatedTokens: number;
  memories: readonly Memory[];
}

export interface MemoryEvaluationMetrics {
  cases: number;
  recallAtK: number;
  precisionAtK: number;
  meanReciprocalRank: number;
  abstentionAccuracy: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  meanEstimatedTokens: number;
}

export interface MemoryEvaluationReport {
  metrics: MemoryEvaluationMetrics;
  byCategory: Readonly<Record<string, MemoryEvaluationMetrics>>;
  cases: readonly MemoryEvaluationCaseResult[];
}

export interface MemoryEvaluationOptions {
  estimateTokens?: TokenEstimator;
}

/** Provider-free baseline fixtures for update, temporal, contradiction, and abstention behavior. */
export function createMemoryPracticeEvaluationCases(
  ownerPrefix = "asp-mem-eval",
): MemoryEvaluationCase[] {
  return [
    {
      name: "current knowledge replaces an old observation",
      category: "knowledge_update",
      ownerId: `${ownerPrefix}-update`,
      async prepare(memory) {
        const old = await memory.remember({
          ownerId: `${ownerPrefix}-update`,
          content: "Prefers tea",
          validFrom: new Date("2024-01-01T00:00:00Z"),
        });
        await memory.supersede(
          `${ownerPrefix}-update`,
          old.memory.id,
          {
            content: "Prefers coffee",
            validFrom: new Date("2025-01-01T00:00:00Z"),
          },
          { reason: "evaluation update" },
        );
      },
      query: "drink preference coffee",
      expectedContents: ["Prefers coffee"],
      recall: { limit: 1 },
    },
    {
      name: "historical recall uses the prior validity interval",
      category: "temporal",
      ownerId: `${ownerPrefix}-temporal`,
      async prepare(memory) {
        const old = await memory.remember({
          ownerId: `${ownerPrefix}-temporal`,
          content: "Lives in Lisbon",
          validFrom: new Date("2023-01-01T00:00:00Z"),
        });
        await memory.supersede(
          `${ownerPrefix}-temporal`,
          old.memory.id,
          {
            content: "Lives in Berlin",
            validFrom: new Date("2025-01-01T00:00:00Z"),
          },
          { reason: "evaluation move" },
        );
      },
      query: "where lives Lisbon",
      expectedContents: ["Lives in Lisbon"],
      recall: {
        limit: 1,
        referenceTime: new Date("2024-06-01T00:00:00Z"),
      },
    },
    {
      name: "retracted contradiction stays out of the current view",
      category: "contradiction",
      ownerId: `${ownerPrefix}-contradiction`,
      async prepare(memory) {
        const incorrect = await memory.remember({
          ownerId: `${ownerPrefix}-contradiction`,
          content: "Is allergic to peanuts",
        });
        await memory.retract(`${ownerPrefix}-contradiction`, incorrect.memory.id, {
          reason: "evaluation correction",
        });
        await memory.remember({
          ownerId: `${ownerPrefix}-contradiction`,
          content: "Has no peanut allergy",
        });
      },
      query: "peanut allergy",
      expectedContents: ["Has no peanut allergy"],
      recall: { limit: 1 },
    },
    {
      name: "unseen owner abstains",
      category: "abstention",
      ownerId: `${ownerPrefix}-empty`,
      async prepare() {},
      query: "unknown preference",
      shouldAbstain: true,
      recall: { limit: 3, minScore: 0.95 },
    },
  ];
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
}

function metrics(results: readonly MemoryEvaluationCaseResult[]): MemoryEvaluationMetrics {
  const count = results.length || 1;
  return {
    cases: results.length,
    recallAtK:
      results.reduce(
        (total, item) =>
          total +
          (item.expected === 0
            ? item.abstentionCorrect
              ? 1
              : 0
            : item.relevantRetrieved / item.expected),
        0,
      ) / count,
    precisionAtK:
      results.reduce(
        (total, item) => total + (item.retrieved === 0 ? (item.expected === 0 ? 1 : 0) : item.relevantRetrieved / item.retrieved),
        0,
      ) / count,
    meanReciprocalRank:
      results.reduce((total, item) => total + item.reciprocalRank, 0) / count,
    abstentionAccuracy:
      results.reduce((total, item) => total + (item.abstentionCorrect ? 1 : 0), 0) /
      count,
    latencyP50Ms: percentile(results.map((item) => item.latencyMs), 0.5),
    latencyP95Ms: percentile(results.map((item) => item.latencyMs), 0.95),
    meanEstimatedTokens:
      results.reduce((total, item) => total + item.estimatedTokens, 0) / count,
  };
}

export async function evaluateMemory(
  memory: AspMemory,
  cases: readonly MemoryEvaluationCase[],
  options: MemoryEvaluationOptions = {},
): Promise<MemoryEvaluationReport> {
  const estimateTokens = options.estimateTokens ?? estimateTokensConservatively;
  const results: MemoryEvaluationCaseResult[] = [];

  for (const testCase of cases) {
    await testCase.prepare(memory);
    const started = performance.now();
    const recalled = await memory.recall(testCase.ownerId, {
      ...testCase.recall,
      ...(testCase.scope ? { scope: testCase.scope } : {}),
      query: testCase.query,
      trackAccess: false,
    });
    const latencyMs = performance.now() - started;
    const expected = (testCase.expectedContents ?? []).map((content) =>
      normalizeContent(content).toLocaleLowerCase(),
    );
    const retrieved = recalled.map((item) =>
      normalizeContent(item.content).toLocaleLowerCase(),
    );
    const relevantRanks = retrieved.flatMap((content, index) =>
      expected.includes(content) ? [index + 1] : [],
    );
    const shouldAbstain = testCase.shouldAbstain ?? expected.length === 0;
    results.push({
      name: testCase.name,
      category: testCase.category,
      expected: expected.length,
      retrieved: recalled.length,
      relevantRetrieved: new Set(relevantRanks).size,
      reciprocalRank: relevantRanks[0]
        ? 1 / relevantRanks[0]
        : expected.length === 0 && recalled.length === 0
          ? 1
          : 0,
      abstentionCorrect: shouldAbstain
        ? recalled.length === 0
        : relevantRanks.length > 0,
      latencyMs,
      estimatedTokens: Number(
        estimateTokens(recalled.map((item) => item.content).join("\n")),
      ),
      memories: recalled,
    });
  }

  const categories = new Map<string, MemoryEvaluationCaseResult[]>();
  for (const result of results) {
    const items = categories.get(result.category) ?? [];
    items.push(result);
    categories.set(result.category, items);
  }
  return {
    metrics: metrics(results),
    byCategory: Object.fromEntries(
      [...categories].map(([category, items]) => [category, metrics(items)]),
    ),
    cases: results,
  };
}
