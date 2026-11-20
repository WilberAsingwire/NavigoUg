import { createHmac, timingSafeEqual } from "node:crypto";
import type { RideFareQuoteInput } from "@navigo/shared";
import type { RouteCoordinate } from "./routing.service.js";

export type SignedRideFare = {
  distanceKm: number;
  fareAmountUgx: number;
  fareBasis: "LANDMARK_FARE" | "DISTANCE_RULE";
  durationSeconds: number;
  routeCoordinates: RouteCoordinate[];
  routingProvider: "GOOGLE_TWO_WHEELER" | "VALHALLA_MOTORCYCLE";
};

type NormalizedLocation = {
  latitude: number;
  longitude: number;
  description: string;
  landmarkId: string | null;
};

type RideQuotePayload = {
  version: 1;
  customerId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  pickup: NormalizedLocation;
  destination: NormalizedLocation;
  fare: SignedRideFare;
};

export class RideQuoteTokenError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RideQuoteTokenError";
  }
}

export const RIDE_QUOTE_TTL_MS = 5 * 60 * 1000;
const MAX_QUOTE_TOKEN_LENGTH = 60_000;
const MAX_ROUTE_COORDINATES = 500;

function signingKey(): Buffer {
  const accessSecret = process.env.JWT_ACCESS_SECRET ?? "";
  if (Buffer.byteLength(accessSecret, "utf8") < 32) {
    throw new RideQuoteTokenError(
      503,
      "QUOTE_SIGNING_UNAVAILABLE",
      "NAVIGO could not securely prepare this fare quote. Please try again."
    );
  }

  // Domain separation prevents quote signatures from being interchangeable
  // with access-token signatures, while avoiding a new production secret.
  return createHmac("sha256", accessSecret)
    .update("NAVIGO_RIDE_QUOTE_V1")
    .digest();
}

function signature(payloadPart: string): Buffer {
  return createHmac("sha256", signingKey()).update(payloadPart).digest();
}

function normalizeLocation(location: RideFareQuoteInput["pickup"]): NormalizedLocation {
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    description: location.description,
    landmarkId: location.landmarkId ?? null
  };
}

function isValidFare(value: unknown): value is SignedRideFare {
  if (typeof value !== "object" || value === null) return false;
  const fare = value as Partial<SignedRideFare>;
  return (
    Number.isFinite(fare.distanceKm) &&
    Number(fare.distanceKm) > 0 &&
    Number.isInteger(fare.fareAmountUgx) &&
    Number(fare.fareAmountUgx) >= 500 &&
    (fare.fareBasis === "LANDMARK_FARE" || fare.fareBasis === "DISTANCE_RULE") &&
    Number.isFinite(fare.durationSeconds) &&
    Number(fare.durationSeconds) > 0 &&
    (fare.routingProvider === "GOOGLE_TWO_WHEELER" || fare.routingProvider === "VALHALLA_MOTORCYCLE") &&
    Array.isArray(fare.routeCoordinates) &&
    fare.routeCoordinates.length >= 2 &&
    fare.routeCoordinates.length <= MAX_ROUTE_COORDINATES &&
    fare.routeCoordinates.every((point) =>
      typeof point === "object" &&
      point !== null &&
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      point.latitude >= -90 &&
      point.latitude <= 90 &&
      point.longitude >= -180 &&
      point.longitude <= 180
    )
  );
}

function isNormalizedLocation(value: unknown): value is NormalizedLocation {
  if (typeof value !== "object" || value === null) return false;
  const location = value as Partial<NormalizedLocation>;
  return (
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) &&
    typeof location.description === "string" &&
    (location.landmarkId === null || typeof location.landmarkId === "string")
  );
}

function isRideQuotePayload(value: unknown): value is RideQuotePayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<RideQuotePayload>;
  return (
    payload.version === 1 &&
    typeof payload.customerId === "string" &&
    Number.isFinite(payload.issuedAtMs) &&
    Number.isFinite(payload.expiresAtMs) &&
    isNormalizedLocation(payload.pickup) &&
    isNormalizedLocation(payload.destination) &&
    isValidFare(payload.fare)
  );
}

function sameLocation(left: NormalizedLocation, right: NormalizedLocation): boolean {
  return (
    left.latitude === right.latitude &&
    left.longitude === right.longitude &&
    left.description === right.description &&
    left.landmarkId === right.landmarkId
  );
}

/**
 * Signs the server-calculated fare and motorcycle route for one customer and
 * one exact pickup/destination pair. The token expires after five minutes.
 */
export function issueRideQuoteToken(
  customerId: string,
  input: RideFareQuoteInput,
  fare: SignedRideFare
): string {
  if (!isValidFare(fare)) {
    throw new RideQuoteTokenError(
      503,
      "INVALID_QUOTE_DATA",
      "NAVIGO could not prepare a complete fare quote. Please calculate the route again."
    );
  }

  const issuedAtMs = Date.now();
  const payload: RideQuotePayload = {
    version: 1,
    customerId,
    issuedAtMs,
    expiresAtMs: issuedAtMs + RIDE_QUOTE_TTL_MS,
    pickup: normalizeLocation(input.pickup),
    destination: normalizeLocation(input.destination),
    fare
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadPart}.${signature(payloadPart).toString("base64url")}`;
}

/**
 * Verifies the quote signature, expiry, customer ownership, and exact
 * endpoints. A fare supplied by the mobile client is never trusted.
 */
export function verifyRideQuoteToken(
  customerId: string,
  input: RideFareQuoteInput,
  token: string
): SignedRideFare {
  if (typeof token !== "string" || token.length < 50 || token.length > MAX_QUOTE_TOKEN_LENGTH) {
    throw new RideQuoteTokenError(
      400,
      "INVALID_RIDE_QUOTE",
      "This fare quote is invalid. Please calculate the route again."
    );
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new RideQuoteTokenError(
      400,
      "INVALID_RIDE_QUOTE",
      "This fare quote is invalid. Please calculate the route again."
    );
  }

  const [payloadPart, suppliedSignaturePart] = parts;
  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(suppliedSignaturePart, "base64url");
  } catch {
    throw new RideQuoteTokenError(400, "INVALID_RIDE_QUOTE", "This fare quote is invalid. Please calculate the route again.");
  }

  const expectedSignature = signature(payloadPart);
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new RideQuoteTokenError(
      400,
      "INVALID_RIDE_QUOTE",
      "This fare quote could not be verified. Please calculate the route again."
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new RideQuoteTokenError(400, "INVALID_RIDE_QUOTE", "This fare quote is invalid. Please calculate the route again.");
  }

  if (!isRideQuotePayload(decoded)) {
    throw new RideQuoteTokenError(400, "INVALID_RIDE_QUOTE", "This fare quote is incomplete. Please calculate the route again.");
  }

  if (decoded.customerId !== customerId) {
    throw new RideQuoteTokenError(
      403,
      "RIDE_QUOTE_CUSTOMER_MISMATCH",
      "This fare quote belongs to another account. Please calculate your own route."
    );
  }

  const now = Date.now();
  if (
    decoded.issuedAtMs > now + 30_000 ||
    decoded.expiresAtMs <= now ||
    decoded.expiresAtMs <= decoded.issuedAtMs ||
    decoded.expiresAtMs - decoded.issuedAtMs > RIDE_QUOTE_TTL_MS
  ) {
    throw new RideQuoteTokenError(
      409,
      "RIDE_QUOTE_EXPIRED",
      "Your fare quote has expired. Please calculate the route again before confirming."
    );
  }

  if (
    !sameLocation(decoded.pickup, normalizeLocation(input.pickup)) ||
    !sameLocation(decoded.destination, normalizeLocation(input.destination))
  ) {
    throw new RideQuoteTokenError(
      409,
      "RIDE_QUOTE_LOCATION_MISMATCH",
      "Your pickup or destination has changed. Please calculate the route again before confirming."
    );
  }

  return decoded.fare;
}
