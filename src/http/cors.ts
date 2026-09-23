const ALLOWED_METHODS = "GET, POST, PUT, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization";

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (origin === env.ALLOWED_ORIGIN) return origin;
  return null;
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export function corsPreflight(request: Request, env: Env): Response {
  const origin = allowedOrigin(request, env);
  if (!origin) {
    return new Response(null, { status: 204 });
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

export function withCors(request: Request, env: Env, response: Response): Response {
  const origin = allowedOrigin(request, env);
  if (!origin) return response;

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
