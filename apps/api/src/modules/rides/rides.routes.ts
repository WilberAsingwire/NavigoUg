import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  CreateRideInputSchema,
  RideFareQuoteInputSchema,
  RideStatusUpdateInputSchema,
  RecordPaymentInputSchema
} from "@navigo/shared";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import {
  acceptRide,
  cancelCustomerRide,
  createRide,
  getRideFareQuote,
  listAvailableRides,
  listCustomerRides,
  listRiderRides,
  RideError,
  updateRideStatus,
  recordRidePayment,
  setRiderOnline,
  updateRiderAvailabilityLocation,
  setRiderOffline
} from "./rides.service.js";

export const ridesRouter = Router();

const ridesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

ridesRouter.use(requireAuth, ridesLimiter);

function validationError(response: import("express").Response, message: string, details?: unknown) {
  response.status(400).json({
    error: {
      code: "VALIDATION_ERROR",
      message,
      ...(details ? { details } : {})
    }
  });
}

function validRideId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

ridesRouter.post("/fare-quote", requireRole("CUSTOMER"), async (request, response, next) => {
  const startedAt = Date.now();
  console.info("[NAVIGO fare quote] request received");
  const parsed = RideFareQuoteInputSchema.safeParse(request.body);
  if (!parsed.success) {
    console.warn("[NAVIGO fare quote] input rejected", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code
      }))
    });
    validationError(response, "Please select valid pickup and destination locations.", parsed.error.issues);
    return;
  }

  try {
    const quote = await getRideFareQuote(parsed.data);
    console.info("[NAVIGO fare quote] completed", {
      distanceKm: quote.distanceKm,
      fareAmountUgx: quote.fareAmountUgx,
      routingProvider: quote.routingProvider,
      routePointCount: quote.routeCoordinates.length,
      durationMs: Date.now() - startedAt
    });
    response.status(200).json({ data: quote });
  } catch (error) {
    if (error instanceof RideError) {
      console.warn("[NAVIGO fare quote] failed", {
        code: error.code,
        statusCode: error.statusCode,
        durationMs: Date.now() - startedAt
      });
    } else {
      console.error("[NAVIGO fare quote] unexpected failure", {
        message: error instanceof Error ? error.message : "Unknown error",
        durationMs: Date.now() - startedAt
      });
    }
    next(error);
  }
});

ridesRouter.post("/", requireRole("CUSTOMER"), async (request, response, next) => {
  const parsed = CreateRideInputSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Please check the ride request details.", parsed.error.issues);
    return;
  }

  try {
    response.status(201).json({
      data: await createRide(request.auth!.userId, parsed.data)
    });
  } catch (error) {
    next(error);
  }
});

ridesRouter.get("/mine", requireRole("CUSTOMER", "RIDER"), async (request, response, next) => {
  try {
    const rides = request.auth!.role === "CUSTOMER"
      ? await listCustomerRides(request.auth!.userId)
      : await listRiderRides(request.auth!.userId);
    response.status(200).json({ data: rides });
  } catch (error) {
    next(error);
  }
});

function parseRiderLocation(body: unknown): { latitude: number; longitude: number; accuracyMeters: number } | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (typeof value.latitude !== "number" || typeof value.longitude !== "number" || typeof value.accuracyMeters !== "number") return null;
  return { latitude: value.latitude, longitude: value.longitude, accuracyMeters: value.accuracyMeters };
}

ridesRouter.post("/availability/online", requireRole("RIDER"), async (request, response, next) => {
  const point = parseRiderLocation(request.body);
  if (!point) { validationError(response, "A valid GPS latitude, longitude and accuracy are required."); return; }
  try { response.status(200).json({ data: await setRiderOnline(request.auth!.userId, point) }); }
  catch (error) { next(error); }
});

ridesRouter.post("/availability/location", requireRole("RIDER"), async (request, response, next) => {
  const point = parseRiderLocation(request.body);
  if (!point) { validationError(response, "A valid GPS latitude, longitude and accuracy are required."); return; }
  try { response.status(200).json({ data: await updateRiderAvailabilityLocation(request.auth!.userId, point) }); }
  catch (error) { next(error); }
});

ridesRouter.post("/availability/offline", requireRole("RIDER"), async (request, response, next) => {
  try { response.status(200).json({ data: await setRiderOffline(request.auth!.userId) }); }
  catch (error) { next(error); }
});

ridesRouter.get("/available", requireRole("RIDER"), async (request, response, next) => {
  try { response.status(200).json({ data: await listAvailableRides(request.auth!.userId) }); }
  catch (error) { next(error); }
});

ridesRouter.post("/:rideId/accept", requireRole("RIDER"), async (request, response, next) => {
  const rideId = typeof request.params.rideId === "string" ? request.params.rideId : "";
  if (!validRideId(rideId)) {
    validationError(response, "A valid ride request ID is required.");
    return;
  }

  try {
    response.status(200).json({
      data: await acceptRide(request.auth!.userId, rideId)
    });
  } catch (error) {
    next(error);
  }
});

ridesRouter.patch("/:rideId/status", requireRole("RIDER"), async (request, response, next) => {
  const rideId = typeof request.params.rideId === "string" ? request.params.rideId : "";
  if (!validRideId(rideId)) {
    validationError(response, "A valid ride request ID is required.");
    return;
  }

  const parsed = RideStatusUpdateInputSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Choose a valid next ride stage.", parsed.error.issues);
    return;
  }

  try {
    response.status(200).json({
      data: await updateRideStatus(
        request.auth!.userId,
        rideId,
        parsed.data.status
      )
    });
  } catch (error) {
    next(error);
  }
});

ridesRouter.post("/:rideId/payment/record", requireRole("RIDER"), async (request, response, next) => {
  const rideId = typeof request.params.rideId === "string" ? request.params.rideId : "";
  if (!validRideId(rideId)) {
    validationError(response, "A valid ride request ID is required.");
    return;
  }

  const parsed = RecordPaymentInputSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    validationError(response, "Please provide a valid Mobile Money transaction reference.", parsed.error.issues);
    return;
  }

  try {
    response.status(200).json({
      data: await recordRidePayment(request.auth!.userId, rideId, parsed.data.transactionReference)
    });
  } catch (error) {
    next(error);
  }
});

ridesRouter.post("/:rideId/cancel", requireRole("CUSTOMER"), async (request, response, next) => {
  const rideId = typeof request.params.rideId === "string" ? request.params.rideId : "";
  if (!validRideId(rideId)) {
    validationError(response, "A valid ride request ID is required.");
    return;
  }

  try {
    response.status(200).json({
      data: await cancelCustomerRide(request.auth!.userId, rideId)
    });
  } catch (error) {
    next(error);
  }
});

export function ridesErrorHandler(
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
