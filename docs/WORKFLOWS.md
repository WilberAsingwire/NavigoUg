# NAVIGO request workflows

## Passenger ride
Allowed progression:
1. **PENDING** — customer created the request; approved riders may see it.
2. **ACCEPTED** — one approved rider atomically accepts it.
3. **ARRIVED_AT_PICKUP** — assigned rider confirms arrival.
4. **IN_PROGRESS** — assigned rider starts the ride.
5. **COMPLETED** — assigned rider completes the ride.

CANCELLED and EXPIRED are terminal states. State transitions must be checked centrally; requests must not jump between arbitrary statuses.

## Ready-parcel delivery
Allowed progression:
1. **PENDING** — sender creates request and receives separate pickup and delivery codes.
2. **ACCEPTED** — one approved rider atomically accepts.
3. **ARRIVED_AT_PICKUP** — rider confirms arrival at sender's pickup point.
4. **COLLECTED** — rider enters the sender's valid pickup code.
5. **IN_TRANSIT** — rider starts delivery.
6. **ARRIVED_AT_DESTINATION** — rider confirms arrival.
7. **DELIVERED** — rider enters the recipient's valid delivery code.

CANCELLED and EXPIRED are terminal states. A parcel already collected cannot be cancelled through the ordinary sender workflow; it requires administrator resolution.

## Parcel code handling
- Generate two independent six-digit codes using a cryptographically secure random generator.
- Store only a keyed hash or secure password hash; never store or log plaintext codes.
- Show the sender the pickup code for handover and the delivery code to share with the recipient.
- Neither code is sent in a rider API response or push notification.
- Limit failed attempts (initial target: five per code), apply endpoint rate limits and lock/reissue securely when exhausted.
- A code is valid for exactly one transition and cannot be reused.

## Rider acceptance and rejection
The available-request list contains pending requests. The first valid atomic acceptance wins. A rider's rejection hides that request from that rider only; it does not reject it for everyone. A rider must be approved and must not exceed the active-job rule selected for the pilot.

## Payment recording
The app records CASH or MOBILE_MONEY and UNPAID/PAID. The rider records receipt because they receive payment directly. A transaction reference may be recorded as text but is not verified by NAVIGO. The system does not process money.
