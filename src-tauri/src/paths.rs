//! モデル保存先パスの組み立てと検証 (パストラバーサル防止)

use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Result};

/// `publisher/repo` 形式のリポジトリIDを検証する
pub fn validate_repo_id(repo_id: &str) -> Result<(&str, &str)> {
    let mut parts = repo_id.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        bail!("invalid repo id: {repo_id}");
    };
    let ok = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !ok(owner) || !ok(name) {
        bail!("invalid repo id: {repo_id}");
    }
    Ok((owner, name))
}

/// リポジトリ内の相対ファイルパスを検証し、安全な相対PathBufにする
pub fn validate_rel_path(rel: &str) -> Result<PathBuf> {
    if rel.is_empty() || rel.contains('\\') || rel.contains(':') {
        bail!("invalid file path: {rel}");
    }
    let mut out = PathBuf::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(s) => out.push(s),
            _ => bail!("invalid file path: {rel}"),
        }
    }
    Ok(out)
}

/// `<models_dir>/<publisher>/<repo>`
pub fn repo_dir(models_dir: &Path, repo_id: &str) -> Result<PathBuf> {
    let (owner, name) = validate_repo_id(repo_id)?;
    Ok(models_dir.join(owner).join(name))
}

/// `<models_dir>/<publisher>/<repo>/<file>`
pub fn file_path(models_dir: &Path, repo_id: &str, rel: &str) -> Result<PathBuf> {
    Ok(repo_dir(models_dir, repo_id)?.join(validate_rel_path(rel)?))
}

/// 実在するパスがmodels_dir配下 (models_dir自身は除く) にあるか確認する
pub fn ensure_within(models_dir: &Path, target: &Path) -> Result<()> {
    let base = canonical(models_dir)?;
    let t = canonical(target)?;
    if !t.starts_with(&base) || t == base {
        bail!("path is outside of models directory: {}", target.display());
    }
    Ok(())
}

fn canonical(p: &Path) -> Result<PathBuf> {
    let c = std::fs::canonicalize(p)?;
    // Windowsの \\?\ プレフィックスを外して比較を安定させる
    #[cfg(windows)]
    {
        let s = c.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(stripped));
        }
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_id_validation() {
        assert!(validate_repo_id("unsloth/Qwen3-8B-GGUF").is_ok());
        assert!(validate_repo_id("a/b/c").is_err());
        assert!(validate_repo_id("../b").is_err());
        assert!(validate_repo_id("a").is_err());
        assert!(validate_repo_id("a/..").is_err());
    }

    #[test]
    fn rel_path_validation() {
        assert!(validate_rel_path("Q4_K_M/model-00001-of-00002.gguf").is_ok());
        assert!(validate_rel_path("../evil.gguf").is_err());
        assert!(validate_rel_path("/abs.gguf").is_err());
        assert!(validate_rel_path("C:/x.gguf").is_err());
        assert!(validate_rel_path("a\\b.gguf").is_err());
    }

    #[test]
    fn within_check() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("a").join("b");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(ensure_within(dir.path(), &inner).is_ok());
        assert!(ensure_within(dir.path(), dir.path()).is_err());
        assert!(ensure_within(&inner, dir.path()).is_err());
    }
}
