//! アプリ状態 (設定・お気に入り・検索履歴) のJSON永続化

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub models_dir: Option<String>,
    pub language: String,
    pub theme: String,
    pub max_concurrent_downloads: u32,
    pub update_check_interval_hours: u32,
    pub default_context_length: u32,
    pub min_tokens_per_sec: f64,
    pub verify_hash: bool,
    pub vram_override_gb: Option<f64>,
    pub gpu_bandwidth_override_gbps: Option<f64>,
    pub ram_bandwidth_override_gbps: Option<f64>,
    /// localhostでMCPサーバー (Streamable HTTP) を公開する
    pub mcp_enabled: bool,
    pub mcp_port: u16,
    /// MCPクライアントからのダウンロード開始を許可する
    pub mcp_allow_download: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            models_dir: None,
            language: "ja".into(),
            theme: "system".into(),
            max_concurrent_downloads: 2,
            update_check_interval_hours: 6,
            default_context_length: 8192,
            min_tokens_per_sec: 10.0,
            verify_hash: true,
            vram_override_gb: None,
            gpu_bandwidth_override_gbps: None,
            ram_bandwidth_override_gbps: None,
            mcp_enabled: false,
            mcp_port: crate::mcp::DEFAULT_PORT,
            mcp_allow_download: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    pub repo_id: String,
    pub added_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub query: String,
    /// 検索条件 (フロントエンドが解釈する任意JSON)
    pub filters: serde_json::Value,
    pub searched_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UserData {
    pub settings: Settings,
    pub favorites: Vec<Favorite>,
    pub history: Vec<HistoryEntry>,
}

pub const HISTORY_LIMIT: usize = 50;

impl UserData {
    pub fn toggle_favorite(&mut self, repo_id: &str) -> bool {
        if let Some(pos) = self.favorites.iter().position(|f| f.repo_id == repo_id) {
            self.favorites.remove(pos);
            false
        } else {
            self.favorites.insert(
                0,
                Favorite {
                    repo_id: repo_id.to_string(),
                    added_at: Utc::now(),
                },
            );
            true
        }
    }

    pub fn push_history(&mut self, query: String, filters: serde_json::Value) {
        self.history
            .retain(|h| !(h.query == query && h.filters == filters));
        self.history.insert(
            0,
            HistoryEntry {
                query,
                filters,
                searched_at: Utc::now(),
            },
        );
        self.history.truncate(HISTORY_LIMIT);
    }
}

/// JSONファイルを読み込む。存在しない場合は既定値を返す
pub fn load_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    if !path.exists() {
        return Ok(T::default());
    }
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("failed to parse {}", path.display()))
}

/// 一時ファイルへ書いてからrenameし、書き込み途中の破損を防ぐ
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp: PathBuf = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn favorite_toggle() {
        let mut d = UserData::default();
        assert!(d.toggle_favorite("a/b"));
        assert_eq!(d.favorites.len(), 1);
        assert!(!d.toggle_favorite("a/b"));
        assert!(d.favorites.is_empty());
    }

    #[test]
    fn history_dedup_and_limit() {
        let mut d = UserData::default();
        for i in 0..60 {
            d.push_history(format!("q{i}"), serde_json::json!({}));
        }
        d.push_history("q59".into(), serde_json::json!({}));
        assert_eq!(d.history.len(), HISTORY_LIMIT);
        assert_eq!(d.history[0].query, "q59");
        assert_eq!(d.history.iter().filter(|h| h.query == "q59").count(), 1);
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut d = UserData::default();
        d.settings.models_dir = Some("X".into());
        save_json(&path, &d).unwrap();
        let loaded: UserData = load_json(&path).unwrap();
        assert_eq!(loaded.settings.models_dir.as_deref(), Some("X"));
    }
}
