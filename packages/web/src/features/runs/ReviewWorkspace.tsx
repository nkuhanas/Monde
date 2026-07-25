import type { RunDto } from "@monde/core";
import { EmptyState } from "../../components/ui";
import { RunDetail, type RunDetailProps } from "./RunDetail";

export function ReviewWorkspace({ run, detailProps }: { run?: RunDto; detailProps: Omit<RunDetailProps, "run" | "compact"> }) {
  return (
    <section className="review-workspace">
      {run ? <RunDetail run={run} {...detailProps} /> : <EmptyState title="No run selected" body="Choose a run from the Runs tab to review execution evidence." />}
    </section>
  );
}
