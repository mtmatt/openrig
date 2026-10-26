import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService, type SeatHandoverResult } from "../src/domain/seat-handover-service.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ResolvedStartupFile, RuntimeAdapter } from "../src/domain/runtime-adapter.js";

// A rebuild handover's successor is a fresh conversation, so it gets the seat's configured startup context as a
// fresh launch does: its guidance is written before it starts, its identity and role prompt follow once it is
// committed, and only then the rebuild priming packet. These run the real handover service and startup
// orchestrator over a real DB, with fakes only at tmux and the runtime adapter, which record into one ordered log.

const ROLE_PATH = "/spec/agents/impl/guidance/role.md";
const STARTUP_FILES = [
  { path: "guidance/role.md", absolutePath: ROLE_PATH, ownerRoot: "/spec/agents/impl", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"], kind: "file" },
  { path: "CULTURE.md", absolutePath: "/spec/CULTURE.md", ownerRoot: "/spec", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] },
];
const IDENTITY_ACTION = {
  type: "send_text", value: "dev-impl@seat-rig\nOpenRig session identity:", phase: "after_ready",
  appliesOn: ["fresh_start", "restore"], idempotent: true, builtin: "session_identity",
};
const PRIMING_HEADER = "# Seat rebuild handover — dev-impl@seat-rig";

describe("rebuild handover: the seat's startup context, then the priming", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let log: string[];
  let sendText: ReturnType<typeof vi.fn>;
  let respawnPane: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let deliverStartup: ReturnType<typeof vi.fn>;
  let startupOrchestrator: StartupOrchestrator;
  let service: SeatHandoverService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const discoveryRepo = new DiscoveryRepository(db);
    const eventBus = new EventBus(db);
    log = [];
    sendText = vi.fn(async (_session: string, text: string) => { log.push(`send:${text.split("\n")[0]}`); return { ok: true }; });
    respawnPane = vi.fn(async () => { log.push("respawn"); return { ok: true }; });
    launchHarness = vi.fn(async () => { log.push("launch"); return { ok: true, resumeToken: "successor-tok", resumeType: "codex_id" }; });
    checkReady = vi.fn(async () => ({ ready: true }));
    deliverStartup = vi.fn(async (files: ResolvedStartupFile[]) => {
      log.push(`files:${files.map((file) => file.path).join(",")}`);
      return { delivered: files.length, failed: [] };
    });
    const tmux = {
      hasSession: async () => true,
      listPanes: async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }],
      respawnPane,
      setRemainOnExit: async () => ({ ok: true }),
      signalPaneProcess: async () => ({ ok: true }),
      isPaneDead: async () => true,
      sendText,
      sendKeys: async () => ({ ok: true }),
      capturePaneScreen: async () => "predecessor screen",
      getDefaultShell: async () => "/bin/zsh",
      getPaneCommand: async () => "zsh",
    } as unknown as TmuxAdapter;
    const adapter = {
      runtime: "codex",
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup,
      launchHarness,
      checkReady,
    } as unknown as RuntimeAdapter;
    startupOrchestrator = new StartupOrchestrator({
      db, sessionRegistry, eventBus, tmuxAdapter: tmux,
      readFile: (path) => (path === ROLE_PATH ? "You implement the plan." : ""),
      sleep: async () => {},
    });
    service = new SeatHandoverService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: tmux,
      runtimeAdapters: { codex: adapter },
      startupOrchestrator,
      rebuildPrimingResolver: () => ({ artifacts: [{ address: "/seats/dev-impl/RECAP.md", label: "authored recap" }] }),
      rebuildArtifactExists: () => true,
      readinessTimeoutMs: 50,
      sleep: async () => {},
    });
  });

  afterEach(() => db.close());

  function seedSeat(opts: { startupContext: boolean } = { startupContext: true }) {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-10-23T12:00:00Z");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%0" });
    if (opts.startupContext) {
      db.prepare(`INSERT INTO node_startup_context
        (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime)
        VALUES (?, '[]', ?, ?, 'codex')`).run(node.id, JSON.stringify(STARTUP_FILES), JSON.stringify([IDENTITY_ACTION]));
    }
    return { node, sessionId: session.id };
  }

  function liveSession(nodeId: string) {
    return db.prepare("SELECT id, origin, startup_status FROM sessions WHERE node_id = ? AND status NOT IN ('superseded', 'detached', 'exited') ORDER BY id DESC")
      .get(nodeId) as { id: string; origin: string; startup_status: string } | undefined;
  }

  function lifecycleEvents(): string[] {
    return (db.prepare("SELECT type FROM events WHERE type IN ('seat.handover_completed', 'node.startup_pending', 'node.startup_ready', 'node.startup_failed') ORDER BY seq")
      .all() as Array<{ type: string }>).map((row) => row.type);
  }

  function mutation(result: SeatHandoverResult) {
    if (!result.ok || !("result" in result)) throw new Error(`expected a committed handover, got ${JSON.stringify(result)}`);
    return result.result;
  }

  it("writes the guidance before the successor starts, then sends its identity and role, then the priming", async () => {
    const { node } = seedSeat();

    const result = mutation(await service.handover({ seatRef: "dev-impl@seat-rig", reason: "new guidance", source: "rebuild" }));

    expect(log).toEqual([
      "files:CULTURE.md", // the guidance is current before the successor exists
      "respawn",
      "launch",
      "files:CULTURE.md", // the committed successor's startup repeats the idempotent write
      "send:dev-impl@seat-rig", // the identity prompt, with the role bundled behind it
      `send:${PRIMING_HEADER}`,
    ]);
    const firstPrompt = String(sendText.mock.calls[0]?.[1]);
    expect(firstPrompt).toContain("OpenRig session identity:");
    expect(firstPrompt).toContain("You implement the plan.");
    expect(firstPrompt).toContain("This is a fresh conversation.");
    expect(String(sendText.mock.calls[1]?.[1])).toContain("/seats/dev-impl/RECAP.md");
    expect(result).toMatchObject({
      startup: { status: "ready" },
      sideEffects: { startupContextDelivered: true },
      currentStatus: { startupStatus: "ready", continuityOutcome: "rebuilt" },
    });
    expect(result.primingNotDelivered).toBeUndefined();
    expect(lifecycleEvents()).toEqual(["seat.handover_completed", "node.startup_pending", "node.startup_ready"]);
    expect(liveSession(node.id)).toMatchObject({ origin: "launched", startup_status: "ready" });
  });

  it.each([
    ["a required startup file can't be written", () => {
      deliverStartup.mockImplementation(async (files: ResolvedStartupFile[]) => ({ delivered: 0, failed: files.map((file) => ({ path: file.path, error: "ENOENT" })) }));
    }, "Pre-launch file delivery failed: CULTURE.md: ENOENT"],
    ["the persisted startup context is malformed", () => {
      db.prepare("UPDATE node_startup_context SET resolved_files_json = '{'").run();
    }, "Persisted startup context is malformed"],
    ["the persisted startup context names another runtime", () => {
      db.prepare("UPDATE node_startup_context SET runtime = 'claude-code'").run();
    }, "does not match the seat's runtime 'codex'"],
  ])("refuses before the successor is created when %s, leaving the seat's session as it was", async (_label, breakStartup, detail) => {
    const { node, sessionId } = seedSeat();
    breakStartup();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "new guidance", source: "rebuild" });

    expect(result).toMatchObject({ ok: false, code: "startup_context_failed" });
    if (result.ok) return;
    expect(result.message).toContain(detail);
    expect(respawnPane).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
    expect(liveSession(node.id)?.id).toBe(sessionId);
  });

  it("types nothing more into the pane after commit when the successor's startup needs attention, and says how to finish it", async () => {
    const { node } = seedSeat();
    checkReady
      .mockResolvedValueOnce({ ready: true }) // the successor launch
      .mockResolvedValue({ ready: false, code: "hook_trust_gate", reason: "native gate" }); // its startup delivery

    const result = mutation(await service.handover({ seatRef: "dev-impl@seat-rig", reason: "new guidance", source: "rebuild" }));

    expect(result).toMatchObject({
      startup: { status: "attention_required" },
      sideEffects: { startupContextDelivered: false },
      currentStatus: { startupStatus: "attention_required" },
    });
    expect(result.startup?.detail).toContain("rig seat continue");
    expect(result.primingNotDelivered).toBeDefined();
    expect(sendText).not.toHaveBeenCalled();
    expect(liveSession(node.id)).toMatchObject({ startup_status: "attention_required" });
  });

  it("records a startup that fails after commit on the committed result and types nothing more into the pane", async () => {
    const { node } = seedSeat();
    deliverStartup
      .mockImplementationOnce(async (files: ResolvedStartupFile[]) => ({ delivered: files.length, failed: [] })) // before the successor
      .mockImplementation(async (files: ResolvedStartupFile[]) => ({ delivered: 0, failed: files.map((file) => ({ path: file.path, error: "EACCES" })) }));

    const result = mutation(await service.handover({ seatRef: "dev-impl@seat-rig", reason: "new guidance", source: "rebuild" }));

    expect(result).toMatchObject({ startup: { status: "failed" }, currentStatus: { startupStatus: "failed" }, sideEffects: { startupContextDelivered: false } });
    expect(result.startup?.detail).toContain("EACCES");
    expect(result.primingNotDelivered).toBeDefined();
    expect(sendText).not.toHaveBeenCalled();
    expect(liveSession(node.id)).toMatchObject({ origin: "launched", startup_status: "failed" });
  });

  it("reports a startup that throws after commit as a failed startup of the committed handover, not a failed handover", async () => {
    const { node } = seedSeat();
    vi.spyOn(startupOrchestrator, "startNode").mockRejectedValue(new Error("daemon lost the pane"));

    const result = mutation(await service.handover({ seatRef: "dev-impl@seat-rig", reason: "new guidance", source: "rebuild" }));

    expect(result).toMatchObject({ startup: { status: "failed", detail: "Startup error: daemon lost the pane" }, currentStatus: { startupStatus: "failed" } });
    expect(result.primingNotDelivered).toBeDefined();
    expect(lifecycleEvents()).toContain("seat.handover_completed");
    expect(liveSession(node.id)).toMatchObject({ startup_status: "failed" });
  });

  it("withholds the priming while the startup prompt still waits in the composer, so the two are not submitted together", async () => {
    seedSeat();
    vi.spyOn(startupOrchestrator, "startNode").mockResolvedValue({
      ok: true, startupStatus: "ready", continuityOutcome: "rebuilt",
      submission: { status: "staged", reasons: ["not submitted"], warning: "Press Enter in dev-impl@seat-rig" },
    });

    const result = mutation(await service.handover({ seatRef: "dev-impl@seat-rig", reason: "new guidance", source: "rebuild" }));

    expect(result).toMatchObject({ startup: { status: "ready", detail: "Press Enter in dev-impl@seat-rig" }, sideEffects: { startupContextDelivered: false } });
    expect(result.primingNotDelivered).toContain("waiting in its composer");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("says so when the startup finished but the priming couldn't be sent", async () => {
    seedSeat();
    sendText.mockImplementation(async (_session: string, text: string) => (text.startsWith(PRIMING_HEADER)
      ? { ok: false, message: "tmux refused the paste" }
      : { ok: true }));

    const result = mutation(await service.handover({ seatRef: "dev-impl@seat-rig", reason: "new guidance", source: "rebuild" }));

    expect(result).toMatchObject({ startup: { status: "ready" }, sideEffects: { startupContextDelivered: false }, primingNotDelivered: "tmux refused the paste" });
  });

  it("reports a warning from writing the same startup file twice once", async () => {
    seedSeat();
    deliverStartup.mockImplementation(async (files: ResolvedStartupFile[]) => ({ delivered: files.length, failed: [], warnings: ["Left CLAUDE.md as it is"] }));

    const result = mutation(await service.handover({ seatRef: "dev-impl@seat-rig", reason: "new guidance", source: "rebuild" }));

    expect(result.startup?.warnings).toEqual(["Left CLAUDE.md as it is"]);
  });

  it("primes a seat without a persisted startup context from its durable chain alone, before commit, and says why", async () => {
    seedSeat({ startupContext: false });
    let committedBeforePriming: boolean | undefined;
    sendText.mockImplementation(async (_session: string, text: string) => {
      log.push(`send:${text.split("\n")[0]}`);
      committedBeforePriming = lifecycleEvents().includes("seat.handover_completed");
      return { ok: true };
    });

    const result = mutation(await service.handover({ seatRef: "dev-impl@seat-rig", reason: "new guidance", source: "rebuild" }));

    expect(log).toEqual(["respawn", "launch", `send:${PRIMING_HEADER}`]);
    expect(committedBeforePriming).toBe(false);
    expect(result).toMatchObject({ startup: { status: "skipped" }, sideEffects: { startupContextDelivered: true } });
    expect(result.startup?.detail).toContain("Persisted startup context is missing");
  });
});
