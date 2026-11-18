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


describe("authentication input validation", () => {
  it("rejects an incomplete customer registration before database access", async () => {
    const response = await request(app).post("/api/v1/auth/register/customer").send({
      phone: "123",
      password: "short"
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a login request with missing credentials", async () => {
    const response = await request(app).post("/api/v1/auth/login").send({});
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
