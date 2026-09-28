// モデル詳細 (ファイル構成・量子化ごとの適合度) の解析。詳細画面とMCPで共有する

import { estimateFit, pickBestQuant, type FitResult, type MachineProfile, type ModelSpec, type QuantChoice } from "./estimate";
import type { ModelSummary } from "./hfmodel";
import { groupGgufFiles, safetensorsBundle, type FileGroup, type RepoFile } from "./quant";
import type { ModelArch } from "./types";

export interface RepoGroups {
  model: FileGroup[];
  mmproj: FileGroup[];
}

export function repoGroups(summary: ModelSummary, files: RepoFile[], bundleLabel: string): RepoGroups {
  if (summary.format === "gguf") {
    const all = groupGgufFiles(files);
    return { model: all.filter((g) => !g.isMmproj), mmproj: all.filter((g) => g.isMmproj) };
  }
  const b = safetensorsBundle(files);
  return {
    model: b ? [{ ...b, quant: summary.repoQuant, label: summary.repoQuant ?? bundleLabel }] : [],
    mmproj: [],
  };
}

/** 構造情報の取得に使うファイル (最小の量子化の先頭ファイル)。GGUF以外は null */
export function archProbeFile(summary: ModelSummary, groups: RepoGroups): string | null {
  if (summary.format !== "gguf") return null;
  const smallest = [...groups.model].sort((a, b) => a.totalSize - b.totalSize)[0];
  return smallest?.files[0]?.path ?? null;
}

export function activeParams(summary: ModelSummary, arch: ModelArch | null, total: number | null): number | null {
  if (summary.paramsActive) return summary.paramsActive;
  if (total && arch?.expertCount && arch.expertUsedCount && arch.expertCount > 1) {
    // 共有部分を約1割と仮定した概算
    return total * (0.1 + (0.9 * arch.expertUsedCount) / arch.expertCount);
  }
  return null;
}

export function modelSpec(summary: ModelSummary, arch: ModelArch | null): Omit<ModelSpec, "weightsBytes"> {
  const paramsTotal = summary.paramsTotal ?? arch?.parameterCount ?? null;
  return {
    format: summary.format,
    paramsTotal,
    paramsActive: activeParams(summary, arch, paramsTotal),
    kvBytesPerToken: arch?.kvBytesPerToken ?? null,
  };
}

export interface GroupEvaluation {
  fits: Map<string, FitResult>;
  best: QuantChoice | null;
}

export function evaluateGroups(
  profile: MachineProfile,
  groups: FileGroup[],
  spec: Omit<ModelSpec, "weightsBytes">,
  ctx: number,
  minTps: number,
): GroupEvaluation {
  const fits = new Map<string, FitResult>();
  for (const g of groups) fits.set(g.key, estimateFit(profile, { ...spec, weightsBytes: g.totalSize }, ctx, minTps));
  const best = pickBestQuant(
    profile,
    groups.map((g) => ({ quant: g.quant ?? g.label, weightsBytes: g.totalSize, id: g.key })),
    spec,
    ctx,
    minTps,
  );
  return { fits, best };
}

/** 画像入力用に優先するmmproj (F16 > その他) */
export function preferredMmproj(groups: RepoGroups): FileGroup | null {
  return groups.mmproj.find((g) => /F16/i.test(g.label) && !/BF16/i.test(g.label)) ?? groups.mmproj[0] ?? null;
}
