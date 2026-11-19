import { prisma } from "../../lib/prisma.js";

// Arua pilot tariff, derived from local short-trip fares and a simple
// UGX 500/km marginal rate after the first 2 km. These are distance bands
// because FareRule is intentionally database-configurable.
export const DEFAULT_RIDE_FARE_RULES = [
  { minDistanceKm: 0, maxDistanceKm: 2, fareUgx: 2000 },
  { minDistanceKm: 2.01, maxDistanceKm: 4, fareUgx: 3000 },
  { minDistanceKm: 4.01, maxDistanceKm: 6, fareUgx: 4000 },
  { minDistanceKm: 6.01, maxDistanceKm: 8, fareUgx: 5000 },
  { minDistanceKm: 8.01, maxDistanceKm: 10, fareUgx: 6000 },
  { minDistanceKm: 10.01, maxDistanceKm: 12, fareUgx: 7000 },
  { minDistanceKm: 12.01, maxDistanceKm: 14, fareUgx: 8000 },
  { minDistanceKm: 14.01, maxDistanceKm: 16, fareUgx: 9000 },
  { minDistanceKm: 16.01, maxDistanceKm: 18, fareUgx: 10000 },
  { minDistanceKm: 18.01, maxDistanceKm: 20, fareUgx: 11000 },
  { minDistanceKm: 20.01, maxDistanceKm: 22, fareUgx: 12000 },
  { minDistanceKm: 22.01, maxDistanceKm: 24, fareUgx: 13000 },
  { minDistanceKm: 24.01, maxDistanceKm: 26, fareUgx: 14000 },
  { minDistanceKm: 26.01, maxDistanceKm: 28, fareUgx: 15000 },
  { minDistanceKm: 28.01, maxDistanceKm: 30, fareUgx: 16000 }
] as const;

/**
 * Initializes the pilot tariff only when no active RIDE tariff exists.
 * Existing active administrator-configured fares are never overwritten.
 */
export async function ensureDefaultRideFareRules(): Promise<void> {
  const activeRules = await prisma.fareRule.findMany({
    where: {
      requestType: "RIDE",
      parcelSize: null,
      isActive: true
    },
    select: { id: true }
  });

  if (activeRules.length > 0) {
    console.info(`NAVIGO fare tariff: ${activeRules.length} active ride rule(s) already configured; keeping them unchanged.`);
    return;
  }

  await prisma.fareRule.createMany({
    data: DEFAULT_RIDE_FARE_RULES.map((rule) => ({
      requestType: "RIDE" as const,
      minDistanceKm: rule.minDistanceKm,
      maxDistanceKm: rule.maxDistanceKm,
      parcelSize: null,
      fareUgx: rule.fareUgx,
      isActive: true
    }))
  });

  console.info(`NAVIGO fare tariff: initialized ${DEFAULT_RIDE_FARE_RULES.length} Arua pilot ride fare rules.`);
}
