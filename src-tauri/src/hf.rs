//! Hugging Face Hub API クライアント

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use futures_util::StreamExt;
use reqwest::{header, RequestBuilder, Response, StatusCode};
use serde_json::Value;

use crate::gguf::{self, ModelArch, ParseError};
use crate::paths;

pub const HF_BASE: &str = "https://huggingface.co";
const GGUF_HEADER_CAP: usize = 96 * 1024 * 1024;

pub struct HfClient {
    pub http: reqwest::Client,
    token: RwLock<Option<String>>,
    arch_cache: tokio::sync::Mutex<HashMap<String, ModelArch>>,
}

impl HfClient {
    pub fn new(token: Option<String>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("LLMModelSearcher/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(90))
            .build()?;
        Ok(Self {
            http,
            token: RwLock::new(token),
            arch_cache: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    pub fn set_token(&self, token: Option<String>) {
        *self.token.write().unwrap() = token;
    }

    pub fn has_token(&self) -> bool {
        self.token.read().unwrap().is_some()
    }

    /// huggingface.co 宛てのリクエストにのみトークンを付与する
    /// (CDNへのリダイレクト時はreqwestがAuthorizationを除去する)
    pub fn authed(&self, rb: RequestBuilder) -> RequestBuilder {
        match self.token.read().unwrap().as_deref() {
            Some(t) => rb.bearer_auth(t),
            None => rb,
        }
    }

    async fn send_checked(&self, rb: RequestBuilder) -> Result<Response> {
        let resp = self.authed(rb).send().await?;
        check_status(resp).await
    }

    async fn get_json(&self, url: &str) -> Result<Value> {
        let resp = self
            .send_checked(self.http.get(url).timeout(Duration::from_secs(60)))
            .await?;
        Ok(resp.json().await?)
    }

    /// `/api/models` の一覧検索。クエリはフロントエンドで組み立てる
    pub async fn list_models(&self, query: &[(String, String)]) -> Result<Value> {
        for (k, _) in query {
            if !k
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '[' | ']'))
            {
                bail!("invalid query key: {k}");
            }
        }
        let url = reqwest::Url::parse_with_params(&format!("{HF_BASE}/api/models"), query)?;
        self.get_json(url.as_str()).await
    }

    pub async fn model_info(&self, repo_id: &str) -> Result<Value> {
        paths::validate_repo_id(repo_id)?;
        self.get_json(&format!("{HF_BASE}/api/models/{repo_id}?blobs=true"))
            .await
    }

    /// トークンの有効性を確認し、ユーザー名を返す
    pub async fn whoami(&self, token: &str) -> Result<String> {
        let resp = self
            .http
            .get(format!("{HF_BASE}/api/whoami-v2"))
            .bearer_auth(token)
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        let v: Value = check_status(resp).await?.json().await?;
        Ok(v["name"].as_str().unwrap_or_default().to_string())
    }

    pub async fn readme(&self, repo_id: &str) -> Result<String> {
        paths::validate_repo_id(repo_id)?;
        let resp = self
            .authed(
                self.http
                    .get(format!("{HF_BASE}/{repo_id}/resolve/main/README.md"))
                    .timeout(Duration::from_secs(60)),
            )
            .send()
            .await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(String::new());
        }
        Ok(check_status(resp).await?.text().await?)
    }

    pub fn resolve_url(repo_id: &str, revision: &str, rel: &str) -> Result<String> {
        paths::validate_repo_id(repo_id)?;
        paths::validate_rel_path(rel)?;
        if !revision
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            bail!("invalid revision: {revision}");
        }
        let enc: Vec<String> = rel
            .split('/')
            .map(|s| urlencoding::encode(s).into_owned())
            .collect();
        Ok(format!(
            "{HF_BASE}/{repo_id}/resolve/{revision}/{}",
            enc.join("/")
        ))
    }

    /// モデル構造情報を取得する。GGUFはヘッダを部分取得し、それ以外は config.json を読む
    pub async fn model_arch(&self, repo_id: &str, file: Option<&str>) -> Result<ModelArch> {
        let key = format!("{repo_id}::{}", file.unwrap_or(""));
        if let Some(a) = self.arch_cache.lock().await.get(&key) {
            return Ok(a.clone());
        }
        let arch = match file {
            Some(f) if f.to_lowercase().ends_with(".gguf") => {
                self.gguf_arch(repo_id, f).await?
            }
            _ => {
                let url = Self::resolve_url(repo_id, "main", "config.json")?;
                let cfg = self.get_json(&url).await?;
                gguf::arch_from_config(&cfg)
            }
        };
        self.arch_cache.lock().await.insert(key, arch.clone());
        Ok(arch)
    }

    async fn gguf_arch(&self, repo_id: &str, file: &str) -> Result<ModelArch> {
        let url = Self::resolve_url(repo_id, "main", file)?;
        let resp = self
            .send_checked(
                self.http
                    .get(&url)
                    .header(header::RANGE, format!("bytes=0-{}", GGUF_HEADER_CAP - 1))
                    .timeout(Duration::from_secs(120)),
            )
            .await?;
        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::with_capacity(4 * 1024 * 1024);
        let mut target = 2 * 1024 * 1024;
        loop {
            let mut ended = false;
            while buf.len() < target {
                match stream.next().await {
                    Some(chunk) => buf.extend_from_slice(&chunk?),
                    None => {
                        ended = true;
                        break;
                    }
                }
            }
            match gguf::parse_metadata(&buf) {
                Ok(meta) => return Ok(gguf::arch_from_gguf(&meta)),
                Err(ParseError::Invalid(e)) => bail!("GGUF parse error: {e}"),
                Err(ParseError::Incomplete) => {
                    if ended || buf.len() >= GGUF_HEADER_CAP {
                        bail!("GGUF metadata is larger than the read limit");
                    }
                    target = (target * 2).min(GGUF_HEADER_CAP);
                }
            }
        }
    }
}

async fn check_status(resp: Response) -> Result<Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let url = resp.url().to_string();
    let body = resp.text().await.unwrap_or_default();
    let detail: String = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| body.chars().take(200).collect());
    let kind = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "HF_AUTH",
        StatusCode::NOT_FOUND => "HF_NOT_FOUND",
        StatusCode::TOO_MANY_REQUESTS => "HF_RATE_LIMIT",
        _ => "HF_HTTP",
    };
    Err(anyhow!("{kind}: HTTP {} {url} {detail}", status.as_u16()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_url_encodes_segments() {
        let u = HfClient::resolve_url("a/b", "main", "Q4 K/x+y.gguf").unwrap();
        assert_eq!(u, "https://huggingface.co/a/b/resolve/main/Q4%20K/x%2By.gguf");
        assert!(HfClient::resolve_url("a/b", "ma/in", "x.gguf").is_err());
        assert!(HfClient::resolve_url("a/b", "main", "../x.gguf").is_err());
    }
}

/// ネットワークを使う結合テスト。`cargo test -- --ignored` で実行する
#[cfg(test)]
mod net_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn gguf_header_from_hub() {
        let hf = HfClient::new(None).unwrap();
        let a = hf
            .model_arch("unsloth/Qwen3-0.6B-GGUF", Some("Qwen3-0.6B-Q4_K_M.gguf"))
            .await
            .unwrap();
        println!("{a:?}");
        assert_eq!(a.architecture.as_deref(), Some("qwen3"));
        assert_eq!(a.block_count, Some(28));
        // 28層 * 8 KVヘッド * (128+128) * 2バイト
        assert_eq!(a.kv_bytes_per_token, Some(28 * 8 * 256 * 2));
    }

    #[tokio::test]
    #[ignore]
    async fn config_json_from_hub() {
        let hf = HfClient::new(None).unwrap();
        let a = hf.model_arch("Qwen/Qwen3-0.6B", None).await.unwrap();
        println!("{a:?}");
        assert_eq!(a.block_count, Some(28));
    }

    #[tokio::test]
    #[ignore]
    async fn tracking_against_hub() {
        let hf = HfClient::new(None).unwrap();
        let rec = crate::library::LibraryRepo {
            repo_id: "unsloth/Qwen3-8B-GGUF".into(),
            format: "gguf".into(),
            revision: Some("0000000000000000000000000000000000000000".into()),
            downloaded_at: chrono::DateTime::parse_from_rfc3339("2025-06-01T00:00:00Z")
                .unwrap()
                .into(),
            baseline_only: false,
            created_at: None,
            last_modified: None,
            base_models: vec![],
            files: vec![crate::library::LibraryFile {
                path: "Qwen3-8B-Q4_K_M.gguf".into(),
                size: 1,
                lfs_oid: Some("deadbeef".into()),
            }],
            tracking: None,
        };
        let t = crate::library::check_repo(&hf, &rec).await;
        println!(
            "updated={} changed={:?} base={:?} newver={:?} successors={:?} derivatives={}",
            t.repo_updated,
            t.changed_files,
            t.base_model,
            t.new_version,
            t.successors.iter().map(|s| &s.id).collect::<Vec<_>>(),
            t.derivatives.len()
        );
        assert!(t.error.is_none(), "{:?}", t.error);
        assert!(t.repo_updated);
        assert_eq!(t.changed_files, vec!["Qwen3-8B-Q4_K_M.gguf".to_string()]);
        assert_eq!(t.base_model.as_deref(), Some("Qwen/Qwen3-8B"));
        assert!(!t.derivatives.is_empty());
    }
}
