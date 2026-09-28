//! 実行マシンのハードウェア情報 (CPU / RAM / GPU / メモリ速度) の検出

use std::process::Command;

use serde::Serialize;
use sysinfo::System;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub vendor: String,
    pub vram_total: Option<u64>,
    pub vram_free: Option<u64>,
    /// "discrete" | "integrated" | "unified"
    pub kind: String,
    pub driver: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub cpu_threads: usize,
    pub ram_total: u64,
    pub ram_available: u64,
    pub gpus: Vec<GpuInfo>,
    pub memory_speed_mts: Option<u32>,
    pub memory_type: Option<String>,
    pub memory_modules: Option<u32>,
    /// Apple Siliconなど、CPUとGPUがメモリを共有する構成か
    pub unified_memory: bool,
    /// 推論バックエンドの候補 (CUDA / Metal / Vulkan / CPU など)
    pub backends: Vec<String>,
}

pub fn detect() -> HardwareInfo {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_default();
    let cpu_threads = sys.cpus().len();
    let cpu_cores = System::physical_core_count().unwrap_or(cpu_threads);

    let mut info = HardwareInfo {
        os: std::env::consts::OS.to_string(),
        os_version: System::long_os_version().unwrap_or_default(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_brand,
        cpu_cores,
        cpu_threads,
        ram_total: sys.total_memory(),
        ram_available: sys.available_memory(),
        gpus: Vec::new(),
        memory_speed_mts: None,
        memory_type: None,
        memory_modules: None,
        unified_memory: false,
        backends: Vec::new(),
    };

    let nvidia = detect_nvidia();
    platform_detect(&mut info, nvidia);

    let mut backends = Vec::new();
    if info.gpus.iter().any(|g| g.vendor == "NVIDIA") {
        backends.push("CUDA".to_string());
    }
    if info.unified_memory && info.os == "macos" {
        backends.push("Metal".to_string());
        backends.push("MLX".to_string());
    }
    if info
        .gpus
        .iter()
        .any(|g| g.vendor == "AMD" && g.kind == "discrete")
    {
        backends.push(if info.os == "linux" { "ROCm" } else { "Vulkan" }.to_string());
    }
    if info.gpus.iter().any(|g| g.vendor == "Intel" && g.kind == "discrete") {
        backends.push("Vulkan".to_string());
    }
    backends.push("CPU".to_string());
    backends.dedup();
    info.backends = backends;
    info
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // コンソールウィンドウを表示しない
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn detect_nvidia() -> Vec<GpuInfo> {
    let Some(out) = run(
        "nvidia-smi",
        &[
            "--query-gpu=name,memory.total,memory.free,driver_version",
            "--format=csv,noheader,nounits",
        ],
    ) else {
        return Vec::new();
    };
    parse_nvidia_smi(&out)
}

fn parse_nvidia_smi(out: &str) -> Vec<GpuInfo> {
    out.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            if cols.len() < 4 {
                return None;
            }
            let mib = |s: &str| s.parse::<u64>().ok().map(|v| v * 1024 * 1024);
            Some(GpuInfo {
                name: cols[0].to_string(),
                vendor: "NVIDIA".into(),
                vram_total: mib(cols[1]),
                vram_free: mib(cols[2]),
                kind: "discrete".into(),
                driver: Some(cols[3].to_string()),
            })
        })
        .collect()
}

#[cfg(any(windows, target_os = "macos"))]
fn vendor_of(name: &str) -> String {
    let n = name.to_lowercase();
    if n.contains("nvidia") || n.contains("geforce") || n.contains("quadro") {
        "NVIDIA"
    } else if n.contains("amd") || n.contains("radeon") {
        "AMD"
    } else if n.contains("intel") || n.contains("arc") {
        "Intel"
    } else if n.contains("apple") {
        "Apple"
    } else {
        "Other"
    }
    .into()
}

/// 名前から内蔵GPUかを推定する。
/// Strix Haloなど、BIOSで大容量VRAMを割り当てたAPUも内蔵として扱い、VRAM量は別途見る
#[cfg(any(windows, target_os = "macos", test))]
fn guess_kind(name: &str, _vram: Option<u64>) -> String {
    let n = name.to_lowercase();
    let integrated_name = n.contains("uhd")
        || n.contains("iris")
        || (n.contains("intel") && n.contains("graphics") && !n.contains("arc"))
        || n == "amd radeon(tm) graphics"
        || n == "amd radeon graphics"
        || n.contains("radeon(tm) 7")
        || n.contains("radeon 7")
        || n.contains("radeon 8");
    if integrated_name {
        "integrated".into()
    } else {
        "discrete".into()
    }
}

#[cfg(windows)]
fn platform_detect(info: &mut HardwareInfo, nvidia: Vec<GpuInfo>) {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let mut gpus = nvidia;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let class = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    if let Ok(key) = hklm.open_subkey(class) {
        for sub in key.enum_keys().flatten() {
            let Ok(dev) = key.open_subkey(&sub) else {
                continue;
            };
            let Ok(name) = dev.get_value::<String, _>("DriverDesc") else {
                continue;
            };
            let lower = name.to_lowercase();
            if lower.contains("basic display")
                || lower.contains("basic render")
                || lower.contains("virtual")
                || lower.contains("parsec")
                || lower.contains("remote")
                || lower.contains("indirect")
            {
                continue;
            }
            // nvidia-smiで取得済みのGPUはそちらを優先する
            if gpus.iter().any(|g| g.name.eq_ignore_ascii_case(&name))
                || (vendor_of(&name) == "NVIDIA" && gpus.iter().any(|g| g.vendor == "NVIDIA"))
            {
                continue;
            }
            // AdapterRAM (DWORD) は4GBで頭打ちになるため qwMemorySize を優先する
            let vram = dev
                .get_value::<u64, _>("HardwareInformation.qwMemorySize")
                .ok()
                .or_else(|| {
                    dev.get_raw_value("HardwareInformation.MemorySize")
                        .ok()
                        .and_then(|v| {
                            let b = v.bytes;
                            match b.len() {
                                4 => Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as u64),
                                8 => Some(u64::from_le_bytes([
                                    b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
                                ])),
                                _ => None,
                            }
                        })
                })
                .filter(|v| *v > 0);
            let driver = dev.get_value::<String, _>("DriverVersion").ok();
            if gpus.iter().any(|g| g.name == name) {
                continue;
            }
            gpus.push(GpuInfo {
                vendor: vendor_of(&name),
                kind: guess_kind(&name, vram),
                name,
                vram_total: vram,
                vram_free: None,
                driver,
            });
        }
    }
    info.gpus = gpus;

    // メモリ速度と種類 (SMBIOSMemoryType: 26=DDR4, 34=DDR5, 35=LPDDR5, 30=LPDDR4)
    if let Some(out) = run(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_PhysicalMemory | ForEach-Object { \"$($_.ConfiguredClockSpeed),$($_.SMBIOSMemoryType)\" }",
        ],
    ) {
        let rows: Vec<(u32, u32)> = out
            .lines()
            .filter_map(|l| {
                let mut it = l.trim().split(',');
                Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
            })
            .collect();
        if !rows.is_empty() {
            info.memory_modules = Some(rows.len() as u32);
            info.memory_speed_mts = rows.iter().map(|r| r.0).filter(|v| *v > 0).min();
            info.memory_type = match rows[0].1 {
                26 => Some("DDR4".into()),
                34 => Some("DDR5".into()),
                35 => Some("LPDDR5".into()),
                30 => Some("LPDDR4".into()),
                24 => Some("DDR3".into()),
                _ => None,
            };
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_detect(info: &mut HardwareInfo, nvidia: Vec<GpuInfo>) {
    let mut gpus = nvidia;
    let brand = run("sysctl", &["-n", "machdep.cpu.brand_string"]).unwrap_or_default();
    let brand = brand.trim().to_string();
    if brand.starts_with("Apple") {
        info.cpu_brand = brand.clone();
        info.unified_memory = true;
        info.memory_type = Some("Unified".into());
        gpus.push(GpuInfo {
            name: brand,
            vendor: "Apple".into(),
            vram_total: Some(info.ram_total),
            vram_free: None,
            kind: "unified".into(),
            driver: None,
        });
    } else if let Some(out) = run("system_profiler", &["SPDisplaysDataType", "-json"]) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
            for g in v["SPDisplaysDataType"].as_array().into_iter().flatten() {
                let name = g["sppci_model"].as_str().unwrap_or("GPU").to_string();
                let vram = g["spdisplays_vram"]
                    .as_str()
                    .or(g["spdisplays_vram_shared"].as_str())
                    .and_then(parse_size_label);
                gpus.push(GpuInfo {
                    vendor: vendor_of(&name),
                    kind: guess_kind(&name, vram),
                    name,
                    vram_total: vram,
                    vram_free: None,
                    driver: None,
                });
            }
        }
    }
    info.gpus = gpus;
}

#[cfg(target_os = "linux")]
fn platform_detect(info: &mut HardwareInfo, nvidia: Vec<GpuInfo>) {
    let mut gpus = nvidia;
    if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
        for e in entries.flatten() {
            let fname = e.file_name().to_string_lossy().to_string();
            if !fname.starts_with("card") || fname.contains('-') {
                continue;
            }
            let dev = e.path().join("device");
            let vendor_id = std::fs::read_to_string(dev.join("vendor")).unwrap_or_default();
            let vendor = match vendor_id.trim() {
                "0x1002" => "AMD",
                "0x8086" => "Intel",
                "0x10de" => continue, // nvidia-smiで取得する
                _ => continue,
            };
            let vram = std::fs::read_to_string(dev.join("mem_info_vram_total"))
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok());
            let name = std::fs::read_to_string(dev.join("product_name"))
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|_| format!("{vendor} GPU ({fname})"));
            // VRAM量が取れない、または2GB未満なら内蔵GPUとみなす
            let kind = if vram.map(|v| v < 2 * 1024 * 1024 * 1024).unwrap_or(true) {
                "integrated".to_string()
            } else {
                "discrete".to_string()
            };
            gpus.push(GpuInfo {
                name,
                vendor: vendor.into(),
                vram_total: vram,
                vram_free: std::fs::read_to_string(dev.join("mem_info_vram_used"))
                    .ok()
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .and_then(|used| vram.map(|t| t.saturating_sub(used))),
                kind,
                driver: None,
            });
        }
    }
    info.gpus = gpus;
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn platform_detect(info: &mut HardwareInfo, nvidia: Vec<GpuInfo>) {
    info.gpus = nvidia;
}

#[cfg(any(target_os = "macos", test))]
fn parse_size_label(s: &str) -> Option<u64> {
    let mut it = s.split_whitespace();
    let n: f64 = it.next()?.parse().ok()?;
    let unit = it.next().unwrap_or("MB").to_uppercase();
    let mul = match unit.as_str() {
        "GB" => 1024.0 * 1024.0 * 1024.0,
        "MB" => 1024.0 * 1024.0,
        _ => return None,
    };
    Some((n * mul) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvidia_smi_parse() {
        let g = parse_nvidia_smi("NVIDIA GeForce RTX 5070 Ti, 16303, 14800, 581.29\n");
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].name, "NVIDIA GeForce RTX 5070 Ti");
        assert_eq!(g[0].vram_total, Some(16303 * 1024 * 1024));
        assert_eq!(g[0].driver.as_deref(), Some("581.29"));
    }

    #[test]
    fn kind_guess() {
        assert_eq!(guess_kind("Intel(R) UHD Graphics 770", Some(128 << 20)), "integrated");
        assert_eq!(guess_kind("AMD Radeon RX 7900 XTX", Some(24 << 30)), "discrete");
        assert_eq!(guess_kind("Intel(R) Arc(TM) B580 Graphics", Some(12 << 30)), "discrete");
    }

    #[test]
    fn size_label() {
        assert_eq!(parse_size_label("8 GB"), Some(8 << 30));
        assert_eq!(parse_size_label("1536 MB"), Some(1536 << 20));
    }
}
