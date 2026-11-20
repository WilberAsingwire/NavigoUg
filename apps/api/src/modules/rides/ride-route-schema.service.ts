import { prisma } from "../../lib/prisma.js";

/**
 * The NAVIGO production database predates a committed Prisma migration
 * history. Add only the optional ride-route snapshot columns idempotently,
 * preserving all existing ride data and avoiding a migration-history reset.
 */
export async function ensureRideRouteSnapshotColumns(): Promise<void> {
  await prisma.$executeRaw`
    ALTER TABLE "ride_requests"
      ADD COLUMN IF NOT EXISTS "route_coordinates" JSONB,
      ADD COLUMN IF NOT EXISTS "estimated_duration_seconds" INTEGER,
      ADD COLUMN IF NOT EXISTS "routing_provider" VARCHAR(40)
  `;
  console.info("NAVIGO ride route snapshot columns are ready.");
}
