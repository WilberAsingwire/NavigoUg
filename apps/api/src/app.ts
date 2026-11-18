import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

export const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));

const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Native Android requests commonly have no Origin header.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by CORS"));
    }
  })
);

app.use(
  "/api/v1",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false
  })
);

app.get("/api/v1/health/live", (_request, response) => {
  response.status(200).json({
    status: "ok",
    service: "navigo-api",
    timestamp: new Date().toISOString()
  });
});

app.use((_request, response) => {
  response.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "The requested API route was not found."
    }
  });
});

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  response.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: process.env.NODE_ENV === "production" ? "An unexpected error occurred." : message
    }
  });
};

app.use(errorHandler);
