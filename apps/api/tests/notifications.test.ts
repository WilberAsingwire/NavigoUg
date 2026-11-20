import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SignJWT } from "jose";

const mocks = vi.hoisted(() => ({
  notificationFindMany: vi.fn(),
  notificationCount: vi.fn(),
  notificationUpdateMany: vi.fn(),
  notificationFindFirst: vi.fn(),
  deviceTokenUpsert: vi.fn(),
  deviceTokenDeleteMany: vi.fn(),
  deviceTokenFindMany: vi.fn()
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    notification: {
      findMany: mocks.notificationFindMany,
      count: mocks.notificationCount,
      updateMany: mocks.notificationUpdateMany,
      findFirst: mocks.notificationFindFirst
    },
    deviceToken: {
      upsert: mocks.deviceTokenUpsert,
      deleteMany: mocks.deviceTokenDeleteMany,
      findMany: mocks.deviceTokenFindMany
    }
  }
}));

import { app } from "../src/app.js";
import { sendPushNotificationToUser } from "../src/modules/notifications/notifications.service.js";

const userId = "7b6bce6e-9d14-4b11-9f0e-0e8e9408e8e4";
const expoPushToken = "ExpoPushToken[abcdefghijklmnop123456]";
const secret = new TextEncoder().encode("local-test-secret-that-is-long-enough-123456");

async function authHeader() {
  const token = await new SignJWT({ role: "CUSTOMER" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
  return { Authorization: "Bearer " + token };
}

describe("Notification device registration and push delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    mocks.deviceTokenUpsert.mockResolvedValue({ id: "device-token-id" });
    mocks.deviceTokenDeleteMany.mockResolvedValue({ count: 1 });
    mocks.deviceTokenFindMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires authentication to register a device token", async () => {
    const response = await request(app)
      .post("/api/v1/notifications/device-token")
      .send({ pushToken: expoPushToken, platform: "ANDROID" });

    expect(response.status).toBe(401);
    expect(mocks.deviceTokenUpsert).not.toHaveBeenCalled();
  });

  it("rejects malformed tokens and unsupported platforms", async () => {
    const headers = await authHeader();
    const response = await request(app)
      .post("/api/v1/notifications/device-token")
      .set(headers)
      .send({ pushToken: "not-a-push-token", platform: "ANDROID" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_DEVICE_TOKEN");

    const unsupported = await request(app)
      .post("/api/v1/notifications/device-token")
      .set(headers)
      .send({ pushToken: expoPushToken, platform: "IOS" });
    expect(unsupported.status).toBe(400);
    expect(mocks.deviceTokenUpsert).not.toHaveBeenCalled();
  });

  it("registers the token for the authenticated user without returning the token", async () => {
    const headers = await authHeader();
    const response = await request(app)
      .post("/api/v1/notifications/device-token")
      .set(headers)
      .send({ pushToken: expoPushToken, platform: "ANDROID" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ registered: true });
    expect(JSON.stringify(response.body)).not.toContain(expoPushToken);
    expect(mocks.deviceTokenUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { pushToken: expoPushToken },
      create: { userId, pushToken: expoPushToken, platform: "ANDROID" },
      update: expect.objectContaining({ userId, platform: "ANDROID", lastSeenAt: expect.any(Date) })
    }));
  });

  it("removes only the authenticated user's matching device token", async () => {
    const headers = await authHeader();
    const response = await request(app)
      .delete("/api/v1/notifications/device-token")
      .set(headers)
      .send({ pushToken: expoPushToken });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ removed: true });
    expect(mocks.deviceTokenDeleteMany).toHaveBeenCalledWith({
      where: { userId, pushToken: expoPushToken }
    });
  });

  it("sends Expo push messages to registered devices", async () => {
    mocks.deviceTokenFindMany.mockResolvedValue([{ pushToken: expoPushToken }]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: "ok" }] })
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendPushNotificationToUser(userId, {
      title: "Your rider has accepted",
      body: "A NAVIGO rider has accepted your request.",
      data: { requestType: "RIDE", requestId: "ride-id" }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://exp.host/--/api/v2/push/send",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(expoPushToken)
      })
    );
  });

  it("removes device tokens Expo reports as unregistered", async () => {
    mocks.deviceTokenFindMany.mockResolvedValue([{ pushToken: expoPushToken }]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] })
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendPushNotificationToUser(userId, {
      title: "Ride update",
      body: "Your ride status changed.",
      data: { requestType: "RIDE", requestId: "ride-id" }
    });

    expect(mocks.deviceTokenDeleteMany).toHaveBeenCalledWith({
      where: { pushToken: { in: [expoPushToken] } }
    });
  });

  it("does not call Expo when the user has no registered devices", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await sendPushNotificationToUser(userId, {
      title: "Ride update",
      body: "Your ride status changed.",
      data: {}
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
