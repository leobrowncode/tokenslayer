import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Config } from './config';

/** TOKENSLAYER_HOME lets tests and demos point every provider at a fake home directory. */
export function homeDir(): string {
  return process.env.TOKENSLAYER_HOME || os.homedir();
}

export function claudeDirs(cfg: Config): string[] {
  if (cfg.paths.claudeDirs.length) return cfg.paths.claudeDirs;
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  const h = homeDir();
  return [path.join(h, '.claude'), path.join(h, '.config', 'claude')];
}

export function codexHome(cfg: Config): string {
  if (cfg.paths.codexHome) return cfg.paths.codexHome;
  return process.env.CODEX_HOME || path.join(homeDir(), '.codex');
}

export function cursorStateDb(cfg: Config): string {
  if (cfg.paths.cursorStateDb) return cfg.paths.cursorStateDb;
  const h = homeDir();
  const overridden = Boolean(process.env.TOKENSLAYER_HOME);
  const tail = ['Cursor', 'User', 'globalStorage', 'state.vscdb'];
  if (process.platform === 'win32') {
    const appData = (!overridden && process.env.APPDATA) || path.join(h, 'AppData', 'Roaming');
    return path.join(appData, ...tail);
  }
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', ...tail);
  const xdg = (!overridden && process.env.XDG_CONFIG_HOME) || path.join(h, '.config');
  return path.join(xdg, ...tail);
}

/** Last path segment for either Windows or POSIX separators (WSL sessions log POSIX paths). */
export function folderName(p: string): string | undefined {
  return p.split(/[\\/]/).filter(Boolean).pop();
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Recursively lists `*.jsonl` files modified at or after `minMtime`. */
export async function listJsonl(root: string, maxDepth: number, minMtime: number): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = await fsp.stat(full);
          if (st.mtimeMs >= minMtime) out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* file vanished between readdir and stat */
        }
      }
    }
  }
  await walk(root, 0);
  return out;
}
