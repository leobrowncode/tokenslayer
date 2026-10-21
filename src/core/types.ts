export type ProviderId = 'cursor' | 'claude' | 'codex';

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** A plan / rate-limit window reported by the vendor (e.g. Claude "5h", Codex "7d", Cursor "Plan"). */
export interface LimitWindow {
  label: string;
  usedPercent: number;
  resetsAt?: number;
}

export interface ChatInfo {
  id: string;
  title?: string;
  model?: string;
  contextTokens: number;
  contextWindow: number;
  contextPercent: number;
  turns?: number;
  updatedAt: number;
  /** True when the context size is a heuristic estimate rather than a reported number. */
  estimated?: boolean;
}

export interface ProviderSnapshot {
  id: ProviderId;
  name: string;
  detected: boolean;
  usageToday: TokenUsage;
  tokensToday: number;
  usageSource?: string;
  /** Most recently active chats first. */
  chats: ChatInfo[];
  limits: LimitWindow[];
  notes: string[];
  error?: string;
}

export type AlertLevel = 'ok' | 'compact' | 'newChat';

export interface Advice {
  level: Exclude<AlertLevel, 'ok'>;
  provider: ProviderId;
  providerName: string;
  chatId: string;
  chatTitle?: string;
  contextPercent: number;
  message: string;
  actions: Array<{ label: string; copy?: string }>;
}

export interface OverlaySnapshot {
  generatedAt: number;
  tokensToday: number;
  dailyBudget: number;
  budgetPercent: number;
  includeCacheReads: boolean;
  providers: ProviderSnapshot[];
  advice: Advice[];
  topLevel: AlertLevel;
  thresholds: { compactAt: number; newChatAt: number };
}
