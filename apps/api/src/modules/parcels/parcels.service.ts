import { randomInt } from "node:crypto";
import * as argon2 from "argon2";
import type {
  CreateParcelInput,
  ParcelFareQuoteInput,
  ParcelStatusAction
} from "@navigo/shared";
import { prisma } from "../../lib/prisma.js";
import { MotorcycleRoutingError, getMotorcycleRoute } from "../rides/routing.service.js";

const MAX_CODE_ATTEMPTS = 5;
const MAX_PARCEL_DISTANCE_KM = 30;

export class ParcelError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ParcelError";
  }
}

type ParcelFareQuote = {
  distanceKm: number;
  durationSeconds: number;
  fareAmountUgx: number;
  fareBasis: "DISTANCE_RULE" | "LANDMARK_FARE";
  routeCoordinates: { latitude: number; longitude: number }[];
  routingProvider: "GOOGLE_TWO_WHEELER" | "VALHALLA_MOTORCYCLE";
};

type ParcelWithSecrets = {
  pickupCodeHash: string;
  deliveryCodeHash: string;
  pickupCodeAttempts: number;
  deliveryCodeAttempts: number;
  pickupCodeLockedAt: Date | null;
  deliveryCodeLockedAt: Date | null;
};

function withoutVerificationSecrets<T extends ParcelWithSecrets>(parcel: T) {
  const {
    pickupCodeHash: _pickupCodeHash,
    deliveryCodeHash: _deliveryCodeHash,
    pickupCodeAttempts: _pickupCodeAttempts,
    deliveryCodeAttempts: _deliveryCodeAttempts,
    pickupCodeLockedAt: _pickupCodeLockedAt,
    deliveryCodeLockedAt: _deliveryCodeLockedAt,
    ...safeParcel
  } = parcel;
  return safeParcel;
}

function parcelInclude() {
  return {
    sender: { select: { id: true, fullName: true, phone: true } },
    rider: {
      select: {
        id: true,
        fullName: true,
        phone: true,
        riderProfile: {
          select: {
            motorcyclePlate: true,
            motorcycleDescription: true,
            approvalStatus: true
          }
        }
      }
    },
    payment: true,
    history: { orderBy: { createdAt: "asc" as const } }
  } as const;
}

function generateVerificationCode(): string {
  return randomInt(100000, 1000000).toString();
}

async function calculateParcelFare(input: ParcelFareQuoteInput): Promise<ParcelFareQuote> {
  let route;
  try {
    route = await getMotorcycleRoute(input.pickup, input.destination);
  } catch (error) {
    if (error instanceof MotorcycleRoutingError) {
      throw new ParcelError(error.statusCode, error.code, error.message);
    }
    throw new ParcelError(
      503,
      "ROUTE_PROVIDER_UNAVAILABLE",
      "NAVIGO could not calculate a motorcycle road route for this parcel. Please try again."
    );
  }

  const distanceKm = Math.round(route.distanceKm * 100) / 100;
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    throw new ParcelError(400, "INVALID_ROUTE", "Choose two different pickup and destination locations.");
  }
  if (distanceKm > MAX_PARCEL_DISTANCE_KM) {
    throw new ParcelError(
      422,
      "PARCEL_DISTANCE_LIMIT",
      `Parcel deliveries currently support road journeys up to ${MAX_PARCEL_DISTANCE_KM} km in the Arua pilot area.`
    );
  }

  const rules = await prisma.fareRule.findMany({
    where: {
      requestType: "PARCEL",
      parcelSize: input.sizeCategory,
      isActive: true
    },
    orderBy: { minDistanceKm: "desc" },
    select: {
      minDistanceKm: true,
      maxDistanceKm: true,
      fareUgx: true
    }
  });

  const matchedRule = rules.find((rule) => {
    const minimum = Number(rule.minDistanceKm);
    const maximum = rule.maxDistanceKm === null ? null : Number(rule.maxDistanceKm);
    return distanceKm >= minimum && (maximum === null || distanceKm <= maximum);
  });

  if (!matchedRule) {
    throw new ParcelError(
      422,
      "PARCEL_FARE_NOT_CONFIGURED",
      `NAVIGO has not configured a ${input.sizeCategory.toLowerCase()} parcel fare for this distance yet. Please contact NAVIGO support.`
    );
  }

  return {
    distanceKm,
    durationSeconds: route.durationSeconds,
    fareAmountUgx: matchedRule.fareUgx,
    fareBasis: "DISTANCE_RULE",
    routeCoordinates: route.coordinates,
    routingProvider: route.provider
  };
}

export async function getParcelFareQuote(input: ParcelFareQuoteInput) {
  return calculateParcelFare(input);
}

export async function createParcel(senderId: string, input: CreateParcelInput) {
  const fare = await calculateParcelFare(input);
  const pickupCode = generateVerificationCode();
  const deliveryCode = generateVerificationCode();
  const [pickupCodeHash, deliveryCodeHash] = await Promise.all([
    argon2.hash(pickupCode, { type: argon2.argon2id }),
    argon2.hash(deliveryCode, { type: argon2.argon2id })
  ]);

  const created = await prisma.$transaction(async (tx) => {
    const parcel = await tx.parcelRequest.create({
      data: {
        senderId,
        recipientName: input.recipientName,
        recipientPhone: input.recipientPhone,
        parcelDescription: input.parcelDescription,
        sizeCategory: input.sizeCategory,
        status: "PENDING",
        pickupLatitude: input.pickup.latitude,
        pickupLongitude: input.pickup.longitude,
        pickupLandmarkId: input.pickup.landmarkId,
        pickupDescription: input.pickup.description,
        destinationLatitude: input.destination.latitude,
        destinationLongitude: input.destination.longitude,
        destinationLandmarkId: input.destination.landmarkId,
        destinationDescription: input.destination.description,
        fareAmountUgx: fare.fareAmountUgx,
        fareBasis: fare.fareBasis,
        estimatedDistanceKm: fare.distanceKm,
        pickupCodeHash,
        deliveryCodeHash,
        payment: {
          create: {
            method: input.paymentMethod,
            status: "UNPAID",
            amountUgx: fare.fareAmountUgx
          }
        }
      },
      include: { payment: true }
    });

    await tx.parcelStatusHistory.create({
      data: {
        parcelRequestId: parcel.id,
        fromStatus: null,
        toStatus: "PENDING",
        changedById: senderId,
        note: "Parcel delivery request created"
      }
    });
    await tx.notification.create({
      data: {
        userId: senderId,
        title: "Item delivery request received",
        body: "Your item delivery request has been created. We will update you when a rider accepts it.",
        requestType: "PARCEL",
        requestId: parcel.id
      }
    });

    return parcel;
  });

  // Verification codes are returned once to the sender at creation only.
  // Only Argon2 hashes are persisted; list and rider endpoints never expose them.
  return {
    ...withoutVerificationSecrets(created),
    pickupCode,
    deliveryCode,
    estimatedDistanceKm: fare.distanceKm,
    estimatedDurationSeconds: fare.durationSeconds,
    routeCoordinates: fare.routeCoordinates,
    routingProvider: fare.routingProvider
  };
}

export async function listSenderParcels(senderId: string) {
  const parcels = await prisma.parcelRequest.findMany({
    where: { senderId },
    orderBy: { createdAt: "desc" },
    include: parcelInclude()
  });
  return parcels.map(withoutVerificationSecrets);
}

export async function listRiderParcels(riderId: string) {
  const parcels = await prisma.parcelRequest.findMany({
    where: { riderId },
    orderBy: { createdAt: "desc" },
    include: parcelInclude()
  });
  return parcels.map(withoutVerificationSecrets);
}

async function assertApprovedRider(riderId: string): Promise<void> {
  const rider = await prisma.user.findUnique({
    where: { id: riderId },
    select: {
      isActive: true,
      riderProfile: { select: { approvalStatus: true } }
    }
  });

  if (!rider || !rider.isActive || rider.riderProfile?.approvalStatus !== "APPROVED") {
    throw new ParcelError(
      403,
      "RIDER_NOT_APPROVED",
      "Your rider account must be active and approved before handling parcel deliveries."
    );
  }
}

export async function listAvailableParcels(riderId: string) {
  await assertApprovedRider(riderId);
  const parcels = await prisma.parcelRequest.findMany({
    where: {
      status: "PENDING",
      riderId: null,
      rejections: { none: { riderId } }
    },
    orderBy: { createdAt: "asc" },
    include: {
      sender: { select: { fullName: true } }
    }
  });
  return parcels.map((parcel) => ({
    ...withoutVerificationSecrets(parcel),
    pickupLatitude: undefined,
    pickupLongitude: undefined,
    pickupLandmarkId: undefined,
    destinationLatitude: undefined,
    destinationLongitude: undefined,
    destinationLandmarkId: undefined,
    pickupDescription: "Pickup details shared after acceptance",
    destinationDescription: "Destination details shared after acceptance"
  }));
}

export async function acceptParcel(riderId: string, parcelId: string) {
  await assertApprovedRider(riderId);

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.parcelRequest.updateMany({
      where: { id: parcelId, status: "PENDING", riderId: null },
      data: { riderId, status: "ACCEPTED", acceptedAt: new Date() }
    });

    if (claimed.count !== 1) {
      throw new ParcelError(
        409,
        "PARCEL_ALREADY_ASSIGNED",
        "This parcel is no longer available. Refresh the list to see other deliveries."
      );
    }

    await tx.parcelStatusHistory.create({
      data: {
        parcelRequestId: parcelId,
        fromStatus: "PENDING",
        toStatus: "ACCEPTED",
        changedById: riderId,
        note: "Parcel accepted by an approved rider"
      }
    });

    const parcel = await tx.parcelRequest.findUnique({
      where: { id: parcelId },
      include: parcelInclude()
    });
    if (!parcel) {
      throw new ParcelError(404, "PARCEL_NOT_FOUND", "The parcel request could not be found.");
    }
    await tx.notification.create({
      data: {
        userId: parcel.senderId,
        title: "Your delivery has been accepted",
        body: "A NAVIGO rider has accepted your item delivery request.",
        requestType: "PARCEL",
        requestId: parcel.id
      }
    });
    return withoutVerificationSecrets(parcel);
  });
}

async function updateAssignedParcel(
  riderId: string,
  parcelId: string,
  nextStatus: ParcelStatusAction
) {
  const parcel = await prisma.parcelRequest.findUnique({ where: { id: parcelId } });
  if (!parcel || parcel.riderId !== riderId) {
    throw new ParcelError(404, "PARCEL_NOT_FOUND", "The assigned parcel could not be found.");
  }

  const transitions: Record<string, ParcelStatusAction> = {
    ACCEPTED: "ARRIVED_AT_PICKUP",
    COLLECTED: "IN_TRANSIT",
    IN_TRANSIT: "ARRIVED_AT_DESTINATION"
  };
  if (transitions[parcel.status] !== nextStatus) {
    throw new ParcelError(
      409,
      "INVALID_PARCEL_TRANSITION",
      "This parcel cannot move to that stage from its current status."
    );
  }

  const updates = { status: nextStatus };

  return prisma.$transaction(async (tx) => {
    const changed = await tx.parcelRequest.updateMany({
      where: { id: parcelId, riderId, status: parcel.status },
      data: updates
    });
    if (changed.count !== 1) {
      throw new ParcelError(409, "PARCEL_STATUS_CHANGED", "The parcel was updated elsewhere. Refresh and try again.");
    }

    await tx.parcelStatusHistory.create({
      data: {
        parcelRequestId: parcelId,
        fromStatus: parcel.status,
        toStatus: nextStatus,
        changedById: riderId
      }
    });

    const updated = await tx.parcelRequest.findUnique({
      where: { id: parcelId },
      include: parcelInclude()
    });
    return updated ? withoutVerificationSecrets(updated) : null;
  });
}

export async function updateParcelStatus(
  riderId: string,
  parcelId: string,
  nextStatus: ParcelStatusAction
) {
  await assertApprovedRider(riderId);
  return updateAssignedParcel(riderId, parcelId, nextStatus);
}

async function verifyParcelCode(
  riderId: string,
  parcelId: string,
  code: string,
  kind: "PICKUP" | "DELIVERY"
) {
  await assertApprovedRider(riderId);
  const parcel = await prisma.parcelRequest.findUnique({ where: { id: parcelId } });
  const expectedStatus = kind === "PICKUP" ? "ARRIVED_AT_PICKUP" : "ARRIVED_AT_DESTINATION";
  const hash = kind === "PICKUP" ? parcel?.pickupCodeHash : parcel?.deliveryCodeHash;
  const attempts = kind === "PICKUP" ? parcel?.pickupCodeAttempts : parcel?.deliveryCodeAttempts;
  const lockedAt = kind === "PICKUP" ? parcel?.pickupCodeLockedAt : parcel?.deliveryCodeLockedAt;

  if (!parcel || parcel.riderId !== riderId || parcel.status !== expectedStatus || !hash || attempts === undefined) {
    throw new ParcelError(409, "PARCEL_NOT_READY_FOR_VERIFICATION", "This parcel is not ready for that verification step.");
  }
  if (lockedAt || attempts >= MAX_CODE_ATTEMPTS) {
    throw new ParcelError(423, "PARCEL_CODE_LOCKED", "Too many incorrect attempts. Contact NAVIGO support to continue.");
  }

  const valid = await argon2.verify(hash, code);
  if (!valid) {
    const nextAttempts = attempts + 1;
    const locked = nextAttempts >= MAX_CODE_ATTEMPTS;
    await prisma.parcelRequest.updateMany({
      where: {
        id: parcelId,
        riderId,
        status: expectedStatus,
        ...(kind === "PICKUP"
          ? { pickupCodeAttempts: attempts, pickupCodeLockedAt: null }
          : { deliveryCodeAttempts: attempts, deliveryCodeLockedAt: null })
      },
      data: kind === "PICKUP"
        ? { pickupCodeAttempts: nextAttempts, ...(locked ? { pickupCodeLockedAt: new Date() } : {}) }
        : { deliveryCodeAttempts: nextAttempts, ...(locked ? { deliveryCodeLockedAt: new Date() } : {}) }
    });
    throw new ParcelError(
      locked ? 423 : 400,
      locked ? "PARCEL_CODE_LOCKED" : "INVALID_PARCEL_CODE",
      locked
        ? "Too many incorrect attempts. Contact NAVIGO support to continue."
        : `Incorrect ${kind.toLowerCase()} code. You have ${MAX_CODE_ATTEMPTS - nextAttempts} attempt(s) remaining.`
    );
  }

  const nextStatus = kind === "PICKUP" ? "COLLECTED" : "DELIVERED";
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const changed = await tx.parcelRequest.updateMany({
      where: {
        id: parcelId,
        riderId,
        status: expectedStatus,
        ...(kind === "PICKUP"
          ? { pickupCodeAttempts: attempts, pickupCodeLockedAt: null }
          : { deliveryCodeAttempts: attempts, deliveryCodeLockedAt: null })
      },
      data: kind === "PICKUP"
        ? { status: "COLLECTED", collectedAt: now }
        : { status: "DELIVERED", deliveredAt: now }
    });

    if (changed.count !== 1) {
      throw new ParcelError(409, "PARCEL_STATUS_CHANGED", "The parcel was updated elsewhere. Refresh and try again.");
    }

    if (kind === "DELIVERY") {
      await tx.parcelTrackingSession.updateMany({
        where: { parcelRequestId: parcelId },
        data: {
          riderSharingEnabled: false,
          endedAt: now,
          riderLatitude: null,
          riderLongitude: null,
          riderAccuracyMeters: null,
          riderLocationUpdatedAt: null
        }
      });
    }

    await tx.parcelStatusHistory.create({
      data: {
        parcelRequestId: parcelId,
        fromStatus: expectedStatus,
        toStatus: nextStatus,
        changedById: riderId,
        note: kind === "PICKUP" ? "Collection verified using sender code" : "Delivery verified using recipient code"
      }
    });

    const updated = await tx.parcelRequest.findUnique({
      where: { id: parcelId },
      include: parcelInclude()
    });
    return updated ? withoutVerificationSecrets(updated) : null;
  });
}

export async function verifyParcelPickup(riderId: string, parcelId: string, code: string) {
  return verifyParcelCode(riderId, parcelId, code, "PICKUP");
}

export async function verifyParcelDelivery(riderId: string, parcelId: string, code: string) {
  return verifyParcelCode(riderId, parcelId, code, "DELIVERY");
}


const ARUA_TRACKING_BOUNDS = { minLat: 2.75, maxLat: 3.30, minLon: 30.55, maxLon: 31.25 };
const ACTIVE_PARCEL_TRACKING_STATUSES = [
  "ACCEPTED",
  "ARRIVED_AT_PICKUP",
  "COLLECTED",
  "IN_TRANSIT",
  "ARRIVED_AT_DESTINATION"
] as const;

function validateTrackingPoint(latitude: number, longitude: number, accuracyMeters: number) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < ARUA_TRACKING_BOUNDS.minLat || latitude > ARUA_TRACKING_BOUNDS.maxLat ||
      longitude < ARUA_TRACKING_BOUNDS.minLon || longitude > ARUA_TRACKING_BOUNDS.maxLon ||
      !Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > 500) {
    throw new ParcelError(400, "INVALID_TRACKING_LOCATION", "A valid, reasonably accurate location inside the Arua pilot area is required.");
  }
}

export async function startParcelTracking(riderId: string, parcelId: string) {
  await assertApprovedRider(riderId);
  const parcel = await prisma.parcelRequest.findFirst({
    where: { id: parcelId, riderId, status: { in: [...ACTIVE_PARCEL_TRACKING_STATUSES] } },
    select: { id: true }
  });
  if (!parcel) throw new ParcelError(404, "ACTIVE_PARCEL_NOT_FOUND", "The assigned active item delivery was not found.");

  const now = new Date();
  return prisma.parcelTrackingSession.upsert({
    where: { parcelRequestId: parcelId },
    create: {
      parcelRequestId: parcelId,
      riderSharingEnabled: true,
      riderConsentAt: now,
      startedAt: now
    },
    update: {
      riderSharingEnabled: true,
      riderConsentAt: now,
      startedAt: now,
      endedAt: null,
      riderLatitude: null,
      riderLongitude: null,
      riderAccuracyMeters: null,
      riderLocationUpdatedAt: null
    },
    select: { riderSharingEnabled: true, riderConsentAt: true, startedAt: true }
  });
}

export async function updateParcelRiderLocation(
  riderId: string,
  parcelId: string,
  point: { latitude: number; longitude: number; accuracyMeters: number }
) {
  await assertApprovedRider(riderId);
  validateTrackingPoint(point.latitude, point.longitude, point.accuracyMeters);

  const parcel = await prisma.parcelRequest.findFirst({
    where: { id: parcelId, riderId, status: { in: [...ACTIVE_PARCEL_TRACKING_STATUSES] } },
    select: { id: true }
  });
  if (!parcel) throw new ParcelError(404, "ACTIVE_PARCEL_NOT_FOUND", "No active item delivery was found for this rider.");

  const tracking = await prisma.parcelTrackingSession.findUnique({
    where: { parcelRequestId: parcelId },
    select: { riderSharingEnabled: true, endedAt: true }
  });
  if (!tracking?.riderSharingEnabled || tracking.endedAt) {
    throw new ParcelError(403, "TRACKING_NOT_ENABLED", "Enable live location sharing before sending location updates.");
  }

  const now = new Date();
  return prisma.parcelTrackingSession.update({
    where: { parcelRequestId: parcelId },
    data: {
      riderLatitude: point.latitude,
      riderLongitude: point.longitude,
      riderAccuracyMeters: point.accuracyMeters,
      riderLocationUpdatedAt: now
    },
    select: { riderLocationUpdatedAt: true }
  });
}

export async function stopParcelTracking(riderId: string, parcelId: string) {
  await assertApprovedRider(riderId);
  const parcel = await prisma.parcelRequest.findFirst({
    where: { id: parcelId, riderId },
    select: { id: true }
  });
  if (!parcel) throw new ParcelError(404, "PARCEL_NOT_FOUND", "The assigned item delivery was not found.");

  return prisma.parcelTrackingSession.updateMany({
    where: { parcelRequestId: parcelId },
    data: {
      riderSharingEnabled: false,
      endedAt: new Date(),
      riderLatitude: null,
      riderLongitude: null,
      riderAccuracyMeters: null,
      riderLocationUpdatedAt: null
    }
  });
}

export async function getParcelTracking(senderId: string, parcelId: string) {
  const parcel = await prisma.parcelRequest.findFirst({
    where: { id: parcelId, senderId },
    select: {
      id: true,
      status: true,
      pickupLatitude: true,
      pickupLongitude: true,
      destinationLatitude: true,
      destinationLongitude: true,
      tracking: {
        select: {
          riderSharingEnabled: true,
          riderLatitude: true,
          riderLongitude: true,
          riderAccuracyMeters: true,
          riderLocationUpdatedAt: true,
          endedAt: true
        }
      }
    }
  });
  if (!parcel) throw new ParcelError(404, "PARCEL_NOT_FOUND", "The item delivery could not be found.");

  const tracking = parcel.tracking;
  const active = (ACTIVE_PARCEL_TRACKING_STATUSES as readonly string[]).includes(parcel.status);
  const fresh = Boolean(
    active &&
    tracking?.riderSharingEnabled &&
    !tracking.endedAt &&
    tracking.riderLocationUpdatedAt &&
    Date.now() - tracking.riderLocationUpdatedAt.getTime() <= 120_000
  );

  return {
    parcelId: parcel.id,
    status: parcel.status,
    pickup: { latitude: Number(parcel.pickupLatitude), longitude: Number(parcel.pickupLongitude) },
    destination: { latitude: Number(parcel.destinationLatitude), longitude: Number(parcel.destinationLongitude) },
    rider: fresh && tracking && tracking.riderLatitude !== null && tracking.riderLongitude !== null
      ? {
          latitude: Number(tracking.riderLatitude),
          longitude: Number(tracking.riderLongitude),
          accuracyMeters: tracking.riderAccuracyMeters,
          updatedAt: tracking.riderLocationUpdatedAt
        }
      : null,
    sharingEnabled: Boolean(active && tracking?.riderSharingEnabled && !tracking?.endedAt)
  };
}

export async function recordParcelPayment(
  riderId: string,
  parcelId: string,
  transactionReference?: string
) {
  return prisma.$transaction(async (tx) => {
    const parcel = await tx.parcelRequest.findUnique({
      where: { id: parcelId },
      include: { payment: true }
    });

    if (!parcel || parcel.riderId !== riderId) {
      throw new ParcelError(404, "PARCEL_NOT_FOUND", "The assigned item delivery could not be found.");
    }
    if (parcel.status !== "DELIVERED") {
      throw new ParcelError(409, "PAYMENT_NOT_ELIGIBLE", "An item-delivery payment can only be recorded after delivery is confirmed.");
    }
    if (!parcel.payment) {
      throw new ParcelError(409, "PAYMENT_RECORD_NOT_FOUND", "The payment record for this item delivery could not be found.");
    }
    if (parcel.payment.status !== "UNPAID") {
      throw new ParcelError(409, "PAYMENT_ALREADY_RECORDED", "This item-delivery payment has already been recorded.");
    }
    if (parcel.payment.method === "CASH" && transactionReference) {
      throw new ParcelError(400, "INVALID_PAYMENT_REFERENCE", "A transaction reference can only be supplied for Mobile Money payments.");
    }

    const recordedAt = new Date();
    const changed = await tx.parcelPayment.updateMany({
      where: { parcelRequestId: parcelId, status: "UNPAID" },
      data: {
        status: "PAID",
        recordedById: riderId,
        recordedAt,
        transactionReference: transactionReference ?? null
      }
    });

    if (changed.count !== 1) {
      throw new ParcelError(409, "PAYMENT_ALREADY_RECORDED", "This item-delivery payment was already recorded. Refresh to see its latest status.");
    }

    await tx.auditLog.create({
      data: {
        actorId: riderId,
        action: "PARCEL_PAYMENT_RECORDED",
        targetType: "PARCEL_PAYMENT",
        targetId: parcelId,
        metadata: {
          method: parcel.payment.method,
          amountUgx: parcel.payment.amountUgx,
          hasTransactionReference: Boolean(transactionReference)
        }
      }
    });

    const updated = await tx.parcelRequest.findUnique({
      where: { id: parcelId },
      include: parcelInclude()
    });
    if (!updated) {
      throw new ParcelError(404, "PARCEL_NOT_FOUND", "The item delivery could not be found.");
    }
    return withoutVerificationSecrets(updated);
  });
}

export async function cancelSenderParcel(senderId: string, parcelId: string) {
  const parcel = await prisma.parcelRequest.findUnique({ where: { id: parcelId } });
  if (!parcel || parcel.senderId !== senderId) {
    throw new ParcelError(404, "PARCEL_NOT_FOUND", "The parcel request could not be found.");
  }

  if (!["PENDING", "ACCEPTED", "ARRIVED_AT_PICKUP"].includes(parcel.status)) {
    throw new ParcelError(409, "PARCEL_CANNOT_BE_CANCELLED", "A parcel can only be cancelled before it has been collected.");
  }

  return prisma.$transaction(async (tx) => {
    const changed = await tx.parcelRequest.updateMany({
      where: { id: parcelId, senderId, status: parcel.status },
      data: { status: "CANCELLED", cancelledAt: new Date() }
    });
    if (changed.count !== 1) {
      throw new ParcelError(409, "PARCEL_STATUS_CHANGED", "The parcel was updated elsewhere. Refresh and try again.");
    }

    await tx.parcelTrackingSession.updateMany({
      where: { parcelRequestId: parcelId },
      data: {
        riderSharingEnabled: false,
        endedAt: new Date(),
        riderLatitude: null,
        riderLongitude: null,
        riderAccuracyMeters: null,
        riderLocationUpdatedAt: null
      }
    });

    await tx.parcelStatusHistory.create({
      data: {
        parcelRequestId: parcelId,
        fromStatus: parcel.status,
        toStatus: "CANCELLED",
        changedById: senderId,
        note: "Cancelled by sender before collection"
      }
    });

    const updated = await tx.parcelRequest.findUnique({
      where: { id: parcelId },
      include: parcelInclude()
    });
    return updated ? withoutVerificationSecrets(updated) : null;
  });
}

export function parcelErrorHandler(
  error: unknown,
  _request: import("express").Request,
  response: import("express").Response,
  next: import("express").NextFunction
) {
  if (error instanceof ParcelError) {
    response.status(error.statusCode).json({
      error: { code: error.code, message: error.message }
    });
    return;
  }
  next(error);
}
