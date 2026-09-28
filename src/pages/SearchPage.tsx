import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import { CapabilityIcon } from "../components/CapabilityIcons";
import { ModelTable, useQuickFits } from "../components/ModelTable";
import { api, errorMessage } from "../lib/api";
import { CAPABILITIES, type Capability } from "../lib/capabilities";
import { isRunnable } from "../lib/estimate";
import { buildListQuery, toSummary, type ModelSummary } from "../lib/hfmodel";

export interface SearchFilters {
  query: string;
  formats: string[];
  sort: string;
  task: string;
  size: string;
  fitsOnly: boolean;
  caps: Capability[];
  llmOnly: boolean;
}

const DEFAULT_FILTERS: SearchFilters = {
  query: "",
  formats: ["gguf"],
  sort: "trendingScore",
  task: "",
  size: "all",
  fitsOnly: false,
  caps: [],
  llmOnly: true,
};

const SORTS = ["trendingScore", "downloads", "likes", "lastModified", "createdAt"] as const;
const TASKS = ["", "text-generation", "image-text-to-text", "feature-extraction", "sentence-similarity"] as const;
const SIZES: Record<string, [number, number]> = {
  all: [0, Infinity],
  tiny: [0, 4e9],
  small: [4e9, 10e9],
  medium: [10e9, 35e9],
  large: [35e9, 80e9],
  huge: [80e9, Infinity],
};
const FORMATS = ["gguf", "mlx", "safetensors"] as const;

function sortModels(list: ModelSummary[], sort: string): ModelSummary[] {
  const key: Record<string, (m: ModelSummary) => number> = {
    trendingScore: (m) => m.trendingScore,
    downloads: (m) => m.downloads,
    likes: (m) => m.likes,
    lastModified: (m) => (m.lastModified ? Date.parse(m.lastModified) : 0),
    createdAt: (m) => (m.createdAt ? Date.parse(m.createdAt) : 0),
  };
  const f = key[sort] ?? key.trendingScore;
  return [...list].sort((a, b) => f(b) - f(a));
}

export function SearchPage() {
  const { t, pageParams, addHistory, profile } = useApp();
  const [filters, setFilters] = useState<SearchFilters>(() => ({
    ...DEFAULT_FILTERS,
    formats: profile?.appleSilicon ? ["gguf", "mlx"] : ["gguf"],
  }));
  const [limit, setLimit] = useState(50);
  const [results, setResults] = useState<ModelSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (f: SearchFilters, lim: number, record: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const formats = f.formats.length > 0 ? f.formats : ["gguf"];
        const lists = await Promise.all(
          formats.map((fmt) =>
            api.listModels(
              buildListQuery({
                search: f.query.trim() || undefined,
                filters: [fmt],
                pipelineTag: f.task || undefined,
                sort: f.sort,
                limit: lim,
              }),
            ),
          ),
        );
        const seen = new Set<string>();
        const merged = (lists.flat() as Record<string, unknown>[])
          .map(toSummary)
          .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
        setResults(sortModels(merged, f.sort));
        if (record && f.query.trim()) addHistory(f.query.trim(), { ...f });
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [addHistory],
  );

  // 履歴からの再検索、または初回表示
  useEffect(() => {
    const fromHistory = pageParams?.filters as Partial<SearchFilters> | undefined;
    const f = fromHistory ? { ...DEFAULT_FILTERS, ...fromHistory } : filters;
    if (fromHistory) setFilters(f);
    setLimit(50);
    run(f, 50, false);
  }, [pageParams]);

  const fits = useQuickFits(results);
  const visible = useMemo(() => {
    const [lo, hi] = SIZES[filters.size] ?? SIZES.all;
    return results.filter((m) => {
      if (filters.llmOnly && !m.isLlm) return false;
      if ((filters.caps ?? []).some((c) => !m.capabilities.includes(c))) return false;
      if (filters.size !== "all") {
        if (!m.paramsTotal || m.paramsTotal < lo || m.paramsTotal >= hi) return false;
      }
      if (filters.fitsOnly) {
        const f = fits.get(m.id);
        if (!f?.choice || !isRunnable(f.choice.fit)) return false;
      }
      return true;
    });
  }, [results, filters.size, filters.fitsOnly, filters.llmOnly, filters.caps, fits]);

  const toggleCap = (c: Capability) =>
    update({ caps: (filters.caps ?? []).includes(c) ? filters.caps.filter((x) => x !== c) : [...(filters.caps ?? []), c] });

  const update = (patch: Partial<SearchFilters>, rerun = false) => {
    const f = { ...filters, ...patch };
    setFilters(f);
    if (rerun) {
      setLimit(50);
      run(f, 50, false);
    }
  };

  return (
    <div className="page">
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          setLimit(50);
          run(filters, 50, true);
        }}
      >
        <input
          autoFocus
          value={filters.query}
          placeholder={t("search.placeholder")}
          onChange={(e) => update({ query: e.target.value })}
        />
        <button className="btn primary" type="submit">
          <Search size={16} /> {t("search.button")}
        </button>
      </form>
      <div className="filters">
        <div className="filter">
          <span>{t("search.format")}</span>
          {FORMATS.map((f) => (
            <label key={f} className="chip-check">
              <input
                type="checkbox"
                checked={filters.formats.includes(f)}
                onChange={(e) =>
                  update(
                    { formats: e.target.checked ? [...filters.formats, f] : filters.formats.filter((x) => x !== f) },
                    true,
                  )
                }
              />
              {f.toUpperCase()}
            </label>
          ))}
        </div>
        <label className="filter">
          <span>{t("search.sort")}</span>
          <select value={filters.sort} onChange={(e) => update({ sort: e.target.value }, true)}>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`search.sort.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span>{t("search.task")}</span>
          <select value={filters.task} onChange={(e) => update({ task: e.target.value }, true)}>
            {TASKS.map((s) => (
              <option key={s} value={s}>
                {t(`search.task.${s || "all"}` as "search.task.all")}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span>{t("search.size")}</span>
          <select value={filters.size} onChange={(e) => update({ size: e.target.value })}>
            {Object.keys(SIZES).map((s) => (
              <option key={s} value={s}>
                {t(`search.size.${s}` as "search.size.all")}
              </option>
            ))}
          </select>
        </label>
        <label className="filter chip-check">
          <input type="checkbox" checked={filters.fitsOnly} onChange={(e) => update({ fitsOnly: e.target.checked })} />
          {t("search.fitsOnly")}
        </label>
        <label className="filter chip-check">
          <input type="checkbox" checked={filters.llmOnly} onChange={(e) => update({ llmOnly: e.target.checked })} />
          {t("search.llmOnly")}
        </label>
      </div>
      <div className="filters caps-filter" title={t("search.capsHint")}>
        <span className="muted">{t("search.caps")}</span>
        {CAPABILITIES.map((c) => (
          <button
            key={c}
            type="button"
            className={`chip cap-chip cap-${c} ${(filters.caps ?? []).includes(c) ? "active" : ""}`}
            title={t(`capDesc.${c}`)}
            onClick={() => toggleCap(c)}
          >
            <CapabilityIcon cap={c} />
            {t(`cap.${c}`)}
          </button>
        ))}
      </div>
      <p className="muted small">{t("search.hint")}</p>
      {error && <p className="error">{error}</p>}
      {loading && results.length === 0 ? <p className="muted">{t("common.loading")}</p> : <ModelTable models={visible} />}
      {results.length >= limit && (
        <div className="center">
          <button
            className="btn"
            disabled={loading}
            onClick={() => {
              const n = limit + 50;
              setLimit(n);
              run(filters, n, false);
            }}
          >
            {loading ? t("common.loading") : t("common.loadMore")}
          </button>
        </div>
      )}
    </div>
  );
}
