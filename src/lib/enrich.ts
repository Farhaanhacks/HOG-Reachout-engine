import { bulkMatch, type ApolloInput, type ApolloMatch } from './apollo';
import type { Services } from './services';
import { ensureSchema, type Db, type SavedPerson } from './store';

export const DEFAULT_DAILY_LIMIT = 100;

/** The daily cap on Apollo lookups: APOLLO_DAILY_LIMIT, or 100. */
export function dailyLimitFromEnv(): number {
  return Math.max(1, Number(process.env.APOLLO_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT);
}

/** Who is worth a lookup: target people not based elsewhere, never looked up before. The main person of each company first, then oldest first. */
export async function pendingPeople(db: Db, limit: number): Promise<SavedPerson[]> {
  await ensureSchema(db);
  return db.query<SavedPerson>(
    `SELECT id, linkedin_url, name, title, company, location, geo, geo_match, labels, is_target, inferred, status, seen_count, first_seen, last_seen,
            email, email_status, apollo_status, apollo_confidence, apollo_tier, rank
     FROM people
     WHERE is_target = TRUE AND geo_match <> 'other' AND apollo_status = 'none'
     ORDER BY COALESCE(rank, 3) ASC, first_seen ASC, id ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 500))],
  );
}

export type EnrichStatus = {
  pending: number;
  checked: number;
  withEmail: number;
  /** People sent to Apollo today (UTC), and the daily cap. */
  usedToday: number;
  dailyLimit: number;
  creditsToday: number;
};

export async function enrichStatus(db: Db, dailyLimit = DEFAULT_DAILY_LIMIT): Promise<EnrichStatus> {
  await ensureSchema(db);
  const [p] = await db.query<{ pending: number; checked: number; with_email: number }>(
    `SELECT count(*) FILTER (WHERE is_target AND geo_match <> 'other' AND apollo_status = 'none')::int AS pending,
            count(*) FILTER (WHERE apollo_status <> 'none')::int AS checked,
            count(*) FILTER (WHERE apollo_status = 'matched')::int AS with_email
     FROM people`,
  );
  const [t] = await db.query<{ used: number; credits: number }>(
    `SELECT coalesce(sum(requested), 0)::int AS used, coalesce(sum(credits), 0)::float8 AS credits FROM enrichment_log WHERE ran_at >= date_trunc('day', now())`,
  );
  return { pending: p?.pending ?? 0, checked: p?.checked ?? 0, withEmail: p?.with_email ?? 0, usedToday: t?.used ?? 0, dailyLimit, creditsToday: t?.credits ?? 0 };
}

export type EnrichSummary = {
  requested: number;
  matched: number;
  withEmail: number;
  credits: number;
  /** Set when a daily cap or an Apollo error stopped the run early. */
  stopped?: string;
};

/**
 * matched: an email from a confident match. low_confidence: an email, but Apollo is not sure it is the right person, so it is
 * kept for a look and not treated as ready. no_email: found the person, no email. no_match: Apollo does not know them.
 */
export function statusOf(m: ApolloMatch | null): 'matched' | 'low_confidence' | 'no_email' | 'no_match' {
  if (!m) return 'no_match';
  if (!m.email) return 'no_email';
  return m.confidence === 'low' || m.confidence === 'none' ? 'low_confidence' : 'matched';
}

async function save(db: Db, p: SavedPerson, m: ApolloMatch | null, tier: number): Promise<void> {
  const status = statusOf(m);
  await db.query(
    `UPDATE people SET email = $2, email_status = $3, apollo_status = $4, apollo_confidence = $5, apollo_tier = $6, apollo_checked_at = now(),
       title = COALESCE(NULLIF(title, ''), $7), company = COALESCE(NULLIF(company, ''), $8)
     WHERE id = $1`,
    [p.id, m?.email ?? '', m?.email ? m.emailStatus : '', status, m?.confidence ?? '', tier, m?.title ?? '', m?.company ?? ''],
  );
}

/**
 * Looks people up in Apollo in tiers (the plan from our notes):
 *  tier 1: LinkedIn URL plus name. Apollo charges nothing when it finds nothing to charge for.
 *  tier 2: for those still without an email, name plus company.
 * Stops at the daily cap. Every person sent is marked, so nobody is looked up twice.
 */
export async function runEnrichment(svc: Services, db: Db, opts: { limit: number; dailyLimit?: number }): Promise<EnrichSummary> {
  const dailyLimit = opts.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  const status = await enrichStatus(db, dailyLimit);
  const room = dailyLimit - status.usedToday;
  if (room <= 0) return { requested: 0, matched: 0, withEmail: 0, credits: 0, stopped: `Daily limit of ${dailyLimit} lookups reached` };

  const people = await pendingPeople(db, Math.min(opts.limit, room));
  if (!people.length) return { requested: 0, matched: 0, withEmail: 0, credits: 0 };

  let credits = 0;
  let stopped: string | undefined;
  const results = new Map<string | number, { m: ApolloMatch | null; tier: number }>();
  // Which tier is running, so a failure part-way still keeps the answers Apollo already gave.
  let current: { list: SavedPerson[]; tier: number } = { list: people, tier: 1 };

  try {
    const t1 = await bulkMatch(svc, people.map((p): ApolloInput => ({ linkedin: p.linkedin_url, name: p.name })));
    credits += t1.credits;
    people.forEach((p, i) => results.set(p.id, { m: t1.matches[i], tier: 1 }));

    const retry = people.filter((p) => !results.get(p.id)?.m?.email && p.name && p.company);
    if (retry.length) {
      current = { list: retry, tier: 2 };
      const t2 = await bulkMatch(svc, retry.map((p): ApolloInput => ({ name: p.name, company: p.company })));
      credits += t2.credits;
      retry.forEach((p, i) => {
        const m = t2.matches[i];
        if (m?.email) results.set(p.id, { m, tier: 2 });
      });
    }
  } catch (e) {
    stopped = (e as Error).message;
    const partial = (e as Error & { partial?: { matches: (ApolloMatch | null)[]; credits: number } }).partial;
    credits += partial?.credits ?? 0;
    partial?.matches.forEach((m, i) => {
      const p = current.list[i];
      if (p && (current.tier === 1 || m?.email)) results.set(p.id, { m, tier: current.tier });
    });
  }

  // Save what finished. People Apollo never answered stay unmarked, so they can be retried.
  let matched = 0;
  let withEmail = 0;
  let sent = 0;
  for (const p of people) {
    const r = results.get(p.id);
    if (!r) continue;
    sent++;
    if (r.m) matched++;
    if (statusOf(r.m) === 'matched') withEmail++;
    await save(db, p, r.m, r.tier);
  }
  if (sent) await db.query('INSERT INTO enrichment_log (requested, matched, with_email, credits) VALUES ($1, $2, $3, $4)', [sent, matched, withEmail, credits]);
  return { requested: sent, matched, withEmail, credits, stopped };
}
