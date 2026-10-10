/** Calls one of the app's API routes from the browser. The login cookie goes along automatically. Throws with the server's message. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const post = (body: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** "ae" gives "UAE"; "ae,us" gives "UAE + US". */
export const countryName = (geo: string) =>
  geo
    .split(',')
    .map((g) => (g === 'ae' ? 'UAE' : g === 'us' ? 'US' : g))
    .join(' + ');

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
