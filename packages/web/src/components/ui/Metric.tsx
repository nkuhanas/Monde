export function Metric({ label, value, tone }: { label: string; value: number | string; tone: "green" | "amber" | "purple" | "red" | "blue" }) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
