import { formatAgo, formatDuration, formatTokens } from '../core/format';
import type { Advice, AlertLevel, ChatInfo, LimitWindow, OverlaySnapshot, ProviderId, ProviderSnapshot } from '../core/types';
import type { OverlayApi, OverlayUpdate } from '../shared/api';

declare global {
  interface Window {
    tokenslayer: OverlayApi;
  }
}

const api = window.tokenslayer;
const root = document.getElementById('app')!;

const PROVIDER_COLOR: Record<ProviderId, string> = {
  cursor: 'var(--cursor)',
  claude: 'var(--claude)',
  codex: 'var(--codex)',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  logo: '<circle cx="12" cy="12" r="10.5" fill="#34d399"/><circle cx="12" cy="12" r="7.6" fill="none" stroke="#1f7a5c" stroke-width="1.4"/><path d="M17.5 5.5 6.5 18.5" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>',
  compact:
    '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  newChat:
    '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 8.5v7M9.5 12h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  chevronUp: '<path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronDown: '<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  close: '<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  menu: '<circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/>',
};

function svg(name: keyof typeof ICONS, cls?: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  if (cls) el.setAttribute('class', cls);
  // Icon markup is a static constant above, never user data.
  el.innerHTML = ICONS[name];
  return el;
}

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; title?: string; style?: Record<string, string>; onclick?: () => void } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.title) el.title = props.title;
  // The CSP forbids style attributes; CSSOM property writes are allowed.
  if (props.style) for (const [k, v] of Object.entries(props.style)) el.style.setProperty(k, v);
  if (props.onclick) el.addEventListener('click', props.onclick);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

let state: OverlayUpdate | null = null;
let adviceOpen = false;
let lastTop: AlertLevel = 'ok';
let copied: string | null = null;

function levelOf(pct: number, s: OverlaySnapshot): AlertLevel {
  if (pct >= s.thresholds.newChatAt) return 'newChat';
  if (pct >= s.thresholds.compactAt) return 'compact';
  return 'ok';
}

function bar(pct: number, cls: string, marks: number[] = [], thick = false): HTMLElement {
  const b = h('div', { class: `bar${thick ? ' thick' : ''}` });
  b.append(h('div', { class: `fill ${cls}`, style: { width: `${Math.max(0, Math.min(100, pct))}%` } }));
  for (const m of marks) b.append(h('div', { class: 'mark', style: { left: `${m}%` } }));
  return b;
}

function limitLevel(pct: number): string {
  return pct >= 90 ? 'newChat' : pct >= 70 ? 'compact' : 'ok';
}

function limitRow(l: LimitWindow, now: number): HTMLElement {
  const resets = l.resetsAt ? `resets in ${formatDuration(l.resetsAt - now)}` : '';
  return h(
    'div',
    { class: 'limit', title: `${l.label} limit: ${l.usedPercent.toFixed(1)}% used${resets ? `, ${resets}` : ''}` },
    h('span', {}, l.label),
    bar(l.usedPercent, limitLevel(l.usedPercent)),
    h('b', {}, `${Math.round(l.usedPercent)}%`),
  );
}

function renderHeader(s: OverlaySnapshot | null, ui: OverlayUpdate['ui']): HTMLElement {
  const logo = svg('logo', 'logo');
  const today = h('div', { class: 'today' });
  if (s) {
    today.append(h('b', {}, formatTokens(s.tokensToday)));
    today.append(s.dailyBudget > 0 ? ` / ${formatTokens(s.dailyBudget)} today` : ' tokens today');
  } else {
    today.append('scanning…');
  }

  const head = h('div', { class: 'header' }, logo, h('span', { class: 'brand' }, 'TokenSlayer'), today);

  if (s && s.topLevel !== 'ok') {
    const top = s.advice[0];
    const btn = h('button', {
      class: `icon-btn alert-btn ${s.topLevel}${adviceOpen ? '' : ' pulse'}`,
      title: top ? `${top.providerName}: ${top.level === 'newChat' ? 'start a new chat' : 'compact this chat'}` : '',
      onclick: () => {
        adviceOpen = !adviceOpen;
        render();
      },
    });
    btn.append(svg(s.topLevel === 'newChat' ? 'newChat' : 'compact'));
    head.append(btn);
  }

  const toggle = h('button', {
    class: 'icon-btn',
    title: ui.expanded ? 'Collapse' : 'Expand',
    onclick: () => api.setExpanded(!ui.expanded),
  });
  toggle.append(svg(ui.expanded ? 'chevronUp' : 'chevronDown'));
  const menu = h('button', { class: 'icon-btn', title: 'Menu', onclick: () => api.menu() });
  menu.append(svg('menu'));
  const close = h('button', { class: 'icon-btn', title: `Hide (${ui.toggleShortcut} to show)`, onclick: () => api.hide() });
  close.append(svg('close'));
  head.append(toggle, menu, close);
  return head;
}

function renderGlobal(s: OverlaySnapshot): HTMLElement {
  const detected = s.providers.filter((p) => p.inUse);
  const denom = s.dailyBudget > 0 ? Math.max(s.dailyBudget, s.tokensToday) : Math.max(1, s.tokensToday);
  const b = h('div', { class: 'bar thick' });
  let left = 0;
  for (const p of detected) {
    const w = (p.tokensToday / denom) * 100;
    if (w <= 0) continue;
    b.append(h('div', { class: 'fill split', style: { left: `${left}%`, width: `${w}%`, background: PROVIDER_COLOR[p.id] } }));
    left += w;
  }

  const legend = h('div', { class: 'legend' });
  for (const p of detected) {
    legend.append(
      h('span', { style: { '--c': PROVIDER_COLOR[p.id] }, title: `${p.name}: ${p.tokensToday.toLocaleString()} tokens today (${p.usageSource ?? 'n/a'})` }, `${shortName(p.id)} ${formatTokens(p.tokensToday)}`),
    );
  }
  const pctLabel = s.dailyBudget > 0 ? `${Math.round(s.budgetPercent)}% of budget` : '';
  const title = `Tokens used today across all tools${s.includeCacheReads ? ' (including cache reads)' : ' (excluding cache reads)'}`;
  return h('div', { class: 'global', title }, b, h('div', { class: 'global-meta' }, legend, h('span', {}, pctLabel)));
}

function shortName(id: ProviderId): string {
  return id === 'cursor' ? 'Cursor' : id === 'claude' ? 'Claude' : 'Codex';
}

function renderAdvice(list: Advice[]): HTMLElement {
  const wrap = h('div', { class: 'advice' });
  for (const a of list) {
    const actions = h('div', { class: 'actions' });
    for (const act of a.actions) {
      if (act.copy) {
        const text = act.copy;
        actions.append(
          h('button', { class: 'chip-btn', onclick: () => copy(text) }, copied === text ? 'Copied!' : act.label),
        );
      } else {
        actions.append(h('span', { class: 'chip-btn static' }, act.label));
      }
    }
    actions.append(
      h('button', { class: 'chip-btn ghost', onclick: () => api.dismiss({ provider: a.provider, chatId: a.chatId, level: a.level }) }, 'Dismiss'),
    );
    wrap.append(
      h(
        'div',
        { class: `advice-item ${a.level}` },
        h(
          'div',
          { class: 'advice-title' },
          svg(a.level === 'newChat' ? 'newChat' : 'compact'),
          `${a.level === 'newChat' ? 'Start a new chat' : 'Compact this chat'} · ${a.providerName}${a.chatTitle ? ` · ${a.chatTitle}` : ''}`,
        ),
        h('div', { class: 'advice-msg' }, a.message),
        actions,
      ),
    );
  }
  return wrap;
}

function copy(text: string): void {
  api.copy(text);
  copied = text;
  render();
  setTimeout(() => {
    copied = null;
    render();
  }, 1200);
}

function chatMeta(c: ChatInfo, p: ProviderSnapshot, now: number): HTMLElement {
  const approx = c.estimated ? '~' : '';
  const meta = h('div', { class: 'meta' });
  meta.append(h('span', {}, 'ctx ', h('b', {}, `${approx}${formatTokens(c.contextTokens)}`), ` / ${formatTokens(c.contextWindow)}`));
  if (c.turns) meta.append(h('span', {}, h('b', {}, String(c.turns)), ' turns'));
  meta.append(h('span', {}, 'today ', h('b', {}, formatTokens(p.tokensToday))));
  meta.append(h('span', {}, formatAgo(now - c.updatedAt)));
  if (p.chats.length > 1) meta.append(h('span', { title: p.chats.slice(1).map((x) => `${x.title ?? x.id}: ${Math.round(x.contextPercent)}%`).join('\n') }, `+${p.chats.length - 1} more`));
  return meta;
}

function renderCard(p: ProviderSnapshot, s: OverlaySnapshot): HTMLElement {
  const chat = p.chats[0];
  const worst = p.chats.reduce<AlertLevel>((acc, c) => {
    const l = levelOf(c.contextPercent, s);
    return l === 'newChat' || (l === 'compact' && acc === 'ok') ? l : acc;
  }, 'ok');
  const card = h('div', { class: `card ${worst}${p.detected ? '' : ' dim'}` });
  const head = h('div', { class: 'card-head' }, h('span', { class: 'dot', style: { '--c': PROVIDER_COLOR[p.id] } }), h('span', { class: 'pname' }, p.name));

  if (!p.detected) {
    head.append(h('span', { class: 'ptitle' }, 'not detected'));
    card.append(head);
    return card;
  }

  if (chat) {
    const lvl = levelOf(chat.contextPercent, s);
    head.append(h('span', { class: 'ptitle', title: [chat.title, chat.model].filter(Boolean).join(' · ') }, chat.title ?? chat.model ?? 'active chat'));
    if (worst !== 'ok') {
      const badge = svg(worst === 'newChat' ? 'newChat' : 'compact', `badge ${worst}`);
      head.append(badge);
    }
    head.append(h('span', { class: `pct ${lvl}` }, `${chat.estimated ? '~' : ''}${Math.round(chat.contextPercent)}%`));
    card.append(head, bar(chat.contextPercent, lvl, [s.thresholds.compactAt, s.thresholds.newChatAt]), chatMeta(chat, p, s.generatedAt));
  } else {
    head.append(h('span', { class: 'ptitle' }, 'no active chat'));
    head.append(h('span', { class: 'pct' }, formatTokens(p.tokensToday)));
    card.append(head);
  }

  if (p.limits.length) {
    const limits = h('div', { class: 'limits' });
    for (const l of p.limits) limits.append(limitRow(l, s.generatedAt));
    card.append(limits);
  }
  if (p.error) card.append(h('div', { class: 'note error' }, p.error));
  return card;
}

function renderChips(s: OverlaySnapshot, providers: ProviderSnapshot[]): HTMLElement {
  const wrap = h('div', { class: 'chips' });
  for (const p of providers) {
    const c = p.chats[0];
    const pct = c?.contextPercent ?? 0;
    const lvl = c ? levelOf(pct, s) : 'ok';
    const limit = p.limits.reduce((m, l) => Math.max(m, l.usedPercent), -1);
    const tip = [`${p.name}`, c ? `context ${Math.round(pct)}% (${formatTokens(c.contextTokens)} / ${formatTokens(c.contextWindow)})` : 'no active chat', limit >= 0 ? `highest limit ${Math.round(limit)}%` : '', `today ${formatTokens(p.tokensToday)}`]
      .filter(Boolean)
      .join('\n');
    wrap.append(
      h(
        'div',
        { class: `chip ${lvl}`, title: tip },
        h('div', { class: 'chip-head' }, h('span', {}, shortName(p.id)), h('b', {}, c ? `${Math.round(pct)}%` : '–')),
        bar(pct, lvl),
      ),
    );
  }
  return wrap;
}

function stripTip(p: ProviderSnapshot, now: number): string {
  const c = p.chats[0];
  const lines = [`${p.name}: ${p.tokensToday.toLocaleString()} tokens today`];
  if (c) lines.push(`Context ${c.estimated ? '~' : ''}${Math.round(c.contextPercent)}% (${formatTokens(c.contextTokens)} / ${formatTokens(c.contextWindow)})`);
  for (const l of p.limits) lines.push(`${l.label} limit ${Math.round(l.usedPercent)}%`);
  lines.push(p.running ? 'Running' : p.lastActivityAt ? `Last active ${formatAgo(now - p.lastActivityAt)}` : '');
  return lines.filter(Boolean).join('\n');
}

function renderStrip(s: OverlaySnapshot | null, ui: OverlayUpdate['ui']): void {
  root.className = `strip${ui.clickThrough ? ' locked' : ''}`;
  if (!s) {
    root.replaceChildren(h('span', { class: 'idle' }, '…'));
    return;
  }
  const used = s.providers.filter((p) => p.inUse);
  if (!used.length) {
    root.replaceChildren(h('span', { class: 'idle', title: 'No Cursor, Claude Code or Codex activity right now' }, 'idle'));
    return;
  }
  root.replaceChildren(
    ...used.map((p) =>
      h(
        'span',
        { class: 'tool', title: stripTip(p, s.generatedAt) },
        h('span', { class: 'dot', style: { '--c': PROVIDER_COLOR[p.id] } }),
        h('span', { class: 'tname' }, shortName(p.id)),
        h('b', {}, formatTokens(p.tokensToday)),
      ),
    ),
  );
}

function render(): void {
  if (!state) return;
  const { snapshot: s, ui } = state;
  if (ui.mode === 'taskbar') {
    renderStrip(s, ui);
    return;
  }
  root.className = `overlay level-${s?.topLevel ?? 'ok'}${ui.clickThrough ? ' locked' : ''}`;
  root.replaceChildren(renderHeader(s, ui));
  if (!s) return;

  const shown = s.providers.filter((p) => p.inUse || (ui.showUndetected && !p.detected));
  if (!s.providers.some((p) => p.inUse)) {
    const anyData = s.providers.some((p) => p.detected);
    root.append(
      h(
        'div',
        { class: 'empty' },
        anyData
          ? 'Cursor, Claude Code and Codex are not in use right now.'
          : 'No Cursor, Claude Code or Codex data found yet. Use one of them, or set custom paths in the config file (tray menu → Open config file).',
      ),
    );
    return;
  }
  root.append(renderGlobal(s));
  if (adviceOpen && s.advice.length) root.append(renderAdvice(s.advice));

  if (ui.expanded) {
    const list = h('div', { class: 'providers' });
    for (const p of shown) list.append(renderCard(p, s));
    root.append(list);
    const missing = s.providers.filter((p) => !p.inUse).map((p) => p.name);
    const notes = s.providers.flatMap((p) => p.notes.map((n) => `${p.name}: ${n}`));
    const footer = h(
      'div',
      { class: 'footer', title: notes.join('\n') },
      h('span', {}, `Updated ${new Date(s.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}${notes.length ? ` · ${notes.length} note${notes.length > 1 ? 's' : ''}` : ''}`),
      h('span', {}, missing.length && !ui.showUndetected ? `Not in use: ${missing.join(', ')}` : ui.clickThrough ? `Locked · ${ui.clickThroughShortcut}` : ''),
    );
    root.append(footer);
  } else {
    root.append(renderChips(s, shown.filter((p) => p.detected)));
  }
}

api.onUpdate((u) => {
  const top = u.snapshot?.topLevel ?? 'ok';
  if (top === 'ok') adviceOpen = false;
  else if (lastTop === 'ok' && u.ui.expanded) adviceOpen = true;
  lastTop = top;
  state = u;
  render();
});
api.onOpenAdvice(() => {
  adviceOpen = true;
  render();
});

new ResizeObserver(() => {
  const r = root.getBoundingClientRect();
  api.resize(Math.ceil(r.width), Math.ceil(r.height));
}).observe(root);
root.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.menu();
});

// The strip has no title bar, so it is dragged by hand; drag regions would swallow the right-click menu.
let dragFrom: { x: number; y: number } | null = null;
root.addEventListener('pointerdown', (e) => {
  if (state?.ui.mode !== 'taskbar' || e.button !== 0) return;
  dragFrom = { x: e.screenX, y: e.screenY };
  root.setPointerCapture(e.pointerId);
  api.drag('start', 0, 0);
});
root.addEventListener('pointermove', (e) => {
  if (dragFrom) api.drag('move', e.screenX - dragFrom.x, e.screenY - dragFrom.y);
});
const endDrag = (e: PointerEvent) => {
  if (!dragFrom) return;
  api.drag('end', e.screenX - dragFrom.x, e.screenY - dragFrom.y);
  dragFrom = null;
};
root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);
api.ready();
