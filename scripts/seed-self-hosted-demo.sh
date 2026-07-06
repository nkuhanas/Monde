#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node packages/cli/dist/index.js doctor >/dev/null

node --input-type=module - <<'NODE'
import fs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMondePlatformPaths } from "./packages/core/dist/index.js";

const root = process.cwd();
const monde = JSON.parse(readFileSync(join(root, ".monde", "monde.json"), "utf8"));
const paths = getMondePlatformPaths();
const metadata = JSON.parse(readFileSync(paths.metadataPath, "utf8"));
const token = readFileSync(metadata.token_path, "utf8").trim();

async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${metadata.web_addr}${path}`, { ...init, headers });
  const text = await response.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(json)}`);
  return json;
}

const planInputs = [
  {
    title: "Harden Monde run review",
    mon_id: "frontend",
    objective: "Make run review clear enough to evaluate process state, semantic outcome, logs, artifacts, and review notes.",
    prompt: "Review the Run Review UI and CLI close/show surfaces against the beta-hardening slice."
  },
  {
    title: "Improve artifact/diff review",
    mon_id: "frontend",
    objective: "Make write evidence easy to inspect from the operator console without raw git commands.",
    prompt: "Review diff artifact rendering, changed-file artifacts, bounded excerpts, and path status."
  },
  {
    title: "Validate Codex write workflow",
    mon_id: "service",
    objective: "Validate that Codex write runs are explicit, run-scoped, and backed by diff evidence.",
    prompt: "Review the Codex adapter write workflow, MCP bridge, run token authorization, and write evidence capture."
  }
];

const plans = (await request(`/plans?monde_id=${encodeURIComponent(monde.id)}`)).plans;
for (const input of planInputs) {
  let plan = plans.find((candidate) => candidate.title === input.title);
  if (!plan) {
    plan = (await request("/plans", {
      method: "POST",
      body: JSON.stringify({
        monde_id: monde.id,
        title: input.title,
        objective: input.objective,
        description: input.objective,
        assignment: {
          mon_id: input.mon_id,
          title: input.title,
          prompt: input.prompt,
          phase: "beta-review"
        }
      })
    })).plan;
  }

  const activated = await request(`/plans/${plan.id}/activate`, { method: "POST" });
  const refreshed = activated.plan ?? (await request(`/plans/${plan.id}`)).plan;
  const hasRun = refreshed.assignments?.some((assignment) => assignment.generated_run_ids?.length);
  if (!hasRun) throw new Error(`Plan ${plan.id} has no generated run after activation.`);
  console.log(`${plan.id}\t${input.title}`);
}

const docs = ["development.md", "runtime.md", "harnesses.md", "harness-liveness.md", "run-model.md", "mcp.md", "operator-console.md", "review-flow.md", "write-runs.md", "plans.md"];
for (const doc of docs) {
  if (!fs.existsSync(join(root, ".monde", "docs", doc))) throw new Error(`Missing doc ${doc}`);
}
NODE
