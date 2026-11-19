import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  CreateParcelInputSchema,
  ParcelCodeInputSchema,
  ParcelFareQuoteInputSchema,
  ParcelStatusActionSchema
} from "@navigo/shared";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import {
  acceptParcel,
  cancelSenderParcel,
  createParcel,
  getParcelFareQuote,
  listAvailableParcels,
  listRiderParcels,
  listSenderParcels,
  ParcelError,
  updateParcelStatus,
  verifyParcelDelivery,
  verifyParcelPickup
} from "./parcels.service.js";

export const parcelsRouter = Router();

const parcelsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

parcelsRouter.use(requireAuth, parcelsLimiter);

function validationError(
  response: import("express").Response,
  message: string,
  details?: unknown
) {
  response.status(400).json({
    error: {
      code: "VALIDATION_ERROR",
      message,
      ...(details ? { details } : {})
    }
  });
}

function validParcelId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parcelIdFromRequest(request: import("express").Request): string {
  return typeof request.params.parcelId === "string" ? request.params.parcelId : "";
}

parcelsRouter.post("/fare-quote", requireRole("CUSTOMER"), async (request, response, next) => {
  const parsed = ParcelFareQuoteInputSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Please provide valid parcel size, pickup and destination details.", parsed.error.issues);
    return;
  }

  try {
    response.status(200).json({ data: await getParcelFareQuote(parsed.data) });
  } catch (error) {
    next(error);
  }
});

parcelsRouter.post("/", requireRole("CUSTOMER"), async (request, response, next) => {
  const parsed = CreateParcelInputSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Please check the parcel delivery details.", parsed.error.issues);
    return;
  }

  try {
    response.status(201).json({
      data: await createParcel(request.auth!.userId, parsed.data)
    });
  } catch (error) {
    next(error);
  }
});

parcelsRouter.get("/mine", requireRole("CUSTOMER", "RIDER"), async (request, response, next) => {
  try {
    const parcels = request.auth!.role === "CUSTOMER"
      ? await listSenderParcels(request.auth!.userId)
      : await listRiderParcels(request.auth!.userId);
    response.status(200).json({ data: parcels });
  } catch (error) {
    next(error);
  }
});

parcelsRouter.get("/available", requireRole("RIDER"), async (request, response, next) => {
  try {
    response.status(200).json({
      data: await listAvailableParcels(request.auth!.userId)
    });
  } catch (error) {
    next(error);
  }
});

parcelsRouter.post("/:parcelId/accept", requireRole("RIDER"), async (request, response, next) => {
  const parcelId = parcelIdFromRequest(request);
  if (!validParcelId(parcelId)) {
    validationError(response, "A valid parcel request ID is required.");
    return;
  }

  try {
    response.status(200).json({
      data: await acceptParcel(request.auth!.userId, parcelId)
    });
  } catch (error) {
    next(error);
  }
});

parcelsRouter.patch("/:parcelId/status", requireRole("RIDER"), async (request, response, next) => {
  const parcelId = parcelIdFromRequest(request);
  if (!validParcelId(parcelId)) {
    validationError(response, "A valid parcel request ID is required.");
    return;
  }

  const parsed = ParcelStatusActionSchema.safeParse(request.body?.status);
  if (!parsed.success) {
    validationError(response, "Choose a valid next parcel stage.", parsed.error.issues);
    return;
  }

  try {
    response.status(200).json({
      data: await updateParcelStatus(request.auth!.userId, parcelId, parsed.data)
    });
  } catch (error) {
    next(error);
  }
});

parcelsRouter.post("/:parcelId/verify-pickup", requireRole("RIDER"), async (request, response, next) => {
  const parcelId = parcelIdFromRequest(request);
  if (!validParcelId(parcelId)) {
    validationError(response, "A valid parcel request ID is required.");
    return;
  }

  const parsed = ParcelCodeInputSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Enter the 6-digit sender collection code.", parsed.error.issues);
    return;
  }

  try {
    response.status(200).json({
      data: await verifyParcelPickup(request.auth!.userId, parcelId, parsed.data.code)
    });
  } catch (error) {
    next(error);
  }
});

parcelsRouter.post("/:parcelId/verify-delivery", requireRole("RIDER"), async (request, response, next) => {
  const parcelId = parcelIdFromRequest(request);
  if (!validParcelId(parcelId)) {
    validationError(response, "A valid parcel request ID is required.");
    return;
  }

  const parsed = ParcelCodeInputSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Enter the 6-digit recipient delivery code.", parsed.error.issues);
    return;
  }

  try {
    response.status(200).json({
      data: await verifyParcelDelivery(request.auth!.userId, parcelId, parsed.data.code)
    });
  } catch (error) {
    next(error);
  }
});

parcelsRouter.post("/:parcelId/cancel", requireRole("CUSTOMER"), async (request, response, next) => {
  const parcelId = parcelIdFromRequest(request);
  if (!validParcelId(parcelId)) {
    validationError(response, "A valid parcel request ID is required.");
    return;
  }

  try {
    response.status(200).json({
      data: await cancelSenderParcel(request.auth!.userId, parcelId)
    });
  } catch (error) {
    next(error);
  }
});

export function parcelsErrorHandler(
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
