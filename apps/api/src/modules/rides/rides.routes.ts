import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  CreateRideInputSchema,
  RideFareQuoteInputSchema,
  RideStatusUpdateInputSchema
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
  updateRideStatus
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
  const parsed = RideFareQuoteInputSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Please select valid pickup and destination locations.", parsed.error.issues);
    return;
  }

  try {
    response.status(200).json({ data: await getRideFareQuote(parsed.data) });
  } catch (error) {
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

ridesRouter.get("/available", requireRole("RIDER"), async (request, response, next) => {
  try {
    response.status(200).json({
      data: await listAvailableRides(request.auth!.userId)
    });
  } catch (error) {
    next(error);
  }
});

ridesRouter.post("/:rideId/accept", requireRole("RIDER"), async (request, response, next) => {
  if (!validRideId(request.params.rideId)) {
    validationError(response, "A valid ride request ID is required.");
    return;
  }

  try {
    response.status(200).json({
      data: await acceptRide(request.auth!.userId, request.params.rideId)
    });
  } catch (error) {
    next(error);
  }
});

ridesRouter.patch("/:rideId/status", requireRole("RIDER"), async (request, response, next) => {
  if (!validRideId(request.params.rideId)) {
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
        request.params.rideId,
        parsed.data.status
      )
    });
  } catch (error) {
    next(error);
  }
});

ridesRouter.post("/:rideId/cancel", requireRole("CUSTOMER"), async (request, response, next) => {
  if (!validRideId(request.params.rideId)) {
    validationError(response, "A valid ride request ID is required.");
    return;
  }

  try {
    response.status(200).json({
      data: await cancelCustomerRide(request.auth!.userId, request.params.rideId)
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
