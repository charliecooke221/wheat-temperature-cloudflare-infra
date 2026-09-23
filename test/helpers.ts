import type { SampleUpload } from "../src/api/sample";

export const HUB_TOKEN = "test-hub-token";

export function validSample(overrides: Partial<SampleUpload> = {}): SampleUpload {
  return {
    schemaVersion: 1,
    sampleId: "01TESTSAMPLEIDABCDEFGHIJKL",
    hubId: "shed-01",
    source: "scheduled",
    sampledAt: "2026-09-23T09:00:02Z",
    timeQuality: "ntp",
    batteryV: 4.08,
    externalPower: true,
    firmwareVersion: "0.1.2",
    uploadSequence: 1234,
    readings: [
      {
        channel: 1,
        probeId: "grain-01",
        romId: "28AABBCCDDEEFF01",
        rawTemperatureC: 18.31,
        temperatureC: 18.24,
        status: "ok",
      },
      {
        channel: 2,
        probeId: "grain-02",
        romId: "28AABBCCDDEEFF02",
        rawTemperatureC: 18.5,
        temperatureC: 18.4,
        status: "ok",
      },
      {
        channel: 10,
        probeId: "air-01",
        romId: "28AABBCCDDEEFF0A",
        rawTemperatureC: 16.1,
        temperatureC: 16.05,
        status: "ok",
      },
    ],
    ...overrides,
  };
}

export function hubHeaders(token = HUB_TOKEN): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}
