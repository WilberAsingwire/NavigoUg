import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn()
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $executeRaw: mocks.executeRaw
  }
}));

import { ensureRideRouteSnapshotColumns } from "../src/modules/rides/ride-route-schema.service.js";

describe("ride route snapshot schema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeRaw.mockResolvedValue(0);
  });

  it("adds the optional route columns idempotently without changing existing rows", async () => {
    await ensureRideRouteSnapshotColumns();

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const template = mocks.executeRaw.mock.calls[0]?.[0] as TemplateStringsArray;
    const sql = Array.from(template).join(" ");
    expect(sql).toContain('ALTER TABLE "ride_requests"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "route_coordinates" JSONB');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "estimated_duration_seconds" INTEGER');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "routing_provider" VARCHAR(40)');
  });
});
