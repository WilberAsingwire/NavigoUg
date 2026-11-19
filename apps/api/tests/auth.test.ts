import { beforeEach, describe, expect, it, vi } from "vitest";
import * as argon2 from "argon2";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  userCreate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  transaction: vi.fn(),
  refreshCreate: vi.fn(),
  refreshFindUnique: vi.fn(),
  refreshUpdateMany: vi.fn(),
  queryRaw: vi.fn()
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: {
      create: mocks.userCreate,
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate
    },
    refreshToken: {
      create: mocks.refreshCreate,
      findUnique: mocks.refreshFindUnique,
      updateMany: mocks.refreshUpdateMany
    },
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction
  }
}));

import { app } from "../src/app.js";

const password = "TestPassword-2026!";
const sampleUser = {
  id: "7b6bce6e-9d14-4b11-9f0e-0e8e9408e8e4",
  fullName: "Test Customer",
  phone: "+256700000001",
  email: "customer@example.test",
  role: "CUSTOMER" as const,
  isActive: true,
  riderProfile: null
};

describe("Authentication API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
      user: { update: mocks.userUpdate },
      refreshToken: { updateMany: mocks.refreshUpdateMany }
    }));
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    process.env.JWT_ACCESS_TTL_SECONDS = "900";
    process.env.REFRESH_TOKEN_TTL_DAYS = "30";
  });

  it("registers a customer without allowing the client to choose an elevated role", async () => {
    mocks.userCreate.mockResolvedValue(sampleUser);
    mocks.refreshCreate.mockResolvedValue({});

    const response = await request(app)
      .post("/api/v1/auth/register/customer")
      .send({
        fullName: sampleUser.fullName,
        phone: sampleUser.phone,
        email: sampleUser.email,
        password,
        role: "ADMIN"
      });

    expect(response.status).toBe(201);
    expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: "CUSTOMER" })
    }));
    expect(response.body.data.user.role).toBe("CUSTOMER");
    expect(response.body.data.user).not.toHaveProperty("passwordHash");
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(response.body.data.refreshToken).toEqual(expect.any(String));

    const createdData = mocks.userCreate.mock.calls[0]?.[0]?.data;
    expect(await argon2.verify(createdData.passwordHash, password)).toBe(true);
  });

  it("creates rider accounts in the pending approval state", async () => {
    mocks.userCreate.mockResolvedValue({
      ...sampleUser,
      role: "RIDER",
      riderProfile: { approvalStatus: "PENDING" }
    });
    mocks.refreshCreate.mockResolvedValue({});

    const response = await request(app)
      .post("/api/v1/auth/register/rider")
      .send({
        fullName: "Test Rider",
        phone: "+256700000002",
        password,
        licenceNumber: "DL-TEST-001",
        motorcyclePlate: "UAA 123A",
        motorcycleDescription: "Black motorcycle"
      });

    expect(response.status).toBe(201);
    expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        role: "RIDER",
        riderProfile: {
          create: expect.objectContaining({ approvalStatus: "PENDING" })
        }
      }),
      include: { riderProfile: true }
    }));
    expect(response.body.data.user.riderApprovalStatus).toBe("PENDING");
  });

  it("returns a generic authentication error for an incorrect password", async () => {
    const passwordHash = await argon2.hash(password);
    mocks.userFindUnique.mockResolvedValue({
      ...sampleUser,
      passwordHash
    });

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ phone: sampleUser.phone, password: "WrongPassword!" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(response.body.error.message).not.toContain(sampleUser.phone);
    expect(mocks.refreshCreate).not.toHaveBeenCalled();
  });

  it("rotates a refresh token exactly once", async () => {
    const existingToken = "refresh-token-for-test-12345678901234567890";
    mocks.refreshFindUnique.mockResolvedValue({
      id: "4ccfa809-038a-46e9-a8e7-f02c8d7dd03c",
      userId: sampleUser.id,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: sampleUser
    });
    mocks.refreshUpdateMany.mockResolvedValue({ count: 1 });
    mocks.refreshCreate.mockResolvedValue({});

    const response = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: existingToken });

    expect(response.status).toBe(200);
    expect(response.body.data.refreshToken).not.toBe(existingToken);
    expect(mocks.refreshUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ revokedAt: null }),
      data: expect.objectContaining({ revokedAt: expect.any(Date) })
    }));
    expect(mocks.refreshCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects a refresh token that has already been used", async () => {
    const existingToken = "refresh-token-for-test-12345678901234567890";
    mocks.refreshFindUnique.mockResolvedValue({
      id: "4ccfa809-038a-46e9-a8e7-f02c8d7dd03c",
      userId: sampleUser.id,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: sampleUser
    });
    mocks.refreshUpdateMany.mockResolvedValue({ count: 0 });

    const response = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: existingToken });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    expect(mocks.refreshCreate).not.toHaveBeenCalled();
  });
  it("allows an authenticated user to update only their own profile details", async () => {
    const passwordHash = await argon2.hash(password);
    mocks.userFindUnique.mockResolvedValue({ ...sampleUser, passwordHash });
    mocks.refreshCreate.mockResolvedValue({});

    const loginResponse = await request(app)
      .post("/api/v1/auth/login")
      .send({ phone: sampleUser.phone, password });
    const accessToken = loginResponse.body.data.accessToken as string;

    mocks.userUpdate.mockResolvedValue({
      ...sampleUser,
      fullName: "Updated Customer",
      email: null
    });

    const response = await request(app)
      .patch("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ fullName: "Updated Customer", email: "" });

    expect(response.status).toBe(200);
    expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: sampleUser.id },
      data: { fullName: "Updated Customer", email: null },
      include: { riderProfile: true }
    }));
    expect(response.body.data.fullName).toBe("Updated Customer");
    expect(response.body.data).not.toHaveProperty("passwordHash");
  });

  it("requires the current password and rotates sessions when a password is changed", async () => {
    const passwordHash = await argon2.hash(password);
    mocks.userFindUnique
      .mockResolvedValueOnce({ ...sampleUser, passwordHash })
      .mockResolvedValueOnce({ ...sampleUser, passwordHash: "updated-hash" });
    mocks.userUpdate.mockResolvedValue({});
    mocks.refreshUpdateMany.mockResolvedValue({ count: 1 });
    mocks.refreshCreate.mockResolvedValue({});

    const loginResponse = await request(app)
      .post("/api/v1/auth/login")
      .send({ phone: sampleUser.phone, password });
    const accessToken = loginResponse.body.data.accessToken as string;

    const response = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ currentPassword: password, newPassword: "NewSecurePassword-2026!" });

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(response.body.data.refreshToken).toEqual(expect.any(String));
    expect(mocks.refreshUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: sampleUser.id, revokedAt: null },
      data: expect.objectContaining({ revokedAt: expect.any(Date) })
    }));
    const newPasswordHash = mocks.userUpdate.mock.calls[0]?.[0]?.data?.passwordHash as string;
    expect(await argon2.verify(newPasswordHash, "NewSecurePassword-2026!")).toBe(true);
  });

  it("rejects a password change when the current password is incorrect", async () => {
    const passwordHash = await argon2.hash(password);
    mocks.userFindUnique.mockResolvedValue({ ...sampleUser, passwordHash });

    const loginResponse = await request(app)
      .post("/api/v1/auth/login")
      .send({ phone: sampleUser.phone, password });
    const accessToken = loginResponse.body.data.accessToken as string;

    const response = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ currentPassword: "IncorrectPassword!", newPassword: "NewSecurePassword-2026!" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("CURRENT_PASSWORD_INCORRECT");
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

});
