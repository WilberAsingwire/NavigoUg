# NAVIGO decision log

| ID | Decision | Reason / constraint |
|---|---|---|
| ADR-001 | One Android app with Customer, Rider and Administrator interfaces | Avoid maintaining multiple clients; enforce permissions on the API. |
| ADR-002 | Node.js, TypeScript, Express and a modular monolith | Shared language across app and API; simple local operation. |
| ADR-003 | PostgreSQL with Prisma | Relational consistency and transactions for request acceptance and code verification. |
| ADR-004 | Separate ride and parcel workflows and tables | Their statuses, codes and data fields differ. |
| ADR-005 | Manual payment recording only | Riders receive Cash/Mobile Money directly; no gateway or wallet. |
| ADR-006 | Live two-way location sharing only during active bookings | Supports coordination while preventing always-on tracking. This changes the earlier proposal scope and needs supervisor agreement. |
| ADR-007 | Store only latest shared locations | No full movement history; reduce privacy and data-retention risk. |
| ADR-008 | REST polling before WebSockets | Easier to build, test and support for a small pilot. |
| ADR-009 | First eligible rider to atomically accept wins | Prevent two riders being assigned to one request. |

## Decisions still to confirm with the project team/supervisor
1. Proposal scope amendment for live, two-way tracking and background location permissions.
2. Exact cancellation rules for each request state.
3. Request expiry duration.
4. Whether each rider may hold only one active booking at a time (recommended for v1).
5. Final fare bands and parcel size categories, calibrated for the pilot area.
6. Required rider vetting fields: collect only those genuinely needed for approval.
7. Participant sample size and test procedure for the pilot.
