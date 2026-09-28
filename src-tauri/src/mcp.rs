//! MCPサーバー (Streamable HTTP, JSON応答のみ)
//!
//! プロトコル処理とセキュリティ (localhost限定・Originチェック) はRust側で行い、
//! ツールの一覧と実行はフロントエンド (推定ロジックを持つTS側) へイベントで転送する。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::sync::oneshot;

use crate::Core;

pub const DEFAULT_PORT: u16 = 7865;
const SUPPORTED_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
const FORWARD_TIMEOUT: Duration = Duration::from_secs(120);

/// フロントエンドへ転送中のリクエスト
#[derive(Default)]
pub struct Bridge {
    seq: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
}

impl Bridge {
    pub fn respond(&self, id: u64, result: Result<Value, String>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(result);
        }
    }
}

#[derive(Serialize, Clone)]
struct ForwardRequest {
    id: u64,
    method: String,
    params: Value,
}

async fn forward(core: &Core, method: &str, params: Value) -> Result<Value, String> {
    let id = core.mcp_bridge.seq.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = oneshot::channel();
    core.mcp_bridge.pending.lock().unwrap().insert(id, tx);
    let req = ForwardRequest {
        id,
        method: method.to_string(),
        params,
    };
    if let Err(e) = core.app.emit("mcp-request", req) {
        core.mcp_bridge.pending.lock().unwrap().remove(&id);
        return Err(format!("failed to reach the app window: {e}"));
    }
    match tokio::time::timeout(FORWARD_TIMEOUT, rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("request was dropped".into()),
        Err(_) => {
            core.mcp_bridge.pending.lock().unwrap().remove(&id);
            Err("timed out waiting for the app".into())
        }
    }
}

/// DNSリバインディング対策: Originがある場合はlocalhost系のみ許可する
pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(o) = origin else { return true };
    let Ok(url) = reqwest::Url::parse(o) else {
        return false;
    };
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
    )
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// 1件のJSON-RPCメッセージを処理する。通知の場合は None
pub async fn handle_message(core: &Core, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let id = match id {
        Some(v) if !v.is_null() => v,
        // 通知 (notifications/initialized など) とレスポンスには応答しない
        _ => return None,
    };
    let reply = match method {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or("");
            let version = if SUPPORTED_VERSIONS.contains(&requested) {
                requested
            } else {
                SUPPORTED_VERSIONS[0]
            };
            rpc_result(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": {
                        "name": "llm-model-searcher",
                        "title": "LLM Model Searcher",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "instructions": "Search Hugging Face LLMs, estimate whether each model/quantization fits this PC (VRAM/RAM, tok/s), get recommendations by use case, inspect the local model library and start downloads. Call get_hardware first to understand the machine."
                }),
            )
        }
        "ping" => rpc_result(&id, json!({})),
        "tools/list" | "tools/call" => match forward(core, method, params).await {
            Ok(v) => rpc_result(&id, v),
            Err(e) => rpc_error(&id, -32603, e),
        },
        _ => rpc_error(&id, -32601, format!("method not found: {method}")),
    };
    Some(reply)
}

async fn post_mcp(State(core): State<Arc<Core>>, headers: HeaderMap, body: Bytes) -> Response {
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    if !origin_allowed(origin) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        let e = rpc_error(&Value::Null, -32700, "parse error");
        return (StatusCode::BAD_REQUEST, axum::Json(e)).into_response();
    };
    let reply = if let Value::Array(items) = &msg {
        let mut out = Vec::new();
        for m in items {
            if let Some(r) = handle_message(&core, m).await {
                out.push(r);
            }
        }
        (!out.is_empty()).then_some(Value::Array(out))
    } else {
        handle_message(&core, &msg).await
    };
    match reply {
        Some(r) => axum::Json(r).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn get_mcp() -> Response {
    // サーバーからのSSEストリームは提供しない
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

pub struct RunningServer {
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub url: Option<String>,
    pub error: Option<String>,
}

/// 設定に合わせてサーバーを起動・停止・再起動する
pub async fn reconcile(core: &Arc<Core>) {
    let (enabled, port) = {
        let s = &core.user.lock().unwrap().settings;
        (s.mcp_enabled, s.mcp_port)
    };
    let current = core.mcp_server.lock().unwrap().as_ref().map(|s| s.port);
    if enabled && current == Some(port) {
        return;
    }
    // 停止 (Dropでシャットダウンを通知する)
    *core.mcp_server.lock().unwrap() = None;
    *core.mcp_error.lock().unwrap() = None;
    if !enabled {
        return;
    }
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            *core.mcp_error.lock().unwrap() = Some(format!("port {port}: {e}"));
            return;
        }
    };
    let (tx, rx) = oneshot::channel::<()>();
    let app = Router::new()
        .route("/mcp", post(post_mcp).get(get_mcp))
        .with_state(core.clone());
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    *core.mcp_server.lock().unwrap() = Some(RunningServer {
        port,
        shutdown: Some(tx),
    });
}

pub fn status(core: &Core) -> McpStatus {
    let server = core.mcp_server.lock().unwrap();
    McpStatus {
        running: server.is_some(),
        url: server
            .as_ref()
            .map(|s| format!("http://127.0.0.1:{}/mcp", s.port)),
        error: core.mcp_error.lock().unwrap().clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_check() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("http://localhost:3000")));
        assert!(origin_allowed(Some("http://127.0.0.1")));
        assert!(!origin_allowed(Some("https://evil.example.com")));
        assert!(!origin_allowed(Some("http://127.0.0.1.evil.com")));
        assert!(!origin_allowed(Some("null")));
    }
}
