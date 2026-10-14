import { bulkMatch, type ApolloMatch } from './apollo';
import {
  COMPANIES_PER_PEOPLE_SEARCH,
  COMPANY_MAX_PAGE,
  MAX_PAGE,
  PEOPLE_PAGES_PER_COMPANIES,
  PEOPLE_PER_PAGE_AT_COMPANIES,
  PER_PAGE,
  icpSearches,
  searchCompanies,
  searchPeople,
  searchesFor,
  type FoundPerson,
  type SearchSpec,
} from './apollo-search';
import { DEFAULT_DAILY_LIMIT, enrichStatus, runEnrichment, statusOf, type EnrichSummary } from './enrich';
import { companyKey, emailDomain, linkedinKey, normDomain } from './keys';
import { BRAND_LIST, brandsForMarket, eligibleBrands, isBrand, pickBrand, quotasFor, type Quotas } from './brands';
import { AFRICA_LANE, ICPS, checkIcpLead, icpById, laneCaps, type Icp } from './icps';
import { MARKET_LIST, isMarket, marketOf, type Market } from './markets';
import { cellKey, needIn, needs, regionQuotas, type Needs } from './quotas';
import { tagTitle } from './seniority';
import { getSettings, type Settings } from './settings';
import { sizeVerdict } from './size';
import { clientCompanies, suppressedReason } from './suppression';
import type { Services } from './services';
import { ensureSchema, type Db } from './store';
import { checkLead, editionFor, matchTitle, sectorOf } from './targeting';

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
  lane_ready?: string | null;
  region_ready?: string | null;
  /** Started by the autopilot (the hourly scheduler) rather than the Run workflow button. */
  auto?: boolean;
  /** Autopilot stage: finding, writing, sending (then the run is done). */
  phase?: string;
};

/** What a run is asked for: these markets, until this many new leads can be emailed, split between the brands. */
export type RunBrief = {
  markets: string[];
  target: number;
  quotas?: Quotas;
  /** The most leads each lane (ICP, or Africa) may take. Older runs have none. */
  lanes?: Record<string, number>;
  /** Each brand's quota split equally between its regions ("hog:us": 3). Older runs have none. */
  regions?: Record<string, number>;
};
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
export type Run = Omit<RunRow, 'brief' | 'queries' | 'apollo_credits' | 'brand_ready' | 'lane_ready' | 'region_ready'> & {
  brief: RunBrief;
  queries: RunQuery[];
  apollo_credits: number;
  /** New leads ready to email found so far, per brand. */
  brand_ready: Partial<Quotas>;
  /** New leads ready to email found so far, per lane (ICP id, or 'africa'). */
  lane_ready: Record<string, number>;
  /** New leads ready to email found so far, per brand and region ("hog:us"). */
  region_ready: Record<string, number>;
  /** How many more leads the run can still find; 0 when it has all it needs or nothing left to search. */
  left: number;
};

type NeedSource = Pick<Run, 'brief' | 'brand_ready' | 'lane_ready' | 'region_ready' | 'queries' | 'next_index'>;

/** What each brand still needs in a run (never below 0), by brand only: how runs from before the region split work. */
export function remainingNeed(run: Pick<Run, 'brief' | 'brand_ready'>): Quotas {
  const quotas = run.brief.quotas ?? quotasFor(run.brief.target);
  return Object.fromEntries(BRAND_LIST.map((b) => [b, Math.max(0, quotas[b] - (run.brand_ready[b] ?? 0))])) as Quotas;
}

/** What a run split by region still needs, counting the searches from `from` on; null for older runs. */
export function runNeeds(run: NeedSource, from = run.next_index): Needs | null {
  if (!run.brief.regions) return null;
  return needs({
    regions: run.brief.regions,
    regionReady: run.region_ready,
    lanes: run.brief.lanes,
    laneReady: run.lane_ready,
    remaining: run.queries.slice(from).filter((q) => q.titles.length),
  });
}

function leftOf(run: NeedSource): number {
  const n = runNeeds(run);
  return n ? n.left : Object.values(remainingNeed(run)).reduce((a, b) => a + b, 0);
}

/** Whether the run has found all it needs (or, split by region, all its remaining searches can still give it). */
export function quotasMet(run: NeedSource): boolean {
  return leftOf(run) === 0;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo));

/** Reads a stored run, including runs from the earlier LinkedIn search (shown in the history, never continued). */
function toRun(r: RunRow): Run {
  const brief = JSON.parse(r.brief) as Partial<RunBrief> & { geos?: string[] };
  const queries = (JSON.parse(r.queries) as Partial<RunQuery & { query: string; geo: string; segment: string; startPage: number }>[]).map(
    (q): RunQuery => ({
      ...q,
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
  const parse = <T,>(s: string | null | undefined): T => {
    try {
      return JSON.parse(s || '{}') as T;
    } catch {
      return {} as T;
    }
  };
  const run: Run = {
    ...r,
    brief: { markets: brief.markets ?? brief.geos ?? r.geo.split(','), target: brief.target ?? 0, quotas: brief.quotas, lanes: brief.lanes, regions: brief.regions },
    queries,
    apollo_credits: Number(r.apollo_credits) || 0,
    brand_ready: parse<Partial<Quotas>>(r.brand_ready),
    lane_ready: parse<Record<string, number>>(r.lane_ready),
    region_ready: parse<Record<string, number>>(r.region_ready),
    left: 0,
  };
  run.left = run.status === 'running' && queries[0]?.titles.length ? leftOf(run) : 0;
  return run;
}

/**
 * Starts a run. Searches take turns by lane (each of the five ICPs, then Africa) and, within a lane, by region; each
 * search continues from the page earlier runs stopped at, so every run finds new people.
 */
export async function createRun(db: Db, brief: { markets?: string[]; target?: number } = {}, opts: { maxSteps?: number; auto?: boolean } = {}): Promise<Run> {
  const markets = [...new Set(brief.markets ?? MARKET_LIST)].filter(isMarket);
  if (!markets.length) throw new Error('Choose at least one market.');
  const target = clamp(brief.target ?? DEFAULT_TARGET, 1, 2000);
  await ensureSchema(db);
  const settings = await getSettings(db);

  const history = new Map<string, { pages: number; exhausted: boolean }>();
  for (const h of await db.query<{ geo: string; query: string; pages_done: number; exhausted: boolean }>('SELECT geo, query, pages_done, exhausted FROM searched_queries')) {
    history.set(`${h.geo}|${h.query}`, { pages: h.pages_done, exhausted: h.exhausted });
  }
  // Per lane: its searches still to read (in the run's markets), each with the next page to read.
  const lanes: [string, SearchSpec[]][] = [
    ...ICPS.map((icp): [string, SearchSpec[]] => [icp.id, icpSearches(icp)]),
    [AFRICA_LANE, searchesFor('af', settings.rules)],
  ];
  const open = new Map<string, { spec: SearchSpec; next: number }[]>();
  for (const [lane, specs] of lanes) {
    open.set(
      lane,
      specs
        .filter((spec) => markets.includes(spec.market))
        .map((spec) => ({ spec, h: history.get(`${spec.market}|${spec.key}`) ?? { pages: 0, exhausted: false } }))
        .filter((x) => !x.h.exhausted && x.h.pages < maxPageOf(x.spec))
        .map((x) => ({ spec: x.spec, next: x.h.pages + 1 })),
    );
  }
  const turns = lanes.map(([lane]) => lane);
  // Each run starts every lane at a different search, so an ICP's keywords and regions all take turns over the hours.
  const [count] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM runs');
  const runNumber = Number(count?.n) || 0;
  const pointer = new Map<string, number>(lanes.map(([lane]) => [lane, runNumber]));
  // Searches are free, and those whose brands or lane are already full are skipped for free, so plenty are planned;
  // what a run pays for is capped by the target (see runStep).
  const maxSteps = clamp(opts.maxSteps ?? Math.max(40, target), 1, MAX_STEPS);
  const queries: RunQuery[] = [];
  for (let t = 0; queries.length < maxSteps && [...open.values()].some((l) => l.length); t++) {
    const m = turns[t % turns.length];
    const list = open.get(m) ?? [];
    if (!list.length) continue;
    const i = (pointer.get(m) ?? 0) % list.length;
    pointer.set(m, i + 1);
    const item = list[i];
    queries.push({ ...item.spec, page: item.next });
    // An ICP search reads its current company page until everyone suitable there is looked up (see icpPeople), so it
    // is planned as often as needed without moving on; other searches read one new page each time.
    if (!isCompanySearch(item.spec)) item.next++;
    if (item.next > maxPageOf(item.spec)) list.splice(i, 1);
  }
  if (!queries.length) throw new Error('Every search has been read to the end. Add titles on the Targeting page to find new people.');
  const quotas = quotasFor(target);

  const [row] = await db.query<RunRow>('INSERT INTO runs (geo, brief, queries, pages, auto, phase) VALUES ($1, $2, $3, 1, $4, $5) RETURNING *', [
    markets.join(','),
    JSON.stringify({ markets, target, quotas, lanes: laneCaps(target), regions: regionQuotas(quotas, markets, runNumber) } satisfies RunBrief),
    JSON.stringify(queries),
    !!opts.auto,
    opts.auto ? 'finding' : '',
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

const isCompanySearch = (spec: SearchSpec) => !!spec.companyKeywords?.length;
const maxPageOf = (spec: SearchSpec) => (isCompanySearch(spec) ? COMPANY_MAX_PAGE : MAX_PAGE);

/**
 * The people an ICP search offers now: its current page of companies (pages already fully worked through are skipped),
 * fetched from Apollo's company search only the first time (1 credit) and kept, then People Search (free) for the ICP's
 * titles and seniorities at those companies, 50 companies at a time.
 */
async function icpPeople(
  svc: Services,
  db: Db,
  q: RunQuery,
): Promise<{ page: number; people: FoundPerson[]; credits: number; lastPage: boolean; allRead: boolean }> {
  const [done] = await db.query<{ pages_done: number; exhausted: boolean }>('SELECT pages_done, exhausted FROM searched_queries WHERE geo = $1 AND query = $2', [
    q.market,
    q.key,
  ]);
  const page = (done?.pages_done ?? 0) + 1;
  // Every company page has been worked through: nothing more to find, and nothing to pay for.
  if (done?.exhausted) return { page: page - 1, people: [], credits: 0, lastPage: true, allRead: true };
  let credits = 0;
  let ids: string[];
  const [kept] = await db.query<{ company_ids: string }>('SELECT company_ids FROM company_pages WHERE geo = $1 AND query = $2 AND page = $3', [q.market, q.key, page]);
  if (kept) ids = JSON.parse(kept.company_ids) as string[];
  let lastPage: boolean;
  if (kept) {
    const saved = JSON.parse(kept.company_ids) as string[] | { ids: string[]; lastPage: boolean };
    // (Pages kept by the first version of this were a plain list, with no last-page flag.)
    ids = Array.isArray(saved) ? saved : saved.ids;
    lastPage = Array.isArray(saved) ? ids.length === 0 : saved.lastPage;
  } else {
    ({ ids, lastPage } = await searchCompanies(svc, q, page));
    credits = 1;
    await db.query('INSERT INTO company_pages (geo, query, page, company_ids) VALUES ($1, $2, $3, $4) ON CONFLICT (geo, query, page) DO NOTHING', [
      q.market,
      q.key,
      page,
      JSON.stringify({ ids, lastPage }),
    ]);
  }
  const people = new Map<string, FoundPerson>();
  let allRead = true;
  for (let i = 0; i < ids.length; i += COMPANIES_PER_PEOPLE_SEARCH) {
    const organizationIds = ids.slice(i, i + COMPANIES_PER_PEOPLE_SEARCH);
    for (let p = 1; ; p++) {
      const res = await searchPeople(svc, q, p, { organizationIds, perPage: PEOPLE_PER_PAGE_AT_COMPANIES });
      for (const person of res.people) people.set(person.id, person);
      if (res.people.length < PEOPLE_PER_PAGE_AT_COMPANIES) break;
      if (p >= PEOPLE_PAGES_PER_COMPANIES) {
        allRead = false;
        break;
      }
    }
  }
  return { page, people: [...people.values()], credits, lastPage, allRead };
}

/** Saves one looked-up person with everything the brief asks for. Returns whether they are new and ready to email. */
export async function saveApolloLead(
  db: Db,
  m: ApolloMatch,
  fallbackMarket: Market,
  settings: Settings,
  source: string,
  run: { id?: number | string; need?: Partial<Quotas>; icp?: Icp } = {},
): Promise<{ inserted: boolean; ready: boolean; brand: string }> {
  // A lead found for an ICP is checked against that ICP; anyone else (Africa, older searches) against the title rules.
  const rule = run.icp
    ? { ...checkIcpLead(run.icp, { title: m.title, employees: m.org?.employees ?? null, country: m.country }), sector: sectorOf(m.industry, settings.rules) }
    : checkLead({ title: m.title, industry: m.industry, employees: m.org?.employees ?? null }, settings.rules);
  // Someone based outside every brand's countries is saved but never emailed.
  const covered = eligibleBrands(m.country).length > 0;
  const check = covered ? rule : { ...rule, fit: false, reason: `Based in ${m.country || 'an unknown country'}, outside every brand's countries` };
  const segment = run.icp?.label ?? editionFor(m.industry, settings.editions).segment;
  const linkedin = linkedinKey(m.linkedin) || null;
  const domain = normDomain(m.domain || m.website) || emailDomain(m.email);
  const suppressed = await suppressedReason(db, { email: m.email, domain, linkedin: linkedin ?? '', company: m.company });
  const tag = tagTitle(m.title, m.company);
  const status = statusOf(m);
  const emailStatus = m.email ? m.emailStatus : '';
  const values = [
    m.id, linkedin, m.name, m.title, m.company, [m.city, m.country].filter(Boolean).join(', '), marketOf(m.country) ?? fallbackMarket,
    tag.labels.join(', '), tag.isTarget, tag.rank, m.email, emailStatus, status, m.confidence, m.org?.employees ?? null, sizeVerdict(m.org),
    m.website, domain, m.industry, m.country, check.sector, check.size, segment, check.matched, check.fit, check.reason, suppressed,
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
  // How many more this search may bring: what its region still needs across the brands that cover it (by brand and
  // region, and within its lane's cap), or for older runs what the region's brands still need.
  const need = remainingNeed(run);
  const marketNeed = (m: Market) => brandsForMarket(m).reduce((n, b) => n + need[b], 0);
  const searchNeedAt = (i: number): { n: number; needs: Needs | null } => {
    const q = run.queries[i];
    const needs = runNeeds(run, i);
    if (!needs) return { n: marketNeed(q.market), needs };
    const inRegion = Object.values(needIn(needs.cells, q.market)).reduce((a, b) => a + (b ?? 0), 0);
    const inLane = needs.lanes && q.lane ? (needs.lanes[q.lane] ?? 0) : Infinity;
    return { n: Math.min(inRegion, inLane), needs };
  };
  // Skip, for free, searches whose region or lane already has all the leads it needs.
  let index = run.next_index;
  while (index < run.queries.length && run.queries[index].titles.length && searchNeedAt(index).n === 0) index++;
  if (index !== run.next_index) {
    await db.query('UPDATE runs SET next_index = $2 WHERE id = $1 AND next_index = $3', [id, index, run.next_index]);
    run.next_index = index;
    if (index >= run.queries.length) return { run: (await getRun(db, id)) as Run, summary };
  }
  const q = run.queries[index];
  const { n: searchNeed, needs: current } = searchNeedAt(index);
  const dailyLimit = opts.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  const room = dailyLimit - (await enrichStatus(db, dailyLimit)).usedToday;
  if (room <= 0) {
    summary.stopped = `Daily limit of ${dailyLimit} Apollo lookups reached. Raise APOLLO_DAILY_LIMIT in Vercel or continue tomorrow.`;
    await db.query('UPDATE runs SET error = $2 WHERE id = $1', [id, summary.stopped]);
    return { run: (await getRun(db, id)) as Run, summary };
  }
  const settings = await getSettings(db);

  // An ICP search: its current page of companies, then the people there. Any other search: one page of People Search.
  let found: { people: FoundPerson[] };
  let icp: Awaited<ReturnType<typeof icpPeople>> | null = null;
  try {
    if (isCompanySearch(q)) {
      icp = await icpPeople(svc, db, q);
      found = icp;
    } else found = await searchPeople(svc, q, q.page);
  } catch (e) {
    await db.query('UPDATE runs SET error = $2 WHERE id = $1', [id, `Search ${index + 1}: ${(e as Error).message}`]);
    throw e;
  }
  summary.searched = found.people.length;
  if (icp?.credits) {
    summary.credits += icp.credits;
    // Counted with the lookups, so APOLLO_DAILY_LIMIT caps every credit the engine spends.
    await db.query('INSERT INTO enrichment_log (requested, matched, with_email, credits) VALUES ($1, 0, 0, $2)', [icp.credits, icp.credits]);
  }
  const markSearched = (pagesDone: number, exhausted: boolean) =>
    db.query(
      `INSERT INTO searched_queries (geo, query, pages_done, exhausted, last_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (geo, query) DO UPDATE SET pages_done = GREATEST(searched_queries.pages_done, EXCLUDED.pages_done),
         exhausted = searched_queries.exhausted OR EXCLUDED.exhausted, last_at = now()`,
      [q.market, q.key, pagesDone, exhausted],
    );
  if (!icp) await markSearched(q.page, found.people.length < PER_PAGE || q.page >= MAX_PAGE);

  // Before paying for anyone: a wanted title, an email on record, not saved already, not at a client company.
  const wanted = found.people.filter((p) => p.hasEmail && matchTitle(p.title, q.titles));
  summary.wanted = wanted.length;
  const ids = wanted.map((p) => p.id);
  const saved = new Set(
    ids.length
      ? (
          await db.query<{ apollo_person_id: string }>(
            `SELECT apollo_person_id FROM people WHERE apollo_person_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})
             UNION SELECT apollo_person_id FROM apollo_misses WHERE apollo_person_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`,
            ids,
          )
        ).map((r) => r.apollo_person_id)
      : [],
  );
  const clients = await clientCompanies(db, wanted.map((p) => p.company));
  const fresh = wanted.filter((p) => !saved.has(p.id) && !clients.has(companyKey(p.company)));
  // Never pay for more people than this search may still bring: a run of 10 looks up about 10, not a whole page.
  const budget = room - (icp?.credits ?? 0);
  const toLookUp = fresh.slice(0, Math.max(0, Math.min(budget, run.brief.target ? searchNeed : budget)));
  summary.skipped = found.people.length - toLookUp.length;

  let matches: (ApolloMatch | null)[] = [];
  if (toLookUp.length) {
    try {
      const r = await bulkMatch(svc, toLookUp.map((p) => ({ id: p.id })));
      matches = r.matches;
      summary.credits += r.credits;
    } catch (e) {
      const partial = (e as Error & { partial?: { matches: (ApolloMatch | null)[]; credits: number } }).partial;
      matches = partial?.matches ?? [];
      summary.credits += partial?.credits ?? 0;
      summary.stopped = (e as Error).message;
    }
  }
  let inserted = 0;
  let updated = 0;
  let withEmail = 0;
  // Anyone Apollo could not match is remembered, so they are never paid for again.
  const missed = summary.stopped ? [] : toLookUp.filter((_, i) => !matches[i]).map((p) => p.id);
  for (const miss of missed) await db.query('INSERT INTO apollo_misses (apollo_person_id) VALUES ($1) ON CONFLICT DO NOTHING', [miss]);
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m) continue;
    // The lead's brand goes to whichever brand covering their region still needs the most there.
    const region = marketOf(m.country) ?? q.market;
    const brandNeed = current ? needIn(current.cells, region) : need;
    // Bulk match by id answers for that person; keep the id even if Apollo leaves it out of the answer.
    const r = await saveApolloLead(db, { ...m, id: m.id || toLookUp[i].id }, q.market, settings, q.label, { id, need: brandNeed, icp: icpById(q.lane) });
    if (r.inserted) inserted++;
    else updated++;
    if (m.email) withEmail++;
    if (r.ready && r.inserted && isBrand(r.brand)) {
      summary.ready++;
      const b = r.brand;
      need[b] = Math.max(0, need[b] - 1);
      run.brand_ready[b] = (run.brand_ready[b] ?? 0) + 1;
      const cell = cellKey(b, region);
      run.region_ready[cell] = (run.region_ready[cell] ?? 0) + 1;
      if (current && cell in current.cells) current.cells[cell] = Math.max(0, current.cells[cell] - 1);
      if (q.lane) {
        run.lane_ready[q.lane] = (run.lane_ready[q.lane] ?? 0) + 1;
        if (current?.lanes && q.lane in current.lanes) current.lanes[q.lane] = Math.max(0, current.lanes[q.lane] - 1);
      }
    }
  }
  summary.lookedUp = matches.length;
  // An ICP's company page is done once everyone suitable at those companies has been looked up; until then the next run
  // keeps working through it, free.
  if (icp) {
    const used = !summary.stopped && icp.allRead && fresh.length <= toLookUp.length;
    // (People not matched just now are remembered above, so they do not hold the page open.)
    await markSearched(used ? icp.page : icp.page - 1, used && icp.lastPage);
  }
  if (matches.length) {
    await db.query('INSERT INTO enrichment_log (requested, matched, with_email, credits) VALUES ($1, $2, $3, $4)', [
      matches.length,
      matches.filter(Boolean).length,
      withEmail,
      summary.credits - (icp?.credits ?? 0), // the company page was logged on its own above
    ]);
  }
  // A failed lookup leaves the run on this page, so the people not looked up are tried again.
  const advance = summary.stopped ? 0 : 1;
  const [row] = await db.query<RunRow>(
    `UPDATE runs SET next_index = next_index + $3, searches = searches + 1, results = results + $4, found = found + $5, excluded = excluded + $6,
       inserted = inserted + $7, updated = updated + $8, apollo_requested = apollo_requested + $9, apollo_with_email = apollo_with_email + $10,
       apollo_credits = apollo_credits + $11, error = $12, brand_ready = $13, lane_ready = $14, region_ready = $15
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
      JSON.stringify(run.lane_ready),
      JSON.stringify(run.region_ready),
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
