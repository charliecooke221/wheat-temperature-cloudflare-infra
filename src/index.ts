import { retryPendingAlert } from "./alerts/alerts";
import { handleRequest } from "./api/router";
import { purgeOldLoginAttempts } from "./auth/admin";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  // Cron trigger (wrangler.jsonc): retries a failed alert email and tidies login limits.
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      Promise.all([retryPendingAlert(env), purgeOldLoginAttempts(env.DB)]).then(
        () => undefined,
        (error: unknown) => {
          console.error(JSON.stringify({ level: "error", event: "scheduled_failed", error: String(error) }));
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
