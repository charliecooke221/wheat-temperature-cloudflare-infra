import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

type EnvWithMigrations = Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const testEnv = env as EnvWithMigrations;
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
