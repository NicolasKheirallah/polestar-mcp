import type { TokenProvider } from './auth.js';
import type { Transport, TransportResponse } from './transport.js';

export type DomainKind = 'telemetry' | 'charging';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/; // standard VIN alphabet: no I, O, Q

export class PolestarApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly requestId?: string,
    readonly timestamp?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PolestarApiError';
  }
}

export interface PolestarClientOptions {
  baseUrl: string;
  accountId: string;
  /** Third-party credentials only: account whose shared VINs to access. */
  delegatedAccountId?: string;
  /** False blocks the position domain at the request layer, not just its display. */
  allowLocation?: boolean;
}

interface ApiErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    httpStatus?: unknown;
    requestId?: unknown;
    timestamp?: unknown;
    details?: unknown;
  };
}

/**
 * The one deep module over the Polestar Data Portal M2M API. Callers see two
 * methods: `vehicles()` and `domain(vin, kind, name)`: both read-only GETs.
 * Behind them: the token lifecycle (including retry-once on 401), the
 * x-client-id (and optional x-delegated-account-id) headers, envelope
 * unwrapping ({data, meta} → data), error normalization into
 * PolestarApiError, and the rule that a 404 DATA_NOT_AVAILABLE means "no data
 * reported" (→ null) rather than an error.
 */
export class PolestarClient {
  constructor(
    private readonly tokenProvider: TokenProvider,
    private readonly transport: Transport,
    private readonly opts: PolestarClientOptions,
  ) {}

  /**
   * A view of this client that sends `x-delegated-account-id` for one call.
   * Returns a new client rather than mutating: concurrent calls must not change
   * each other's identity, and the API answers 200 for an unknown delegation
   * instead of refusing it, so which account served a result is part of it.
   */
  forDelegation(delegatedAccountId: string | undefined): PolestarClient {
    if (delegatedAccountId === undefined || delegatedAccountId === '' || delegatedAccountId === this.opts.delegatedAccountId) return this;
    return new PolestarClient(this.tokenProvider, this.transport, { ...this.opts, delegatedAccountId });
  }

  /** VINs this credential is authorized to access. */
  async vehicles(): Promise<string[]> {
    const { status, parsed } = await this.request('/v1/vehicles');
    const data = (parsed as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new PolestarApiError('BAD_RESPONSE', 'GET /v1/vehicles response has no data array.', status);
    }
    return data.map(String);
  }

  /**
   * Resolve the VIN a tool call should target. An omitted VIN means "the only
   * vehicle" (the overwhelmingly common personal-credential case); an
   * ambiguous credential must be told apart, and a malformed VIN is rejected
   * with a pointer to list_vehicles.
   */
  async resolveVin(vin: string | undefined): Promise<string> {
    const normalized = vin?.trim().toUpperCase();
    if (normalized !== undefined && normalized !== '') {
      if (!VIN_RE.test(normalized)) {
        throw new PolestarApiError(
          'INVALID_VIN',
          `"${vin}" is not a plausible VIN (17 characters, no I/O/Q). Call list_vehicles for valid VINs.`,
          400,
        );
      }
      return normalized;
    }
    const vins = await this.vehicles();
    if (vins.length === 1) return vins[0]!;
    if (vins.length === 0) {
      throw new PolestarApiError('NO_VEHICLES', 'This credential is not authorized for any vehicle.', 404);
    }
    throw new PolestarApiError(
      'AMBIGUOUS_VIN',
      `This credential has ${vins.length} vehicles; pass an explicit vin. Known VINs: ${vins.join(', ')}`,
      400,
    );
  }

  /**
   * Fetch one domain (e.g. telemetry/battery) for a vehicle, unwrapped to the
   * `data` payload. Returns null when the vehicle reports no data for the
   * domain (404 DATA_NOT_AVAILABLE: every field a car has not reported is
   * simply absent).
   */
  async domain(vin: string, kind: DomainKind, name: string): Promise<Record<string, unknown> | null> {
    // The privacy switch is enforced here rather than in each caller: a tool
    // that forgets to check it would otherwise still fetch the position and
    // spend quota on data the operator asked never to collect.
    if (this.opts.allowLocation === false && name === 'location' && kind === 'telemetry') {
      throw new PolestarApiError(
        'LOCATION_DISALLOWED',
        'Position data is disabled for this server (POLESTAR_ALLOW_LOCATION=false); the request was never sent.',
        403,
      );
    }
    const path = `/v1/vehicles/${encodeURIComponent(vin)}/${kind}/${name}`;
    const res = await this.requestRaw(path);

    if (res.status === 404 && parseErrorBody(res.body)?.error?.code === 'DATA_NOT_AVAILABLE') {
      return null;
    }
    if (res.status >= 400) throw toApiError(res);

    const envelope = parseJson(res.body);
    if (envelope === null) {
      throw new PolestarApiError('BAD_RESPONSE', `Domain ${kind}/${name} returned a non-JSON body.`, res.status);
    }
    if (typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new PolestarApiError('BAD_RESPONSE', `Domain ${kind}/${name} returned a non-object body.`, res.status);
    }
    const data = (envelope as { data?: unknown }).data;
    if (data !== undefined && data !== null && !(typeof data === 'object' && !Array.isArray(data))) {
      throw new PolestarApiError('BAD_RESPONSE', `Domain ${kind}/${name} returned a non-object data payload.`, res.status);
    }
    assertIdentity(envelope, data, vin, kind, name);
    return (data ?? null) as Record<string, unknown> | null;
  }

  private async request(path: string): Promise<{ status: number; parsed: unknown }> {
    const res = await this.requestRaw(path);
    if (res.status >= 400) throw toApiError(res);
    const parsed = parseJson(res.body);
    if (parsed === null) {
      throw new PolestarApiError('BAD_RESPONSE', `GET ${path} returned a non-JSON body.`, res.status);
    }
    return { status: res.status, parsed };
  }

  private async requestRaw(path: string, attempt = 0): Promise<TransportResponse> {
    const token = await this.tokenProvider.token();
    const res = await this.transport.fetch(`${this.opts.baseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-client-id': this.opts.accountId,
        ...(this.opts.delegatedAccountId ? { 'x-delegated-account-id': this.opts.delegatedAccountId } : {}),
        accept: 'application/json',
      },
    });
    if (res.status === 401 && attempt === 0) {
      this.tokenProvider.invalidate();
      return this.requestRaw(path, attempt + 1);
    }
    return res;
  }
}

/**
 * The envelope carries {domain, vin}, and payloads repeat the VIN. If the
 * response is labelled a different vehicle than the one requested, returning it
 * would present one car's telemetry as another's, so refuse instead. Guards
 * against mislabelled fixtures and upstream routing surprises alike.
 */
function assertIdentity(
  envelope: object,
  data: unknown,
  vin: string,
  kind: DomainKind,
  name: string,
): void {
  const meta = (envelope as { meta?: { vin?: unknown; domain?: unknown } }).meta;
  const wanted = vin.toUpperCase();
  const actual = typeof meta?.vin === 'string' ? meta.vin.toUpperCase() : undefined;
  if (actual !== undefined && actual !== wanted) {
    throw new PolestarApiError(
      'VIN_MISMATCH',
      `Requested ${wanted} but the ${kind}/${name} response is labelled ${actual}.`,
      200,
    );
  }
  const actualDomain = typeof meta?.domain === 'string' ? meta.domain.toLowerCase() : undefined;
  if (actualDomain !== undefined && actualDomain !== name.toLowerCase()) {
    throw new PolestarApiError(
      'DOMAIN_MISMATCH',
      `Requested ${kind}/${name} but the response is labelled ${kind}/${actualDomain}.`,
      200,
    );
  }
  // Payloads repeat the VIN inside data too; check it when present.
  const dataVin =
    data !== null && typeof data === 'object' && !Array.isArray(data) && typeof (data as { vin?: unknown }).vin === 'string'
      ? ((data as { vin: string }).vin as string).toUpperCase()
      : undefined;
  if (dataVin !== undefined && dataVin !== wanted) {
    throw new PolestarApiError('VIN_MISMATCH', `Response data is for ${dataVin}, not the requested ${wanted}.`, 200);
  }
}
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function parseErrorBody(body: string): ApiErrorEnvelope | null {
  const parsed = parseJson(body);
  return parsed !== null && typeof parsed === 'object' ? (parsed as ApiErrorEnvelope) : null;
}

function toApiError(res: TransportResponse): PolestarApiError {
  const err = parseErrorBody(res.body)?.error;
  if (err && typeof err === 'object') {
    const code = typeof err.code === 'string' ? err.code : `HTTP_${res.status}`;
    const message = typeof err.message === 'string' ? err.message : `Request failed (HTTP ${res.status}).`;
    return new PolestarApiError(
      code,
      message,
      typeof err.httpStatus === 'number' ? err.httpStatus : res.status,
      typeof err.requestId === 'string' ? err.requestId : undefined,
      typeof err.timestamp === 'string' ? err.timestamp : undefined,
      err.details,
    );
  }
  return new PolestarApiError(`HTTP_${res.status}`, `Request failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`, res.status);
}
