import {
  AudioLines,
  Binary,
  Brain,
  Code2,
  Eye,
  Globe,
  Layers,
  Ruler,
  ShieldOff,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useApp } from "../AppContext";
import type { Capability } from "../lib/capabilities";

export const CAPABILITY_ICON: Record<Exclude<Capability, "japanese">, LucideIcon> = {
  vision: Eye,
  tools: Wrench,
  reasoning: Brain,
  code: Code2,
  multilingual: Globe,
  longContext: Ruler,
  moe: Layers,
  embedding: Binary,
  audio: AudioLines,
  uncensored: ShieldOff,
};

export function CapabilityIcon({ cap, size = 14 }: { cap: Capability; size?: number }) {
  if (cap === "japanese") {
    return (
      <span className="cap-text" style={{ fontSize: size * 0.72 }}>
        JA
      </span>
    );
  }
  const Icon = CAPABILITY_ICON[cap];
  return <Icon size={size} />;
}

export function CapabilityIcons({ caps, size = 14 }: { caps: Capability[]; size?: number }) {
  const { t } = useApp();
  if (!caps || caps.length === 0) return null;
  return (
    <span className="caps">
      {caps.map((c) => (
        <span key={c} className={`cap cap-${c}`} title={t(`cap.${c}`)}>
          <CapabilityIcon cap={c} size={size} />
        </span>
      ))}
    </span>
  );
}

/** 詳細画面用: アイコンと名前を並べて表示する */
export function CapabilityList({ caps }: { caps: Capability[] }) {
  const { t } = useApp();
  if (caps.length === 0) return <span className="muted">-</span>;
  return (
    <span className="caps wide">
      {caps.map((c) => (
        <span key={c} className={`cap cap-${c} labeled`} title={t(`capDesc.${c}`)}>
          <CapabilityIcon cap={c} />
          {t(`cap.${c}`)}
        </span>
      ))}
    </span>
  );
}
