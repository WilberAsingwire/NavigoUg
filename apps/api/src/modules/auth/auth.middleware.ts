import type { NextFunction, Request, Response } from "express";
import { jwtVerify } from "jose";
import { UserRoleSchema } from "@navigo/shared";

export type AuthPrincipal = { userId: string; role: "CUSTOMER" | "RIDER" | "ADMIN" };

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPrincipal;
    }
  }
}

function secret(): Uint8Array {
  const value = process.env.JWT_ACCESS_SECRET ?? "";
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("JWT_ACCESS_SECRET must contain at least 32 characters.");
  }
  return new TextEncoder().encode(value);
}

export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  const header = request.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
    return;
  }

  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    const role = UserRoleSchema.safeParse(payload.role);
    if (typeof payload.sub !== "string" || !role.success) {
      response.status(401).json({ error: { code: "INVALID_TOKEN", message: "Your session is invalid." } });
      return;
    }
    request.auth = { userId: payload.sub, role: role.data };
    next();
  } catch {
    response.status(401).json({ error: { code: "INVALID_TOKEN", message: "Your session is invalid or has expired." } });
  }
}

export function requireRole(...allowedRoles: AuthPrincipal["role"][]) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!request.auth || !allowedRoles.includes(request.auth.role)) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "You do not have permission to access this resource." } });
      return;
    }
    next();
  };
}
