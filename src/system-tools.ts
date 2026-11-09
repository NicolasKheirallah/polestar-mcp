import type { CacheStats } from './caching-transport.js';
import type { BudgetMeter, MinuteWindowMeter } from './budget.js';
import { EXPIRY_SKEW_MS } from './auth.js';
import { withData, type ToolDeps } from './tool-output.js';
import type { ToolSpec } from './tools.js';

export interface SystemDeps extends ToolDeps {
  budget: BudgetMeter;
  /** Rolling per-minute ceiling, reported next to the daily budget. */
  minute: MinuteWindowMeter;
  cacheStats: CacheStats;
  /** Epoch ms when the current access token stops being trusted. */
  tokenExpiresAt: () => number | undefined;
  fixtureMode: boolean;
  /**
   * The background sampler, when history is on. It describes itself: it holds the
   * cadence it actually runs at and the guard it actually uses.
   */
  sampler?: { describe(): string } | undefined;
}

/**
 * polestar_status: self-observation for the agent. The API has hard daily and
 * per-minute ceilings, so an agent that can see the budget, the cache
 * efficiency and the token clock can pace itself instead of tripping the
 * fail-closed guards.
 */
export function systemToolSpecs(deps: SystemDeps): ToolSpec[] {
  return [
    {
      name: 'polestar_status',
      title: 'Server status',
      description:
        'Server self-report: daily API budget (used/limit/reset), per-minute ceiling, cache hit rate, token expiry, and mode. Call this if you suspect you are burning through the daily API budget.',
      annotations: { readOnlyHint: true },
      run: async () => {
        const budget = deps.budget.snapshot();
        const minute = deps.minute.snapshot();
        const cache = deps.cacheStats;
        const lines = [
          `Mode: ${deps.fixtureMode ? 'fixture (offline)' : 'live'}`,
          `API budget: ${budget.used}/${budget.limit} used (${budget.remaining} left), resets ${budget.resetsAtUtc}`,
          `Per-minute ceiling: ${minute.used}/${minute.limit} used in this minute`,
        ];
        // Sampling spends the same daily budget as an agent's questions, so an
        // operator has to be able to see it is happening without reading stderr.
        if (deps.sampler !== undefined) lines.push(`Background sampling: ${deps.sampler.describe()}`);
        if (cache.enabled) {
          const totalReads = cache.hits + cache.staleServed + cache.misses;
          const hitRate = totalReads === 0 ? 0 : Math.round(((cache.hits + cache.staleServed) / totalReads) * 100);
          lines.push(
            `Cache: ${cache.hits} hits + ${cache.staleServed} stale-served of ${totalReads} reads (${hitRate}%), ${cache.misses} live misses, ${cache.refreshes} refreshes, ${cache.entries} entries`,
          );
        } else {
          lines.push('Cache: off (POLESTAR_CACHE=off, or fixture mode without a history store)');
        }
        const expiresAt = deps.tokenExpiresAt();
        // The clock is injected like every other one this server reads, so the
        // reported expiry can be asserted instead of drifting with the wall.
        const nowMs = deps.nowMs?.() ?? Date.now();
        // The provider refetches before the advertised expiry, so report the life
        // it will actually use; the advertised number overstates it by the skew.
        const trustedUntil = expiresAt !== undefined ? expiresAt - EXPIRY_SKEW_MS : undefined;
        const trustedMinutes =
          trustedUntil === undefined ? undefined : Math.max(0, Math.round((trustedUntil - nowMs) / 60_000));
        lines.push(
          trustedMinutes !== undefined ? `Token: trusted ~${trustedMinutes} more min` : 'Token: not yet issued',
        );
        // The same facts as fields, so a client can pace itself without parsing
        // the prose: the budget arithmetic, the cache counters and the token
        // clock are the reasons this tool exists.
        const totalReads = cache.hits + cache.staleServed + cache.misses;
        return withData(lines.join('\n'), {
          mode: deps.fixtureMode ? 'fixture' : 'live',
          budget: {
            used: budget.used,
            limit: budget.limit,
            remaining: budget.remaining,
            resetsAtUtc: budget.resetsAtUtc,
          },
          minute: { used: minute.used, limit: minute.limit },
          cache: {
            enabled: cache.enabled,
            hits: cache.hits,
            staleServed: cache.staleServed,
            misses: cache.misses,
            refreshes: cache.refreshes,
            entries: cache.entries,
            ...(cache.enabled && totalReads > 0
              ? { hitRatePct: Math.round(((cache.hits + cache.staleServed) / totalReads) * 100) }
              : {}),
          },
          token:
            trustedUntil === undefined
              ? { issued: false }
              : { expiresAt, trustedUntil, trustedMinutes },
          ...(deps.sampler === undefined ? {} : { sampling: deps.sampler.describe() }),
        });
      },
    },
  ];
}
