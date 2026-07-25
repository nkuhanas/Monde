import type { ReactNode } from "react";

export type BadgeTone = "default" | "blue" | "green" | "amber" | "red";

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
