# NAVIGO architecture baseline

## Architecture style
A modular monolith: one Android application, one REST API and one PostgreSQL database. Business rules, permissions and request transitions are owned by the API. The mobile app is a user interface, not a security boundary.

## Components
- **Mobile:** React Native, Expo SDK 58 and TypeScript. One app switches navigation by the authenticated, server-provided role.
- **API:** Node.js 24 LTS, Express 5, Zod validation and Prisma ORM 7.
- **Database:** PostgreSQL. Separate ride and parcel tables preserve their distinct workflows.
- **Shared contracts:** Zod schemas and status constants in packages/shared.
- **Notifications:** Expo Notifications backed by Android FCM; push is best effort and API polling remains the fallback.
- **Maps:** map display and pin selection; avoid mandatory paid geocoding or route optimisation in the first build.
- **Tracking:** Expo Location and Task Manager in an Android development build. Tracking is permitted only during an accepted booking and only for authorised participants.

## Request acceptance
The API must claim a pending request with a database transaction or conditional update. A request may be assigned to one rider only. The database operation, not client refresh timing, decides which rider wins.

## Fare calculation
The server calculates the fare. The app never submits a trusted fare value. A fare quote is stored on creation and remains locked for that request. Begin with configurable landmark pairs and distance bands. Straight-line distance is an estimate and must be calibrated against observed routes before pilot use.

## Tracking update design
- Use REST location updates initially; do not add WebSockets until polling is shown to be inadequate.
- Suggested starting cadence: send after roughly 10 metres of movement, with a 5–10 second minimum interval while actively sharing. Tune through battery and reliability tests.
- Store only the latest rider and customer coordinates for each active session, plus accuracy and timestamps. Do not store a breadcrumb trail.
- Poll latest location around every 5 seconds while the active map screen is foregrounded; back off when that screen is backgrounded.
- The rider app can use an Android location foreground service during an eligible active request. The user must see the OS foreground-service notification.
- Customer sharing is optional. It stops at pickup/ride start for a ride and at collection for a parcel. Rider sharing stops at completion, delivery, cancellation or expiry.
- A session can be read only by that request's customer/sender or assigned rider. The API re-checks booking status and consent on every read/write.
- Mark a position stale after 45 seconds without a fresh update. Display its last-update time; never imply a stale point is current.
- Android force-stop, revoked permissions, device shutdown, GPS disabled and manufacturer battery management can interrupt tracking. Show an honest unavailable state and test on physical devices.

## Security baseline
- Passwords are hashed with Argon2id or bcrypt; never store plaintext passwords.
- Use short-lived access tokens and rotating, hashed, revocable refresh tokens.
- Enforce role, rider approval, request ownership and state transitions on the server.
- Rate-limit login and parcel-code endpoints. Parcel codes are generated with a cryptographically secure random generator, stored as hashes and locked after a small number of failures.
- Validate location ranges, freshness, user role, request membership and session status on every update.
- Do not log passwords, tokens, verification codes, phone numbers or precise coordinates.
- Keep secrets in environment configuration, never in Git.
- Collect the minimum necessary identity and recipient information. Show clear consent and privacy notices.

## Scope guard
V1 excludes actual Mobile Money processing, wallets, in-app chat, shopping errands, car-hailing, continuous tracking outside active bookings, stored movement histories, emergency dispatch and automated route optimisation.
