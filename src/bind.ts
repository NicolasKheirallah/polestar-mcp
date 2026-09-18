/**
 * The HTTP bind decision, as a function rather than a side effect of startup.
 *
 * This server reads vehicle position. Bound to a routable address with no token,
 * anyone who can reach the port can ask where the car is, so the rule has to hold
 * before the socket opens. It used to be inline in `serveHttp`, reading
 * `process.env` directly, which left the security decision reachable only by
 * starting a server.
 */
export interface BindRequest {
  host: string | undefined;
  token: string | undefined;
}

export type BindDecision =
  | { ok: true; host: string; token: string | undefined; authenticated: boolean }
  | { ok: false; host: string; reason: string };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function decideBind(request: BindRequest): BindDecision {
  const host = request.host?.trim() || '127.0.0.1';
  const token = request.token?.trim() || '';
  if (LOOPBACK.has(host)) {
    return { ok: true, host, token: token === '' ? undefined : token, authenticated: token !== '' };
  }
  if (token === '') {
    return {
      ok: false,
      host,
      reason:
        `Refusing to serve on ${host} without POLESTAR_HTTP_TOKEN: this server reads vehicle location and would be unauthenticated. ` +
        'Bind 127.0.0.1, or set a bearer token.',
    };
  }
  return { ok: true, host, token, authenticated: true };
}

/** The 401 body an unauthenticated caller gets, in the shape the client uses. */
export function unauthenticatedBody(): string {
  return JSON.stringify({
    error: {
      code: 'UNAUTHENTICATED',
      message: 'Provide Authorization: Bearer <POLESTAR_HTTP_TOKEN>.',
      httpStatus: 401,
    },
  });
}
