// 量子化形式の判定と、ファイルのグループ化 (分割GGUF・mmproj)

export interface QuantSpec {
  /** 1パラメータあたりの平均ビット数 (概算) */
  bpw: number;
  /** 品質係数 (F16=1.0を基準とした相対値の目安) */
  quality: number;
}

const QUANTS: Record<string, QuantSpec> = {
  F32: { bpw: 32, quality: 1.0 },
  F16: { bpw: 16, quality: 1.0 },
  BF16: { bpw: 16, quality: 1.0 },
  Q8_K_XL: { bpw: 9.5, quality: 0.997 },
  Q8_0: { bpw: 8.5, quality: 0.995 },
  Q6_K_XL: { bpw: 7.2, quality: 0.992 },
  Q6_K: { bpw: 6.56, quality: 0.99 },
  Q5_K_XL: { bpw: 6.0, quality: 0.982 },
  Q5_K_M: { bpw: 5.69, quality: 0.98 },
  Q5_K_S: { bpw: 5.54, quality: 0.975 },
  Q5_1: { bpw: 6.0, quality: 0.975 },
  Q5_0: { bpw: 5.5, quality: 0.97 },
  Q4_K_XL: { bpw: 5.0, quality: 0.965 },
  Q4_K_M: { bpw: 4.85, quality: 0.96 },
  Q4_K_S: { bpw: 4.58, quality: 0.95 },
  Q4_1: { bpw: 5.0, quality: 0.94 },
  Q4_0: { bpw: 4.55, quality: 0.93 },
  IQ4_NL: { bpw: 4.5, quality: 0.95 },
  IQ4_XS: { bpw: 4.25, quality: 0.95 },
  MXFP4: { bpw: 4.25, quality: 0.95 },
  MXFP4_MOE: { bpw: 4.25, quality: 0.95 },
  Q3_K_XL: { bpw: 4.0, quality: 0.915 },
  Q3_K_L: { bpw: 4.27, quality: 0.91 },
  Q3_K_M: { bpw: 3.91, quality: 0.9 },
  Q3_K_S: { bpw: 3.5, quality: 0.86 },
  IQ3_M: { bpw: 3.66, quality: 0.9 },
  IQ3_S: { bpw: 3.44, quality: 0.88 },
  IQ3_XS: { bpw: 3.3, quality: 0.87 },
  IQ3_XXS: { bpw: 3.06, quality: 0.85 },
  Q2_K_XL: { bpw: 3.3, quality: 0.83 },
  Q2_K_L: { bpw: 3.2, quality: 0.81 },
  Q2_K: { bpw: 3.0, quality: 0.8 },
  IQ2_M: { bpw: 2.7, quality: 0.78 },
  IQ2_S: { bpw: 2.5, quality: 0.75 },
  IQ2_XS: { bpw: 2.31, quality: 0.72 },
  IQ2_XXS: { bpw: 2.06, quality: 0.68 },
  IQ1_M: { bpw: 1.75, quality: 0.55 },
  IQ1_S: { bpw: 1.56, quality: 0.5 },
  TQ1_0: { bpw: 1.69, quality: 0.5 },
  // MLX
  "8BIT": { bpw: 8.5, quality: 0.995 },
  "6BIT": { bpw: 6.5, quality: 0.985 },
  "5BIT": { bpw: 5.5, quality: 0.975 },
  "4BIT": { bpw: 4.5, quality: 0.95 },
  "3BIT": { bpw: 3.5, quality: 0.88 },
  "2BIT": { bpw: 2.5, quality: 0.75 },
};

/** 一覧表示で使う、パラメータ数からの推定で候補にする量子化 (品質の高い順) */
export const CANDIDATE_QUANTS = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "IQ4_XS", "Q3_K_M", "IQ3_XXS", "Q2_K"];

const GGUF_QUANT_RE =
  /(?:^|[-_.\s/])(?:UD-)?(IQ[1-4]_(?:XXS|XS|S|M|NL)|Q[2-8]_K(?:_(?:XL|S|M|L))?|Q[4-8]_[01]|TQ[12]_0|MXFP4(?:_MOE)?|BF16|F16|F32)(?=[-_.\s/]|$)/gi;
const MLX_QUANT_RE = /(?:^|[-_.])(\d)-?bit(?=[-_.]|$)/i;

/** ファイル名またはリポジトリ名から量子化名を取り出す (最後に現れたものを採用) */
export function parseQuant(name: string): string | null {
  let last: string | null = null;
  for (const m of name.matchAll(GGUF_QUANT_RE)) last = m[1].toUpperCase();
  if (last) return last;
  const mlx = name.match(MLX_QUANT_RE);
  if (mlx) return `${mlx[1]}BIT`;
  if (/(?:^|[-_.])(bf16|fp16)(?=[-_.]|$)/i.test(name)) return "BF16";
  return null;
}

export function quantSpec(q: string | null | undefined): QuantSpec | null {
  if (!q) return null;
  return QUANTS[q.toUpperCase()] ?? null;
}

export function isUnslothDynamic(name: string): boolean {
  return /(?:^|[-_/])UD-/i.test(name);
}

export interface RepoFile {
  path: string;
  size: number;
  sha256: string | null;
}

export interface FileGroup {
  /** グループの識別子 (分割番号を除いたパス) */
  key: string;
  quant: string | null;
  label: string;
  files: RepoFile[];
  totalSize: number;
  isMmproj: boolean;
}

const SHARD_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

/** GGUFファイルを量子化ごとにまとめる (分割ファイルは1グループ) */
export function groupGgufFiles(files: RepoFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of files) {
    if (!f.path.toLowerCase().endsWith(".gguf")) continue;
    const key = f.path.replace(SHARD_RE, ".gguf");
    const base = f.path.split("/").pop() ?? f.path;
    const isMmproj = /mmproj/i.test(base);
    let g = groups.get(key);
    if (!g) {
      const quant = parseQuant(f.path);
      g = {
        key,
        quant,
        label: (isMmproj ? "mmproj " : "") + (quant ?? base.replace(/\.gguf$/i, "")),
        files: [],
        totalSize: 0,
        isMmproj,
      };
      if (isUnslothDynamic(f.path) && quant) g.label = `UD-${quant}`;
      groups.set(key, g);
    }
    g.files.push(f);
    g.totalSize += f.size;
  }
  const list = [...groups.values()];
  for (const g of list) g.files.sort((a, b) => a.path.localeCompare(b.path));
  return list.sort((a, b) => b.totalSize - a.totalSize);
}

const SKIP_FOR_SAFETENSORS = [/^original\//i, /\.(bin|pth|pt|onnx|gguf|msgpack|h5|ot)$/i, /^\.gitattributes$/];

/** safetensors / MLX リポジトリで取得するファイル一式 */
export function safetensorsBundle(files: RepoFile[]): FileGroup | null {
  const weights = files.filter((f) => f.path.toLowerCase().endsWith(".safetensors"));
  if (weights.length === 0) return null;
  const hasWeightsInRoot = weights.some((f) => !f.path.includes("/"));
  const picked = files.filter((f) => {
    if (SKIP_FOR_SAFETENSORS.some((re) => re.test(f.path))) return false;
    // ルートに重みがある場合、サブフォルダ内の別形式の重みは除く
    if (hasWeightsInRoot && f.path.includes("/") && f.path.endsWith(".safetensors")) return false;
    return true;
  });
  return {
    key: "__bundle__",
    quant: null,
    label: "safetensors",
    files: picked,
    totalSize: picked.reduce((s, f) => s + f.size, 0),
    isMmproj: false,
  };
}
