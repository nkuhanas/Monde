import type { ReactNode } from "react";

export type BadgeTone = "default" | "blue" | "cyan" | "green" | "purple" | "pink" | "amber" | "red";

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
