import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BATCH_SIZE, bulkMatch, splitFullName, toDetail, usableEmail } from '../src/lib/apollo';
import { enrichStatus, runEnrichment, statusOf } from '../src/lib/enrich';
import type { Person } from '../src/lib/linkedin';
import type { Services } from '../src/lib/services';
import { savePeople, type Db } from '../src/lib/store';

type Detail = Record<string, string>;
type ApolloReply = { matches: unknown[]; credits_consumed?: number };

/** A fake Apollo: `respond` builds the reply for each request; `status` can make a request fail. */
function fakeApollo(respond: (details: Detail[], call: number) => ApolloReply, status: (call: number) => number = () => 200) {
  const calls: { url: string; headers: Record<string, string>; details: Detail[] }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const details = (JSON.parse(String(init.body)) as { details: Detail[] }).details;
    calls.push({ url, headers, details });
    const code = status(calls.length);
    if (code !== 200) return new Response(JSON.stringify({ error: 'rate limited' }), { status: code });
    return new Response(JSON.stringify(respond(details, calls.length)), { status: 200 });
  }) as unknown as typeof fetch;
  const svc: Services = { fetch: f, keys: { serper: '', jina: '', deepseek: '', apollo: 'apollo-key' } };
  return { svc, calls };
}

const found = (d: Detail, o: Record<string, unknown> = {}) => ({
  email: 'someone@acme.com',
  email_status: 'verified',
  match_confidence: 'high',
  title: 'CEO',
  linkedin_url: d.linkedin_url,
  organization: { name: 'Acme' },
  ...o,
});

describe('request building', () => {
  it('splits names', () => {
    expect(splitFullName('Jason English')).toEqual({ first_name: 'Jason', last_name: 'English' });
    expect(splitFullName('Mustafa Al Ansari')).toEqual({ first_name: 'Mustafa', last_name: 'Al Ansari' });
    expect(splitFullName('Cher')).toEqual({ first_name: 'Cher' });
    expect(splitFullName('')).toEqual({});
  });

  it('sends only identifying fields', () => {
    expect(toDetail({ linkedin: 'https://www.linkedin.com/in/ab', name: 'A B', company: 'Acme' })).toEqual({
      linkedin_url: 'https://www.linkedin.com/in/ab',
      first_name: 'A',
      last_name: 'B',
      organization_name: 'Acme',
    });
  });

  it('rejects placeholder emails', () => {
    expect(usableEmail('email_not_unlocked@domain.com')).toBe('');
    expect(usableEmail(null)).toBe('');
    expect(usableEmail('ab@acme.com')).toBe('ab@acme.com');
  });

  it('rates matches', () => {
    expect(statusOf(null)).toBe('no_match');
    expect(statusOf({ email: '', emailStatus: '', confidence: 'high', title: '', company: '', linkedin: '' })).toBe('no_email');
    expect(statusOf({ email: 'a@b.com', emailStatus: 'verified', confidence: 'low', title: '', company: '', linkedin: '' })).toBe('low_confidence');
    expect(statusOf({ email: 'a@b.com', emailStatus: 'verified', confidence: 'medium', title: '', company: '', linkedin: '' })).toBe('matched');
  });
});

describe('bulkMatch', () => {
  const inputs = Array.from({ length: 25 }, (_, i) => ({ linkedin: `https://www.linkedin.com/in/p${i}`, name: `P${i} X` }));

  it('sends ten people per request with the API key header, and no reveal or waterfall options', async () => {
    const { svc, calls } = fakeApollo((details) => ({ matches: details.map((d) => found(d)), credits_consumed: details.length }));
    const out = await bulkMatch(svc, inputs);
    expect(calls.map((c) => c.details.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 5]);
    expect(calls[0].headers['x-api-key']).toBe('apollo-key');
    expect(calls[0].url).toBe('https://api.apollo.io/api/v1/people/bulk_match');
    expect(calls.every((c) => !/reveal|waterfall|webhook/i.test(c.url))).toBe(true);
    expect(out.credits).toBe(25);
    expect(out.matches).toHaveLength(25);
    expect(out.matches[24]?.linkedin).toBe('https://www.linkedin.com/in/p24');
  });

  it('keeps order and turns missing or unlocked-placeholder emails into no email', async () => {
    const { svc } = fakeApollo((details) => ({ matches: [null, found(details[1], { email: 'email_not_unlocked@acme.com' })] }));
    const out = await bulkMatch(svc, inputs.slice(0, 2));
    expect(out.matches[0]).toBeNull();
    expect(out.matches[1]).toMatchObject({ email: '' });
  });

  it('fails clearly without a key', async () => {
    const { svc } = fakeApollo(() => ({ matches: [] }));
    svc.keys.apollo = '';
    await expect(bulkMatch(svc, inputs.slice(0, 1))).rejects.toThrow('APOLLO_API_KEY is not set');
  });

  it('reports how far it got when a later request fails', async () => {
    const { svc } = fakeApollo((details) => ({ matches: details.map((d) => found(d)), credits_consumed: 10 }), (call) => (call === 2 ? 429 : 200));
    const err = (await bulkMatch(svc, inputs).catch((e) => e)) as Error & { partial?: { matches: unknown[]; credits: number } };
    expect(err.message).toMatch(/Apollo: 429.*10 of 25 people done/);
    expect(err.partial?.matches).toHaveLength(10);
    expect(err.partial?.credits).toBe(10);
  });
});

// A real (embedded) Postgres, as in the store tests.
let pg: PGlite;
let db: Db;
beforeAll(() => {
  pg = new PGlite();
});
beforeEach(async () => {
  await pg.exec('DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS enrichment_log');
  db = { query: async (text, params = []) => (await pg.query(text, params as unknown[])).rows as never };
});

const person = (slug: string, o: Partial<Person> = {}): Person => ({
  name: `${slug.toUpperCase()} Person`,
  title: 'Founder & CEO',
  company: `${slug}co`,
  companyTruncated: false,
  location: 'Dubai',
  geoMatch: 'match',
  linkedin: `https://www.linkedin.com/in/${slug}`,
  snippet: '',
  inferred: false,
  ...o,
});
const rows = () => db.query<{ linkedin_url: string; email: string; apollo_status: string; apollo_tier: number }>('SELECT linkedin_url, email, apollo_status, apollo_tier FROM people ORDER BY id');

describe('runEnrichment', () => {
  it('tries the LinkedIn URL first, then name and company, and never sends non-targets', async () => {
    await savePeople(db, [person('a'), person('b'), person('c', { company: '' }), person('vp', { title: 'Vice President, Sales' })], 'ae', 'q');
    const { svc, calls } = fakeApollo((details, call) => {
      if (call === 1) {
        return {
          matches: details.map((d) => {
            if (d.linkedin_url?.endsWith('/a')) return found(d);
            if (d.linkedin_url?.endsWith('/b')) return found(d, { email: null });
            return null;
          }),
          credits_consumed: 1,
        };
      }
      return { matches: details.map((d) => found(d, { email: 'b@bco.com', match_confidence: 'medium' })), credits_consumed: 1 };
    });

    const summary = await runEnrichment(svc, db, { limit: 10 });
    expect(calls).toHaveLength(2);
    expect(calls[0].details).toHaveLength(3); // a, b, c: the vice president is not a target
    expect(calls[1].details).toEqual([{ first_name: 'B', last_name: 'Person', organization_name: 'bco' }]); // only b has a company and no email
    expect(summary).toMatchObject({ requested: 3, matched: 2, withEmail: 2, credits: 2 });
    const saved = await rows();
    expect(saved.find((r) => r.linkedin_url.endsWith('/a'))).toMatchObject({ apollo_status: 'matched', apollo_tier: 1, email: 'someone@acme.com' });
    expect(saved.find((r) => r.linkedin_url.endsWith('/b'))).toMatchObject({ apollo_status: 'matched', apollo_tier: 2, email: 'b@bco.com' });
    expect(saved.find((r) => r.linkedin_url.endsWith('/c'))).toMatchObject({ apollo_status: 'no_match', email: '' });
    expect(saved.find((r) => r.linkedin_url.endsWith('/vp'))).toMatchObject({ apollo_status: 'none' });
  });

  it('looks nobody up twice', async () => {
    await savePeople(db, [person('a')], 'ae', 'q');
    const { svc, calls } = fakeApollo((details) => ({ matches: details.map((d) => found(d)), credits_consumed: 1 }));
    await runEnrichment(svc, db, { limit: 10 });
    const again = await runEnrichment(svc, db, { limit: 10 });
    expect(again.requested).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('labels a low-confidence email but still counts it as ready', async () => {
    await savePeople(db, [person('a')], 'ae', 'q');
    const { svc } = fakeApollo((details) => ({ matches: details.map((d) => found(d, { match_confidence: 'low' })), credits_consumed: 1 }));
    const summary = await runEnrichment(svc, db, { limit: 10 });
    expect(summary.withEmail).toBe(1);
    expect((await rows())[0]).toMatchObject({ apollo_status: 'low_confidence', email: 'someone@acme.com' });
    expect((await enrichStatus(db)).withEmail).toBe(1);
  });

  it('stops at the daily limit', async () => {
    await savePeople(db, [person('a'), person('b'), person('c')], 'ae', 'q');
    const { svc } = fakeApollo((details) => ({ matches: details.map((d) => found(d)), credits_consumed: 1 }));
    const first = await runEnrichment(svc, db, { limit: 10, dailyLimit: 2 });
    expect(first.requested).toBe(2);
    const second = await runEnrichment(svc, db, { limit: 10, dailyLimit: 2 });
    expect(second).toMatchObject({ requested: 0, stopped: 'Daily limit of 2 lookups reached' });
    const status = await enrichStatus(db, 2);
    expect(status).toMatchObject({ usedToday: 2, pending: 1, creditsToday: 1 }); // one Apollo request, which the fake charged 1 credit for
  });

  it('leaves people unmarked when Apollo fails, so they can be retried', async () => {
    await savePeople(db, [person('a'), person('b')], 'ae', 'q');
    const { svc } = fakeApollo(() => ({ matches: [] }), () => 500);
    const summary = await runEnrichment(svc, db, { limit: 10 });
    expect(summary.requested).toBe(0);
    expect(summary.stopped).toMatch(/Apollo/);
    expect((await rows()).every((r) => r.apollo_status === 'none')).toBe(true);
  });
});
