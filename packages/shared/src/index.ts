import { z } from "zod";

export const UserRoleSchema = z.enum(["CUSTOMER", "RIDER", "ADMIN"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const RiderApprovalStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "SUSPENDED"
]);
export type RiderApprovalStatus = z.infer<typeof RiderApprovalStatusSchema>;

export const RideStatusSchema = z.enum([
  "PENDING",
  "ACCEPTED",
  "ARRIVED_AT_PICKUP",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "EXPIRED"
]);
export type RideStatus = z.infer<typeof RideStatusSchema>;

export const ParcelStatusSchema = z.enum([
  "PENDING",
  "ACCEPTED",
  "ARRIVED_AT_PICKUP",
  "COLLECTED",
  "IN_TRANSIT",
  "ARRIVED_AT_DESTINATION",
  "DELIVERED",
  "CANCELLED",
  "EXPIRED"
]);
export type ParcelStatus = z.infer<typeof ParcelStatusSchema>;

export const PaymentMethodSchema = z.enum(["CASH", "MOBILE_MONEY"]);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const PaymentStatusSchema = z.enum(["UNPAID", "PAID"]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const CoordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180)
});

export const LoginInputSchema = z.object({
  phone: z.string().trim().min(7).max(20),
  password: z.string().min(8).max(128)
});

export const RegisterCustomerInputSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(7).max(20),
  email: z.email().optional(),
  password: z.string().min(8).max(128)
});

export const LocationUpdateInputSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).max(10000).optional(),
  headingDegrees: z.number().min(0).max(360).nullable().optional(),
  speedMetersPerSecond: z.number().min(0).nullable().optional(),
  recordedAt: z.iso.datetime()
});

export type LocationUpdateInput = z.infer<typeof LocationUpdateInputSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional()
  })
});
