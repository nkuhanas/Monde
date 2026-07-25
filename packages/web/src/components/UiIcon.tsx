export type IconName = "runs" | "plans" | "artifacts" | "status" | "review" | "mons" | "machine" | "monde";

export function UiIcon({ name }: { name: IconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2.35 } as const;
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      {name === "runs" ? <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M10 8l6 4-6 4V8z" /></> : null}
      {name === "plans" ? <><path {...common} d="M8 4h8" /><path {...common} d="M7 6h10a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V8a2 2 0 012-2z" /><path {...common} d="M8 11h8M8 15h5" /></> : null}
      {name === "artifacts" ? <><path {...common} d="M4 8l8-4 8 4-8 4-8-4z" /><path {...common} d="M4 8v8l8 4 8-4V8" /><path {...common} d="M12 12v8" /></> : null}
      {name === "status" ? <><path {...common} d="M4 13h4l2-6 4 10 2-4h4" /><path {...common} d="M4 19h16" /></> : null}
      {name === "review" ? <><path {...common} d="M5 12l4 4L19 6" /><path {...common} d="M5 20h14" /></> : null}
      {name === "mons" ? <><path {...common} d="M12 20c0-6 3-11 8-14" /><path {...common} d="M12 20c0-6-3-11-8-14" /><path {...common} d="M12 20V9" /><path {...common} d="M8 8c2 0 4 1 4 3-3 0-5-1-4-3z" /><path {...common} d="M16 8c-2 0-4 1-4 3 3 0 5-1 4-3z" /></> : null}
      {name === "machine" ? <><rect {...common} x="4" y="5" width="16" height="11" rx="2" /><path {...common} d="M8 20h8M12 16v4" /></> : null}
      {name === "monde" ? <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></> : null}
    </svg>
  );
}
