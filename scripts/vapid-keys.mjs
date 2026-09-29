// Generates a VAPID key pair for Web Push.
//   node scripts/vapid-keys.mjs
// VAPID_PUBLIC_KEY is safe to share (browsers need it to subscribe);
// VAPID_PRIVATE_KEY must stay a Worker secret. Changing the pair invalidates
// every existing browser subscription.
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);

const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
const jwk = await crypto.subtle.exportKey("jwk", privateKey);

console.log(`VAPID_PUBLIC_KEY=${Buffer.from(raw).toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
