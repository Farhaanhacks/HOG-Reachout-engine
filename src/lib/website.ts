import type { Geo } from './geo';
import type { SerperResult, Services } from './services';
import { googleSearch } from './services';
import { rootDomain } from './text';

// Directories, social networks, data sellers, marketplaces and news sites are never a company's own website.
export const BLOCKED_DOMAINS =
  /(^|\.)(linkedin|facebook|instagram|twitter|x|youtube|tiktok|wikipedia|crunchbase|pitchbook|cbinsights|tracxn|owler|zoominfo|rocketreach|apollo|lusha|signalhire|glassdoor|dnb|opencorporates|bloomberg|forbes|reuters|yelp|tripadvisor|yellowpages|google|amazon|medium|bayut|propertyfinder|dubizzle|zawya|gulfnews|khaleejtimes|thenationalnews|arabianbusiness|wamda|magnitt|sec|finra|brokercheck)\.|\.gov(\.[a-z]{2})?$/;

export function isBlockedDomain(domain: string): boolean {
  return BLOCKED_DOMAINS.test(domain);
}

// Words that say what a company does or what kind of firm it is, rather than which company it is.
const GENERIC = new Set(
  'llc fzco fze fz dmcc pjsc psc llp pvt private ltd limited inc corp corporation co company group holding holdings the and international global enterprises solutions technologies technology services capital partners ventures investments investment management asset assets advisors advisory fund funds trading properties real estate uae dubai abu dhabi usa america american middle east'.split(' '),
);

export function nameTokens(company: string): string[] {
  const words = company.toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
  const distinctive = words.filter((w) => !GENERIC.has(w) && (w.length >= 3 || /\d/.test(w)));
  return distinctive.length ? distinctive : words.filter((w) => w.length >= 3);
}

// Extra words in a domain that say it belongs to another organisation ("acmecollege.org").
const OTHER_ORG = /(college|school|university|institute|academy|hospital|news|jobs|careers|alumni|foundation|trust|blog)/;
// Extra words that still mean the same company ("acme-uae.com", "acmegroup.com").
const SAME_ORG = /^(?:uae|ae|dubai|us|usa|group|global|intl|international|co|corp|ltd|llc|inc|hq|the|world|online|capital|partners|holdings|holding)*$/;

/**
 * How well a domain matches a company name: 0 = not this company; 3+ = the domain is the
 * company's name, give or take words like "group" or "uae" ("Danube Group" gives danubegroup.com).
 */
export function domainScore(company: string, domain: string): number {
  const tokens = nameTokens(company);
  const root = rootDomain(domain);
  if (!tokens.length || !root || isBlockedDomain(root)) return 0;
  const label = root.split('.')[0].replace(/-/g, '');
  const matched = tokens.filter((t) => label.includes(t));
  if (!matched.length) return 0;
  const rest = matched.reduce((r, t) => r.replace(t, ''), label);
  if (OTHER_ORG.test(rest) && !OTHER_ORG.test(company.toLowerCase())) return 0;
  // What's left of the domain must be the company's own other words (or short forms of them), or
  // harmless extras. Anything else is another company sharing a word.
  const fullName = tokens.length >= 2 && matched.length === tokens.length;
  if (!fullName && !SAME_ORG.test(ownWordsRemoved(rest, company))) return 0;
  const clean = SAME_ORG.test(rest);
  return matched.length + (clean && matched.length === tokens.length ? 1 : 0) + (clean ? 1 : 0);
}

/** The domain's leftover letters with the company's own words (whole, or their first 3+ letters) and initials taken out. */
function ownWordsRemoved(rest: string, company: string): string {
  const words = company.toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
  let r = rest;
  const initials = words.map((w) => w[0]).join('');
  if (initials.length >= 2 && r.includes(initials)) r = r.replace(initials, '');
  for (const w of words) {
    for (let len = w.length; len >= 3; len--) {
      const piece = w.slice(0, len);
      if (r.includes(piece)) {
        r = r.replace(piece, '');
        break;
      }
    }
  }
  return r;
}

export type DomainCandidate = { domain: string; score: number; link: string };

/** The first ten results as candidate domains with their scores, best first (earlier results win ties). */
export function rankDomains(company: string, results: SerperResult[]): DomainCandidate[] {
  const seen = new Set<string>();
  const out: DomainCandidate[] = [];
  for (const r of results.slice(0, 10)) {
    const domain = rootDomain(r.link);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push({ domain, score: domainScore(company, domain), link: r.link ?? '' });
  }
  return out.map((c, i) => ({ c, i })).sort((a, b) => b.c.score - a.c.score || a.i - b.i).map((x) => x.c);
}

/** The company's own domain among search results, or '' when none is convincing. */
export function pickOfficialDomain(company: string, results: SerperResult[]): string {
  const best = rankDomains(company, results)[0];
  return best && best.score > 0 ? best.domain : '';
}

/** Looks the company's website up on Google. Returns '' when nothing convincing turns up. Cached by company and country. */
export async function findOfficialWebsite(svc: Services, company: string, geo: Geo, city = ''): Promise<string> {
  const key = `domain:v1:${geo}:${company.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  try {
    const hit = (await svc.cache?.get(key)) as { domain: string } | null | undefined;
    if (hit && typeof hit.domain === 'string') return hit.domain;
  } catch {}
  try {
    const results = await googleSearch(svc, `${company} ${city} official website`.replace(/\s+/g, ' ').trim(), geo);
    const domain = pickOfficialDomain(company, results);
    await svc.cache?.set(key, { domain }).catch(() => {});
    return domain;
  } catch {
    return '';
  }
}
