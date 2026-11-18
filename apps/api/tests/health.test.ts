import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("GET /api/v1/health/live", () => {
  it("returns service health without exposing secrets", async () => {
    const response = await request(app).get("/api/v1/health/live");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.service).toBe("navigo-api");
    expect(response.body).not.toHaveProperty("databaseUrl");
  });
});
