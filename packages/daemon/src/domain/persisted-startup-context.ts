import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { ResolvedStartupFile } from "./runtime-adapter.js";
import type { ProjectionEntry, ProjectionPlan } from "./projection-planner.js";
import type { StartupAction } from "./types.js";
import { resolveStartupProof } from "./startup-resolver.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";

/**
 * The startup context a seat's last managed start persisted (node_startup_context), parsed back into the shape
 * StartupOrchestrator.startNode takes. A fresh launch and a continued startup replay it, so the seat starts from its own
 * configured startup files and actions, read from their paths at delivery time; set-cwd and a runtime switch read it too.
 */
export interface ParsedStartupContext {
  plan: ProjectionPlan;
  resolvedStartupFiles: ResolvedStartupFile[];
  startupActions: StartupAction[];
  runtime: string;
  /** Digest of the persisted row: a fresh launch records it as its startup policy, and set-cwd compares it. */
  hash: string;
}

export type PersistedStartupContextRead =
  | { ok: true; context: ParsedStartupContext }
  | { ok: false; code: "startup_context_missing" | "startup_context_malformed"; message: string };

interface PersistedStartupContextRow {
  projection_entries_json: string;
  resolved_files_json: string;
  startup_actions_json: string;
  runtime: string | null;
}

/** Read and validate a node's persisted startup context; `cwd` becomes the plan's cwd. */
export function readPersistedStartupContext(db: Database.Database, nodeId: string, cwd: string): PersistedStartupContextRead {
  const row = db.prepare(
    "SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime FROM node_startup_context WHERE node_id = ?",
  ).get(nodeId) as PersistedStartupContextRow | undefined;
  if (!row) {
    return { ok: false, code: "startup_context_missing", message: `Persisted startup context is missing for node ${nodeId}` };
  }

  let rawEntries: unknown;
  let rawFiles: unknown;
  let rawActions: unknown;
  try {
    rawEntries = JSON.parse(row.projection_entries_json);
    rawFiles = JSON.parse(row.resolved_files_json);
    rawActions = JSON.parse(row.startup_actions_json);
  } catch (error) {
    return malformed(nodeId, `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(rawEntries) || !Array.isArray(rawFiles) || !Array.isArray(rawActions) || !row.runtime?.trim()) {
    return malformed(nodeId, "projection entries, resolved files, and startup actions must be arrays and runtime must be non-empty");
  }

  const entries: ProjectionEntry[] = [];
  for (const raw of rawEntries) {
    if (!isRecord(raw)
      || !isProjectionCategory(raw["category"])
      || !hasStrings(raw, ["effectiveId", "sourceSpec", "sourcePath", "resourcePath", "absolutePath"])
      || !isOptionalString(raw["resourceType"])
      || !isOptionalString(raw["target"])
      || !isOptionalOneOf(raw["mergeStrategy"], ["managed_block", "append"] as const)
      || !isOptionalOneOf(raw["pluginType"], ["claude", "codex", "auto"] as const)) {
      return malformed(nodeId, "projection_entries_json contains an invalid entry");
    }
    // S04 owns the live ambient skill set. Replaying the older catalog
    // selection here could reinstall a skill that work-install removed.
    if (raw["category"] === "skill") continue;
    // #261: shipped-spec resources follow the running install.
    entries.push(reanchorShippedProjectionEntry({
      category: raw["category"],
      effectiveId: raw["effectiveId"],
      sourceSpec: raw["sourceSpec"],
      sourcePath: raw["sourcePath"],
      resourcePath: raw["resourcePath"],
      absolutePath: raw["absolutePath"],
      classification: "safe_projection",
      ...(typeof raw["resourceType"] === "string" ? { resourceType: raw["resourceType"] } : {}),
      ...(typeof raw["mergeStrategy"] === "string" ? { mergeStrategy: raw["mergeStrategy"] as ProjectionEntry["mergeStrategy"] } : {}),
      ...(typeof raw["target"] === "string" ? { target: raw["target"] } : {}),
      ...(typeof raw["pluginType"] === "string" ? { pluginType: raw["pluginType"] as ProjectionEntry["pluginType"] } : {}),
    }));
  }

  const resolvedStartupFiles: ResolvedStartupFile[] = [];
  for (const raw of rawFiles) {
    if (!isRecord(raw)
      || !hasStrings(raw, ["path", "absolutePath", "ownerRoot"])
      || !isOneOf(raw["deliveryHint"], ["auto", "guidance_merge", "skill_install", "send_text"] as const)
      || typeof raw["required"] !== "boolean"
      || !isStringArrayOf(raw["appliesOn"], ["fresh_start", "restore"] as const)
      || !isOptionalOneOf(raw["kind"], ["file"] as const)) {
      return malformed(nodeId, "resolved_files_json contains an invalid entry");
    }
    // #261: recognized built-in startup files follow the running install.
    resolvedStartupFiles.push(reanchorBuiltinStartupFile({
      path: raw["path"],
      absolutePath: raw["absolutePath"],
      ownerRoot: raw["ownerRoot"],
      deliveryHint: raw["deliveryHint"],
      required: raw["required"],
      appliesOn: raw["appliesOn"],
      ...(raw["kind"] === "file" ? { kind: "file" as const } : {}),
    }));
  }

  const startupActions: StartupAction[] = [];
  for (const raw of rawActions) {
    if (!isRecord(raw)
      || !isOneOf(raw["type"], ["slash_command", "send_text", "startup_proof"] as const)
      || typeof raw["value"] !== "string"
      || !isOneOf(raw["phase"], ["after_files", "after_ready"] as const)
      || !isStringArrayOf(raw["appliesOn"], ["fresh_start", "restore"] as const)
      || typeof raw["idempotent"] !== "boolean"
      || !isOptionalOneOf(raw["builtin"], ["session_identity"] as const)) {
      return malformed(nodeId, "startup_actions_json contains an invalid entry");
    }
    startupActions.push({
      type: raw["type"],
      value: raw["value"],
      phase: raw["phase"],
      appliesOn: raw["appliesOn"],
      idempotent: raw["idempotent"],
      ...(raw["builtin"] === "session_identity" ? { builtin: "session_identity" as const } : {}),
    });
  }

  try {
    resolveStartupProof(startupActions, "fresh_start");
  } catch (err) {
    return malformed(nodeId, (err as Error).message);
  }

  const startupFiles = resolvedStartupFiles.map((file) => ({
    kind: file.kind,
    path: file.path,
    deliveryHint: file.deliveryHint,
    required: file.required,
    appliesOn: file.appliesOn,
  }));
  const plan: ProjectionPlan = {
    runtime: row.runtime,
    cwd,
    entries,
    startup: { files: startupFiles, actions: startupActions },
    conflicts: [],
    noOps: [],
    diagnostics: [],
  };
  const hash = createHash("sha256")
    .update(JSON.stringify([row.projection_entries_json, row.resolved_files_json, row.startup_actions_json, row.runtime]))
    .digest("hex");
  return { ok: true, context: { plan, resolvedStartupFiles, startupActions, runtime: row.runtime, hash } };
}

function malformed(nodeId: string, detail: string): PersistedStartupContextRead {
  return {
    ok: false,
    code: "startup_context_malformed",
    message: `Persisted startup context is malformed for node ${nodeId}: ${detail}.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings<T extends string>(value: Record<string, unknown>, keys: readonly T[]): value is Record<T, string> & Record<string, unknown> {
  return keys.every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

function isProjectionCategory(value: unknown): value is ProjectionEntry["category"] {
  return isOneOf(value, ["skill", "guidance", "subagent", "plugin", "runtime_resource"] as const);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isOptionalOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T | undefined {
  return value === undefined || isOneOf(value, allowed);
}

function isStringArrayOf<T extends string>(value: unknown, allowed: readonly T[]): value is T[] {
  return Array.isArray(value) && value.every((entry) => isOneOf(entry, allowed));
}
