import { createHash } from "node:crypto";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Must match ADMIN_PASSWORD in test/helpers.ts.
const TEST_ADMIN_PASSWORD = "correct horse battery staple";
const TEST_ADMIN_SALT = "test-salt";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            HUB_UPLOAD_TOKEN: "test-hub-token",
            ALLOWED_ORIGIN: "http://localhost:5173",
            ENVIRONMENT: "test",
            ADMIN_PASSWORD_SALT: TEST_ADMIN_SALT,
            ADMIN_PASSWORD_HASH: createHash("sha256").update(TEST_ADMIN_SALT + TEST_ADMIN_PASSWORD).digest("hex"),
            ADMIN_TOKEN_KEY: "test-admin-token-key",
            LOGIN_FAILURE_DELAY_MS: "0",
            DASHBOARD_URL: "https://example.test/dashboard/",
            BREVO_API_KEY: "test-brevo-key",
            ALERT_SENDER_EMAIL: "alerts@example.test",
            // A fixed throwaway pair generated with scripts/vapid-keys.mjs.
            VAPID_PUBLIC_KEY: "BELGBGFKwjqhcVtrh38HpRoPaO54JfJExXCMPGReu_L6eQ4S0MaaTVnJZCGhOkJyHrPGEqsVRqFI-HYDM5rVwtM",
            VAPID_PRIVATE_KEY: "mZtMdp0C2xtBhaQ63tO0DoPw7WLsGGXXcPQfFBbiOLI",
            VAPID_SUBJECT: "mailto:test@example.test",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
