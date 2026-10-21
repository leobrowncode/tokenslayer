import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlertTracker, buildAdvice, levelFor } from '../src/core/advisor';
import { DEFAULT_CONFIG, mergeConfig } from '../src/core/config';
import { formatDuration, formatTokens } from '../src/core/format';
import { iconPNG } from '../src/core/icon';
import { JsonlTailer } from '../src/core/jsonl';
import { codexContextPercent, codexLimits } from '../src/core/providers/codex';
import { contextHint, resolveCursorContext } from '../src/core/providers/cursor';
import { cursorUserId, parseLegacyUsage, parseUsageSummary } from '../src/core/providers/cursorApi';
import { parseClaudeUsageResponse } from '../src/core/providers/claude';
import { UsageLedger, parseTime, windowLabel } from '../src/core/tokens';
import type { Advice, ProviderSnapshot } from '../src/core/types';
import { fakeJwt } from '../src/tools/demoHome';

describe('JsonlTailer', () => {
  it('handles partial lines, multibyte chars across chunks and truncation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'));
    const file = path.join(dir, 'a.jsonl');
    const seen: string[] = [];
    const t = new JsonlTailer<{ n: number }>(() => ({ n: 0 }), (s, o) => {
      s.n++;
      seen.push(o.v);
    }, 7);
    fs.writeFileSync(file, '{"v":"héllo"}\n{"v":"wör');
    expect((await t.update(file)).n).toBe(1);
    fs.appendFileSync(file, 'ld"}\nnot json\n\n');
    expect((await t.update(file)).n).toBe(2);
    expect(seen).toEqual(['héllo', 'wörld']);
    fs.writeFileSync(file, '{"v":"new"}\n');
    expect((await t.update(file)).n).toBe(1);
    t.retain([]);
    expect(t.get(file)).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });
});

describe('tokens helpers', () => {
  it('parses many time formats', () => {
    expect(parseTime(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseTime('1700000000000')).toBe(1_700_000_000_000);
    expect(parseTime('2026-10-21T10:00:00Z')).toBe(Date.parse('2026-10-21T10:00:00Z'));
    expect(parseTime('garbage')).toBeUndefined();
  });

  it('labels rate-limit windows', () => {
    expect(windowLabel(300, 'x')).toBe('5h');
    expect(windowLabel(10080, 'x')).toBe('7d');
    expect(windowLabel(1440, 'x')).toBe('1d');
    expect(windowLabel(45, 'x')).toBe('45m');
    expect(windowLabel(undefined, 'x')).toBe('x');
  });

  it('ledger dedupes and prunes', () => {
    const l = new UsageLedger();
    const u = { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 };
    expect(l.add('a', 10, u)).toBe(true);
    expect(l.add('a', 10, u)).toBe(false);
    l.add('b', 20, u);
    expect(l.sumSince(15)).toEqual(u);
    l.prune(15);
    expect(l.size).toBe(1);
  });
});

describe('format', () => {
  it('formats token counts', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(176000)).toBe('176k');
    expect(formatTokens(1_840_000)).toBe('1.84M');
    expect(formatTokens(12_000_000)).toBe('12M');
  });
  it('formats durations', () => {
    expect(formatDuration(30_000)).toBe('1m');
    expect(formatDuration(133 * 60_000)).toBe('2h 13m');
    expect(formatDuration(3 * 86400_000)).toBe('3d 0h');
  });
});

describe('config', () => {
  it('merges user overrides and ignores unknown or mistyped keys', () => {
    const c = mergeConfig(DEFAULT_CONFIG, {
      compactAtPercent: 50,
      bogus: 1,
      overlay: { opacity: 'high', x: 10 },
      paths: { claudeDirs: ['D:\\claude'] },
    });
    expect(c.compactAtPercent).toBe(50);
    expect((c as any).bogus).toBeUndefined();
    expect(c.overlay.opacity).toBe(DEFAULT_CONFIG.overlay.opacity);
    expect(c.overlay.x).toBe(10);
    expect(c.paths.claudeDirs).toEqual(['D:\\claude']);
    expect(c.newChatAtPercent).toBe(85);
  });
});

describe('codex math', () => {
  it('matches the Codex TUI baseline-adjusted percentage', () => {
    expect(codexContextPercent(12_000, 272_000)).toBe(0);
    expect(codexContextPercent(272_000, 272_000)).toBe(100);
    expect(codexContextPercent(142_000, 272_000)).toBe(50);
  });
  it('supports resets_in_seconds and expired windows', () => {
    const at = 1_000_000;
    const limits = codexLimits({ at, primary: { used_percent: 80, window_minutes: 300, resets_in_seconds: 60 }, secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1 } }, at + 1000);
    expect(limits).toEqual([
      { label: '5h', usedPercent: 80, resetsAt: at + 60_000 },
      { label: '7d', usedPercent: 0, resetsAt: 1000 },
    ]);
  });
});

describe('cursor helpers', () => {
  it('extracts user id from session JWT', () => {
    expect(cursorUserId(fakeJwt('auth0|user_abc'))).toBe('user_abc');
    expect(cursorUserId('nope')).toBeUndefined();
  });

  it('reads context hints from several schema variants', () => {
    expect(contextHint({ contextWindowStatusAtCreation: { tokensUsed: 5000, tokenLimit: 100000 } })).toEqual({ tokens: 5000, limit: 100000, percent: undefined });
    expect(contextHint({ contextWindowStatusAtCreation: { percentageRemaining: 30 } })).toEqual({ tokens: undefined, limit: undefined, percent: 70 });
    expect(contextHint({ contextUsagePercent: 42 })).toEqual({ percent: 42, tokens: undefined, limit: undefined });
    expect(contextHint({ text: 'hi' })).toBeUndefined();
  });

  it('falls back to a character-based estimate', () => {
    const r = resolveCursorContext({}, [{ type: 1, inTok: 0, outTok: 0, chars: 4000 }, { type: 2, inTok: 0, outTok: 0, chars: 36000 }], [], 200000);
    expect(r).toEqual({ tokens: 10000, window: 200000, estimated: true });
    const hinted = resolveCursorContext({}, [], [{ contextWindowStatusAtCreation: { percentageRemaining: 25, tokenLimit: 1000000 } }], 200000);
    expect(hinted).toEqual({ tokens: 750000, window: 1000000, estimated: false });
  });

  it('parses plan usage responses', () => {
    expect(parseUsageSummary({ individualUsage: { plan: { enabled: true, totalPercentUsed: 33 }, onDemand: { enabled: true, used: 50, limit: 100 } } })).toEqual([
      { label: 'Plan', usedPercent: 33, resetsAt: undefined },
      { label: 'On-demand', usedPercent: 50, resetsAt: undefined },
    ]);
    const legacy = parseLegacyUsage({ 'gpt-4': { numRequests: 250, maxRequestUsage: 500 }, startOfMonth: '2026-10-05T00:00:00.000Z' });
    expect(legacy[0].label).toBe('Requests');
    expect(legacy[0].usedPercent).toBe(50);
    expect(parseLegacyUsage({})).toEqual([]);
  });
});

describe('claude usage api', () => {
  it('zeroes windows that already reset', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    expect(parseClaudeUsageResponse({ five_hour: { utilization: 90, resets_at: '2026-10-21T11:00:00Z' } }, now)).toEqual([
      { label: '5h', usedPercent: 0, resetsAt: Date.parse('2026-10-21T11:00:00Z') },
    ]);
  });
});

describe('advisor', () => {
  const snap = (pcts: number[]): ProviderSnapshot => ({
    id: 'claude', name: 'Claude Code', detected: true, usageToday: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, tokensToday: 0, limits: [], notes: [],
    chats: pcts.map((p, i) => ({ id: `c${i}`, contextTokens: p * 2000, contextWindow: 200000, contextPercent: p, updatedAt: 0 })),
  });

  it('maps percentages to levels', () => {
    expect(levelFor(59.9, DEFAULT_CONFIG)).toBe('ok');
    expect(levelFor(60, DEFAULT_CONFIG)).toBe('compact');
    expect(levelFor(85, DEFAULT_CONFIG)).toBe('newChat');
  });

  it('orders advice by severity and suggests the right commands', () => {
    const advice = buildAdvice([snap([65, 90, 10])], DEFAULT_CONFIG);
    expect(advice.map((a) => [a.chatId, a.level])).toEqual([['c1', 'newChat'], ['c0', 'compact']]);
    expect(advice[0].actions[0].copy).toBe('/clear');
    expect(advice[1].actions[0].copy).toBe('/compact');
  });

  it('notifies once per escalation, re-arms after compaction, and honours dismiss', () => {
    const t = new AlertTracker();
    const adv = (p: number): Advice[] => buildAdvice([snap([p])], DEFAULT_CONFIG);
    expect(t.process(adv(65)).notify).toHaveLength(1);
    expect(t.process(adv(70)).notify).toHaveLength(0);
    expect(t.process(adv(90)).notify.map((a) => a.level)).toEqual(['newChat']);
    expect(t.process(adv(20)).notify).toHaveLength(0);
    expect(t.process(adv(66)).notify).toHaveLength(1);

    t.dismiss({ provider: 'claude', chatId: 'c0', level: 'compact' });
    expect(t.process(adv(70)).visible).toHaveLength(0);
    const escalated = t.process(adv(88));
    expect(escalated.visible).toHaveLength(1);
    expect(escalated.notify).toHaveLength(1);
  });
});

describe('icon', () => {
  it('produces a PNG', () => {
    const png = iconPNG(16, 'ok');
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(16);
  });
});
