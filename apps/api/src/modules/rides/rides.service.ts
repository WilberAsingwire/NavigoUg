import type { CreateRideInput, RideFareQuoteInput } from "@navigo/shared";
import { prisma } from "../../lib/prisma.js";
import { RIDE_DISTANCE_TARIFF } from "./fare-rules.js";
import { getMotorcycleRoute, MotorcycleRoutingError } from "./routing.service.js";
import {
  issueRideQuoteToken,
  RideQuoteTokenError,
  verifyRideQuoteToken
} from "./ride-quote-token.service.js";

const EARTH_RADIUS_KM = 6371.0088;
const ARUA_LOCATION_BOUNDS = { minLatitude: 2.75, maxLatitude: 3.30, minLongitude: 30.55, maxLongitude: 31.25 };
const MAX_RIDER_LOCATION_ACCURACY_METERS = 500;
const LOCATION_STALE_AFTER_MS = Math.max(15, Number(process.env.LOCATION_STALE_AFTER_SECONDS ?? 45)) * 1000;

type RiderLocationPoint = { latitude: number; longitude: number; accuracyMeters: number };

function validateRiderLocation(point: RiderLocationPoint): void {
  if (
    !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
    point.latitude < ARUA_LOCATION_BOUNDS.minLatitude || point.latitude > ARUA_LOCATION_BOUNDS.maxLatitude ||
    point.longitude < ARUA_LOCATION_BOUNDS.minLongitude || point.longitude > ARUA_LOCATION_BOUNDS.maxLongitude ||
    !Number.isFinite(point.accuracyMeters) || point.accuracyMeters < 0 ||
    point.accuracyMeters > MAX_RIDER_LOCATION_ACCURACY_METERS
  ) {
    throw new RideError(400, "INVALID_RIDER_LOCATION", "A valid, reasonably accurate GPS location inside the Arua pilot area is required.");
  }
}

function isFreshAvailability(availability: { isOnline: boolean; lastSeenAt: Date | null; latitude: unknown; longitude: unknown; accuracyMeters: number | null } | null): boolean {
  return Boolean(
    availability?.isOnline && availability.lastSeenAt &&
    Date.now() - availability.lastSeenAt.getTime() <= LOCATION_STALE_AFTER_MS &&
    availability.latitude !== null && availability.longitude !== null &&
    availability.accuracyMeters !== null && availability.accuracyMeters <= MAX_RIDER_LOCATION_ACCURACY_METERS
  );
}

function dispatchRadiusKm(createdAt: Date, now = Date.now()): number {
  const ageSeconds = Math.max(0, (now - createdAt.getTime()) / 1000);
  if (ageSeconds < 60) return 5;
  if (ageSeconds < 120) return 8;
  return 12;
}

export class RideError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RideError";
  }
}

function radians(value: number): number {
  return value * (Math.PI / 180);
}

export function calculateStraightLineDistanceKm(
  pickup: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number }
): number {
  const latitudeDelta = radians(destination.latitude - pickup.latitude);
  const longitudeDelta = radians(destination.longitude - pickup.longitude);
  const pickupLatitude = radians(pickup.latitude);
  const destinationLatitude = radians(destination.latitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(pickupLatitude) *
      Math.cos(destinationLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, a)));
}

type FareQuote = {
  distanceKm: number;
  fareAmountUgx: number;
  fareBasis: "LANDMARK_FARE" | "DISTANCE_RULE";
  durationSeconds: number;
  routeCoordinates: { latitude: number; longitude: number }[];
  routingProvider: "GOOGLE_TWO_WHEELER" | "VALHALLA_MOTORCYCLE";
};

async function calculateFare(input: RideFareQuoteInput): Promise<FareQuote> {
  const directDistance = calculateStraightLineDistanceKm(input.pickup, input.destination);
  if (!Number.isFinite(directDistance) || directDistance < 0.05) {
    throw new RideError(400, "INVALID_ROUTE", "Choose two different pickup and destination points.");
  }

  let roadRoute;
  try {
    roadRoute = await getMotorcycleRoute(input.pickup, input.destination);
  } catch (error) {
    if (error instanceof MotorcycleRoutingError) {
      throw new RideError(error.statusCode, error.code, error.message);
    }
    throw new RideError(
      503,
      "ROUTE_PROVIDER_UNAVAILABLE",
      "NAVIGO could not calculate a motorcycle road route. Please try again."
    );
  }

  const roundedDistance = Math.round(roadRoute.distanceKm * 100) / 100;

  if (input.pickup.landmarkId || input.destination.landmarkId) {
    if (!input.pickup.landmarkId || !input.destination.landmarkId) {
      throw new RideError(400, "INVALID_LANDMARK_PAIR", "Select both pickup and destination landmarks, or use map locations for both.");
    }

    const landmarks = await prisma.landmark.findMany({
      where: {
        id: { in: [input.pickup.landmarkId, input.destination.landmarkId] },
        isActive: true
      },
      select: { id: true }
    });

    if (landmarks.length !== 2) {
      throw new RideError(400, "LANDMARK_UNAVAILABLE", "One of the selected landmarks is no longer available.");
    }

    const landmarkFare = await prisma.landmarkFare.findFirst({
      where: {
        fromLandmarkId: input.pickup.landmarkId,
        toLandmarkId: input.destination.landmarkId,
        requestType: "RIDE",
        parcelSize: null,
        isActive: true
      },
      select: { fareUgx: true }
    });

    if (landmarkFare) {
      return {
        distanceKm: roundedDistance,
        fareAmountUgx: landmarkFare.fareUgx,
        fareBasis: "LANDMARK_FARE",
        durationSeconds: roadRoute.durationSeconds,
        routeCoordinates: roadRoute.coordinates,
        routingProvider: roadRoute.provider
      };
    }
  }

  // Match using the same 2-decimal road distance shown to the customer.
  const rules = await prisma.fareRule.findMany({
    where: { requestType: "RIDE", parcelSize: null, isActive: true },
    orderBy: { minDistanceKm: "desc" },
    select: { minDistanceKm: true, maxDistanceKm: true, fareUgx: true }
  });

  const matchedRule = rules.find((rule) => {
    const minimum = Number(rule.minDistanceKm);
    const maximum = rule.maxDistanceKm === null ? null : Number(rule.maxDistanceKm);
    return roundedDistance >= minimum && (maximum === null || roundedDistance <= maximum);
  });

  // Administrator-configured distance rules take priority. Otherwise,
  // calculate a proportional per-kilometre fare with a UGX 1,000 floor.
  const fallbackFare = roundedDistance <= RIDE_DISTANCE_TARIFF.maximumDistanceKm
    ? Math.max(
        RIDE_DISTANCE_TARIFF.minimumFareUgx,
        Math.ceil(
          (roundedDistance * RIDE_DISTANCE_TARIFF.farePerKmUgx) /
            RIDE_DISTANCE_TARIFF.roundingStepUgx
        ) * RIDE_DISTANCE_TARIFF.roundingStepUgx
      )
    : undefined;
  const selectedFare = matchedRule?.fareUgx ?? fallbackFare;

  if (selectedFare === undefined) {
    throw new RideError(
      422,
      "FARE_NOT_CONFIGURED",
      `NAVIGO's current Arua pilot tariff covers journeys up to ${RIDE_DISTANCE_TARIFF.maximumDistanceKm} km. Please choose a nearer destination.`
    );
  }

  return {
    distanceKm: roundedDistance,
    fareAmountUgx: selectedFare,
    fareBasis: "DISTANCE_RULE",
    durationSeconds: roadRoute.durationSeconds,
    routeCoordinates: roadRoute.coordinates,
    routingProvider: roadRoute.provider
  };
}

export async function getRideFareQuote(customerId: string, input: RideFareQuoteInput) {
  const fare = await calculateFare(input);
  try {
    return {
      ...fare,
      quoteToken: issueRideQuoteToken(customerId, input, fare)
    };
  } catch (error) {
    if (error instanceof RideQuoteTokenError) {
      throw new RideError(error.statusCode, error.code, error.message);
    }
    throw error;
  }
}

function rideInclude() {
  return {
    customer: { select: { id: true, fullName: true, phone: true } },
    rider: {
      select: {
        id: true,
        fullName: true,
        phone: true,
        riderProfile: {
          select: { motorcyclePlate: true, motorcycleDescription: true, approvalStatus: true }
        }
      }
    },
    payment: true
  } as const;
}

export async function createRide(customerId: string, input: CreateRideInput) {
  let fare: FareQuote;
  if (input.quoteToken) {
    try {
      // New clients book the exact server-signed quote they reviewed. Older
      // installed clients may omit this optional field during OTA rollout;
      // those requests retain the previous server-side recalculation path.
      fare = verifyRideQuoteToken(customerId, input, input.quoteToken);
    } catch (error) {
      if (error instanceof RideQuoteTokenError) {
        throw new RideError(error.statusCode, error.code, error.message);
      }
      throw error;
    }
  } else {
    fare = await calculateFare(input);
  }
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const ride = await tx.rideRequest.create({
      data: {
        customerId,
        pickupLatitude: input.pickup.latitude,
        pickupLongitude: input.pickup.longitude,
        pickupDescription: input.pickup.description,
        pickupLandmarkId: input.pickup.landmarkId,
        destinationLatitude: input.destination.latitude,
        destinationLongitude: input.destination.longitude,
        destinationDescription: input.destination.description,
        destinationLandmarkId: input.destination.landmarkId,
        fareAmountUgx: fare.fareAmountUgx,
        fareBasis: fare.fareBasis,
        estimatedDistanceKm: fare.distanceKm,
        status: "PENDING",
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

    await tx.rideStatusHistory.create({
      data: {
        rideRequestId: ride.id,
        fromStatus: null,
        toStatus: "PENDING",
        changedById: customerId,
        note: "Ride request created"
      }
    });
    await tx.notification.create({
      data: {
        userId: customerId,
        title: "Ride request received",
        body: "Your ride request has been created. We will update you when a rider accepts it.",
        requestType: "RIDE",
        requestId: ride.id
      }
    });

    return { ...ride, estimatedDistanceKm: fare.distanceKm };
  });
}

export async function listCustomerRides(userId: string) {
  const rides = await prisma.rideRequest.findMany({
    where: { customerId: userId },
    orderBy: { createdAt: "desc" },
    include: rideInclude()
  });
  const acceptedRideIds = rides.filter((ride) => ride.status === "ACCEPTED").map((ride) => ride.id);
  if (!acceptedRideIds.length) return rides;
  try {
    const estimates = await prisma.rideArrivalEstimate.findMany({
      where: { rideRequestId: { in: acceptedRideIds } },
      select: { rideRequestId: true, riderArrivalEstimateMinutes: true, calculatedAt: true }
    });
    const byRideId = new Map(estimates.map((estimate) => [estimate.rideRequestId, estimate]));
    return rides.map((ride) => {
      const estimate = byRideId.get(ride.id);
      return {
        ...ride,
        riderArrivalEstimateMinutes: estimate?.riderArrivalEstimateMinutes ?? null,
        riderArrivalEstimateUpdatedAt: estimate?.calculatedAt ?? null
      };
    });
  } catch {
    // Ride history must remain available even before the optional ETA table is synced.
    return rides;
  }
}

export async function listRiderRides(userId: string) {
  return prisma.rideRequest.findMany({
    where: { riderId: userId },
    orderBy: { createdAt: "desc" },
    include: rideInclude()
  });
}

async function assertApprovedRider(riderId: string, action: string): Promise<void> {
  const rider = await prisma.user.findUnique({
    where: { id: riderId },
    select: { isActive: true, riderProfile: { select: { approvalStatus: true } } }
  });
  if (!rider || !rider.isActive || rider.riderProfile?.approvalStatus !== "APPROVED") {
    throw new RideError(403, "RIDER_NOT_APPROVED", `Your rider account must be active and approved before ${action}.`);
  }
}

export async function setRiderOnline(riderId: string, point: RiderLocationPoint) {
  await assertApprovedRider(riderId, "going online");
  validateRiderLocation(point);
  const now = new Date();
  return prisma.riderAvailability.upsert({
    where: { riderId },
    create: { riderId, isOnline: true, latitude: point.latitude, longitude: point.longitude, accuracyMeters: point.accuracyMeters, lastSeenAt: now },
    update: { isOnline: true, latitude: point.latitude, longitude: point.longitude, accuracyMeters: point.accuracyMeters, lastSeenAt: now },
    select: { isOnline: true, lastSeenAt: true }
  });
}

export async function updateRiderAvailabilityLocation(riderId: string, point: RiderLocationPoint) {
  await assertApprovedRider(riderId, "sharing availability");
  validateRiderLocation(point);
  const current = await prisma.riderAvailability.findUnique({ where: { riderId } });
  if (!current?.isOnline) throw new RideError(409, "RIDER_NOT_ONLINE", "Go online before updating your rider location.");
  const now = new Date();
  return prisma.riderAvailability.update({
    where: { riderId },
    data: { latitude: point.latitude, longitude: point.longitude, accuracyMeters: point.accuracyMeters, lastSeenAt: now },
    select: { isOnline: true, lastSeenAt: true }
  });
}

export async function setRiderOffline(riderId: string) {
  await prisma.riderAvailability.upsert({
    where: { riderId },
    create: { riderId, isOnline: false },
    update: { isOnline: false, latitude: null, longitude: null, accuracyMeters: null, lastSeenAt: null }
  });
  return { isOnline: false };
}

export async function listAvailableRides(riderId: string) {
  await assertApprovedRider(riderId, "viewing available rides");
  const availability = await prisma.riderAvailability.findUnique({
    where: { riderId },
    select: { isOnline: true, latitude: true, longitude: true, accuracyMeters: true, lastSeenAt: true }
  });
  if (!isFreshAvailability(availability)) return [];

  const rides = await prisma.rideRequest.findMany({
    where: { status: "PENDING", riderId: null, rejections: { none: { riderId } } },
    orderBy: { createdAt: "asc" },
    include: { customer: { select: { fullName: true } } }
  });
  const riderPoint = { latitude: Number(availability!.latitude), longitude: Number(availability!.longitude) };
  return rides.flatMap((ride) => {
    const pickupDistanceKm = calculateStraightLineDistanceKm(riderPoint, {
      latitude: Number(ride.pickupLatitude), longitude: Number(ride.pickupLongitude)
    });
    return pickupDistanceKm <= dispatchRadiusKm(ride.createdAt)
      ? [{ ...ride, pickupDistanceKm: Math.round(pickupDistanceKm * 100) / 100 }]
      : [];
  }).sort((a, b) => a.pickupDistanceKm - b.pickupDistanceKm);
}

export async function acceptRide(riderId: string, rideId: string) {
  await assertApprovedRider(riderId, "accepting rides");
  const availability = await prisma.riderAvailability.findUnique({
    where: { riderId },
    select: { isOnline: true, latitude: true, longitude: true, accuracyMeters: true, lastSeenAt: true }
  });
  if (!isFreshAvailability(availability)) {
    throw new RideError(403, "RIDER_NOT_ONLINE", "Go online and allow fresh location updates before accepting a ride.");
  }
  const rideRequest = await prisma.rideRequest.findFirst({
    where: { id: rideId, status: "PENDING", riderId: null },
    select: { id: true, pickupLatitude: true, pickupLongitude: true, createdAt: true }
  });
  if (!rideRequest) throw new RideError(409, "RIDE_ALREADY_ASSIGNED", "This ride is no longer available. Refresh the list to see other requests.");

  const riderPoint = { latitude: Number(availability!.latitude), longitude: Number(availability!.longitude) };
  const pickupPoint = { latitude: Number(rideRequest.pickupLatitude), longitude: Number(rideRequest.pickupLongitude) };
  const pickupDistanceKm = calculateStraightLineDistanceKm(riderPoint, pickupPoint);
  if (pickupDistanceKm > dispatchRadiusKm(rideRequest.createdAt)) {
    throw new RideError(403, "RIDE_OUTSIDE_MATCHING_AREA", "This ride is outside your current matching area. Refresh to see nearby requests.");
  }

  let riderArrivalEstimateMinutes: number | null = null;
  try {
    const arrivalRoute = await getMotorcycleRoute(riderPoint, pickupPoint);
    riderArrivalEstimateMinutes = Math.max(1, Math.ceil(arrivalRoute.durationSeconds / 60));
  } catch {
    // A rider can still accept if routing is unavailable; the customer will not see an invented ETA.
  }

  return prisma.$transaction(async (tx) => {
    const acceptedAt = new Date();
    const claimed = await tx.rideRequest.updateMany({
      where: { id: rideId, status: "PENDING", riderId: null },
      data: { riderId, status: "ACCEPTED", acceptedAt }
    });

    if (claimed.count !== 1) {
      throw new RideError(409, "RIDE_ALREADY_ASSIGNED", "This ride is no longer available. Refresh the list to see other requests.");
    }

    if (riderArrivalEstimateMinutes !== null) {
      await tx.rideArrivalEstimate.upsert({
        where: { rideRequestId: rideId },
        create: { rideRequestId: rideId, riderArrivalEstimateMinutes, calculatedAt: acceptedAt },
        update: { riderArrivalEstimateMinutes, calculatedAt: acceptedAt }
      });
    }

    await tx.rideStatusHistory.create({
      data: {
        rideRequestId: rideId,
        fromStatus: "PENDING",
        toStatus: "ACCEPTED",
        changedById: riderId,
        note: "Ride accepted by an approved rider"
      }
    });

    const ride = await tx.rideRequest.findUnique({
      where: { id: rideId },
      include: rideInclude()
    });

    if (!ride) {
      throw new RideError(404, "RIDE_NOT_FOUND", "The ride request could not be found.");
    }
    await tx.notification.create({
      data: {
        userId: ride.customerId,
        title: "Your rider has accepted",
        body: "A NAVIGO rider has accepted your ride request and is preparing to come to your pickup point.",
        requestType: "RIDE",
        requestId: ride.id
      }
    });
    return ride;
  });
}

export async function updateRideStatus(
  riderId: string,
  rideId: string,
  nextStatus: "ARRIVED_AT_PICKUP" | "IN_PROGRESS" | "COMPLETED"
) {
  const ride = await prisma.rideRequest.findUnique({ where: { id: rideId } });
  if (!ride || ride.riderId !== riderId) {
    throw new RideError(404, "RIDE_NOT_FOUND", "The assigned ride could not be found.");
  }

  const allowedNext: Record<string, string> = {
    ACCEPTED: "ARRIVED_AT_PICKUP",
    ARRIVED_AT_PICKUP: "IN_PROGRESS",
    IN_PROGRESS: "COMPLETED"
  };

  if (allowedNext[ride.status] !== nextStatus) {
    throw new RideError(409, "INVALID_RIDE_TRANSITION", "This ride cannot move to that status from its current stage.");
  }

  const now = new Date();
  const updates = {
    status: nextStatus,
    ...(nextStatus === "IN_PROGRESS" ? { startedAt: now } : {}),
    ...(nextStatus === "COMPLETED" ? { completedAt: now } : {})
  };

  return prisma.$transaction(async (tx) => {
    const changed = await tx.rideRequest.updateMany({
      where: { id: rideId, riderId, status: ride.status },
      data: updates
    });

    if (changed.count !== 1) {
      throw new RideError(409, "RIDE_STATUS_CHANGED", "The ride was updated elsewhere. Refresh and try again.");
    }

    await tx.rideStatusHistory.create({
      data: {
        rideRequestId: rideId,
        fromStatus: ride.status,
        toStatus: nextStatus,
        changedById: riderId
      }
    });

    return tx.rideRequest.findUnique({
      where: { id: rideId },
      include: rideInclude()
    });
  });
}

export async function recordRidePayment(
  riderId: string,
  rideId: string,
  transactionReference?: string
) {
  return prisma.$transaction(async (tx) => {
    const ride = await tx.rideRequest.findUnique({
      where: { id: rideId },
      include: { payment: true }
    });

    if (!ride || ride.riderId !== riderId) {
      throw new RideError(404, "RIDE_NOT_FOUND", "The assigned ride could not be found.");
    }
    if (ride.status !== "COMPLETED") {
      throw new RideError(409, "PAYMENT_NOT_ELIGIBLE", "A ride payment can only be recorded after the trip is completed.");
    }
    if (!ride.payment) {
      throw new RideError(409, "PAYMENT_RECORD_NOT_FOUND", "The payment record for this ride could not be found.");
    }
    if (ride.payment.status !== "UNPAID") {
      throw new RideError(409, "PAYMENT_ALREADY_RECORDED", "This ride payment has already been recorded.");
    }
    if (ride.payment.method === "CASH" && transactionReference) {
      throw new RideError(400, "INVALID_PAYMENT_REFERENCE", "A transaction reference can only be supplied for Mobile Money payments.");
    }

    const recordedAt = new Date();
    const changed = await tx.ridePayment.updateMany({
      where: { rideRequestId: rideId, status: "UNPAID" },
      data: {
        status: "PAID",
        recordedById: riderId,
        recordedAt,
        transactionReference: transactionReference ?? null
      }
    });

    if (changed.count !== 1) {
      throw new RideError(409, "PAYMENT_ALREADY_RECORDED", "This ride payment was already recorded. Refresh to see its latest status.");
    }

    await tx.auditLog.create({
      data: {
        actorId: riderId,
        action: "RIDE_PAYMENT_RECORDED",
        targetType: "RIDE_PAYMENT",
        targetId: rideId,
        metadata: {
          method: ride.payment.method,
          amountUgx: ride.payment.amountUgx,
          hasTransactionReference: Boolean(transactionReference)
        }
      }
    });

    const updated = await tx.rideRequest.findUnique({
      where: { id: rideId },
      include: rideInclude()
    });
    if (!updated) {
      throw new RideError(404, "RIDE_NOT_FOUND", "The ride request could not be found.");
    }
    return updated;
  });
}

export async function cancelCustomerRide(customerId: string, rideId: string) {
  const ride = await prisma.rideRequest.findUnique({ where: { id: rideId } });
  if (!ride || ride.customerId !== customerId) {
    throw new RideError(404, "RIDE_NOT_FOUND", "The ride request could not be found.");
  }

  if (ride.status !== "PENDING" && ride.status !== "ACCEPTED") {
    throw new RideError(409, "RIDE_CANNOT_BE_CANCELLED", "A ride can only be cancelled before the trip starts.");
  }

  return prisma.$transaction(async (tx) => {
    const cancelled = await tx.rideRequest.updateMany({
      where: { id: rideId, customerId, status: ride.status },
      data: { status: "CANCELLED", cancelledAt: new Date() }
    });

    if (cancelled.count !== 1) {
      throw new RideError(409, "RIDE_STATUS_CHANGED", "The ride was updated elsewhere. Refresh and try again.");
    }

    await tx.rideStatusHistory.create({
      data: {
        rideRequestId: rideId,
        fromStatus: ride.status,
        toStatus: "CANCELLED",
        changedById: customerId,
        note: "Cancelled by customer before trip start"
      }
    });

    return tx.rideRequest.findUnique({
      where: { id: rideId },
      include: rideInclude()
    });
  });
}

export function rideErrorHandler(
  error: unknown,
  _request: import("express").Request,
  response: import("express").Response,
  next: import("express").NextFunction
) {
  if (error instanceof RideError) {
    response.status(error.statusCode).json({
      error: { code: error.code, message: error.message }
    });
    return;
  }
  next(error);
}
