import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/csv';
import { planQueries } from '../src/lib/icp';
import { createRun, finishRun, getRun, listRuns, runStep } from '../src/lib/run';
import type { SerperResult, Services } from '../src/lib/services';
import { ensureSchema, listPeople, type Db } from '../src/lib/store';

let pg: PGlite;
let db: Db;
beforeAll(() => {
  pg = new PGlite();
});
beforeEach(async () => {
  await pg.exec('DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS enrichment_log');
  db = { query: async (text, params = []) => (await pg.query(text, params as unknown[])).rows as never };
});

/** A LinkedIn result as Google shows it, based in Dubai unless a location is given. */
const profile = (slug: string, location = 'Dubai, United Arab Emirates', role = 'Founder & CEO', company = `${slug}co`): SerperResult => ({
  title: `${slug.toUpperCase()} Person - ${role} at ${company}`,
  link: `https://ae.linkedin.com/in/${slug}`,
  subtitle: `${location} · ${role} · ${company}`,
  snippet: '',
});

/** A fake Serper: `pages(query, page)` gives the results, or 'fail' for an error. */
function fakeSerper(pages: (q: string, page: number) => SerperResult[] | 'fail') {
  const calls: { q: string; page: number; gl: string }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { q: string; page?: number; gl: string };
    const page = body.page ?? 1;
    calls.push({ q: body.q, page, gl: body.gl });
    const out = pages(body.q, page);
    if (out === 'fail') return new Response(JSON.stringify({ message: 'Not enough credits' }), { status: 400 });
    return new Response(JSON.stringify({ organic: out }), { status: 200 });
  }) as unknown as typeof fetch;
  const svc: Services = { fetch: f, keys: { serper: 'k', jina: '', deepseek: '' } };
  return { svc, calls };
}

describe('planQueries', () => {
  it('interleaves countries and types so a cap still covers all of them', () => {
    const q = planQueries({ geos: ['ae', 'us'], segments: ['leaders', 'hedge'] }, 4);
    expect(new Set(q.map((x) => x.geo))).toEqual(new Set(['ae', 'us']));
    expect(new Set(q.map((x) => x.segment))).toEqual(new Set(['leaders', 'hedge']));
  });

  it('ignores unknown types and never repeats a search', () => {
    const q = planQueries({ geos: ['ae'], segments: ['hedge', 'nope'] });
    expect(q.every((x) => x.segment === 'hedge')).toBe(true);
    expect(new Set(q.map((x) => x.query)).size).toBe(q.length);
  });
});

describe('createRun', () => {
  it('plans searches for both countries from the chosen types', async () => {
    const run = await createRun(db, { geos: ['ae', 'us'], segments: ['hedge'] }, { maxQueries: 3 });
    expect(run.queries).toHaveLength(3);
    expect(run.queries[0]).toEqual({ query: 'site:linkedin.com/in ("Chief Investment Officer" OR "CIO" OR "Founder") "Dubai" "hedge fund"', geo: 'ae', segment: 'hedge' });
    expect(run.queries[1]).toMatchObject({ geo: 'us', segment: 'hedge' });
    expect(run.geo).toBe('ae,us');
    expect(run.brief).toEqual({ geos: ['ae', 'us'], segments: ['hedge'], extraTitles: [] });
    expect(run).toMatchObject({ status: 'running', next_index: 0, pages: 2, searches: 0 });
  });

  it('refuses a run with no country or no type', async () => {
    await expect(createRun(db, { geos: [], segments: ['leaders'] })).rejects.toThrow('Choose at least one country.');
    await expect(createRun(db, { geos: ['ae'], segments: [] })).rejects.toThrow('Choose at least one type of lead.');
  });

  it('still reads runs saved in the earlier format', async () => {
    await ensureSchema(db);
    const [row] = await db.query<{ id: number }>(`INSERT INTO runs (geo, brief, queries) VALUES ('ae', '{"geo":"ae","titles":["CEO"]}', '["q1"]') RETURNING id`);
    const run = await getRun(db, row.id);
    expect(run?.queries).toEqual([{ query: 'q1', geo: 'ae', segment: '' }]);
    expect(run?.brief).toEqual({ geos: ['ae'], segments: [], extraTitles: ['CEO'] });
  });
});

describe('runStep', () => {
  it('reads every page of a search, drops people based elsewhere, and keeps the tally', async () => {
    const page1 = Array.from({ length: 10 }, (_, i) => profile(`p${i}`, i === 9 ? 'San Francisco Bay Area' : undefined));
    const page2 = [profile('p10'), profile('p0')]; // p0 again: counted once
    const { svc, calls } = fakeSerper((_q, page) => (page === 1 ? page1 : page2));
    const run = await createRun(db, { geos: ['ae'], segments: ['leaders'] }, { maxQueries: 2 });

    const after = await runStep(svc, db, run.id);
    expect(calls).toEqual([
      { q: run.queries[0].query, page: 1, gl: 'ae' },
      { q: run.queries[0].query, page: 2, gl: 'ae' },
    ]);
    expect(after).toMatchObject({ next_index: 1, searches: 2, results: 12, found: 11, excluded: 1, inserted: 10, updated: 0 });
    expect(await listPeople(db)).toHaveLength(10);
  });

  it('searches each query in its own country', async () => {
    const { svc, calls } = fakeSerper(() => []);
    const run = await createRun(db, { geos: ['ae', 'us'], segments: ['leaders'] }, { maxQueries: 2 });
    await runStep(svc, db, run.id);
    await runStep(svc, db, run.id);
    expect(calls.map((c) => c.gl)).toEqual(['ae', 'us']);
  });

  it('treats a CIO found by a fund search as the main person', async () => {
    const { svc } = fakeSerper(() => [profile('cio', undefined, 'CIO', 'Zeta')]);
    const run = await createRun(db, { geos: ['ae'], segments: ['hedge'] }, { maxQueries: 1 });
    await runStep(svc, db, run.id);
    expect((await listPeople(db))[0]).toMatchObject({ rank: 1, is_target: true });
  });

  it('stops paging when a page comes back short, and counts people already saved', async () => {
    const { svc, calls } = fakeSerper(() => [profile('a'), profile('b')]);
    const run = await createRun(db, { geos: ['ae'], segments: ['leaders'] }, { maxQueries: 2 });
    await runStep(svc, db, run.id);
    const after = await runStep(svc, db, run.id);
    expect(calls).toHaveLength(2); // one page per search
    expect(after).toMatchObject({ next_index: 2, searches: 2, inserted: 2, updated: 2 });
  });

  it('does nothing once every search is done, and finishes', async () => {
    const { svc, calls } = fakeSerper(() => []);
    const run = await createRun(db, { geos: ['ae'], segments: ['leaders'] }, { maxQueries: 1 });
    await runStep(svc, db, run.id);
    await runStep(svc, db, run.id);
    expect(calls).toHaveLength(1);
    const done = await finishRun(db, run.id, 'done');
    expect(done.status).toBe('done');
    expect(done.finished_at).not.toBeNull();
    expect((await finishRun(db, run.id, 'stopped')).status).toBe('done'); // a finished run stays finished
  });

  it('does not advance when the search fails, so the search is retried', async () => {
    const { svc } = fakeSerper(() => 'fail');
    const run = await createRun(db, { geos: ['ae'], segments: ['leaders'] }, { maxQueries: 2 });
    await expect(runStep(svc, db, run.id)).rejects.toThrow('Not enough credits');
    const after = await getRun(db, run.id);
    expect(after).toMatchObject({ next_index: 0, searches: 0, status: 'running' });
    expect(after?.error).toMatch(/Search 1: 400 Not enough credits/);
  });

  it('lists runs newest first', async () => {
    const first = await createRun(db, { geos: ['ae'], segments: ['leaders'] }, { maxQueries: 1 });
    const second = await createRun(db, { geos: ['us'], segments: ['vc'] }, { maxQueries: 1 });
    expect((await listRuns(db)).map((r) => r.id)).toEqual([second.id, first.id]);
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
