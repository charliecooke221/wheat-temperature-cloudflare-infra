import { sendTestAlert } from "../alerts/alerts";
import { requireAdminToken } from "../auth/admin";
import { jsonResponse } from "../http/json";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export async function handleAlertTest(request: Request, env: Env): Promise<Response> {
  await requireAdminToken(request, env);
  const result = await sendTestAlert(env);

  const parts: string[] = [];
  if (result.emailed > 0) parts.push(plural(result.emailed, "email recipient"));
  if (result.push.sent > 0) parts.push(plural(result.push.sent, "device"));
  let message = parts.length > 0 ? `Test alert sent to ${parts.join(" and ")}.` : "No test alert was delivered.";
  if (result.push.failed > 0) message += ` ${plural(result.push.failed, "device")} could not be reached.`;
  if (result.push.removed > 0) message += ` Removed ${plural(result.push.removed, "expired device subscription")}.`;

  return jsonResponse(200, { ok: true, message, emailed: result.emailed, push: result.push });
}
