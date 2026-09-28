//! ダウンロードキュー: 並列数制御、Rangeによるレジューム、SHA256検証、再起動後の再開

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::{header, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::io::{AsyncWriteExt, BufWriter};

use crate::hf::HfClient;
use crate::library::{LibraryFile, RepoMeta};
use crate::{paths, store, Core};

const RUN: u8 = 0;
const PAUSE: u8 = 1;
const CANCEL: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Queued,
    Downloading,
    Verifying,
    Paused,
    Completed,
    Failed,
    Canceled,
}

impl Status {
    fn is_active(self) -> bool {
        matches!(self, Status::Downloading | Status::Verifying)
    }
    fn is_finished(self) -> bool {
        matches!(self, Status::Completed | Status::Failed | Status::Canceled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub repo_id: String,
    pub revision: String,
    pub path: String,
    pub size: u64,
    pub sha256: Option<String>,
    pub meta: RepoMeta,
    pub status: Status,
    pub downloaded: u64,
    #[serde(default)]
    pub speed: f64,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueFile {
    pub path: String,
    pub size: u64,
    pub sha256: Option<String>,
}

pub struct DownloadManager {
    tasks: Mutex<Vec<DownloadTask>>,
    controls: Mutex<HashMap<String, Arc<AtomicU8>>>,
    persist_path: PathBuf,
}

enum Outcome {
    Completed(LibraryFile),
    Paused,
    Canceled,
}

impl DownloadManager {
    pub fn load(persist_path: PathBuf) -> Self {
        let mut tasks: Vec<DownloadTask> = store::load_json(&persist_path).unwrap_or_default();
        // 前回終了時に進行中だったものは一時停止扱いで復元する
        for t in tasks.iter_mut() {
            if t.status.is_active() {
                t.status = Status::Paused;
            }
            t.speed = 0.0;
        }
        Self {
            tasks: Mutex::new(tasks),
            controls: Mutex::new(HashMap::new()),
            persist_path,
        }
    }

    pub fn list(&self) -> Vec<DownloadTask> {
        self.tasks.lock().unwrap().clone()
    }

    fn persist(&self) {
        let tasks = self.tasks.lock().unwrap().clone();
        if let Err(e) = store::save_json(&self.persist_path, &tasks) {
            eprintln!("failed to save downloads: {e:#}");
        }
    }

    fn update<F: FnOnce(&mut DownloadTask)>(&self, id: &str, f: F) -> Option<DownloadTask> {
        let mut tasks = self.tasks.lock().unwrap();
        let t = tasks.iter_mut().find(|t| t.id == id)?;
        f(t);
        Some(t.clone())
    }
}

fn emit(core: &Core, task: &DownloadTask) {
    let _ = core.app.emit("download-updated", task);
}

fn emit_removed(core: &Core, ids: &[String]) {
    let _ = core.app.emit("download-removed", ids);
}

fn models_dir(core: &Core) -> Result<PathBuf> {
    core.user
        .lock()
        .unwrap()
        .settings
        .models_dir
        .clone()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("MODELS_DIR_NOT_SET: models directory is not configured"))
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

pub fn enqueue(
    core: &Arc<Core>,
    repo_id: String,
    revision: String,
    files: Vec<EnqueueFile>,
    meta: RepoMeta,
) -> Result<()> {
    let dir = models_dir(core)?;
    let mut added = Vec::new();
    {
        let mut tasks = core.downloads.tasks.lock().unwrap();
        for f in files {
            paths::file_path(&dir, &repo_id, &f.path)?;
            HfClient::resolve_url(&repo_id, &revision, &f.path)?;
            let id = format!("{repo_id}/{}", f.path);
            if let Some(pos) = tasks.iter().position(|t| t.id == id) {
                if !tasks[pos].status.is_finished() {
                    continue;
                }
                tasks.remove(pos);
            }
            let t = DownloadTask {
                id,
                repo_id: repo_id.clone(),
                revision: revision.clone(),
                path: f.path,
                size: f.size,
                sha256: f.sha256.map(|s| s.to_lowercase()),
                meta: meta.clone(),
                status: Status::Queued,
                downloaded: 0,
                speed: 0.0,
                error: None,
                created_at: Utc::now(),
            };
            added.push(t.clone());
            tasks.push(t);
        }
    }
    for t in &added {
        emit(core, t);
    }
    core.downloads.persist();
    pump(core);
    Ok(())
}

/// 並列数の上限までキューからタスクを開始する
pub fn pump(core: &Arc<Core>) {
    let max = core
        .user
        .lock()
        .unwrap()
        .settings
        .max_concurrent_downloads
        .max(1) as usize;
    let mut to_start = Vec::new();
    {
        let mut tasks = core.downloads.tasks.lock().unwrap();
        let mut active = tasks.iter().filter(|t| t.status.is_active()).count();
        for t in tasks.iter_mut() {
            if active >= max {
                break;
            }
            if t.status == Status::Queued {
                t.status = Status::Downloading;
                t.error = None;
                active += 1;
                to_start.push(t.clone());
            }
        }
    }
    for t in to_start {
        emit(core, &t);
        let ctrl = Arc::new(AtomicU8::new(RUN));
        core.downloads
            .controls
            .lock()
            .unwrap()
            .insert(t.id.clone(), ctrl.clone());
        let core = core.clone();
        tauri::async_runtime::spawn(async move {
            let result = run(&core, &t, ctrl).await;
            core.downloads.controls.lock().unwrap().remove(&t.id);
            let updated = core.downloads.update(&t.id, |x| {
                x.speed = 0.0;
                match &result {
                    Ok(Outcome::Completed(_)) => {
                        x.status = Status::Completed;
                        x.downloaded = x.size;
                    }
                    Ok(Outcome::Paused) => x.status = Status::Paused,
                    Ok(Outcome::Canceled) => {
                        x.status = Status::Canceled;
                        x.downloaded = 0;
                    }
                    Err(e) => {
                        x.status = Status::Failed;
                        x.error = Some(format!("{e:#}"));
                    }
                }
            });
            if let Ok(Outcome::Completed(file)) = result {
                let mut lib = core.library.lock().unwrap();
                lib.register_file(&t.repo_id, &t.revision, &t.meta, file);
                if let Err(e) = store::save_json(&core.library_path(), &*lib) {
                    eprintln!("failed to save library: {e:#}");
                }
                drop(lib);
                let _ = core.app.emit("library-changed", &t.repo_id);
            }
            if let Some(u) = updated {
                emit(&core, &u);
            }
            core.downloads.persist();
            pump(&core);
        });
    }
}

async fn hash_existing(path: PathBuf) -> Result<Sha256> {
    tokio::task::spawn_blocking(move || -> Result<Sha256> {
        use std::io::Read;
        let mut f = std::fs::File::open(path)?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 4 * 1024 * 1024];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        Ok(h)
    })
    .await?
}

async fn run(core: &Arc<Core>, t: &DownloadTask, ctrl: Arc<AtomicU8>) -> Result<Outcome> {
    let dir = models_dir(core)?;
    let verify = core.user.lock().unwrap().settings.verify_hash && t.sha256.is_some();
    let dest = paths::file_path(&dir, &t.repo_id, &t.path)?;
    let part = part_path(&dest);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let mut existing = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    if t.size > 0 && existing > t.size {
        tokio::fs::remove_file(&part).await?;
        existing = 0;
    }
    let mut hasher = if verify {
        Some(if existing > 0 {
            hash_existing(part.clone()).await?
        } else {
            Sha256::new()
        })
    } else {
        None
    };

    if !(t.size > 0 && existing == t.size) {
        let url = HfClient::resolve_url(&t.repo_id, &t.revision, &t.path)?;
        let mut rb = core.hf.http.get(&url);
        if existing > 0 {
            rb = rb.header(header::RANGE, format!("bytes={existing}-"));
        }
        let resp = core.hf.authed(rb).send().await?;
        let status = resp.status();
        let append = match status {
            StatusCode::PARTIAL_CONTENT => true,
            StatusCode::OK => false,
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                bail!("HF_AUTH: HTTP {} (gated model or invalid token)", status.as_u16())
            }
            s => bail!("HF_HTTP: HTTP {} {url}", s.as_u16()),
        };
        if !append {
            existing = 0;
            if verify {
                hasher = Some(Sha256::new());
            }
        }
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&part)
            .await?;
        let mut w = BufWriter::with_capacity(1024 * 1024, file);
        let mut stream = resp.bytes_stream();
        let mut downloaded = existing;
        let mut last_emit = Instant::now();
        let mut window_start = Instant::now();
        let mut window_bytes = 0u64;
        let mut speed = 0.0f64;

        while let Some(chunk) = stream.next().await {
            match ctrl.load(Ordering::Relaxed) {
                PAUSE => {
                    w.flush().await?;
                    return Ok(Outcome::Paused);
                }
                CANCEL => {
                    drop(w);
                    let _ = tokio::fs::remove_file(&part).await;
                    return Ok(Outcome::Canceled);
                }
                _ => {}
            }
            let chunk = chunk?;
            w.write_all(&chunk).await?;
            if let Some(h) = hasher.as_mut() {
                h.update(&chunk);
            }
            downloaded += chunk.len() as u64;
            window_bytes += chunk.len() as u64;
            let el = window_start.elapsed();
            if el >= Duration::from_secs(1) {
                let inst = window_bytes as f64 / el.as_secs_f64();
                speed = if speed == 0.0 { inst } else { speed * 0.6 + inst * 0.4 };
                window_start = Instant::now();
                window_bytes = 0;
            }
            if last_emit.elapsed() >= Duration::from_millis(300) {
                last_emit = Instant::now();
                if let Some(u) = core.downloads.update(&t.id, |x| {
                    x.downloaded = downloaded;
                    x.speed = speed;
                }) {
                    emit(core, &u);
                }
            }
        }
        w.flush().await?;
        drop(w);
        existing = downloaded;
    }

    if t.size > 0 && existing != t.size {
        bail!("size mismatch: expected {} bytes, got {existing}", t.size);
    }
    if let (Some(h), Some(expected)) = (hasher, t.sha256.as_deref()) {
        if let Some(u) = core.downloads.update(&t.id, |x| x.status = Status::Verifying) {
            emit(core, &u);
        }
        let actual = hex::encode(h.finalize());
        if actual != expected {
            let _ = tokio::fs::remove_file(&part).await;
            bail!("SHA256 mismatch: expected {expected}, got {actual}");
        }
    }
    if tokio::fs::metadata(&dest).await.is_ok() {
        tokio::fs::remove_file(&dest).await?;
    }
    tokio::fs::rename(&part, &dest).await?;
    Ok(Outcome::Completed(LibraryFile {
        path: t.path.clone(),
        size: existing,
        lfs_oid: t.sha256.clone(),
    }))
}

pub fn pause(core: &Arc<Core>, id: &str) {
    if let Some(c) = core.downloads.controls.lock().unwrap().get(id) {
        c.store(PAUSE, Ordering::Relaxed);
        return;
    }
    if let Some(u) = core.downloads.update(id, |x| {
        if x.status == Status::Queued {
            x.status = Status::Paused;
        }
    }) {
        emit(core, &u);
        core.downloads.persist();
    }
}

pub fn resume(core: &Arc<Core>, id: &str) {
    if let Some(u) = core.downloads.update(id, |x| {
        if matches!(x.status, Status::Paused | Status::Failed) {
            x.status = Status::Queued;
            x.error = None;
        }
    }) {
        emit(core, &u);
        core.downloads.persist();
    }
    pump(core);
}

pub fn cancel(core: &Arc<Core>, id: &str) {
    if let Some(c) = core.downloads.controls.lock().unwrap().get(id) {
        c.store(CANCEL, Ordering::Relaxed);
        return;
    }
    let task = core.downloads.update(id, |x| {
        if !x.status.is_finished() || x.status == Status::Failed {
            x.status = Status::Canceled;
            x.downloaded = 0;
        }
    });
    if let Some(t) = task {
        if let Ok(dir) = models_dir(core) {
            if let Ok(dest) = paths::file_path(&dir, &t.repo_id, &t.path) {
                let _ = std::fs::remove_file(part_path(&dest));
            }
        }
        emit(core, &t);
        core.downloads.persist();
    }
}

/// 完了・キャンセル済みのタスクを一覧から除く (ids未指定なら全ての終了済み)
pub fn clear_finished(core: &Arc<Core>, ids: Option<Vec<String>>) {
    let removed: Vec<String> = {
        let mut tasks = core.downloads.tasks.lock().unwrap();
        let removable = |t: &DownloadTask| {
            matches!(t.status, Status::Completed | Status::Canceled)
                && ids.as_ref().map(|ids| ids.contains(&t.id)).unwrap_or(true)
        };
        let removed = tasks.iter().filter(|t| removable(t)).map(|t| t.id.clone()).collect();
        tasks.retain(|t| !removable(t));
        removed
    };
    emit_removed(core, &removed);
    core.downloads.persist();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_suffix() {
        let p = part_path(Path::new("/m/a/b/x.gguf"));
        assert!(p.to_string_lossy().ends_with("x.gguf.part"));
    }

    #[test]
    fn restore_active_as_paused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("downloads.json");
        let task = DownloadTask {
            id: "a/b/x.gguf".into(),
            repo_id: "a/b".into(),
            revision: "main".into(),
            path: "x.gguf".into(),
            size: 10,
            sha256: None,
            meta: RepoMeta {
                format: "gguf".into(),
                created_at: None,
                last_modified: None,
                base_models: vec![],
            },
            status: Status::Downloading,
            downloaded: 5,
            speed: 100.0,
            error: None,
            created_at: Utc::now(),
        };
        store::save_json(&path, &vec![task]).unwrap();
        let m = DownloadManager::load(path);
        let l = m.list();
        assert_eq!(l[0].status, Status::Paused);
        assert_eq!(l[0].speed, 0.0);
    }
}
