import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { readPersistedStartupContext } from "../src/domain/persisted-startup-context.js";

const roleFile = {
  path: "guidance/role.md", absolutePath: "/spec/agents/impl/guidance/role.md", ownerRoot: "/spec/agents/impl",
  deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"], kind: "file",
};
const cultureFile = {
  path: "CULTURE.md", absolutePath: "/spec/CULTURE.md", ownerRoot: "/spec",
  deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"],
};
const identityAction = {
  type: "send_text", value: "dev-impl@ctx-rig\nOpenRig session identity:", phase: "after_ready",
  appliesOn: ["fresh_start", "restore"], idempotent: true, builtin: "session_identity",
};

function projectionEntry(category: "skill" | "guidance", id: string) {
  return { category, effectiveId: id, sourceSpec: "agent.yaml", sourcePath: `resources/${id}`, resourcePath: id, absolutePath: `/spec/${id}` };
}

describe("readPersistedStartupContext", () => {
  let db: Database.Database;
  let nodeId: string;

  beforeEach(() => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    nodeId = rigRepo.addNode(rigRepo.createRig("ctx-rig").id, "dev.impl", { runtime: "claude-code", cwd: "/project" }).id;
  });

  afterEach(() => db.close());

  function persist(row: { entries?: string; files?: string; actions?: string; runtime?: string }) {
    db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)",
    ).run(nodeId, row.entries ?? "[]", row.files ?? "[]", row.actions ?? "[]", row.runtime ?? "claude-code");
  }

  it("names a node that never persisted a startup context", () => {
    expect(readPersistedStartupContext(db, nodeId, "/project")).toEqual({
      ok: false, code: "startup_context_missing", message: `Persisted startup context is missing for node ${nodeId}`,
    });
  });

  it("parses the persisted files and actions into a plan for the given cwd, leaving skills to the live skill set", () => {
    const entries = JSON.stringify([projectionEntry("skill", "stale-skill"), projectionEntry("guidance", "live-guidance")]);
    const files = JSON.stringify([roleFile, cultureFile]);
    const actions = JSON.stringify([identityAction]);
    persist({ entries, files, actions });

    const read = readPersistedStartupContext(db, nodeId, "/seat/cwd");

    if (!read.ok) throw new Error(read.message);
    expect(read.context.runtime).toBe("claude-code");
    expect(read.context.plan.cwd).toBe("/seat/cwd");
    expect(read.context.plan.entries.map((entry) => entry.effectiveId)).toEqual(["live-guidance"]);
    expect(read.context.resolvedStartupFiles).toEqual([roleFile, cultureFile]);
    expect(read.context.plan.startup.files.map((file) => file.path)).toEqual(["guidance/role.md", "CULTURE.md"]);
    expect(read.context.startupActions).toEqual([identityAction]);
    expect(read.context.hash).toBe(createHash("sha256").update(JSON.stringify([entries, files, actions, "claude-code"])).digest("hex"));
  });

  it.each([
    ["unparseable JSON", { files: "{" }, "JSON parse failed"],
    ["a blank runtime", { runtime: " " }, "runtime must be non-empty"],
    ["a startup file with a blank absolute path", { files: JSON.stringify([{ ...roleFile, absolutePath: "" }]) }, "resolved_files_json contains an invalid entry"],
    ["an unknown action phase", { actions: JSON.stringify([{ ...identityAction, phase: "whenever" }]) }, "startup_actions_json contains an invalid entry"],
  ])("refuses %s as malformed", (_label, row, detail) => {
    persist(row);

    const read = readPersistedStartupContext(db, nodeId, "/project");

    expect(read).toMatchObject({ ok: false, code: "startup_context_malformed" });
    if (read.ok) return;
    expect(read.message).toContain(`Persisted startup context is malformed for node ${nodeId}`);
    expect(read.message).toContain(detail);
  });
});
