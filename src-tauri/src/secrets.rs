//! Hugging Face トークンをOSの資格情報ストアに保存する
//! (Windows資格情報マネージャ / macOSキーチェーン / Linux Secret Service)

use anyhow::Result;
use keyring::Entry;

const SERVICE: &str = "LLMModelSearcher";
const ACCOUNT: &str = "huggingface-token";

fn entry() -> Result<Entry> {
    Ok(Entry::new(SERVICE, ACCOUNT)?)
}

pub fn load_token() -> Option<String> {
    entry()
        .ok()?
        .get_password()
        .ok()
        .filter(|t| !t.trim().is_empty())
}

pub fn save_token(token: &str) -> Result<()> {
    entry()?.set_password(token.trim())?;
    Ok(())
}

pub fn delete_token() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
