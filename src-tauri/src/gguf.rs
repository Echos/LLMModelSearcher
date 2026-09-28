//! GGUFヘッダ (メタデータKV) のパーサーと、モデル構造情報の抽出
//!
//! ファイル全体は数GB以上あるため、先頭のメタデータ部分だけを部分取得して解析する。
//! バッファが足りない場合は `ParseError::Incomplete` を返し、呼び出し側が追加取得して再試行する。

use std::collections::HashMap;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq)]
pub enum GgufValue {
    Int(i128),
    Float(f64),
    Bool(bool),
    Str(String),
    /// 要素数の少ない数値配列のみ保持する (層ごとのKVヘッド数など)
    NumArray(Vec<f64>),
    /// 保持しない配列 (トークナイザ語彙など)
    Skipped,
}

impl GgufValue {
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            GgufValue::Int(v) if *v >= 0 => Some(*v as u64),
            GgufValue::Float(v) if *v >= 0.0 => Some(*v as u64),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            GgufValue::Str(s) => Some(s),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum ParseError {
    Incomplete,
    Invalid(String),
}

const MAX_KEPT_ARRAY: u64 = 4096;

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], ParseError> {
        let end = self.pos.checked_add(n).ok_or(ParseError::Incomplete)?;
        if end > self.buf.len() {
            return Err(ParseError::Incomplete);
        }
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32, ParseError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, ParseError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn string(&mut self) -> Result<String, ParseError> {
        let len = self.u64()?;
        if len > 64 * 1024 * 1024 {
            return Err(ParseError::Invalid("string too long".into()));
        }
        Ok(String::from_utf8_lossy(self.take(len as usize)?).into_owned())
    }
    fn skip_string(&mut self) -> Result<(), ParseError> {
        let len = self.u64()?;
        self.take(usize::try_from(len).map_err(|_| ParseError::Invalid("len".into()))?)?;
        Ok(())
    }
}

fn scalar_size(t: u32) -> Option<usize> {
    match t {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4..=6 => Some(4),
        10..=12 => Some(8),
        _ => None,
    }
}

fn read_scalar(c: &mut Cursor, t: u32) -> Result<GgufValue, ParseError> {
    Ok(match t {
        0 => GgufValue::Int(c.take(1)?[0] as i128),
        1 => GgufValue::Int(c.take(1)?[0] as i8 as i128),
        2 => GgufValue::Int(u16::from_le_bytes(c.take(2)?.try_into().unwrap()) as i128),
        3 => GgufValue::Int(i16::from_le_bytes(c.take(2)?.try_into().unwrap()) as i128),
        4 => GgufValue::Int(c.u32()? as i128),
        5 => GgufValue::Int(i32::from_le_bytes(c.take(4)?.try_into().unwrap()) as i128),
        6 => GgufValue::Float(f32::from_le_bytes(c.take(4)?.try_into().unwrap()) as f64),
        7 => GgufValue::Bool(c.take(1)?[0] != 0),
        8 => GgufValue::Str(c.string()?),
        10 => GgufValue::Int(c.u64()? as i128),
        11 => GgufValue::Int(i64::from_le_bytes(c.take(8)?.try_into().unwrap()) as i128),
        12 => GgufValue::Float(f64::from_le_bytes(c.take(8)?.try_into().unwrap())),
        _ => return Err(ParseError::Invalid(format!("unknown value type {t}"))),
    })
}

fn read_value(c: &mut Cursor, t: u32) -> Result<GgufValue, ParseError> {
    if t != 9 {
        return read_scalar(c, t);
    }
    let item_t = c.u32()?;
    let len = c.u64()?;
    if item_t == 8 {
        for _ in 0..len {
            c.skip_string()?;
        }
        return Ok(GgufValue::Skipped);
    }
    if item_t == 9 {
        return Err(ParseError::Invalid("nested arrays are not supported".into()));
    }
    let size = scalar_size(item_t)
        .ok_or_else(|| ParseError::Invalid(format!("unknown array type {item_t}")))?;
    if len > MAX_KEPT_ARRAY {
        let total = usize::try_from(len)
            .ok()
            .and_then(|l| l.checked_mul(size))
            .ok_or_else(|| ParseError::Invalid("array too large".into()))?;
        c.take(total)?;
        return Ok(GgufValue::Skipped);
    }
    let mut out = Vec::with_capacity(len as usize);
    for _ in 0..len {
        match read_scalar(c, item_t)? {
            GgufValue::Int(v) => out.push(v as f64),
            GgufValue::Float(v) => out.push(v),
            GgufValue::Bool(b) => out.push(if b { 1.0 } else { 0.0 }),
            _ => {}
        }
    }
    Ok(GgufValue::NumArray(out))
}

/// GGUFのメタデータKVを解析する
pub fn parse_metadata(buf: &[u8]) -> Result<HashMap<String, GgufValue>, ParseError> {
    let mut c = Cursor { buf, pos: 0 };
    if c.take(4)? != b"GGUF" {
        return Err(ParseError::Invalid("not a GGUF file".into()));
    }
    let version = c.u32()?;
    if !(2..=3).contains(&version) {
        return Err(ParseError::Invalid(format!("unsupported GGUF version {version}")));
    }
    let _tensor_count = c.u64()?;
    let kv_count = c.u64()?;
    let mut map = HashMap::new();
    for _ in 0..kv_count {
        let key = c.string()?;
        let t = c.u32()?;
        let v = read_value(&mut c, t)?;
        map.insert(key, v);
    }
    Ok(map)
}

/// KVキャッシュ見積もりなどに使うモデル構造情報
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArch {
    pub source: String,
    pub architecture: Option<String>,
    pub context_length: Option<u64>,
    pub block_count: Option<u64>,
    pub embedding_length: Option<u64>,
    pub head_count: Option<u64>,
    pub head_count_kv: Option<f64>,
    /// f16 KVキャッシュのトークンあたりバイト数 (全層合計)
    pub kv_bytes_per_token: Option<u64>,
    pub expert_count: Option<u64>,
    pub expert_used_count: Option<u64>,
    pub sliding_window: Option<u64>,
    pub parameter_count: Option<u64>,
}

pub fn arch_from_gguf(meta: &HashMap<String, GgufValue>) -> ModelArch {
    let arch = meta
        .get("general.architecture")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let a = arch.clone().unwrap_or_default();
    let get = |k: &str| meta.get(&format!("{a}.{k}"));
    let get_u = |k: &str| get(k).and_then(|v| v.as_u64());

    let blocks = get_u("block_count");
    let heads = get("attention.head_count").and_then(|v| match v {
        GgufValue::NumArray(a) => a.iter().cloned().fold(None, |m: Option<f64>, x| {
            Some(m.map_or(x, |m| m.max(x)))
        }).map(|x| x as u64),
        other => other.as_u64(),
    });
    let emb = get_u("embedding_length");
    let key_len = get_u("attention.key_length")
        .or_else(|| match (emb, heads) {
            (Some(e), Some(h)) if h > 0 => Some(e / h),
            _ => None,
        });
    let val_len = get_u("attention.value_length").or(key_len);

    // head_count_kv はスカラーまたは層ごとの配列 (SSM層は0)
    let (kv_heads_sum, kv_heads_avg) = match get("attention.head_count_kv") {
        Some(GgufValue::NumArray(arr)) if !arr.is_empty() => {
            let s: f64 = arr.iter().sum();
            (Some(s), Some(s / arr.len() as f64))
        }
        Some(v) => match (v.as_u64(), blocks) {
            (Some(h), Some(b)) => (Some((h * b) as f64), Some(h as f64)),
            _ => (None, None),
        },
        None => match (heads, blocks) {
            (Some(h), Some(b)) => (Some((h * b) as f64), Some(h as f64)),
            _ => (None, None),
        },
    };

    let kv_bytes = if let Some(rank) = get_u("attention.kv_lora_rank") {
        // MLA (DeepSeek系) は圧縮済み潜在ベクトルのみ保持する
        let rope = get_u("rope.dimension_count").unwrap_or(64);
        blocks.map(|b| b * (rank + rope) * 2)
    } else {
        match (kv_heads_sum, key_len, val_len) {
            (Some(s), Some(k), Some(v)) => Some((s * (k + v) as f64 * 2.0) as u64),
            _ => None,
        }
    };

    ModelArch {
        source: "gguf".into(),
        architecture: arch,
        context_length: get_u("context_length"),
        block_count: blocks,
        embedding_length: emb,
        head_count: heads,
        head_count_kv: kv_heads_avg,
        kv_bytes_per_token: kv_bytes,
        expert_count: get_u("expert_count"),
        expert_used_count: get_u("expert_used_count"),
        sliding_window: get_u("attention.sliding_window"),
        parameter_count: meta.get("general.parameter_count").and_then(|v| v.as_u64()),
    }
}

/// transformers形式の config.json から構造情報を抽出する
pub fn arch_from_config(cfg: &serde_json::Value) -> ModelArch {
    // VLMは text_config 側に言語モデルの設定を持つ
    let c = if cfg.get("num_hidden_layers").is_none() && cfg.get("text_config").is_some() {
        &cfg["text_config"]
    } else {
        cfg
    };
    let u = |k: &str| c.get(k).and_then(|v| v.as_u64());
    let layers = u("num_hidden_layers");
    let heads = u("num_attention_heads");
    let kv_heads = u("num_key_value_heads").or(heads);
    let hidden = u("hidden_size");
    let head_dim = u("head_dim").or_else(|| match (hidden, heads) {
        (Some(h), Some(n)) if n > 0 => Some(h / n),
        _ => None,
    });
    // layer_types があれば、KVキャッシュを持つ層 (full/sliding attention) だけを数える
    let kv_layers = c
        .get("layer_types")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|t| {
                    let s = t.as_str().unwrap_or("");
                    s.contains("attention") && !s.contains("linear")
                })
                .count() as u64
        })
        .or(layers);

    let kv_bytes = if let Some(rank) = u("kv_lora_rank") {
        let rope = u("qk_rope_head_dim").unwrap_or(64);
        layers.map(|l| l * (rank + rope) * 2)
    } else {
        match (kv_layers, kv_heads, head_dim) {
            (Some(l), Some(h), Some(d)) => Some(l * h * d * 2 * 2),
            _ => None,
        }
    };

    ModelArch {
        source: "config".into(),
        architecture: cfg
            .get("model_type")
            .or(c.get("model_type"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        context_length: u("max_position_embeddings"),
        block_count: layers,
        embedding_length: hidden,
        head_count: heads,
        head_count_kv: kv_heads.map(|v| v as f64),
        kv_bytes_per_token: kv_bytes,
        expert_count: u("num_local_experts")
            .or(u("num_experts"))
            .or(u("n_routed_experts")),
        expert_used_count: u("num_experts_per_tok"),
        sliding_window: u("sliding_window"),
        parameter_count: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_str(b: &mut Vec<u8>, s: &str) {
        b.extend((s.len() as u64).to_le_bytes());
        b.extend(s.as_bytes());
    }
    fn kv_u32(b: &mut Vec<u8>, k: &str, v: u32) {
        put_str(b, k);
        b.extend(4u32.to_le_bytes());
        b.extend(v.to_le_bytes());
    }

    fn sample() -> Vec<u8> {
        let mut b = Vec::new();
        b.extend(b"GGUF");
        b.extend(3u32.to_le_bytes());
        b.extend(0u64.to_le_bytes());
        b.extend(8u64.to_le_bytes());
        put_str(&mut b, "general.architecture");
        b.extend(8u32.to_le_bytes());
        put_str(&mut b, "llama");
        kv_u32(&mut b, "llama.block_count", 32);
        kv_u32(&mut b, "llama.embedding_length", 4096);
        kv_u32(&mut b, "llama.attention.head_count", 32);
        kv_u32(&mut b, "llama.attention.head_count_kv", 8);
        kv_u32(&mut b, "llama.context_length", 131072);
        // 文字列配列 (語彙) はスキップされる
        put_str(&mut b, "tokenizer.ggml.tokens");
        b.extend(9u32.to_le_bytes());
        b.extend(8u32.to_le_bytes());
        b.extend(2u64.to_le_bytes());
        put_str(&mut b, "a");
        put_str(&mut b, "b");
        // 大きな数値配列もスキップされる
        put_str(&mut b, "tokenizer.ggml.token_type");
        b.extend(9u32.to_le_bytes());
        b.extend(5u32.to_le_bytes());
        b.extend(5000u64.to_le_bytes());
        b.extend(vec![0u8; 5000 * 4]);
        b
    }

    #[test]
    fn parse_llama_like() {
        let meta = parse_metadata(&sample()).unwrap();
        let a = arch_from_gguf(&meta);
        assert_eq!(a.architecture.as_deref(), Some("llama"));
        assert_eq!(a.block_count, Some(32));
        assert_eq!(a.context_length, Some(131072));
        // 32層 * 8KVヘッド * (128+128) * 2バイト = 131072
        assert_eq!(a.kv_bytes_per_token, Some(131072));
        assert_eq!(meta.get("tokenizer.ggml.tokens"), Some(&GgufValue::Skipped));
    }

    #[test]
    fn incomplete_buffer() {
        let s = sample();
        assert_eq!(parse_metadata(&s[..40]), Err(ParseError::Incomplete));
        assert_eq!(parse_metadata(&s[..s.len() - 10]), Err(ParseError::Incomplete));
    }

    #[test]
    fn invalid_magic() {
        assert!(matches!(parse_metadata(b"XXXXzzzzzzzzzzzzzzzzzzzz"), Err(ParseError::Invalid(_))));
    }

    #[test]
    fn per_layer_kv_heads() {
        let mut meta = HashMap::new();
        meta.insert("general.architecture".into(), GgufValue::Str("hyb".into()));
        meta.insert("hyb.block_count".into(), GgufValue::Int(4));
        meta.insert("hyb.attention.head_count".into(), GgufValue::Int(8));
        meta.insert("hyb.embedding_length".into(), GgufValue::Int(1024));
        meta.insert(
            "hyb.attention.head_count_kv".into(),
            GgufValue::NumArray(vec![0.0, 2.0, 0.0, 2.0]),
        );
        let a = arch_from_gguf(&meta);
        // KVヘッド合計4 * (128+128) * 2 = 2048
        assert_eq!(a.kv_bytes_per_token, Some(2048));
    }

    #[test]
    fn config_json() {
        let cfg = serde_json::json!({
            "model_type": "qwen3",
            "num_hidden_layers": 36,
            "num_attention_heads": 32,
            "num_key_value_heads": 8,
            "hidden_size": 4096,
            "head_dim": 128,
            "max_position_embeddings": 40960
        });
        let a = arch_from_config(&cfg);
        assert_eq!(a.kv_bytes_per_token, Some(36 * 8 * 128 * 4));
        assert_eq!(a.context_length, Some(40960));
    }

    #[test]
    fn config_json_hybrid_layers() {
        let cfg = serde_json::json!({
            "text_config": {
                "num_hidden_layers": 4,
                "num_attention_heads": 8,
                "num_key_value_heads": 2,
                "hidden_size": 1024,
                "layer_types": ["linear_attention", "full_attention", "linear_attention", "full_attention"]
            }
        });
        let a = arch_from_config(&cfg);
        assert_eq!(a.kv_bytes_per_token, Some(2 * 2 * 128 * 4));
    }
}
