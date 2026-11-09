import type { Transport, TransportRequest, TransportResponse } from './transport.js';
import { findDomain, parseDomainPath, VEHICLES_PATH, VEHICLES_TTL_MS } from './domains.js';

export interface CacheStats {
  /** False when the cache was constructed disabled, so polestar_status can say so. */
  enabled: boolean;
  hits: number;
  misses: number;
  /** Responses served from an expired entry while a refresh was in flight. */
  staleServed: number;
  refreshes: number;
  entries: number;
}

export interface CachingTransportOptions {
  disabled?: boolean;
  /** Injectable clock for tests. */
  now?: () => number;
  /**
   * Called when a stale-while-revalidate refresh fails. Without this the failed
   * refresh was a dropped promise: the cache kept serving an entry that got
   * staler by the minute, with no signal anywhere.
   */
  onRefreshError?: (detail: { url: string; message: string }) => void;
}

interface CacheEntry {
  response: TransportResponse;
  fetchedAt: number;
  ttlMs: number;
}

/**
 * Cache lifetime comes from the registry: a Domain row states how long its own
 * value stays believable. A path that matches no row (the vehicle list, or
 * anything unexpected) gets the conservative default below.
 */
const DEFAULT_TTL_MS = 60 * 1000;

/**
 * An absent Domain is a stable answer, not a transient failure: the reference
 * car answers 404 DATA_NOT_AVAILABLE for is-at-charge-location whatever we ask.
 * Keeping it for a minute stops every question about an unreported Domain from
 * spending live quota, while a car that starts reporting it becomes visible
 * again shortly. Errors that could be a credential or rate problem (403, 429)
 * are never stored.
 */
const DATA_NOT_AVAILABLE_TTL_MS = 60 * 1000;

function findDomainTtl(ref: { kind: string; name: string }): number {
  const spec = findDomain(ref.kind, ref.name);
  if (spec === undefined) throw new Error(`parseDomainPath returned an unknown Domain ${ref.kind}/${ref.name}`);
  return spec.ttlMs;
}

/** Header lookup for the identity headers; HTTP header names are case-insensitive. */
function headerValue(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return '';
}

/**
 * Entries are keyed by the URL and the credential that asked, because the
 * identity travels in headers rather than the URL. A URL-only key served the
 * owner's cached vehicle list to a delegated partner read, which is a
 * cross-account disclosure on any process that uses delegation.
 */
function cacheKey(url: string, request: TransportRequest): string {
  const headers = request.headers ?? {};
  return JSON.stringify([url, headerValue(headers, 'x-client-id'), headerValue(headers, 'x-delegated-account-id')]);
}

/** True only for the API's "this vehicle does not report that Domain" 404. */
function isDataNotAvailable(response: TransportResponse): boolean {
  if (response.status !== 404) return false;
  try {
    const parsed = JSON.parse(response.body) as { error?: { code?: unknown } };
    return parsed?.error?.code === 'DATA_NOT_AVAILABLE';
  } catch {
    return false;
  }
}

/**
 * The API allows 10,000 calls per client per day and 100 per minute, so every
 * repeated read must be served locally. Each Domain states its own lifetime;
 * while an entry is fresh the cache answers without touching the network. Once
 * expired, the caller gets the last known value immediately (marked stale) and a
 * single-flight refresh runs in the background, so latency never waits on Polestar
 * and concurrent callers share one refresh.
 *
 * Each lifetime comes from the Domain's own registry row, chosen for how fast
 * that value can actually change. The car pushes updates to the cloud on state
 * changes, so polling faster than a Domain's lifetime buys nothing.
 *
 * The token POST, other non-GET requests and error responses pass straight
 * through, except the short-lived negative entry for an unreported Domain.
 */
export class CachingTransport implements Transport {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<TransportResponse>>();
  private readonly now: () => number;
  readonly stats: CacheStats;

  constructor(
    private readonly inner: Transport,
    private readonly opts: CachingTransportOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.stats = { enabled: opts.disabled !== true, hits: 0, misses: 0, staleServed: 0, refreshes: 0, entries: 0 };
  }

  async fetch(url: string, request: TransportRequest = {}): Promise<TransportResponse> {
    const method = request.method ?? 'GET';
    const ttl = this.ttlFor(url);
    // Only cacheable GETs participate in the cache; the token POST and any
    // TTL-less route pass straight through.
    if (this.opts.disabled || method !== 'GET' || ttl === 0) {
      return this.inner.fetch(url, request);
    }

    const key = cacheKey(url, request);
    const entry = this.entries.get(key);
    const t = this.now();

    if (entry && t < entry.fetchedAt + entry.ttlMs) {
      this.stats.hits += 1;
      return entry.response;
    }

    if (entry) {
      // Expired: serve the last known value now, refresh in the background.
      this.stats.staleServed += 1;
      // The refresh runs in the background on purpose: the caller already has an
      // answer. Its failure is reported through onRefreshError, so the rejection
      // is consumed here rather than escaping as an unhandled one.
      void this.revalidate(key, url, request).catch(() => undefined);
      return entry.response;
    }

    this.stats.misses += 1;
    const response = await this.revalidate(key, url, request);
    return response;
  }

  private revalidate(key: string, url: string, request: TransportRequest): Promise<TransportResponse> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this.inner
      .fetch(url, request)
      .then((response) => {
        const ttlMs = this.cacheableTtl(response, url);
        if (ttlMs !== undefined) {
          this.entries.set(key, { response, fetchedAt: this.now(), ttlMs });
        }
        this.stats.refreshes += 1;
        return response;
      })
      .catch((err: unknown) => {
        this.opts.onRefreshError?.({ url, message: err instanceof Error ? err.message : String(err) });
        throw err;
      })
      .finally(() => {
        this.inflight.delete(key);
        this.stats.entries = this.entries.size;
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** How long this response stays usable: the Domain's own TTL, or the negative TTL. */
  private cacheableTtl(response: TransportResponse, url: string): number | undefined {
    if (response.status < 400) return this.ttlFor(url);
    return isDataNotAvailable(response) ? DATA_NOT_AVAILABLE_TTL_MS : undefined;
  }

  /** The Domain's own freshness rule, or the conservative default. */
  private ttlFor(url: string): number {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith(VEHICLES_PATH)) return VEHICLES_TTL_MS;
    const ref = parseDomainPath(pathname);
    return ref === undefined ? DEFAULT_TTL_MS : findDomainTtl(ref);
  }
}
