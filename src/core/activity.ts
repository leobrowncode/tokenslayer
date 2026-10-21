import { execFile } from 'node:child_process';
import type { Config } from './config';
import type { ProviderId, ProviderSnapshot } from './types';

/**
 * Executable names (lowercase, without `.exe`) that mean a tool is open. The Claude Code and Codex
 * IDE extensions spawn the same `claude` / `codex` binaries as the CLIs. An npm install of Claude
 * Code runs as `node`, so it is only picked up through its recent activity.
 */
const PROCESS_PATTERNS: Record<ProviderId, RegExp> = {
  cursor: /^cursor$/,
  claude: /^claude$/,
  codex: /^codex(-.+)?$/,
};

function normalize(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

export function runningTools(processNames: Iterable<string>): Set<ProviderId> {
  const out = new Set<ProviderId>();
  for (const raw of processNames) {
    const name = normalize(raw);
    if (!name) continue;
    for (const [id, re] of Object.entries(PROCESS_PATTERNS) as Array<[ProviderId, RegExp]>) {
      if (re.test(name)) out.add(id);
    }
  }
  return out;
}

/** Parses `tasklist /fo csv /nh` output: one `"Image Name","PID",...` row per process. */
export function parseTasklist(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });
}

export async function listProcessNames(): Promise<string[]> {
  if (process.platform === 'win32') return parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh']));
  const out = await run('ps', ['-A', '-o', 'comm=']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Sets `running` and `inUse` on each provider. `running` is undefined when processes were not checked. */
export function applyActivity(results: ProviderSnapshot[], running: Set<ProviderId> | undefined, cfg: Config, now: number): void {
  const recentMs = cfg.activity.recentMinutes * 60_000;
  for (const r of results) {
    r.running = running?.has(r.id) ?? false;
    const recent = recentMs > 0 && r.lastActivityAt !== undefined && now - r.lastActivityAt <= recentMs;
    r.inUse = r.detected && (cfg.activity.showAll || r.running || recent);
  }
}
