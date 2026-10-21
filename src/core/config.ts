import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  /** Daily token budget for the global bar. 0 hides the budget and just shows the total. */
  dailyTokenBudget: number;
  /** Cache reads are cheap and huge in agentic tools; excluded from the global total by default. */
  includeCacheReads: boolean;
  /** Context-window percentage at which the overlay suggests compacting the chat. */
  compactAtPercent: number;
  /** Context-window percentage at which the overlay suggests starting a new chat. */
  newChatAtPercent: number;
  /** Chats untouched for longer than this are not considered active. */
  activeChatMaxAgeMinutes: number;
  pollIntervalSeconds: number;
  notifications: boolean;
  providers: { cursor: boolean; claude: boolean; codex: boolean };
  /** Decides which tools count as "in use" and are shown. */
  activity: {
    /** Treat a tool as in use while its process (Cursor, claude, codex) is running. */
    processes: boolean;
    /** Treat a tool as in use if it logged activity this recently. 0 = processes only. */
    recentMinutes: number;
    /** Show every tool whose data exists, used or not. */
    showAll: boolean;
  };
  network: {
    /** Read Cursor's session token from its local DB and query cursor.com for plan usage. */
    cursorApi: boolean;
    /** Read Claude Code's OAuth token and query api.anthropic.com for 5h / weekly limits. */
    claudeUsageApi: boolean;
    intervalSeconds: number;
  };
  contextWindows: {
    /** 0 = auto (200k, or 1M once a session exceeds 200k). */
    claude: number;
    /** 0 = use the window reported in Codex logs. */
    codex: number;
    cursor: number;
  };
  paths: {
    /** Claude config dirs (each containing `projects/`). Empty = auto-detect. */
    claudeDirs: string[];
    /** Codex home (containing `sessions/`). Empty = auto-detect. */
    codexHome: string;
    /** Cursor `state.vscdb`. Empty = auto-detect. */
    cursorStateDb: string;
  };
  overlay: {
    /** `taskbar`: one-line token strip sitting on the taskbar. `panel`: detailed floating panel. */
    mode: 'taskbar' | 'panel';
    taskbar: {
      /** Right edge and top of the strip once dragged; null = docked left of the system tray. */
      right: number | null;
      y: number | null;
      /** Default gap between the strip and the right end of the taskbar (keeps the tray and clock visible). */
      rightMargin: number;
    };
    /** Panel position and width. */
    x: number | null;
    y: number | null;
    width: number;
    opacity: number;
    expanded: boolean;
    clickThrough: boolean;
    showUndetected: boolean;
    toggleShortcut: string;
    clickThroughShortcut: string;
  };
}

export const DEFAULT_CONFIG: Config = {
  dailyTokenBudget: 5_000_000,
  includeCacheReads: false,
  compactAtPercent: 60,
  newChatAtPercent: 85,
  activeChatMaxAgeMinutes: 180,
  pollIntervalSeconds: 10,
  notifications: true,
  providers: { cursor: true, claude: true, codex: true },
  activity: { processes: true, recentMinutes: 30, showAll: false },
  network: { cursorApi: true, claudeUsageApi: true, intervalSeconds: 180 },
  contextWindows: { claude: 0, codex: 0, cursor: 200_000 },
  paths: { claudeDirs: [], codexHome: '', cursorStateDb: '' },
  overlay: {
    mode: 'taskbar',
    taskbar: { right: null, y: null, rightMargin: 360 },
    x: null,
    y: null,
    width: 340,
    opacity: 0.94,
    expanded: true,
    clickThrough: false,
    showUndetected: false,
    toggleShortcut: 'Control+Alt+T',
    clickThroughShortcut: 'Control+Alt+K',
  },
};

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isPlain(base) || !isPlain(override)) return (override === undefined ? base : override) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (!(k in base)) continue;
    const b = (base as Plain)[k];
    if (isPlain(b)) out[k] = mergeConfig(b, v);
    else if (v !== undefined && (b === null || v === null || typeof v === typeof b)) out[k] = v;
  }
  return out as T;
}

export function loadConfig(file: string): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      saveConfig(file, DEFAULT_CONFIG);
      return structuredClone(DEFAULT_CONFIG);
    }
    console.error(`[tokenslayer] could not parse ${file}, using defaults:`, err);
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(file: string, cfg: Config): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
