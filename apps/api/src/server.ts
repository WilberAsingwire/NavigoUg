import "dotenv/config";
import { createServer } from "node:http";
import { app } from "./app.js";
import { ensureDefaultRideFareRules } from "./modules/rides/fare-rules.js";
import { ensureRideRouteSnapshotColumns } from "./modules/rides/ride-route-schema.service.js";

// Cloud hosts such as Render provide PORT; local development falls back to API_PORT.
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT or API_PORT must be a valid TCP port.");
}

const server = createServer(app);

async function startServer(): Promise<void> {
  // Ensure only the additive, nullable route snapshot columns exist before
  // Prisma queries them. This preserves the legacy db-push-managed database.
  await ensureRideRouteSnapshotColumns();

  // Seed the researched pilot tariff before accepting fare-quote requests.
  await ensureDefaultRideFareRules();

  server.listen(port, host, () => {
    console.info(`NAVIGO API listening on http://${host}:${port}`);
  });
}

void startServer().catch((error: unknown) => {
  console.error(
    "NAVIGO API startup failed while initializing the fare tariff.",
    error instanceof Error ? error.message : "Unknown error"
  );
  process.exitCode = 1;
});

function shutdown(signal: string): void {
  console.info(`${signal} received. Closing NAVIGO API...`);
  server.close((error) => {
    if (error) {
      console.error("Error while closing the HTTP server.", error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
