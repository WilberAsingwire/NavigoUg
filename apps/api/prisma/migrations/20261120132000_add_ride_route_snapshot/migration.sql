-- Preserve the exact motorcycle road route used for the customer's confirmed quote.
-- Nullable columns keep existing ride rows and older application versions compatible.
ALTER TABLE "ride_requests"
  ADD COLUMN "route_coordinates" JSONB,
  ADD COLUMN "estimated_duration_seconds" INTEGER,
  ADD COLUMN "routing_provider" VARCHAR(40);
