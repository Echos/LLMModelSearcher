// Hugging Face API のレスポンスをアプリ内の型に正規化する

import { detectCapabilities, isLlmPipeline, templateFeatures, type Capability } from "./capabilities";
import { parseQuant, quantSpec, type RepoFile } from "./quant";

export type ModelFormat = "gguf" | "mlx" | "safetensors" | "other";

export interface ModelSummary {
  id: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  trendingScore: number;
  createdAt: string | null;
  lastModified: string | null;
  tags: string[];
  pipelineTag: string | null;
  format: ModelFormat;
  paramsTotal: number | null;
  paramsActive: number | null;
  contextLength: number | null;
  architecture: string | null;
  baseModels: string[];
  license: string | null;
  gated: boolean;
  /** MLXなどリポジトリ単位で量子化が決まっている場合の量子化名 */
  repoQuant: string | null;
  capabilities: Capability[];
  /** 画像生成・音声合成などLLM以外のモデルでないか */
  isLlm: boolean;
}

export const EXPAND_FIELDS = [
  "author",
  "downloads",
  "likes",
  "trendingScore",
  "createdAt",
  "lastModified",
  "tags",
  "pipeline_tag",
  "library_name",
  "gguf",
  "safetensors",
  "gated",
];

type Raw = Record<string, any>;

const BASE_RELATIONS = new Set(["quantized", "finetune", "adapter", "merge"]);

/** タグ `base_model:...` からベースモデルIDを取り出す */
export function baseModelsFromTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    if (!t.startsWith("base_model:")) continue;
    let rest = t.slice("base_model:".length);
    const i = rest.indexOf(":");
    if (i > 0 && BASE_RELATIONS.has(rest.slice(0, i))) rest = rest.slice(i + 1);
    if (rest.includes("/")) out.add(rest);
  }
  return [...out];
}

/** "30B-A3B" / "8x7B" / "8B" 形式の名前からパラメータ数を推定する */
export function paramsFromName(name: string): { total: number | null; active: number | null } {
  const moe = name.match(/(\d+)x(\d+(?:\.\d+)?)B(?![a-z])/i);
  if (moe) {
    const n = Number(moe[1]);
    const per = Number(moe[2]) * 1e9;
    return { total: n * per * 0.85, active: 2 * per * 0.85 };
  }
  const active = name.match(/[-_]A(\d+(?:\.\d+)?)B(?![a-z])/i);
  let total: number | null = null;
  for (const m of name.matchAll(/(?:^|[-_.])[Ee]?(\d+(?:\.\d+)?)([BM])(?![a-z])/gi)) {
    if (active && m.index !== undefined && name.slice(m.index).match(/^[-_]A/i)) continue;
    const v = Number(m[1]) * (m[2].toUpperCase() === "B" ? 1e9 : 1e6);
    if (total === null) total = v;
  }
  return { total, active: active ? Number(active[1]) * 1e9 : null };
}

export function detectFormat(tags: string[], raw?: Raw): ModelFormat {
  if (tags.includes("gguf") || raw?.gguf) return "gguf";
  if (tags.includes("mlx") || raw?.library_name === "mlx") return "mlx";
  if (tags.includes("safetensors") || raw?.safetensors) return "safetensors";
  return "other";
}

export function toSummary(raw: Raw): ModelSummary {
  const id: string = raw.id ?? raw.modelId;
  const [author, name] = id.includes("/") ? id.split("/", 2) : ["", id];
  const tags: string[] = raw.tags ?? [];
  const fromName = paramsFromName(name);
  const format = detectFormat(tags, raw);
  const paramsTotal: number | null = raw.gguf?.total ?? raw.safetensors?.total ?? fromName.total;
  const baseModels = raw.cardData?.base_model
    ? ([] as string[]).concat(raw.cardData.base_model)
    : baseModelsFromTags(tags);
  const license =
    raw.cardData?.license ?? tags.find((t) => t.startsWith("license:"))?.slice("license:".length) ?? null;
  const contextLength: number | null = raw.gguf?.context_length ?? null;
  const architecture: string | null = raw.gguf?.architecture ?? raw.config?.model_type ?? null;
  const pipelineTag: string | null = raw.pipeline_tag ?? null;
  const tpl = templateFeatures(raw.gguf?.chat_template ?? raw.config?.tokenizer_config?.chat_template);
  const capabilities = detectCapabilities({
    id,
    name,
    tags,
    pipelineTag,
    architecture,
    contextLength,
    paramsActive: fromName.active,
    templateTools: tpl.tools,
    templateReasoning: tpl.reasoning,
  });
  return {
    id,
    author: raw.author ?? author,
    name,
    downloads: raw.downloads ?? 0,
    likes: raw.likes ?? 0,
    trendingScore: raw.trendingScore ?? 0,
    createdAt: raw.createdAt ?? null,
    lastModified: raw.lastModified ?? null,
    tags,
    pipelineTag,
    format,
    paramsTotal,
    paramsActive: fromName.active,
    contextLength,
    architecture,
    baseModels,
    license,
    gated: Boolean(raw.gated),
    repoQuant: format === "mlx" ? parseQuant(name) : null,
    capabilities,
    isLlm: isLlmPipeline(pipelineTag),
  };
}

export function filesFromInfo(info: Raw): RepoFile[] {
  return ((info.siblings as Raw[]) ?? []).map((s) => ({
    path: s.rfilename,
    size: s.size ?? s.lfs?.size ?? 0,
    sha256: s.lfs?.sha256 ?? null,
  }));
}

/** safetensorsのサイズから、量子化ビット数を考慮したパラメータ数を推定する */
export function paramsFromSize(bytes: number, quant: string | null): number {
  const bpw = quantSpec(quant)?.bpw ?? 16;
  return (bytes * 8) / bpw;
}

export function hfUrl(repoId: string): string {
  return `https://huggingface.co/${repoId}`;
}

/** 検索時のHF APIクエリを組み立てる */
export function buildListQuery(opts: {
  search?: string;
  author?: string;
  filters?: string[];
  pipelineTag?: string;
  sort?: string;
  limit?: number;
}): [string, string][] {
  const q: [string, string][] = [];
  if (opts.search) q.push(["search", opts.search]);
  if (opts.author) q.push(["author", opts.author]);
  for (const f of opts.filters ?? []) q.push(["filter", f]);
  if (opts.pipelineTag) q.push(["pipeline_tag", opts.pipelineTag]);
  q.push(["sort", opts.sort ?? "trendingScore"]);
  q.push(["direction", "-1"]);
  q.push(["limit", String(opts.limit ?? 50)]);
  for (const e of EXPAND_FIELDS) q.push(["expand[]", e]);
  return q;
}
