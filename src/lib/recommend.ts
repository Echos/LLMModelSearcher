// 用途別のモデル推奨。HFから候補を集め、このマシンでの適合度・速度・人気・新しさで順位付けする

import { api } from "./api";
import type { MachineProfile, QuantChoice } from "./estimate";
import { buildListQuery, toSummary, type ModelSummary } from "./hfmodel";
import { quickFit } from "./quickfit";

export const USE_CASES = ["chat", "coding", "reasoning", "vision", "japanese", "embedding"] as const;
export type UseCase = (typeof USE_CASES)[number];

interface QueryDef {
  search?: string;
  filters?: string[];
  pipelineTag?: string;
  sort: string;
}

const QUERIES: Record<UseCase, QueryDef[]> = {
  chat: [
    { pipelineTag: "text-generation", sort: "trendingScore" },
    { pipelineTag: "text-generation", sort: "downloads" },
  ],
  coding: [
    { search: "coder", sort: "downloads" },
    { search: "coder", sort: "trendingScore" },
    { search: "devstral", sort: "downloads" },
  ],
  reasoning: [
    { search: "thinking", sort: "trendingScore" },
    { search: "reasoning", sort: "downloads" },
    { search: "gpt-oss", sort: "downloads" },
    { search: "qwen3", sort: "trendingScore" },
  ],
  vision: [
    { pipelineTag: "image-text-to-text", sort: "trendingScore" },
    { pipelineTag: "image-text-to-text", sort: "downloads" },
  ],
  japanese: [
    { filters: ["ja"], sort: "downloads" },
    { filters: ["ja"], sort: "trendingScore" },
    { search: "japanese", sort: "downloads" },
  ],
  embedding: [
    { pipelineTag: "feature-extraction", sort: "downloads" },
    { pipelineTag: "sentence-similarity", sort: "downloads" },
    { search: "embedding", sort: "trendingScore" },
  ],
};

/** 量子化の品質・更新頻度に定評のある公開者 */
const TRUSTED = new Set([
  "unsloth",
  "bartowski",
  "lmstudio-community",
  "ggml-org",
  "mlx-community",
  "qwen",
  "google",
  "microsoft",
  "mistralai",
  "openai",
  "ibm-granite",
  "nvidia",
  "meta-llama",
  "deepseek-ai",
]);

export type ReasonKey = "fullGpu" | "partial" | "cpu" | "fast" | "popular" | "recent" | "trusted";

export interface Recommendation {
  model: ModelSummary;
  choice: QuantChoice;
  score: number;
  reasons: ReasonKey[];
}

function monthsSince(date: string | null): number {
  if (!date) return 36;
  return (Date.now() - new Date(date).getTime()) / (30 * 24 * 3600 * 1000);
}

function recencyFactor(m: ModelSummary): number {
  const months = monthsSince(m.createdAt);
  if (months < 6) return 1;
  if (months < 12) return 0.8;
  if (months < 24) return 0.5;
  return 0.3;
}

export function scoreModel(
  m: ModelSummary,
  profile: MachineProfile,
  ctx: number,
  minTps: number,
  useCase: UseCase,
): Recommendation | null {
  const { choice } = quickFit(m, profile, ctx, minTps);
  if (!m.paramsTotal || !choice) return null;

  const tps = choice.fit.tokensPerSec ?? 0;
  const fitScore = choice.fit.level === "full_gpu" ? 1 : choice.fit.level === "partial" ? 0.75 : 0.6;
  const speedFactor = tps >= minTps ? 1 : Math.max(tps / minTps, 0.05);
  const popularity = Math.min(Math.log10(m.downloads + 1) / 7, 1);
  const recency = recencyFactor(m);
  const trusted = TRUSTED.has(m.author.toLowerCase());
  const paramsB = m.paramsTotal / 1e9;

  let score: number;
  if (useCase === "embedding") {
    score = popularity * 2 + recency + fitScore;
  } else {
    const capability = Math.log2(paramsB + 1) * choice.quality;
    score = capability * fitScore * speedFactor * (0.6 + 0.4 * recency) + popularity * 1.5;
  }
  if (trusted) score *= 1.1;

  const reasons: ReasonKey[] = [];
  reasons.push(choice.fit.level === "full_gpu" ? "fullGpu" : choice.fit.level === "partial" ? "partial" : "cpu");
  if (tps >= Math.max(30, minTps)) reasons.push("fast");
  if (m.downloads >= 100_000) reasons.push("popular");
  if (monthsSince(m.createdAt) < 6) reasons.push("recent");
  if (trusted) reasons.push("trusted");
  return { model: m, choice, score, reasons };
}

function dedupeKey(m: ModelSummary): string {
  return (m.baseModels[0] ?? m.id).toLowerCase();
}

export async function recommend(
  useCase: UseCase,
  profile: MachineProfile,
  ctx: number,
  minTps: number,
  limit = 12,
): Promise<Recommendation[]> {
  const formats = profile.appleSilicon ? ["gguf", "mlx"] : ["gguf"];
  const requests = QUERIES[useCase].flatMap((q) =>
    formats.map((f) =>
      api
        .listModels(
          buildListQuery({
            search: q.search,
            pipelineTag: q.pipelineTag,
            filters: [f, ...(q.filters ?? [])],
            sort: q.sort,
            limit: 40,
          }),
        )
        .catch(() => [] as unknown[]),
    ),
  );
  const raw = (await Promise.all(requests)).flat() as Record<string, unknown>[];
  const seen = new Set<string>();
  const models = raw
    .map((r) => toSummary(r))
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .filter((m) => useCase === "embedding" || !/embed|rerank/i.test(m.id));

  const scored = models
    .map((m) => scoreModel(m, profile, ctx, minTps, useCase))
    .filter((r): r is Recommendation => r !== null);

  // 同じベースモデルの量子化違いは、最もスコアの高い1件だけ残す
  const best = new Map<string, Recommendation>();
  for (const r of scored) {
    const k = dedupeKey(r.model);
    const cur = best.get(k);
    if (!cur || r.score > cur.score) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
