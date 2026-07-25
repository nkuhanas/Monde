export function EvidencePanel({ title, content, collapsible = false }: { title: string; content: string; collapsible?: boolean }) {
  if (collapsible) {
    return (
      <details className="evidence-panel" open>
        <summary>{title}</summary>
        <pre>{content}</pre>
      </details>
    );
  }

  return (
    <section className="evidence-panel">
      <h4>{title}</h4>
      <pre>{content}</pre>
    </section>
  );
}
