import path from 'node:path';
import { JsonlTailer } from '../jsonl';
import { codexHome, exists, folderName, listJsonl } from '../paths';
import { UsageLedger, clampPercent, num, parseTime, startOfLocalDay, windowLabel } from '../tokens';
import type { LimitWindow, ProviderSnapshot, TokenUsage } from '../types';
import { type CollectContext, type Provider, baseSnapshot } from './provider';

const LOOKBACK_MS = 30 * 3600_000;
const DEFAULT_WINDOW = 272_000;
/** Codex's TUI excludes a fixed prompt baseline from its "context left" figure; mirrored here. */
export const CODEX_BASELINE_TOKENS = 12_000;

interface RawRateWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number | string;
  resets_in_seconds?: number;
}

export interface CodexSessionState {
  sessionId?: string;
  cwd?: string;
  model?: string;
  cumulative?: TokenUsage;
  context?: { tokens: number; window: number; at: number };
  rateLimits?: { at: number; primary?: RawRateWindow; secondary?: RawRateWindow };
  turns: number;
  lastAt: number;
}

const newState = (): CodexSessionState => ({ turns: 0, lastAt: 0 });

function toUsage(raw: any): TokenUsage {
  const input = num(raw?.input_tokens);
  const cached = Math.min(num(raw?.cached_input_tokens), input);
  return { input: input - cached, output: num(raw?.output_tokens), cacheWrite: 0, cacheRead: cached };
}

function diff(cur: TokenUsage, prev: TokenUsage | undefined): TokenUsage {
  if (!prev) return cur;
  const d = {
    input: cur.input - prev.input,
    output: cur.output - prev.output,
    cacheWrite: cur.cacheWrite - prev.cacheWrite,
    cacheRead: cur.cacheRead - prev.cacheRead,
  };
  // Counters went backwards: a new cumulative series started in the same file.
  return Object.values(d).some((v) => v < 0) ? cur : d;
}

export function codexContextPercent(tokens: number, window: number): number {
  if (window <= CODEX_BASELINE_TOKENS) return 100;
  const effective = window - CODEX_BASELINE_TOKENS;
  const used = Math.max(0, tokens - CODEX_BASELINE_TOKENS);
  return clampPercent((used / effective) * 100);
}

export function applyCodexLine(state: CodexSessionState, obj: any, file: string, offset: number, ledger: UsageLedger): void {
  const at = parseTime(obj.timestamp);
  const p = obj.payload;
  if (!p) return;
  if (at) state.lastAt = Math.max(state.lastAt, at);

  if (obj.type === 'session_meta') {
    state.sessionId = p.id ?? state.sessionId;
    state.cwd = p.cwd ?? state.cwd;
    return;
  }
  if (obj.type === 'turn_context') {
    if (p.model) state.model = p.model;
    if (p.cwd) state.cwd = p.cwd;
    return;
  }
  if (obj.type !== 'event_msg') return;
  if (p.type === 'user_message') {
    state.turns++;
    return;
  }
  if (p.type !== 'token_count' || !at) return;

  if (p.rate_limits && (p.rate_limits.primary || p.rate_limits.secondary)) {
    state.rateLimits = { at, primary: p.rate_limits.primary ?? undefined, secondary: p.rate_limits.secondary ?? undefined };
  }
  const info = p.info;
  if (!info) return;
  if (info.total_token_usage) {
    const cur = toUsage(info.total_token_usage);
    const d = diff(cur, state.cumulative);
    state.cumulative = cur;
    if (d.input + d.output + d.cacheRead > 0) ledger.add(`${file}:${offset}`, at, d);
  }
  const last = info.last_token_usage;
  if (last) {
    const tokens = num(last.total_tokens) || num(last.input_tokens) + num(last.output_tokens);
    state.context = { tokens, window: num(info.model_context_window) || DEFAULT_WINDOW, at };
  }
}

export function codexLimits(rl: CodexSessionState['rateLimits'], now: number): LimitWindow[] {
  if (!rl) return [];
  const out: LimitWindow[] = [];
  const add = (w: RawRateWindow | undefined, fallback: string) => {
    if (!w || typeof w.used_percent !== 'number') return;
    let resetsAt = parseTime(w.resets_at);
    if (resetsAt === undefined && typeof w.resets_in_seconds === 'number') resetsAt = rl.at + w.resets_in_seconds * 1000;
    const expired = resetsAt !== undefined && resetsAt < now;
    out.push({ label: windowLabel(w.window_minutes, fallback), usedPercent: expired ? 0 : clampPercent(w.used_percent), resetsAt });
  };
  add(rl.primary, '5h');
  add(rl.secondary, '7d');
  return out;
}

export class CodexProvider implements Provider {
  readonly id = 'codex' as const;
  readonly name = 'Codex';
  private ledger = new UsageLedger();
  private tailer = new JsonlTailer<CodexSessionState>(newState, (s, obj, file, off) =>
    applyCodexLine(s, obj, file, off, this.ledger),
  );

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const snap = baseSnapshot(this.id, this.name);
    const sessions = path.join(codexHome(ctx.config), 'sessions');
    if (!(await exists(sessions))) return snap;
    snap.detected = true;

    const minMtime = ctx.now - LOOKBACK_MS;
    const files = await listJsonl(sessions, 4, minMtime);
    for (const f of files) await this.tailer.update(f.path, f.size);
    this.tailer.retain(files.map((f) => f.path));
    this.ledger.prune(minMtime);

    snap.usageToday = this.ledger.sumSince(startOfLocalDay(ctx.now));
    snap.usageSource = 'local session logs';

    const states = this.tailer.entriesList();
    const latestLimits = states
      .map(([, s]) => s.rateLimits)
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .sort((a, b) => b.at - a.at)[0];
    snap.limits = codexLimits(latestLimits, ctx.now);

    const maxAge = ctx.config.activeChatMaxAgeMinutes * 60_000;
    const configured = ctx.config.contextWindows.codex;
    snap.chats = states
      .filter(([, s]) => s.context && s.lastAt >= ctx.now - maxAge)
      .sort(([, a], [, b]) => b.lastAt - a.lastAt)
      .slice(0, 5)
      .map(([file, s]) => {
        const window = configured > 0 ? configured : s.context!.window;
        const pct = codexContextPercent(s.context!.tokens, window);
        return {
          id: s.sessionId ?? path.basename(file, '.jsonl'),
          title: s.cwd ? folderName(s.cwd) : undefined,
          model: s.model,
          contextTokens: s.context!.tokens,
          contextWindow: window,
          contextPercent: Math.round(pct * 10) / 10,
          turns: s.turns,
          updatedAt: s.lastAt,
        };
      });
    return snap;
  }
}
