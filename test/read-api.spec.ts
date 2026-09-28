import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { hubHeaders, validSample } from "./helpers";

afterEach(async () => {
  await env.DB.prepare("DELETE FROM readings").run();
});

async function postSample(body: unknown) {
  return exports.default.fetch("http://example.com/api/v1/samples", {
    method: "POST",
    headers: hubHeaders(),
    body: JSON.stringify(body),
  });
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function seedLatest() {
  expect(
    (
      await postSample(
        validSample({
          sampleId: "01SUMMARYOLDERSAMPLEABCDEF",
          sampledAt: isoHoursAgo(3),
          uploadSequence: 1,
          readings: [
            { channel: 1, probeId: "grain-01", romId: null, rawTemperatureC: 20, temperatureC: 20, status: "ok" },
            { channel: 2, probeId: "grain-02", romId: null, rawTemperatureC: 21, temperatureC: 21, status: "ok" },
            { channel: 10, probeId: "air-01", romId: null, rawTemperatureC: 10, temperatureC: 10, status: "ok" },
          ],
        }),
      )
    ).status,
  ).toBe(201);

  expect(
    (
      await postSample(
        validSample({
          sampleId: "01SUMMARYLATESTSAMPLEABCDE",
          sampledAt: isoHoursAgo(1),
          uploadSequence: 2,
          readings: [
            { channel: 1, probeId: "grain-01", romId: null, rawTemperatureC: 24, temperatureC: 24, status: "ok" },
            { channel: 2, probeId: "grain-02", romId: null, rawTemperatureC: 26, temperatureC: 26, status: "ok" },
            { channel: 10, probeId: "air-01", romId: null, rawTemperatureC: 12, temperatureC: 12, status: "ok" },
          ],
        }),
      )
    ).status,
  ).toBe(201);

  expect(
    (
      await postSample(
        validSample({
          sampleId: "01SUMMARYMANUALSAMPLEABCDE",
          source: "manual",
          sampledAt: isoHoursAgo(0.5),
          uploadSequence: 3,
          readings: [
            { channel: 1, probeId: "grain-01", romId: null, rawTemperatureC: 40, temperatureC: 40, status: "ok" },
            { channel: 2, probeId: "grain-02", romId: null, rawTemperatureC: 40, temperatureC: 40, status: "ok" },
            { channel: 10, probeId: "air-01", romId: null, rawTemperatureC: 40, temperatureC: 40, status: "ok" },
          ],
        }),
      )
    ).status,
  ).toBe(201);
}

describe("GET /api/v1/summary", () => {
  it("returns public layout, latest values from any source, and scheduled 24h range", async () => {
    await seedLatest();
    const response = await exports.default.fetch("http://example.com/api/v1/summary");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=30");

    const body = (await response.json()) as {
      ok: boolean;
      stale: boolean;
      timezone: string;
      lastSampleAt: string | null;
      lastScheduledAt: string | null;
      layout: { probes: Array<{ probeId: string; kind: string }> };
      probes: Array<{
        probeId: string;
        kind: string;
        latest: { temperatureC: number; sampleId: string; source: string } | null;
        min24hC: number | null;
        max24hC: number | null;
      }>;
      air: { latest: { temperatureC: number } | null; min24hC: number | null };
    };

    expect(body.ok).toBe(true);
    expect(body.timezone).toBe("Europe/London");
    expect(body.stale).toBe(false);
    expect(body.layout.probes).toHaveLength(10);
    expect(JSON.stringify(body)).not.toContain("email");
    expect(JSON.stringify(body)).not.toContain("alert_threshold");

    const grain1 = body.probes.find((probe) => probe.probeId === "grain-01");
    const grain2 = body.probes.find((probe) => probe.probeId === "grain-02");
    const air = body.probes.find((probe) => probe.probeId === "air-01");
    expect(grain1?.latest?.temperatureC).toBe(40);
    expect(grain1?.latest?.sampleId).toBe("01SUMMARYMANUALSAMPLEABCDE");
    expect(grain1?.latest?.source).toBe("manual");
    expect(Math.abs(Date.parse(body.lastSampleAt ?? "") - Date.parse(isoHoursAgo(0.5)))).toBeLessThan(5000);
    expect(Date.parse(body.lastScheduledAt ?? "")).toBeGreaterThan(Date.parse(isoHoursAgo(1.1)));
    expect(grain1?.min24hC).toBe(20);
    expect(grain1?.max24hC).toBe(24);
    expect(grain2?.max24hC).toBe(26);
    expect(air?.latest?.temperatureC).toBe(40);
    expect(air?.min24hC).toBe(10);
    expect(air?.max24hC).toBe(12);
    expect(body.air?.latest?.temperatureC).toBe(40);
    expect(body.air?.min24hC).toBe(10);
  });

  it("marks the summary stale when the last scheduled sample is old", async () => {
    await postSample(
      validSample({
        sampleId: "01SUMMARYSTALESAMPLEABCDEF",
        sampledAt: isoHoursAgo(5),
        uploadSequence: 9,
      }),
    );
    const response = await exports.default.fetch("http://example.com/api/v1/summary");
    const body = (await response.json()) as { stale: boolean };
    expect(body.stale).toBe(true);
  });

  it("stays stale when only a manual reading is recent", async () => {
    await postSample(
      validSample({
        sampleId: "01SUMMARYSTALESAMPLEABCDEF",
        sampledAt: isoHoursAgo(5),
        uploadSequence: 9,
      }),
    );
    await postSample(
      validSample({
        sampleId: "01SUMMARYFRESHMANUALABCDEF",
        source: "manual",
        sampledAt: isoHoursAgo(0.1),
        uploadSequence: 10,
      }),
    );
    const response = await exports.default.fetch("http://example.com/api/v1/summary");
    const body = (await response.json()) as { stale: boolean; lastSampleAt: string };
    expect(body.stale).toBe(true);
    expect(Math.abs(Date.parse(body.lastSampleAt ?? "") - Date.parse(isoHoursAgo(0.1)))).toBeLessThan(5000);
  });
});

describe("GET /api/v1/readings", () => {
  it("hides manual readings by default and excludes air from grain aggregates", async () => {
    await seedLatest();
    const start = isoHoursAgo(6);
    const end = isoHoursAgo(0);
    const response = await exports.default.fetch(
      `http://example.com/api/v1/readings?group=raw&start=${start}&end=${end}&probes=grain-01,grain-02,air-01`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      includeManual: boolean;
      points: Array<{
        sampleId: string;
        probes: Record<string, { temperatureC: number }>;
        grain: { avgC: number; maxC: number };
      }>;
    };
    expect(body.includeManual).toBe(false);
    expect(body.points.map((point) => point.sampleId)).toEqual([
      "01SUMMARYOLDERSAMPLEABCDEF",
      "01SUMMARYLATESTSAMPLEABCDE",
    ]);
    const latest = body.points[1];
    expect(latest?.probes["air-01"]?.temperatureC).toBe(12);
    expect(latest?.grain.maxC).toBe(26);
    expect(latest?.grain.avgC).toBe(25);
  });

  it("includes manual readings when requested", async () => {
    await seedLatest();
    const response = await exports.default.fetch(
      `http://example.com/api/v1/readings?group=raw&includeManual=true&start=${isoHoursAgo(6)}&end=${isoHoursAgo(0)}&probes=grain-01`,
    );
    const body = (await response.json()) as { points: Array<{ sampleId: string }> };
    expect(body.points.map((point) => point.sampleId)).toContain("01SUMMARYMANUALSAMPLEABCDE");
  });

  it("groups scheduled grain averages by day", async () => {
    await seedLatest();
    const response = await exports.default.fetch(
      `http://example.com/api/v1/readings?group=day&start=${isoHoursAgo(6)}&end=${isoHoursAgo(0)}&probes=grain-01,air-01`,
    );
    const body = (await response.json()) as {
      group: string;
      points: Array<{
        bucket: string;
        probes: Record<string, { avgC: number }>;
        grain: { avgC: number; maxC: number };
      }>;
    };
    expect(body.group).toBe("day");
    expect(body.points.length).toBeGreaterThan(0);
    const point = body.points[0];
    expect(point?.probes["grain-01"]?.avgC).toBe(22);
    expect(point?.probes["air-01"]?.avgC).toBe(11);
    expect(point?.grain.avgC).toBe(22);
    expect(point?.grain.maxC).toBe(24);
  });

  it("defaults hourly readings to the last 48 hours", async () => {
    const response = await exports.default.fetch("http://example.com/api/v1/readings?group=hour");
    const body = (await response.json()) as { start: string; end: string };
    expect(Date.parse(body.end) - Date.parse(body.start)).toBe(48 * 60 * 60 * 1000);
  });

  it("rejects an unknown group", async () => {
    const response = await exports.default.fetch("http://example.com/api/v1/readings?group=minute");
    expect(response.status).toBe(400);
  });
});
