import type { Transport } from './transport.js';

export interface TokenProviderOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  /** Injectable clock for tests; epoch millis. */
  now?: () => number;
}

/** Refresh tokens this long before their advertised expiry. */
const EXPIRY_SKEW_MS = 300_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface TokenErrorBody {
  /** Polestar's documented shape: { error: { code, message, requestId, ... } }. */
  error?: { code?: unknown; message?: unknown; requestId?: unknown; timestamp?: unknown };
  /** OAuth-style fallback for plain authorization servers. */
  error_description?: unknown;
  requestId?: unknown;
  timestamp?: unknown;
}

/**
 * Pull a useful reason out of a failed token response. The Data Portal returns
 * {error:{code,message}} while OAuth endpoints return error/error_description,
 * so both are read; picking only one produced "[object Object]" on real 404s.
 */
function describeTokenError(err: TokenErrorBody | null): string {
  const nested = err?.error;
  const code =
    typeof nested?.code === 'string' ? nested.code : typeof err?.error === 'string' ? err.error : 'unknown_error';
  const detail =
    typeof nested?.message === 'string'
      ? nested.message
      : typeof err?.error_description === 'string'
        ? err.error_description
        : 'no description';
  return `${code}: ${detail}`;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly requestId?: string,
    readonly timestamp?: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Owns the client-credentials token lifecycle: requests POST {tokenUrl} with
 * JSON {clientId, clientSecret, scope?}, caches the result until expiresIn
 * minus the skew, collapses concurrent callers onto one in-flight request,
 * and supports invalidation so a 401 from the API can trigger exactly one
 * fresh-token retry.
 */
export class TokenProvider {
  private cached: CachedToken | undefined = undefined;
  private inflight: Promise<string> | undefined = undefined;

  constructor(
    private readonly transport: Transport,
    private readonly opts: TokenProviderOptions,
  ) {}

  async token(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - EXPIRY_SKEW_MS) return this.cached.token;
    this.cached = undefined;

    this.inflight ??= this.requestToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * Drop the cached token so the next call fetches a fresh one. The in-flight
   * promise is left alone on purpose: it was started with credentials that were
   * valid when issued, and discarding it would make every concurrent caller
   * behind it re-request a token for no gain.
   */
  invalidate(): void {
    this.cached = undefined;
  }

  /** Epoch ms when the current token stops being trusted (undefined if none). */
  expiresAt(): number | undefined {
    return this.cached?.expiresAt;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private async requestToken(): Promise<string> {
    const scope = this.opts.scopes?.join(' ');
    const res = await this.transport.fetch(this.opts.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        clientId: this.opts.clientId,
        clientSecret: this.opts.clientSecret,
        ...(scope ? { scope } : {}),
      }),
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new AuthError(`Token endpoint returned a non-JSON body (HTTP ${res.status}).`, res.status);
    }

    if (res.status >= 400) {
      const err = parsed instanceof Object ? (parsed as TokenErrorBody) : null;
      throw new AuthError(
        `Token request failed (HTTP ${res.status}): ${describeTokenError(err)}.`,
        res.status,
        typeof err?.error?.requestId === 'string'
          ? err.error.requestId
          : typeof err?.requestId === 'string'
            ? err.requestId
            : undefined,
        typeof err?.timestamp === 'string' ? err.timestamp : undefined,
      );
    }

    const tok = parsed as { accessToken?: unknown; expiresIn?: unknown; tokenType?: unknown };
    if (typeof tok.accessToken !== 'string' || typeof tok.expiresIn !== 'number') {
      throw new AuthError(`Token endpoint response is missing accessToken/expiresIn (HTTP ${res.status}).`, res.status);
    }

    // The API answers `tokenType: "Bearer"`; honour anything else rather than
    // sending a token the gateway will not accept under a scheme we assumed.
    if (typeof tok.tokenType === 'string' && tok.tokenType.toLowerCase() !== 'bearer') {
      throw new AuthError(`Token endpoint returned unsupported tokenType ${JSON.stringify(tok.tokenType)} (only Bearer is supported).`, res.status);
    }
    this.cached = { token: tok.accessToken, expiresAt: this.now() + tok.expiresIn * 1000 };
    return tok.accessToken;
  }
}
