# Active-booking location sharing

## Purpose
Allow a customer/sender to see the assigned rider's movement and allow the rider to see the customer/sender's location when that person chooses to share it.

## Start and stop rules
- Create a tracking session only after a rider is assigned to an accepted request.
- Rider location sharing is enabled for the active service and stops on completion, delivery, cancellation or expiry.
- Customer location sharing is optional and requires explicit, recorded consent.
- For a ride, customer sharing stops when the rider arrives at pickup or the ride starts.
- For a parcel, sender sharing stops when the parcel is collected.
- Both participants can see whether sharing is active. The API rejects updates after the permitted phase ends.
- The app must never collect location when there is no eligible accepted request.

## Storage
Store one latest position for each enabled participant within the tracking-session row. Record coordinates, accuracy and timestamp only. Do not store a sequence of past points or travel-history analytics. On session end, clear coordinate fields and disable both sharing flags; retain only non-location metadata needed for audit.

## Access control
- Customer/sender can view rider location only for their own request.
- Assigned rider can view customer/sender location only for their assigned request and only while consent remains active.
- Other riders, unrelated customers and public endpoints receive no location data.
- Enforce checks in API services, not just mobile navigation.

## Android implementation
Use a custom development build, Expo Location and Expo Task Manager. Request foreground location first and request background access only when the feature is explained and the user starts an eligible sharing session. On Android, background location requires appropriate foreground and background permissions; a location foreground service requires its service permissions and persistent notification. Do not request permissions on initial app launch without context.

The OS or device manufacturer may stop background updates when the user force-stops the app, disables location, revokes permission or applies battery restrictions. The UI must show stale/unavailable location rather than invent continuity.

## Initial performance targets
- Send an update after roughly 10 metres of movement, with a minimum 5–10 second interval while actively sharing.
- Mark location stale after 45 seconds without an update.
- Use HTTPS outside local development.
- Poll latest location around every 5 seconds while the active map screen is foregrounded.
- Validate timestamp age, coordinate range, user role, request membership and session status on every update.

These are starting values for testing, not guarantees of GPS precision or network delivery.
