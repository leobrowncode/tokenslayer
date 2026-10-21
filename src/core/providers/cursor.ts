import { promises as fsp } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cursorStateDb, exists } from '../paths';
import { addUsage, emptyUsage, num, parseTime, startOfLocalDay } from '../tokens';
import type { ChatInfo, ProviderSnapshot, TokenUsage } from '../types';
import { type CollectContext, type Provider, RemoteThrottle, baseSnapshot, makeChat } from './provider';
import { type CursorRemoteUsage, fetchCursorUsage } from './cursorApi';

/** Rough chars-per-token ratio used only when Cursor did not record any token counts. */
const CHARS_PER_TOKEN = 4;
/** Other chats count as "active in parallel" only if touched this close to the newest one. */
const PARALLEL_CHAT_MS = 15 * 60_000;

export interface ComposerRow {
  id: string;
  updatedAt?: number;
  createdAt?: number;
  name?: string;
}

export interface BubbleRow {
  bubbleId?: string;
  type?: number;
  inTok: number;
  outTok: number;
  chars: number;
  createdAt?: number;
}

interface ContextHint {
  tokens?: number;
  limit?: number;
  percent?: number;
}

// cursorDiskKV keys are `composerData:<id>` and `bubbleId:<composerId>:<bubbleId>`. Range scans
// (`>= 'prefix:' AND < 'prefix;'`) use the key index, unlike LIKE which is case-insensitive.
const COMPOSERS_SQL = `
SELECT substr(key, 14) AS id,
  json_extract(v, '$.lastUpdatedAt') AS updatedAt,
  json_extract(v, '$.createdAt') AS createdAt,
  json_extract(v, '$.name') AS name
FROM (SELECT key, CAST(value AS TEXT) AS v FROM cursorDiskKV
      WHERE key >= 'composerData:' AND key < 'composerData;')
WHERE json_valid(v)
ORDER BY coalesce(updatedAt, createdAt, 0) DESC
LIMIT ?`;

const BUBBLES_SQL = `
SELECT json_extract(v, '$.bubbleId') AS bubbleId,
  json_extract(v, '$.type') AS type,
  json_extract(v, '$.tokenCount.inputTokens') AS inTok,
  json_extract(v, '$.tokenCount.outputTokens') AS outTok,
  coalesce(length(json_extract(v, '$.text')), 0)
    + coalesce(length(json_extract(v, '$.toolFormerData.result')), 0)
    + coalesce(length(json_extract(v, '$.toolFormerData.rawArgs')), 0) AS chars,
  json_extract(v, '$.createdAt') AS createdAt
FROM (SELECT CAST(value AS TEXT) AS v FROM cursorDiskKV WHERE key >= ? AND key < ?)
WHERE json_valid(v)`;

export function openCursorDb(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true, timeout: 2000 } as ConstructorParameters<typeof DatabaseSync>[1]);
}

export function listComposers(db: DatabaseSync, limit: number): ComposerRow[] {
  return (db.prepare(COMPOSERS_SQL).all(limit) as any[]).map((r) => ({
    id: String(r.id),
    updatedAt: parseTime(r.updatedAt),
    createdAt: parseTime(r.createdAt),
    name: typeof r.name === 'string' && r.name ? r.name : undefined,
  }));
}

function getJson(db: DatabaseSync, key: string): any {
  const row = db.prepare('SELECT CAST(value AS TEXT) AS v FROM cursorDiskKV WHERE key = ?').get(key) as any;
  if (!row?.v) return undefined;
  try {
    return JSON.parse(row.v);
  } catch {
    return undefined;
  }
}

export function listBubbles(db: DatabaseSync, composerId: string): BubbleRow[] {
  const rows = db.prepare(BUBBLES_SQL).all(`bubbleId:${composerId}:`, `bubbleId:${composerId};`) as any[];
  return rows.map((r) => ({
    bubbleId: r.bubbleId ?? undefined,
    type: r.type === null ? undefined : Number(r.type),
    inTok: num(r.inTok),
    outTok: num(r.outTok),
    chars: num(r.chars),
    createdAt: parseTime(r.createdAt),
  }));
}

function bubbleFromInline(b: any): BubbleRow {
  const chars = (typeof b?.text === 'string' ? b.text.length : 0) + (typeof b?.toolFormerData?.result === 'string' ? b.toolFormerData.result.length : 0);
  return {
    bubbleId: b?.bubbleId,
    type: typeof b?.type === 'number' ? b.type : undefined,
    inTok: num(b?.tokenCount?.inputTokens),
    outTok: num(b?.tokenCount?.outputTokens),
    chars,
    createdAt: parseTime(b?.createdAt),
  };
}

export function readAccessToken(db: DatabaseSync): string | undefined {
  try {
    const row = db.prepare("SELECT CAST(value AS TEXT) AS v FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get() as any;
    const v = typeof row?.v === 'string' ? row.v.replace(/^"|"$/g, '') : undefined;
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Cursor has shipped several (undocumented) shapes for context-window status over time. */
export function contextHint(o: any): ContextHint | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const cws = o.contextWindowStatusAtCreation ?? o.contextWindowStatus;
  if (cws && typeof cws === 'object') {
    const tokens = num(cws.tokensUsed ?? cws.usedTokens ?? cws.tokenCount);
    const limit = num(cws.tokenLimit ?? cws.maxTokens ?? cws.contextWindow);
    const remaining = cws.percentageRemaining ?? cws.percentRemaining;
    const percent = typeof remaining === 'number' ? 100 - remaining : undefined;
    if (tokens > 0 || percent !== undefined) return { tokens: tokens || undefined, limit: limit || undefined, percent };
  }
  const tokens = num(o.contextTokensUsed);
  const limit = num(o.contextTokenLimit);
  if (typeof o.contextUsagePercent === 'number') {
    return { percent: o.contextUsagePercent, tokens: tokens || undefined, limit: limit || undefined };
  }
  if (tokens > 0) return { tokens, limit: limit || undefined };
  return undefined;
}

export function orderBubbles(composer: any, rows: BubbleRow[]): BubbleRow[] {
  const headers: any[] = Array.isArray(composer?.fullConversationHeadersOnly) ? composer.fullConversationHeadersOnly : [];
  if (!headers.length) return [...rows].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const byId = new Map(rows.map((r) => [r.bubbleId, r]));
  const ordered: BubbleRow[] = [];
  for (const h of headers) {
    const r = byId.get(h?.bubbleId);
    if (r) {
      if (r.type === undefined && typeof h.type === 'number') r.type = h.type;
      ordered.push(r);
      byId.delete(h.bubbleId);
    }
  }
  return ordered.concat([...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)));
}

export function resolveCursorContext(
  composer: any,
  bubbles: BubbleRow[],
  recentBubbleJson: any[],
  defaultWindow: number,
): { tokens: number; window: number; estimated: boolean } {
  const fromHint = (h: ContextHint) => {
    const window = h.limit || defaultWindow;
    const tokens = h.tokens ?? Math.round(((h.percent ?? 0) / 100) * window);
    return { tokens, window, estimated: false };
  };
  const composerHint = contextHint(composer);
  if (composerHint) return fromHint(composerHint);
  for (const b of recentBubbleJson) {
    const h = contextHint(b);
    if (h) return fromHint(h);
  }
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    if (b.type === 2 && b.inTok > 0) return { tokens: b.inTok + b.outTok, window: defaultWindow, estimated: false };
  }
  const chars = bubbles.reduce((s, b) => s + b.chars, 0);
  return { tokens: Math.round(chars / CHARS_PER_TOKEN), window: defaultWindow, estimated: true };
}

interface LocalCache {
  key: string;
  dayStart: number;
  chats: ChatInfo[];
  usageToday: TokenUsage;
  accessToken?: string;
}

export class CursorProvider implements Provider {
  readonly id = 'cursor' as const;
  readonly name = 'Cursor';
  private cache?: LocalCache;
  private remote = new RemoteThrottle<CursorRemoteUsage>();

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const snap = baseSnapshot(this.id, this.name);
    const file = cursorStateDb(ctx.config);
    if (!(await exists(file))) return snap;
    snap.detected = true;

    const dayStart = startOfLocalDay(ctx.now);
    const key = await this.fingerprint(file);
    if (!this.cache || this.cache.key !== key || this.cache.dayStart !== dayStart) {
      try {
        this.cache = { key, dayStart, ...this.readLocal(file, ctx, dayStart) };
      } catch (err) {
        snap.error = `Could not read Cursor database: ${(err as Error).message}`;
      }
    }
    const local = this.cache;
    const maxAge = ctx.config.activeChatMaxAgeMinutes * 60_000;
    snap.chats = (local?.chats ?? []).filter((c) => c.updatedAt >= ctx.now - maxAge);
    snap.usageToday = local?.usageToday ?? emptyUsage();
    snap.usageSource = 'local chat history';

    if (ctx.config.network.cursorApi && local?.accessToken) {
      const token = local.accessToken;
      await this.remote.refresh(ctx, () => fetchCursorUsage(ctx.fetchImpl ?? fetch, token, dayStart, ctx.now));
      const r = this.remote.value;
      if (r) {
        snap.limits = r.limits;
        if (r.usageToday) {
          snap.usageToday = r.usageToday;
          snap.usageSource = 'cursor.com usage events';
        }
      }
      if (this.remote.error) snap.notes.push(`cursor.com usage unavailable: ${this.remote.error}`);
    } else if (ctx.config.network.cursorApi) {
      snap.notes.push('Not signed in to Cursor; plan usage unavailable.');
    }
    if (snap.chats.some((c) => c.estimated)) snap.notes.push('Context size estimated from chat text length.');
    return snap;
  }

  private async fingerprint(file: string): Promise<string> {
    const parts: string[] = [];
    for (const f of [file, `${file}-wal`]) {
      try {
        const st = await fsp.stat(f);
        parts.push(`${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push('-');
      }
    }
    return parts.join('|');
  }

  private readLocal(file: string, ctx: CollectContext, dayStart: number): Omit<LocalCache, 'key' | 'dayStart'> {
    const db = openCursorDb(file);
    try {
      const accessToken = readAccessToken(db);
      let composers: ComposerRow[] = [];
      try {
        composers = listComposers(db, 60);
      } catch {
        return { chats: [], usageToday: emptyUsage(), accessToken };
      }

      const newest = composers[0]?.updatedAt ?? composers[0]?.createdAt ?? 0;
      const activeRows = composers
        .filter((c, i) => i === 0 || (c.updatedAt ?? 0) >= newest - PARALLEL_CHAT_MS)
        .slice(0, 3);
      const todayRows = composers.filter((c) => (c.updatedAt ?? c.createdAt ?? 0) >= dayStart).slice(0, 40);

      const usageToday = emptyUsage();
      const bubbleCache = new Map<string, { composer: any; bubbles: BubbleRow[] }>();
      const load = (id: string) => {
        let entry = bubbleCache.get(id);
        if (!entry) {
          const composer = getJson(db, `composerData:${id}`);
          let bubbles = listBubbles(db, id);
          if (!bubbles.length && Array.isArray(composer?.conversation)) bubbles = composer.conversation.map(bubbleFromInline);
          entry = { composer, bubbles: orderBubbles(composer, bubbles) };
          bubbleCache.set(id, entry);
        }
        return entry;
      };

      for (const row of todayRows) {
        const { bubbles } = load(row.id);
        const composerFromToday = (row.createdAt ?? 0) >= dayStart;
        for (const b of bubbles) {
          if (b.createdAt !== undefined ? b.createdAt < dayStart : !composerFromToday) continue;
          addUsage(usageToday, { input: b.inTok, output: b.outTok, cacheWrite: 0, cacheRead: 0 });
        }
      }

      const chats = activeRows.map((row) => {
        const { composer, bubbles } = load(row.id);
        const recent = bubbles
          .slice(-5)
          .reverse()
          .map((b) => (b.bubbleId ? getJson(db, `bubbleId:${row.id}:${b.bubbleId}`) : undefined))
          .filter(Boolean);
        const ctxInfo = resolveCursorContext(composer, bubbles, recent, ctx.config.contextWindows.cursor);
        const turns = bubbles.filter((b) => b.type === 1).length;
        return makeChat({
          id: row.id,
          title: row.name,
          model: composer?.modelConfig?.modelName,
          contextTokens: ctxInfo.tokens,
          contextWindow: ctxInfo.window,
          turns,
          updatedAt: row.updatedAt ?? row.createdAt ?? 0,
          estimated: ctxInfo.estimated,
        });
      });
      return { chats, usageToday, accessToken };
    } finally {
      db.close();
    }
  }
}
