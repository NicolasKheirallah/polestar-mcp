import type { CacheStats } from './caching-transport.js';
import type { BudgetMeter, MinuteWindowMeter } from './budget.js';
import { text, type ToolDeps } from './tool-output.js';
import type { ToolSpec } from './tools.js';

export interface SystemDeps extends ToolDeps {
  budget: BudgetMeter;
  /** Rolling per-minute ceiling, reported next to the daily budget. */
  minute: MinuteWindowMeter;
  cacheStats: CacheStats | undefined;
  /** Epoch ms when the current access token stops being trusted. */
  tokenExpiresAt: () => number | undefined;
  fixtureMode: boolean;
  /** Human-readable background-sampling state; undefined when history is off. */
  samplerState?: () => string | undefined;
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
        const sampling = deps.samplerState?.();
        if (sampling !== undefined) lines.push(`Background sampling: ${sampling}`);
        if (cache !== undefined) {
          const totalReads = cache.hits + cache.staleServed + cache.misses;
          const hitRate = totalReads === 0 ? 0 : Math.round(((cache.hits + cache.staleServed) / totalReads) * 100);
          lines.push(
            `Cache: ${cache.hits} hits + ${cache.staleServed} stale-served of ${totalReads} reads (${hitRate}%), ${cache.misses} live misses, ${cache.refreshes} refreshes, ${cache.entries} entries`,
          );
        } else {
          lines.push('Cache: off (fixture mode serves local files)');
        }
        const expiresAt = deps.tokenExpiresAt();
        lines.push(
          expiresAt !== undefined
            ? `Token: trusted ~${Math.max(0, Math.round((expiresAt - Date.now()) / 60_000))} more min`
            : 'Token: not yet issued',
        );
        return text(lines.join('\n'));
      },
    },
  ];
}
