import { Heart, Lock, Star } from "lucide-react";
import { useMemo } from "react";
import { useApp } from "../AppContext";
import { formatCount, formatParams, relativeTime } from "../lib/format";
import type { ModelSummary } from "../lib/hfmodel";
import { quickFit, type QuickFit } from "../lib/quickfit";
import { CapabilityIcons } from "./CapabilityIcons";
import { FitBadge, SpeedBadge } from "./FitBadge";

export function useQuickFits(models: ModelSummary[]): Map<string, QuickFit> {
  const { profile, settings } = useApp();
  return useMemo(() => {
    const m = new Map<string, QuickFit>();
    if (!profile) return m;
    for (const x of models) {
      m.set(x.id, quickFit(x, profile, settings.defaultContextLength, settings.minTokensPerSec));
    }
    return m;
  }, [models, profile, settings.defaultContextLength, settings.minTokensPerSec]);
}

export function ModelTable({
  models,
  dateField = "lastModified",
}: {
  models: ModelSummary[];
  dateField?: "lastModified" | "createdAt";
}) {
  const { t, lang, openModel, favorites, toggleFavorite, profile, library } = useApp();
  const fits = useQuickFits(models);
  const local = useMemo(() => new Set(library.map((r) => r.repoId)), [library]);

  if (models.length === 0) return <p className="empty">{t("common.noResults")}</p>;

  return (
    <div className="table-wrap">
      <table className="models">
        <thead>
          <tr>
            <th />
            <th>{t("col.model")}</th>
            <th>{t("col.format")}</th>
            <th className="num">{t("col.params")}</th>
            <th>{t("col.bestQuant")}</th>
            <th>{t("col.fit")}</th>
            <th className="num">{t("col.speed")}</th>
            <th className="num">{t("col.downloads")}</th>
            <th className="num">{t("col.likes")}</th>
            <th>{dateField === "createdAt" ? t("col.created") : t("col.updated")}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const f = fits.get(m.id);
            const fav = favorites.has(m.id);
            return (
              <tr key={m.id} onClick={() => openModel(m.id)} className="clickable">
                <td>
                  <button
                    className={`icon-btn ${fav ? "active" : ""}`}
                    title={fav ? t("detail.unfavorite") : t("detail.favorite")}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(m.id);
                    }}
                  >
                    <Star size={16} fill={fav ? "currentColor" : "none"} />
                  </button>
                </td>
                <td className="model-cell">
                  <div className="model-name">
                    {m.name}
                    {m.gated && <Lock size={12} className="muted" />}
                    {local.has(m.id) && <span className="badge local">{t("detail.downloaded")}</span>}
                  </div>
                  <div className="model-author">
                    {m.author}
                    <CapabilityIcons caps={m.capabilities} />
                  </div>
                </td>
                <td>
                  <span className={`badge fmt-${m.format}`}>{m.format.toUpperCase()}</span>
                </td>
                <td className="num">
                  {formatParams(m.paramsTotal)}
                  {m.paramsActive ? <span className="muted"> (A{formatParams(m.paramsActive)})</span> : null}
                </td>
                <td>{f?.choice?.quant ?? "-"}</td>
                <td>
                  <FitBadge level={f?.level ?? null} unified={profile?.unified} />
                </td>
                <td className="num">
                  <SpeedBadge tps={f?.choice?.fit.tokensPerSec ?? null} cls={f?.choice?.fit.speedClass ?? null} />
                </td>
                <td className="num">{formatCount(m.downloads)}</td>
                <td className="num">
                  <Heart size={12} className="muted" /> {formatCount(m.likes)}
                </td>
                <td className="nowrap">{relativeTime(m[dateField], lang)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
