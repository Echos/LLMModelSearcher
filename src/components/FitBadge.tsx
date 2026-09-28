import { useApp } from "../AppContext";
import type { FitLevel, SpeedClass } from "../lib/estimate";
import { formatTps } from "../lib/format";

export function FitBadge({ level, unified }: { level: FitLevel | null; unified?: boolean }) {
  const { t } = useApp();
  if (!level) return <span className="muted">-</span>;
  const label = level === "partial" && unified ? t("fit.partialUnified") : t(`fit.${level}`);
  return <span className={`badge fit-${level}`}>{label}</span>;
}

export function SpeedBadge({ tps, cls }: { tps: number | null; cls: SpeedClass | null }) {
  const { t } = useApp();
  if (!tps || !cls) return <span className="muted">-</span>;
  return (
    <span className={`speed speed-${cls}`} title={t(`speed.${cls}`)}>
      {formatTps(tps)}
    </span>
  );
}
