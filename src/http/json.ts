import { HttpError } from "./errors";

export const MAX_BODY_BYTES = 16 * 1024;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function jsonError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { ok: false, error: code, message });
}

export function jsonFromHttpError(error: HttpError): Response {
  return jsonError(error.status, error.code, error.message);
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) {
      throw new HttpError(400, "invalid_request", "Invalid Content-Length");
    }
    if (length > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", "Request body is too large");
    }
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "Request body is too large");
  }
  if (buffer.byteLength === 0) {
    throw new HttpError(400, "invalid_json", "Empty body");
  }

  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
}
