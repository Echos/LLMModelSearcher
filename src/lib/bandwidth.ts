// GPU / SoC のメモリ帯域 (GB/s) の参考値。LLMのトークン生成速度はほぼメモリ帯域で決まる。
// 上から順に照合するため、より具体的な名前を先に置く。

const TABLE: [RegExp, number][] = [
  // NVIDIA RTX 50
  [/RTX\s*PRO\s*6000/i, 1792],
  [/RTX\s*5090/i, 1792],
  [/RTX\s*5080/i, 960],
  [/RTX\s*5070\s*Ti/i, 896],
  [/RTX\s*5070/i, 672],
  [/RTX\s*5060\s*Ti/i, 448],
  [/RTX\s*5060/i, 448],
  // NVIDIA RTX 40
  [/RTX\s*4090/i, 1008],
  [/RTX\s*4080\s*Super/i, 736],
  [/RTX\s*4080/i, 717],
  [/RTX\s*4070\s*Ti\s*Super/i, 672],
  [/RTX\s*4070/i, 504],
  [/RTX\s*4060\s*Ti/i, 288],
  [/RTX\s*4060/i, 272],
  // NVIDIA RTX 30 / 20
  [/RTX\s*3090/i, 936],
  [/RTX\s*3080\s*Ti/i, 912],
  [/RTX\s*3080/i, 760],
  [/RTX\s*3070\s*Ti/i, 608],
  [/RTX\s*3070/i, 448],
  [/RTX\s*3060\s*Ti/i, 448],
  [/RTX\s*3060/i, 360],
  [/RTX\s*3050/i, 224],
  [/RTX\s*2080\s*Ti/i, 616],
  [/RTX\s*20[678]0/i, 448],
  [/GTX\s*1080\s*Ti/i, 484],
  [/GTX\s*1660/i, 192],
  // NVIDIA データセンター / ワークステーション
  [/H200/i, 4800],
  [/H100/i, 3350],
  [/A100/i, 1935],
  [/L40/i, 864],
  [/RTX\s*6000\s*Ada/i, 960],
  [/RTX\s*A6000/i, 768],
  [/RTX\s*A5000/i, 768],
  [/RTX\s*A4000/i, 448],
  [/DGX\s*Spark|GB10/i, 273],
  // AMD
  [/Radeon\s*AI\s*PRO\s*R9700/i, 640],
  [/RX\s*9070/i, 640],
  [/RX\s*9060\s*XT/i, 320],
  [/RX\s*7900\s*XTX/i, 960],
  [/RX\s*7900\s*XT/i, 800],
  [/RX\s*7900\s*GRE/i, 576],
  [/RX\s*7800\s*XT/i, 624],
  [/RX\s*7700/i, 432],
  [/RX\s*7600/i, 288],
  [/RX\s*69[05]0/i, 512],
  [/RX\s*6800/i, 512],
  [/RX\s*6700/i, 384],
  [/Radeon\s*8060S|Ryzen\s*AI\s*Max/i, 256],
  [/MI300/i, 5300],
  // Intel
  [/Arc.*B580/i, 456],
  [/Arc.*B570/i, 380],
  [/Arc.*A770/i, 560],
  [/Arc.*A750/i, 512],
  [/Arc.*A580/i, 512],
  // Apple Silicon
  [/Apple\s*M4\s*Max/i, 546],
  [/Apple\s*M4\s*Pro/i, 273],
  [/Apple\s*M3\s*Ultra/i, 819],
  [/Apple\s*M3\s*Max/i, 400],
  [/Apple\s*M3\s*Pro/i, 150],
  [/Apple\s*M2\s*Ultra/i, 800],
  [/Apple\s*M2\s*Max/i, 400],
  [/Apple\s*M2\s*Pro/i, 200],
  [/Apple\s*M1\s*Ultra/i, 800],
  [/Apple\s*M1\s*Max/i, 400],
  [/Apple\s*M1\s*Pro/i, 200],
  [/Apple\s*M5\b/i, 153],
  [/Apple\s*M4\b/i, 120],
  [/Apple\s*M3\b/i, 100],
  [/Apple\s*M2\b/i, 100],
  [/Apple\s*M1\b/i, 68],
];

export function lookupBandwidth(name: string): number | null {
  const isLaptop = /laptop|mobile|max-q/i.test(name);
  for (const [re, bw] of TABLE) {
    if (re.test(name)) return isLaptop ? Math.round(bw * 0.7) : bw;
  }
  return null;
}

/** システムメモリの理論帯域 (GB/s)。チャネル数はモジュール数から推定 (最大2) */
export function systemMemoryBandwidth(
  speedMts: number | null,
  modules: number | null,
  type: string | null,
): number {
  if (speedMts && speedMts > 0) {
    const channels = Math.min(Math.max(modules ?? 2, 1), 2);
    return (speedMts * 8 * channels) / 1000;
  }
  return type?.includes("DDR5") ? 70 : 45;
}
