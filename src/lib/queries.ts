import type { Geo } from './geo';
import { GEOS } from './geo';

/** What the team asks for: who, where, and any words the profile must contain. */
export type Brief = {
  geo: Geo;
  titles: string[];
  /** Defaults to the geo's main cities. */
  cities?: string[];
  /** Extra words every result must contain, e.g. "hedge fund" or "real estate". */
  keywords?: string[];
  /** How many titles share one query (OR-ed). Fewer per query gives deeper results per title. */
  titlesPerQuery?: number;
};

const quote = (s: string) => `"${s.trim().replace(/"/g, '')}"`;

/**
 * Google X-ray queries for public LinkedIn profiles: one per group of titles and city.
 * The city is quoted so Google matches it; it can still match a company name ("Dubai Technologies"),
 * which is why step 3 checks each person's own location line.
 */
export function buildQueries(brief: Brief): string[] {
  const titles = [...new Set(brief.titles.map((t) => t.trim()).filter(Boolean))];
  const cities = (brief.cities?.length ? brief.cities : GEOS[brief.geo].cities).map((c) => c.trim()).filter(Boolean);
  const keywords = (brief.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  const size = Math.max(1, brief.titlesPerQuery ?? 3);
  const groups: string[][] = [];
  for (let i = 0; i < titles.length; i += size) groups.push(titles.slice(i, i + size));

  const out = new Set<string>();
  for (const city of cities) {
    for (const group of groups) {
      out.add(['site:linkedin.com/in', `(${group.map(quote).join(' OR ')})`, quote(city), ...keywords.map(quote)].join(' '));
    }
  }
  return [...out];
}
