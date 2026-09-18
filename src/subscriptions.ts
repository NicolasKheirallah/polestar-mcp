import { parseResourceUri } from './domains.js';
import type { MinuteWindowMeter } from './budget.js';

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
  minute?: MinuteWindowMeter;
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
  stop(): void;
  readonly size: number;
}

export function createSubscriptionPoller(deps: SubscriptionDeps): SubscriptionPoller {
  const intervalMs = deps.intervalMs ?? 60_000;
  const setTimer = deps.setTimer ?? ((cb, ms) => { const t = setInterval(cb, ms); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  const lastEventId = new Map<string, string | undefined>();
  let timer: { unref?(): void } | undefined;

  const target = (uri: string) => parseResourceUri(uri);

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
    if (ref !== undefined) {
      try {
        const data = await deps.read(ref.vin, ref.kind, ref.name);
        lastEventId.set(uri, (data?.metaEventId as string | undefined) ?? undefined);
      } catch {
        lastEventId.set(uri, undefined);
      }
    }
    start();
  }

  function unsubscribe(uri: string): void {
    lastEventId.delete(uri);
    if (lastEventId.size === 0) stopTimer();
  }

  async function pollOnce(): Promise<void> {
    if (lastEventId.size === 0) {
      stopTimer();
      return;
    }
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
        // an id change is the only notification worth sending.
        if (eventId !== undefined && eventId !== seen) {
          lastEventId.set(uri, eventId);
          await deps.notify(uri);
        }
      } catch {
        // A failed round keeps the previous state; the next round retries.
      }
    }
  }

  return {
    subscribe,
    unsubscribe,
    pollOnce,
    stop: stopTimer,
    get size() {
      return lastEventId.size;
    },
  };
}
