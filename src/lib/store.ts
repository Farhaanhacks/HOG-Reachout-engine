import type { Geo } from './geo';
import type { Person } from './linkedin';
import { companyKey, linkedinKey } from './keys';
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
    ADD COLUMN IF NOT EXISTS rank INTEGER,
    ADD COLUMN IF NOT EXISTS company_employees INTEGER,
    ADD COLUMN IF NOT EXISTS company_size TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS instantly_status TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS instantly_lead_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS instantly_campaign_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS instantly_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS opener TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS opener_fact TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS opener_status TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS personalized_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS unsubscribe_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS sequence_status TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS apollo_contact_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS apollo_sequence_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS sequence_note TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS sequenced_at TIMESTAMPTZ`);
  // (The instantly_* columns above are from the earlier Instantly setup and are no longer used.)
  // Leads from Apollo People Search: the full record the brief asks for, the title rule that picked them, and which inbox
  // sent to them. Leads from Apollo may have no LinkedIn profile, so the column allows blanks.
  await db.query(`ALTER TABLE people
    ADD COLUMN IF NOT EXISTS apollo_person_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS company_website TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS company_domain TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS industry TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS sector TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS firm_size TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS segment TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS target_title TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS icp_fit BOOLEAN,
    ADD COLUMN IF NOT EXISTS icp_note TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS suppressed_reason TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS company_key TEXT,
    ADD COLUMN IF NOT EXISTS linkedin_key TEXT,
    ADD COLUMN IF NOT EXISTS sent_from TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS sent_from_email TEXT NOT NULL DEFAULT ''`);
  await db.query('ALTER TABLE people ALTER COLUMN linkedin_url DROP NOT NULL');
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS people_apollo_person ON people (apollo_person_id) WHERE apollo_person_id <> ''");
  await db.query('CREATE INDEX IF NOT EXISTS people_contact ON people (apollo_contact_id)');
  // People saved before suppression existed get their match keys (a small, one-off pass).
  const unkeyed = await db.query<{ id: number | string; company: string; linkedin_url: string | null }>('SELECT id, company, linkedin_url FROM people WHERE company_key IS NULL LIMIT 5000');
  for (const r of unkeyed) await db.query('UPDATE people SET company_key = $2, linkedin_key = $3 WHERE id = $1', [r.id, companyKey(r.company), linkedinKey(r.linkedin_url)]);
  await db.query(`CREATE TABLE IF NOT EXISTS suppression (
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, value)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // The sending inboxes (from Apollo), with each one's limit, warm-up ramp and pause state.
  await db.query(`CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    max_per_day INTEGER NOT NULL DEFAULT 50,
    ramp BOOLEAN NOT NULL DEFAULT TRUE,
    ramp_start DATE NOT NULL DEFAULT current_date,
    paused_reason TEXT NOT NULL DEFAULT '',
    paused_at TIMESTAMPTZ,
    apollo_active BOOLEAN NOT NULL DEFAULT TRUE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Every email Apollo has sent (or tried to) for our sequences, with what happened to it.
  await db.query(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL DEFAULT '',
    sequence_id TEXT NOT NULL DEFAULT '',
    email_account_id TEXT NOT NULL DEFAULT '',
    from_email TEXT NOT NULL DEFAULT '',
    to_email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    step INTEGER,
    completed_at TIMESTAMPTZ,
    happened_at TIMESTAMPTZ,
    bounced BOOLEAN NOT NULL DEFAULT FALSE,
    spam_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    replied BOOLEAN NOT NULL DEFAULT FALSE,
    reply_class TEXT NOT NULL DEFAULT '',
    opened BOOLEAN NOT NULL DEFAULT FALSE,
    not_sent_reason TEXT NOT NULL DEFAULT '',
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS unsubscribed BOOLEAN NOT NULL DEFAULT FALSE');
  await db.query('CREATE INDEX IF NOT EXISTS messages_contact ON messages (contact_id)');
  await db.query('CREATE INDEX IF NOT EXISTS messages_account ON messages (email_account_id, happened_at)');
  await db.query(`CREATE TABLE IF NOT EXISTS outreach_log (
    id BIGSERIAL PRIMARY KEY,
    ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    campaign_id TEXT NOT NULL,
    requested INTEGER NOT NULL,
    added INTEGER NOT NULL,
    skipped INTEGER NOT NULL
  )`);
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
export async function savePeople(db: Db, people: Person[], geo: Geo | string, query: string, opts: { fundContext?: boolean } = {}): Promise<SaveResult> {
  await ensureSchema(db);
  let inserted = 0;
  let updated = 0;
  for (const p of people) {
    // Found by a fund search (hedge fund, VC, family office): a CIO or principal there is the main person.
    const tag = tagTitle(p.title, opts.fundContext ? `${p.company} fund` : p.company);
    const rows = await db.query<{ inserted: boolean }>(
      `INSERT INTO people (linkedin_url, name, title, company, location, geo, geo_match, labels, is_target, inferred, snippet, source_query, rank, company_key, linkedin_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
         company = COALESCE(NULLIF(people.company, ''), EXCLUDED.company),
         company_key = CASE WHEN people.company = '' THEN EXCLUDED.company_key ELSE people.company_key END
       RETURNING (xmax = 0) AS inserted`,
      [p.linkedin, p.name, p.title, p.company, p.location, geo, p.geoMatch, tag.labels.join(', '), tag.isTarget, p.inferred, p.snippet.slice(0, 1000), query, tag.rank, companyKey(p.company), linkedinKey(p.linkedin)],
    );
    if (rows[0]?.inserted) inserted++;
    else updated++;
  }
  return { inserted, updated };
}

export type SavedPerson = {
  id: number | string;
  /** Null for leads from Apollo that have no LinkedIn profile on record. */
  linkedin_url: string | null;
  name: string;
  title: string;
  company: string;
  location: string;
  /** The market they were found in: af, eu, us, ae (or ae, us, uk, ca for leads found by the earlier LinkedIn search). */
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
  /** Apollo's rating of the email. Only "verified" emails are sent to. */
  email_status: string;
  apollo_status: string;
  apollo_confidence: string;
  apollo_tier: number;
  /** 1 = the main person of the company, 2 = other C-suite or partner, 3 = other. */
  rank: number | null;
  /** Employees at their company, from Apollo, when known. */
  company_employees: number | null;
  /** fit, big_enough, too_small, too_large, unknown, or '' before Apollo (see size.ts). Earlier leads only. */
  company_size: string;
  company_website?: string;
  company_domain?: string;
  industry?: string;
  country?: string;
  /** healthcare, hospitality or general: which title rules apply (see targeting.ts). */
  sector?: string;
  /** small (up to 50 employees), large or unknown. */
  firm_size?: string;
  /** The edition segment they are pitched for ("Healthcare", "Technology"…). */
  segment?: string;
  /** The rule title they hold ("Managing Director"). */
  target_title?: string;
  /** False when their title is not one the rules want at their kind of company; null for earlier leads. */
  icp_fit?: boolean | null;
  icp_note?: string;
  /** Why the suppression list blocked them when they were saved ('' = not blocked). Sending re-checks live. */
  suppressed_reason?: string;
  /** '' = not sent; 'added' = in an Apollo sequence; 'skipped' = Apollo declined (e.g. already in another sequence). */
  sequence_status?: string;
  /** Apollo's reason when it declined. */
  sequence_note?: string;
  sequenced_at?: string | null;
  /** The Apollo inbox that sends to them. */
  sent_from?: string;
  sent_from_email?: string;
  /** The personal first line of their email, written from research (see personalize.ts). */
  opener?: string;
  opener_fact?: string;
  /** '' = not personalized yet; 'done' = has an opener; 'none' = nothing specific found, held back from sending. */
  opener_status?: string;
  /** When they used the unsubscribe link; they are never emailed again. */
  unsubscribed_at?: string | null;
};

/** The columns every list of people reads. */
export const PERSON_COLUMNS = `id, linkedin_url, name, title, company, location, geo, geo_match, labels, is_target, inferred, status, seen_count, first_seen, last_seen,
  email, email_status, apollo_status, apollo_confidence, apollo_tier, rank, company_employees, company_size, company_website, company_domain, industry,
  country, sector, firm_size, segment, target_title, icp_fit, icp_note, suppressed_reason, sequence_status, sequence_note, sequenced_at, sent_from,
  sent_from_email, opener, opener_fact, opener_status, unsubscribed_at`;

/** Not on the suppression list (clients and people contacted before), checked live (see suppression.ts). */
export const NOT_SUPPRESSED_SQL = `NOT EXISTS (SELECT 1 FROM suppression s WHERE
  (s.kind = 'email' AND s.value = lower(people.email))
  OR (s.kind = 'domain' AND (s.value = people.company_domain OR s.value = split_part(lower(people.email), '@', 2)))
  OR (s.kind = 'linkedin' AND s.value = people.linkedin_key)
  OR (s.kind = 'company' AND s.value = people.company_key))`;

/**
 * Who can be emailed: a verified email (bounces are what burn the sending domains, so nothing unverified is sent), a title
 * the rules want at their kind of company (earlier leads, checked before the rules existed, count as fitting), not
 * unsubscribed, and not on the suppression list.
 */
export const READY_SQL = `email <> '' AND email_status = 'verified' AND apollo_status IN ('matched', 'low_confidence') AND COALESCE(icp_fit, TRUE)
  AND unsubscribed_at IS NULL AND ${NOT_SUPPRESSED_SQL}`;

export type ListOptions = {
  /** A market (af, eu, us, ae) or an earlier country code. */
  geo?: string;
  targetOnly?: boolean;
  /** Only people who can be emailed (READY_SQL). */
  ready?: boolean;
  /** Only the main person of each company (rank 1). */
  topOnly?: boolean;
  /** 'newest' (default): most recently found first. 'emails': most recently given an email first. */
  orderBy?: 'newest' | 'emails';
  /** Text to find in name, title, company or industry. */
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
  if (opts.ready) where.push(READY_SQL);
  if (opts.topOnly) where.push('rank = 1');
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim()}%`);
    const n = params.length;
    where.push(`(name ILIKE $${n} OR title ILIKE $${n} OR company ILIKE $${n} OR industry ILIKE $${n})`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  return db.query<SavedPerson>(
    `SELECT ${PERSON_COLUMNS}
     FROM people ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${opts.orderBy === 'emails' ? 'apollo_checked_at DESC NULLS LAST,' : ''} first_seen DESC, id DESC LIMIT $${params.length}`,
    params,
  );
}

/** Per market: everyone saved, the target people, the main person of each company (rank 1), and who can be emailed. */
export async function countPeople(db: Db): Promise<{ geo: string; total: number; targets: number; main: number; ready: number }[]> {
  await ensureSchema(db);
  return db.query(
    `SELECT geo, count(*)::int AS total, count(*) FILTER (WHERE is_target)::int AS targets, count(*) FILTER (WHERE rank = 1)::int AS main,
            count(*) FILTER (WHERE ${READY_SQL})::int AS ready
     FROM people GROUP BY geo ORDER BY geo`,
  );
}
