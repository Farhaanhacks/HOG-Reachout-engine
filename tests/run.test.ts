import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchesFor } from '../src/lib/apollo-search';
import { toCsv } from '../src/lib/csv';
import { SEGMENTS, planQueries } from '../src/lib/icp';
import { createRun, finishRun, getRun, listRuns, runStep } from '../src/lib/run';
import type { Services } from '../src/lib/services';
import { listPeople, type Db } from '../src/lib/store';
import { importSuppression } from '../src/lib/suppression';
import { DEFAULT_RULES } from '../src/lib/targeting';

let pg: PGlite;
let db: Db;
beforeAll(() => {
  pg = new PGlite();
});
beforeEach(async () => {
  await pg.exec(
    'DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS enrichment_log; DROP TABLE IF EXISTS searched_queries; DROP TABLE IF EXISTS suppression; DROP TABLE IF EXISTS settings',
  );
  db = { query: async (text, params = []) => (await pg.query(text, params as unknown[])).rows as never };
});

type Found = { id: string; first_name: string; title: string; organization: { name: string }; has_email: boolean };
type Full = {
  id: string;
  name: string;
  title: string;
  email: string;
  email_status: string;
  linkedin_url: string;
  country: string;
  city: string;
  organization: { name: string; website_url: string; primary_domain: string; industry: string; estimated_num_employees: number };
};

const found = (id: string, title: string, company = `${id}co`): Found => ({ id, first_name: id.toUpperCase(), title, organization: { name: company }, has_email: true });
const full = (id: string, o: Partial<Omit<Full, 'organization'>> & { industry?: string; employees?: number; company?: string } = {}): Full => ({
  id,
  name: `${id.toUpperCase()} Person`,
  title: o.title ?? 'CEO',
  email: o.email ?? `${id}@${id}co.com`,
  email_status: o.email_status ?? 'verified',
  linkedin_url: o.linkedin_url ?? `http://www.linkedin.com/in/${id}`,
  country: o.country ?? 'Nigeria',
  city: o.city ?? 'Lagos',
  organization: { name: o.company ?? `${id}co`, website_url: `http://www.${id}co.com`, primary_domain: `${id}co.com`, industry: o.industry ?? 'information technology & services', estimated_num_employees: o.employees ?? 20 },
});

/** A fake Apollo: `search(params, page)` gives a page of People Search, `people` the full records bulk_match returns by id. */
function fakeApollo(search: (q: URLSearchParams, page: number) => Found[] | 'fail', people: Record<string, Full> = {}, opts: { failMatch?: boolean } = {}) {
  const searches: URLSearchParams[] = [];
  const lookups: string[][] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.pathname.endsWith('/mixed_people/api_search')) {
      searches.push(u.searchParams);
      const out = search(u.searchParams, Number(u.searchParams.get('page')));
      return out === 'fail' ? json({ error: 'Rate limited' }, 429) : json({ total_entries: out.length, people: out });
    }
    if (u.pathname.endsWith('/people/bulk_match')) {
      if (opts.failMatch) return json({ error: 'Insufficient credits' }, 422);
      const ids = (JSON.parse(String(init.body)) as { details: { id: string }[] }).details.map((d) => d.id);
      lookups.push(ids);
      return json({ matches: ids.map((id) => people[id] ?? null), credits_consumed: ids.filter((id) => people[id]).length });
    }
    return json({ error: `unexpected ${u.pathname}` }, 404);
  }) as unknown as typeof fetch;
  const svc: Services = { fetch: f, keys: { serper: '', jina: '', deepseek: '', apollo: 'master-key' } };
  return { svc, searches, lookups };
}

describe('planQueries (earlier LinkedIn search)', () => {
  it('interleaves countries and types so a cap still covers all of them', () => {
    const q = planQueries({ geos: ['ae', 'us'], segments: ['leaders', 'hedge'] }, 4);
    expect(new Set(q.map((x) => x.geo))).toEqual(new Set(['ae', 'us']));
    expect(new Set(q.map((x) => x.segment))).toEqual(new Set(['leaders', 'hedge']));
  });

  it('reaches both countries even in a short run of every type', () => {
    const q = planQueries({ geos: ['ae', 'us'], segments: SEGMENTS.map((s) => s.id) }, 10);
    expect(q.filter((x) => x.geo === 'ae')).toHaveLength(5);
    expect(q.filter((x) => x.geo === 'us')).toHaveLength(5);
  });
});

describe('searchesFor', () => {
  it('searches small-firm titles at 1–50 employees, large-firm titles at 51+, and each sector its own titles', () => {
    const s = searchesFor('af', DEFAULT_RULES);
    expect(s.find((x) => x.label === 'All industries: small firms')).toMatchObject({ titles: ['Owner', 'CEO', 'Founder', 'Co-Founder'], ranges: ['1,50'] });
    expect(s.find((x) => x.label === 'All industries: large firms')).toMatchObject({ titles: DEFAULT_RULES.general.large, ranges: ['51,1000000'] });
    // Chief Medical Officer exists only in healthcare, so no keyword is needed; General Manager is everywhere, so it is narrowed.
    expect(s.filter((x) => x.sector === 'healthcare').map((x) => [x.titles, x.keywords])).toEqual([[['Chief Medical Officer'], undefined]]);
    expect(s.filter((x) => x.sector === 'hospitality').map((x) => x.keywords)).toEqual(['hospitality', 'hotel', 'restaurant']);
  });
});

describe('createRun', () => {
  it('takes turns by market, the Middle East, Europe and the US twice as often as Africa, and sizes the run to the target', async () => {
    const run = await createRun(db, { target: 120 });
    expect(run.queries).toHaveLength(24); // searches are free; lookups are what the target caps
    expect((await createRun(db, { target: 10 })).queries).toHaveLength(10);
    expect(run.queries.slice(0, 7).map((q) => q.market)).toEqual(['me', 'eu', 'us', 'me', 'af', 'eu', 'us']);
    expect(run.queries.every((q) => q.page === 1 || run.queries.some((o) => o.key === q.key && o.market === q.market && o.page === q.page - 1))).toBe(true);
    expect(run.brief).toEqual({ markets: ['me', 'eu', 'us', 'af'], target: 120 });
  });

  it('continues each search from the page earlier runs stopped at, and skips searches read to the end', async () => {
    const [first] = searchesFor('af', DEFAULT_RULES);
    const [second] = searchesFor('af', DEFAULT_RULES).slice(1);
    await createRun(db, { markets: ['af'], target: 10 }); // creates the tables
    await db.query("INSERT INTO searched_queries (geo, query, pages_done, exhausted) VALUES ('af', $1, 4, FALSE), ('af', $2, 1, TRUE)", [first.key, second.key]);
    const run = await createRun(db, { markets: ['af'], target: 30 });
    expect(run.queries.find((q) => q.key === first.key)?.page).toBe(5);
    expect(run.queries.some((q) => q.key === second.key)).toBe(false);
  });

  it('refuses a run with no known market', async () => {
    await expect(createRun(db, { markets: ['mars'] })).rejects.toThrow('Choose at least one market.');
  });
});

describe('runStep', () => {
  it('searches Apollo, looks up only new people with a target title, and saves every field the brief asks for', async () => {
    const page: Found[] = [found('a', 'Founder & CEO'), found('b', 'Owner'), found('c', 'Marketing Manager'), { ...found('d', 'CEO'), has_email: false }];
    const { svc, searches, lookups } = fakeApollo(() => page, { a: full('a'), b: full('b', { title: 'Owner', email_status: 'guessed' }) });
    const run = await createRun(db, { markets: ['af'], target: 50 });
    const { run: after, summary } = await runStep(svc, db, run.id, { dailyLimit: 600 });

    const q = searches[0];
    expect(q.getAll('person_titles[]')).toEqual(['Owner', 'CEO', 'Founder', 'Co-Founder']);
    expect(q.getAll('organization_num_employees_ranges[]')).toEqual(['1,50']);
    expect(q.getAll('person_locations[]')).toContain('Nigeria');
    expect(q.getAll('contact_email_status[]')).toEqual(['verified']);
    expect(q.get('per_page')).toBe('50');
    expect(lookups).toEqual([['a', 'b']]); // the marketing manager and the person with no email are never paid for
    expect(summary).toMatchObject({ searched: 4, wanted: 2, lookedUp: 2, ready: 1, credits: 2 });
    expect(after).toMatchObject({ next_index: 1, searches: 1, results: 4, found: 2, inserted: 2, apollo_requested: 2, apollo_with_email: 1, apollo_credits: 2 });

    const [a] = await listPeople(db, { q: 'A Person' });
    expect(a).toMatchObject({
      name: 'A Person',
      title: 'CEO', // Apollo's record is newer than the search snippet
      company: 'aco',
      company_website: 'http://www.aco.com',
      linkedin_url: 'https://www.linkedin.com/in/a',
      email: 'a@aco.com',
      email_status: 'verified',
      company_employees: 20,
      industry: 'information technology & services',
      country: 'Nigeria',
      geo: 'af',
      firm_size: 'small',
      target_title: 'CEO',
      icp_fit: true,
      segment: 'Technology',
    });
    expect((await listPeople(db, { ready: true })).map((p) => p.name)).toEqual(['A Person']); // B's email is not verified
  });

  it('picks the title from the real industry and size, so a General Manager outside hospitality is saved but not emailed', async () => {
    const { svc } = fakeApollo(() => [found('g', 'General Manager'), found('h', 'General Manager'), found('m', 'Chief Medical Officer')], {
      g: full('g', { title: 'General Manager', industry: 'hospitality', employees: 300 }),
      h: full('h', { title: 'General Manager', industry: 'computer software', employees: 300 }),
      m: full('m', { title: 'Chief Medical Officer', industry: 'hospital & health care', employees: 900 }),
    });
    const run = await createRun(db, { markets: ['af'], target: 50 });
    // Run the hospitality search: its titles include General Manager.
    const index = run.queries.findIndex((q) => q.sector === 'hospitality');
    await db.query('UPDATE runs SET next_index = $2 WHERE id = $1', [run.id, index]);
    await runStep(svc, db, run.id, { dailyLimit: 600 });
    const people = await listPeople(db);
    const by = (name: string) => people.find((p) => p.name === name);
    expect(by('G Person')).toMatchObject({ icp_fit: true, sector: 'hospitality', target_title: 'General Manager', segment: 'Hospitality' });
    expect(by('H Person')).toMatchObject({ icp_fit: false, sector: 'general' });
    expect(by('H Person')?.icp_note).toContain('not a target title at a large computer software company');
    expect(by('M Person')).toBeUndefined(); // the CMO was not on the hospitality search's titles, so not looked up
    expect((await listPeople(db, { ready: true })).map((p) => p.name)).toEqual(['G Person']);
  });

  it('never pays for anyone already saved or at a client company, and marks suppressed people it finds', async () => {
    await importSuppression(db, [{ company: 'Clientco Ltd' }], 'client');
    await importSuppression(db, [{ email: 'b@bco.com' }], 'contacted');
    const page = [found('a', 'CEO'), found('b', 'CEO'), found('x', 'CEO', 'ClientCo')];
    const { svc, lookups } = fakeApollo(() => page, { a: full('a'), b: full('b') });
    const run = await createRun(db, { markets: ['af'], target: 50 });
    await runStep(svc, db, run.id, { dailyLimit: 600 });
    expect(lookups).toEqual([['a', 'b']]);
    const [b] = await listPeople(db, { q: 'B Person' });
    expect(b.suppressed_reason).toBe('email already contacted');
    expect((await listPeople(db, { ready: true })).map((p) => p.name)).toEqual(['A Person']);

    await runStep(svc, db, run.id, { dailyLimit: 600 });
    expect(lookups).toHaveLength(1); // the next page returns the same people: all saved already
  });

  it('gives every new lead one brand, splitting overlaps evenly, and never moves a lead to another brand', async () => {
    const page = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 's1', 's2', 'j1', 'j2', 'n1', 'x1'].map((id) => found(id, 'CEO'));
    const country: Record<string, string> = { u: 'United Arab Emirates', s: 'United States', j: 'Jordan', n: 'Nigeria', x: 'Japan' };
    const people = Object.fromEntries(page.map((p) => [p.id, full(p.id, { country: country[p.id[0]] })]));
    const { svc } = fakeApollo(() => page, people);
    const run = await createRun(db, { markets: ['me'], target: 50 });
    await runStep(svc, db, run.id, { dailyLimit: 600 });
    const rows = await db.query<{ apollo_person_id: string; brand: string; icp_fit: boolean }>('SELECT apollo_person_id, brand, icp_fit FROM people ORDER BY id');
    const brandsOf = (prefix: string) => rows.filter((r) => r.apollo_person_id.startsWith(prefix)).map((r) => r.brand).sort();
    expect(brandsOf('u')).toEqual(['ciominds', 'ciominds', 'gulficons', 'gulficons', 'hog', 'hog']); // UAE: all three, two each
    expect(brandsOf('s')).toEqual(['ciominds', 'hog']); // US: Humans of Globe or CIO Minds
    expect(brandsOf('j')).toEqual(['gulficons', 'hog']); // Jordan: Humans of Globe or Gulf Icons
    expect(brandsOf('n')).toEqual(['hog']); // Africa: Humans of Globe only
    expect(rows.find((r) => r.apollo_person_id === 'x1')).toMatchObject({ brand: 'none', icp_fit: false }); // outside every brand

    // Seen again by a later search, a lead keeps its brand.
    const before = new Map(rows.map((r) => [r.apollo_person_id, r.brand]));
    const { saveApolloLead } = await import('../src/lib/run');
    const { DEFAULT_SETTINGS } = await import('../src/lib/settings');
    const { parseMatch } = await import('../src/lib/apollo');
    for (const id of ['u1', 'u2', 'u3']) await saveApolloLead(db, parseMatch(people[id])!, 'me', DEFAULT_SETTINGS, 'again');
    const after = await db.query<{ apollo_person_id: string; brand: string }>('SELECT apollo_person_id, brand FROM people');
    expect(after.every((r) => before.get(r.apollo_person_id) === r.brand)).toBe(true);
    expect(after).toHaveLength(rows.length); // nobody saved twice
  });

  it('looks up no more people than the run still needs', async () => {
    const page = Array.from({ length: 30 }, (_, i) => found(`p${i}`, 'CEO'));
    const people = Object.fromEntries(page.map((p) => [p.id, full(p.id)]));
    const { svc, lookups } = fakeApollo(() => page, people);
    const run = await createRun(db, { markets: ['af'], target: 10 });
    const { run: after } = await runStep(svc, db, run.id, { dailyLimit: 600 });
    expect(lookups.flat()).toHaveLength(10);
    expect(after.apollo_with_email).toBe(10);
  });

  it('stops before paying once the daily lookup limit is reached', async () => {
    const { svc, lookups } = fakeApollo(() => [found('a', 'CEO'), found('b', 'CEO'), found('c', 'CEO')], { a: full('a'), b: full('b'), c: full('c') });
    const run = await createRun(db, { markets: ['af'], target: 50 });
    expect((await runStep(svc, db, run.id, { dailyLimit: 2 })).summary.lookedUp).toBe(2);
    expect(lookups).toEqual([['a', 'b']]);
    const second = await runStep(svc, db, run.id, { dailyLimit: 2 });
    expect(second.summary.stopped).toContain('Daily limit of 2 Apollo lookups reached');
    expect(lookups).toHaveLength(1);
  });

  it('does not advance when the search fails, so the same page is tried again', async () => {
    const { svc } = fakeApollo(() => 'fail');
    const run = await createRun(db, { markets: ['af'], target: 50 });
    await expect(runStep(svc, db, run.id)).rejects.toThrow('429');
    expect(await getRun(db, run.id)).toMatchObject({ next_index: 0, error: expect.stringContaining('Search 1') });
  });

  it('stays on the page when the lookups fail, so nobody on it is missed', async () => {
    const { svc } = fakeApollo(() => [found('a', 'CEO')], {}, { failMatch: true });
    const run = await createRun(db, { markets: ['af'], target: 50 });
    const { run: after, summary } = await runStep(svc, db, run.id, { dailyLimit: 600 });
    expect(summary.stopped).toContain('Insufficient credits');
    expect(after.next_index).toBe(0);
  });

  it('marks a search as read to the end when a page comes back short', async () => {
    const { svc } = fakeApollo(() => [found('a', 'CEO')], { a: full('a') });
    const run = await createRun(db, { markets: ['af'], target: 50 });
    await runStep(svc, db, run.id, { dailyLimit: 600 });
    const [row] = await db.query<{ exhausted: boolean }>('SELECT exhausted FROM searched_queries WHERE query = $1', [run.queries[0].key]);
    expect(row.exhausted).toBe(true);
  });

  it('will not continue a run from the earlier LinkedIn search, and lists runs newest first', async () => {
    await createRun(db, { markets: ['af'], target: 10 });
    const [old] = await db.query<{ id: number }>(
      `INSERT INTO runs (geo, brief, queries) VALUES ('ae', '{"geos":["ae"],"segments":["leaders"]}', '[{"query":"site:linkedin.com/in CEO","geo":"ae","segment":"leaders","startPage":1}]') RETURNING id`,
    );
    const { svc } = fakeApollo(() => []);
    await expect(runStep(svc, db, old.id)).rejects.toThrow('earlier LinkedIn search');
    const runs = await listRuns(db);
    expect(runs[0].id).toBe(old.id);
    expect(runs[0].brief.markets).toEqual(['ae']);
    expect((await finishRun(db, old.id, 'stopped')).status).toBe('stopped');
  });
});

describe('toCsv', () => {
  it('quotes where needed, keeps Arabic, and defuses formulas', () => {
    const csv = toCsv(['name', 'note'], [
      ['دبي', 'a, b'],
      ['=HYPERLINK("x")', 'say "hi"'],
    ]);
    expect(csv).toBe('﻿name,note\r\nدبي,"a, b"\r\n"\'=HYPERLINK(""x"")","say ""hi"""\r\n');
  });
});
