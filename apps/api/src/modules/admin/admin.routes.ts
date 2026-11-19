import { Router } from "express";
import { z } from "zod";
import {
  AdminFareRuleInputSchema,
  AdminRiderApprovalInputSchema,
  RiderApprovalStatusSchema
} from "@navigo/shared";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import {
  adminErrorHandler,
  createAdminFareRule,
  createAdminAnnouncement,
  listAdminAnnouncements,
  listAdminFareRules,
  listAdminRiders,
  reviewRider,
  updateAdminFareRule
} from "./admin.service.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole("ADMIN"));

function validationError(
  response: import("express").Response,
  message: string,
  details?: unknown
) {
  response.status(400).json({
    error: { code: "VALIDATION_ERROR", message, ...(details ? { details } : {}) }
  });
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const adminAnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(500),
  audience: z.enum(["CUSTOMER", "RIDER", "BOTH"])
}).strict();

adminRouter.get("/announcements", async (_request, response, next) => {
  try {
    response.status(200).json({ data: await listAdminAnnouncements() });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/announcements", async (request, response, next) => {
  const parsed = adminAnnouncementSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Enter a title, message and valid recipient group.", parsed.error.issues);
    return;
  }
  try {
    response.status(201).json({
      data: await createAdminAnnouncement(request.auth!.userId, parsed.data)
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/riders", async (request, response, next) => {
  const rawStatus = request.query.status;
  let status: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED" | undefined;
  if (rawStatus !== undefined && rawStatus !== "ALL") {
    const parsed = RiderApprovalStatusSchema.safeParse(rawStatus);
    if (!parsed.success) {
      validationError(response, "Choose a valid rider application status.");
      return;
    }
    status = parsed.data;
  }
  try {
    response.status(200).json({ data: await listAdminRiders(status) });
  } catch (error) {
    next(error);
  }
});

adminRouter.patch("/riders/:riderId/approval", async (request, response, next) => {
  const riderId = typeof request.params.riderId === "string" ? request.params.riderId : "";
  if (!validUuid(riderId)) {
    validationError(response, "A valid rider account ID is required.");
    return;
  }
  const parsed = AdminRiderApprovalInputSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Choose a valid rider approval decision.", parsed.error.issues);
    return;
  }
  try {
    response.status(200).json({
      data: await reviewRider(request.auth!.userId, riderId, parsed.data)
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/fare-rules", async (_request, response, next) => {
  try {
    response.status(200).json({ data: await listAdminFareRules() });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/fare-rules", async (request, response, next) => {
  const parsed = AdminFareRuleInputSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Check the service, item size, distance range and fare.", parsed.error.issues);
    return;
  }
  try {
    response.status(201).json({
      data: await createAdminFareRule(request.auth!.userId, parsed.data)
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.patch("/fare-rules/:ruleId", async (request, response, next) => {
  const ruleId = typeof request.params.ruleId === "string" ? request.params.ruleId : "";
  if (!validUuid(ruleId)) {
    validationError(response, "A valid fare-rule ID is required.");
    return;
  }
  const parsed = AdminFareRuleInputSchema.safeParse(request.body);
  if (!parsed.success) {
    validationError(response, "Check the service, item size, distance range and fare.", parsed.error.issues);
    return;
  }
  try {
    response.status(200).json({
      data: await updateAdminFareRule(request.auth!.userId, ruleId, parsed.data)
    });
  } catch (error) {
    next(error);
  }
});

export { adminErrorHandler };
