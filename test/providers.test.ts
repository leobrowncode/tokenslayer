import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, DEFAULT_CONFIG } from '../src/core/config';
import { ClaudeProvider } from '../src/core/providers/claude';
import { CodexProvider } from '../src/core/providers/codex';
import { CursorProvider } from '../src/core/providers/cursor';
import { collectSnapshot, createProviders } from '../src/core/snapshot';
import { writeDemoHome } from '../src/tools/demoHome';

const NOW = new Date(2026, 9, 21, 15, 0, 0).getTime();
let root: string;
let cfg: Config;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenslayer-'));
  const cursorDb = path.join(root, 'Cursor', 'state.vscdb');
  writeDemoHome(root, NOW, cursorDb);
  cfg = structuredClone(DEFAULT_CONFIG);
  cfg.network.cursorApi = false;
  cfg.network.claudeUsageApi = false;
  cfg.paths = { claudeDirs: [path.join(root, '.claude')], codexHome: path.join(root, '.codex'), cursorStateDb: cursorDb };
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ClaudeProvider', () => {
  it('reads context of the latest main-thread message and dedupes streamed entries', async () => {
    const snap = await new ClaudeProvider().collect({ now: NOW, config: cfg });
    expect(snap.detected).toBe(true);
    expect(snap.usageToday).toEqual({ input: 1000 + 5000 + 2000 + 500, output: 500 + 100 + 3000 + 1500, cacheWrite: 20000 + 1000 + 58000, cacheRead: 170000 });
    expect(snap.chats.map((c) => c.id)).toEqual(['sess-a', 'sess-b']);
    const [a, b] = snap.chats;
    expect(a.contextTokens).toBe(176000);
    expect(a.contextWindow).toBe(200000);
    expect(a.contextPercent).toBe(88);
    expect(a.title).toBe('webapp');
    expect(a.turns).toBe(2);
    expect(a.model).toBe('claude-sonnet-4-5');
    expect(b.title).toBe('API rate limiter');
    expect(b.contextPercent).toBe(30);
  });

  it('only reads appended bytes on later polls', async () => {
    const p = new ClaudeProvider();
    await p.collect({ now: NOW, config: cfg });
    const file = path.join(root, '.claude', 'projects', 'C--Users-me-webapp', 'sess-a.jsonl');
    const line = {
      type: 'system', subtype: 'compact_boundary', sessionId: 'sess-a', timestamp: new Date(NOW).toISOString(),
      compactMetadata: { trigger: 'manual', preTokens: 176000, postTokens: 20000 },
    };
    const original = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, JSON.stringify(line) + '\n');
      const snap = await p.collect({ now: NOW, config: cfg });
      expect(snap.chats[0].contextTokens).toBe(20000);
      expect(snap.chats[0].contextPercent).toBe(10);
      expect(snap.usageToday.output).toBe(500 + 100 + 3000 + 1500);
    } finally {
      fs.writeFileSync(file, original);
      fs.utimesSync(file, new Date(NOW - 60_000), new Date(NOW - 60_000));
    }
  });

  it('reports 5h / weekly limits from the OAuth usage endpoint', async () => {
    const dir = path.join(root, '.claude');
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: NOW + 3600_000 } }));
    const c = structuredClone(cfg);
    c.network.claudeUsageApi = true;
    let auth = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).Authorization;
      return new Response(
        JSON.stringify({ five_hour: { utilization: 34, resets_at: new Date(Date.now() + 3600_000).toISOString() }, seven_day: { utilization: 12.5, resets_at: null }, seven_day_opus: null }),
      );
    }) as typeof fetch;
    try {
      const snap = await new ClaudeProvider().collect({ now: NOW, config: c, fetchImpl });
      expect(auth).toBe('Bearer tok');
      expect(snap.limits.map((l) => [l.label, l.usedPercent])).toEqual([['5h', 34], ['7d', 12.5]]);
    } finally {
      fs.rmSync(path.join(dir, '.credentials.json'));
    }
  });

  it('is undetected when no Claude dir exists', async () => {
    const c = structuredClone(cfg);
    c.paths.claudeDirs = [path.join(root, 'nope')];
    const snap = await new ClaudeProvider().collect({ now: NOW, config: c });
    expect(snap.detected).toBe(false);
  });
});

describe('CodexProvider', () => {
  it('sums cumulative deltas, mirrors the TUI context % and reads rate limits', async () => {
    const snap = await new CodexProvider().collect({ now: NOW, config: cfg });
    expect(snap.detected).toBe(true);
    expect(snap.usageToday).toEqual({ input: 50000, output: 6000, cacheWrite: 0, cacheRead: 160000 });
    const chat = snap.chats[0];
    expect(chat.id).toBe('codex-1');
    expect(chat.title).toBe('cli-tool');
    expect(chat.model).toBe('gpt-5-codex');
    expect(chat.turns).toBe(2);
    expect(chat.contextTokens).toBe(184000);
    expect(chat.contextPercent).toBeCloseTo(66.2, 1);
    expect(snap.limits.map((l) => [l.label, l.usedPercent])).toEqual([['5h', 47], ['7d', 13]]);
  });
});

describe('CursorProvider', () => {
  it('finds the active composer and its context from the last assistant bubble', async () => {
    const snap = await new CursorProvider().collect({ now: NOW, config: cfg });
    expect(snap.detected).toBe(true);
    expect(snap.error).toBeUndefined();
    expect(snap.chats).toHaveLength(1);
    const chat = snap.chats[0];
    expect(chat.title).toBe('Refactor auth middleware');
    expect(chat.contextTokens).toBe(98000);
    expect(chat.contextPercent).toBe(49);
    expect(chat.turns).toBe(2);
    expect(chat.estimated).toBeFalsy();
    expect(snap.usageToday).toEqual({ input: 40000 + 96000 + 10000, output: 2000 + 2000 + 1000, cacheWrite: 0, cacheRead: 0 });
  });

  it('prefers cursor.com usage events and plan usage when signed in', async () => {
    const c = structuredClone(cfg);
    c.network.cursorApi = true;
    const calls: string[] = [];
    let cookie = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(new URL(url).pathname);
      cookie = (init.headers as Record<string, string>).Cookie;
      if (url.endsWith('/api/usage-summary')) {
        return new Response(JSON.stringify({ billingCycleEnd: '2026-11-01T00:00:00Z', individualUsage: { plan: { enabled: true, used: 1500, limit: 2000 } } }));
      }
      return new Response(
        JSON.stringify({
          totalUsageEventsCount: 2,
          usageEventsDisplay: [
            { timestamp: String(NOW - 60_000), tokenUsage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300 } },
            { timestamp: String(NOW - 120_000), tokenUsage: { inputTokens: 10, outputTokens: 20 } },
          ],
        }),
      );
    }) as typeof fetch;
    const snap = await new CursorProvider().collect({ now: NOW, config: c, fetchImpl });
    expect(cookie).toMatch(/^WorkosCursorSessionToken=user_123%3A%3A/);
    expect(calls).toEqual(['/api/usage-summary', '/api/dashboard/get-filtered-usage-events']);
    expect(snap.limits).toEqual([{ label: 'Plan', usedPercent: 75, resetsAt: Date.parse('2026-11-01T00:00:00Z') }]);
    expect(snap.usageToday).toEqual({ input: 1010, output: 220, cacheWrite: 300, cacheRead: 5000 });
    expect(snap.usageSource).toBe('cursor.com usage events');
  });
});

describe('collectSnapshot', () => {
  it('combines providers into a global total with advice', async () => {
    const snap = await collectSnapshot(createProviders(), cfg, { now: NOW });
    const byId = Object.fromEntries(snap.providers.map((p) => [p.id, p.tokensToday]));
    expect(byId).toEqual({ claude: 92600, codex: 56000, cursor: 151000 });
    expect(snap.tokensToday).toBe(299600);
    expect(snap.budgetPercent).toBeCloseTo((299600 / 5_000_000) * 100, 5);
    expect(snap.topLevel).toBe('newChat');
    expect(snap.advice.map((a) => [a.provider, a.level])).toEqual([
      ['claude', 'newChat'],
      ['codex', 'compact'],
    ]);
  });

  it('counts cache reads when configured', async () => {
    const c = { ...cfg, includeCacheReads: true };
    const snap = await collectSnapshot(createProviders(), c, { now: NOW });
    expect(snap.tokensToday).toBe(299600 + 170000 + 160000);
  });
});
