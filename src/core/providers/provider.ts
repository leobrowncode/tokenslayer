import type { Config } from '../config';
import type { ChatInfo, ProviderId, ProviderSnapshot } from '../types';
import { clampPercent, emptyUsage } from '../tokens';

export interface CollectContext {
  now: number;
  config: Config;
  /** Bypass the network throttle (e.g. "Refresh now" from the tray). */
  forceNetwork?: boolean;
  fetchImpl?: typeof fetch;
}

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  collect(ctx: CollectContext): Promise<ProviderSnapshot>;
}

export function baseSnapshot(id: ProviderId, name: string): ProviderSnapshot {
  return { id, name, detected: false, inUse: false, running: false, usageToday: emptyUsage(), tokensToday: 0, chats: [], limits: [], notes: [] };
}

export function makeChat(c: Omit<ChatInfo, 'contextPercent'>): ChatInfo {
  const pct = c.contextWindow > 0 ? (c.contextTokens / c.contextWindow) * 100 : 0;
  return { ...c, contextPercent: Math.round(clampPercent(pct) * 10) / 10 };
}

/** Remote usage endpoints are polled at most once per `network.intervalSeconds`. */
export class RemoteThrottle<T> {
  value?: T;
  error?: string;
  private lastAttempt = 0;
  private inFlight?: Promise<void>;

  async refresh(ctx: CollectContext, fn: () => Promise<T>): Promise<void> {
    const due = ctx.forceNetwork || ctx.now - this.lastAttempt >= ctx.config.network.intervalSeconds * 1000;
    if (!due) return;
    if (this.inFlight) return this.inFlight;
    this.lastAttempt = ctx.now;
    this.inFlight = fn()
      .then((v) => {
        this.value = v;
        this.error = undefined;
      })
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}

export async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded HTTP ${res.status}`);
  return res.json();
}
