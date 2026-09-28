import { confirm } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertTriangle, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useApp } from "../AppContext";
import { api, errorMessage } from "../lib/api";
import { formatBytes, formatCount, relativeTime } from "../lib/format";
import type { LocalRepo, TrackingInfo } from "../lib/types";

export function hasUpdates(t: TrackingInfo | null | undefined): boolean {
  if (!t) return false;
  return t.changedFiles.length > 0 || !!t.newVersion || t.successors.length > 0 || t.derivatives.length > 0;
}

export function LibraryPage() {
  const { t, lang, settings, library, reloadLibrary, checkUpdates, checking, navigate } = useApp();
  const [filter, setFilter] = useState<"all" | "updates">("all");

  const total = library.reduce((s, r) => s + r.totalSize, 0);
  const lastChecked = useMemo(() => {
    const times = library
      .map((r) => r.record?.tracking?.checkedAt)
      .filter((x): x is string => !!x)
      .sort();
    return times[times.length - 1] ?? null;
  }, [library]);
  const visible = filter === "updates" ? library.filter((r) => hasUpdates(r.record?.tracking)) : library;

  if (!settings.modelsDir) {
    return (
      <div className="page">
        <p className="banner">
          {t("banner.noModelsDir")}{" "}
          <button className="btn small" onClick={() => navigate("settings")}>
            {t("banner.openSettings")}
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="muted small">{t("lib.dir")}</div>
          <code>{settings.modelsDir}</code>
          <div className="muted small">{t("lib.total", { size: formatBytes(total), count: library.length })}</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => openPath(settings.modelsDir!)}>
            <FolderOpen size={14} /> {t("lib.openDir")}
          </button>
          <button className="btn" onClick={() => reloadLibrary()}>
            <RefreshCw size={14} /> {t("lib.rescan")}
          </button>
          <button className="btn primary" disabled={checking} onClick={() => checkUpdates()}>
            <RefreshCw size={14} className={checking ? "spin" : ""} /> {checking ? t("lib.checking") : t("lib.checkUpdates")}
          </button>
        </div>
      </div>
      {lastChecked && <p className="muted small">{t("lib.lastChecked", { time: relativeTime(lastChecked, lang) })}</p>}
      <div className="chips">
        {(["all", "updates"] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
            {t(`lib.filter.${f}`)}
          </button>
        ))}
      </div>
      {visible.length === 0 && <p className="empty">{t("lib.empty")}</p>}
      <div className="lib-list">
        {visible.map((r) => (
          <RepoCard key={r.repoId} repo={r} />
        ))}
      </div>
    </div>
  );
}

function RepoCard({ repo }: { repo: LocalRepo }) {
  const { t, lang, openModel, notify, reloadLibrary, navigate } = useApp();
  const [busy, setBusy] = useState(false);
  const [showDerivatives, setShowDerivatives] = useState(false);
  const rec = repo.record;
  const tr = rec?.tracking ?? null;

  const del = async (file: string | null) => {
    const target = file ? `${repo.repoId}/${file}` : repo.repoId;
    if (!(await confirm(t("common.confirmDelete", { target }), { kind: "warning" }))) return;
    try {
      await api.libraryDelete(repo.repoId, file);
      await reloadLibrary();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const track = async () => {
    setBusy(true);
    try {
      await api.libraryTrack(repo.repoId);
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card lib-card">
      <div className="lib-head">
        <div>
          <button className="link model-name" onClick={() => openModel(repo.repoId)}>
            {repo.repoId}
          </button>
          <div className="muted small">
            <span className={`badge fmt-${repo.format}`}>{repo.format.toUpperCase()}</span> {formatBytes(repo.totalSize)}
            {rec?.createdAt && <> ・ {t("lib.published", { age: relativeTime(rec.createdAt, lang) })}</>}
            {rec && <> ・ {t("lib.saved", { age: relativeTime(rec.downloadedAt, lang) })}</>}
          </div>
        </div>
        <div className="actions">
          <button className="icon-btn" title={t("lib.reveal")} onClick={() => revealItemInDir(repo.dir)}>
            <FolderOpen size={16} />
          </button>
          <button className="icon-btn danger" title={t("lib.deleteRepo")} onClick={() => del(null)}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <ul className="plain files-list">
        {repo.files.map((f) => (
          <li key={f.path}>
            <span className="mono">{f.path}</span>
            <span className="muted">{formatBytes(f.size)}</span>
            <button className="icon-btn danger" title={t("common.delete")} onClick={() => del(f.path)}>
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      {repo.incompleteFiles.length > 0 && (
        <p className="hint">
          {t("lib.incomplete", { files: repo.incompleteFiles.map((f) => f.path).join(", ") })}{" "}
          <button className="link" onClick={() => navigate("downloads")}>
            {t("nav.downloads")}
          </button>
        </p>
      )}

      {!rec ? (
        <div className="tracking">
          <span className="muted">{t("lib.untracked")}</span>{" "}
          <button className="btn small" disabled={busy} onClick={track}>
            {busy ? t("common.loading") : t("lib.track")}
          </button>
        </div>
      ) : (
        <div className="tracking">
          {rec.baselineOnly && <div className="muted small">{t("lib.baseline")}</div>}
          {tr?.error && <div className="error small">{t("lib.trackError", { error: tr.error })}</div>}
          {tr?.changedFiles.length ? (
            <div className="alert">
              <AlertTriangle size={14} /> {t("lib.filesChanged", { files: tr.changedFiles.join(", ") })}
            </div>
          ) : null}
          {tr?.removedFiles.length ? (
            <div className="muted small">{t("lib.filesRemoved", { files: tr.removedFiles.join(", ") })}</div>
          ) : null}
          {tr?.repoUpdated && !tr.changedFiles.length && (
            <div className="muted small">
              {t("lib.repoUpdated")} ({relativeTime(tr.latestLastModified, lang)})
            </div>
          )}
          {tr?.newVersion && (
            <div className="alert info">
              {t("lib.newVersion", { id: "" })}
              <button className="link" onClick={() => openModel(tr.newVersion!)}>
                {tr.newVersion}
              </button>
            </div>
          )}
          {tr && tr.successors.length > 0 && (
            <div>
              <div className="small strong">{t("lib.successors")}</div>
              <div className="tags">
                {tr.successors.map((s) => (
                  <button key={s.id} className="tag link" onClick={() => openModel(s.id)}>
                    {s.id} <span className="muted">{relativeTime(s.createdAt, lang)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {tr && tr.derivatives.length > 0 && (
            <div>
              <button className="link small strong" onClick={() => setShowDerivatives(!showDerivatives)}>
                {showDerivatives ? "▾" : "▸"} {t("lib.derivatives", { count: tr.derivatives.length })}
              </button>
              {showDerivatives && (
                <ul className="plain">
                  {tr.derivatives.map((d) => (
                    <li key={d.id}>
                      <button className="link" onClick={() => openModel(d.id)}>
                        {d.id}
                      </button>
                      {d.relation && (
                        <span className="tag">{t(`lib.relation.${d.relation}` as "lib.relation.quantized")}</span>
                      )}
                      <span className="muted small">
                        {relativeTime(d.createdAt, lang)} ・ DL {formatCount(d.downloads)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {tr && !tr.error && !hasUpdates(tr) && !tr.repoUpdated && (
            <div className="muted small">
              {t("lib.upToDate")} ({relativeTime(tr.checkedAt, lang)})
            </div>
          )}
        </div>
      )}
    </div>
  );
}
