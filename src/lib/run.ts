import { runEnrichment, type EnrichSummary } from './enrich';
import { isGeo, type Geo } from './geo';
import { parsePeople, type Person } from './linkedin';
import { buildQueries, type Brief } from './queries';
import { googleSearch, type Services } from './services';
import { ensureSchema, savePeople, splitByCountry, type Db } from './store';

export const MAX_QUERIES = 30;
export const MAX_PAGES = 3;

type RunRow = {
  id: number | string;
  created_at: string;
  finished_at: string | null;
  geo: string;
  brief: string;
  queries: string;
  pages: number;
  next_index: number;
  searches: number;
  results: number;
  found: number;
  excluded: number;
  inserted: number;
  updated: number;
  apollo_requested: number;
  apollo_with_email: number;
  apollo_credits: number | string;
  status: 'running' | 'done' | 'stopped';
  error: string;
};

/**
 * One full run: a brief turned into queries, worked through one query per request (so no request runs long enough to
 * time out, and a closed tab can be continued), with a running tally of what was searched, found and spent.
 */
export type Run = Omit<RunRow, 'brief' | 'queries' | 'apollo_credits'> & { brief: Brief; queries: string[]; apollo_credits: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo));

function toRun(r: RunRow): Run {
  return { ...r, brief: JSON.parse(r.brief) as Brief, queries: JSON.parse(r.queries) as string[], apollo_credits: Number(r.apollo_credits) || 0 };
}

export async function createRun(db: Db, brief: Brief, opts: { pages?: number; maxQueries?: number } = {}): Promise<Run> {
  if (!isGeo(brief.geo)) throw new Error('Choose the UAE or the US.');
  const queries = buildQueries(brief).slice(0, clamp(opts.maxQueries ?? 15, 1, MAX_QUERIES));
  if (!queries.length) throw new Error('Add at least one title.');
  await ensureSchema(db);
  const [row] = await db.query<RunRow>('INSERT INTO runs (geo, brief, queries, pages) VALUES ($1, $2, $3, $4) RETURNING *', [
    brief.geo,
    JSON.stringify(brief),
    JSON.stringify(queries),
    clamp(opts.pages ?? 2, 1, MAX_PAGES),
  ]);
  return toRun(row);
}

export async function getRun(db: Db, id: number | string): Promise<Run | null> {
  await ensureSchema(db);
  const [row] = await db.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
  return row ? toRun(row) : null;
}

export async function listRuns(db: Db, limit = 20): Promise<Run[]> {
  await ensureSchema(db);
  return (await db.query<RunRow>('SELECT * FROM runs ORDER BY id DESC LIMIT $1', [clamp(limit, 1, 100)])).map(toRun);
}

/**
 * Works through the run's next query: its result pages (stopping early when a page comes back short), the people in
 * them, minus those based outside the country, saved by LinkedIn URL. On a search failure the run is not advanced, so
 * the same query is tried again next time; searches already made are still counted, since they were charged.
 */
export async function runStep(svc: Services, db: Db, id: number | string): Promise<Run> {
  const run = await getRun(db, id);
  if (!run) throw new Error('Run not found');
  if (run.status !== 'running' || run.next_index >= run.queries.length) return run;
  const geo = run.geo as Geo;
  const index = run.next_index;
  const query = run.queries[index];
  const byUrl = new Map<string, Person>();
  let searches = 0;
  let results = 0;
  try {
    for (let page = 1; page <= run.pages; page++) {
      const res = await googleSearch(svc, query, geo, page);
      searches++;
      results += res.length;
      for (const p of parsePeople(res, geo)) if (!byUrl.has(p.linkedin)) byUrl.set(p.linkedin, p);
      if (res.length < 10) break;
    }
  } catch (e) {
    await db.query('UPDATE runs SET searches = searches + $2, error = $3 WHERE id = $1', [id, searches, `Query ${index + 1}: ${(e as Error).message}`]);
    throw e;
  }
  const { kept, excluded } = splitByCountry([...byUrl.values()]);
  const saved = await savePeople(db, kept, geo, query);
  const [row] = await db.query<RunRow>(
    `UPDATE runs SET next_index = next_index + 1, searches = searches + $3, results = results + $4, found = found + $5,
       excluded = excluded + $6, inserted = inserted + $7, updated = updated + $8, error = ''
     WHERE id = $1 AND next_index = $2 RETURNING *`,
    [id, index, searches, results, byUrl.size, excluded.length, saved.inserted, saved.updated],
  );
  // No row means another tab advanced the run meanwhile; the people saved here are deduplicated anyway.
  return row ? toRun(row) : ((await getRun(db, id)) as Run);
}

/** Sends waiting target people (oldest first) to Apollo and adds the lookups and credits to this run's tally. */
export async function enrichRun(svc: Services, db: Db, id: number | string, opts: { limit: number; dailyLimit?: number }): Promise<{ run: Run; summary: EnrichSummary }> {
  if (!(await getRun(db, id))) throw new Error('Run not found');
  const summary = await runEnrichment(svc, db, opts);
  const [row] = await db.query<RunRow>(
    `UPDATE runs SET apollo_requested = apollo_requested + $2, apollo_with_email = apollo_with_email + $3,
       apollo_credits = apollo_credits + $4, error = $5
     WHERE id = $1 RETURNING *`,
    [id, summary.requested, summary.withEmail, summary.credits, summary.stopped ?? ''],
  );
  return { run: toRun(row), summary };
}

export async function finishRun(db: Db, id: number | string, status: 'done' | 'stopped'): Promise<Run> {
  const [row] = await db.query<RunRow>("UPDATE runs SET status = $2, finished_at = now() WHERE id = $1 AND status = 'running' RETURNING *", [id, status]);
  const run = row ? toRun(row) : await getRun(db, id);
  if (!run) throw new Error('Run not found');
  return run;
}
