import { Compass, Cpu, Download, Heart, Library, Search, Settings as SettingsIcon, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useApp, type Page } from "./AppContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ModelDetail } from "./components/ModelDetail";
import { formatBytes } from "./lib/format";
import { McpBridge } from "./mcp/McpBridge";
import { DiscoverPage } from "./pages/DiscoverPage";
import { DownloadsPage } from "./pages/DownloadsPage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { hasUpdates, LibraryPage } from "./pages/LibraryPage";
import { RecommendPage } from "./pages/RecommendPage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SystemPage } from "./pages/SystemPage";

const NAV: { page: Page; icon: ReactNode }[] = [
  { page: "search", icon: <Search size={18} /> },
  { page: "recommend", icon: <Sparkles size={18} /> },
  { page: "discover", icon: <Compass size={18} /> },
  { page: "library", icon: <Library size={18} /> },
  { page: "downloads", icon: <Download size={18} /> },
  { page: "favorites", icon: <Heart size={18} /> },
  { page: "system", icon: <Cpu size={18} /> },
  { page: "settings", icon: <SettingsIcon size={18} /> },
];

export function App() {
  const { t, page, navigate, detailId, downloads, library, settings, profile, toasts } = useApp();

  const activeDownloads = downloads.filter((d) => ["queued", "downloading", "verifying"].includes(d.status)).length;
  const updates = library.filter((r) => hasUpdates(r.record?.tracking)).length;
  const badge: Partial<Record<Page, number>> = { downloads: activeDownloads, library: updates };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">{t("app.title")}</div>
        {NAV.map((n) => (
          <button
            key={n.page}
            className={`nav-item ${page === n.page ? "active" : ""}`}
            onClick={() => navigate(n.page)}
          >
            {n.icon}
            <span>{t(`nav.${n.page}`)}</span>
            {badge[n.page] ? <span className="count">{badge[n.page]}</span> : null}
          </button>
        ))}
        {profile && (
          <div className="spec-mini" onClick={() => navigate("system")}>
            <div>{profile.gpuName ?? t("rec.noGpu")}</div>
            <div>
              VRAM {formatBytes(profile.gpuMemory, 0)} / RAM {formatBytes(profile.ramTotal, 0)}
            </div>
          </div>
        )}
      </nav>
      <main className="content">
        {!settings.modelsDir && page !== "settings" && (
          <div className="banner">
            {t("banner.noModelsDir")}{" "}
            <button className="btn small" onClick={() => navigate("settings")}>
              {t("banner.openSettings")}
            </button>
          </div>
        )}
        <ErrorBoundary resetKey={page}>
          {page === "search" && <SearchPage />}
          {page === "recommend" && <RecommendPage />}
          {page === "discover" && <DiscoverPage />}
          {page === "library" && <LibraryPage />}
          {page === "downloads" && <DownloadsPage />}
          {page === "favorites" && <FavoritesPage />}
          {page === "system" && <SystemPage />}
          {page === "settings" && <SettingsPage />}
        </ErrorBoundary>
      </main>
      {detailId && (
        <ErrorBoundary resetKey={detailId}>
          <ModelDetail key={detailId} repoId={detailId} />
        </ErrorBoundary>
      )}
      <McpBridge />
      <div className="toasts">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind}`}>
            {x.text}
          </div>
        ))}
      </div>
    </div>
  );
}
