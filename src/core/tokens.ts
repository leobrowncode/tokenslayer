import type { TokenUsage } from './types';

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

export function addUsage(target: TokenUsage, u: TokenUsage): TokenUsage {
  target.input += u.input;
  target.output += u.output;
  target.cacheWrite += u.cacheWrite;
  target.cacheRead += u.cacheRead;
  return target;
}

export function totalTokens(u: TokenUsage, includeCacheReads: boolean): number {
  return u.input + u.output + u.cacheWrite + (includeCacheReads ? u.cacheRead : 0);
}

export function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Accepts epoch ms, epoch seconds, numeric strings or ISO strings. */
export function parseTime(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    if (/^\d+(\.\d+)?$/.test(v)) return parseTime(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

export function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

/** Records usage events once per key so re-reads and resumed sessions are not double counted. */
export class UsageLedger {
  private events = new Map<string, { at: number; usage: TokenUsage }>();

  add(key: string, at: number, usage: TokenUsage): boolean {
    if (this.events.has(key)) return false;
    this.events.set(key, { at, usage });
    return true;
  }

  sumSince(since: number): TokenUsage {
    const out = emptyUsage();
    for (const e of this.events.values()) if (e.at >= since) addUsage(out, e.usage);
    return out;
  }

  prune(before: number): void {
    for (const [k, e] of this.events) if (e.at < before) this.events.delete(k);
  }

  get size(): number {
    return this.events.size;
  }
}

export function windowLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback;
  if (minutes % 10080 === 0) return minutes === 10080 ? '7d' : `${minutes / 1440}d`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
