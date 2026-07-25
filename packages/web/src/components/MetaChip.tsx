export type ChipTone = "green" | "blue" | "amber" | "red" | "neutral";
export type ChipMeta = { label: string; tone: ChipTone };

export function MetaChip({ meta }: { meta: ChipMeta }) {
  return <span className="thread-chip" data-tone={meta.tone}>{meta.label}</span>;
}
