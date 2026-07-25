import type { MonDto } from "@monde/core";
import { monDisplayName } from "../lib/mon";

export function MonIcon({ mon, label, tone = "mint", compact = false }: { mon?: MonDto; label?: string; tone?: "mint" | "cyan"; compact?: boolean }) {
  const title = mon ? monDisplayName(mon) : label ?? "Mon";
  return (
    <span
      className={compact ? `mon-placeholder mon-placeholder-${tone} mon-placeholder-compact` : `mon-placeholder mon-placeholder-${tone}`}
      role="img"
      aria-label={`${title} mon icon`}
    >
      <span className="mon-placeholder-face" />
    </span>
  );
}
