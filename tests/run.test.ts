import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/csv';
import { createRun, finishRun, getRun, listRuns, runStep } from '../src/lib/run';
import type { SerperResult, Services } from '../src/lib/services';
import { listPeople, type Db } from '../src/lib/store';

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
const profile = (slug: string, location = 'Dubai, United Arab Emirates'): SerperResult => ({
  title: `${slug.toUpperCase()} Person - Founder & CEO at ${slug}co`,
  link: `https://ae.linkedin.com/in/${slug}`,
  subtitle: `${location} · Founder & CEO · ${slug}co`,
  snippet: '',
});

/** A fake Serper: `pages(query, page)` gives the results, or 'fail' for an error. */
function fakeSerper(pages: (q: string, page: number) => SerperResult[] | 'fail') {
  const calls: { q: string; page: number }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { q: string; page?: number };
    const page = body.page ?? 1;
    calls.push({ q: body.q, page });
    const out = pages(body.q, page);
    if (out === 'fail') return new Response(JSON.stringify({ message: 'Not enough credits' }), { status: 400 });
    return new Response(JSON.stringify({ organic: out }), { status: 200 });
  }) as unknown as typeof fetch;
  const svc: Services = { fetch: f, keys: { serper: 'k', jina: '', deepseek: '' } };
  return { svc, calls };
}

const brief = { geo: 'ae' as const, titles: ['Founder', 'CEO', 'Managing Partner', 'CIO'], cities: ['Dubai', 'Abu Dhabi'] };

describe('createRun', () => {
  it('turns a brief into queries, capped', async () => {
    const run = await createRun(db, brief, { maxQueries: 3 });
    expect(run.queries).toHaveLength(3);
    expect(run.queries[0]).toBe('site:linkedin.com/in ("Founder" OR "CEO" OR "Managing Partner") "Dubai"');
    expect(run).toMatchObject({ status: 'running', next_index: 0, pages: 2, searches: 0 });
  });

  it('refuses a brief with no titles', async () => {
    await expect(createRun(db, { geo: 'ae', titles: [] })).rejects.toThrow('Add at least one title.');
  });
});

describe('runStep', () => {
  it('reads every page of a query, drops people based elsewhere, and keeps the tally', async () => {
    const page1 = Array.from({ length: 10 }, (_, i) => profile(`p${i}`, i === 9 ? 'San Francisco Bay Area' : undefined));
    const page2 = [profile('p10'), profile('p0')]; // p0 again: counted once
    const { svc, calls } = fakeSerper((_q, page) => (page === 1 ? page1 : page2));
    const run = await createRun(db, brief, { maxQueries: 2 });

    const after = await runStep(svc, db, run.id);
    expect(calls).toEqual([
      { q: run.queries[0], page: 1 },
      { q: run.queries[0], page: 2 },
    ]);
    expect(after).toMatchObject({ next_index: 1, searches: 2, results: 12, found: 11, excluded: 1, inserted: 10, updated: 0 });
    expect(await listPeople(db)).toHaveLength(10);
  });

  it('stops paging when a page comes back short, and counts people already saved', async () => {
    const { svc, calls } = fakeSerper(() => [profile('a'), profile('b')]);
    const run = await createRun(db, brief, { maxQueries: 2 });
    await runStep(svc, db, run.id);
    const after = await runStep(svc, db, run.id);
    expect(calls).toHaveLength(2); // one page per query
    expect(after).toMatchObject({ next_index: 2, searches: 2, inserted: 2, updated: 2 });
  });

  it('does nothing once every query is done, and finishes', async () => {
    const { svc, calls } = fakeSerper(() => []);
    const run = await createRun(db, brief, { maxQueries: 1 });
    await runStep(svc, db, run.id);
    await runStep(svc, db, run.id);
    expect(calls).toHaveLength(1);
    const done = await finishRun(db, run.id, 'done');
    expect(done.status).toBe('done');
    expect(done.finished_at).not.toBeNull();
    expect((await finishRun(db, run.id, 'stopped')).status).toBe('done'); // a finished run stays finished
  });

  it('does not advance when the search fails, so the query is retried', async () => {
    const { svc } = fakeSerper(() => 'fail');
    const run = await createRun(db, brief, { maxQueries: 2 });
    await expect(runStep(svc, db, run.id)).rejects.toThrow('Not enough credits');
    const after = await getRun(db, run.id);
    expect(after).toMatchObject({ next_index: 0, searches: 0, status: 'running' });
    expect(after?.error).toMatch(/Query 1: 400 Not enough credits/);
  });

  it('lists runs newest first', async () => {
    const first = await createRun(db, brief, { maxQueries: 1 });
    const second = await createRun(db, { ...brief, geo: 'us', cities: ['Austin'] }, { maxQueries: 1 });
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
