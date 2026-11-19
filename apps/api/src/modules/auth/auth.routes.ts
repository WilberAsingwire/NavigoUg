import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  ApplyRiderInputSchema,
  ChangeOwnPasswordInputSchema,
  LoginInputSchema,
  RefreshTokenInputSchema,
  UpdateOwnProfileInputSchema,
  SwitchWorkspaceInputSchema,
  RegisterCustomerInputSchema,
  RegisterRiderInputSchema
} from "@navigo/shared";
import {
  applyForRider,
  changeOwnPassword,
  getSafeCurrentUser,
  login,
  refreshSession,
  registerCustomer,
  registerRider,
  revokeRefreshToken,
  switchWorkspace,
  updateOwnProfile
} from "./auth.service.js";
import { requireAuth } from "./auth.middleware.js";
import { AuthError } from "./auth.service.js";

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 100 : 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts. Please try again later." } }
});

function validate<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, body: unknown) {
  const result = schema.safeParse(body);
  return result.success ? { success: true as const, data: result.data } :
    { success: false as const, issues: result.error.issues };
}

authRouter.post("/register/customer", authLimiter, async (request, response, next) => {
  const parsed = validate(RegisterCustomerInputSchema, request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Please check the registration details.", details: parsed.issues } });
    return;
  }
  try {
    response.status(201).json({ data: await registerCustomer(parsed.data) });
  } catch (error) { next(error); }
});

authRouter.post("/register/rider", authLimiter, async (request, response, next) => {
  const parsed = validate(RegisterRiderInputSchema, request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Please check the rider registration details.", details: parsed.issues } });
    return;
  }
  try {
    response.status(201).json({ data: await registerRider(parsed.data) });
  } catch (error) { next(error); }
});

authRouter.post("/login", authLimiter, async (request, response, next) => {
  const parsed = validate(LoginInputSchema, request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Enter a valid phone number and password.", details: parsed.issues } });
    return;
  }
  try {
    response.status(200).json({ data: await login(parsed.data) });
  } catch (error) { next(error); }
});

authRouter.post("/refresh", authLimiter, async (request, response, next) => {
  const parsed = validate(RefreshTokenInputSchema, request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "A valid refresh token is required." } });
    return;
  }
  try {
    response.status(200).json({ data: await refreshSession(parsed.data.refreshToken) });
  } catch (error) { next(error); }
});

authRouter.post("/logout", requireAuth, async (request, response, next) => {
  const parsed = validate(RefreshTokenInputSchema, request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "A valid refresh token is required." } });
    return;
  }
  try {
    await revokeRefreshToken(parsed.data.refreshToken);
    response.status(204).send();
  } catch (error) { next(error); }
});

authRouter.patch("/me", requireAuth, async (request, response, next) => {
  const parsed = validate(UpdateOwnProfileInputSchema, request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Please check your name and email address.", details: parsed.issues } });
    return;
  }
  try {
    response.status(200).json({ data: await updateOwnProfile(request.auth!.userId, parsed.data, request.auth!.role) });
  } catch (error) { next(error); }
});

authRouter.post("/change-password", requireAuth, authLimiter, async (request, response, next) => {
  const parsed = validate(ChangeOwnPasswordInputSchema, request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Please enter your current password and a valid new password.", details: parsed.issues } });
    return;
  }
  try {
    response.status(200).json({ data: await changeOwnPassword(request.auth!.userId, parsed.data, request.auth!.role) });
  } catch (error) { next(error); }
});

authRouter.post("/apply-rider", requireAuth, async (request, response, next) => {
  const parsed = validate(ApplyRiderInputSchema, request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Please complete all rider and motorcycle details.", details: parsed.issues } });
    return;
  }
  try {
    response.status(201).json({ data: await applyForRider(request.auth!.userId, parsed.data) });
  } catch (error) { next(error); }
});

authRouter.post("/switch-workspace", requireAuth, async (request, response, next) => {
  const parsed = validate(SwitchWorkspaceInputSchema, request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Choose a valid workspace." } });
    return;
  }
  try {
    response.status(200).json({ data: await switchWorkspace(request.auth!.userId, request.auth!.role, parsed.data.role) });
  } catch (error) { next(error); }
});

authRouter.get("/me", requireAuth, async (request, response, next) => {
  try {
    response.status(200).json({ data: await getSafeCurrentUser(request.auth!.userId, request.auth!.role) });
  } catch (error) { next(error); }
});

export function authErrorHandler(error: unknown, _request: import("express").Request, response: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof AuthError) {
    response.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
    return;
  }
  next(error);
}
