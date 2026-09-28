//! 保存済みモデルのインデックス管理、ディスク走査、削除、更新追跡

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::Result;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hf::HfClient;
use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFile {
    pub path: String,
    pub size: u64,
    pub lfs_oid: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelRef {
    pub id: String,
    pub created_at: Option<String>,
    pub downloads: Option<u64>,
    pub likes: Option<u64>,
    /// 派生の種類 (quantized / finetune / adapter / merge)
    pub relation: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackingInfo {
    pub checked_at: Option<DateTime<Utc>>,
    pub latest_sha: Option<String>,
    pub latest_last_modified: Option<String>,
    /// リポジトリにコミットが追加されたか
    pub repo_updated: bool,
    /// 保存済みファイルのうち内容が変わったもの
    pub changed_files: Vec<String>,
    /// リポジトリから削除されたファイル
    pub removed_files: Vec<String>,
    /// モデルカードの new_version 指定 (自身またはベースモデル)
    pub new_version: Option<String>,
    /// 同じ公開者・シリーズ名の後継モデル (名前からの推定)
    pub successors: Vec<ModelRef>,
    /// 同じベースモデルから、保存後に公開された派生モデル
    pub derivatives: Vec<ModelRef>,
    pub base_model: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRepo {
    pub repo_id: String,
    pub format: String,
    pub revision: Option<String>,
    pub downloaded_at: DateTime<Utc>,
    /// true の場合、ダウンロード記録がなく追跡開始時点を基準にしている
    #[serde(default)]
    pub baseline_only: bool,
    pub created_at: Option<String>,
    pub last_modified: Option<String>,
    #[serde(default)]
    pub base_models: Vec<String>,
    #[serde(default)]
    pub files: Vec<LibraryFile>,
    #[serde(default)]
    pub tracking: Option<TrackingInfo>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryIndex {
    pub repos: BTreeMap<String, LibraryRepo>,
}

/// ダウンロード時にフロントエンドから受け取るリポジトリ情報
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMeta {
    pub format: String,
    pub created_at: Option<String>,
    pub last_modified: Option<String>,
    #[serde(default)]
    pub base_models: Vec<String>,
}

impl LibraryIndex {
    pub fn register_file(
        &mut self,
        repo_id: &str,
        revision: &str,
        meta: &RepoMeta,
        file: LibraryFile,
    ) {
        let rec = self
            .repos
            .entry(repo_id.to_string())
            .or_insert_with(|| LibraryRepo {
                repo_id: repo_id.to_string(),
                format: meta.format.clone(),
                revision: None,
                downloaded_at: Utc::now(),
                baseline_only: false,
                created_at: None,
                last_modified: None,
                base_models: Vec::new(),
                files: Vec::new(),
                tracking: None,
            });
        rec.revision = Some(revision.to_string());
        rec.downloaded_at = Utc::now();
        rec.baseline_only = false;
        rec.created_at = meta.created_at.clone().or(rec.created_at.take());
        rec.last_modified = meta.last_modified.clone().or(rec.last_modified.take());
        if !meta.base_models.is_empty() {
            rec.base_models = meta.base_models.clone();
        }
        rec.files.retain(|f| f.path != file.path);
        rec.files.push(file);
        rec.files.sort_by(|a, b| a.path.cmp(&b.path));
        // 新しいリビジョンを取得したので、更新検出結果はリセットする
        if let Some(t) = rec.tracking.as_mut() {
            t.repo_updated = false;
            t.changed_files.clear();
            t.removed_files.clear();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub path: String,
    pub size: u64,
    pub modified: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepo {
    pub repo_id: String,
    pub dir: String,
    pub format: String,
    pub files: Vec<LocalFile>,
    pub incomplete_files: Vec<LocalFile>,
    pub total_size: u64,
    pub record: Option<LibraryRepo>,
}

fn is_model_file(name: &str) -> bool {
    let l = name.to_lowercase();
    l.ends_with(".gguf") || l.ends_with(".safetensors")
}

fn walk(dir: &Path, base: &Path, depth: u32, out: &mut Vec<(String, std::fs::Metadata)>) {
    if depth > 4 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if md.is_dir() {
            walk(&p, base, depth + 1, out);
        } else if let Ok(rel) = p.strip_prefix(base) {
            let rel = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, md));
        }
    }
}

fn guess_format(files: &[LocalFile]) -> String {
    if files.iter().any(|f| f.path.to_lowercase().ends_with(".gguf")) {
        "gguf".into()
    } else {
        "safetensors".into()
    }
}

/// `<models_dir>/<publisher>/<repo>` を走査してローカルのモデル一覧を作る
pub fn scan(models_dir: &Path, index: &LibraryIndex) -> Vec<LocalRepo> {
    let mut out = Vec::new();
    let Ok(owners) = std::fs::read_dir(models_dir) else {
        return out;
    };
    for owner in owners.flatten() {
        if !owner.path().is_dir() {
            continue;
        }
        let Ok(repos) = std::fs::read_dir(owner.path()) else {
            continue;
        };
        for repo in repos.flatten() {
            let dir = repo.path();
            if !dir.is_dir() {
                continue;
            }
            let repo_id = format!(
                "{}/{}",
                owner.file_name().to_string_lossy(),
                repo.file_name().to_string_lossy()
            );
            let mut raw = Vec::new();
            walk(&dir, &dir, 0, &mut raw);
            let mut files = Vec::new();
            let mut incomplete = Vec::new();
            for (rel, md) in raw {
                let lf = LocalFile {
                    size: md.len(),
                    modified: md.modified().ok().map(DateTime::<Utc>::from),
                    path: rel.clone(),
                };
                if let Some(stripped) = rel.strip_suffix(".part") {
                    incomplete.push(LocalFile {
                        path: stripped.to_string(),
                        ..lf
                    });
                } else {
                    files.push(lf);
                }
            }
            if !files.iter().any(|f| is_model_file(&f.path)) && incomplete.is_empty() {
                continue;
            }
            files.sort_by(|a, b| a.path.cmp(&b.path));
            let record = index.repos.get(&repo_id).cloned();
            let format = record
                .as_ref()
                .map(|r| r.format.clone())
                .unwrap_or_else(|| guess_format(&files));
            out.push(LocalRepo {
                total_size: files.iter().map(|f| f.size).sum(),
                repo_id,
                dir: dir.to_string_lossy().into_owned(),
                format,
                files,
                incomplete_files: incomplete,
                record,
            });
        }
    }
    out.sort_by(|a, b| a.repo_id.to_lowercase().cmp(&b.repo_id.to_lowercase()));
    out
}

/// ファイルまたはリポジトリディレクトリを削除し、空になった親ディレクトリも片付ける
pub fn delete(models_dir: &Path, repo_id: &str, file: Option<&str>) -> Result<()> {
    let repo_dir = paths::repo_dir(models_dir, repo_id)?;
    match file {
        Some(rel) => {
            let target = paths::file_path(models_dir, repo_id, rel)?;
            paths::ensure_within(models_dir, &target)?;
            std::fs::remove_file(&target)?;
            let mut parent: Option<PathBuf> = target.parent().map(|p| p.to_path_buf());
            while let Some(p) = parent {
                if p == models_dir || !p.starts_with(models_dir) {
                    break;
                }
                if std::fs::remove_dir(&p).is_err() {
                    break; // 空でなければ止める
                }
                parent = p.parent().map(|x| x.to_path_buf());
            }
        }
        None => {
            paths::ensure_within(models_dir, &repo_dir)?;
            std::fs::remove_dir_all(&repo_dir)?;
            if let Some(owner) = repo_dir.parent() {
                let _ = std::fs::remove_dir(owner);
            }
        }
    }
    Ok(())
}

// ---- 追跡 ----

fn series_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?P<fam>[A-Za-z]+(?:-[A-Za-z]+)*?)[-_]?(?P<ver>\d+(?:\.\d+)*)").unwrap()
    })
}

fn quant_variant_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)[-_](fp8|fp4|nvfp4|gptq|awq|int[48]|gguf|mlx|bnb|\d+bit)([-_]|$)").unwrap())
}

/// モデル名からシリーズ名とバージョンを推定する (例: "Qwen3-8B" -> ("qwen", [3]))
pub fn parse_series(name: &str) -> Option<(String, Vec<u32>)> {
    let caps = series_re().captures(name)?;
    let ver = caps.name("ver")?;
    // "gpt-oss-20b" の 20 のようにパラメータ数を表す数字はバージョンではない
    let rest = &name[ver.end()..];
    let mut chars = rest.chars();
    if let Some(c) = chars.next() {
        if matches!(c, 'b' | 'B' | 'm' | 'M' | 'k' | 'K')
            && !chars.next().map(|n| n.is_ascii_alphabetic()).unwrap_or(false)
        {
            return None;
        }
    }
    let v: Vec<u32> = ver
        .as_str()
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();
    Some((caps["fam"].to_lowercase(), v))
}

fn cmp_version(a: &[u32], b: &[u32]) -> std::cmp::Ordering {
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

fn base_models_of(info: &Value) -> Vec<String> {
    match &info["cardData"]["base_model"] {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

fn model_ref(v: &Value) -> ModelRef {
    ModelRef {
        id: v["id"].as_str().unwrap_or_default().to_string(),
        created_at: v["createdAt"].as_str().map(|s| s.to_string()),
        downloads: v["downloads"].as_u64(),
        likes: v["likes"].as_u64(),
        relation: None,
    }
}

fn q(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

fn after(created: &Option<String>, since: &DateTime<Utc>) -> bool {
    created
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc) > *since)
        .unwrap_or(false)
}

pub async fn check_repo(hf: &HfClient, rec: &LibraryRepo) -> TrackingInfo {
    match check_repo_inner(hf, rec).await {
        Ok(t) => t,
        Err(e) => {
            let mut t = rec.tracking.clone().unwrap_or_default();
            t.checked_at = Some(Utc::now());
            t.error = Some(format!("{e:#}"));
            t
        }
    }
}

async fn check_repo_inner(hf: &HfClient, rec: &LibraryRepo) -> Result<TrackingInfo> {
    let info = hf.model_info(&rec.repo_id).await?;
    let mut t = TrackingInfo {
        checked_at: Some(Utc::now()),
        latest_sha: info["sha"].as_str().map(|s| s.to_string()),
        latest_last_modified: info["lastModified"].as_str().map(|s| s.to_string()),
        ..Default::default()
    };
    t.repo_updated = match (&rec.revision, &t.latest_sha) {
        (Some(a), Some(b)) => a != b,
        _ => false,
    };

    // 保存済みファイルの内容変化 (LFSのsha256比較)
    let siblings = info["siblings"].as_array().cloned().unwrap_or_default();
    for f in &rec.files {
        match siblings
            .iter()
            .find(|s| s["rfilename"].as_str() == Some(f.path.as_str()))
        {
            None => t.removed_files.push(f.path.clone()),
            Some(s) => {
                let remote = s["lfs"]["sha256"].as_str();
                if let (Some(r), Some(l)) = (remote, f.lfs_oid.as_deref()) {
                    if r != l {
                        t.changed_files.push(f.path.clone());
                    }
                }
            }
        }
    }

    let bases = base_models_of(&info);
    let base = bases.first().cloned().unwrap_or_else(|| rec.repo_id.clone());
    t.base_model = Some(base.clone());

    // new_version: 自身のモデルカード、次にベースモデルのモデルカード
    t.new_version = info["cardData"]["new_version"].as_str().map(|s| s.to_string());
    if t.new_version.is_none() && base != rec.repo_id {
        if let Ok(bi) = hf.model_info(&base).await {
            t.new_version = bi["cardData"]["new_version"].as_str().map(|s| s.to_string());
        }
    }

    let since = rec.downloaded_at;

    // 派生モデル: 同じベースモデルを持ち、保存後に公開されたもの
    let deriv = hf
        .list_models(&[
            q("filter", &format!("base_model:{base}")),
            q("sort", "createdAt"),
            q("direction", "-1"),
            q("limit", "40"),
            q("expand[]", "createdAt"),
            q("expand[]", "downloads"),
            q("expand[]", "likes"),
            q("expand[]", "tags"),
        ])
        .await;
    if let Ok(Value::Array(items)) = deriv {
        for it in items {
            let mut r = model_ref(&it);
            if r.id == rec.repo_id || !after(&r.created_at, &since) {
                continue;
            }
            let prefix = "base_model:";
            r.relation = it["tags"].as_array().and_then(|tags| {
                tags.iter().filter_map(|x| x.as_str()).find_map(|tag| {
                    let rest = tag.strip_prefix(prefix)?;
                    let (rel, target) = rest.split_once(':')?;
                    (target == base).then(|| rel.to_string())
                })
            });
            t.derivatives.push(r);
        }
    }

    // 後継モデル: 同じ公開者・シリーズ名でバージョンが大きいもの (推定)
    if let Some((author, name)) = base.split_once('/') {
        if let Some((fam, ver)) = parse_series(name) {
            let found = hf
                .list_models(&[
                    q("author", author),
                    q("search", &fam),
                    q("sort", "createdAt"),
                    q("direction", "-1"),
                    q("limit", "100"),
                    q("expand[]", "createdAt"),
                    q("expand[]", "downloads"),
                    q("expand[]", "likes"),
                ])
                .await;
            if let Ok(Value::Array(items)) = found {
                for it in items {
                    let r = model_ref(&it);
                    let Some((_, n)) = r.id.split_once('/') else {
                        continue;
                    };
                    // 同じモデルの量子化配布 (FP8 / GPTQ など) は後継として重複させない
                    if quant_variant_re().is_match(n) {
                        continue;
                    }
                    if let Some((f2, v2)) = parse_series(n) {
                        if f2 == fam && cmp_version(&v2, &ver) == std::cmp::Ordering::Greater {
                            t.successors.push(r);
                        }
                    }
                }
                t.successors.truncate(15);
            }
        }
    }

    Ok(t)
}

/// ダウンロード記録のないローカルモデルを、現在のリモート状態を基準に追跡対象へ加える
pub async fn adopt(hf: &HfClient, local: &LocalRepo) -> Result<LibraryRepo> {
    let info = hf.model_info(&local.repo_id).await?;
    let siblings = info["siblings"].as_array().cloned().unwrap_or_default();
    let files = local
        .files
        .iter()
        .filter(|f| is_model_file(&f.path))
        .map(|f| LibraryFile {
            path: f.path.clone(),
            size: f.size,
            lfs_oid: siblings
                .iter()
                .find(|s| s["rfilename"].as_str() == Some(f.path.as_str()))
                .and_then(|s| s["lfs"]["sha256"].as_str().map(|x| x.to_string())),
        })
        .collect();
    let downloaded_at = local
        .files
        .iter()
        .filter_map(|f| f.modified)
        .max()
        .unwrap_or_else(Utc::now);
    Ok(LibraryRepo {
        repo_id: local.repo_id.clone(),
        format: local.format.clone(),
        revision: info["sha"].as_str().map(|s| s.to_string()),
        downloaded_at,
        baseline_only: true,
        created_at: info["createdAt"].as_str().map(|s| s.to_string()),
        last_modified: info["lastModified"].as_str().map(|s| s.to_string()),
        base_models: base_models_of(&info),
        files,
        tracking: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_parse() {
        assert_eq!(parse_series("Qwen3-8B"), Some(("qwen".into(), vec![3])));
        assert_eq!(parse_series("Llama-3.1-8B-Instruct"), Some(("llama".into(), vec![3, 1])));
        assert_eq!(parse_series("gemma-3-12b-it"), Some(("gemma".into(), vec![3])));
        assert_eq!(
            parse_series("Mistral-Small-3.2-24B-Instruct-2506"),
            Some(("mistral-small".into(), vec![3, 2]))
        );
        assert_eq!(parse_series("Qwen2.5-Coder-7B"), Some(("qwen".into(), vec![2, 5])));
        assert_eq!(parse_series("gpt-oss-20b"), None);
    }

    #[test]
    fn version_compare() {
        use std::cmp::Ordering::*;
        assert_eq!(cmp_version(&[3], &[2, 5]), Greater);
        assert_eq!(cmp_version(&[3, 1], &[3]), Greater);
        assert_eq!(cmp_version(&[3, 0], &[3]), Equal);
    }

    #[test]
    fn scan_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = root.join("pub").join("Model-GGUF");
        std::fs::create_dir_all(repo.join("Q4")).unwrap();
        std::fs::write(repo.join("Q4").join("m.gguf"), b"1234").unwrap();
        std::fs::write(repo.join("n.gguf.part"), b"12").unwrap();
        std::fs::create_dir_all(root.join("x").join("empty")).unwrap();

        let list = scan(root, &LibraryIndex::default());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].repo_id, "pub/Model-GGUF");
        assert_eq!(list[0].files[0].path, "Q4/m.gguf");
        assert_eq!(list[0].incomplete_files[0].path, "n.gguf");
        assert_eq!(list[0].total_size, 4);

        delete(root, "pub/Model-GGUF", Some("Q4/m.gguf")).unwrap();
        assert!(!repo.join("Q4").exists());
        delete(root, "pub/Model-GGUF", None).unwrap();
        assert!(!root.join("pub").exists());
        assert!(delete(root, "pub/../x", None).is_err());
    }

    #[test]
    fn register_updates_record() {
        let mut idx = LibraryIndex::default();
        let meta = RepoMeta {
            format: "gguf".into(),
            created_at: Some("2025-01-01T00:00:00Z".into()),
            last_modified: None,
            base_models: vec!["a/base".into()],
        };
        let f = |p: &str| LibraryFile { path: p.into(), size: 1, lfs_oid: None };
        idx.register_file("a/b", "sha1", &meta, f("x.gguf"));
        idx.register_file("a/b", "sha2", &meta, f("x.gguf"));
        idx.register_file("a/b", "sha2", &meta, f("y.gguf"));
        let r = &idx.repos["a/b"];
        assert_eq!(r.files.len(), 2);
        assert_eq!(r.revision.as_deref(), Some("sha2"));
        assert_eq!(r.base_models, vec!["a/base".to_string()]);
    }
}
