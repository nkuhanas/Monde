import assert from "node:assert/strict";
import test from "node:test";
import type { HealthDto, MondeDto } from "@monde/core";
import { buildSidebarMachines } from "../packages/web/src/layout/sidebarMachines.ts";

const health: HealthDto = {
  ok: true,
  service: "monde",
  db_path: "/tmp/monde.sqlite",
  schema_version: 12
};

const mondes: MondeDto[] = [
  {
    id: "cli-demo",
    name: "CLI Demo",
    root: "/srv/cli-demo",
    docs: "/srv/cli-demo/.monde/docs"
  },
  {
    id: "backup",
    name: "Backup",
    root: "/srv/backup",
    docs: "/srv/backup/.monde/docs"
  }
];

test("sidebar presents all service Mondes under one local machine", () => {
  assert.deepEqual(buildSidebarMachines(mondes, health), [{
    id: "local-machine",
    displayName: "Local Machine",
    online: true,
    mondes
  }]);
});

test("local machine is offline until service health is available", () => {
  assert.equal(buildSidebarMachines([], null)[0]?.online, false);
});
