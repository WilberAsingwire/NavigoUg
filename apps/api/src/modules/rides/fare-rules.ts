import { prisma } from "../../lib/prisma.js";

/**
 * Arua / Muni pilot ride pricing:
 * - UGX 500 per estimated kilometre
 * - UGX 1,000 minimum customer fare
 * - Round upward to the nearest UGX 100 for cash-friendly prices
 * - The initial pilot quote range is capped at 30 km
 */
export const RIDE_DISTANCE_TARIFF = {
  farePerKmUgx: 500,
  minimumFareUgx: 1000,
  roundingStepUgx: 100,
  maximumDistanceKm: 30
} as const;

// Exact signature of the old 15-band default tariff deployed during initial
// fare testing. Only these known generated rows are retired; custom rules are
// kept active and continue to take precedence over the formula.
const LEGACY_DEFAULT_RIDE_FARE_RULES = [
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

function signature(rule: {
  minDistanceKm: unknown;
  maxDistanceKm: unknown;
  fareUgx: number;
}): string {
  const minimum = Number(rule.minDistanceKm).toFixed(2);
  const maximum = rule.maxDistanceKm === null
    ? "null"
    : Number(rule.maxDistanceKm).toFixed(2);
  return `${minimum}|${maximum}|${rule.fareUgx}`;
}

/**
 * Retires only the old generated 15-band default tariff. Any administrator-
 * configured active fare rules are preserved and continue to override the
 * per-kilometre fallback for their configured distances.
 */
export async function ensureDefaultRideFareRules(): Promise<void> {
  const activeRules = await prisma.fareRule.findMany({
    where: {
      requestType: "RIDE",
      parcelSize: null,
      isActive: true
    },
    select: {
      id: true,
      minDistanceKm: true,
      maxDistanceKm: true,
      fareUgx: true
    }
  });

  const legacySignatures = new Set(
    LEGACY_DEFAULT_RIDE_FARE_RULES.map(signature)
  );
  const legacyRules = activeRules.filter((rule) =>
    legacySignatures.has(signature(rule))
  );

  if (legacyRules.length > 0) {
    await prisma.fareRule.updateMany({
      where: {
        id: { in: legacyRules.map((rule) => rule.id) },
        isActive: true
      },
      data: { isActive: false }
    });
  }

  const preservedCustomRules = activeRules.length - legacyRules.length;
  console.info(
    `NAVIGO ride tariff: per-kilometre default is UGX ${RIDE_DISTANCE_TARIFF.farePerKmUgx}/km (minimum UGX ${RIDE_DISTANCE_TARIFF.minimumFareUgx}); retired ${legacyRules.length} old default rule(s) and preserved ${preservedCustomRules} custom active rule(s).`
  );
}
