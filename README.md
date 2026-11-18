# NAVIGO

NAVIGO is an Android-first ride-request and ready-parcel collection/delivery platform being developed as a Muni University undergraduate final-year project. The intended pilot is Muni University Main Campus, Arua City and selected nearby areas.

## Roles

- **Customer/Sender:** requests passenger rides or ready-parcel collection and delivery, selects pickup and destination, sees fare estimates and request progress, and can share location during an eligible active booking.
- **Approved Rider:** applies for approval, views available requests, accepts or rejects requests, updates progress, verifies parcel handovers and records payment received.
- **Administrator:** approves riders, manages users, monitors requests and maintains pilot landmarks and fare rules.

## Agreed first-version behaviour

- Administrator approval is required before a rider can accept requests.
- Rides and parcels have separate status workflows.
- The first eligible rider to accept a pending request wins; the API enforces this atomically.
- Parcels use separate one-time pickup and delivery codes. Recipients do not need an account.
- Cash and Mobile Money are paid directly to the rider. NAVIGO records method, status and an optional reference; it does not process or verify money.
- Live location sharing is available only between the two participants in an accepted booking, requires consent, and ends automatically at the defined workflow stage.
- Only the latest position is retained for an active sharing session. NAVIGO does not keep a complete movement history.
- No shopping errands, car-hailing, wallet, in-app chat, payment gateway, emergency dispatch or automated route optimisation in v1.

> **Academic scope note:** live, two-way active-booking location sharing was added after the earlier proposal scope was agreed. Update the proposal's scope and privacy sections and discuss the change with the supervisor before treating it as approved.

## Architecture

A modular monolith with one Android app, one REST API and one PostgreSQL database.

- `apps/mobile` — Expo / React Native Android application
- `apps/api` — Express API, Prisma schema and API tests
- `packages/shared` — shared TypeScript types and Zod validation
- `docs` — architecture decisions, workflows, privacy and development notes

## Technology baseline

- Node.js 24 LTS and npm workspaces
- Expo SDK 58 / React Native 0.88
- TypeScript, Express 5 and Zod
- PostgreSQL and Prisma ORM 7
- Expo Location, Task Manager, SecureStore and Notifications
- Firebase Cloud Messaging for Android push delivery

Expo native-module versions must be installed/checked with `npx expo install` and `npx expo install --fix` to keep them compatible with SDK 58.

## Prerequisites

- Node.js 24.x
- npm
- Docker Desktop (local PostgreSQL)
- Android Studio and Android SDK
- Physical Android phone or emulator

## Local setup

1. Clone the repository.
2. Run `npm install` from the root.
3. Copy `apps/api/.env.example` to `apps/api/.env`.
4. Start PostgreSQL using `docker compose up -d db`.
5. Run the API and mobile app in separate terminals using the commands in [Development guide](docs/DEVELOPMENT.md).

Never commit real `.env` files, credentials, signing keys or Firebase service-account files.

## Quality rules

- Enforce roles, approval, ownership, fares and status transitions on the server.
- Validate external API inputs.
- Never log passwords, tokens, parcel verification codes or precise location coordinates.
- Test authorisation, request transitions, code attempts, concurrent acceptance and location-session expiry.
- Keep secrets out of Git.
- Use feature branches and review each other's changes.
- Record proposed scope changes before implementing them.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Ride and parcel workflows](docs/WORKFLOWS.md)
- [Location tracking and privacy](docs/LOCATION-TRACKING.md)
- [Development setup](docs/DEVELOPMENT.md)
- [Decision log](docs/DECISIONS.md)

NAVIGO is an academic prototype for a limited pilot, not a claim of commercial-scale availability. Evaluation will use consenting participants and test devices in the agreed pilot area.
