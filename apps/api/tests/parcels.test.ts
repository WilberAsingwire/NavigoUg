import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SignJWT } from "jose";

const mocks = vi.hoisted(() => ({
  fareRuleFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  parcelCreate: vi.fn(),
  parcelFindMany: vi.fn(),
  parcelFindUnique: vi.fn(),
  parcelUpdateMany: vi.fn(),
  parcelHistoryCreate: vi.fn(),
  transaction: vi.fn(),
  getMotorcycleRoute: vi.fn()
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    fareRule: { findMany: mocks.fareRuleFindMany },
    user: { findUnique: mocks.userFindUnique },
    parcelRequest: {
      create: mocks.parcelCreate,
      findMany: mocks.parcelFindMany,
      findUnique: mocks.parcelFindUnique,
      updateMany: mocks.parcelUpdateMany
    },
    parcelStatusHistory: { create: mocks.parcelHistoryCreate },
    $transaction: mocks.transaction
  }
}));

vi.mock("../src/modules/rides/routing.service.js", () => ({
  getMotorcycleRoute: mocks.getMotorcycleRoute,
  MotorcycleRoutingError: class MotorcycleRoutingError extends Error {
    constructor(
      public readonly statusCode: number,
      public readonly code: string,
      message: string
    ) { super(message); }
  }
}));

import { app } from "../src/app.js";

const secret = new TextEncoder().encode("local-test-secret-that-is-long-enough-123456");
const senderId = "7b6bce6e-9d14-4b11-9f0e-0e8e9408e8e4";

async function accessToken(role: "CUSTOMER" | "RIDER" | "ADMIN") {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(senderId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

const parcelInput = {
  pickup: {
    latitude: 3.0200,
    longitude: 30.9100,
    description: "Muni University"
  },
  destination: {
    latitude: 3.0300,
    longitude: 30.9200,
    description: "Arua Main Market"
  },
  sizeCategory: "SMALL",
  recipientName: "Test Recipient",
  recipientPhone: "+256700000000",
  parcelDescription: "A sealed envelope",
  paymentMethod: "CASH"
};

const fakeParcel = {
  id: "9d530def-28a0-4c1d-8c2e-6ffbaed03ec3",
  senderId,
  riderId: null,
  recipientName: parcelInput.recipientName,
  recipientPhone: parcelInput.recipientPhone,
  parcelDescription: parcelInput.parcelDescription,
  sizeCategory: "SMALL",
  status: "PENDING",
  pickupLatitude: 3.02,
  pickupLongitude: 30.91,
  pickupLandmarkId: null,
  pickupDescription: "Muni University",
  destinationLatitude: 3.03,
  destinationLongitude: 30.92,
  destinationLandmarkId: null,
  destinationDescription: "Arua Main Market",
  fareAmountUgx: 2500,
  fareBasis: "DISTANCE_RULE",
  estimatedDistanceKm: 3.7,
  pickupCodeHash: "private-pickup-hash",
  deliveryCodeHash: "private-delivery-hash",
  pickupCodeAttempts: 0,
  deliveryCodeAttempts: 0,
  pickupCodeLockedAt: null,
  deliveryCodeLockedAt: null,
  expiresAt: null,
  acceptedAt: null,
  collectedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  createdAt: new Date("2026-11-19T07:00:00.000Z"),
  updatedAt: new Date("2026-11-19T07:00:00.000Z"),
  payment: { method: "CASH", status: "UNPAID", amountUgx: 2500 }
};

describe("Parcel delivery API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    mocks.getMotorcycleRoute.mockResolvedValue({
      distanceKm: 3.7,
      durationSeconds: 720,
      coordinates: [
        { latitude: parcelInput.pickup.latitude, longitude: parcelInput.pickup.longitude },
        { latitude: parcelInput.destination.latitude, longitude: parcelInput.destination.longitude }
      ],
      provider: "VALHALLA_MOTORCYCLE"
    });
    mocks.fareRuleFindMany.mockResolvedValue([
      { minDistanceKm: 0, maxDistanceKm: 5, fareUgx: 2500 }
    ]);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        parcelRequest: {
          create: mocks.parcelCreate,
          findMany: mocks.parcelFindMany,
          findUnique: mocks.parcelFindUnique,
          updateMany: mocks.parcelUpdateMany
        },
        parcelStatusHistory: { create: mocks.parcelHistoryCreate }
      })
    );
  });

  it("requires authentication for parcel endpoints", async () => {
    const response = await request(app).get("/api/v1/parcels/mine");
    expect(response.status).toBe(401);
  });

  it("prevents customers from viewing the rider parcel queue", async () => {
    const token = await accessToken("CUSTOMER");
    const response = await request(app)
      .get("/api/v1/parcels/available")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(mocks.parcelFindMany).not.toHaveBeenCalled();
  });

  it("calculates a parcel fare using the matching size-specific road-distance rule", async () => {
    const token = await accessToken("CUSTOMER");
    const response = await request(app)
      .post("/api/v1/parcels/fare-quote")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pickup: parcelInput.pickup,
        destination: parcelInput.destination,
        sizeCategory: "SMALL"
      });

    expect(response.status).toBe(200);
    expect(response.body.data.distanceKm).toBe(3.7);
    expect(response.body.data.fareAmountUgx).toBe(2500);
    expect(response.body.data.durationSeconds).toBe(720);
    expect(response.body.data.routingProvider).toBe("VALHALLA_MOTORCYCLE");
    expect(mocks.fareRuleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        requestType: "PARCEL",
        parcelSize: "SMALL",
        isActive: true
      })
    }));
  });

  it("does not reuse ride fares when a parcel size tariff is missing", async () => {
    mocks.fareRuleFindMany.mockResolvedValue([]);
    const token = await accessToken("CUSTOMER");
    const response = await request(app)
      .post("/api/v1/parcels/fare-quote")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pickup: parcelInput.pickup,
        destination: parcelInput.destination,
        sizeCategory: "LARGE"
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("PARCEL_FARE_NOT_CONFIGURED");
  });

  it("creates a parcel request and returns one-time verification codes without exposing hashes", async () => {
    const token = await accessToken("CUSTOMER");
    mocks.parcelCreate.mockResolvedValue(fakeParcel);
    const response = await request(app)
      .post("/api/v1/parcels")
      .set("Authorization", `Bearer ${token}`)
      .send(parcelInput);

    expect(response.status).toBe(201);
    expect(response.body.data.id).toBe(fakeParcel.id);
    expect(response.body.data.status).toBe("PENDING");
    expect(response.body.data.pickupCode).toMatch(/^\\d{6}$/);
    expect(response.body.data.deliveryCode).toMatch(/^\\d{6}$/);
    expect(response.body.data).not.toHaveProperty("pickupCodeHash");
    expect(response.body.data).not.toHaveProperty("deliveryCodeHash");
    expect(mocks.parcelHistoryCreate).toHaveBeenCalled();
  });
});
