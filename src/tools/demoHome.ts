import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIN = 60_000;

function writeJsonl(file: string, lines: object[], mtime: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

const iso = (t: number) => new Date(t).toISOString();

export function fakeJwt(sub: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub, exp: 9999999999 })}.signature`;
}

/**
 * Writes realistic Claude Code, Codex and Cursor data under `root` (used as TOKENSLAYER_HOME).
 * Expected values (with cache reads excluded): Claude 92,600 tokens today, active chat 88%;
 * Codex 56,000 today, active chat ~66%; Cursor 151,000 today, active chat 49%.
 */
export function writeDemoHome(root: string, now: number, cursorDbPath: string): void {
  const claudeProjects = path.join(root, '.claude', 'projects');
  const cwdA = 'C:\\Users\\me\\webapp';
  writeJsonl(
    path.join(claudeProjects, 'C--Users-me-webapp', 'sess-a.jsonl'),
    [
      { type: 'user', sessionId: 'sess-a', cwd: cwdA, timestamp: iso(now - 30 * MIN), message: { role: 'user', content: 'Add a login page' } },
      {
        type: 'assistant', sessionId: 'sess-a', cwd: cwdA, requestId: 'req_1', timestamp: iso(now - 29 * MIN),
        message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0 } },
      },
      {
        type: 'assistant', sessionId: 'sess-a', cwd: cwdA, requestId: 'req_1', timestamp: iso(now - 29 * MIN),
        message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0 } },
      },
      { type: 'user', sessionId: 'sess-a', cwd: cwdA, timestamp: iso(now - 10 * MIN), message: { role: 'user', content: [{ type: 'text', text: 'Now add OAuth' }] } },
      { type: 'user', sessionId: 'sess-a', cwd: cwdA, timestamp: iso(now - 9.5 * MIN), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      {
        type: 'assistant', sessionId: 'sess-a', isSidechain: true, requestId: 'req_s', timestamp: iso(now - 9 * MIN),
        message: { id: 'msg_side', model: 'claude-haiku-4-5', usage: { input_tokens: 5000, output_tokens: 100 } },
      },
      {
        type: 'assistant', sessionId: 'sess-a', cwd: cwdA, requestId: 'req_2', timestamp: iso(now - 1 * MIN),
        message: { id: 'msg_2', model: 'claude-sonnet-4-5', usage: { input_tokens: 2000, output_tokens: 3000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 170000 } },
      },
    ],
    now - 1 * MIN,
  );
  writeJsonl(
    path.join(claudeProjects, '-home-me-api-server', 'sess-b.jsonl'),
    [
      { type: 'summary', summary: 'API rate limiter', leafUuid: 'x' },
      {
        type: 'assistant', sessionId: 'sess-b', cwd: '/home/me/api-server', requestId: 'req_0', timestamp: iso(now - 20 * 60 * MIN),
        message: { id: 'msg_0', model: 'claude-opus-4-1', usage: { input_tokens: 10000, output_tokens: 10000 } },
      },
      { type: 'user', sessionId: 'sess-b', cwd: '/home/me/api-server', timestamp: iso(now - 101 * MIN), message: { role: 'user', content: 'Add a rate limiter' } },
      {
        type: 'assistant', sessionId: 'sess-b', cwd: '/home/me/api-server', requestId: 'req_3', timestamp: iso(now - 100 * MIN),
        message: { id: 'msg_3', model: 'claude-opus-4-1', usage: { input_tokens: 500, output_tokens: 1500, cache_creation_input_tokens: 58000 } },
      },
    ],
    now - 100 * MIN,
  );

  const codexDay = new Date(now);
  const dayDir = path.join(
    root, '.codex', 'sessions', String(codexDay.getFullYear()),
    String(codexDay.getMonth() + 1).padStart(2, '0'), String(codexDay.getDate()).padStart(2, '0'),
  );
  writeJsonl(
    path.join(dayDir, 'rollout-2026-10-21T14-10-00-codex-1.jsonl'),
    [
      { timestamp: iso(now - 50 * MIN), type: 'session_meta', payload: { id: 'codex-1', cwd: '/home/me/cli-tool' } },
      { timestamp: iso(now - 50 * MIN), type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/home/me/cli-tool' } },
      { timestamp: iso(now - 49 * MIN), type: 'event_msg', payload: { type: 'user_message', message: 'scaffold the CLI' } },
      {
        timestamp: iso(now - 48 * MIN), type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 30000, cached_input_tokens: 10000, output_tokens: 2000, total_tokens: 32000 },
            last_token_usage: { input_tokens: 30000, cached_input_tokens: 10000, output_tokens: 2000, total_tokens: 32000 },
            model_context_window: 272000,
          },
          rate_limits: {
            primary: { used_percent: 42, window_minutes: 300, resets_at: Math.floor((now + 120 * MIN) / 1000) },
            secondary: { used_percent: 12, window_minutes: 10080, resets_at: Math.floor((now + 3 * 24 * 60 * MIN) / 1000) },
          },
        },
      },
      {
        timestamp: iso(now - 47 * MIN), type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 30000, cached_input_tokens: 10000, output_tokens: 2000, total_tokens: 32000 },
            last_token_usage: { input_tokens: 30000, cached_input_tokens: 10000, output_tokens: 2000, total_tokens: 32000 },
            model_context_window: 272000,
          },
        },
      },
      { timestamp: iso(now - 20 * MIN), type: 'event_msg', payload: { type: 'user_message', message: 'add tests' } },
      {
        timestamp: iso(now - 19 * MIN), type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 210000, cached_input_tokens: 160000, output_tokens: 6000, total_tokens: 216000 },
            last_token_usage: { input_tokens: 180000, cached_input_tokens: 150000, output_tokens: 4000, total_tokens: 184000 },
            model_context_window: 272000,
          },
          rate_limits: {
            primary: { used_percent: 47, window_minutes: 300, resets_at: Math.floor((now + 120 * MIN) / 1000) },
            secondary: { used_percent: 13, window_minutes: 10080, resets_at: Math.floor((now + 3 * 24 * 60 * MIN) / 1000) },
          },
        },
      },
    ],
    now - 19 * MIN,
  );

  fs.mkdirSync(path.dirname(cursorDbPath), { recursive: true });
  fs.rmSync(cursorDbPath, { force: true });
  const db = new DatabaseSync(cursorDbPath);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);
  const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', fakeJwt('auth0|user_123'));

  const headers = [
    { bubbleId: 'b1', type: 1 },
    { bubbleId: 'b2', type: 2 },
    { bubbleId: 'b3', type: 1 },
    { bubbleId: 'b4', type: 2 },
  ];
  put.run(
    'composerData:cmp-active',
    JSON.stringify({
      composerId: 'cmp-active', name: 'Refactor auth middleware', createdAt: now - 40 * MIN, lastUpdatedAt: now - 2 * MIN,
      modelConfig: { modelName: 'claude-4.5-sonnet' }, fullConversationHeadersOnly: headers,
    }),
  );
  const bubbles = [
    { bubbleId: 'b1', type: 1, text: 'please refactor the auth middleware', createdAt: iso(now - 40 * MIN) },
    { bubbleId: 'b2', type: 2, text: 'Sure...', tokenCount: { inputTokens: 40000, outputTokens: 2000 }, createdAt: iso(now - 39 * MIN) },
    { bubbleId: 'b3', type: 1, text: 'also add tests', createdAt: iso(now - 3 * MIN) },
    { bubbleId: 'b4', type: 2, text: 'Done.', tokenCount: { inputTokens: 96000, outputTokens: 2000 }, createdAt: iso(now - 2 * MIN) },
  ];
  for (const b of bubbles) put.run(`bubbleId:cmp-active:${b.bubbleId}`, JSON.stringify(b));

  put.run(
    'composerData:cmp-old',
    JSON.stringify({
      composerId: 'cmp-old', name: 'Old chat', createdAt: now - 26 * 60 * MIN, lastUpdatedAt: now - 5 * 60 * MIN,
      fullConversationHeadersOnly: [{ bubbleId: 'o1', type: 2 }, { bubbleId: 'o2', type: 2 }],
    }),
  );
  put.run('bubbleId:cmp-old:o1', JSON.stringify({ bubbleId: 'o1', type: 2, tokenCount: { inputTokens: 50000, outputTokens: 5000 }, createdAt: iso(now - 26 * 60 * MIN) }));
  put.run('bubbleId:cmp-old:o2', JSON.stringify({ bubbleId: 'o2', type: 2, tokenCount: { inputTokens: 10000, outputTokens: 1000 }, createdAt: iso(now - 5 * 60 * MIN) }));
  put.run('composerData:cmp-blank', JSON.stringify({ composerId: 'cmp-blank', createdAt: now - 3 * 60 * MIN, lastUpdatedAt: now - 3 * 60 * MIN }));
  put.run('composerData:broken', '{not json');
  db.close();
}
