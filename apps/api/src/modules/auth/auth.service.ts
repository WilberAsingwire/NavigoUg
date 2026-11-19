import * as argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { prisma } from "../../lib/prisma.js";

type SessionUser = {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: "CUSTOMER" | "RIDER" | "ADMIN";
  isActive: boolean;
  riderProfile?: {
    approvalStatus: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";
    licenceNumber: string | null;
    motorcyclePlate: string | null;
    motorcycleDescription: string | null;
  } | null;
};

export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function accessSecret(): Uint8Array {
  const secret = process.env.JWT_ACCESS_SECRET ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("JWT_ACCESS_SECRET must contain at least 32 characters.");
  }
  return new TextEncoder().encode(secret);
}

function accessTokenTtl(): string {
  const ttl = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
    throw new Error("JWT_ACCESS_TTL_SECONDS must be between 60 and 3600.");
  }
  return `${ttl}s`;
}

function normalizePhone(phone: string): string {
  return phone.trim().replace(/[\s()-]/g, "");
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeUser(user: SessionUser, activeRole: SessionUser["role"] = user.role) {
  const isApprovedRider = user.riderProfile?.approvalStatus === "APPROVED";
  const availableRoles: SessionUser["role"][] = user.role === "ADMIN"
    ? ["ADMIN"]
    : isApprovedRider ? ["CUSTOMER", "RIDER"] : ["CUSTOMER"];
  return {
    id: user.id,
    fullName: user.fullName,
    phone: user.phone,
    email: user.email,
    role: activeRole,
    availableRoles,
    riderApplicationStatus: user.riderProfile?.approvalStatus ?? null,
    riderApprovalStatus: user.riderProfile?.approvalStatus ?? null,
    riderProfile: user.riderProfile ? {
      licenceNumber: user.riderProfile.licenceNumber,
      motorcyclePlate: user.riderProfile.motorcyclePlate,
      motorcycleDescription: user.riderProfile.motorcycleDescription
    } : null
  };
}

async function buildSession(user: SessionUser, activeRole: SessionUser["role"] = user.role) {
  const sessionRole = user.role === "ADMIN" ? "ADMIN" : activeRole;
  const accessToken = await new SignJWT({ role: sessionRole })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(accessTokenTtl())
    .sign(accessSecret());

  const refreshToken = randomBytes(64).toString("base64url");
  const refreshDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);
  if (!Number.isInteger(refreshDays) || refreshDays < 1 || refreshDays > 90) {
    throw new Error("REFRESH_TOKEN_TTL_DAYS must be between 1 and 90.");
  }

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      activeRole: sessionRole,
      expiresAt: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000)
    }
  });

  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer" as const,
    expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
    user: safeUser(user, sessionRole)
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "P2002";
}

export async function registerCustomer(input: {
  fullName: string; phone: string; email?: string; password: string;
}) {
  const phone = normalizePhone(input.phone);
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  try {
    const user = await prisma.user.create({
      data: {
        fullName: input.fullName.trim(),
        phone,
        email: input.email?.trim().toLowerCase(),
        passwordHash,
        role: "CUSTOMER"
      }
    });
    return await buildSession(user, "CUSTOMER");
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AuthError(409, "ACCOUNT_EXISTS", "An account with this phone number or email already exists.");
    }
    throw error;
  }
}

export async function registerRider(input: {
  fullName: string; phone: string; email?: string; password: string;
  licenceNumber: string; motorcyclePlate: string; motorcycleDescription: string;
}) {
  const phone = normalizePhone(input.phone);
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  try {
    const user = await prisma.user.create({
      data: {
        fullName: input.fullName.trim(),
        phone,
        email: input.email?.trim().toLowerCase(),
        passwordHash,
        role: "RIDER",
        riderProfile: {
          create: {
            approvalStatus: "PENDING",
            licenceNumber: input.licenceNumber.trim(),
            motorcyclePlate: input.motorcyclePlate.trim().toUpperCase(),
            motorcycleDescription: input.motorcycleDescription.trim()
          }
        }
      },
      include: { riderProfile: true }
    });
    return await buildSession(user, "RIDER");
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AuthError(409, "ACCOUNT_EXISTS", "An account with this phone number or email already exists.");
    }
    throw error;
  }
}

export async function login(input: { phone: string; password: string }) {
  const user = await prisma.user.findUnique({
    where: { phone: normalizePhone(input.phone) },
    include: { riderProfile: true }
  });

  if (!user || !user.isActive) {
    throw new AuthError(401, "INVALID_CREDENTIALS", "The phone number or password is incorrect.");
  }

  let matches = false;
  try {
    matches = await argon2.verify(user.passwordHash, input.password);
  } catch {
    matches = false;
  }

  if (!matches) {
    throw new AuthError(401, "INVALID_CREDENTIALS", "The phone number or password is incorrect.");
  }

  return buildSession(user);
}

export async function refreshSession(refreshToken: string) {
  const tokenHash = hashRefreshToken(refreshToken);
  const now = new Date();
  const newRefreshToken = randomBytes(64).toString("base64url");
  const refreshDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);
  if (!Number.isInteger(refreshDays) || refreshDays < 1 || refreshDays > 90) {
    throw new Error("REFRESH_TOKEN_TTL_DAYS must be between 1 and 90.");
  }

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { include: { riderProfile: true } } }
  });

  if (!existing || existing.revokedAt || existing.expiresAt <= now || !existing.user.isActive) {
    throw new AuthError(401, "INVALID_REFRESH_TOKEN", "Your session has expired. Please sign in again.");
  }

  // Conditional update ensures concurrent refresh attempts cannot both reuse a token.
  const revoked = await prisma.refreshToken.updateMany({
    where: { id: existing.id, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now }
  });
  if (revoked.count !== 1) {
    throw new AuthError(401, "INVALID_REFRESH_TOKEN", "This refresh token has already been used.");
  }

  await prisma.refreshToken.create({
    data: {
      userId: existing.userId,
      tokenHash: hashRefreshToken(newRefreshToken),
      activeRole: existing.activeRole ?? existing.user.role,
      expiresAt: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000)
    }
  });

  const user = existing.user;
  const storedRole = existing.activeRole ?? user.role;
  const activeRole = user.role === "ADMIN" ? "ADMIN" : storedRole;
  const accessToken = await new SignJWT({ role: activeRole })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(accessTokenTtl())
    .sign(accessSecret());

  return {
    accessToken,
    refreshToken: newRefreshToken,
    tokenType: "Bearer" as const,
    expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
    user: safeUser(user, activeRole)
  };
}

export async function switchWorkspace(userId: string, role: "CUSTOMER" | "RIDER") {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { riderProfile: true }
  });
  if (!user || !user.isActive) {
    throw new AuthError(401, "ACCOUNT_UNAVAILABLE", "This account is not available.");
  }
  if (user.role === "ADMIN") {
    throw new AuthError(403, "WORKSPACE_NOT_AVAILABLE", "Administrator accounts cannot switch to customer or rider workspaces.");
  }
  if (role === "RIDER" && user.riderProfile?.approvalStatus !== "APPROVED") {
    throw new AuthError(403, "RIDER_NOT_APPROVED", "The rider workspace becomes available after NAVIGO approves your rider application.");
  }
  return buildSession(user, role);
}

export async function applyForRider(userId: string, input: {
  licenceNumber: string; motorcyclePlate: string; motorcycleDescription: string;
}) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { riderProfile: true }
  });
  if (!user || !user.isActive) {
    throw new AuthError(401, "ACCOUNT_UNAVAILABLE", "This account is not available.");
  }
  if (user.role === "ADMIN") {
    throw new AuthError(403, "RIDER_APPLICATION_NOT_AVAILABLE", "This account cannot submit a rider application.");
  }
  if (user.riderProfile) {
    throw new AuthError(409, "RIDER_APPLICATION_EXISTS", "A rider application already exists for this account. Contact NAVIGO support if you need it reviewed.");
  }

  await prisma.riderProfile.create({
    data: {
      userId,
      approvalStatus: "PENDING",
      licenceNumber: input.licenceNumber.trim(),
      motorcyclePlate: input.motorcyclePlate.trim().toUpperCase(),
      motorcycleDescription: input.motorcycleDescription.trim()
    }
  });
  const updatedUser = await prisma.user.findUnique({
    where: { id: userId },
    include: { riderProfile: true }
  });
  if (!updatedUser) throw new AuthError(401, "ACCOUNT_UNAVAILABLE", "This account is not available.");
  return safeUser(updatedUser, "CUSTOMER");
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

export async function updateOwnProfile(userId: string, input: { fullName: string; email?: string }, activeRole?: SessionUser["role"]) {
  const normalizedEmail = input.email?.trim().toLowerCase() || null;
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        fullName: input.fullName.trim(),
        email: normalizedEmail
      },
      include: { riderProfile: true }
    });
    return safeUser(user, activeRole ?? user.role);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AuthError(409, "EMAIL_ALREADY_USED", "That email address is already linked to another NAVIGO account.");
    }
    throw error;
  }
}

export async function changeOwnPassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
  activeRole?: SessionUser["role"]
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { riderProfile: true }
  });

  if (!user || !user.isActive) {
    throw new AuthError(401, "ACCOUNT_UNAVAILABLE", "This account is not available.");
  }

  let matches = false;
  try {
    matches = await argon2.verify(user.passwordHash, input.currentPassword);
  } catch {
    matches = false;
  }

  if (!matches) {
    throw new AuthError(400, "CURRENT_PASSWORD_INCORRECT", "Your current password is incorrect.");
  }

  const passwordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
  await prisma.$transaction(async (transaction) => {
    await transaction.user.update({
      where: { id: userId },
      data: { passwordHash }
    });
    await transaction.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  });

  const updatedUser = await prisma.user.findUnique({
    where: { id: userId },
    include: { riderProfile: true }
  });
  if (!updatedUser || !updatedUser.isActive) {
    throw new AuthError(401, "ACCOUNT_UNAVAILABLE", "This account is not available.");
  }

  // Replace the sessions revoked above with a fresh session for this device.
  return buildSession(updatedUser, activeRole ?? updatedUser.role);
}

export async function getSafeCurrentUser(userId: string, activeRole?: SessionUser["role"]) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { riderProfile: true }
  });
  if (!user || !user.isActive) {
    throw new AuthError(401, "ACCOUNT_UNAVAILABLE", "This account is not available.");
  }
  return safeUser(user, activeRole ?? user.role);
}
