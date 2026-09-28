// 一覧表示用: パラメータ数だけから最適な量子化と適合度を推定する

import { estimateFit, estimatedQuantSizes, pickBestQuant, type FitLevel, type MachineProfile, type QuantChoice } from "./estimate";
import type { ModelSummary } from "./hfmodel";
import { quantSpec } from "./quant";

export interface QuickFit {
  choice: QuantChoice | null;
  level: FitLevel | null;
}

export function quickFit(m: ModelSummary, profile: MachineProfile, ctx: number, minTps: number): QuickFit {
  if (!m.paramsTotal) return { choice: null, level: null };
  const base = {
    format: m.format,
    paramsTotal: m.paramsTotal,
    paramsActive: m.paramsActive,
    kvBytesPerToken: null,
  };
  const candidates =
    m.format === "mlx" || m.format === "safetensors"
      ? [
          {
            quant: m.repoQuant ?? "BF16",
            weightsBytes: (m.paramsTotal * (quantSpec(m.repoQuant ?? "BF16")?.bpw ?? 16)) / 8,
          },
        ]
      : estimatedQuantSizes(m.paramsTotal);
  const choice = pickBestQuant(profile, candidates, base, ctx, minTps);
  if (choice) return { choice, level: choice.fit.level };
  // 動かない場合は、最小の候補での判定結果 (メモリ不足 / 非対応) を返す
  const smallest = candidates[candidates.length - 1];
  const fit = estimateFit(profile, { ...base, weightsBytes: smallest.weightsBytes }, ctx, minTps);
  return { choice: null, level: fit.level };
}
