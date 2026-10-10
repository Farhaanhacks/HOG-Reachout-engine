import type { Geo } from './geo';
import type { Person } from './linkedin';
import { tagTitle } from './seniority';

/** The one thing the store needs from a database: run a query, get rows. Production uses Postgres; tests use an embedded one. */
export type Db = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

const ready = new WeakSet<object>();

/** Creates the table on first use. Safe to call every time. */
export async function ensureSchema(db: Db): Promise<void> {
  if (ready.has(db)) return;
  await db.query(`CREATE TABLE IF NOT EXISTS people (
    id BIGSERIAL PRIMARY KEY,
    linkedin_url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    geo TEXT NOT NULL,
    geo_match TEXT NOT NULL DEFAULT 'unknown',
    labels TEXT NOT NULL DEFAULT '',
    is_target BOOLEAN NOT NULL DEFAULT FALSE,
    inferred BOOLEAN NOT NULL DEFAULT FALSE,
    snippet TEXT NOT NULL DEFAULT '',
    source_query TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    seen_count INTEGER NOT NULL DEFAULT 1,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS people_geo_target ON people (geo, is_target)');
  ready.add(db);
}

/**
 * People based outside the searched country are dropped before saving (a Bay Area CEO of "Dubai Technologies"
 * is not a UAE lead, and every Apollo lookup costs credits). People with no location line are kept.
 */
export function splitByCountry(people: Person[]): { kept: Person[]; excluded: Person[] } {
  return { kept: people.filter((p) => p.geoMatch !== 'other'), excluded: people.filter((p) => p.geoMatch === 'other') };
}

export type SaveResult = { inserted: number; updated: number };

/**
 * Saves people by LinkedIn URL. A profile already saved is not added again: its "seen" count goes up, and any blank
 * field (title, company, location) is filled in from the new sighting. Existing values are never overwritten.
 */
export async function savePeople(db: Db, people: Person[], geo: Geo, query: string): Promise<SaveResult> {
  await ensureSchema(db);
  let inserted = 0;
  let updated = 0;
  for (const p of people) {
    const tag = tagTitle(p.title, p.company);
    const rows = await db.query<{ inserted: boolean }>(
      `INSERT INTO people (linkedin_url, name, title, company, location, geo, geo_match, labels, is_target, inferred, snippet, source_query)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (linkedin_url) DO UPDATE SET
         last_seen = now(),
         seen_count = people.seen_count + 1,
         name = COALESCE(NULLIF(people.name, ''), EXCLUDED.name),
         location = COALESCE(NULLIF(people.location, ''), EXCLUDED.location),
         geo_match = CASE WHEN people.geo_match = 'unknown' THEN EXCLUDED.geo_match ELSE people.geo_match END,
         labels = CASE WHEN people.title = '' THEN EXCLUDED.labels ELSE people.labels END,
         is_target = CASE WHEN people.title = '' THEN EXCLUDED.is_target ELSE people.is_target END,
         inferred = CASE WHEN people.title = '' OR people.company = '' THEN EXCLUDED.inferred ELSE people.inferred END,
         title = COALESCE(NULLIF(people.title, ''), EXCLUDED.title),
         company = COALESCE(NULLIF(people.company, ''), EXCLUDED.company)
       RETURNING (xmax = 0) AS inserted`,
      [p.linkedin, p.name, p.title, p.company, p.location, geo, p.geoMatch, tag.labels.join(', '), tag.isTarget, p.inferred, p.snippet.slice(0, 1000), query],
    );
    if (rows[0]?.inserted) inserted++;
    else updated++;
  }
  return { inserted, updated };
}

export type SavedPerson = {
  id: number | string;
  linkedin_url: string;
  name: string;
  title: string;
  company: string;
  location: string;
  geo: string;
  geo_match: string;
  labels: string;
  is_target: boolean;
  inferred: boolean;
  status: string;
  seen_count: number;
  first_seen: string;
  last_seen: string;
};

export async function listPeople(db: Db, opts: { geo?: Geo; targetOnly?: boolean; limit?: number } = {}): Promise<SavedPerson[]> {
  await ensureSchema(db);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.geo) {
    params.push(opts.geo);
    where.push(`geo = $${params.length}`);
  }
  if (opts.targetOnly) where.push('is_target = TRUE');
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  return db.query<SavedPerson>(
    `SELECT id, linkedin_url, name, title, company, location, geo, geo_match, labels, is_target, inferred, status, seen_count, first_seen, last_seen
     FROM people ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY first_seen DESC, id DESC LIMIT $${params.length}`,
    params,
  );
}

export async function countPeople(db: Db): Promise<{ geo: string; total: number; targets: number }[]> {
  await ensureSchema(db);
  return db.query(`SELECT geo, count(*)::int AS total, count(*) FILTER (WHERE is_target)::int AS targets FROM people GROUP BY geo ORDER BY geo`);
}
