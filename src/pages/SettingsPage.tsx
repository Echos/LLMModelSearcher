import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useApp } from "../AppContext";
import { api, errorMessage } from "../lib/api";
import type { Settings } from "../lib/types";

function numOrNull(v: string): number | null {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
}

export function SettingsPage() {
  const { t, settings, saveSettings, notify } = useApp();
  const [draft, setDraft] = useState<Settings>(settings);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);

  useEffect(() => setDraft(settings), [settings]);
  useEffect(() => {
    api.suggestModelsDir().then(setSuggested);
    api.tokenStatus().then(setHasToken);
  }, []);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    try {
      await saveSettings({
        ...draft,
        maxConcurrentDownloads: Math.min(Math.max(Math.round(draft.maxConcurrentDownloads) || 1, 1), 8),
        updateCheckIntervalHours: Math.max(Math.round(draft.updateCheckIntervalHours) || 0, 0),
        defaultContextLength: Math.max(Math.round(draft.defaultContextLength) || 8192, 512),
        minTokensPerSec: Math.max(draft.minTokensPerSec || 1, 0.5),
      });
      notify(t("set.saved"));
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const browse = async () => {
    const dir = await open({ directory: true, defaultPath: draft.modelsDir ?? suggested ?? undefined });
    if (typeof dir === "string") set("modelsDir", dir);
  };

  const saveToken = async () => {
    setTokenBusy(true);
    try {
      const name = await api.setToken(token);
      setHasToken(true);
      setToken("");
      notify(t("set.tokenOk", { name }));
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setTokenBusy(false);
    }
  };

  return (
    <div className="page settings">
      <h1>{t("set.title")}</h1>

      <section className="field">
        <label>{t("set.modelsDir")}</label>
        <div className="row">
          <input value={draft.modelsDir ?? ""} onChange={(e) => set("modelsDir", e.target.value || null)} />
          <button className="btn" onClick={browse}>
            {t("set.browse")}
          </button>
          {suggested && !draft.modelsDir && (
            <button className="btn" onClick={() => set("modelsDir", suggested)}>
              {t("set.useSuggested")}
            </button>
          )}
        </div>
        <p className="muted small">{t("set.modelsDirHint")}</p>
      </section>

      <div className="grid2">
        <section className="field">
          <label>{t("set.language")}</label>
          <select value={draft.language} onChange={(e) => set("language", e.target.value as Settings["language"])}>
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
        </section>
        <section className="field">
          <label>{t("set.theme")}</label>
          <select value={draft.theme} onChange={(e) => set("theme", e.target.value as Settings["theme"])}>
            {(["system", "light", "dark"] as const).map((x) => (
              <option key={x} value={x}>
                {t(`set.theme.${x}`)}
              </option>
            ))}
          </select>
        </section>
        <section className="field">
          <label>{t("set.concurrency")}</label>
          <input
            type="number"
            min={1}
            max={8}
            value={draft.maxConcurrentDownloads}
            onChange={(e) => set("maxConcurrentDownloads", Number(e.target.value))}
          />
        </section>
        <section className="field">
          <label>{t("set.updateInterval")}</label>
          <input
            type="number"
            min={0}
            value={draft.updateCheckIntervalHours}
            onChange={(e) => set("updateCheckIntervalHours", Number(e.target.value))}
          />
        </section>
        <section className="field">
          <label>{t("set.context")}</label>
          <select value={draft.defaultContextLength} onChange={(e) => set("defaultContextLength", Number(e.target.value))}>
            {[2048, 4096, 8192, 16384, 32768, 65536, 131072].map((c) => (
              <option key={c} value={c}>
                {c.toLocaleString()}
              </option>
            ))}
          </select>
        </section>
        <section className="field">
          <label>{t("set.minTps")}</label>
          <input
            type="number"
            min={1}
            step={1}
            value={draft.minTokensPerSec}
            onChange={(e) => set("minTokensPerSec", Number(e.target.value))}
          />
        </section>
      </div>

      <label className="check">
        <input type="checkbox" checked={draft.verifyHash} onChange={(e) => set("verifyHash", e.target.checked)} />
        {t("set.verify")}
      </label>

      <h2>{t("set.overrides")}</h2>
      <div className="grid2">
        {(
          [
            ["vramOverrideGb", "set.vramOverride"],
            ["gpuBandwidthOverrideGbps", "set.gpuBwOverride"],
            ["ramBandwidthOverrideGbps", "set.ramBwOverride"],
          ] as const
        ).map(([k, label]) => (
          <section className="field" key={k}>
            <label>{t(label)}</label>
            <input
              type="number"
              min={0}
              step="any"
              value={draft[k] ?? ""}
              onChange={(e) => set(k, numOrNull(e.target.value))}
            />
          </section>
        ))}
      </div>

      <div className="center-left">
        <button className="btn primary" onClick={save}>
          {t("common.save")}
        </button>
      </div>

      <h2>{t("set.token")}</h2>
      <p className="muted small">{t("set.tokenHint")}</p>
      <p>
        <span className={`badge ${hasToken ? "local" : ""}`}>{hasToken ? t("set.tokenSet") : t("set.tokenNotSet")}</span>
      </p>
      <div className="row">
        <input
          type="password"
          autoComplete="off"
          placeholder="hf_..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button className="btn primary" disabled={!token.trim() || tokenBusy} onClick={saveToken}>
          {t("set.tokenSave")}
        </button>
        {hasToken && (
          <button
            className="btn danger"
            onClick={async () => {
              try {
                await api.deleteToken();
                setHasToken(false);
              } catch (e) {
                notify(errorMessage(e), "error");
              }
            }}
          >
            {t("set.tokenDelete")}
          </button>
        )}
      </div>
    </div>
  );
}
