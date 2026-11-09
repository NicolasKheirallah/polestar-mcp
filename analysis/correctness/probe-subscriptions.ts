/**
 * Probes for the subscription poller (src/subscriptions.ts):
 *  A) a notify() failure loses the change forever, because lastEventId is
 *     updated before notify is awaited and the rejection is swallowed.
 *  B) two overlapping pollOnce() rounds (the default clock is a setInterval,
 *     and a round takes as long as its reads) both notify for one change,
 *     because `seen` is destructured from a snapshot taken before the awaits.
 */
import { createSubscriptionPoller } from '../../src/subscriptions.js';

const URI = 'polestar://vehicle/YSMTEST22PL000001/telemetry/battery';

// A: notify failure
const notifiedA: string[] = [];
const readsA: string[] = [];
let failNextNotify = true;
let eventA = 'e1';
const pollerA = createSubscriptionPoller({
  async read() {
    readsA.push(eventA);
    return { metaEventId: eventA };
  },
  budget: { isLow: () => false },
  async notify(uri) {
    if (failNextNotify) {
      failNextNotify = false;
      throw new Error('transport closed');
    }
    notifiedA.push(uri);
  },
  log: () => undefined,
  setTimer: () => ({ unref: () => undefined }),
  clearTimer: () => undefined,
});
await pollerA.subscribe(URI); // primes e1
eventA = 'e2';
await pollerA.pollOnce(); // read e2, notify throws, change recorded as seen
await pollerA.pollOnce(); // read e2 again: no change left to report
await pollerA.pollOnce();

// B: overlapping rounds
const notifiedB: string[] = [];
let readsB: string[] = [];
let pendingB: Array<(value: { metaEventId: string }) => void> = [];
const pollerB = createSubscriptionPoller({
  read() {
    return new Promise<{ metaEventId: string }>((resolve) => {
      pendingB.push(resolve);
    }).then((value) => {
      readsB.push(value.metaEventId);
      return value;
    });
  },
  budget: { isLow: () => false },
  async notify(uri) {
    notifiedB.push(uri);
  },
  log: () => undefined,
  setTimer: () => ({ unref: () => undefined }),
  clearTimer: () => undefined,
});
const subscribing = pollerB.subscribe(URI);
// resolve the priming read with e1
await new Promise((r) => setImmediate(r));
pendingB.shift()?.({ metaEventId: 'e1' });
await subscribing;
// two ticks overlap: both snapshot seen=e1 before either reads
readsB = [];
const round1 = pollerB.pollOnce();
const round2 = pollerB.pollOnce();
await new Promise((r) => setImmediate(r));
pendingB.shift()?.({ metaEventId: 'e2' });
pendingB.shift()?.({ metaEventId: 'e2' });
await Promise.all([round1, round2]);

console.log(
  JSON.stringify(
    {
      A_notify_failure: { reads: readsA, notified: notifiedA, note: 'e2 was never delivered; later rounds see no change' },
      B_overlapping_rounds: { reads: readsB, notified: notifiedB, note: 'one cloud change, two notifications' },
    },
    null,
    2,
  ),
);
