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

export const RecordPaymentInputSchema = z.object({
  transactionReference: z.string().trim().min(3).max(120).optional()
}).strict();
export type RecordPaymentInput = z.infer<typeof RecordPaymentInputSchema>;

export const CoordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180)
});

export const LoginInputSchema = z.object({
  phone: z.string().trim().min(7).max(20),
  password: z.string().min(8).max(128)
});

export const UpdateOwnProfileInputSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.union([z.email(), z.literal("")]).optional()
}).strict();
export type UpdateOwnProfileInput = z.infer<typeof UpdateOwnProfileInputSchema>;

export const ChangeOwnPasswordInputSchema = z.object({
  currentPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128)
}).strict().refine((value) => value.currentPassword !== value.newPassword, {
  path: ["newPassword"],
  message: "Your new password must be different from your current password."
});
export type ChangeOwnPasswordInput = z.infer<typeof ChangeOwnPasswordInputSchema>;

export const ApplyRiderInputSchema = z.object({
  licenceNumber: z.string().trim().min(3).max(80),
  motorcyclePlate: z.string().trim().min(3).max(20),
  motorcycleDescription: z.string().trim().min(3).max(160)
}).strict();
export type ApplyRiderInput = z.infer<typeof ApplyRiderInputSchema>;

export const SwitchWorkspaceInputSchema = z.object({
  role: z.enum(["CUSTOMER", "RIDER"])
}).strict();
export type SwitchWorkspaceInput = z.infer<typeof SwitchWorkspaceInputSchema>;

export const RegisterCustomerInputSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(7).max(20),
  email: z.email().optional(),
  password: z.string().min(8).max(128)
});


export const RegisterRiderInputSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(7).max(20),
  email: z.email().optional(),
  password: z.string().min(8).max(128),
  licenceNumber: z.string().trim().min(3).max(80),
  motorcyclePlate: z.string().trim().min(3).max(20),
  motorcycleDescription: z.string().trim().min(3).max(160)
});


export const RideLocationInputSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  description: z.string().trim().min(2).max(250),
  landmarkId: z.string().uuid().optional()
});

export const RideFareQuoteInputSchema = z.object({
  pickup: RideLocationInputSchema,
  destination: RideLocationInputSchema
}).refine(
  (value) =>
    value.pickup.latitude !== value.destination.latitude ||
    value.pickup.longitude !== value.destination.longitude,
  { message: "Pickup and destination must be different locations." }
);

export const CreateRideInputSchema = RideFareQuoteInputSchema.extend({
  paymentMethod: PaymentMethodSchema.default("CASH")
});

export type CreateRideInput = z.infer<typeof CreateRideInputSchema>;
export type RideFareQuoteInput = z.infer<typeof RideFareQuoteInputSchema>;

export const RideStatusUpdateInputSchema = z.object({
  status: z.enum(["ARRIVED_AT_PICKUP", "IN_PROGRESS", "COMPLETED"])
});


export const ParcelSizeCategorySchema = z.enum(["SMALL", "MEDIUM", "LARGE"]);
export type ParcelSizeCategory = z.infer<typeof ParcelSizeCategorySchema>;

export const ParcelLocationInputSchema = RideLocationInputSchema;

export const ParcelFareQuoteInputSchema = z.object({
  pickup: ParcelLocationInputSchema,
  destination: ParcelLocationInputSchema,
  sizeCategory: ParcelSizeCategorySchema
}).refine(
  (value) =>
    value.pickup.latitude !== value.destination.latitude ||
    value.pickup.longitude !== value.destination.longitude,
  { message: "Pickup and destination must be different locations." }
);

export const CreateParcelInputSchema = ParcelFareQuoteInputSchema.extend({
  recipientName: z.string().trim().min(2).max(100),
  recipientPhone: z.string().trim().min(7).max(20),
  parcelDescription: z.string().trim().min(3).max(300),
  paymentMethod: PaymentMethodSchema.default("CASH")
});

export type ParcelFareQuoteInput = z.infer<typeof ParcelFareQuoteInputSchema>;
export type CreateParcelInput = z.infer<typeof CreateParcelInputSchema>;

export const ParcelCodeInputSchema = z.object({
  code: z.string().trim().regex(/^\\d{6}$/, "Enter the 6-digit verification code.")
});

export const ParcelStatusActionSchema = z.enum([
  "ARRIVED_AT_PICKUP",
  "IN_TRANSIT",
  "ARRIVED_AT_DESTINATION"
]);
export type ParcelStatusAction = z.infer<typeof ParcelStatusActionSchema>;

export const RefreshTokenInputSchema = z.object({
  refreshToken: z.string().min(40).max(200)
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

export const AdminRiderApprovalInputSchema = z.object({
  approvalStatus: z.enum(["APPROVED", "REJECTED", "SUSPENDED"]),
  rejectionReason: z.string().trim().max(500).optional()
});
export type AdminRiderApprovalInput = z.infer<typeof AdminRiderApprovalInputSchema>;

export const AdminFareRuleInputSchema = z.object({
  requestType: z.enum(["RIDE", "PARCEL"]),
  parcelSize: ParcelSizeCategorySchema.nullable().optional().default(null),
  minDistanceKm: z.number().min(0).max(500),
  maxDistanceKm: z.number().gt(0).max(500).nullable().optional().default(null),
  fareUgx: z.number().int().min(500).max(10000000),
  isActive: z.boolean().default(true)
}).superRefine((value, context) => {
  if (value.requestType === "PARCEL" && !value.parcelSize) {
    context.addIssue({
      code: "custom",
      path: ["parcelSize"],
      message: "Choose a size category for item-delivery fares."
    });
  }
  if (value.requestType === "RIDE" && value.parcelSize !== null) {
    context.addIssue({
      code: "custom",
      path: ["parcelSize"],
      message: "Motorcycle ride fares must not have an item size category."
    });
  }
  if (value.maxDistanceKm !== null && value.maxDistanceKm <= value.minDistanceKm) {
    context.addIssue({
      code: "custom",
      path: ["maxDistanceKm"],
      message: "The maximum distance must be greater than the minimum distance."
    });
  }
});
export type AdminFareRuleInput = z.infer<typeof AdminFareRuleInputSchema>;

