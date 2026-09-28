// モデルの特性 (画像入力・ツール呼び出し・推論 など) をHFのメタデータから判定する。
// 情報源: pipeline_tag / タグ / GGUFのアーキテクチャ名とチャットテンプレート / モデル名 / 言語タグ

export const CAPABILITIES = [
  "vision",
  "tools",
  "reasoning",
  "code",
  "japanese",
  "multilingual",
  "longContext",
  "moe",
  "embedding",
  "audio",
  "uncensored",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** LLM以外 (画像生成・音声合成など) のpipeline_tag */
const NON_LLM_PIPELINES = new Set([
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "text-to-speech",
  "text-to-audio",
  "automatic-speech-recognition",
  "audio-classification",
  "image-classification",
  "object-detection",
  "image-segmentation",
  "depth-estimation",
  "unconditional-image-generation",
  "voice-activity-detection",
]);

const VISION_ARCH =
  /(vl|vision|llava|mllama|gemma3|gemma3n|mistral3|llama4|pixtral|minicpmv|internvl|idefics|smolvlm|glm4v|kimi_?vl|ovis|molmo|paligemma)/i;
const VISION_NAME = /(^|[-_.])(vl|vision|llava|pixtral|vlm|omni|minicpm-v|internvl|smolvlm|moondream)([-_.\d]|$)/i;
// "Encoder" などに誤一致しないよう、coder/code は単語の先頭でのみ判定する
const CODE_NAME =
  /((^|[-_.])(coder|code)([-_.\d]|$)|codestral|devstral|starcoder|codegemma|codellama|deepcoder|(^|[-_])swe[-_])/i;
const REASONING_NAME = /(thinking|reason|(^|[-_])r1([-_]|$)|qwq|gpt-oss|magistral|phi-4-.*reasoning|deepseek-r|exaone-deep|nemotron.*nano)/i;
const JA_NAME =
  /(japanese|(^|[-_])ja([-_]|$)|swallow|elyza|(^|[-_])calm\d|sarashina|plamo|llm-jp|ezo|shisa|karakuri|stockmark|youri|rinna|cyberagent|tanuki|abeja|lightblue)/i;
const EMBED_NAME = /(embed|(^|[-_])bge([-_]|$)|e5-|gte-|rerank|colbert)/i;
const UNCENSORED_NAME = /(uncensored|abliterat|heretic|unfiltered)/i;

/** チャットテンプレートから判定できる機能 */
export function templateFeatures(template: string | null | undefined): { tools: boolean; reasoning: boolean } {
  if (!template) return { tools: false, reasoning: false };
  return {
    tools: /\btools\b|tool_call|function_call|<\|tool/i.test(template),
    reasoning: /<think>|enable_thinking|reasoning_content|thinking|<\|channel\|>analysis/i.test(template),
  };
}

export interface CapabilityInput {
  id: string;
  name: string;
  tags: string[];
  pipelineTag: string | null;
  architecture: string | null;
  contextLength: number | null;
  paramsActive: number | null;
  templateTools: boolean;
  templateReasoning: boolean;
}

const LANG_TAG = /^[a-z]{2,3}$/;

export function detectCapabilities(m: CapabilityInput): Capability[] {
  const tags = new Set(m.tags.map((t) => t.toLowerCase()));
  const name = m.name;
  const arch = m.architecture ?? "";
  const pipe = m.pipelineTag ?? "";
  const out = new Set<Capability>();

  if (
    pipe === "image-text-to-text" ||
    pipe === "visual-question-answering" ||
    tags.has("image-text-to-text") ||
    tags.has("vision") ||
    tags.has("multimodal") ||
    // Gemma 3 の 1B / 270M はテキスト専用
    (arch && VISION_ARCH.test(arch) && !/gemma-?3-?(1b|270m)/i.test(name)) ||
    VISION_NAME.test(name)
  ) {
    out.add("vision");
  }
  if (m.templateTools || tags.has("tool-use") || tags.has("function-calling") || tags.has("tool_calling") || tags.has("agent")) {
    out.add("tools");
  }
  if (m.templateReasoning || tags.has("reasoning") || tags.has("thinking") || REASONING_NAME.test(name)) {
    out.add("reasoning");
  }
  if (CODE_NAME.test(name) || tags.has("code") || tags.has("coding")) out.add("code");

  const langs = [...tags].filter((t) => LANG_TAG.test(t) && t !== "en" && !["gguf", "mlx"].includes(t));
  if (tags.has("ja") || JA_NAME.test(name)) out.add("japanese");
  if (langs.length >= 5 || tags.has("multilingual")) out.add("multilingual");

  if ((m.contextLength ?? 0) >= 128 * 1024) out.add("longContext");
  if (m.paramsActive || tags.has("moe") || /moe|mixtral|(^|[-_])a\d+(\.\d+)?b([-_]|$)/i.test(name) || /moe/i.test(arch)) {
    out.add("moe");
  }
  if (pipe === "feature-extraction" || pipe === "sentence-similarity" || EMBED_NAME.test(name)) out.add("embedding");
  if (pipe === "audio-text-to-text" || pipe === "any-to-any" || tags.has("audio") || /omni|voxtral|audio/i.test(name)) {
    out.add("audio");
  }
  if (UNCENSORED_NAME.test(name) || tags.has("uncensored") || tags.has("abliterated")) out.add("uncensored");

  return CAPABILITIES.filter((c) => out.has(c));
}

export function isLlmPipeline(pipelineTag: string | null): boolean {
  return !pipelineTag || !NON_LLM_PIPELINES.has(pipelineTag);
}
