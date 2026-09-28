mod download;
mod gguf;
mod hardware;
mod hf;
mod library;
mod paths;
mod secrets;
mod store;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use download::{DownloadTask, EnqueueFile};
use gguf::ModelArch;
use hardware::HardwareInfo;
use hf::HfClient;
use library::{LibraryIndex, LocalRepo, RepoMeta};
use store::{Settings, UserData};

/// アプリ全体で共有する状態
pub struct Core {
    pub app: AppHandle,
    pub data_dir: PathBuf,
    pub user: Mutex<UserData>,
    pub library: Mutex<LibraryIndex>,
    pub hf: HfClient,
    pub downloads: download::DownloadManager,
    pub hardware: Mutex<Option<HardwareInfo>>,
}

impl Core {
    pub fn library_path(&self) -> PathBuf {
        self.data_dir.join("library.json")
    }
    fn user_path(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }
    fn save_user(&self) -> CmdResult<()> {
        let data = self.user.lock().unwrap().clone();
        store::save_json(&self.user_path(), &data).map_err(err)
    }
    fn save_library(&self) -> CmdResult<()> {
        let lib = self.library.lock().unwrap().clone();
        store::save_json(&self.library_path(), &lib).map_err(err)
    }
    fn models_dir(&self) -> CmdResult<PathBuf> {
        self.user
            .lock()
            .unwrap()
            .settings
            .models_dir
            .clone()
            .map(PathBuf::from)
            .ok_or_else(|| "MODELS_DIR_NOT_SET: models directory is not configured".to_string())
    }
}

type CmdResult<T> = Result<T, String>;
type CoreState<'a> = State<'a, Arc<Core>>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

fn anyerr(e: anyhow::Error) -> String {
    format!("{e:#}")
}

// ---- 設定・お気に入り・履歴 ----

#[tauri::command]
fn get_user_data(core: CoreState) -> UserData {
    core.user.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(core: CoreState, settings: Settings) -> CmdResult<Settings> {
    if let Some(dir) = settings.models_dir.as_deref() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    core.user.lock().unwrap().settings = settings.clone();
    core.save_user()?;
    download::pump(&core);
    Ok(settings)
}

#[tauri::command]
fn suggest_models_dir() -> Option<String> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join("LLMModels").to_string_lossy().into_owned())
}

#[tauri::command]
fn toggle_favorite(core: CoreState, repo_id: String) -> CmdResult<bool> {
    paths::validate_repo_id(&repo_id).map_err(anyerr)?;
    let added = core.user.lock().unwrap().toggle_favorite(&repo_id);
    core.save_user()?;
    Ok(added)
}

#[tauri::command]
fn add_history(core: CoreState, query: String, filters: Value) -> CmdResult<()> {
    core.user.lock().unwrap().push_history(query, filters);
    core.save_user()
}

#[tauri::command]
fn clear_history(core: CoreState) -> CmdResult<()> {
    core.user.lock().unwrap().history.clear();
    core.save_user()
}

// ---- ハードウェア ----

#[tauri::command]
async fn get_hardware(core: CoreState<'_>, refresh: bool) -> CmdResult<HardwareInfo> {
    if !refresh {
        if let Some(h) = core.hardware.lock().unwrap().clone() {
            return Ok(h);
        }
    }
    let info = tokio::task::spawn_blocking(hardware::detect)
        .await
        .map_err(err)?;
    *core.hardware.lock().unwrap() = Some(info.clone());
    Ok(info)
}

// ---- Hugging Face ----

#[tauri::command]
async fn hf_list_models(core: CoreState<'_>, query: Vec<(String, String)>) -> CmdResult<Value> {
    core.hf.list_models(&query).await.map_err(anyerr)
}

#[tauri::command]
async fn hf_model_info(core: CoreState<'_>, repo_id: String) -> CmdResult<Value> {
    core.hf.model_info(&repo_id).await.map_err(anyerr)
}

#[tauri::command]
async fn hf_readme(core: CoreState<'_>, repo_id: String) -> CmdResult<String> {
    core.hf.readme(&repo_id).await.map_err(anyerr)
}

#[tauri::command]
async fn hf_model_arch(
    core: CoreState<'_>,
    repo_id: String,
    file: Option<String>,
) -> CmdResult<ModelArch> {
    core.hf
        .model_arch(&repo_id, file.as_deref())
        .await
        .map_err(anyerr)
}

#[tauri::command]
fn token_status(core: CoreState) -> bool {
    core.hf.has_token()
}

#[tauri::command]
async fn set_token(core: CoreState<'_>, token: String) -> CmdResult<String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("token is empty".into());
    }
    let name = core.hf.whoami(&token).await.map_err(anyerr)?;
    secrets::save_token(&token).map_err(anyerr)?;
    core.hf.set_token(Some(token));
    Ok(name)
}

#[tauri::command]
fn delete_token(core: CoreState) -> CmdResult<()> {
    secrets::delete_token().map_err(anyerr)?;
    core.hf.set_token(None);
    Ok(())
}

// ---- ダウンロード ----

#[tauri::command]
fn download_enqueue(
    core: CoreState,
    repo_id: String,
    revision: String,
    files: Vec<EnqueueFile>,
    meta: RepoMeta,
) -> CmdResult<()> {
    download::enqueue(&core, repo_id, revision, files, meta).map_err(anyerr)
}

#[tauri::command]
fn download_list(core: CoreState) -> Vec<DownloadTask> {
    core.downloads.list()
}

#[tauri::command]
fn download_pause(core: CoreState, id: String) {
    download::pause(&core, &id);
}

#[tauri::command]
fn download_resume(core: CoreState, id: String) {
    download::resume(&core, &id);
}

#[tauri::command]
fn download_cancel(core: CoreState, id: String) {
    download::cancel(&core, &id);
}

#[tauri::command]
fn download_clear(core: CoreState, ids: Option<Vec<String>>) {
    download::clear_finished(&core, ids);
}

// ---- ライブラリ ----

fn scan_library(core: &Core) -> CmdResult<Vec<LocalRepo>> {
    let dir = core.models_dir()?;
    let lib = core.library.lock().unwrap().clone();
    Ok(library::scan(&dir, &lib))
}

#[tauri::command]
async fn library_scan(core: CoreState<'_>) -> CmdResult<Vec<LocalRepo>> {
    let core = core.inner().clone();
    tokio::task::spawn_blocking(move || scan_library(&core))
        .await
        .map_err(err)?
}

#[tauri::command]
fn library_delete(core: CoreState, repo_id: String, file: Option<String>) -> CmdResult<()> {
    let dir = core.models_dir()?;
    library::delete(&dir, &repo_id, file.as_deref()).map_err(anyerr)?;
    {
        let mut lib = core.library.lock().unwrap();
        match file.as_deref() {
            Some(f) => {
                if let Some(r) = lib.repos.get_mut(&repo_id) {
                    r.files.retain(|x| x.path != f);
                    if r.files.is_empty() {
                        lib.repos.remove(&repo_id);
                    }
                }
            }
            None => {
                lib.repos.remove(&repo_id);
            }
        }
    }
    core.save_library()?;
    let _ = core.app.emit("library-changed", &repo_id);
    Ok(())
}

#[tauri::command]
async fn library_track(core: CoreState<'_>, repo_id: String) -> CmdResult<()> {
    let local = scan_library(&core)?
        .into_iter()
        .find(|r| r.repo_id == repo_id)
        .ok_or_else(|| format!("not found in library: {repo_id}"))?;
    let mut rec = library::adopt(&core.hf, &local).await.map_err(anyerr)?;
    rec.tracking = Some(library::check_repo(&core.hf, &rec).await);
    core.library.lock().unwrap().repos.insert(repo_id.clone(), rec);
    core.save_library()?;
    let _ = core.app.emit("library-changed", &repo_id);
    Ok(())
}

/// 追跡中のモデルの更新・新バージョン・派生を確認する (ids未指定なら全件)
#[tauri::command]
async fn library_check_updates(
    core: CoreState<'_>,
    repo_ids: Option<Vec<String>>,
) -> CmdResult<usize> {
    let targets: Vec<_> = core
        .library
        .lock()
        .unwrap()
        .repos
        .values()
        .filter(|r| repo_ids.as_ref().map(|ids| ids.contains(&r.repo_id)).unwrap_or(true))
        .cloned()
        .collect();
    let shared = core.inner().clone();
    let results: Vec<_> = futures_util::stream::iter(targets)
        .map(move |rec| {
            let c = shared.clone();
            async move { (rec.repo_id.clone(), library::check_repo(&c.hf, &rec).await) }
        })
        .buffer_unordered(3)
        .collect()
        .await;
    let n = results.len();
    {
        let mut lib = core.library.lock().unwrap();
        for (id, t) in results {
            if let Some(r) = lib.repos.get_mut(&id) {
                r.tracking = Some(t);
            }
        }
    }
    core.save_library()?;
    let _ = core.app.emit("library-changed", "");
    Ok(n)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let user: UserData = store::load_json(&data_dir.join("state.json")).unwrap_or_else(|e| {
                eprintln!("failed to load state: {e:#}");
                UserData::default()
            });
            let library: LibraryIndex = store::load_json(&data_dir.join("library.json"))
                .unwrap_or_else(|e| {
                    eprintln!("failed to load library: {e:#}");
                    LibraryIndex::default()
                });
            let core = Arc::new(Core {
                app: app.handle().clone(),
                downloads: download::DownloadManager::load(data_dir.join("downloads.json")),
                data_dir,
                user: Mutex::new(user),
                library: Mutex::new(library),
                hf: HfClient::new(secrets::load_token())?,
                hardware: Mutex::new(None),
            });
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_user_data,
            update_settings,
            suggest_models_dir,
            toggle_favorite,
            add_history,
            clear_history,
            get_hardware,
            hf_list_models,
            hf_model_info,
            hf_readme,
            hf_model_arch,
            token_status,
            set_token,
            delete_token,
            download_enqueue,
            download_list,
            download_pause,
            download_resume,
            download_cancel,
            download_clear,
            library_scan,
            library_delete,
            library_track,
            library_check_updates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
