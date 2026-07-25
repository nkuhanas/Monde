import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRunScope } from "../packages/service/src/scope.ts";
import type { MonRow } from "../packages/service/src/repositories/mons.ts";
import type { MondeRow } from "../packages/service/src/repositories/mondes.ts";

interface ScopeFixture {
  tempRoot: string;
  mondeRoot: string;
  monRoot: string;
  configPath: string;
  monde: MondeRow;
  mon: MonRow;
}

function createFixture(t: test.TestContext): ScopeFixture {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-scope-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const mondeRoot = path.join(tempRoot, "world");
  const docsRoot = path.join(mondeRoot, ".monde", "docs");
  const monRoot = path.join(mondeRoot, "apps", "web", "frontend.mon");
  fs.mkdirSync(docsRoot, { recursive: true });
  fs.mkdirSync(monRoot, { recursive: true });
  fs.writeFileSync(
    path.join(mondeRoot, ".monde", "monde.json"),
    JSON.stringify({
      id: "scope-test",
      name: "Scope Test",
      version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      root: mondeRoot,
      docs: docsRoot
    })
  );

  const configPath = path.join(monRoot, "mon.json");
  const monde: MondeRow = {
    id: "scope-test",
    name: "Scope Test",
    root: mondeRoot,
    docs: docsRoot,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  };
  const mon: MonRow = {
    id: "frontend",
    monde_id: monde.id,
    name: "Frontend",
    role: "frontend",
    mon_root: monRoot,
    work_root: path.dirname(monRoot),
    default_harness: "basic-process",
    default_model: null,
    capabilities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  };

  return { tempRoot, mondeRoot, monRoot, configPath, monde, mon };
}

function writeMonConfig(fixture: ScopeFixture, workRoot: string): void {
  fs.writeFileSync(
    fixture.configPath,
    JSON.stringify({
      id: "frontend",
      name: "Frontend",
      role: "frontend",
      version: 1,
      default_harness: "basic-process",
      default_model: null,
      work_root: workRoot,
      capabilities: [],
      created_at: "2026-01-01T00:00:00.000Z",
      created_under_monde_id: fixture.monde.id
    })
  );
}

test("rejects a relative work-root traversal outside the Monde", (t) => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.tempRoot, "outside");
  fs.mkdirSync(outside);
  writeMonConfig(fixture, path.relative(fixture.monRoot, outside));

  assert.throws(() => resolveRunScope(fixture.monde, fixture.mon), /outside Monde/);
});

test("rejects an absolute work root outside the Monde", (t) => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.tempRoot, "outside");
  fs.mkdirSync(outside);
  writeMonConfig(fixture, outside);

  assert.throws(() => resolveRunScope(fixture.monde, fixture.mon), /outside Monde/);
});

test("rejects an existing symlink that escapes the Monde", (t) => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.tempRoot, "outside");
  const link = path.join(fixture.mondeRoot, "apps", "web", "outside-link");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, link, "dir");
  writeMonConfig(fixture, path.relative(fixture.monRoot, link));

  assert.throws(() => resolveRunScope(fixture.monde, fixture.mon), /outside Monde/);
});

test("rechecks canonical scope and rejects a symlink created after an earlier resolution", (t) => {
  const fixture = createFixture(t);
  const workRoot = path.join(fixture.mondeRoot, "apps", "web", "work");
  const outside = path.join(fixture.tempRoot, "outside");
  fs.mkdirSync(workRoot);
  fs.mkdirSync(outside);
  writeMonConfig(fixture, path.relative(fixture.monRoot, workRoot));

  assert.equal(resolveRunScope(fixture.monde, fixture.mon).work_root, fs.realpathSync(workRoot));

  fs.rmSync(workRoot, { recursive: true });
  fs.symlinkSync(outside, workRoot, "dir");
  assert.throws(() => resolveRunScope(fixture.monde, fixture.mon), /outside Monde/);
});
