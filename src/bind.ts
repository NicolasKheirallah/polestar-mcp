import { timingSafeEqual } from 'node:crypto';
import {
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  validateHostHeader,
  validateOriginHeader,
} from '@modelcontextprotocol/server';

/**
 * The HTTP ingress decisions, as functions rather than side effects of startup.
 *
 * This server reads vehicle position. Bound to a routable address with no token,
 * anyone who can reach the port can ask where the car is; bound to loopback with
 * no token, any web page that resolves a hostname to 127.0.0.1 can do the same
 * through DNS rebinding. Both rules have to hold before a single byte of the
 * request body is read, so both are decided here and covered by tests.
 */
export interface BindRequest {
  host: string | undefined;
  token: string | undefined;
}

export type BindSuccess = { ok: true; host: string; token: string | undefined; authenticated: boolean };
export type BindDecision = BindSuccess | { ok: false; host: string; reason: string };

/** Loopback aliases a loopback bind may answer to. Kept in step with the SDK list. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * A bearer token short enough to guess is not a token. Sixteen characters is the
 * floor the origin guard is paired with: below it a non-loopback bind is refused
 * at startup instead of being served with a secret that is effectively public.
 */
export const MIN_HTTP_TOKEN_LENGTH = 16;

/** Wildcard binds cannot know which interface address a client used. */
const WILDCARD = new Set(['0.0.0.0', '::', '[::]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

export function decideBind(request: BindRequest): BindDecision {
  const host = request.host?.trim() || '127.0.0.1';
  const token = request.token?.trim() || '';
  if (isLoopbackHost(host)) {
    return { ok: true, host, token: token === '' ? undefined : token, authenticated: token !== '' };
  }
  if (token === '') {
    return {
      ok: false,
      host,
      reason:
        `Refusing to serve on ${host} without POLESTAR_HTTP_TOKEN: this server reads vehicle location and would be unauthenticated. ` +
        'Bind 127.0.0.1, or set a bearer token of at least ' +
        `${MIN_HTTP_TOKEN_LENGTH} characters.`,
    };
  }
  if (token.length < MIN_HTTP_TOKEN_LENGTH) {
    return {
      ok: false,
      host,
      reason:
        `Refusing to serve on ${host} with a POLESTAR_HTTP_TOKEN shorter than ${MIN_HTTP_TOKEN_LENGTH} characters: ` +
        'a short bearer token is guessable, and this listener reads vehicle location. ' +
        `Use at least ${MIN_HTTP_TOKEN_LENGTH} characters (for example the output of \`openssl rand -hex 24\`), or bind 127.0.0.1.`,
    };
  }
  return { ok: true, host, token, authenticated: true };
}

/** A request, reduced to the headers the ingress guards look at. */
export interface HttpGuardRequest {
  /** The interface this listener bound. */
  boundHost: string;
  /** `POLESTAR_HTTP_ALLOWED_ORIGINS`, absolute origins. Empty means the request host only. */
  allowedOrigins: readonly string[];
  /** The request's Host header, verbatim. */
  hostHeader: string | undefined;
  /** The request's Origin header, verbatim. Absent for non-browser clients. */
  originHeader: string | undefined;
}

export type HttpGuardDecision = { ok: true } | { ok: false; status: 403; message: string };

/**
 * Host and Origin validation for one HTTP request, decided from headers alone.
 *
 * The Host check is the DNS-rebinding guard: a browser sends the attacker's
 * hostname, which reaches us as the Host header, and a request for our listener
 * must answer to the bound interface (or a loopback alias of a loopback bind).
 * A wildcard bind cannot know the interface address, so it relies on the token
 * floor for that case; the Origin rule still applies.
 *
 * The Origin check is the browser-cross-origin guard: a present Origin must be
 * the request's own host or one of the configured origins. A request without an
 * Origin passes, because non-browser MCP clients do not send one.
 */
export function decideHttpRequest(request: HttpGuardRequest): HttpGuardDecision {
  const { boundHost, allowedOrigins, hostHeader, originHeader } = request;
  const bound = boundHost.trim().toLowerCase();
  const loopback = isLoopbackHost(bound);

  if (hostHeader === undefined || hostHeader.trim() === '') {
    return { ok: false, status: 403, message: 'Missing Host header; HTTP/1.1 requests must name the host they are for.' };
  }
  let requestHost: string | undefined;
  if (!WILDCARD.has(bound)) {
    const allowedHostnames = loopback ? localhostAllowedHostnames() : [bound];
    const host = validateHostHeader(hostHeader, allowedHostnames);
    if (!host.ok) {
      return {
        ok: false,
        status: 403,
        message:
          `Host ${JSON.stringify(hostHeader)} is not this listener (binding ${bound}). ` +
          'A DNS-rebinding request reaches the socket with the attacker hostname in Host, so it is refused here.',
      };
    }
    requestHost = host.hostname;
  } else {
    // Wildcard bind: the Host header names whichever interface address the
    // client dialled, and this server cannot enumerate them. Syntax is checked
    // by taking the header's own hostname as the only allowed value.
    const hostname = hostHeader.replace(/:\d+$/, '').replace(/\[|\]/g, '');
    const host = validateHostHeader(hostHeader, [hostname === '::1' ? '[::1]' : hostname]);
    if (!host.ok) {
      return { ok: false, status: 403, message: `Host ${JSON.stringify(hostHeader)} is not a valid host header.` };
    }
    requestHost = host.hostname;
  }

  if (originHeader === undefined || originHeader.trim() === '') {
    return { ok: true };
  }
  const originHostnames: string[] = allowedOrigins.map(originHostnameOrSelf);
  if (allowedOrigins.length === 0 && requestHost !== undefined) {
    // Empty allowlist means same-host-origin only, so the request's own host is
    // the allowed origin. Loopback aliases are added on a loopback bind because
    // http://localhost and http://127.0.0.1 are the same machine.
    originHostnames.push(requestHost);
  }
  if (loopback) originHostnames.push(...localhostAllowedOrigins());
  const origin = validateOriginHeader(originHeader, originHostnames);
  if (!origin.ok) {
    return {
      ok: false,
      status: 403,
      message:
        `Origin ${JSON.stringify(originHeader)} is not allowed. ` +
        (allowedOrigins.length === 0
          ? 'Only the request host may call this listener; set POLESTAR_HTTP_ALLOWED_ORIGINS to admit another origin.'
          : 'Add it to POLESTAR_HTTP_ALLOWED_ORIGINS if it is a legitimate client.'),
    };
  }
  return { ok: true };
}

/** `https://app.example.com` -> `app.example.com`, the SDK origin guard's unit. */
function originHostnameOrSelf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/**
 * Compare a Bearer header with the configured token in constant time.
 *
 * String equality answers on the first differing byte and on differing lengths,
 * which is a timing oracle in principle. `timingSafeEqual` needs equal-length
 * buffers, so a length mismatch is refused before it is called; the length of a
 * bearer token is not the secret.
 */
export function bearerMatches(authorization: string | undefined, token: string): boolean {
  if (authorization === undefined || token === '') return false;
  const match = /^Bearer (.+)$/i.exec(authorization.trim());
  if (match === null) return false;
  const provided = Buffer.from(match[1]!, 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
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

/** The 403 body a request with a foreign Host or Origin gets. */
export function forbiddenBody(message: string): string {
  return JSON.stringify({ error: { code: 'FORBIDDEN', message, httpStatus: 403 } });
}
