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

// Must match TEST_ADMIN_PASSWORD in vitest.config.ts.
export const ADMIN_PASSWORD = "correct horse battery staple";

export function adminHeaders(token: string): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

/** A realistic browser push subscription with a fresh P-256 key. */
export async function fakePushSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/abc123") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { endpoint, expirationTime: null, keys: { p256dh: b64url(raw), auth: b64url(auth) } };
}
