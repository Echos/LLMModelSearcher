import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useApp } from "../AppContext";
import { formatBytes } from "../lib/format";

export function SystemPage() {
  const { t, hw, profile, refreshHardware } = useApp();
  const [busy, setBusy] = useState(false);

  if (!hw || !profile) return <div className="page muted">{t("common.loading")}</div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t("sys.title")}</h1>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await refreshHardware();
            setBusy(false);
          }}
        >
          <RefreshCw size={14} className={busy ? "spin" : ""} /> {t("sys.detect")}
        </button>
      </div>
      <dl className="kv">
        <div>
          <dt>{t("sys.os")}</dt>
          <dd>
            {hw.osVersion || hw.os} ({hw.arch})
          </dd>
        </div>
        <div>
          <dt>{t("sys.cpu")}</dt>
          <dd>
            {hw.cpuBrand} <span className="muted">{t("sys.cores", { cores: hw.cpuCores, threads: hw.cpuThreads })}</span>
          </dd>
        </div>
        <div>
          <dt>{t("sys.ram")}</dt>
          <dd>{t("sys.ramDetail", { total: formatBytes(hw.ramTotal), avail: formatBytes(hw.ramAvailable) })}</dd>
        </div>
        <div>
          <dt>{t("sys.memType")}</dt>
          <dd>
            {[hw.memoryType, hw.memorySpeedMts ? `${hw.memorySpeedMts} MT/s` : null, hw.memoryModules ? `x${hw.memoryModules}` : null]
              .filter(Boolean)
              .join(" ") || "-"}
          </dd>
        </div>
        <div>
          <dt>{t("sys.gpus")}</dt>
          <dd>
            {hw.gpus.length === 0 && t("common.none")}
            <ul className="plain">
              {hw.gpus.map((g, i) => (
                <li key={`${g.name}-${i}`}>
                  <strong>{g.name}</strong> <span className="tag">{t(`sys.kind.${g.kind}`)}</span>{" "}
                  {g.vramTotal ? t("sys.vram", { total: formatBytes(g.vramTotal) }) : ""}{" "}
                  {g.vramFree ? <span className="muted">{t("sys.vramFree", { free: formatBytes(g.vramFree) })}</span> : null}
                  {g.driver && <span className="muted small"> driver {g.driver}</span>}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>{t("sys.backends")}</dt>
          <dd>
            {hw.backends.map((b) => (
              <span key={b} className="tag">
                {b}
              </span>
            ))}
          </dd>
        </div>
      </dl>
      <h2>{t("sys.profile")}</h2>
      <dl className="kv">
        <div>
          <dt>{t("sys.usableGpu")}</dt>
          <dd>
            {formatBytes(profile.gpuMemory)} {profile.gpuName && <span className="muted">({profile.gpuName})</span>}
          </dd>
        </div>
        <div>
          <dt>{t("sys.gpuBw")}</dt>
          <dd>{profile.gpuBandwidth ? `${profile.gpuBandwidth} GB/s` : "-"}</dd>
        </div>
        <div>
          <dt>{t("sys.cpuBw")}</dt>
          <dd>{profile.cpuBandwidth.toFixed(0)} GB/s</dd>
        </div>
      </dl>
      <p className="muted small">{t("sys.overrideHint")}</p>
    </div>
  );
}
