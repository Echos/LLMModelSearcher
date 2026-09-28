import { describe, expect, it } from "vitest";
import { lookupBandwidth, systemMemoryBandwidth } from "./bandwidth";
import { buildProfile, estimateFit, pickBestQuant, type MachineProfile } from "./estimate";
import { baseModelsFromTags, paramsFromName, toSummary } from "./hfmodel";
import { groupGgufFiles, parseQuant, safetensorsBundle } from "./quant";
import type { HardwareInfo, Settings } from "./types";

const GB = 1024 ** 3;

const settings: Settings = {
  modelsDir: null,
  language: "ja",
  theme: "system",
  maxConcurrentDownloads: 2,
  updateCheckIntervalHours: 6,
  defaultContextLength: 8192,
  minTokensPerSec: 10,
  verifyHash: true,
  vramOverrideGb: null,
  gpuBandwidthOverrideGbps: null,
  ramBandwidthOverrideGbps: null,
};

const hw: HardwareInfo = {
  os: "windows",
  osVersion: "Windows 11",
  arch: "x86_64",
  cpuBrand: "AMD Ryzen 7 8700F",
  cpuCores: 8,
  cpuThreads: 16,
  ramTotal: 96 * GB,
  ramAvailable: 80 * GB,
  gpus: [
    { name: "NVIDIA GeForce RTX 5070 Ti", vendor: "NVIDIA", vramTotal: 16 * GB, vramFree: null, kind: "discrete", driver: null },
  ],
  memorySpeedMts: 5600,
  memoryModules: 2,
  memoryType: "DDR5",
  unifiedMemory: false,
  backends: ["CUDA", "CPU"],
};

describe("quant", () => {
  it("parses quant names", () => {
    expect(parseQuant("Qwen3-8B-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(parseQuant("Qwen3-8B-UD-Q4_K_XL.gguf")).toBe("Q4_K_XL");
    expect(parseQuant("Q8_0/model-00001-of-00002.gguf")).toBe("Q8_0");
    expect(parseQuant("gemma-3-12b-it-IQ4_XS.gguf")).toBe("IQ4_XS");
    expect(parseQuant("model-BF16.gguf")).toBe("BF16");
    expect(parseQuant("Qwen3-8B-4bit")).toBe("4BIT");
    expect(parseQuant("gpt-oss-20b-MXFP4.gguf")).toBe("MXFP4");
    expect(parseQuant("README.md")).toBeNull();
  });

  it("groups split GGUF files and mmproj", () => {
    const groups = groupGgufFiles([
      { path: "Q4_K_M/m-Q4_K_M-00001-of-00002.gguf", size: 10, sha256: null },
      { path: "Q4_K_M/m-Q4_K_M-00002-of-00002.gguf", size: 5, sha256: null },
      { path: "m-Q8_0.gguf", size: 20, sha256: null },
      { path: "mmproj-F16.gguf", size: 1, sha256: null },
      { path: "README.md", size: 1, sha256: null },
    ]);
    expect(groups).toHaveLength(3);
    const q4 = groups.find((g) => g.quant === "Q4_K_M")!;
    expect(q4.files).toHaveLength(2);
    expect(q4.totalSize).toBe(15);
    expect(groups.find((g) => g.isMmproj)?.label).toBe("mmproj F16");
  });

  it("builds a safetensors bundle without duplicate formats", () => {
    const b = safetensorsBundle([
      { path: "model.safetensors", size: 100, sha256: null },
      { path: "config.json", size: 1, sha256: null },
      { path: "pytorch_model.bin", size: 100, sha256: null },
      { path: "original/consolidated.pth", size: 100, sha256: null },
      { path: ".gitattributes", size: 1, sha256: null },
    ])!;
    expect(b.files.map((f) => f.path)).toEqual(["model.safetensors", "config.json"]);
  });
});

describe("hfmodel", () => {
  it("parses params from names", () => {
    expect(paramsFromName("Qwen3-8B-GGUF")).toEqual({ total: 8e9, active: null });
    expect(paramsFromName("Qwen3-30B-A3B-GGUF")).toEqual({ total: 30e9, active: 3e9 });
    expect(paramsFromName("gemma-3-270m-it")).toEqual({ total: 270e6, active: null });
    expect(paramsFromName("Mixtral-8x7B").active).toBeGreaterThan(0);
  });

  it("extracts base models from tags", () => {
    expect(baseModelsFromTags(["base_model:Qwen/Qwen3-8B", "base_model:quantized:Qwen/Qwen3-8B", "gguf"])).toEqual([
      "Qwen/Qwen3-8B",
    ]);
  });

  it("normalizes API results", () => {
    const s = toSummary({
      id: "unsloth/Qwen3-8B-GGUF",
      downloads: 10,
      tags: ["gguf", "license:apache-2.0", "base_model:quantized:Qwen/Qwen3-8B"],
      gguf: { total: 8190735360, context_length: 40960, architecture: "qwen3" },
    });
    expect(s.format).toBe("gguf");
    expect(s.paramsTotal).toBe(8190735360);
    expect(s.license).toBe("apache-2.0");
    expect(s.baseModels).toEqual(["Qwen/Qwen3-8B"]);
  });
});

describe("estimate", () => {
  const profile = buildProfile(hw, settings);

  it("builds a profile from detected hardware", () => {
    expect(lookupBandwidth("NVIDIA GeForce RTX 5070 Ti")).toBe(896);
    expect(lookupBandwidth("NVIDIA GeForce RTX 4070 Laptop GPU")).toBe(Math.round(504 * 0.7));
    expect(lookupBandwidth("Apple M4 Max")).toBe(546);
    expect(systemMemoryBandwidth(5600, 2, "DDR5")).toBeCloseTo(89.6);
    expect(profile.gpuMemory).toBe(16 * GB);
    expect(profile.gpuBandwidth).toBe(896);
  });

  it("classifies fit levels", () => {
    const small = estimateFit(profile, { weightsBytes: 5 * GB, format: "gguf", paramsTotal: 8e9 }, 8192, 10);
    expect(small.level).toBe("full_gpu");
    expect(small.tokensPerSec!).toBeGreaterThan(50);

    const mid = estimateFit(profile, { weightsBytes: 40 * GB, format: "gguf", paramsTotal: 70e9 }, 8192, 10);
    expect(mid.level).toBe("partial");
    expect(mid.gpuFraction).toBeGreaterThan(0);
    expect(mid.gpuFraction).toBeLessThan(1);

    const huge = estimateFit(profile, { weightsBytes: 400 * GB, format: "gguf", paramsTotal: 700e9 }, 8192, 10);
    expect(huge.level).toBe("no_fit");

    const mlx = estimateFit(profile, { weightsBytes: 4 * GB, format: "mlx" }, 8192, 10);
    expect(mlx.level).toBe("unsupported");
  });

  it("MoE models are faster than dense models of the same size", () => {
    const dense = estimateFit(profile, { weightsBytes: 18 * GB, format: "gguf", paramsTotal: 30e9 }, 8192, 10);
    const moe = estimateFit(
      profile,
      { weightsBytes: 18 * GB, format: "gguf", paramsTotal: 30e9, paramsActive: 3e9 },
      8192,
      10,
    );
    expect(moe.tokensPerSec!).toBeGreaterThan(dense.tokensPerSec! * 5);
  });

  it("uses exact KV size when available", () => {
    const f = estimateFit(profile, { weightsBytes: GB, format: "gguf", kvBytesPerToken: 131072 }, 8192, 10);
    expect(f.kvBytes).toBe(GB);
    expect(f.kvEstimated).toBe(false);
  });

  it("picks the highest-quality quant that is fast enough", () => {
    const p: MachineProfile = { ...profile };
    const c = pickBestQuant(
      p,
      [
        { quant: "BF16", weightsBytes: 16 * GB },
        { quant: "Q8_0", weightsBytes: 8.5 * GB },
        { quant: "Q4_K_M", weightsBytes: 5 * GB },
      ],
      { format: "gguf", paramsTotal: 8e9 },
      8192,
      10,
    );
    expect(c?.quant).toBe("Q8_0");
  });

  it("uses unified memory on Apple Silicon", () => {
    const mac = buildProfile(
      { ...hw, os: "macos", unifiedMemory: true, cpuBrand: "Apple M3 Max", ramTotal: 64 * GB, gpus: [] },
      settings,
    );
    expect(mac.appleSilicon).toBe(true);
    expect(mac.gpuMemory).toBe(48 * GB);
    expect(estimateFit(mac, { weightsBytes: 4 * GB, format: "mlx" }, 8192, 10).level).toBe("full_gpu");
  });
});

describe("capabilities", () => {
  it("detects capabilities from metadata", async () => {
    const { detectCapabilities, templateFeatures } = await import("./capabilities");
    const base = {
      id: "a/b",
      tags: [] as string[],
      pipelineTag: "text-generation",
      architecture: null,
      contextLength: null,
      paramsActive: null,
      templateTools: false,
      templateReasoning: false,
    };
    const tpl = templateFeatures("{% if tools %}...{% endif %}<think>");
    expect(tpl).toEqual({ tools: true, reasoning: true });

    expect(
      detectCapabilities({ ...base, name: "Qwen3-VL-8B-Instruct-GGUF", architecture: "qwen3vl", contextLength: 262144 }),
    ).toEqual(expect.arrayContaining(["vision", "longContext"]));
    expect(detectCapabilities({ ...base, name: "Qwen3-Coder-30B-A3B-Instruct-GGUF", paramsActive: 3e9 })).toEqual(
      expect.arrayContaining(["code", "moe"]),
    );
    expect(detectCapabilities({ ...base, name: "llm-jp-3-13b-instruct", tags: ["ja"] })).toContain("japanese");
    expect(detectCapabilities({ ...base, name: "Qwen3-8B-abliterated" })).toContain("uncensored");
    expect(detectCapabilities({ ...base, name: "Qwen-Image-2.1-Text-Encoder-GGUF" })).not.toContain("code");
    expect(detectCapabilities({ ...base, name: "DeepCoder-14B-Preview" })).toContain("code");
    expect(detectCapabilities({ ...base, name: "gemma-3-1b-it", architecture: "gemma3" })).not.toContain("vision");
    expect(detectCapabilities({ ...base, name: "plain-7b", tags: ["en", "fr", "de", "es", "it", "pt"] })).toContain(
      "multilingual",
    );
  });

  it("marks non-LLM models", () => {
    const s = toSummary({ id: "x/Qwen-Image-GGUF", pipeline_tag: "text-to-image", tags: ["gguf"] });
    expect(s.isLlm).toBe(false);
    expect(toSummary({ id: "x/m-GGUF", pipeline_tag: "text-generation", tags: ["gguf"] }).isLlm).toBe(true);
  });
});
