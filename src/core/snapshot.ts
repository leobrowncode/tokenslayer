import type { Config } from './config';
import { applyActivity, listProcessNames, runningTools } from './activity';
import { buildAdvice, topLevel } from './advisor';
import { type CollectContext, type Provider, baseSnapshot } from './providers/provider';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';
import { CursorProvider } from './providers/cursor';
import { clampPercent, totalTokens } from './tokens';
import type { OverlaySnapshot, ProviderId, ProviderSnapshot } from './types';

export function createProviders(): Provider[] {
  return [new CursorProvider(), new ClaudeProvider(), new CodexProvider()];
}

export interface SnapshotOptions extends Omit<CollectContext, 'config' | 'now'> {
  now?: number;
  /** Lists running process names; defaults to `tasklist` / `ps`. */
  listProcesses?: () => Promise<string[]>;
}

async function detectRunning(cfg: Config, list: () => Promise<string[]>): Promise<Set<ProviderId> | undefined> {
  if (!cfg.activity.processes) return undefined;
  try {
    return runningTools(await list());
  } catch {
    return undefined;
  }
}

export async function collectSnapshot(providers: Provider[], config: Config, opts: SnapshotOptions = {}): Promise<OverlaySnapshot> {
  const { listProcesses = listProcessNames, ...rest } = opts;
  const now = opts.now ?? Date.now();
  const ctx: CollectContext = { ...rest, now, config };
  const enabled = providers.filter((p) => config.providers[p.id]);
  const [results, running] = await Promise.all([
    Promise.all(
      enabled.map(async (p): Promise<ProviderSnapshot> => {
        try {
          return await p.collect(ctx);
        } catch (err) {
          const s = baseSnapshot(p.id, p.name);
          s.detected = true;
          s.error = err instanceof Error ? err.message : String(err);
          return s;
        }
      }),
    ),
    detectRunning(config, listProcesses),
  ]);
  for (const r of results) r.tokensToday = totalTokens(r.usageToday, config.includeCacheReads);
  applyActivity(results, running, config, now);

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
