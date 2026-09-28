import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../AppContext";
import { CapabilityIcons } from "../components/CapabilityIcons";
import { FitBadge, SpeedBadge } from "../components/FitBadge";
import { errorMessage } from "../lib/api";
import { formatBytes, formatCount, formatParams, relativeTime } from "../lib/format";
import { recommend, USE_CASES, type Recommendation, type UseCase } from "../lib/recommend";

export function RecommendPage() {
  const { t, lang, profile, settings, openModel } = useApp();
  const [useCase, setUseCase] = useState<UseCase>("chat");
  const [items, setItems] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, Recommendation[]>());

  const ctx = settings.defaultContextLength;
  const minTps = settings.minTokensPerSec;

  const load = useCallback(
    async (uc: UseCase, force = false) => {
      if (!profile) return;
      const key = `${uc}:${ctx}:${minTps}:${profile.gpuMemory}:${profile.gpuBandwidth}:${profile.cpuBandwidth}`;
      if (!force && cache.current.has(key)) {
        setItems(cache.current.get(key)!);
        return;
      }
      setItems(null);
      setError(null);
      try {
        const r = await recommend(uc, profile, ctx, minTps);
        cache.current.set(key, r);
        setItems(r);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [profile, ctx, minTps],
  );

  useEffect(() => {
    load(useCase);
  }, [useCase, load]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t("rec.title")}</h1>
        <button className="btn" onClick={() => load(useCase, true)}>
          <RefreshCw size={14} /> {t("common.refresh")}
        </button>
      </div>
      {profile && (
        <p className="muted">
          {t("rec.machine", {
            gpu: profile.gpuName ?? t("rec.noGpu"),
            vram: formatBytes(profile.gpuMemory),
            ram: formatBytes(profile.ramTotal),
            ctx: ctx.toLocaleString(),
          })}
        </p>
      )}
      <div className="chips">
        {USE_CASES.map((u) => (
          <button key={u} className={`chip ${u === useCase ? "active" : ""}`} onClick={() => setUseCase(u)}>
            {t(`rec.useCase.${u}`)}
          </button>
        ))}
      </div>
      <p className="muted small">{t("rec.note")}</p>
      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted">{t("common.loading")}</p>}
      {items && items.length === 0 && <p className="empty">{t("common.noResults")}</p>}
      <div className="cards">
        {items?.map((r, i) => (
          <div key={r.model.id} className="card clickable" onClick={() => openModel(r.model.id)}>
            <div className="card-rank">{i + 1}</div>
            <div className="card-main">
              <div className="model-name">
                {r.model.name}
                <CapabilityIcons caps={r.model.capabilities} />
              </div>
              <div className="model-author">
                {r.model.author} ・ {formatParams(r.model.paramsTotal)}
                {r.model.paramsActive ? ` (A${formatParams(r.model.paramsActive)})` : ""} ・{" "}
                {r.model.format.toUpperCase()} ・ {relativeTime(r.model.createdAt, lang)} ・ DL {formatCount(r.model.downloads)}
              </div>
              <div className="card-fit">
                <span className="quant">{r.choice.quant}</span>
                <span className="muted">{formatBytes(r.choice.fit.weightsBytes)}</span>
                <FitBadge level={r.choice.fit.level} unified={profile?.unified} />
                <SpeedBadge tps={r.choice.fit.tokensPerSec} cls={r.choice.fit.speedClass} />
              </div>
              <div className="reasons">
                {r.reasons.map((k) => (
                  <span key={k} className="tag">
                    {t(`rec.reason.${k}`)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
