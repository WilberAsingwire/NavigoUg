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

function safeUser(user: SessionUser) {
  return {
    id: user.id,
    fullName: user.fullName,
    phone: user.phone,
    email: user.email,
    role: user.role,
    riderApprovalStatus: user.riderProfile?.approvalStatus ?? null,
    riderProfile: user.riderProfile ? {
      licenceNumber: user.riderProfile.licenceNumber,
      motorcyclePlate: user.riderProfile.motorcyclePlate,
      motorcycleDescription: user.riderProfile.motorcycleDescription
    } : null
  };
}

async function buildSession(user: SessionUser) {
  const accessToken = await new SignJWT({ role: user.role })
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
      expiresAt: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000)
    }
  });

  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer" as const,
    expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
    user: safeUser(user)
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
    return await buildSession(user);
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
    return await buildSession(user);
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
      expiresAt: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000)
    }
  });

  const user = existing.user;
  const accessToken = await new SignJWT({ role: user.role })
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
    user: safeUser(user)
  };
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

export async function getSafeCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { riderProfile: true }
  });
  if (!user || !user.isActive) {
    throw new AuthError(401, "ACCOUNT_UNAVAILABLE", "This account is not available.");
  }
  return safeUser(user);
}
