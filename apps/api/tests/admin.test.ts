import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SignJWT } from "jose";

const mocks = vi.hoisted(() => ({
  riderFindMany: vi.fn(),
  riderFindUnique: vi.fn(),
  riderUpdate: vi.fn(),
  fareFindMany: vi.fn(),
  fareCreate: vi.fn(),
  fareFindUnique: vi.fn(),
  fareUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    riderProfile: {
      findMany: mocks.riderFindMany,
      findUnique: mocks.riderFindUnique,
      update: mocks.riderUpdate
    },
    fareRule: {
      findMany: mocks.fareFindMany,
      create: mocks.fareCreate,
      findUnique: mocks.fareFindUnique,
      update: mocks.fareUpdate
    },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction
  }
}));

import { app } from "../src/app.js";

const secret = new TextEncoder().encode("local-test-secret-that-is-long-enough-123456");
const adminId = "7b6bce6e-9d14-4b11-9f0e-0e8e9408e8e4";
const riderId = "9d530def-28a0-4c1d-8c2e-6ffbaed03ec3";
const fareRuleId = "31af9f77-559d-4844-bf11-a0648e46f6bc";

async function accessToken(role: "CUSTOMER" | "RIDER" | "ADMIN") {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(adminId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

const tx = {
  riderProfile: {
    findMany: mocks.riderFindMany,
    findUnique: mocks.riderFindUnique,
    update: mocks.riderUpdate
  },
  fareRule: {
    findMany: mocks.fareFindMany,
    create: mocks.fareCreate,
    findUnique: mocks.fareFindUnique,
    update: mocks.fareUpdate
  },
  auditLog: { create: mocks.auditCreate }
};

describe("Administrator API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    mocks.transaction.mockImplementation(async (callback: (value: unknown) => unknown) => callback(tx));
    mocks.auditCreate.mockResolvedValue({});
  });

  it("requires administrator role for management routes", async () => {
    const token = await accessToken("CUSTOMER");
    const response = await request(app)
      .get("/api/v1/admin/riders")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(mocks.riderFindMany).not.toHaveBeenCalled();
  });

  it("lists rider applications and supports status filtering", async () => {
    const token = await accessToken("ADMIN");
    const rows = [{ userId: riderId, approvalStatus: "PENDING", user: { id: riderId, fullName: "Test Rider" } }];
    mocks.riderFindMany.mockResolvedValue(rows);

    const response = await request(app)
      .get("/api/v1/admin/riders?status=PENDING")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(mocks.riderFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { approvalStatus: "PENDING" }
    }));
  });

  it("approves a rider and records an audit event", async () => {
    const token = await accessToken("ADMIN");
    mocks.riderFindUnique.mockResolvedValue({
      approvalStatus: "PENDING",
      user: { id: riderId, role: "RIDER" }
    });
    mocks.riderUpdate.mockResolvedValue({
      userId: riderId,
      approvalStatus: "APPROVED",
      user: { id: riderId, fullName: "Test Rider" }
    });

    const response = await request(app)
      .patch(`/api/v1/admin/riders/${riderId}/approval`)
      .set("Authorization", `Bearer ${token}`)
      .send({ approvalStatus: "APPROVED" });

    expect(response.status).toBe(200);
    expect(response.body.data.approvalStatus).toBe("APPROVED");
    expect(mocks.riderUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        approvalStatus: "APPROVED",
        reviewedById: adminId,
        rejectionReason: null
      })
    }));
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "RIDER_APPLICATION_REVIEWED",
        targetId: riderId
      })
    }));
  });

  it("rejects item-delivery fare rules without a size category", async () => {
    const token = await accessToken("ADMIN");
    const response = await request(app)
      .post("/api/v1/admin/fare-rules")
      .set("Authorization", `Bearer ${token}`)
      .send({
        requestType: "PARCEL",
        minDistanceKm: 0,
        maxDistanceKm: 5,
        fareUgx: 2000,
        isActive: true
      });

    expect(response.status).toBe(400);
    expect(mocks.fareCreate).not.toHaveBeenCalled();
  });

  it("creates an item-delivery fare rule and records an audit event", async () => {
    const token = await accessToken("ADMIN");
    mocks.fareFindMany.mockResolvedValue([]);
    mocks.fareCreate.mockResolvedValue({
      id: fareRuleId,
      requestType: "PARCEL",
      parcelSize: "SMALL",
      minDistanceKm: 0,
      maxDistanceKm: 5,
      fareUgx: 2000,
      isActive: true
    });

    const response = await request(app)
      .post("/api/v1/admin/fare-rules")
      .set("Authorization", `Bearer ${token}`)
      .send({
        requestType: "PARCEL",
        parcelSize: "SMALL",
        minDistanceKm: 0,
        maxDistanceKm: 5,
        fareUgx: 2000,
        isActive: true
      });

    expect(response.status).toBe(201);
    expect(response.body.data.id).toBe(fareRuleId);
    expect(mocks.fareCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        requestType: "PARCEL",
        parcelSize: "SMALL",
        fareUgx: 2000
      })
    }));
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "FARE_RULE_CREATED" })
    }));
  });

  it("prevents overlapping active fare ranges for the same service and size", async () => {
    const token = await accessToken("ADMIN");
    mocks.fareFindMany.mockResolvedValue([
      { id: fareRuleId, minDistanceKm: 0, maxDistanceKm: 5 }
    ]);

    const response = await request(app)
      .post("/api/v1/admin/fare-rules")
      .set("Authorization", `Bearer ${token}`)
      .send({
        requestType: "PARCEL",
        parcelSize: "SMALL",
        minDistanceKm: 4,
        maxDistanceKm: 7,
        fareUgx: 2500,
        isActive: true
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("FARE_RULE_OVERLAP");
    expect(mocks.fareCreate).not.toHaveBeenCalled();
  });

  it("does not allow an administrator to deactivate a rule that does not exist", async () => {
    const token = await accessToken("ADMIN");
    mocks.fareFindUnique.mockResolvedValue(null);
    const response = await request(app)
      .patch(`/api/v1/admin/fare-rules/${fareRuleId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        requestType: "RIDE",
        parcelSize: null,
        minDistanceKm: 0,
        maxDistanceKm: 5,
        fareUgx: 2000,
        isActive: false
      });

    expect(response.status).toBe(404);
    expect(mocks.fareUpdate).not.toHaveBeenCalled();
  });
});
