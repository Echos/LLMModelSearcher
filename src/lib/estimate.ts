// マシン性能とモデルサイズから、メモリ適合度と生成速度 (tok/s) を推定する

import { lookupBandwidth, systemMemoryBandwidth } from "./bandwidth";
import { CANDIDATE_QUANTS, quantSpec } from "./quant";
import type { HardwareInfo, Settings } from "./types";

const GB = 1024 ** 3;

export interface MachineProfile {
  gpuName: string | null;
  /** 推論に使えるGPUメモリ (バイト) */
  gpuMemory: number;
  gpuBandwidth: number;
  ramTotal: number;
  cpuBandwidth: number;
  unified: boolean;
  appleSilicon: boolean;
  gpuCount: number;
}

export function buildProfile(hw: HardwareInfo, s: Settings): MachineProfile {
  const appleSilicon = hw.os === "macos" && hw.unifiedMemory;
  const discrete = hw.gpus.filter((g) => g.kind === "discrete" && (g.vramTotal ?? 0) > 0);
  // Strix HaloなどBIOSで大きなVRAMを割り当てた内蔵GPUも推論に使える
  const bigIntegrated = hw.gpus.filter((g) => g.kind === "integrated" && (g.vramTotal ?? 0) >= 4 * GB);
  const usable = discrete.length > 0 ? discrete : bigIntegrated;

  let gpuMemory = 0;
  let gpuName: string | null = null;
  let gpuBandwidth = 0;
  if (appleSilicon) {
    // macOSが既定でGPUに割り当てる上限は、RAM 36GB以下で約2/3、それ以上で約3/4
    gpuMemory = hw.ramTotal * (hw.ramTotal > 36 * GB ? 0.75 : 0.67);
    gpuName = hw.cpuBrand;
    gpuBandwidth = lookupBandwidth(hw.cpuBrand) ?? 100;
  } else if (usable.length > 0) {
    gpuMemory = usable.reduce((sum, g) => sum + (g.vramTotal ?? 0), 0);
    gpuName = usable.map((g) => g.name).join(" + ");
    // 複数GPUは層分割になるため、速度は最も遅いGPUに律速される
    gpuBandwidth = Math.min(...usable.map((g) => lookupBandwidth(g.name) ?? 300));
  }

  if (s.vramOverrideGb) gpuMemory = s.vramOverrideGb * GB;
  if (s.gpuBandwidthOverrideGbps) gpuBandwidth = s.gpuBandwidthOverrideGbps;
  const cpuBandwidth =
    s.ramBandwidthOverrideGbps ??
    (appleSilicon ? gpuBandwidth : systemMemoryBandwidth(hw.memorySpeedMts, hw.memoryModules, hw.memoryType));

  return {
    gpuName,
    gpuMemory,
    gpuBandwidth,
    ramTotal: hw.ramTotal,
    cpuBandwidth,
    unified: appleSilicon,
    appleSilicon,
    gpuCount: appleSilicon ? 1 : usable.length,
  };
}

export type FitLevel = "full_gpu" | "partial" | "cpu" | "no_fit" | "unsupported";
export type SpeedClass = "fast" | "usable" | "slow" | "unusable";

export interface ModelSpec {
  weightsBytes: number;
  format: "gguf" | "mlx" | "safetensors" | "other";
  paramsTotal?: number | null;
  paramsActive?: number | null;
  kvBytesPerToken?: number | null;
}

export interface FitResult {
  level: FitLevel;
  weightsBytes: number;
  kvBytes: number;
  overheadBytes: number;
  totalBytes: number;
  /** GPUに載る重みの割合 (0-1) */
  gpuFraction: number;
  tokensPerSec: number | null;
  speedClass: SpeedClass | null;
  kvEstimated: boolean;
}

/** 構造情報がないときのKVキャッシュ推定 (f16, トークンあたりバイト) */
export function fallbackKvPerToken(paramsTotal: number | null | undefined): number {
  const b = paramsTotal ? paramsTotal / 1e9 : 7;
  return 50000 * Math.sqrt(Math.max(b, 0.1));
}

export function speedClassOf(tps: number, minTps: number): SpeedClass {
  if (tps >= Math.max(30, minTps)) return "fast";
  if (tps >= minTps) return "usable";
  if (tps >= 3) return "slow";
  return "unusable";
}

const OS_RESERVE = 6 * GB;

export function estimateFit(p: MachineProfile, m: ModelSpec, ctx: number, minTps: number): FitResult {
  const kvEstimated = !m.kvBytesPerToken;
  const kvBytes = (m.kvBytesPerToken || fallbackKvPerToken(m.paramsTotal)) * ctx;
  // 計算バッファなどの固定的なオーバーヘッド
  const overheadBytes = 0.5 * GB + (ctx / 1024) * 16 * 1024 ** 2;
  const w = m.weightsBytes;
  const totalBytes = w + kvBytes + overheadBytes;
  const base = { weightsBytes: w, kvBytes, overheadBytes, totalBytes, kvEstimated };

  if (m.format === "mlx" && !p.appleSilicon) {
    return { ...base, level: "unsupported", gpuFraction: 0, tokensPerSec: null, speedClass: null };
  }

  const ramBudget = Math.max(p.ramTotal - OS_RESERVE, 0);
  let level: FitLevel;
  let gpuFraction = 0;

  if (p.unified) {
    if (totalBytes <= p.gpuMemory) {
      level = "full_gpu";
      gpuFraction = 1;
    } else if (totalBytes <= ramBudget) {
      // GPU割り当て上限 (iogpu.wired_limit_mb) を引き上げれば全てGPUで動く
      level = "partial";
      gpuFraction = 1;
    } else {
      level = "no_fit";
    }
  } else {
    const gpuBudget = Math.max(p.gpuMemory * 0.95 - 0.3 * GB, 0);
    if (p.gpuMemory > 0 && totalBytes <= gpuBudget) {
      level = "full_gpu";
      gpuFraction = 1;
    } else if (p.gpuMemory > 0 && gpuBudget > kvBytes + overheadBytes) {
      const onGpu = gpuBudget - kvBytes - overheadBytes;
      gpuFraction = Math.min(onGpu / w, 1);
      level = w - onGpu <= ramBudget ? "partial" : "no_fit";
    } else {
      level = totalBytes <= ramBudget ? "cpu" : "no_fit";
    }
  }

  if (level === "no_fit") {
    return { ...base, level, gpuFraction, tokensPerSec: null, speedClass: null };
  }

  // 1トークン生成ごとに (アクティブな) 重みを1回読むと仮定し、実効帯域で割る
  const activeRatio =
    m.paramsActive && m.paramsTotal && m.paramsActive < m.paramsTotal ? m.paramsActive / m.paramsTotal : 1;
  const bytesPerToken = w * activeRatio;
  const gpuBw = p.gpuBandwidth * 1e9 * 0.7;
  const cpuBw = p.cpuBandwidth * 1e9 * 0.6;
  let seconds = 0;
  if (gpuFraction > 0 && gpuBw > 0) seconds += (bytesPerToken * gpuFraction) / gpuBw;
  if (gpuFraction < 1) seconds += (bytesPerToken * (1 - gpuFraction)) / cpuBw;
  const tokensPerSec = seconds > 0 ? 1 / seconds : null;

  return {
    ...base,
    level,
    gpuFraction,
    tokensPerSec,
    speedClass: tokensPerSec ? speedClassOf(tokensPerSec, minTps) : null,
  };
}

const LEVEL_RANK: Record<FitLevel, number> = { full_gpu: 3, partial: 2, cpu: 1, no_fit: 0, unsupported: -1 };

export function isRunnable(f: FitResult): boolean {
  return LEVEL_RANK[f.level] > 0;
}

export interface QuantChoice {
  quant: string;
  /** 候補を識別するための任意ID (ファイルグループのキーなど) */
  id?: string;
  quality: number;
  fit: FitResult;
}

/**
 * 候補の量子化の中から、このマシンで最も良いものを選ぶ。
 * 速度が最低ラインを満たす中で品質が最も高いもの、なければ最も速く動くもの。
 */
export function pickBestQuant(
  p: MachineProfile,
  candidates: { quant: string; weightsBytes: number; id?: string }[],
  base: Omit<ModelSpec, "weightsBytes">,
  ctx: number,
  minTps: number,
): QuantChoice | null {
  const evaluated: QuantChoice[] = candidates
    .map((c) => ({
      quant: c.quant,
      id: c.id,
      quality: quantSpec(c.quant)?.quality ?? 0.9,
      fit: estimateFit(p, { ...base, weightsBytes: c.weightsBytes }, ctx, minTps),
    }))
    .filter((c) => isRunnable(c.fit));
  if (evaluated.length === 0) return null;
  // 品質低下の大きい2bit以下は、他に選択肢がない場合のみ選ぶ
  const good = evaluated.filter((c) => (c.fit.tokensPerSec ?? 0) >= minTps && c.quality >= 0.8);
  if (good.length > 0) {
    // 品質差がわずかなら、GPUに全て載る (大幅に速い) 方を優先する
    const bonus: Record<FitLevel, number> = { full_gpu: 0.05, partial: 0, cpu: -0.02, no_fit: 0, unsupported: 0 };
    const value = (c: QuantChoice) => c.quality + bonus[c.fit.level];
    return good.sort((a, b) => value(b) - value(a))[0];
  }
  return evaluated.sort((a, b) => (b.fit.tokensPerSec ?? 0) - (a.fit.tokensPerSec ?? 0))[0];
}

/** パラメータ数から量子化ごとのファイルサイズを推定する (一覧表示用) */
export function estimatedQuantSizes(paramsTotal: number): { quant: string; weightsBytes: number }[] {
  return CANDIDATE_QUANTS.map((q) => ({
    quant: q,
    weightsBytes: (paramsTotal * (quantSpec(q)?.bpw ?? 4.85)) / 8,
  }));
}
