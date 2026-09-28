import { listen } from "@tauri-apps/api/event";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { en } from "./i18n/en";
import { ja, type Dict } from "./i18n/ja";
import { api, errorMessage } from "./lib/api";
import { buildProfile, type MachineProfile } from "./lib/estimate";
import type { DownloadTask, HardwareInfo, LocalRepo, Settings, UserData } from "./lib/types";

export type Page =
  | "search"
  | "recommend"
  | "discover"
  | "library"
  | "downloads"
  | "favorites"
  | "system"
  | "settings";

export type TFunc = (key: keyof Dict, vars?: Record<string, string | number>) => string;

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

interface AppCtx {
  user: UserData;
  settings: Settings;
  saveSettings: (s: Settings) => Promise<void>;
  t: TFunc;
  lang: "ja" | "en";
  hw: HardwareInfo | null;
  profile: MachineProfile | null;
  refreshHardware: () => Promise<void>;
  favorites: Set<string>;
  toggleFavorite: (id: string) => Promise<void>;
  addHistory: (query: string, filters: Record<string, unknown>) => void;
  clearHistory: () => Promise<void>;
  downloads: DownloadTask[];
  library: LocalRepo[];
  reloadLibrary: () => Promise<void>;
  checkUpdates: (ids?: string[]) => Promise<void>;
  checking: boolean;
  page: Page;
  pageParams: Record<string, unknown> | null;
  navigate: (p: Page, params?: Record<string, unknown>) => void;
  detailId: string | null;
  openModel: (id: string | null) => void;
  notify: (text: string, kind?: "info" | "error") => void;
  toasts: Toast[];
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("AppContext is not available");
  return c;
}

const DICTS = { ja, en };

export function AppProvider({ initial, children }: { initial: UserData; children: ReactNode }) {
  const [user, setUser] = useState<UserData>(initial);
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [downloadMap, setDownloadMap] = useState<Map<string, DownloadTask>>(new Map());
  const [library, setLibrary] = useState<LocalRepo[]>([]);
  const [checking, setChecking] = useState(false);
  const [page, setPage] = useState<Page>("search");
  const [pageParams, setPageParams] = useState<Record<string, unknown> | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const settings = user.settings;
  const lang = settings.language === "en" ? "en" : "ja";

  const t = useCallback<TFunc>(
    (key, vars) => {
      let s = DICTS[lang][key] ?? String(key);
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      return s;
    },
    [lang],
  );

  const notify = useCallback((text: string, kind: "info" | "error" = "info") => {
    const id = ++toastSeq.current;
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);

  const saveSettings = useCallback(
    async (s: Settings) => {
      const saved = await api.updateSettings(s);
      setUser((u) => ({ ...u, settings: saved }));
    },
    [],
  );

  const refreshHardware = useCallback(async () => {
    try {
      setHw(await api.getHardware(true));
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [notify]);

  const profile = useMemo(() => (hw ? buildProfile(hw, settings) : null), [hw, settings]);

  const favorites = useMemo(() => new Set(user.favorites.map((f) => f.repoId)), [user.favorites]);

  const toggleFavorite = useCallback(async (id: string) => {
    const added = await api.toggleFavorite(id);
    setUser((u) => ({
      ...u,
      favorites: added
        ? [{ repoId: id, addedAt: new Date().toISOString() }, ...u.favorites]
        : u.favorites.filter((f) => f.repoId !== id),
    }));
  }, []);

  const addHistory = useCallback((query: string, filters: Record<string, unknown>) => {
    api
      .addHistory(query, filters)
      .then(() => api.getUserData())
      .then((u) => setUser((cur) => ({ ...cur, history: u.history })))
      .catch(() => undefined);
  }, []);

  const clearHistory = useCallback(async () => {
    await api.clearHistory();
    setUser((u) => ({ ...u, history: [] }));
  }, []);

  const reloadLibrary = useCallback(async () => {
    if (!settings.modelsDir) {
      setLibrary([]);
      return;
    }
    try {
      setLibrary(await api.libraryScan());
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [settings.modelsDir, notify]);

  const checkingRef = useRef(false);
  const checkUpdates = useCallback(
    async (ids?: string[]) => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      setChecking(true);
      try {
        await api.libraryCheckUpdates(ids);
        await reloadLibrary();
      } catch (e) {
        notify(errorMessage(e), "error");
      } finally {
        checkingRef.current = false;
        setChecking(false);
      }
    },
    [reloadLibrary, notify],
  );

  const navigate = useCallback((p: Page, params?: Record<string, unknown>) => {
    setPage(p);
    setPageParams(params ?? null);
  }, []);

  // ハードウェア検出
  useEffect(() => {
    api.getHardware(false).then(setHw).catch((e) => notify(errorMessage(e), "error"));
  }, [notify]);

  // ダウンロード状態の購読
  useEffect(() => {
    api.downloadList().then((list) => setDownloadMap(new Map(list.map((d) => [d.id, d]))));
    const unsubs = [
      listen<DownloadTask>("download-updated", (e) => {
        setDownloadMap((m) => new Map(m).set(e.payload.id, e.payload));
        if (e.payload.status === "failed" && e.payload.error) {
          notify(`${e.payload.path}: ${e.payload.error}`, "error");
        }
      }),
      listen<string[]>("download-removed", (e) => {
        setDownloadMap((m) => {
          const n = new Map(m);
          for (const id of e.payload) n.delete(id);
          return n;
        });
      }),
      listen("library-changed", () => {
        reloadLibrary();
      }),
    ];
    return () => {
      unsubs.forEach((p) => p.then((f) => f()));
    };
  }, [reloadLibrary, notify]);

  useEffect(() => {
    reloadLibrary();
  }, [reloadLibrary]);

  // 起動時と定期的な更新確認
  useEffect(() => {
    if (!settings.modelsDir || settings.updateCheckIntervalHours <= 0) return;
    const first = setTimeout(() => checkUpdates(), 5000);
    const timer = setInterval(() => checkUpdates(), settings.updateCheckIntervalHours * 3600 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [settings.modelsDir, settings.updateCheckIntervalHours, checkUpdates]);

  // テーマ
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", settings.theme);
    root.lang = lang;
  }, [settings.theme, lang]);

  const downloads = useMemo(
    () => [...downloadMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [downloadMap],
  );

  const value: AppCtx = {
    user,
    settings,
    saveSettings,
    t,
    lang,
    hw,
    profile,
    refreshHardware,
    favorites,
    toggleFavorite,
    addHistory,
    clearHistory,
    downloads,
    library,
    reloadLibrary,
    checkUpdates,
    checking,
    page,
    pageParams,
    navigate,
    detailId,
    openModel: setDetailId,
    notify,
    toasts,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
