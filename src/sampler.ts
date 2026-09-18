import { DOMAINS } from './domains.js';
import type { PolestarClient } from './client.js';
import type { BudgetMeter } from './budget.js';

export interface SamplerOptions {
  /** Seconds between sample rounds. Clamped to [60, 3600]. */
  intervalSeconds?: number;
  /** Pause sampling when this fraction of the daily budget is spent. */
  budgetGuardFraction?: number;
  /** Injectable wait for tests; production waits on a real unref'd timer. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Optional background sampler that feeds the history store even when no MCP
 * client is asking questions. Defaults to one round per 10 minutes across the
 * four fast-moving domains (~576 calls/day per vehicle of the 10,000 budget, so a
 * three-car credential spends three times that) and stands
 * down entirely once 80% of the daily budget is spent, sampling must never
 * be the thing that exhausts the credential.
 */
export class HistorySampler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  private readonly intervalMs: number;
  private readonly budgetGuardFraction: number;

  constructor(
    private readonly client: PolestarClient,
    private readonly budget: BudgetMeter,
    private readonly sample: (vin: string) => Promise<void>,
    private readonly opts: SamplerOptions = {},
  ) {
    this.intervalMs = intervalSeconds(opts.intervalSeconds) * 1000;
    this.budgetGuardFraction = opts.budgetGuardFraction ?? SAMPLER_BUDGET_GUARD;
  }

  /**
   * Begin sampling. With no explicit VIN list the sampler resolves them from
   * the credential itself, so the caller only has to decide whether sampling is
   * allowed at all, that decision is POLESTAR_SAMPLE, and it defaults to off
   * because background polling is exactly what the daily quota is for.
   */
  async start(vins?: string[]): Promise<number> {
    if (this.timer !== undefined) return 0;
    const targets = vins ?? (await this.client.vehicles().catch(() => [] as string[]));
    if (targets.length === 0) return 0;
    const tickVins = targets;
    const tick = async (): Promise<void> => {
      if (this.running) return;
      this.running = true;
      try {
        if (this.budget.isLow(this.budgetGuardFraction)) {
          this.opts.log?.(`sampler standing down: ${Math.round(this.budget.snapshot().fractionUsed * 100)}% of daily budget spent`);
          return;
        }
        for (const vin of tickVins) {
          await this.sample(vin);
        }
      } catch (err) {
        this.opts.log?.(`sampler round failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        this.running = false;
      }
    };
    const schedule = (): void => {
      if (this.stopped) return;
      if (this.opts.sleep !== undefined) {
        void this.opts.sleep(this.intervalMs).then(async () => {
          if (this.stopped) return;
          await tick();
          schedule();
        });
        return;
      }
      this.timer = setTimeout(() => {
        void tick().finally(schedule);
      }, this.intervalMs);
      this.timer.unref?.();
    };
    schedule();
    return tickVins.length;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** The fraction of the daily budget at which background sampling stands down. */
export const SAMPLER_BUDGET_GUARD = 0.8;

/**
 * The fast movers worth sampling, derived from the registry rather than a list
 * that had to be remembered beside it. A Domain opts in with `sampled: true`.
 */
export const SAMPLED_DOMAINS: { kind: 'telemetry' | 'charging'; name: string }[] = DOMAINS.filter((d) => d.sampled).map(({ kind, name }) => ({ kind, name }));

/** The sampler's real cadence: what was asked for, clamped into the safe band. */
export function intervalSeconds(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? 600, 60), 3_600);
}
