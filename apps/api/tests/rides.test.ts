import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SignJWT } from "jose";

const mocks = vi.hoisted(() => ({
  fareRuleFindMany: vi.fn(),
  landmarkFindMany: vi.fn(),
  landmarkFareFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  rideCreate: vi.fn(),
  rideFindMany: vi.fn(),
  rideFindUnique: vi.fn(),
  rideUpdateMany: vi.fn(),
  rideHistoryCreate: vi.fn(),
  transaction: vi.fn(),
  getMotorcycleRoute: vi.fn()
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    fareRule: { findMany: mocks.fareRuleFindMany },
    landmark: { findMany: mocks.landmarkFindMany },
    landmarkFare: { findFirst: mocks.landmarkFareFindFirst },
    user: { findUnique: mocks.userFindUnique },
    rideRequest: {
      create: mocks.rideCreate,
      findMany: mocks.rideFindMany,
      findUnique: mocks.rideFindUnique,
      updateMany: mocks.rideUpdateMany
    },
    rideStatusHistory: { create: mocks.rideHistoryCreate },
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

async function accessToken(role: "CUSTOMER" | "RIDER" | "ADMIN") {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject("7b6bce6e-9d14-4b11-9f0e-0e8e9408e8e4")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

const route = {
  pickup: {
    latitude: 3.0200,
    longitude: 30.9100,
    description: "Arua Main Market"
  },
  destination: {
    latitude: 3.0300,
    longitude: 30.9200,
    description: "Arua Hill"
  }
};

describe("Motorcycle ride API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMotorcycleRoute.mockResolvedValue({
      distanceKm: 2.5,
      durationSeconds: 420,
      coordinates: [
        { latitude: route.pickup.latitude, longitude: route.pickup.longitude },
        { latitude: route.destination.latitude, longitude: route.destination.longitude }
      ],
      provider: "VALHALLA_MOTORCYCLE"
    });
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        rideRequest: {
          create: mocks.rideCreate,
          findUnique: mocks.rideFindUnique,
          updateMany: mocks.rideUpdateMany
        },
        rideStatusHistory: { create: mocks.rideHistoryCreate }
      })
    );
  });

  it("requires authentication to access ride endpoints", async () => {
    const response = await request(app).get("/api/v1/rides/available");
    expect(response.status).toBe(401);
  });

  it("prevents customers from viewing the rider request queue", async () => {
    const token = await accessToken("CUSTOMER");
    const response = await request(app)
      .get("/api/v1/rides/available")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(mocks.rideFindMany).not.toHaveBeenCalled();
  });

  it("calculates a fare using an active server-side distance rule", async () => {
    mocks.fareRuleFindMany.mockResolvedValue([
      { minDistanceKm: 0, maxDistanceKm: 3, fareUgx: 2500 }
    ]);
    const token = await accessToken("CUSTOMER");
    const response = await request(app)
      .post("/api/v1/rides/fare-quote")
      .set("Authorization", `Bearer ${token}`)
      .send(route);

    expect(response.status).toBe(200);
    expect(response.body.data.fareAmountUgx).toBe(2500);
    expect(response.body.data.fareBasis).toBe("DISTANCE_RULE");
    expect(response.body.data.distanceKm).toBe(2.5);
    expect(response.body.data.durationSeconds).toBe(420);
    expect(response.body.data.routingProvider).toBe("VALHALLA_MOTORCYCLE");
    expect(response.body.data.routeCoordinates).toHaveLength(2);
  });

  it("applies the UGX 1,000 minimum to a 0.9 km journey", async () => {
    mocks.fareRuleFindMany.mockResolvedValue([]);
    const token = await accessToken("CUSTOMER");
    mocks.getMotorcycleRoute.mockResolvedValueOnce({
      distanceKm: 0.9,
      durationSeconds: 180,
      coordinates: [
        { latitude: 3.0200, longitude: 30.9100 },
        { latitude: 3.0200, longitude: 30.9181 }
      ],
      provider: "VALHALLA_MOTORCYCLE"
    });
    const response = await request(app)
      .post("/api/v1/rides/fare-quote")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pickup: {
          latitude: 3.0200,
          longitude: 30.9100,
          description: "Hostel"
        },
        destination: {
          latitude: 3.0200,
          longitude: 30.9181,
          description: "Muni University"
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.data.distanceKm).toBeCloseTo(0.9, 1);
    expect(response.body.data.fareAmountUgx).toBe(1000);
    expect(response.body.data.fareBasis).toBe("DISTANCE_RULE");
  });

  it("calculates fares proportionally at UGX 500 per kilometre above the minimum", async () => {
    mocks.fareRuleFindMany.mockResolvedValue([]);
    const token = await accessToken("CUSTOMER");
    mocks.getMotorcycleRoute.mockResolvedValueOnce({
      distanceKm: 4,
      durationSeconds: 600,
      coordinates: [
        { latitude: 3.0200, longitude: 30.9100 },
        { latitude: 3.0200, longitude: 30.9460 }
      ],
      provider: "VALHALLA_MOTORCYCLE"
    });
    const response = await request(app)
      .post("/api/v1/rides/fare-quote")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pickup: route.pickup,
        destination: {
          latitude: 3.0200,
          longitude: 30.9460,
          description: "Four kilometres away"
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.data.distanceKm).toBeCloseTo(4, 1);
    expect(response.body.data.fareAmountUgx).toBe(2000);
  });

  it("does not quote journeys beyond the pilot tariff coverage", async () => {
    mocks.fareRuleFindMany.mockResolvedValue([]);
    const token = await accessToken("CUSTOMER");
    mocks.getMotorcycleRoute.mockResolvedValueOnce({
      distanceKm: 31,
      durationSeconds: 4000,
      coordinates: [
        { latitude: 3.0200, longitude: 30.9100 },
        { latitude: 3.3000, longitude: 30.9100 }
      ],
      provider: "VALHALLA_MOTORCYCLE"
    });
    const response = await request(app)
      .post("/api/v1/rides/fare-quote")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pickup: route.pickup,
        destination: {
          latitude: 3.3000,
          longitude: 30.9100,
          description: "31 km road journey within pilot map bounds"
        }
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("FARE_NOT_CONFIGURED");
  });

  it("rejects identical pickup and destination points", async () => {
    const token = await accessToken("CUSTOMER");
    const response = await request(app)
      .post("/api/v1/rides/fare-quote")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pickup: route.pickup,
        destination: route.pickup
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(mocks.fareRuleFindMany).not.toHaveBeenCalled();
  });
});
