import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink, Lock, Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import { api, errorMessage } from "../lib/api";
import { estimateFit, pickBestQuant, type FitResult, type ModelSpec } from "../lib/estimate";
import { formatBytes, formatCount, formatDate, formatParams, relativeTime } from "../lib/format";
import { buildListQuery, filesFromInfo, hfUrl, toSummary, type ModelSummary } from "../lib/hfmodel";
import { groupGgufFiles, safetensorsBundle, type FileGroup } from "../lib/quant";
import type { ModelArch } from "../lib/types";
import { CAPABILITIES, type Capability } from "../lib/capabilities";
import { CapabilityIcons, CapabilityList } from "./CapabilityIcons";
import { FitBadge, SpeedBadge } from "./FitBadge";
import { Markdown } from "./Markdown";
import { ModelTable } from "./ModelTable";

type Tab = "files" | "overview" | "readme" | "related";

const CONTEXT_OPTIONS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];

export function ModelDetail({ repoId }: { repoId: string }) {
  const { t, lang, openModel, favorites, toggleFavorite, settings, notify, navigate } = useApp();
  const [info, setInfo] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("files");
  const [arch, setArch] = useState<ModelArch | null>(null);
  const [ctx, setCtx] = useState(settings.defaultContextLength);
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    setInfo(null);
    setError(null);
    setArch(null);
    setTab("files");
    api
      .modelInfo(repoId)
      .then(setInfo)
      .catch((e) => setError(errorMessage(e)));
    api.tokenStatus().then(setHasToken).catch(() => undefined);
  }, [repoId]);

  const summary: ModelSummary | null = useMemo(() => (info ? toSummary(info) : null), [info]);
  const files = useMemo(() => (info ? filesFromInfo(info) : []), [info]);
  const groups = useMemo(() => {
    if (!summary) return { model: [] as FileGroup[], mmproj: [] as FileGroup[] };
    if (summary.format === "gguf") {
      const all = groupGgufFiles(files);
      return { model: all.filter((g) => !g.isMmproj), mmproj: all.filter((g) => g.isMmproj) };
    }
    const b = safetensorsBundle(files);
    return { model: b ? [{ ...b, quant: summary.repoQuant, label: summary.repoQuant ?? t("detail.bundle") }] : [], mmproj: [] };
  }, [summary, files, t]);

  // KVキャッシュ見積もりのための構造情報 (GGUFヘッダまたは config.json)
  useEffect(() => {
    if (!summary) return;
    const smallest = [...groups.model].sort((a, b) => a.totalSize - b.totalSize)[0];
    const file = summary.format === "gguf" ? smallest?.files[0]?.path ?? null : null;
    if (summary.format === "gguf" && !file) return;
    let cancelled = false;
    api
      .modelArch(repoId, file)
      .then((a) => !cancelled && setArch(a))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repoId, summary, groups.model]);

  if (error) {
    return (
      <Shell repoId={repoId} onClose={() => openModel(null)}>
        <p className="error">{error}</p>
      </Shell>
    );
  }
  if (!info || !summary) {
    return (
      <Shell repoId={repoId} onClose={() => openModel(null)}>
        <p className="muted">{t("common.loading")}</p>
      </Shell>
    );
  }

  const maxCtx = arch?.contextLength ?? summary.contextLength ?? null;
  const fav = favorites.has(repoId);

  return (
    <Shell repoId={repoId} onClose={() => openModel(null)}>
      <div className="detail-actions">
        <button className="btn" onClick={() => toggleFavorite(repoId)}>
          <Star size={14} fill={fav ? "currentColor" : "none"} />
          {fav ? t("detail.unfavorite") : t("detail.favorite")}
        </button>
        <button className="btn" onClick={() => openUrl(hfUrl(repoId))}>
          <ExternalLink size={14} />
          {t("common.openHf")}
        </button>
        <span className={`badge fmt-${summary.format}`}>{summary.format.toUpperCase()}</span>
        <CapabilityIcons caps={summary.capabilities} size={16} />
        {summary.gated && (
          <span className="badge warn">
            <Lock size={12} /> {t("detail.gated")}
          </span>
        )}
      </div>
      {summary.gated && !hasToken && <p className="hint warn-text">{t("detail.gatedHint")}</p>}

      <div className="tabs">
        {(["files", "overview", "readme", "related"] as Tab[]).map((k) => (
          <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {t(`detail.${k}`)}
          </button>
        ))}
      </div>

      {tab === "files" && (
        <FilesTab
          repoId={repoId}
          info={info}
          summary={summary}
          groups={groups}
          arch={arch}
          ctx={ctx}
          setCtx={setCtx}
          maxCtx={maxCtx}
          onNeedDir={() => {
            notify(t("banner.noModelsDir"), "error");
            openModel(null);
            navigate("settings");
          }}
        />
      )}
      {tab === "overview" && (
        <Overview summary={summary} arch={arch} info={info} lang={lang} hasMmproj={groups.mmproj.length > 0} />
      )}
      {tab === "readme" && <Readme repoId={repoId} />}
      {tab === "related" && <Related repoId={repoId} />}
    </Shell>
  );
}

function Shell({ repoId, onClose, children }: { repoId: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-header">
          <div>
            <div className="model-author">{repoId.split("/")[0]}</div>
            <h2>{repoId.split("/")[1]}</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

function activeParams(summary: ModelSummary, arch: ModelArch | null, total: number | null): number | null {
  if (summary.paramsActive) return summary.paramsActive;
  if (total && arch?.expertCount && arch.expertUsedCount && arch.expertCount > 1) {
    // 共有部分を約1割と仮定した概算
    return total * (0.1 + (0.9 * arch.expertUsedCount) / arch.expertCount);
  }
  return null;
}

function FilesTab({
  repoId,
  info,
  summary,
  groups,
  arch,
  ctx,
  setCtx,
  maxCtx,
  onNeedDir,
}: {
  repoId: string;
  info: Record<string, any>;
  summary: ModelSummary;
  groups: { model: FileGroup[]; mmproj: FileGroup[] };
  arch: ModelArch | null;
  ctx: number;
  setCtx: (n: number) => void;
  maxCtx: number | null;
  onNeedDir: () => void;
}) {
  const { t, profile, settings, downloads, library, notify } = useApp();
  const [withMmproj, setWithMmproj] = useState(true);

  const paramsTotal = summary.paramsTotal ?? arch?.parameterCount ?? null;
  const spec: Omit<ModelSpec, "weightsBytes"> = {
    format: summary.format,
    paramsTotal,
    paramsActive: activeParams(summary, arch, paramsTotal),
    kvBytesPerToken: arch?.kvBytesPerToken ?? null,
  };
  const minTps = settings.minTokensPerSec;

  const fits = useMemo(() => {
    const m = new Map<string, FitResult>();
    if (!profile) return m;
    for (const g of groups.model) m.set(g.key, estimateFit(profile, { ...spec, weightsBytes: g.totalSize }, ctx, minTps));
    return m;
  }, [profile, groups.model, ctx, minTps, spec.kvBytesPerToken, spec.paramsTotal, spec.paramsActive, spec.format]);

  const best = useMemo(() => {
    if (!profile) return null;
    return pickBestQuant(
      profile,
      groups.model.map((g) => ({ quant: g.quant ?? g.label, weightsBytes: g.totalSize, id: g.key })),
      spec,
      ctx,
      minTps,
    );
  }, [profile, groups.model, ctx, minTps, spec.kvBytesPerToken, spec.paramsTotal, spec.paramsActive, spec.format]);

  const localRepo = library.find((r) => r.repoId === repoId);
  const localPaths = new Set(localRepo?.files.map((f) => f.path) ?? []);
  const taskMap = new Map(downloads.filter((d) => d.repoId === repoId).map((d) => [d.path, d]));

  const preferredMmproj =
    groups.mmproj.find((g) => /F16/i.test(g.label) && !/BF16/i.test(g.label)) ?? groups.mmproj[0] ?? null;

  const startDownload = async (g: FileGroup, includeMmproj: boolean) => {
    if (!settings.modelsDir) return onNeedDir();
    const fileList = [...g.files];
    if (includeMmproj && preferredMmproj) fileList.push(...preferredMmproj.files);
    try {
      await api.downloadEnqueue(
        repoId,
        info.sha ?? "main",
        fileList.filter((f) => !localPaths.has(f.path)).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
        {
          format: summary.format,
          createdAt: summary.createdAt,
          lastModified: summary.lastModified,
          baseModels: summary.baseModels,
        },
      );
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const ctxOptions = CONTEXT_OPTIONS.filter((c) => !maxCtx || c <= maxCtx);
  if (!ctxOptions.includes(ctx)) ctxOptions.push(ctx);
  ctxOptions.sort((a, b) => a - b);

  const groupStatus = (g: FileGroup) => {
    if (g.files.every((f) => localPaths.has(f.path))) return { kind: "done" as const };
    const tasks = g.files.map((f) => taskMap.get(f.path)).filter((x) => x);
    const active = tasks.filter((x) => x && !["completed", "canceled", "failed"].includes(x.status));
    if (active.length > 0) {
      const done = g.files.reduce((s, f) => {
        if (localPaths.has(f.path)) return s + f.size;
        return s + (taskMap.get(f.path)?.downloaded ?? 0);
      }, 0);
      return { kind: "progress" as const, pct: g.totalSize ? (done / g.totalSize) * 100 : 0 };
    }
    return { kind: "none" as const };
  };

  const kvNote = arch?.kvBytesPerToken
    ? t(arch.source === "gguf" ? "detail.kvSource.gguf" : "detail.kvSource.config")
    : t("detail.kvSource.fallback");

  return (
    <div>
      <div className="toolbar">
        <label>
          {t("detail.context")}{" "}
          <select value={ctx} onChange={(e) => setCtx(Number(e.target.value))}>
            {ctxOptions.map((c) => (
              <option key={c} value={c}>
                {c.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">{kvNote}</span>
      </div>
      {localRepo && <p className="hint">{t("detail.localNote")}</p>}
      {groups.model.length === 0 ? (
        <p className="empty">{t("detail.noFiles")}</p>
      ) : (
        <div className="table-wrap">
          <table className="files">
            <thead>
              <tr>
                <th>{t("col.bestQuant")}</th>
                <th className="num">{t("col.size")}</th>
                <th>{t("col.fit")}</th>
                <th className="num">{t("col.memory")}</th>
                <th className="num">{t("col.speed")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.model.map((g) => {
                const f = fits.get(g.key);
                const st = groupStatus(g);
                const isBest = best?.id === g.key;
                return (
                  <tr key={g.key} className={isBest ? "best" : ""}>
                    <td>
                      <strong>{g.label}</strong>
                      {g.files.length > 1 && <span className="muted small"> ({g.files.length} files)</span>}
                      {isBest && <span className="badge rec">{t("detail.recommended")}</span>}
                    </td>
                    <td className="num">{formatBytes(g.totalSize)}</td>
                    <td>
                      <FitBadge level={f?.level ?? null} unified={profile?.unified} />
                      {f && f.level === "partial" && !profile?.unified && (
                        <span className="muted small"> {t("detail.gpuShare", { pct: Math.round(f.gpuFraction * 100) })}</span>
                      )}
                    </td>
                    <td className="num" title={f ? t("detail.breakdown", { w: formatBytes(f.weightsBytes), kv: formatBytes(f.kvBytes), oh: formatBytes(f.overheadBytes) }) : ""}>
                      {f ? formatBytes(f.totalBytes) : "-"}
                      {f?.kvEstimated && <span className="muted small"> ({t("common.estimated")})</span>}
                    </td>
                    <td className="num">
                      <SpeedBadge tps={f?.tokensPerSec ?? null} cls={f?.speedClass ?? null} />
                    </td>
                    <td className="nowrap">
                      {st.kind === "done" ? (
                        <span className="badge local">{t("detail.downloaded")}</span>
                      ) : st.kind === "progress" ? (
                        <div className="mini-progress">
                          <div style={{ width: `${st.pct}%` }} />
                          <span>{st.pct.toFixed(0)}%</span>
                        </div>
                      ) : (
                        <button
                          className="btn primary small"
                          disabled={f?.level === "unsupported"}
                          onClick={() => startDownload(g, withMmproj)}
                        >
                          <Download size={14} /> {t("detail.download")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {groups.mmproj.length > 0 && (
        <div className="section">
          <h3>{t("detail.mmprojTitle")}</h3>
          <label className="check">
            <input type="checkbox" checked={withMmproj} onChange={(e) => setWithMmproj(e.target.checked)} />
            {t("detail.withMmproj")}
          </label>
          <ul className="plain">
            {groups.mmproj.map((g) => {
              const st = groupStatus(g);
              return (
                <li key={g.key}>
                  <span>
                    {g.label} <span className="muted">{formatBytes(g.totalSize)}</span>
                  </span>
                  {st.kind === "done" ? (
                    <span className="badge local">{t("detail.downloaded")}</span>
                  ) : st.kind === "progress" ? (
                    <span className="muted">{st.pct.toFixed(0)}%</span>
                  ) : (
                    <button className="btn small" onClick={() => startDownload(g, false)}>
                      <Download size={14} /> {t("detail.download")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="muted small">{t("detail.speedNote")}</p>
    </div>
  );
}

function Overview({
  summary,
  arch,
  info,
  lang,
  hasMmproj,
}: {
  summary: ModelSummary;
  arch: ModelArch | null;
  info: Record<string, any>;
  lang: string;
  hasMmproj: boolean;
}) {
  const { t, openModel } = useApp();
  const params = summary.paramsTotal ?? arch?.parameterCount ?? null;
  // 詳細情報で判明した特性 (mmprojの有無・MoE・長文脈) を一覧時の判定に加える
  const caps = new Set<Capability>(summary.capabilities);
  if (hasMmproj) caps.add("vision");
  if (arch?.expertCount && arch.expertCount > 1) caps.add("moe");
  if ((arch?.contextLength ?? 0) >= 128 * 1024) caps.add("longContext");
  const rows: [string, React.ReactNode][] = [
    [t("detail.capabilities"), <CapabilityList caps={CAPABILITIES.filter((c) => caps.has(c))} />],
    [t("detail.author"), summary.author],
    [t("detail.license"), summary.license ?? "-"],
    [t("detail.task"), summary.pipelineTag ?? "-"],
    [t("detail.architecture"), arch?.architecture ?? summary.architecture ?? "-"],
    [
      t("detail.params"),
      <>
        {formatParams(params)}
        {summary.paramsActive ? ` (A${formatParams(summary.paramsActive)})` : ""}
        {arch?.expertCount ? ` / experts ${arch.expertUsedCount ?? "?"}/${arch.expertCount}` : ""}
      </>,
    ],
    [t("detail.contextMax"), (arch?.contextLength ?? summary.contextLength)?.toLocaleString() ?? "-"],
    [
      t("detail.created"),
      <>
        {formatDate(summary.createdAt, lang)} <span className="muted">({t("detail.age", { age: relativeTime(summary.createdAt, lang) })})</span>
      </>,
    ],
    [t("detail.updated"), `${formatDate(summary.lastModified, lang)} (${relativeTime(summary.lastModified, lang)})`],
    [t("col.downloads"), formatCount(summary.downloads)],
    [t("col.likes"), formatCount(summary.likes)],
  ];
  return (
    <div>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        <div>
          <dt>{t("detail.baseModel")}</dt>
          <dd>
            {summary.baseModels.length === 0
              ? "-"
              : summary.baseModels.map((b) => (
                  <button key={b} className="link" onClick={() => openModel(b)}>
                    {b}
                  </button>
                ))}
          </dd>
        </div>
      </dl>
      <div className="tags">
        {(info.tags as string[] | undefined)
          ?.filter((x) => !x.startsWith("base_model:"))
          .map((x) => (
            <span key={x} className="tag">
              {x}
            </span>
          ))}
      </div>
    </div>
  );
}

function Readme({ repoId }: { repoId: string }) {
  const { t } = useApp();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .readme(repoId)
      .then(setText)
      .catch((e) => setError(errorMessage(e)));
  }, [repoId]);
  if (error) return <p className="error">{error}</p>;
  if (text === null) return <p className="muted">{t("common.loading")}</p>;
  if (!text.trim()) return <p className="empty">{t("detail.noReadme")}</p>;
  return <Markdown source={text} repoId={repoId} />;
}

function Related({ repoId }: { repoId: string }) {
  const { t } = useApp();
  const [items, setItems] = useState<ModelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .listModels(buildListQuery({ filters: [`base_model:${repoId}`], sort: "downloads", limit: 60 }))
      .then((r) => setItems((r as Record<string, unknown>[]).map(toSummary)))
      .catch((e) => setError(errorMessage(e)));
  }, [repoId]);
  if (error) return <p className="error">{error}</p>;
  if (!items) return <p className="muted">{t("common.loading")}</p>;
  const quantTag = `base_model:quantized:${repoId}`;
  const quantized = items.filter((m) => m.tags.includes(quantTag));
  const derived = items.filter((m) => !m.tags.includes(quantTag));
  return (
    <div>
      <h3>{t("detail.relatedQuantized")}</h3>
      <ModelTable models={quantized} />
      <h3>{t("detail.relatedDerived")}</h3>
      <ModelTable models={derived} />
    </div>
  );
}
