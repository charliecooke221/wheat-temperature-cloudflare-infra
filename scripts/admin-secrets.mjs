// Generates the three admin secrets for a password.
//   node scripts/admin-secrets.mjs "the shared admin password"
// Prints ADMIN_PASSWORD_SALT, ADMIN_PASSWORD_HASH and ADMIN_TOKEN_KEY. Put them in
// .dev.vars for local use, or `npx wrangler secret put <NAME>` for production.
import { createHash, randomBytes } from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/admin-secrets.mjs "the shared admin password"');
  process.exit(1);
}
if (password.length < 12) {
  console.error("Use a password of at least 12 characters.");
  process.exit(1);
}

const salt = randomBytes(16).toString("hex");
const hash = createHash("sha256").update(salt + password).digest("hex");
const tokenKey = randomBytes(32).toString("base64url");

console.log(`ADMIN_PASSWORD_SALT=${salt}`);
console.log(`ADMIN_PASSWORD_HASH=${hash}`);
console.log(`ADMIN_TOKEN_KEY=${tokenKey}`);
