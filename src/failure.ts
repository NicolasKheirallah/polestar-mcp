import { AuthError } from './auth.js';
import { BudgetExceededError, RateLimitMinuteError } from './budget.js';
import { PolestarApiError } from './client.js';
import { TransportError } from './transport.js';

/**
 * The codes this server minted itself, as opposed to the ones the Data Portal
 * answers with (those are open-ended and pass through unchanged).
 *
 * The list is closed on purpose: the guidance table in tool-output.ts (MINTED_HINTS)
 * is keyed by it, so
 * minting a new code without deciding what to tell the caller is a type error
 * rather than a result that arrives with no advice attached.
 */
export type MintedCode =
  | 'INVALID_VIN'
  | 'AMBIGUOUS_VIN'
  | 'NO_VEHICLES'
  | 'VIN_NOT_CHOSEN'
  | 'VIN_MISMATCH'
  | 'DOMAIN_MISMATCH'
  | 'LOCATION_DISALLOWED'
  | 'DELEGATION_NOT_ALLOWED'
  | 'BAD_RESPONSE'
  | 'AUTH_ERROR'
  | 'TRANSPORT_TIMEOUT'
  | 'TRANSPORT_NETWORK'
  | 'RATE_LIMIT_EXCEEDED'
  | 'RATE_LIMIT_MINUTE'
  | 'INTERNAL_ERROR';

/**
 * What a failed call looks like once it has left its raising module.
 *
 * Tool code used to identify failures by comparing `err.name` to four string
 * literals, which meant a class rename or a fifth error type silently turned into
 * `INTERNAL_ERROR` and dropped the `requestId` on the floor: the one handle
 * Polestar support acts on. Every module now normalizes into this shape at the
 * place that knows what went wrong.
 */
export interface Failure {
  code: MintedCode | (string & {});
  message: string;
  httpStatus?: number | undefined;
  requestId?: string | undefined;
  /** Only when it is a minted code. Upstream codes get their own hint from
   * UPSTREAM_HINTS when documented, and the generic fallback otherwise. */
  minted?: MintedCode | undefined;
}

const isMinted = (code: string): code is MintedCode => MINTED.has(code);

const MINTED = new Set<string>([
  'INVALID_VIN',
  'AMBIGUOUS_VIN',
  'NO_VEHICLES',
  'VIN_NOT_CHOSEN',
  'VIN_MISMATCH',
  'DOMAIN_MISMATCH',
  'LOCATION_DISALLOWED',
  'DELEGATION_NOT_ALLOWED',
  'BAD_RESPONSE',
  'AUTH_ERROR',
  'TRANSPORT_TIMEOUT',
  'TRANSPORT_NETWORK',
  'RATE_LIMIT_EXCEEDED',
  'RATE_LIMIT_MINUTE',
  'INTERNAL_ERROR',
]);

const base = (message: string): Failure => ({ code: 'INTERNAL_ERROR', message, minted: 'INTERNAL_ERROR' });

/**
 * Normalize anything thrown into the shape the presentation layer renders.
 *
 * `instanceof` against the real classes, so the compiler sees the coupling: the
 * five error types are imported here and adding a sixth without a branch leaves
 * the fall-through visible rather than hidden behind a spelling.
 */
export function toFailure(err: unknown): Failure {
  if (err instanceof PolestarApiError) {
    const minted = isMinted(err.code) ? err.code : undefined;
    return {
      code: err.code,
      message: err.message,
      httpStatus: err.httpStatus,
      ...(typeof err.requestId === 'string' ? { requestId: err.requestId } : {}),
      ...(minted !== undefined ? { minted } : {}),
    };
  }
  if (err instanceof AuthError) {
    return {
      code: 'AUTH_ERROR',
      minted: 'AUTH_ERROR',
      message: err.message,
      ...(typeof err.status === 'number' ? { httpStatus: err.status } : {}),
      ...(typeof err.requestId === 'string' ? { requestId: err.requestId } : {}),
    };
  }
  if (err instanceof TransportError) {
    return {
      code: `TRANSPORT_${err.causeKind.toUpperCase()}`,
      minted: err.causeKind === 'timeout' ? 'TRANSPORT_TIMEOUT' : 'TRANSPORT_NETWORK',
      message: err.message,
    };
  }
  if (err instanceof BudgetExceededError) {
    return { code: 'RATE_LIMIT_EXCEEDED', minted: 'RATE_LIMIT_EXCEEDED', message: err.message };
  }
  if (err instanceof RateLimitMinuteError) {
    return { code: 'RATE_LIMIT_MINUTE', minted: 'RATE_LIMIT_MINUTE', message: err.message };
  }
  if (err instanceof Error) return base(err.message);
  return base(String(err));
}

/** The one text rendering of a failure, shared by tools and resources. */
export function describeFailure(f: Failure): string {
  const parts = [`Polestar API error ${f.code} (HTTP ${f.httpStatus ?? 'n/a'}): ${f.message}`];
  if (f.requestId !== undefined) parts.push(`requestId: ${f.requestId}`);
  return parts.join(', ');
}
