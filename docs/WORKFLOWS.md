# NAVIGO request workflows

## Passenger ride
Allowed progression:
1. **PENDING** — customer created the request; approved riders may see it.
2. **ACCEPTED** — one approved rider atomically accepts it.
3. **ARRIVED_AT_PICKUP** — assigned rider confirms arrival.
4. **IN_PROGRESS** — assigned rider starts the ride.
5. **COMPLETED** — assigned rider completes the ride.

CANCELLED and EXPIRED are terminal states. State transitions must be checked centrally; requests must not jump between arbitrary statuses.


## Motorcycle ride booking implementation notes
- The customer app requests a fare quote before creating a ride. The API calculates straight-line distance from the submitted coordinates and applies an active RIDE distance rule, or an exact active pickup-to-destination landmark fare when both landmark IDs are supplied.
- Straight-line distance is an estimate, not road distance. It must be labelled as an estimate in the UI and fares must be calibrated for the pilot area. The customer never submits a trusted fare amount.
- If no active fare rule covers the estimated distance and no exact landmark fare exists, the API refuses the quote/request. It does not invent a price.
- Creating a ride records a PENDING history event and an UNPAID payment record using CASH by default, or the customer's selected CASH/MOBILE_MONEY method.
- Only active, APPROVED riders can list or accept pending rides. Pending rides are claimed with a conditional database update so only one rider can win an acceptance race.
- Only the assigned rider can progress a ride: ACCEPTED → ARRIVED_AT_PICKUP → IN_PROGRESS → COMPLETED. The API rejects skipped or repeated transitions.
- The customer who created the ride can cancel it while PENDING or ACCEPTED. Cancellation is not available after the trip starts.
- The API exposes customer/rider ride history separately. Rider phone details are disclosed only on the assigned ride, not in the public request queue.

## Ride API
- `POST /api/v1/rides/fare-quote` — customer-only estimate for a pickup/destination pair.
- `POST /api/v1/rides` — customer-only request creation; fare is calculated by the API.
- `GET /api/v1/rides/mine` — authenticated customer's or rider's own ride history.
- `GET /api/v1/rides/available` — approved rider's pending requests, excluding requests they rejected.
- `POST /api/v1/rides/:rideId/accept` — approved rider atomically claims a pending ride.
- `PATCH /api/v1/rides/:rideId/status` — assigned rider advances the trip one allowed stage.
- `POST /api/v1/rides/:rideId/cancel` — customer cancels an eligible ride before the trip starts.

All ride endpoints require a valid bearer access token. The API enforces role, rider approval, ownership and permitted state transitions.

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
