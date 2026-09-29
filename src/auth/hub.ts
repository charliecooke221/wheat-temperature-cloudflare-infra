import { HttpError } from "../http/errors";
import { bearerToken, timingSafeEqualString } from "./tokens";

export async function requireHubToken(request: Request, env: Env): Promise<void> {
  if (!env.HUB_UPLOAD_TOKEN) {
    throw new HttpError(500, "misconfigured", "Hub upload token is not configured");
  }

  const token = bearerToken(request.headers.get("Authorization"));
  if (!token || !(await timingSafeEqualString(token, env.HUB_UPLOAD_TOKEN))) {
    throw new HttpError(401, "unauthorized", "Invalid hub upload token");
  }
}
