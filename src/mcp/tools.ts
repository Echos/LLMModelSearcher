// MCPツールの定義と実装。Rust側のMCPサーバーからイベント経由で呼び出される

import { archProbeFile, evaluateGroups, modelSpec, preferredMmproj, repoGroups } from "../lib/analyze";
import { api } from "../lib/api";
import { CAPABILITIES, type Capability } from "../lib/capabilities";
import { isRunnable, type FitResult, type MachineProfile } from "../lib/estimate";
import { buildListQuery, filesFromInfo, toSummary, type ModelSummary } from "../lib/hfmodel";
import { quickFit } from "../lib/quickfit";
import { recommend, USE_CASES, type UseCase } from "../lib/recommend";
import type { DownloadTask, Favorite, HardwareInfo, LocalRepo, ModelArch, Settings } from "../lib/types";

export interface McpContext {
  settings: Settings;
  hw: HardwareInfo | null;
  profile: MachineProfile | null;
  library: LocalRepo[];
  downloads: DownloadTask[];
  favorites: Favorite[];
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  /** ダウンロード許可設定が有効なときだけ公開する */
  requiresDownload?: boolean;
}

const GB = 1024 ** 3;
const gb = (b: number | null | undefined) => (b === null || b === undefined ? null : Math.round((b / GB) * 100) / 100);
const billions = (n: number | null | undefined) => (n ? Math.round((n / 1e9) * 100) / 100 : null);
const tps = (n: number | null | undefined) => (n ? Math.round(n * 10) / 10 : null);

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
const LOCAL_READ = { readOnlyHint: true, openWorldHint: false };

const formatsProp = {
  type: "array",
  items: { type: "string", enum: ["gguf", "mlx", "safetensors"] },
  description: "Model file formats to include. Default: gguf (plus mlx on Apple Silicon).",
};
const ctxProp = {
  type: "integer",
  minimum: 512,
  description: "Context length (tokens) used for memory/speed estimates. Default: the app setting.",
};

export const TOOLS: ToolDef[] = [
  {
    name: "get_hardware",
    title: "Get hardware",
    description:
      "Detected hardware of this PC (CPU, RAM, GPUs, VRAM, memory bandwidth) and the values used for fit/speed estimates.",
    inputSchema: { type: "object", properties: {} },
    annotations: LOCAL_READ,
  },
  {
    name: "search_models",
    title: "Search models",
    description:
      "Search Hugging Face models. Each result includes capabilities, the best quantization for this PC, fit level (full_gpu / partial / cpu / no_fit / unsupported) and estimated generation speed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword (model name etc.). Empty = trending models." },
        formats: formatsProp,
        sort: { type: "string", enum: ["trendingScore", "downloads", "likes", "lastModified", "createdAt"] },
        task: {
          type: "string",
          description: "Hugging Face pipeline_tag, e.g. text-generation, image-text-to-text, feature-extraction",
        },
        capabilities: {
          type: "array",
          items: { type: "string", enum: [...CAPABILITIES] },
          description: "Only models having all of these capabilities",
        },
        min_params_b: { type: "number", description: "Minimum total parameters (billions)" },
        max_params_b: { type: "number", description: "Maximum total parameters (billions)" },
        fits_only: { type: "boolean", description: "Only models that can run on this PC" },
        llm_only: { type: "boolean", description: "Exclude non-LLM models such as image generation. Default true." },
        context_length: ctxProp,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results (default 20)" },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_model",
    title: "Get model details",
    description:
      "Details of a Hugging Face repository and, for each quantization/file group, size, required memory, fit on this PC, estimated tok/s and which one is recommended. Also shows whether files are already saved locally.",
    inputSchema: {
      type: "object",
      properties: { repo_id: { type: "string", description: "e.g. unsloth/Qwen3-8B-GGUF" }, context_length: ctxProp },
      required: ["repo_id"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "recommend_models",
    title: "Recommend models",
    description: "Models recommended for this PC for a use case, with the best quantization and reasons.",
    inputSchema: {
      type: "object",
      properties: {
        use_case: { type: "string", enum: [...USE_CASES] },
        context_length: ctxProp,
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      required: ["use_case"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_trending",
    title: "List trending / new models",
    description: "Trending, newly published or recently updated models with fit on this PC.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["trending", "new", "updated"] },
        task: { type: "string", description: "pipeline_tag filter (default text-generation)" },
        fits_only: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_readme",
    title: "Get model card",
    description: "README (model card) of a Hugging Face repository as Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: { type: "string" },
        max_chars: { type: "integer", minimum: 500, description: "Truncate to this many characters (default 20000)" },
      },
      required: ["repo_id"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_library",
    title: "List local models",
    description:
      "Models saved in the local models directory with disk usage and tracking results (updated files, new_version, successor and derivative models).",
    inputSchema: { type: "object", properties: {} },
    annotations: LOCAL_READ,
  },
  {
    name: "list_downloads",
    title: "List downloads",
    description: "Download queue with status and progress.",
    inputSchema: { type: "object", properties: {} },
    annotations: LOCAL_READ,
  },
  {
    name: "list_favorites",
    title: "List favorites",
    description: "Repositories the user marked as favorite in the app.",
    inputSchema: { type: "object", properties: {} },
    annotations: LOCAL_READ,
  },
  {
    name: "download_model",
    title: "Download model",
    description:
      "Queue a download into the app's models directory (<dir>/<publisher>/<repo>/<file>). If quant is omitted, the quantization recommended for this PC is used. Files already saved are skipped. Progress can be checked with list_downloads.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: { type: "string" },
        quant: {
          type: "string",
          description: "Quantization label from get_model, e.g. Q4_K_M or UD-Q4_K_XL. Omit to use the recommended one.",
        },
        include_mmproj: {
          type: "boolean",
          description: "Also download the vision projector (mmproj) when the repo has one. Default true.",
        },
      },
      required: ["repo_id"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true },
    requiresDownload: true,
  },
];

export function listTools(ctx: McpContext) {
  return TOOLS.filter((t) => !t.requiresDownload || ctx.settings.mcpAllowDownload).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

function requireProfile(ctx: McpContext): MachineProfile {
  if (!ctx.profile) throw new Error("hardware detection has not finished yet; retry shortly");
  return ctx.profile;
}

function fitJson(f: FitResult | null | undefined) {
  if (!f) return null;
  return {
    level: f.level,
    required_memory_gb: gb(f.totalBytes),
    weights_gb: gb(f.weightsBytes),
    kv_cache_gb: gb(f.kvBytes),
    gpu_offload_percent: Math.round(f.gpuFraction * 100),
    est_tokens_per_sec: tps(f.tokensPerSec),
    speed_class: f.speedClass,
    kv_estimated: f.kvEstimated,
  };
}

function modelRow(m: ModelSummary, ctx: McpContext, contextLength: number) {
  const q = ctx.profile ? quickFit(m, ctx.profile, contextLength, ctx.settings.minTokensPerSec) : null;
  return {
    id: m.id,
    format: m.format,
    task: m.pipelineTag,
    params_b: billions(m.paramsTotal),
    active_params_b: billions(m.paramsActive),
    capabilities: m.capabilities,
    best_quant: q?.choice?.quant ?? null,
    fit: q?.level ?? null,
    est_tokens_per_sec: tps(q?.choice?.fit.tokensPerSec),
    downloads: m.downloads,
    likes: m.likes,
    created_at: m.createdAt,
    last_modified: m.lastModified,
    gated: m.gated,
    saved_locally: ctx.library.some((r) => r.repoId === m.id),
  };
}

function defaultFormats(ctx: McpContext): string[] {
  return ctx.profile?.appleSilicon ? ["gguf", "mlx"] : ["gguf"];
}

async function listMerged(formats: string[], opts: Parameters<typeof buildListQuery>[0]): Promise<ModelSummary[]> {
  const lists = await Promise.all(formats.map((f) => api.listModels(buildListQuery({ ...opts, filters: [f, ...(opts.filters ?? [])] }))));
  const seen = new Set<string>();
  return (lists.flat() as Record<string, unknown>[])
    .map(toSummary)
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

type Args = Record<string, any>;

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : def;
  return Math.min(Math.max(n, min), max);
}

async function loadModel(repoId: string) {
  const info = (await api.modelInfo(repoId)) as Record<string, any>;
  const summary = toSummary(info);
  const groups = repoGroups(summary, filesFromInfo(info), "safetensors");
  let arch: ModelArch | null = null;
  const probe = archProbeFile(summary, groups);
  if (summary.format !== "gguf" || probe) {
    arch = await api.modelArch(repoId, probe).catch(() => null);
  }
  return { info, summary, groups, arch };
}

const HANDLERS: Record<string, (args: Args, ctx: McpContext) => Promise<unknown>> = {
  async get_hardware(_args, ctx) {
    const hw = ctx.hw;
    const p = requireProfile(ctx);
    return {
      os: hw?.osVersion || hw?.os,
      cpu: hw ? `${hw.cpuBrand} (${hw.cpuCores} cores / ${hw.cpuThreads} threads)` : null,
      ram_total_gb: gb(hw?.ramTotal),
      ram_available_gb: gb(hw?.ramAvailable),
      memory: hw ? [hw.memoryType, hw.memorySpeedMts ? `${hw.memorySpeedMts} MT/s` : null].filter(Boolean).join(" ") : null,
      gpus: hw?.gpus.map((g) => ({ name: g.name, kind: g.kind, vram_gb: gb(g.vramTotal), vram_free_gb: gb(g.vramFree) })),
      backends: hw?.backends,
      estimate_basis: {
        usable_gpu_memory_gb: gb(p.gpuMemory),
        gpu_bandwidth_gbps: p.gpuBandwidth,
        system_memory_bandwidth_gbps: Math.round(p.cpuBandwidth),
        unified_memory: p.unified,
        default_context_length: ctx.settings.defaultContextLength,
        min_usable_tokens_per_sec: ctx.settings.minTokensPerSec,
      },
    };
  },

  async search_models(a, ctx) {
    const contextLength = clampInt(a.context_length, ctx.settings.defaultContextLength, 512, 1 << 21);
    const limit = clampInt(a.limit, 20, 1, 100);
    const caps: Capability[] = Array.isArray(a.capabilities) ? a.capabilities : [];
    const models = await listMerged(Array.isArray(a.formats) && a.formats.length ? a.formats : defaultFormats(ctx), {
      search: typeof a.query === "string" && a.query.trim() ? a.query.trim() : undefined,
      pipelineTag: typeof a.task === "string" && a.task ? a.task : undefined,
      sort: typeof a.sort === "string" ? a.sort : "trendingScore",
      // 絞り込みで減る分を見込んで多めに取得する
      limit: Math.min(limit * 3, 100),
    });
    const lo = typeof a.min_params_b === "number" ? a.min_params_b * 1e9 : 0;
    const hi = typeof a.max_params_b === "number" ? a.max_params_b * 1e9 : Infinity;
    const rows = models
      .filter((m) => a.llm_only === false || m.isLlm)
      .filter((m) => caps.every((c) => m.capabilities.includes(c)))
      .filter((m) => (lo === 0 && hi === Infinity) || (m.paramsTotal !== null && m.paramsTotal >= lo && m.paramsTotal <= hi))
      .map((m) => modelRow(m, ctx, contextLength))
      .filter((r) => !a.fits_only || (r.fit !== null && ["full_gpu", "partial", "cpu"].includes(r.fit) && r.best_quant));
    return { context_length: contextLength, count: Math.min(rows.length, limit), results: rows.slice(0, limit) };
  },

  async get_model(a, ctx) {
    const repoId = str(a.repo_id, "repo_id");
    const p = requireProfile(ctx);
    const contextLength = clampInt(a.context_length, ctx.settings.defaultContextLength, 512, 1 << 21);
    const { info, summary, groups, arch } = await loadModel(repoId);
    const { fits, best } = evaluateGroups(p, groups.model, modelSpec(summary, arch), contextLength, ctx.settings.minTokensPerSec);
    const local = ctx.library.find((r) => r.repoId === repoId);
    const localPaths = new Set(local?.files.map((f) => f.path) ?? []);
    const caps = new Set(summary.capabilities);
    if (groups.mmproj.length) caps.add("vision");
    return {
      id: summary.id,
      revision: info.sha ?? null,
      format: summary.format,
      task: summary.pipelineTag,
      license: summary.license,
      gated: summary.gated,
      architecture: arch?.architecture ?? summary.architecture,
      params_b: billions(summary.paramsTotal ?? arch?.parameterCount),
      active_params_b: billions(modelSpec(summary, arch).paramsActive),
      max_context: arch?.contextLength ?? summary.contextLength,
      capabilities: CAPABILITIES.filter((c) => caps.has(c)),
      base_models: summary.baseModels,
      created_at: summary.createdAt,
      last_modified: summary.lastModified,
      downloads: summary.downloads,
      likes: summary.likes,
      context_length_used: contextLength,
      kv_cache_source: arch?.kvBytesPerToken ? arch.source : "estimated_from_params",
      recommended_quant: best ? groups.model.find((g) => g.key === best.id)?.label ?? best.quant : null,
      quantizations: groups.model.map((g) => ({
        label: g.label,
        size_gb: gb(g.totalSize),
        files: g.files.length,
        recommended: best?.id === g.key,
        saved_locally: g.files.every((f) => localPaths.has(f.path)),
        ...fitJson(fits.get(g.key)),
      })),
      mmproj: groups.mmproj.map((g) => ({ label: g.label, size_gb: gb(g.totalSize) })),
      speed_note: "Speed is a rough estimate from memory bandwidth.",
    };
  },

  async recommend_models(a, ctx) {
    const p = requireProfile(ctx);
    const useCase = str(a.use_case, "use_case") as UseCase;
    if (!USE_CASES.includes(useCase)) throw new Error(`use_case must be one of ${USE_CASES.join(", ")}`);
    const contextLength = clampInt(a.context_length, ctx.settings.defaultContextLength, 512, 1 << 21);
    const recs = await recommend(useCase, p, contextLength, ctx.settings.minTokensPerSec, clampInt(a.limit, 10, 1, 30));
    return {
      use_case: useCase,
      context_length: contextLength,
      results: recs.map((r) => ({
        ...modelRow(r.model, ctx, contextLength),
        best_quant: r.choice.quant,
        fit: r.choice.fit.level,
        est_tokens_per_sec: tps(r.choice.fit.tokensPerSec),
        est_weights_gb: gb(r.choice.fit.weightsBytes),
        reasons: r.reasons,
      })),
    };
  },

  async list_trending(a, ctx) {
    const sort = { trending: "trendingScore", new: "createdAt", updated: "lastModified" }[String(a.mode ?? "trending")] ?? "trendingScore";
    const limit = clampInt(a.limit, 30, 1, 100);
    const models = await listMerged(defaultFormats(ctx), {
      pipelineTag: typeof a.task === "string" ? a.task || undefined : "text-generation",
      sort,
      limit: Math.min(limit * 2, 100),
    });
    const rows = models
      .filter((m) => m.isLlm)
      .map((m) => modelRow(m, ctx, ctx.settings.defaultContextLength))
      .filter((r) => !a.fits_only || (r.best_quant !== null && r.fit !== "no_fit"));
    return { mode: a.mode ?? "trending", results: rows.slice(0, limit) };
  },

  async get_readme(a) {
    const repoId = str(a.repo_id, "repo_id");
    const max = clampInt(a.max_chars, 20000, 500, 200000);
    const text = await api.readme(repoId);
    return { repo_id: repoId, truncated: text.length > max, readme: text.slice(0, max) };
  },

  async list_library(_a, ctx) {
    return {
      models_dir: ctx.settings.modelsDir,
      total_size_gb: gb(ctx.library.reduce((s, r) => s + r.totalSize, 0)),
      repos: ctx.library.map((r) => {
        const t = r.record?.tracking;
        return {
          repo_id: r.repoId,
          format: r.format,
          size_gb: gb(r.totalSize),
          dir: r.dir,
          files: r.files.map((f) => ({ path: f.path, size_gb: gb(f.size) })),
          incomplete_files: r.incompleteFiles.map((f) => f.path),
          published_at: r.record?.createdAt ?? null,
          saved_at: r.record?.downloadedAt ?? null,
          tracked: !!r.record,
          tracking: t
            ? {
                checked_at: t.checkedAt,
                repo_updated: t.repoUpdated,
                changed_files: t.changedFiles,
                removed_files: t.removedFiles,
                new_version: t.newVersion,
                successors: t.successors.map((s) => s.id),
                derivatives: t.derivatives.map((d) => ({ id: d.id, relation: d.relation, created_at: d.createdAt })),
                error: t.error,
              }
            : null,
        };
      }),
    };
  },

  async list_downloads(_a, ctx) {
    return {
      downloads: ctx.downloads.map((d) => ({
        repo_id: d.repoId,
        path: d.path,
        status: d.status,
        progress_percent: d.size ? Math.round((d.downloaded / d.size) * 1000) / 10 : null,
        size_gb: gb(d.size),
        speed_mb_per_sec: d.speed ? Math.round((d.speed / 1024 ** 2) * 10) / 10 : null,
        error: d.error,
      })),
    };
  },

  async list_favorites(_a, ctx) {
    return { favorites: ctx.favorites.map((f) => ({ repo_id: f.repoId, added_at: f.addedAt })) };
  },

  async download_model(a, ctx) {
    if (!ctx.settings.mcpAllowDownload) throw new Error("downloads from MCP are disabled in the app settings");
    if (!ctx.settings.modelsDir) throw new Error("the models directory is not configured in the app settings");
    const repoId = str(a.repo_id, "repo_id");
    const p = requireProfile(ctx);
    const { info, summary, groups, arch } = await loadModel(repoId);
    if (groups.model.length === 0) throw new Error("no supported model files in this repository");

    const want = typeof a.quant === "string" ? a.quant.trim().toUpperCase() : "";
    let group = want
      ? groups.model.find((g) => g.label.toUpperCase() === want) ??
        groups.model.find((g) => (g.quant ?? "").toUpperCase() === want)
      : undefined;
    if (want && !group) {
      throw new Error(`quant "${a.quant}" not found. Available: ${groups.model.map((g) => g.label).join(", ")}`);
    }
    if (!group) {
      const { best } = evaluateGroups(p, groups.model, modelSpec(summary, arch), ctx.settings.defaultContextLength, ctx.settings.minTokensPerSec);
      if (!best || !isRunnable(best.fit)) {
        throw new Error(`no quantization fits this PC. Specify quant explicitly. Available: ${groups.model.map((g) => g.label).join(", ")}`);
      }
      group = groups.model.find((g) => g.key === best.id)!;
    }

    const files = [...group.files];
    const mmproj = preferredMmproj(groups);
    if (a.include_mmproj !== false && mmproj) files.push(...mmproj.files);
    const local = new Set(ctx.library.find((r) => r.repoId === repoId)?.files.map((f) => f.path) ?? []);
    const pending = files.filter((f) => !local.has(f.path));
    if (pending.length > 0) {
      await api.downloadEnqueue(
        repoId,
        info.sha ?? "main",
        pending.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
        { format: summary.format, createdAt: summary.createdAt, lastModified: summary.lastModified, baseModels: summary.baseModels },
      );
    }
    return {
      repo_id: repoId,
      quant: group.label,
      queued_files: pending.map((f) => f.path),
      already_saved: files.filter((f) => local.has(f.path)).map((f) => f.path),
      total_size_gb: gb(pending.reduce((s, f) => s + f.size, 0)),
      destination: `${ctx.settings.modelsDir}/${repoId}`,
      note: "Use list_downloads to check progress.",
    };
  },
};

export async function callTool(name: string, args: Args, ctx: McpContext) {
  const def = TOOLS.find((t) => t.name === name);
  if (!def || (def.requiresDownload && !ctx.settings.mcpAllowDownload)) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = (await HANDLERS[name](args ?? {}, ctx)) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (e) {
    const msg = typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
