import { marketShort } from './markets';

/** Calls one of the app's API routes from the browser. The login cookie goes along automatically. Throws with the server's message. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const post = (body: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/**
 * Writes personal openers from the news for up to `count` people waiting (emails ready, not personalized), in batches
 * of 10 so each request stays short. Used straight after Apollo finds emails, so every email is personalized without
 * anyone pressing a button.
 */
export async function personalizeWaiting(count: number, onProgress?: (done: number, none: number) => void): Promise<{ done: number; none: number; failed: number; error?: string }> {
  const total = { done: 0, none: 0, failed: 0, error: undefined as string | undefined };
  let left = count;
  while (left > 0) {
    const r = await api<{ summary: { done: number; none: number; failed: number; error?: string } }>('/api/outreach', post({ action: 'personalize', limit: Math.min(10, left) }));
    total.done += r.summary.done;
    total.none += r.summary.none;
    total.failed += r.summary.failed;
    if (r.summary.error) total.error = r.summary.error;
    onProgress?.(total.done, total.none);
    const handled = r.summary.done + r.summary.none;
    if (handled === 0) break; // nobody left, or every attempt failed
    left -= handled;
  }
  return total;
}

/** "af" gives "Africa"; "af,eu" gives "Africa + Europe". */
export const countryName = (geo: string) => geo.split(',').map(marketShort).join(' + ');

/** 0.0312 gives "3.1%"; nothing to divide gives "—". */
export const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');

/** Reads a CSV file's text into rows of cells: quoted cells, commas and line breaks inside quotes, and a semicolon or tab separator. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
