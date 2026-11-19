import "dotenv/config";
import { createServer } from "node:http";
import { app } from "./app.js";

// Cloud hosts such as Render provide PORT; local development falls back to API_PORT.
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT or API_PORT must be a valid TCP port.");
}

const server = createServer(app);

server.listen(port, host, () => {
  console.info(`NAVIGO API listening on http://${host}:${port}`);
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
