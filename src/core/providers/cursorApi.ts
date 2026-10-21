import { clampPercent, emptyUsage, num, parseTime } from '../tokens';
import type { LimitWindow, TokenUsage } from '../types';
import { fetchJson } from './provider';

const BASE = 'https://cursor.com';

export interface CursorRemoteUsage {
  limits: LimitWindow[];
  usageToday?: TokenUsage;
  notes: string[];
}

/** The JWT `sub` looks like `auth0|user_XXXX`; the dashboard cookie wants the part after the pipe. */
export function cursorUserId(jwt: string): string | undefined {
  const part = jwt.split('.')[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const sub: unknown = payload?.sub;
    return typeof sub === 'string' ? sub.split('|').pop() : undefined;
  } catch {
    return undefined;
  }
}

export function parseUsageSummary(j: any): LimitWindow[] {
  const out: LimitWindow[] = [];
  const resetsAt = parseTime(j?.billingCycleEnd);
  const plan = j?.individualUsage?.plan;
  if (plan && plan.enabled !== false) {
    let pct: number | undefined;
    if (typeof plan.totalPercentUsed === 'number') pct = plan.totalPercentUsed;
    else if (num(plan.limit) > 0) pct = (num(plan.used) / num(plan.limit)) * 100;
    if (pct !== undefined) out.push({ label: 'Plan', usedPercent: clampPercent(pct), resetsAt });
  }
  const od = j?.individualUsage?.onDemand;
  if (od?.enabled && num(od.limit) > 0) {
    out.push({ label: 'On-demand', usedPercent: clampPercent((num(od.used) / num(od.limit)) * 100), resetsAt });
  }
  return out;
}

/** Legacy request-based plans: `{ "gpt-4": { numRequests, maxRequestUsage }, startOfMonth }`. */
export function parseLegacyUsage(j: any): LimitWindow[] {
  const premium = j?.['gpt-4'];
  if (!premium || !(num(premium.maxRequestUsage) > 0)) return [];
  const start = parseTime(j.startOfMonth);
  let resetsAt: number | undefined;
  if (start) {
    const d = new Date(start);
    d.setMonth(d.getMonth() + 1);
    resetsAt = d.getTime();
  }
  return [
    {
      label: 'Requests',
      usedPercent: clampPercent((num(premium.numRequests) / num(premium.maxRequestUsage)) * 100),
      resetsAt,
    },
  ];
}

export function sumUsageEvents(events: any[], since: number): TokenUsage {
  const out = emptyUsage();
  for (const e of events) {
    const at = parseTime(e?.timestamp);
    if (at !== undefined && at < since) continue;
    const t = e?.tokenUsage;
    if (!t) continue;
    out.input += num(t.inputTokens);
    out.output += num(t.outputTokens);
    out.cacheWrite += num(t.cacheWriteTokens);
    out.cacheRead += num(t.cacheReadTokens);
  }
  return out;
}

export async function fetchCursorUsage(
  fetchImpl: typeof fetch,
  accessToken: string,
  since: number,
  now: number,
): Promise<CursorRemoteUsage> {
  const userId = cursorUserId(accessToken);
  if (!userId) throw new Error('could not read user id from Cursor session token');
  const headers = {
    Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`,
    Origin: BASE,
    Referer: `${BASE}/dashboard`,
    'Content-Type': 'application/json',
    'User-Agent': 'tokenslayer-overlay',
  };
  const result: CursorRemoteUsage = { limits: [], notes: [] };
  const errors: string[] = [];

  try {
    result.limits = parseUsageSummary(await fetchJson(fetchImpl, `${BASE}/api/usage-summary`, { headers }));
  } catch (err) {
    errors.push(`usage-summary: ${(err as Error).message}`);
  }
  if (!result.limits.length) {
    try {
      result.limits = parseLegacyUsage(
        await fetchJson(fetchImpl, `${BASE}/api/usage?user=${encodeURIComponent(userId)}`, { headers }),
      );
    } catch (err) {
      errors.push(`usage: ${(err as Error).message}`);
    }
  }

  try {
    const events: any[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 20; page++) {
      const j = await fetchJson(fetchImpl, `${BASE}/api/dashboard/get-filtered-usage-events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ startDate: String(since), endDate: String(now), page, pageSize }),
      });
      const batch: any[] = Array.isArray(j?.usageEventsDisplay) ? j.usageEventsDisplay : [];
      events.push(...batch);
      const total = num(j?.totalUsageEventsCount);
      if (batch.length < pageSize || (total > 0 && events.length >= total)) break;
    }
    result.usageToday = sumUsageEvents(events, since);
  } catch (err) {
    errors.push(`usage events: ${(err as Error).message}`);
  }

  if (!result.limits.length && !result.usageToday) throw new Error(errors.join('; '));
  result.notes = errors;
  return result;
}
