import { invoke } from "@tauri-apps/api/core";
import type {
  DownloadTask,
  HardwareInfo,
  LocalRepo,
  McpStatus,
  ModelArch,
  RepoMeta,
  Settings,
  UserData,
} from "./types";

export const api = {
  getUserData: () => invoke<UserData>("get_user_data"),
  updateSettings: (settings: Settings) => invoke<Settings>("update_settings", { settings }),
  suggestModelsDir: () => invoke<string | null>("suggest_models_dir"),
  toggleFavorite: (repoId: string) => invoke<boolean>("toggle_favorite", { repoId }),
  addHistory: (query: string, filters: Record<string, unknown>) =>
    invoke<void>("add_history", { query, filters }),
  clearHistory: () => invoke<void>("clear_history"),

  getHardware: (refresh = false) => invoke<HardwareInfo>("get_hardware", { refresh }),

  listModels: (query: [string, string][]) => invoke<unknown[]>("hf_list_models", { query }),
  modelInfo: (repoId: string) => invoke<Record<string, unknown>>("hf_model_info", { repoId }),
  readme: (repoId: string) => invoke<string>("hf_readme", { repoId }),
  modelArch: (repoId: string, file: string | null) =>
    invoke<ModelArch>("hf_model_arch", { repoId, file }),
  tokenStatus: () => invoke<boolean>("token_status"),
  setToken: (token: string) => invoke<string>("set_token", { token }),
  deleteToken: () => invoke<void>("delete_token"),

  downloadEnqueue: (
    repoId: string,
    revision: string,
    files: { path: string; size: number; sha256: string | null }[],
    meta: RepoMeta,
  ) => invoke<void>("download_enqueue", { repoId, revision, files, meta }),
  downloadList: () => invoke<DownloadTask[]>("download_list"),
  downloadPause: (id: string) => invoke<void>("download_pause", { id }),
  downloadResume: (id: string) => invoke<void>("download_resume", { id }),
  downloadCancel: (id: string) => invoke<void>("download_cancel", { id }),
  downloadClear: (ids?: string[]) => invoke<void>("download_clear", { ids: ids ?? null }),

  mcpStatus: () => invoke<McpStatus>("mcp_status"),

  libraryScan: () => invoke<LocalRepo[]>("library_scan"),
  libraryDelete: (repoId: string, file: string | null) =>
    invoke<void>("library_delete", { repoId, file }),
  libraryTrack: (repoId: string) => invoke<void>("library_track", { repoId }),
  libraryCheckUpdates: (repoIds?: string[]) =>
    invoke<number>("library_check_updates", { repoIds: repoIds ?? null }),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
