// Rustバックエンドとやり取りする型

export interface Settings {
  modelsDir: string | null;
  language: "ja" | "en";
  theme: "system" | "light" | "dark";
  maxConcurrentDownloads: number;
  updateCheckIntervalHours: number;
  defaultContextLength: number;
  minTokensPerSec: number;
  verifyHash: boolean;
  vramOverrideGb: number | null;
  gpuBandwidthOverrideGbps: number | null;
  ramBandwidthOverrideGbps: number | null;
}

export interface Favorite {
  repoId: string;
  addedAt: string;
}

export interface HistoryEntry {
  query: string;
  filters: Record<string, unknown>;
  searchedAt: string;
}

export interface UserData {
  settings: Settings;
  favorites: Favorite[];
  history: HistoryEntry[];
}

export interface GpuInfo {
  name: string;
  vendor: string;
  vramTotal: number | null;
  vramFree: number | null;
  kind: "discrete" | "integrated" | "unified";
  driver: string | null;
}

export interface HardwareInfo {
  os: string;
  osVersion: string;
  arch: string;
  cpuBrand: string;
  cpuCores: number;
  cpuThreads: number;
  ramTotal: number;
  ramAvailable: number;
  gpus: GpuInfo[];
  memorySpeedMts: number | null;
  memoryType: string | null;
  memoryModules: number | null;
  unifiedMemory: boolean;
  backends: string[];
}

export interface ModelArch {
  source: "gguf" | "config";
  architecture: string | null;
  contextLength: number | null;
  blockCount: number | null;
  embeddingLength: number | null;
  headCount: number | null;
  headCountKv: number | null;
  kvBytesPerToken: number | null;
  expertCount: number | null;
  expertUsedCount: number | null;
  slidingWindow: number | null;
  parameterCount: number | null;
}

export interface RepoMeta {
  format: string;
  createdAt: string | null;
  lastModified: string | null;
  baseModels: string[];
}

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "verifying"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export interface DownloadTask {
  id: string;
  repoId: string;
  revision: string;
  path: string;
  size: number;
  sha256: string | null;
  meta: RepoMeta;
  status: DownloadStatus;
  downloaded: number;
  speed: number;
  error: string | null;
  createdAt: string;
}

export interface ModelRef {
  id: string;
  createdAt: string | null;
  downloads: number | null;
  likes: number | null;
  relation: string | null;
}

export interface TrackingInfo {
  checkedAt: string | null;
  latestSha: string | null;
  latestLastModified: string | null;
  repoUpdated: boolean;
  changedFiles: string[];
  removedFiles: string[];
  newVersion: string | null;
  successors: ModelRef[];
  derivatives: ModelRef[];
  baseModel: string | null;
  error: string | null;
}

export interface LibraryFile {
  path: string;
  size: number;
  lfsOid: string | null;
}

export interface LibraryRepo {
  repoId: string;
  format: string;
  revision: string | null;
  downloadedAt: string;
  baselineOnly: boolean;
  createdAt: string | null;
  lastModified: string | null;
  baseModels: string[];
  files: LibraryFile[];
  tracking: TrackingInfo | null;
}

export interface LocalFile {
  path: string;
  size: number;
  modified: string | null;
}

export interface LocalRepo {
  repoId: string;
  dir: string;
  format: string;
  files: LocalFile[];
  incompleteFiles: LocalFile[];
  totalSize: number;
  record: LibraryRepo | null;
}
