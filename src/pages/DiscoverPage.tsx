import { useEffect, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import { ModelTable, useQuickFits } from "../components/ModelTable";
import { api, errorMessage } from "../lib/api";
import { isRunnable } from "../lib/estimate";
import { buildListQuery, toSummary, type ModelSummary } from "../lib/hfmodel";

type Mode = "trending" | "new" | "recentlyUpdated";
const SORT: Record<Mode, string> = { trending: "trendingScore", new: "createdAt", recentlyUpdated: "lastModified" };

export function DiscoverPage() {
  const { t, profile } = useApp();
  const [mode, setMode] = useState<Mode>("trending");
  const [task, setTask] = useState("text-generation");
  const [fitsOnly, setFitsOnly] = useState(true);
  const [items, setItems] = useState<ModelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    setError(null);
    const formats = profile?.appleSilicon ? ["gguf", "mlx"] : ["gguf"];
    Promise.all(
      formats.map((f) =>
        api.listModels(buildListQuery({ filters: [f], pipelineTag: task || undefined, sort: SORT[mode], limit: 80 })),
      ),
    )
      .then((lists) => {
        const all = (lists.flat() as Record<string, unknown>[]).map(toSummary);
        const key = (m: ModelSummary) =>
          mode === "trending" ? m.trendingScore : Date.parse((mode === "new" ? m.createdAt : m.lastModified) ?? "") || 0;
        setItems(all.sort((a, b) => key(b) - key(a)));
      })
      .catch((e) => setError(errorMessage(e)));
  }, [mode, task, profile?.appleSilicon]);

  const fits = useQuickFits(items ?? []);
  const visible = useMemo(
    () =>
      (items ?? []).filter((m) => {
        if (!m.isLlm) return false;
        if (!fitsOnly) return true;
        const f = fits.get(m.id);
        return !!f?.choice && isRunnable(f.choice.fit);
      }),
    [items, fits, fitsOnly],
  );

  return (
    <div className="page">
      <div className="chips">
        {(["trending", "new", "recentlyUpdated"] as Mode[]).map((m) => (
          <button key={m} className={`chip ${m === mode ? "active" : ""}`} onClick={() => setMode(m)}>
            {t(`discover.${m}`)}
          </button>
        ))}
        <select value={task} onChange={(e) => setTask(e.target.value)}>
          {["", "text-generation", "image-text-to-text", "feature-extraction"].map((s) => (
            <option key={s} value={s}>
              {t(`search.task.${s || "all"}` as "search.task.all")}
            </option>
          ))}
        </select>
        <label className="chip-check">
          <input type="checkbox" checked={fitsOnly} onChange={(e) => setFitsOnly(e.target.checked)} />
          {t("search.fitsOnly")}
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {!items && !error ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <ModelTable models={visible} dateField={mode === "new" ? "createdAt" : "lastModified"} />
      )}
    </div>
  );
}
