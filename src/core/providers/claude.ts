import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { JsonlTailer } from '../jsonl';
import { claudeDirs, exists, folderName, listJsonl } from '../paths';
import { UsageLedger, clampPercent, num, parseTime, startOfLocalDay } from '../tokens';
import type { LimitWindow, ProviderSnapshot, TokenUsage } from '../types';
import { type CollectContext, type Provider, RemoteThrottle, baseSnapshot, fetchJson, makeChat } from './provider';

const LOOKBACK_MS = 30 * 3600_000;
const DEFAULT_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

export interface ClaudeSessionState {
  sessionId?: string;
  cwd?: string;
  title?: string;
  model?: string;
  context?: { tokens: number; at: number };
  turns: number;
  lastAt: number;
  compactions: number;
}

const newState = (): ClaudeSessionState => ({ turns: 0, lastAt: 0, compactions: 0 });

function isHumanTurn(obj: any): boolean {
  if (obj.isMeta || obj.isSidechain || obj.isCompactSummary) return false;
  const content = obj.message?.content;
  if (typeof content === 'string') return !content.startsWith('<command-') && !content.startsWith('<local-command');
  if (Array.isArray(content)) return content.some((c: any) => c?.type === 'text');
  return false;
}

/** Applies one Claude Code transcript record to the session state and the shared usage ledger. */
export function applyClaudeLine(state: ClaudeSessionState, obj: any, file: string, offset: number, ledger: UsageLedger): void {
  const at = parseTime(obj.timestamp);
  if (obj.sessionId && !state.sessionId) state.sessionId = obj.sessionId;
  if (obj.cwd) state.cwd = obj.cwd;
  if (obj.type === 'summary' && typeof obj.summary === 'string') state.title = obj.summary;
  if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') state.title = obj.customTitle;
  if (at && !obj.isSidechain) state.lastAt = Math.max(state.lastAt, at);

  if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
    state.compactions++;
    state.turns = 0;
    const post = num(obj.compactMetadata?.postTokens);
    state.context = post > 0 && at ? { tokens: post, at } : undefined;
    return;
  }

  if (obj.type === 'user' && isHumanTurn(obj)) {
    state.turns++;
    return;
  }

  const usage = obj.type === 'assistant' ? obj.message?.usage : undefined;
  if (!usage || !at) return;
  const u: TokenUsage = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
  };
  const msgId = obj.message?.id;
  const key = msgId ? `${msgId}:${obj.requestId ?? ''}` : `${file}:${offset}`;
  ledger.add(key, at, u);

  const model = obj.message?.model;
  if (obj.isSidechain || model === '<synthetic>') return;
  if (model) state.model = model;
  const ctxTokens = u.input + u.cacheWrite + u.cacheRead + u.output;
  if (ctxTokens > 0) state.context = { tokens: ctxTokens, at };
}

export function parseClaudeUsageResponse(j: any, now: number): LimitWindow[] {
  const labels: Array<[string, string]> = [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
    ['seven_day_opus', '7d Opus'],
    ['seven_day_sonnet', '7d Sonnet'],
  ];
  const out: LimitWindow[] = [];
  for (const [key, label] of labels) {
    const w = j?.[key];
    if (!w || typeof w.utilization !== 'number') continue;
    const resetsAt = parseTime(w.resets_at);
    const expired = resetsAt !== undefined && resetsAt < now;
    out.push({ label, usedPercent: expired ? 0 : clampPercent(w.utilization), resetsAt });
  }
  return out;
}

async function readClaudeOAuthToken(dirs: string[], now: number): Promise<string | undefined> {
  for (const d of dirs) {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(d, '.credentials.json'), 'utf8'));
      const oauth = raw?.claudeAiOauth;
      if (!oauth?.accessToken) continue;
      if (oauth.expiresAt && num(oauth.expiresAt) < now) continue;
      return oauth.accessToken as string;
    } catch {
      /* no credentials in this dir */
    }
  }
  return undefined;
}

export class ClaudeProvider implements Provider {
  readonly id = 'claude' as const;
  readonly name = 'Claude Code';
  private ledger = new UsageLedger();
  private tailer = new JsonlTailer<ClaudeSessionState>(newState, (s, obj, file, off) =>
    applyClaudeLine(s, obj, file, off, this.ledger),
  );
  private remote = new RemoteThrottle<LimitWindow[]>();

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const snap = baseSnapshot(this.id, this.name);
    const dirs = claudeDirs(ctx.config);
    const projectRoots: string[] = [];
    for (const d of dirs) if (await exists(path.join(d, 'projects'))) projectRoots.push(path.join(d, 'projects'));
    if (!projectRoots.length) return snap;
    snap.detected = true;

    const minMtime = ctx.now - LOOKBACK_MS;
    const files = (await Promise.all(projectRoots.map((r) => listJsonl(r, 4, minMtime)))).flat();
    for (const f of files) await this.tailer.update(f.path, f.size);
    this.tailer.retain(files.map((f) => f.path));
    this.ledger.prune(minMtime);

    snap.usageToday = this.ledger.sumSince(startOfLocalDay(ctx.now));
    snap.usageSource = 'local transcripts';
    const lastAt = Math.max(0, ...this.tailer.entriesList().map(([, s]) => s.lastAt));
    if (lastAt > 0) snap.lastActivityAt = lastAt;

    const maxAge = ctx.config.activeChatMaxAgeMinutes * 60_000;
    const configured = ctx.config.contextWindows.claude;
    snap.chats = this.tailer
      .entriesList()
      .filter(([, s]) => s.context && s.lastAt >= ctx.now - maxAge)
      .sort(([, a], [, b]) => b.lastAt - a.lastAt)
      .slice(0, 5)
      .map(([file, s]) => {
        const tokens = s.context!.tokens;
        const window = configured > 0 ? configured : tokens > DEFAULT_WINDOW ? LARGE_WINDOW : DEFAULT_WINDOW;
        return makeChat({
          id: s.sessionId ?? path.basename(file, '.jsonl'),
          title: s.title ?? (s.cwd ? folderName(s.cwd) : undefined),
          model: s.model,
          contextTokens: tokens,
          contextWindow: window,
          turns: s.turns,
          updatedAt: s.lastAt,
        });
      });

    if (ctx.config.network.claudeUsageApi) {
      const fetchImpl = ctx.fetchImpl ?? fetch;
      await this.remote.refresh(ctx, async () => {
        const token = await readClaudeOAuthToken(dirs, ctx.now);
        if (!token) throw new Error('no Claude OAuth login found (.credentials.json)');
        const j = await fetchJson(fetchImpl, 'https://api.anthropic.com/api/oauth/usage', {
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'tokenslayer-overlay',
          },
        });
        return parseClaudeUsageResponse(j, Date.now());
      });
      if (this.remote.value) snap.limits = this.remote.value;
      if (this.remote.error) snap.notes.push(`Plan limits unavailable: ${this.remote.error}`);
    }
    return snap;
  }
}
