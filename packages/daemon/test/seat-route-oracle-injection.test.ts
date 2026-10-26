import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// WAVE O FIX R1 — B1 (R2 verdict 508e383d): the PRODUCTION handover construction must
// receive the daemon's ONE SeatActivityService. The service-level swap contract is
// already pinned (seat-handover-service.test.ts); THIS pin holds the actual route seam
// R2's effect probe caught: routes/seat.ts constructed the service without the oracle,
// so a real managed handover committed without declareOccupantSwap and the successor
// could inherit the retiree's evidence and promoted rung authority.

const constructed: Array<Record<string, unknown>> = [];
const handover = vi.fn(async () => ({ ok: true, seat: "x" }));

vi.mock("../src/domain/seat-handover-service.js", () => ({
  SeatHandoverService: class {
    constructor(deps: Record<string, unknown>) {
      constructed.push(deps);
    }
    handover = handover;
  },
}));

import { seatRoutes } from "../src/routes/seat.js";

function makeApp(sentinelOracle: object, startupOrchestrator?: object) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, { db: {} } as never);
    c.set("sessionRegistry" as never, {} as never);
    c.set("discoveryRepo" as never, {} as never);
    c.set("eventBus" as never, {} as never);
    c.set("tmuxAdapter" as never, {} as never);
    c.set("seatActivityService" as never, sentinelOracle as never);
    if (startupOrchestrator) c.set("startupOrchestrator" as never, startupOrchestrator as never);
    await next();
  });
  app.route("/api/seat", seatRoutes);
  return app;
}

describe("Wave-O B1 — production handover construction injects the one activity oracle", () => {
  beforeEach(() => {
    constructed.length = 0;
    handover.mockClear();
  });

  it("POST /api/seat/handover/:seatRef constructs the service WITH the context's seatActivityService as activityOracle", async () => {
    const sentinel = { declareOccupantSwap: vi.fn() };
    const app = makeApp(sentinel);
    const res = await app.request("/api/seat/handover/dev-impl%40seat-rig", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "context-wall", source: "fresh" }),
    });
    expect(res.status).toBe(200);
    expect(constructed).toHaveLength(1);
    // The R2 discriminator, preserved: candidate captured `undefined` here.
    expect(constructed[0]!.activityOracle).toBe(sentinel);
  });
});

// A rebuild replays the seat's startup context through the daemon's orchestrator; without it the route would silently
// fall back to priming the successor from its durable chain alone.
describe("production handover construction injects the startup orchestrator", () => {
  beforeEach(() => {
    constructed.length = 0;
    handover.mockClear();
  });

  it("constructs the service with the context's startupOrchestrator, and answers a startup_context_failed refusal with 409", async () => {
    const orchestrator = { startNode: vi.fn() };
    const app = makeApp({ declareOccupantSwap: vi.fn() }, orchestrator);
    handover.mockResolvedValueOnce({ ok: false, code: "startup_context_failed", message: "malformed", guidance: "fix it" } as never);

    const res = await app.request("/api/seat/handover/dev-impl%40seat-rig", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "new guidance", source: "rebuild" }),
    });

    expect(constructed[0]!.startupOrchestrator).toBe(orchestrator);
    expect(res.status).toBe(409);
  });
});
