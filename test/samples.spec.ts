import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { hubHeaders, validSample } from "./helpers";

afterEach(async () => {
  await env.DB.prepare("DELETE FROM readings").run();
});

async function postSample(body: unknown, headers: HeadersInit = hubHeaders()) {
  return exports.default.fetch("http://example.com/api/v1/samples", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("GET /api/v1/health", () => {
  it("reports a healthy D1 connection", async () => {
    const response = await exports.default.fetch("http://example.com/api/v1/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "wheat-temperature-api",
    });
  });
});

describe("POST /api/v1/samples", () => {
  it("rejects a missing or wrong hub token", async () => {
    const missing = await postSample(validSample(), { "content-type": "application/json" });
    expect(missing.status).toBe(401);

    const wrong = await postSample(validSample(), hubHeaders("not-the-token"));
    expect(wrong.status).toBe(401);
  });

  it("accepts a valid sample and stores one row per probe", async () => {
    const sample = validSample();
    const response = await postSample(sample);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      duplicate: false,
      sampleId: sample.sampleId,
    });

    const { results } = await env.DB.prepare(
      "SELECT probe_id, temperature_c, source FROM readings WHERE sample_id = ? ORDER BY probe_id",
    )
      .bind(sample.sampleId)
      .all<{ probe_id: string; temperature_c: number; source: string }>();

    expect(results).toHaveLength(3);
    expect(results.map((row) => row.probe_id)).toEqual(["air-01", "grain-01", "grain-02"]);
    expect(results[1]?.temperature_c).toBeCloseTo(18.24);
    expect(results[0]?.source).toBe("scheduled");
  });

  it("returns success without inserting duplicates for the same sampleId", async () => {
    const sample = validSample();
    expect((await postSample(sample)).status).toBe(201);

    const retry = await postSample({ ...sample, uploadSequence: 9999 });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({
      ok: true,
      duplicate: true,
      sampleId: sample.sampleId,
    });

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM readings WHERE sample_id = ?")
      .bind(sample.sampleId)
      .first<{ n: number }>();
    expect(count?.n).toBe(3);
  });

  it("accepts a partial sample when failed probes have an error status", async () => {
    const sample = validSample({
      sampleId: "01PARTIALSAMPLEIDABCDEFGHIJ",
      readings: [
        {
          channel: 1,
          probeId: "grain-01",
          romId: "28AABBCCDDEEFF01",
          rawTemperatureC: 19.1,
          temperatureC: 19.0,
          status: "ok",
        },
        {
          channel: 2,
          probeId: "grain-02",
          romId: "",
          rawTemperatureC: null,
          temperatureC: null,
          status: "disconnected",
        },
        {
          channel: 3,
          probeId: "grain-03",
          romId: "28AABBCCDDEEFF03",
          rawTemperatureC: null,
          temperatureC: null,
          status: "error",
        },
      ],
    });

    const response = await postSample(sample);
    expect(response.status).toBe(201);

    const disconnected = await env.DB.prepare(
      "SELECT temperature_c, status FROM readings WHERE sample_id = ? AND probe_id = ?",
    )
      .bind(sample.sampleId, "grain-02")
      .first<{ temperature_c: number | null; status: string }>();
    expect(disconnected?.status).toBe("disconnected");
    expect(disconnected?.temperature_c).toBeNull();
  });

  it("rejects invalid, mismatched, and sentinel temperatures", async () => {
    const missingSchema = await postSample({ ...validSample(), schemaVersion: 2 });
    expect(missingSchema.status).toBe(400);

    const mismatch = await postSample({
      ...validSample(),
      readings: [
        {
          channel: 10,
          probeId: "grain-01",
          romId: null,
          rawTemperatureC: 18,
          temperatureC: 18,
          status: "ok",
        },
      ],
    });
    expect(mismatch.status).toBe(400);

    const sentinel = await postSample({
      ...validSample(),
      readings: [
        {
          channel: 1,
          probeId: "grain-01",
          romId: null,
          rawTemperatureC: -127,
          temperatureC: -127,
          status: "ok",
        },
      ],
    });
    expect(sentinel.status).toBe(400);

    const emptyReadings = await postSample({ ...validSample(), readings: [] });
    expect(emptyReadings.status).toBe(400);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM readings").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("accepts an unsynced sample without sampledAt", async () => {
    const sample = validSample({
      sampleId: "01UNSYNCEDSAMPLEIDABCDEFGHI",
      sampledAt: null,
      timeQuality: "unsynced",
    });
    const response = await postSample(sample);
    expect(response.status).toBe(201);

    const row = await env.DB.prepare("SELECT sampled_at, time_quality FROM readings WHERE sample_id = ? LIMIT 1")
      .bind(sample.sampleId)
      .first<{ sampled_at: string | null; time_quality: string }>();
    expect(row?.sampled_at).toBeNull();
    expect(row?.time_quality).toBe("unsynced");
  });
});
