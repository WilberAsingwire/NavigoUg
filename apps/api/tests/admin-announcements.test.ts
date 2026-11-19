import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SignJWT } from "jose";

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  notificationCreateMany: vi.fn(),
  auditCreate: vi.fn(),
  auditFindMany: vi.fn(),
  transaction: vi.fn(),
  sendPushNotificationToUsers: vi.fn()
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findMany: mocks.userFindMany },
    notification: { createMany: mocks.notificationCreateMany },
    auditLog: {
      create: mocks.auditCreate,
      findMany: mocks.auditFindMany
    },
    $transaction: mocks.transaction
  }
}));

vi.mock("../src/modules/notifications/notifications.service.js", () => ({
  sendPushNotificationToUsers: mocks.sendPushNotificationToUsers
}));

import { app } from "../src/app.js";

const adminId = "7b6bce6e-9d14-4b11-9f0e-0e8e9408e8e4";
const customerId = "9d530def-28a0-4c1d-8c2e-6ffbaed03ec3";
const riderId = "bda4e5ac-4d54-4ee8-a193-5c0cb065e172";
const secret = new TextEncoder().encode("local-test-secret-that-is-long-enough-123456");

async function token(role: "CUSTOMER" | "RIDER" | "ADMIN") {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(adminId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

const tx = {
  user: { findMany: mocks.userFindMany },
  notification: { createMany: mocks.notificationCreateMany },
  auditLog: { create: mocks.auditCreate }
};

describe("Administrator announcements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    mocks.transaction.mockImplementation(async (callback: (value: unknown) => unknown) => callback(tx));
    mocks.userFindMany.mockResolvedValue([
      { id: customerId },
      { id: riderId }
    ]);
    mocks.notificationCreateMany.mockResolvedValue({ count: 2 });
    mocks.auditCreate.mockResolvedValue({
      id: "c2a27e83-9d44-47c6-8ddd-2bc5d10e54e3",
      createdAt: new Date("2026-11-19T10:00:00.000Z")
    });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.sendPushNotificationToUsers.mockResolvedValue(undefined);
  });

  it("allows only administrators to access the announcement composer API", async () => {
    const accessToken = await token("RIDER");
    const response = await request(app)
      .post("/api/v1/admin/announcements")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ title: "Welcome", body: "Thanks for using NAVIGO.", audience: "BOTH" });

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects invalid recipient groups and empty messages", async () => {
    const accessToken = await token("ADMIN");
    const response = await request(app)
      .post("/api/v1/admin/announcements")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ title: " ", body: "", audience: "EVERYONE" });

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("creates one in-app notification per active recipient and sends push to registered devices", async () => {
    const accessToken = await token("ADMIN");
    const response = await request(app)
      .post("/api/v1/admin/announcements")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        title: "Welcome to NAVIGO",
        body: "Thank you for joining us. Safe travels!",
        audience: "BOTH"
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      title: "Welcome to NAVIGO",
      audience: "BOTH",
      recipientCount: 2
    });
    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        role: { in: ["CUSTOMER", "RIDER"] }
      },
      select: { id: true }
    });
    expect(mocks.notificationCreateMany).toHaveBeenCalledWith({
      data: [
        {
          userId: customerId,
          title: "Welcome to NAVIGO",
          body: "Thank you for joining us. Safe travels!"
        },
        {
          userId: riderId,
          title: "Welcome to NAVIGO",
          body: "Thank you for joining us. Safe travels!"
        }
      ]
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "ADMIN_ANNOUNCEMENT_SENT",
        metadata: expect.objectContaining({
          audience: "BOTH",
          recipientCount: 2
        })
      })
    }));
    expect(mocks.sendPushNotificationToUsers).toHaveBeenCalledWith(
      [customerId, riderId],
      expect.objectContaining({ title: "Welcome to NAVIGO" })
    );
  });

  it("does not create a broadcast when the selected audience has no active users", async () => {
    const accessToken = await token("ADMIN");
    mocks.userFindMany.mockResolvedValue([]);
    const response = await request(app)
      .post("/api/v1/admin/announcements")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ title: "Service update", body: "A short update.", audience: "CUSTOMER" });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("NO_ANNOUNCEMENT_RECIPIENTS");
    expect(mocks.notificationCreateMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.sendPushNotificationToUsers).not.toHaveBeenCalled();
  });

  it("lists recent announcements from the administrator audit history", async () => {
    const accessToken = await token("ADMIN");
    mocks.auditFindMany.mockResolvedValue([{
      id: "c2a27e83-9d44-47c6-8ddd-2bc5d10e54e3",
      metadata: {
        title: "Service update",
        body: "The service is available today.",
        audience: "CUSTOMER",
        recipientCount: 12
      },
      createdAt: new Date("2026-11-19T10:00:00.000Z"),
      actor: { fullName: "NAVIGO Admin" }
    }]);

    const response = await request(app)
      .get("/api/v1/admin/announcements")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({
      title: "Service update",
      audience: "CUSTOMER",
      recipientCount: 12,
      senderName: "NAVIGO Admin"
    });
  });
});
