import type { Geo } from './geo';
import { GEOS } from './geo';

export type ApiKeys = { serper: string; jina: string; deepseek: string; apollo?: string; instantly?: string };

/** Lookups kept between runs (places, domains), so each is made once. */
export type EnrichmentCache = {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
};

/** Everything a step needs from the outside world; tests pass fakes. */
export type Services = {
  fetch: typeof fetch;
  keys: ApiKeys;
  cache?: EnrichmentCache;
};

export function keysFromEnv(env: NodeJS.ProcessEnv = process.env): ApiKeys {
  return { serper: env.SERPER_API_KEY ?? '', jina: env.JINA_API_KEY ?? '', deepseek: env.DEEPSEEK_API_KEY ?? '', apollo: env.APOLLO_API_KEY ?? '', instantly: env.INSTANTLY_API_KEY ?? '' };
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request(svc: Services, url: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await svc.fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    if (!res.ok) {
      let detail = body.slice(0, 300);
      try {
        const j = JSON.parse(body);
        detail = j?.errors?.[0]?.details || j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : detail);
      } catch {}
      throw new HttpError(`${res.status} ${detail}`.trim(), res.status);
    }
    return body;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s: ${new URL(url).host}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T = unknown>(svc: Services, url: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  return JSON.parse(await request(svc, url, init, timeoutMs)) as T;
}

export type SerperResult = { title?: string; link?: string; snippet?: string; subtitle?: string };

/** Google search through Serper for one country; `page` 2, 3… gives the next ten results. */
export async function googleSearch(svc: Services, q: string, geo: Geo, page = 1): Promise<SerperResult[]> {
  if (!svc.keys.serper) throw new Error('SERPER_API_KEY is not set');
  const gl = GEOS[geo].gl;
  const data = await getJson<{ organic?: SerperResult[] }>(svc, 'https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': svc.keys.serper, 'content-type': 'application/json' },
    body: JSON.stringify(page > 1 ? { q, gl, num: 10, page } : { q, gl, num: 10 }),
  });
  return Array.isArray(data.organic) ? data.organic : [];
}

export type NewsResult = { title?: string; link?: string; snippet?: string; date?: string; source?: string };

/** Google News through Serper for one country, from the past year. */
export async function newsSearch(svc: Services, q: string, geo: Geo): Promise<NewsResult[]> {
  if (!svc.keys.serper) throw new Error('SERPER_API_KEY is not set');
  const data = await getJson<{ news?: NewsResult[] }>(svc, 'https://google.serper.dev/news', {
    method: 'POST',
    headers: { 'X-API-KEY': svc.keys.serper, 'content-type': 'application/json' },
    body: JSON.stringify({ q, gl: GEOS[geo].gl, num: 5, tbs: 'qdr:y' }),
  });
  return Array.isArray(data.news) ? data.news : [];
}

/** Runs `fn` over `items` with at most `limit` running at once, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
