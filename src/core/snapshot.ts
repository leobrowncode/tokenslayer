import type { Config } from './config';
import { buildAdvice, topLevel } from './advisor';
import { type CollectContext, type Provider, baseSnapshot } from './providers/provider';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';
import { CursorProvider } from './providers/cursor';
import { clampPercent, totalTokens } from './tokens';
import type { OverlaySnapshot, ProviderSnapshot } from './types';

export function createProviders(): Provider[] {
  return [new CursorProvider(), new ClaudeProvider(), new CodexProvider()];
}

export async function collectSnapshot(
  providers: Provider[],
  config: Config,
  opts: Omit<CollectContext, 'config' | 'now'> & { now?: number } = {},
): Promise<OverlaySnapshot> {
  const now = opts.now ?? Date.now();
  const ctx: CollectContext = { ...opts, now, config };
  const enabled = providers.filter((p) => config.providers[p.id]);
  const results: ProviderSnapshot[] = await Promise.all(
    enabled.map(async (p) => {
      try {
        return await p.collect(ctx);
      } catch (err) {
        const s = baseSnapshot(p.id, p.name);
        s.detected = true;
        s.error = err instanceof Error ? err.message : String(err);
        return s;
      }
    }),
  );
  for (const r of results) r.tokensToday = totalTokens(r.usageToday, config.includeCacheReads);

  const tokensToday = results.reduce((s, r) => s + r.tokensToday, 0);
  const budget = config.dailyTokenBudget;
  const advice = buildAdvice(results, config);
  return {
    generatedAt: now,
    tokensToday,
    dailyBudget: budget,
    budgetPercent: budget > 0 ? clampPercent((tokensToday / budget) * 100) : 0,
    includeCacheReads: config.includeCacheReads,
    providers: results,
    advice,
    topLevel: topLevel(advice),
    thresholds: { compactAt: config.compactAtPercent, newChatAt: config.newChatAtPercent },
  };
}
