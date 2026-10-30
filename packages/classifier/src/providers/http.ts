// One JSON POST/GET helper for the HTTP providers: a timeout, an injectable fetch (tests use a mock server or a
// stub), and the error mapping every provider shares: refused/timeout -> offline, 401/403 -> unauthorized,
// 429 -> rate_limited (with Retry-After), other non-2xx or unparsable bodies -> bad_response.

import { ClassifierError } from '../types.ts';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface HttpOpts { fetch?: FetchLike; timeoutMs?: number; headers?: Record<string, string>; signal?: AbortSignal }

export async function httpJson(method: 'GET' | 'POST', url: string, body: unknown, o: HttpOpts = {}): Promise<unknown> {
  const f: FetchLike = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 30_000);
  const onAbort = () => ctl.abort();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await f(url, {
      method,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(o.headers ?? {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctl.signal,
    });
  } catch (e) {
    const why = ctl.signal.aborted ? `timed out or aborted after ${o.timeoutMs ?? 30_000} ms` : (e as Error).message;
    throw new ClassifierError('offline', `${hostOf(url)}: ${why}`);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
  }
  const text = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) throw new ClassifierError('unauthorized', `${hostOf(url)}: HTTP ${res.status} (check the API key)`);
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    throw new ClassifierError('rate_limited', `${hostOf(url)}: HTTP 429 rate limited`, Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 30_000);
  }
  if (res.status === 503) throw new ClassifierError('offline', `${hostOf(url)}: HTTP 503 (server loading or unavailable)`);
  if (res.status < 200 || res.status >= 300) throw new ClassifierError('bad_response', `${hostOf(url)}: HTTP ${res.status} ${errorText(text)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ClassifierError('bad_response', `${hostOf(url)}: response is not JSON`);
  }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'endpoint'; }
}

function errorText(t: string): string {
  try {
    const j = JSON.parse(t) as { error?: { message?: string } | string; detail?: unknown };
    const m = typeof j.error === 'string' ? j.error : j.error?.message ?? (typeof j.detail === 'string' ? j.detail : '');
    return String(m).slice(0, 160);
  } catch { return ''; }
}
