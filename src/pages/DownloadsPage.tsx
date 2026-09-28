import { Pause, Play, RotateCcw, X } from "lucide-react";
import { useApp } from "../AppContext";
import { api, errorMessage } from "../lib/api";
import { formatBytes, formatDuration } from "../lib/format";
import type { DownloadTask } from "../lib/types";

export function DownloadsPage() {
  const { t, downloads, notify } = useApp();
  const call = (p: Promise<void>) => p.catch((e) => notify(errorMessage(e), "error"));
  const hasFinished = downloads.some((d) => d.status === "completed" || d.status === "canceled");

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t("nav.downloads")}</h1>
        <button className="btn" disabled={!hasFinished} onClick={() => call(api.downloadClear())}>
          {t("dl.clearFinished")}
        </button>
      </div>
      {downloads.length === 0 && <p className="empty">{t("dl.empty")}</p>}
      <div className="dl-list">
        {[...downloads].reverse().map((d) => (
          <Row key={d.id} d={d} call={call} />
        ))}
      </div>
    </div>
  );
}

function Row({ d, call }: { d: DownloadTask; call: (p: Promise<void>) => void }) {
  const { t, openModel } = useApp();
  const pct = d.size ? Math.min((d.downloaded / d.size) * 100, 100) : 0;
  const eta = d.speed > 0 ? (d.size - d.downloaded) / d.speed : 0;
  const active = d.status === "downloading" || d.status === "verifying" || d.status === "queued";
  return (
    <div className={`card dl-row status-${d.status}`}>
      <div className="dl-head">
        <div>
          <button className="link" onClick={() => openModel(d.repoId)}>
            {d.repoId}
          </button>
          <div className="mono small">{d.path}</div>
        </div>
        <div className="actions">
          <span className={`badge st-${d.status}`}>{t(`dl.status.${d.status}`)}</span>
          {active && d.status !== "verifying" && (
            <button className="icon-btn" title={t("dl.pause")} onClick={() => call(api.downloadPause(d.id))}>
              <Pause size={16} />
            </button>
          )}
          {d.status === "paused" && (
            <button className="icon-btn" title={t("dl.resume")} onClick={() => call(api.downloadResume(d.id))}>
              <Play size={16} />
            </button>
          )}
          {d.status === "failed" && (
            <button className="icon-btn" title={t("dl.retry")} onClick={() => call(api.downloadResume(d.id))}>
              <RotateCcw size={16} />
            </button>
          )}
          {d.status !== "completed" && d.status !== "canceled" && (
            <button className="icon-btn danger" title={t("dl.cancel")} onClick={() => call(api.downloadCancel(d.id))}>
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="progress">
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="muted small dl-meta">
        <span>
          {formatBytes(d.downloaded)} / {formatBytes(d.size)} ({pct.toFixed(1)}%)
        </span>
        {d.status === "downloading" && d.speed > 0 && (
          <span>
            {formatBytes(d.speed)}/s ・ {t("dl.remaining", { eta: formatDuration(eta) })}
          </span>
        )}
      </div>
      {d.error && <div className="error small">{d.error}</div>}
    </div>
  );
}
