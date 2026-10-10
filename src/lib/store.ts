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
  // Apollo results (step 9). Added with ALTER so a database made before step 9 upgrades itself.
  await db.query(`ALTER TABLE people
    ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS apollo_status TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS apollo_confidence TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS apollo_tier INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS apollo_checked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rank INTEGER`);
  // People saved before ranks existed get one from their title (a small, one-off pass).
  const unranked = await db.query<{ id: number | string; title: string; company: string }>('SELECT id, title, company FROM people WHERE rank IS NULL LIMIT 5000');
  for (const r of unranked) {
    const tag = tagTitle(r.title, r.company);
    await db.query('UPDATE people SET rank = $2, is_target = $3 WHERE id = $1', [r.id, tag.rank, tag.isTarget]);
  }
  await db.query(`CREATE TABLE IF NOT EXISTS enrichment_log (
    id BIGSERIAL PRIMARY KEY,
    ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    requested INTEGER NOT NULL,
    matched INTEGER NOT NULL,
    with_email INTEGER NOT NULL,
    credits NUMERIC NOT NULL DEFAULT 0
  )`);
  // Full runs (step 7): one row per run, with what it searched, found and spent.
  await db.query(`CREATE TABLE IF NOT EXISTS runs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    geo TEXT NOT NULL,
    brief TEXT NOT NULL,
    queries TEXT NOT NULL,
    pages INTEGER NOT NULL DEFAULT 2,
    next_index INTEGER NOT NULL DEFAULT 0,
    searches INTEGER NOT NULL DEFAULT 0,
    results INTEGER NOT NULL DEFAULT 0,
    found INTEGER NOT NULL DEFAULT 0,
    excluded INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    apollo_requested INTEGER NOT NULL DEFAULT 0,
    apollo_with_email INTEGER NOT NULL DEFAULT 0,
    apollo_credits DOUBLE PRECISION NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    error TEXT NOT NULL DEFAULT ''
  )`);
  // Every search ever made and how deep it has gone, so each run picks new searches (or the next result pages)
  // instead of repeating the last run.
  await db.query(`CREATE TABLE IF NOT EXISTS searched_queries (
    geo TEXT NOT NULL,
    query TEXT NOT NULL,
    pages_done INTEGER NOT NULL DEFAULT 0,
    exhausted BOOLEAN NOT NULL DEFAULT FALSE,
    last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (geo, query)
  )`);
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
export async function savePeople(db: Db, people: Person[], geo: Geo, query: string, opts: { fundContext?: boolean } = {}): Promise<SaveResult> {
  await ensureSchema(db);
  let inserted = 0;
  let updated = 0;
  for (const p of people) {
    // Found by a fund search (hedge fund, VC, family office): a CIO or principal there is the main person.
    const tag = tagTitle(p.title, opts.fundContext ? `${p.company} fund` : p.company);
    const rows = await db.query<{ inserted: boolean }>(
      `INSERT INTO people (linkedin_url, name, title, company, location, geo, geo_match, labels, is_target, inferred, snippet, source_query, rank)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (linkedin_url) DO UPDATE SET
         last_seen = now(),
         seen_count = people.seen_count + 1,
         name = COALESCE(NULLIF(people.name, ''), EXCLUDED.name),
         location = COALESCE(NULLIF(people.location, ''), EXCLUDED.location),
         geo_match = CASE WHEN people.geo_match = 'unknown' THEN EXCLUDED.geo_match ELSE people.geo_match END,
         labels = CASE WHEN people.title = '' THEN EXCLUDED.labels ELSE people.labels END,
         is_target = CASE WHEN people.title = '' THEN EXCLUDED.is_target ELSE people.is_target OR EXCLUDED.is_target END,
         rank = CASE WHEN people.title = '' THEN EXCLUDED.rank ELSE LEAST(COALESCE(people.rank, 3), EXCLUDED.rank) END,
         inferred = CASE WHEN people.title = '' OR people.company = '' THEN EXCLUDED.inferred ELSE people.inferred END,
         title = COALESCE(NULLIF(people.title, ''), EXCLUDED.title),
         company = COALESCE(NULLIF(people.company, ''), EXCLUDED.company)
       RETURNING (xmax = 0) AS inserted`,
      [p.linkedin, p.name, p.title, p.company, p.location, geo, p.geoMatch, tag.labels.join(', '), tag.isTarget, p.inferred, p.snippet.slice(0, 1000), query, tag.rank],
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
  email: string;
  email_status: string;
  apollo_status: string;
  apollo_confidence: string;
  apollo_tier: number;
  /** 1 = the main person of the company, 2 = other C-suite or partner, 3 = other. */
  rank: number | null;
};

export type ListOptions = {
  geo?: Geo;
  targetOnly?: boolean;
  /** Only people with a confident Apollo email. */
  ready?: boolean;
  /** Only the main person of each company (rank 1). */
  topOnly?: boolean;
  /** Text to find in name, title or company. */
  q?: string;
  limit?: number;
};

export async function listPeople(db: Db, opts: ListOptions = {}): Promise<SavedPerson[]> {
  await ensureSchema(db);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.geo) {
    params.push(opts.geo);
    where.push(`geo = $${params.length}`);
  }
  if (opts.targetOnly) where.push('is_target = TRUE');
  if (opts.ready) where.push(`apollo_status = 'matched'`);
  if (opts.topOnly) where.push('rank = 1');
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim()}%`);
    const n = params.length;
    where.push(`(name ILIKE $${n} OR title ILIKE $${n} OR company ILIKE $${n})`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  return db.query<SavedPerson>(
    `SELECT id, linkedin_url, name, title, company, location, geo, geo_match, labels, is_target, inferred, status, seen_count, first_seen, last_seen,
            email, email_status, apollo_status, apollo_confidence, apollo_tier, rank
     FROM people ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY first_seen DESC, id DESC LIMIT $${params.length}`,
    params,
  );
}

/** Per country: everyone saved, the target people, and the main person of each company (rank 1). */
export async function countPeople(db: Db): Promise<{ geo: string; total: number; targets: number; main: number }[]> {
  await ensureSchema(db);
  return db.query(
    `SELECT geo, count(*)::int AS total, count(*) FILTER (WHERE is_target)::int AS targets, count(*) FILTER (WHERE rank = 1)::int AS main
     FROM people GROUP BY geo ORDER BY geo`,
  );
}
