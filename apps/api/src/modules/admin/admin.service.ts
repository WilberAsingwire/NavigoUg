import type { AdminFareRuleInput, AdminRiderApprovalInput, RiderApprovalStatus } from "@navigo/shared";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { sendPushNotificationToUsers } from "../notifications/notifications.service.js";

export class AdminError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AdminError";
  }
}

export async function listAdminRiders(status?: RiderApprovalStatus) {
  return prisma.riderProfile.findMany({
    where: status ? { approvalStatus: status } : undefined,
    orderBy: [{ approvalStatus: "asc" }, { createdAt: "asc" }],
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          isActive: true,
          createdAt: true
        }
      }
    }
  });
}

export async function reviewRider(
  adminId: string,
  riderId: string,
  input: AdminRiderApprovalInput
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.riderProfile.findUnique({
      where: { userId: riderId },
      include: { user: { select: { id: true, role: true } } }
    });
    if (!existing || existing.user.role !== "RIDER") {
      throw new AdminError(404, "RIDER_NOT_FOUND", "The rider application could not be found.");
    }

    const reviewedAt = new Date();
    const updated = await tx.riderProfile.update({
      where: { userId: riderId },
      data: {
        approvalStatus: input.approvalStatus,
        reviewedById: adminId,
        reviewedAt,
        rejectionReason: input.approvalStatus === "APPROVED"
          ? null
          : input.rejectionReason?.trim() || null
      },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
            isActive: true,
            createdAt: true
          }
        }
      }
    });

    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: "RIDER_APPLICATION_REVIEWED",
        targetType: "RIDER",
        targetId: riderId,
        metadata: {
          previousStatus: existing.approvalStatus,
          approvalStatus: input.approvalStatus,
          rejectionReason: input.approvalStatus === "APPROVED"
            ? null
            : input.rejectionReason?.trim() || null
        }
      }
    });

    return updated;
  });
}

function asFareRuleData(input: AdminFareRuleInput) {
  return {
    requestType: input.requestType,
    parcelSize: input.requestType === "PARCEL" ? input.parcelSize : null,
    minDistanceKm: input.minDistanceKm,
    maxDistanceKm: input.maxDistanceKm,
    fareUgx: input.fareUgx,
    isActive: input.isActive
  };
}

async function assertNoOverlappingFareRule(
  tx: Prisma.TransactionClient,
  input: AdminFareRuleInput,
  excludedId?: string
) {
  if (!input.isActive) return;
  const rules = await tx.fareRule.findMany({
    where: {
      requestType: input.requestType,
      parcelSize: input.requestType === "PARCEL" ? input.parcelSize : null,
      isActive: true,
      ...(excludedId ? { id: { not: excludedId } } : {})
    },
    select: { id: true, minDistanceKm: true, maxDistanceKm: true }
  });

  const minimum = input.minDistanceKm;
  const maximum = input.maxDistanceKm ?? Number.POSITIVE_INFINITY;
  const overlapping = rules.find((rule) => {
    const existingMinimum = Number(rule.minDistanceKm);
    const existingMaximum = rule.maxDistanceKm === null
      ? Number.POSITIVE_INFINITY
      : Number(rule.maxDistanceKm);
    return minimum <= existingMaximum && existingMinimum <= maximum;
  });

  if (overlapping) {
    throw new AdminError(
      409,
      "FARE_RULE_OVERLAP",
      "This active distance range overlaps another active fare rule for the same service and item size. Adjust the range or deactivate the other rule."
    );
  }
}

export async function listAdminFareRules() {
  return prisma.fareRule.findMany({
    orderBy: [
      { requestType: "asc" },
      { parcelSize: "asc" },
      { minDistanceKm: "asc" }
    ]
  });
}

export async function createAdminFareRule(adminId: string, input: AdminFareRuleInput) {
  return prisma.$transaction(async (tx) => {
    await assertNoOverlappingFareRule(tx, input);
    const created = await tx.fareRule.create({ data: asFareRuleData(input) });
    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: "FARE_RULE_CREATED",
        targetType: "FARE_RULE",
        targetId: created.id,
        metadata: {
          requestType: input.requestType,
          parcelSize: input.requestType === "PARCEL" ? input.parcelSize : null,
          minDistanceKm: input.minDistanceKm,
          maxDistanceKm: input.maxDistanceKm,
          fareUgx: input.fareUgx,
          isActive: input.isActive
        }
      }
    });
    return created;
  });
}

export async function updateAdminFareRule(
  adminId: string,
  ruleId: string,
  input: AdminFareRuleInput
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.fareRule.findUnique({ where: { id: ruleId } });
    if (!existing) throw new AdminError(404, "FARE_RULE_NOT_FOUND", "The fare rule could not be found.");

    await assertNoOverlappingFareRule(tx, input, ruleId);
    const updated = await tx.fareRule.update({
      where: { id: ruleId },
      data: asFareRuleData(input)
    });

    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: "FARE_RULE_UPDATED",
        targetType: "FARE_RULE",
        targetId: ruleId,
        metadata: {
          previous: {
            requestType: existing.requestType,
            parcelSize: existing.parcelSize,
            minDistanceKm: Number(existing.minDistanceKm),
            maxDistanceKm: existing.maxDistanceKm === null ? null : Number(existing.maxDistanceKm),
            fareUgx: existing.fareUgx,
            isActive: existing.isActive
          },
          updated: {
            requestType: input.requestType,
            parcelSize: input.requestType === "PARCEL" ? input.parcelSize : null,
            minDistanceKm: input.minDistanceKm,
            maxDistanceKm: input.maxDistanceKm,
            fareUgx: input.fareUgx,
            isActive: input.isActive
          }
        }
      }
    });
    return updated;
  });
}

export function adminErrorHandler(
  error: unknown,
  _request: import("express").Request,
  response: import("express").Response,
  next: import("express").NextFunction
) {
  if (error instanceof AdminError) {
    response.status(error.statusCode).json({
      error: { code: error.code, message: error.message }
    });
    return;
  }
  next(error);
}


export type AdminAnnouncementAudience = "CUSTOMER" | "RIDER" | "BOTH";

export type AdminAnnouncementInput = {
  title: string;
  body: string;
  audience: AdminAnnouncementAudience;
};

export async function createAdminAnnouncement(
  adminId: string,
  input: AdminAnnouncementInput
) {
  const outcome = await prisma.$transaction(async (tx) => {
    const roles = input.audience === "BOTH"
      ? ["CUSTOMER", "RIDER"] as const
      : [input.audience] as const;
    const recipients = await tx.user.findMany({
      where: {
        isActive: true,
        role: { in: [...roles] }
      },
      select: { id: true }
    });

    if (recipients.length === 0) {
      throw new AdminError(
        409,
        "NO_ANNOUNCEMENT_RECIPIENTS",
        "There are no active users in the selected audience."
      );
    }

    const recipientIds = recipients.map((recipient) => recipient.id);
    for (let offset = 0; offset < recipientIds.length; offset += 1000) {
      const batch = recipientIds.slice(offset, offset + 1000);
      await tx.notification.createMany({
        data: batch.map((userId) => ({
          userId,
          title: input.title,
          body: input.body
        }))
      });
    }

    const audit = await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: "ADMIN_ANNOUNCEMENT_SENT",
        targetType: "ANNOUNCEMENT",
        metadata: {
          title: input.title,
          body: input.body,
          audience: input.audience,
          recipientCount: recipientIds.length
        }
      }
    });

    return {
      recipientIds,
      announcement: {
        id: audit.id,
        title: input.title,
        body: input.body,
        audience: input.audience,
        recipientCount: recipientIds.length,
        createdAt: audit.createdAt
      }
    };
  });

  await sendPushNotificationToUsers(outcome.recipientIds, {
    title: input.title,
    body: input.body,
    data: {}
  });

  return outcome.announcement;
}

export async function listAdminAnnouncements() {
  const rows = await prisma.auditLog.findMany({
    where: {
      action: "ADMIN_ANNOUNCEMENT_SENT",
      targetType: "ANNOUNCEMENT"
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      actor: { select: { fullName: true } }
    }
  });

  return rows.map((row) => {
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {};
    return {
      id: row.id,
      title: typeof metadata.title === "string" ? metadata.title : "NAVIGO announcement",
      body: typeof metadata.body === "string" ? metadata.body : "",
      audience: metadata.audience === "CUSTOMER" || metadata.audience === "RIDER" || metadata.audience === "BOTH"
        ? metadata.audience
        : "BOTH",
      recipientCount: typeof metadata.recipientCount === "number" ? metadata.recipientCount : 0,
      createdAt: row.createdAt,
      senderName: row.actor?.fullName ?? "Administrator"
    };
  });
}
