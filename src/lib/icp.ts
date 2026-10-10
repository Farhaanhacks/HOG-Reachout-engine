import type { Geo } from './geo';
import { buildQueries } from './queries';

/**
 * Humans of Globe's ideal customer: the main decision-maker of a company, in the UAE and the US. Each segment names the
 * titles that are "the main person" for that kind of company: a CEO or founder at a company, a CIO or managing partner
 * at a fund.
 */
export type Segment = {
  id: string;
  label: string;
  description: string;
  titles: string[];
  /** Words every result must contain, e.g. "hedge fund". */
  keywords: string[];
  /** A fund-like segment: a CIO or principal here is the main person. */
  fund?: boolean;
};

export const SEGMENTS: Segment[] = [
  { id: 'leaders', label: 'Company leaders', description: 'The main decision-maker at any company', titles: ['Founder', 'Co-Founder', 'CEO', 'Managing Director', 'Owner', 'President', 'Chairman'], keywords: [] },
  { id: 'software', label: 'Software and internet', description: 'Founders and C-suite at software and internet companies', titles: ['Founder', 'CEO', 'COO', 'CMO', 'President'], keywords: ['software'] },
  { id: 'finance', label: 'Financial services', description: 'CEOs, MDs and C-suite at banks, fintechs and financial firms', titles: ['CEO', 'Managing Director', 'President', 'COO', 'CMO'], keywords: ['financial services'] },
  { id: 'media', label: 'Media and entertainment', description: 'Founders and C-suite at media and entertainment companies', titles: ['Founder', 'CEO', 'COO', 'CMO', 'Managing Director', 'President'], keywords: ['media'] },
  { id: 'startups', label: 'Startup founders and C-suite', description: 'Founders, CEOs, CTOs, CMOs and COOs at startups', titles: ['Founder', 'Co-Founder', 'CEO', 'CTO', 'CMO', 'COO'], keywords: ['startup'] },
  { id: 'hedge', label: 'Hedge funds and asset managers', description: 'CIOs, founders and managing partners', titles: ['Chief Investment Officer', 'CIO', 'Founder', 'Managing Partner'], keywords: ['hedge fund'], fund: true },
  { id: 'vc', label: 'Venture capital', description: 'Managing, general and founding partners', titles: ['Managing Partner', 'General Partner', 'Founding Partner', 'Founder'], keywords: ['venture capital'], fund: true },
  { id: 'pe', label: 'Private equity', description: 'Managing partners and managing directors', titles: ['Managing Partner', 'Managing Director', 'Founding Partner', 'Founder'], keywords: ['private equity'], fund: true },
  { id: 'family', label: 'Family offices', description: 'Principals, CIOs and founders', titles: ['Principal', 'Chief Investment Officer', 'Founder', 'Managing Director'], keywords: ['family office'], fund: true },
  { id: 'realestate', label: 'Real estate', description: 'Founders, CEOs, owners and chairmen of developers and brokerages', titles: ['Founder', 'CEO', 'Managing Director', 'Owner', 'Chairman'], keywords: ['real estate'] },
];

export const DEFAULT_SEGMENTS = ['leaders', 'startups', 'hedge'];
export const DEFAULT_GEOS: Geo[] = ['ae', 'us'];

export function segmentById(id: string): Segment | undefined {
  return SEGMENTS.find((s) => s.id === id);
}

export type PlannedQuery = { query: string; geo: Geo; segment: string };
export type Plan = { geos: Geo[]; segments: string[]; extraTitles?: string[] };

/**
 * Every search for a plan: each segment in each country. They are interleaved (UAE leaders, US leaders, UAE startups…)
 * so that capping the number of searches still covers every country and segment instead of only the first.
 */
export function planQueries(plan: Plan, maxQueries?: number): PlannedQuery[] {
  const groups: PlannedQuery[][] = [];
  // Countries alternate inside each segment (UAE leaders, US leaders, UAE software, US software…), so even a short
  // run reaches every country.
  for (const id of plan.segments) {
    const s = segmentById(id);
    if (!s) continue;
    const titles = [...s.titles, ...(plan.extraTitles ?? [])];
    for (const geo of plan.geos) {
      groups.push(buildQueries({ geo, titles, keywords: s.keywords }).map((query) => ({ query, geo, segment: s.id })));
    }
  }
  const out: PlannedQuery[] = [];
  const seen = new Set<string>();
  for (let i = 0; groups.some((g) => i < g.length); i++) {
    for (const g of groups) {
      const q = g[i];
      if (q && !seen.has(`${q.geo}|${q.query}`)) {
        seen.add(`${q.geo}|${q.query}`);
        out.push(q);
      }
    }
  }
  return maxQueries ? out.slice(0, maxQueries) : out;
}
