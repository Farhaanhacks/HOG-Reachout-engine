import { bulkMatch, type ApolloMatch } from './apollo';
import { MAX_PAGE, PER_PAGE, searchPeople, searchesFor, type SearchSpec } from './apollo-search';
import { DEFAULT_DAILY_LIMIT, enrichStatus, runEnrichment, statusOf, type EnrichSummary } from './enrich';
import { companyKey, emailDomain, linkedinKey, normDomain } from './keys';
import { BRAND_LIST, brandsForMarket, eligibleBrands, pickBrand, quotasFor, type Brand, type Quotas } from './brands';
import { MARKET_LIST, MARKET_TURNS, isMarket, marketOf, type Market } from './markets';
import { tagTitle } from './seniority';
import { getSettings, type Settings } from './settings';
import { sizeVerdict } from './size';
import { clientCompanies, suppressedReason } from './suppression';
import type { Services } from './services';
import { ensureSchema, type Db } from './store';
import { checkLead, editionFor, matchTitle } from './targeting';

/** The most searches one run plans. Each search reads one page of 50 people. */
export const MAX_STEPS = 200;
export const DEFAULT_TARGET = 20;

type RunRow = {
  id: number | string;
  created_at: string;
  finished_at: string | null;
  /** The markets searched, comma separated ("af,eu,us,ae"). */
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
  brand_ready?: string | null;
};

/** What a run is asked for: these markets, until this many new leads can be emailed, split between the brands. */
export type RunBrief = { markets: string[]; target: number; quotas?: Quotas };
/** One search of a run: a page of one Apollo search. */
export type RunQuery = SearchSpec & { page: number };

/**
 * One run: Apollo searches across the markets, worked through one page per request (so no request runs long enough to
 * time out, and a closed tab can be continued). Each page's people are checked against the title rules and the
 * suppression list before anyone is paid for, then looked up in Apollo for their full record. A tally is kept of what
 * was searched, found, saved and spent.
 *
 * results: people the searches returned. found: those with a wanted title. excluded: skipped before paying (already
 * saved, client company, or the wrong title). inserted / updated: leads saved. apollo_with_email: new leads ready to email.
 */
export type Run = Omit<RunRow, 'brief' | 'queries' | 'apollo_credits' | 'brand_ready'> & {
  brief: RunBrief;
  queries: RunQuery[];
  apollo_credits: number;
  /** New leads ready to email found so far, per brand. */
  brand_ready: Partial<Quotas>;
};

/** What each brand still needs in a run (never below 0). */
export function remainingNeed(run: Pick<Run, 'brief' | 'brand_ready'>): Quotas {
  const quotas = run.brief.quotas ?? quotasFor(run.brief.target);
  return Object.fromEntries(BRAND_LIST.map((b) => [b, Math.max(0, quotas[b] - (run.brand_ready[b] ?? 0))])) as Quotas;
}

/** Whether every brand has all the leads it needs. */
export function quotasMet(run: Pick<Run, 'brief' | 'brand_ready'>): boolean {
  return BRAND_LIST.every((b) => remainingNeed(run)[b] === 0);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo));

/** Reads a stored run, including runs from the earlier LinkedIn search (shown in the history, never continued). */
function toRun(r: RunRow): Run {
  const brief = JSON.parse(r.brief) as Partial<RunBrief> & { geos?: string[] };
  const queries = (JSON.parse(r.queries) as Partial<RunQuery & { query: string; geo: string; segment: string; startPage: number }>[]).map(
    (q): RunQuery => ({
      key: q.key ?? q.query ?? '',
      market: (q.market ?? q.geo ?? 'us') as Market,
      label: q.label ?? q.segment ?? 'Search',
      sector: q.sector ?? 'general',
      titles: q.titles ?? [],
      ranges: q.ranges ?? [],
      keywords: q.keywords,
      page: q.page ?? q.startPage ?? 1,
    }),
  );
  let brandReady: Partial<Quotas> = {};
  try {
    brandReady = JSON.parse(r.brand_ready || '{}') as Partial<Quotas>;
  } catch {}
  return {
    ...r,
    brief: { markets: brief.markets ?? brief.geos ?? r.geo.split(','), target: brief.target ?? 0, quotas: brief.quotas },
    queries,
    apollo_credits: Number(r.apollo_credits) || 0,
    brand_ready: brandReady,
  };
}

/**
 * Starts a run. Searches take turns by market (Africa and Europe twice as often as the US and the UAE) and, within a
 * market, by search; each search continues from the page earlier runs stopped at, so every run finds new people.
 */
export async function createRun(db: Db, brief: { markets?: string[]; target?: number } = {}, opts: { maxSteps?: number } = {}): Promise<Run> {
  const markets = [...new Set(brief.markets ?? MARKET_LIST)].filter(isMarket);
  if (!markets.length) throw new Error('Choose at least one market.');
  const target = clamp(brief.target ?? DEFAULT_TARGET, 1, 2000);
  await ensureSchema(db);
  const settings = await getSettings(db);

  const history = new Map<string, { pages: number; exhausted: boolean }>();
  for (const h of await db.query<{ geo: string; query: string; pages_done: number; exhausted: boolean }>('SELECT geo, query, pages_done, exhausted FROM searched_queries')) {
    history.set(`${h.geo}|${h.query}`, { pages: h.pages_done, exhausted: h.exhausted });
  }
  // Per market: its searches still to read, each with the next page to read.
  const open = new Map<Market, { spec: SearchSpec; next: number }[]>();
  for (const m of markets) {
    open.set(
      m,
      searchesFor(m, settings.rules)
        .map((spec) => ({ spec, h: history.get(`${m}|${spec.key}`) ?? { pages: 0, exhausted: false } }))
        .filter((x) => !x.h.exhausted && x.h.pages < MAX_PAGE)
        .map((x) => ({ spec: x.spec, next: x.h.pages + 1 })),
    );
  }
  const turns = MARKET_TURNS.filter((m) => markets.includes(m));
  const pointer = new Map<Market, number>();
  // Searches are free, so a run plans plenty of them; what it pays for is capped by the target (see runStep).
  // Searches whose brands are already full are skipped for free, so plenty are planned.
  const maxSteps = clamp(opts.maxSteps ?? Math.max(16, Math.ceil(target / 3)), 1, MAX_STEPS);
  const queries: RunQuery[] = [];
  for (let t = 0; queries.length < maxSteps && [...open.values()].some((l) => l.length); t++) {
    const m = turns[t % turns.length];
    const list = open.get(m) ?? [];
    if (!list.length) continue;
    const i = (pointer.get(m) ?? 0) % list.length;
    pointer.set(m, i + 1);
    const item = list[i];
    queries.push({ ...item.spec, page: item.next });
    item.next++;
    if (item.next > MAX_PAGE) list.splice(i, 1);
  }
  if (!queries.length) throw new Error('Every search has been read to the end. Add titles on the Targeting page to find new people.');

  const [row] = await db.query<RunRow>('INSERT INTO runs (geo, brief, queries, pages) VALUES ($1, $2, $3, 1) RETURNING *', [
    markets.join(','),
    JSON.stringify({ markets, target, quotas: quotasFor(target) } satisfies RunBrief),
    JSON.stringify(queries),
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

/** Saves one looked-up person with everything the brief asks for. Returns whether they are new and ready to email. */
export async function saveApolloLead(
  db: Db,
  m: ApolloMatch,
  fallbackMarket: Market,
  settings: Settings,
  source: string,
  run: { id?: number | string; need?: Partial<Quotas> } = {},
): Promise<{ inserted: boolean; ready: boolean; brand: string }> {
  const rule = checkLead({ title: m.title, industry: m.industry, employees: m.org?.employees ?? null }, settings.rules);
  // Someone based outside every brand's countries is saved but never emailed.
  const covered = eligibleBrands(m.country).length > 0;
  const check = covered ? rule : { ...rule, fit: false, reason: `Based in ${m.country || 'an unknown country'}, outside every brand's countries` };
  const edition = editionFor(m.industry, settings.editions);
  const linkedin = linkedinKey(m.linkedin) || null;
  const domain = normDomain(m.domain || m.website) || emailDomain(m.email);
  const suppressed = await suppressedReason(db, { email: m.email, domain, linkedin: linkedin ?? '', company: m.company });
  const tag = tagTitle(m.title, m.company);
  const status = statusOf(m);
  const emailStatus = m.email ? m.emailStatus : '';
  const values = [
    m.id, linkedin, m.name, m.title, m.company, [m.city, m.country].filter(Boolean).join(', '), marketOf(m.country) ?? fallbackMarket,
    tag.labels.join(', '), tag.isTarget, tag.rank, m.email, emailStatus, status, m.confidence, m.org?.employees ?? null, sizeVerdict(m.org),
    m.website, domain, m.industry, m.country, check.sector, check.size, edition.segment, check.matched, check.fit, check.reason, suppressed,
    companyKey(m.company), linkedin ?? '', source,
  ];
  const [existing] = await db.query<{ id: number | string; brand: string }>(
    "SELECT id, brand FROM people WHERE apollo_person_id = $1 OR (linkedin_key <> '' AND linkedin_key = $2) ORDER BY id LIMIT 1",
    [m.id, linkedin ?? ''],
  );
  const set = `apollo_person_id = $1, linkedin_url = COALESCE($2, linkedin_url), name = COALESCE(NULLIF($3, ''), name), title = COALESCE(NULLIF($4, ''), title),
    company = COALESCE(NULLIF($5, ''), company), location = COALESCE(NULLIF($6, ''), location), geo = $7, labels = $8, is_target = $9, rank = $10,
    email = $11, email_status = $12, apollo_status = $13, apollo_confidence = $14, company_employees = $15, company_size = $16, company_website = $17,
    company_domain = $18, industry = $19, country = $20, sector = $21, firm_size = $22, segment = $23, target_title = $24, icp_fit = $25, icp_note = $26,
    suppressed_reason = $27, company_key = $28, linkedin_key = $29, source_query = COALESCE(NULLIF(source_query, ''), $30), apollo_checked_at = now(),
    apollo_tier = 0, last_seen = now(), seen_count = seen_count + 1`;
  let brand = existing?.brand ?? '';
  if (existing) {
    // A lead keeps the brand it was first given, so no two brands ever contact the same person.
    await db.query(`UPDATE people SET ${set} WHERE id = $31`, [...values, existing.id]);
  } else {
    const picked = await pickBrand(db, eligibleBrands(m.country), run.need);
    brand = picked?.brand ?? 'none';
    await db.query(
      `INSERT INTO people (apollo_person_id, linkedin_url, name, title, company, location, geo, labels, is_target, rank, email, email_status, apollo_status,
         apollo_confidence, company_employees, company_size, company_website, company_domain, industry, country, sector, firm_size, segment, target_title,
         icp_fit, icp_note, suppressed_reason, company_key, linkedin_key, source_query, brand, brand_group, run_id, geo_match, apollo_checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
         $31, $32, $33, 'match', now())`,
      [...values, brand, picked?.group ?? '', run.id ?? null],
    );
  }
  return { inserted: !existing, ready: !!m.email && emailStatus === 'verified' && check.fit && !suppressed, brand };
}

export type StepSummary = {
  searched: number;
  wanted: number;
  skipped: number;
  lookedUp: number;
  ready: number;
  credits: number;
  /** Set when the daily lookup limit or an Apollo error stopped the step early. */
  stopped?: string;
};

/**
 * Works through the run's next search page: Apollo People Search (free), then, for people with a wanted title who are not
 * saved already and not at a client company, their full record from Apollo (credits, within the daily limit). Each lead is
 * then checked against the title rules on their real industry and size, and the suppression list on their email, domain
 * and LinkedIn. On a search failure the run is not advanced, so the same page is tried again next time.
 */
export async function runStep(svc: Services, db: Db, id: number | string, opts: { dailyLimit?: number } = {}): Promise<{ run: Run; summary: StepSummary }> {
  const run = await getRun(db, id);
  if (!run) throw new Error('Run not found');
  const summary: StepSummary = { searched: 0, wanted: 0, skipped: 0, lookedUp: 0, ready: 0, credits: 0 };
  if (run.status !== 'running' || run.next_index >= run.queries.length) return { run, summary };
  if (!run.queries[run.next_index].titles.length) throw new Error('This run is from the earlier LinkedIn search and cannot be continued. Start a new run.');
  if (quotasMet(run)) return { run, summary };
  // Skip, for free, searches in markets whose brands already have all the leads they need.
  const need = remainingNeed(run);
  const marketNeed = (m: Market) => brandsForMarket(m).reduce((n, b) => n + need[b], 0);
  let index = run.next_index;
  while (index < run.queries.length && run.queries[index].titles.length && marketNeed(run.queries[index].market) === 0) index++;
  if (index !== run.next_index) {
    await db.query('UPDATE runs SET next_index = $2 WHERE id = $1 AND next_index = $3', [id, index, run.next_index]);
    run.next_index = index;
    if (index >= run.queries.length) return { run: (await getRun(db, id)) as Run, summary };
  }
  const q = run.queries[index];
  const dailyLimit = opts.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  const room = dailyLimit - (await enrichStatus(db, dailyLimit)).usedToday;
  if (room <= 0) {
    summary.stopped = `Daily limit of ${dailyLimit} Apollo lookups reached. Raise APOLLO_DAILY_LIMIT in Vercel or continue tomorrow.`;
    await db.query('UPDATE runs SET error = $2 WHERE id = $1', [id, summary.stopped]);
    return { run: (await getRun(db, id)) as Run, summary };
  }
  const settings = await getSettings(db);

  let found: Awaited<ReturnType<typeof searchPeople>>;
  try {
    found = await searchPeople(svc, q, q.page);
  } catch (e) {
    await db.query('UPDATE runs SET error = $2 WHERE id = $1', [id, `Search ${index + 1}: ${(e as Error).message}`]);
    throw e;
  }
  summary.searched = found.people.length;
  await db.query(
    `INSERT INTO searched_queries (geo, query, pages_done, exhausted, last_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (geo, query) DO UPDATE SET pages_done = GREATEST(searched_queries.pages_done, EXCLUDED.pages_done),
       exhausted = searched_queries.exhausted OR EXCLUDED.exhausted, last_at = now()`,
    [q.market, q.key, q.page, found.people.length < PER_PAGE || q.page >= MAX_PAGE],
  );

  // Before paying for anyone: a wanted title, an email on record, not saved already, not at a client company.
  const wanted = found.people.filter((p) => p.hasEmail && matchTitle(p.title, q.titles));
  summary.wanted = wanted.length;
  const ids = wanted.map((p) => p.id);
  const saved = new Set(
    ids.length
      ? (await db.query<{ apollo_person_id: string }>(`SELECT apollo_person_id FROM people WHERE apollo_person_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids)).map(
          (r) => r.apollo_person_id,
        )
      : [],
  );
  const clients = await clientCompanies(db, wanted.map((p) => p.company));
  const fresh = wanted.filter((p) => !saved.has(p.id) && !clients.has(companyKey(p.company)));
  // Never pay for more people than this market's brands still need: a run of 10 looks up about 10, not a whole page.
  const toLookUp = fresh.slice(0, Math.min(room, run.brief.target ? marketNeed(q.market) : room));
  summary.skipped = found.people.length - toLookUp.length;

  let matches: (ApolloMatch | null)[] = [];
  if (toLookUp.length) {
    try {
      const r = await bulkMatch(svc, toLookUp.map((p) => ({ id: p.id })));
      matches = r.matches;
      summary.credits = r.credits;
    } catch (e) {
      const partial = (e as Error & { partial?: { matches: (ApolloMatch | null)[]; credits: number } }).partial;
      matches = partial?.matches ?? [];
      summary.credits = partial?.credits ?? 0;
      summary.stopped = (e as Error).message;
    }
  }
  let inserted = 0;
  let updated = 0;
  let withEmail = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m) continue;
    // Bulk match by id answers for that person; keep the id even if Apollo leaves it out of the answer.
    const r = await saveApolloLead(db, { ...m, id: m.id || toLookUp[i].id }, q.market, settings, q.label, { id, need });
    if (r.inserted) inserted++;
    else updated++;
    if (m.email) withEmail++;
    if (r.ready && r.inserted) {
      summary.ready++;
      const b = r.brand as Brand;
      if (b in need) {
        need[b] = Math.max(0, need[b] - 1);
        run.brand_ready[b] = (run.brand_ready[b] ?? 0) + 1;
      }
    }
  }
  summary.lookedUp = matches.length;
  if (matches.length) {
    await db.query('INSERT INTO enrichment_log (requested, matched, with_email, credits) VALUES ($1, $2, $3, $4)', [
      matches.length,
      matches.filter(Boolean).length,
      withEmail,
      summary.credits,
    ]);
  }
  // A failed lookup leaves the run on this page, so the people not looked up are tried again.
  const advance = summary.stopped ? 0 : 1;
  const [row] = await db.query<RunRow>(
    `UPDATE runs SET next_index = next_index + $3, searches = searches + 1, results = results + $4, found = found + $5, excluded = excluded + $6,
       inserted = inserted + $7, updated = updated + $8, apollo_requested = apollo_requested + $9, apollo_with_email = apollo_with_email + $10,
       apollo_credits = apollo_credits + $11, error = $12, brand_ready = $13
     WHERE id = $1 AND next_index = $2 RETURNING *`,
    [
      id,
      index,
      advance,
      summary.searched,
      summary.wanted,
      summary.skipped,
      inserted,
      updated,
      summary.lookedUp,
      summary.ready,
      summary.credits,
      summary.stopped ?? '',
      JSON.stringify(run.brand_ready),
    ],
  );
  // No row means another tab advanced the run meanwhile; the people saved here are deduplicated anyway.
  return { run: row ? toRun(row) : ((await getRun(db, id)) as Run), summary };
}

/** Sends waiting people from the earlier LinkedIn search to Apollo (the Emails page) and adds the cost to a run's tally. */
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
