import { afterEach, describe, expect, it } from "vitest";
import {
  issueRideQuoteToken,
  RIDE_QUOTE_TTL_MS,
  RideQuoteTokenError,
  verifyRideQuoteToken
} from "../src/modules/rides/ride-quote-token.service.js";

const previousSecret = process.env.JWT_ACCESS_SECRET;
const customerId = "7b6bce6e-9d14-4b11-9f0e-0e8e9408e8e4";
const routeInput = {
  pickup: {
    latitude: 3.02,
    longitude: 30.91,
    description: "Muni University"
  },
  destination: {
    latitude: 3.03,
    longitude: 30.92,
    description: "Arua Central Market"
  }
};
const fare = {
  distanceKm: 3.75,
  fareAmountUgx: 1900,
  fareBasis: "DISTANCE_RULE" as const,
  durationSeconds: 840,
  routeCoordinates: [
    { latitude: 3.02, longitude: 30.91 },
    { latitude: 3.025, longitude: 30.915 },
    { latitude: 3.03, longitude: 30.92 }
  ],
  routingProvider: "VALHALLA_MOTORCYCLE" as const
};

afterEach(() => {
  if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
  else process.env.JWT_ACCESS_SECRET = previousSecret;
});

describe("signed ride fare quotes", () => {
  it("issues a customer-bound quote that preserves the exact server-calculated fare and route", () => {
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    const token = issueRideQuoteToken(customerId, routeInput, fare);

    expect(verifyRideQuoteToken(customerId, routeInput, token)).toEqual(fare);
  });

  it("rejects a quote after its signature is changed", () => {
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    const token = issueRideQuoteToken(customerId, routeInput, fare);
    const [payloadPart, signaturePart] = token.split(".");
    const changedFirstSignatureCharacter = signaturePart?.[0] === "a" ? "b" : "a";
    const tampered = `${payloadPart}.${changedFirstSignatureCharacter}${signaturePart?.slice(1) ?? ""}`;

    expect(() => verifyRideQuoteToken(customerId, routeInput, tampered))
      .toThrowError(RideQuoteTokenError);
  });

  it("rejects a quote issued to another customer", () => {
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    const token = issueRideQuoteToken(customerId, routeInput, fare);

    expect(() => verifyRideQuoteToken("another-customer", routeInput, token))
      .toThrowError(/belongs to another account/);
  });

  it("rejects a quote when pickup or destination changes", () => {
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    const token = issueRideQuoteToken(customerId, routeInput, fare);

    expect(() => verifyRideQuoteToken(customerId, {
      ...routeInput,
      destination: { ...routeInput.destination, longitude: 30.93 }
    }, token)).toThrowError(/has changed/);
  });

  it("expires a quote after five minutes", () => {
    process.env.JWT_ACCESS_SECRET = "local-test-secret-that-is-long-enough-123456";
    const originalNow = Date.now;
    const start = originalNow();
    let now = start;
    Date.now = () => now;
    try {
      const token = issueRideQuoteToken(customerId, routeInput, fare);
      now += RIDE_QUOTE_TTL_MS + 1;
      expect(() => verifyRideQuoteToken(customerId, routeInput, token))
        .toThrowError(/has expired/);
    } finally {
      Date.now = originalNow;
    }
  });
});
