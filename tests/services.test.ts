import { describe, expect, it } from 'vitest';
import { HttpError, googleSearch, mapLimit, type Services } from '../src/lib/services';

function fake(handler: (url: string, init: RequestInit) => Response): { svc: Services; calls: { url: string; body: any }[] } {
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { svc: { fetch: f, keys: { serper: 'key', jina: '', deepseek: '' } }, calls };
}

const ok = (organic: unknown[]) => new Response(JSON.stringify({ organic }), { status: 200 });

describe('googleSearch', () => {
  it('sends the country code for the UAE', async () => {
    const { svc, calls } = fake(() => ok([{ title: 'A', link: 'https://x.com' }]));
    const res = await googleSearch(svc, 'founder Dubai', 'ae');
    expect(res).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ q: 'founder Dubai', gl: 'ae', num: 10 });
  });

  it('sends the country code for the US and asks for page 2', async () => {
    const { svc, calls } = fake(() => ok([]));
    await googleSearch(svc, 'ceo austin', 'us', 2);
    expect(calls[0].body).toMatchObject({ gl: 'us', page: 2 });
  });

  it('fails clearly without a key', async () => {
    const { svc } = fake(() => ok([]));
    svc.keys.serper = '';
    await expect(googleSearch(svc, 'q', 'ae')).rejects.toThrow('SERPER_API_KEY is not set');
  });

  it('turns an API error into an HttpError with the status', async () => {
    const { svc } = fake(() => new Response(JSON.stringify({ message: 'Not enough credits' }), { status: 400 }));
    await expect(googleSearch(svc, 'q', 'ae')).rejects.toMatchObject({ status: 400, message: '400 Not enough credits' });
    await expect(googleSearch(svc, 'q', 'ae')).rejects.toBeInstanceOf(HttpError);
  });

  it('returns an empty list when the response has no organic results', async () => {
    const { svc } = fake(() => new Response('{}', { status: 200 }));
    expect(await googleSearch(svc, 'q', 'us')).toEqual([]);
  });
});

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
