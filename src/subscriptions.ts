import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { parseResourceUri } from './domains.js';

/** Standard VIN alphabet: 17 characters, no I, O or Q. */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

/**
 * A subscription is a timer that spends the shared daily allowance every minute.
 * Unbounded, a client could register hundreds for one vehicle and turn one
 * session into thousands of reads a day; 50 covers a fleet view of one Domain
 * across dozens of vehicles and keeps the unsupervised spend bounded.
 */
export const MAX_SUBSCRIPTIONS = 50;

/**
 * Subscription bookkeeping for `polestar://vehicle/{vin}/{kind}/{domain}` URIs.
 *
 * The SDK declares the protocol and nothing else: someone has to re-read the
 * targets, notice what changed, and tell clients. That used to live inside
 * `createMcpServer`, where the only way to observe it was to run a stdio server
 * for a minute. Here the interface is four methods and the clock is a parameter.
 */
export interface SubscriptionDeps {
  /** One read of one Domain, as the client would answer it. */
  read(vin: string, kind: 'telemetry' | 'charging', name: string): Promise<Record<string, unknown> | null>;
  /** Used to pause rather than spend the last tenth of the daily budget. */
  budget: { isLow(fraction: number): boolean };
  notify(uri: string): Promise<void>;
  log(message: string): void;
  /** Default one minute; a test drives it by passing its own timer. */
  intervalMs?: number | undefined;
  setTimer?: (callback: () => void, ms: number) => { unref?(): void };
  clearTimer?: (handle: { unref?(): void }) => void;
}

export interface SubscriptionPoller {
  /** Subscribe; the first read primes the change detector. */
  subscribe(uri: string): Promise<void>;
  unsubscribe(uri: string): void;
  /** One round of polling. Public so a test, or a caller, need not wait. */
  pollOnce(): Promise<void>;
  /** Finish: stop the clock and forget every target. Idempotent. */
  stop(): void;
  readonly size: number;
}

/**
 * Reject anything that is not a readable subscription target as a JSON-RPC
 * invalid-params error. A typo used to start a timer that polled a URI nobody
 * could answer, sixty seconds at a time, with no way for the client to see it
 * had asked for the wrong thing.
 */
function invalidSubscription(uri: string, why: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Invalid subscription URI ${JSON.stringify(uri)}: ${why} Expected polestar://vehicle/{vin}/{telemetry|charging}/{domain} with a 17-character VIN.`,
  );
}

export function createSubscriptionPoller(deps: SubscriptionDeps): SubscriptionPoller {
  const intervalMs = deps.intervalMs ?? 60_000;
  const setTimer = deps.setTimer ?? ((cb, ms) => { const t = setInterval(cb, ms); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  const lastEventId = new Map<string, string | undefined>();
  let timer: { unref?(): void } | undefined;
  /** One round at a time: a slow read must not stack the next tick on top of it. */
  let polling = false;

  const target = (uri: string) => {
    const ref = parseResourceUri(uri);
    return ref !== undefined && VIN_RE.test(ref.vin) ? ref : undefined;
  };

  function start(): void {
    if (timer !== undefined) return;
    timer = setTimer(() => void pollOnce().catch(() => undefined), intervalMs);
  }

  function stopTimer(): void {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  }

  async function subscribe(uri: string): Promise<void> {
    const ref = target(uri);
    if (ref === undefined) {
      throw invalidSubscription(uri, 'the URI does not name a registered Domain of a 17-character VIN.');
    }
    if (!lastEventId.has(uri) && lastEventId.size >= MAX_SUBSCRIPTIONS) {
      throw invalidSubscription(
        uri,
        `this session already holds ${MAX_SUBSCRIPTIONS} subscriptions, the cap. Unsubscribe one resource before adding another.`,
      );
    }
    try {
      const data = await deps.read(ref.vin, ref.kind, ref.name);
      lastEventId.set(uri, (data?.metaEventId as string | undefined) ?? undefined);
    } catch {
      lastEventId.set(uri, undefined);
    }
    start();
  }

  function unsubscribe(uri: string): void {
    lastEventId.delete(uri);
    if (lastEventId.size === 0) stopTimer();
  }

  /**
   * Finish for good: stop the clock and drop every target.
   *
   * Stopping the timer alone left `size` reporting subscriptions that nothing was
   * polling, so a host asking a finished surface how much work it had in flight
   * got the wrong answer, and the VINs stayed reachable from a map nobody would
   * read again.
   */
  function finish(): void {
    stopTimer();
    lastEventId.clear();
  }

  async function pollOnce(): Promise<void> {
    if (polling) return;
    if (lastEventId.size === 0) {
      stopTimer();
      return;
    }
    polling = true;
    try {
      // Subscriptions are the server acting on its own, so they are the first thing
      // to stop when the allowance runs low: an agent's question outranks a poll.
      if (deps.budget.isLow(0.9)) {
        deps.log('resource subscriptions paused: at least 90% of the daily budget spent');
        return;
      }
      for (const [uri, seen] of [...lastEventId.entries()]) {
        const ref = target(uri);
        if (ref === undefined) continue;
        try {
          const data = await deps.read(ref.vin, ref.kind, ref.name);
          const eventId = data?.metaEventId as string | undefined;
          // The cloud re-serves the same id until the car reports something new, so
          // an id change is the only notification worth sending. The new id is
          // stored only after the client has accepted the notification: a dropped
          // notify used to advance the marker and lose that change forever.
          if (eventId !== undefined && eventId !== seen) {
            await deps.notify(uri);
            lastEventId.set(uri, eventId);
          }
        } catch {
          // A failed read or notification keeps the previous state; the next round retries.
        }
      }
    } finally {
      polling = false;
    }
  }

  return {
    subscribe,
    unsubscribe,
    pollOnce,
    stop: finish,
    get size() {
      return lastEventId.size;
    },
  };
}
