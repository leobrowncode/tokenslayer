import type { Config } from './config';
import type { Advice, AlertLevel, ChatInfo, ProviderId, ProviderSnapshot } from './types';

const COMMANDS: Record<ProviderId, { compact: Advice['actions']; newChat: Advice['actions'] }> = {
  claude: {
    compact: [{ label: 'Copy /compact', copy: '/compact' }],
    newChat: [
      { label: 'Copy /clear', copy: '/clear' },
      { label: 'Copy /compact', copy: '/compact' },
    ],
  },
  codex: {
    compact: [{ label: 'Copy /compact', copy: '/compact' }],
    newChat: [
      { label: 'Copy /new', copy: '/new' },
      { label: 'Copy /compact', copy: '/compact' },
    ],
  },
  cursor: {
    compact: [{ label: 'Copy /summarize', copy: '/summarize' }],
    newChat: [{ label: 'New chat: Ctrl+N in the chat pane' }, { label: 'Copy /summarize', copy: '/summarize' }],
  },
};

export function levelFor(percent: number, cfg: Pick<Config, 'compactAtPercent' | 'newChatAtPercent'>): AlertLevel {
  if (percent >= cfg.newChatAtPercent) return 'newChat';
  if (percent >= cfg.compactAtPercent) return 'compact';
  return 'ok';
}

const RANK: Record<AlertLevel, number> = { ok: 0, compact: 1, newChat: 2 };
export const levelRank = (l: AlertLevel): number => RANK[l];

function message(p: ProviderSnapshot, chat: ChatInfo, level: Exclude<AlertLevel, 'ok'>): string {
  const pct = `${Math.round(chat.contextPercent)}%`;
  const approx = chat.estimated ? '~' : '';
  if (level === 'newChat') {
    return `Context is ${approx}${pct} full. Start a new chat (carry over a short summary) to stop paying for the whole history on every turn.`;
  }
  return `Context is ${approx}${pct} full. Compact or summarize now to shrink what gets re-sent each turn.`;
}

export function buildAdvice(providers: ProviderSnapshot[], cfg: Config): Advice[] {
  const out: Advice[] = [];
  for (const p of providers) {
    for (const chat of p.chats) {
      const level = levelFor(chat.contextPercent, cfg);
      if (level === 'ok') continue;
      out.push({
        level,
        provider: p.id,
        providerName: p.name,
        chatId: chat.id,
        chatTitle: chat.title,
        contextPercent: chat.contextPercent,
        message: message(p, chat, level),
        actions: COMMANDS[p.id][level],
      });
    }
  }
  return out.sort((a, b) => RANK[b.level] - RANK[a.level] || b.contextPercent - a.contextPercent);
}

export function topLevel(advice: Advice[]): AlertLevel {
  return advice.reduce<AlertLevel>((acc, a) => (RANK[a.level] > RANK[acc] ? a.level : acc), 'ok');
}

/**
 * Decides which advice deserves a desktop notification: only when a chat crosses into a higher
 * level than it was last notified at. Dropping back below a level (after compacting) re-arms it.
 */
export class AlertTracker {
  private notified = new Map<string, AlertLevel>();
  private dismissed = new Map<string, AlertLevel>();

  private key(a: { provider: ProviderId; chatId: string }): string {
    return `${a.provider}:${a.chatId}`;
  }

  dismiss(a: { provider: ProviderId; chatId: string; level: AlertLevel }): void {
    this.dismissed.set(this.key(a), a.level);
  }

  /** Removes dismissed advice and returns the visible list plus the items that should notify. */
  process(advice: Advice[]): { visible: Advice[]; notify: Advice[] } {
    const current = new Map(advice.map((a) => [this.key(a), a]));
    for (const [k, lvl] of this.notified) {
      const a = current.get(k);
      if (!a || RANK[a.level] < RANK[lvl]) {
        if (a) this.notified.set(k, a.level);
        else this.notified.delete(k);
      }
    }
    for (const [k, lvl] of this.dismissed) {
      const a = current.get(k);
      if (!a || RANK[a.level] < RANK[lvl]) this.dismissed.delete(k);
    }
    const notify: Advice[] = [];
    const visible: Advice[] = [];
    for (const a of advice) {
      const k = this.key(a);
      const d = this.dismissed.get(k);
      if (d && RANK[a.level] <= RANK[d]) continue;
      if (d) this.dismissed.delete(k);
      visible.push(a);
      const prev = this.notified.get(k) ?? 'ok';
      if (RANK[a.level] > RANK[prev]) {
        notify.push(a);
        this.notified.set(k, a.level);
      }
    }
    return { visible, notify };
  }
}
