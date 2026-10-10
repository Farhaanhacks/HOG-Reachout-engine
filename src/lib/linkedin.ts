import type { Geo } from './geo';
import type { SerperResult } from './services';

/** A person read from one Google result for a LinkedIn profile. */
export type Person = {
  name: string;
  /** The role as written ("Founder & CEO"). Empty when the result doesn't show one. */
  title: string;
  company: string;
  /** The company name was cut off by Google ("Dubai Euro ..."): the real name is longer. */
  companyTruncated: boolean;
  /** Where the profile says they are based, as written ("دبي، الإمارات العربية المتحدة"). */
  location: string;
  /** Whether that location is in the searched country. 'unknown' when there is no location or it is not recognisable. */
  geoMatch: 'match' | 'other' | 'unknown';
  linkedin: string;
  snippet: string;
};

/** "https://ae.linkedin.com/in/Name-1?x=y" gives "https://www.linkedin.com/in/name-1", the same for every host. */
export function canonicalProfileUrl(link: string): string {
  const m = /^https?:\/\/[a-z0-9-]+\.linkedin\.com\/in\/([^/?#]+)/i.exec((link ?? '').trim());
  if (!m) return '';
  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {}
  return `https://www.linkedin.com/in/${slug.toLowerCase()}`;
}

const JOB_WORD = /\b(chairman|chairwoman|chairperson|founder|co-?founder|ceo|cfo|coo|cto|cio|cmo|chro|chief|president|owner|partner|principal|managing|director|head|vp|md|gm|manager|officer|investor)\b/i;
/** A piece after a comma that is a department, not a company ("Head, Operations"). */
const DEPARTMENT = /^(operations|finance|sales|marketing|technology|strategy|engineering|product|growth|business development|human resources|hr|legal|risk|investments?)\b/i;
const COMPANY_SUFFIX = /^(inc|llc|l\.l\.c|ltd|limited|llp|co|corp|plc)\b\.?/i;
const OWNER_ROLE = /\b(ceo|cfo|coo|cto|founder|co-?founder|chairman|chairwoman|chairperson|president|owner|partner|principal|md)$/i;

function cleanCompany(raw: string): { company: string; truncated: boolean } {
  let text = raw.trim();
  const truncated = /(\.\.\.|…)\s*$/.test(text);
  text = text.replace(/\s*(\.\.\.|…)\s*$/, '');
  // "Sooner, YC Alum" is the company "Sooner"; "Acme, Inc." keeps its suffix.
  const comma = /^([^,]+),\s*(.*)$/.exec(text);
  if (comma && !COMPANY_SUFFIX.test(comma[2])) text = comma[1];
  return { company: text.replace(/[\s,|.-]+$/, '').trim(), truncated };
}

/** The role and company from the part of a Google title after the name. */
export function splitRoleAndCompany(segment: string): { title: string; company: string; companyTruncated: boolean } {
  const s = segment.trim();
  const none = { title: '', company: '', companyTruncated: false };
  if (!s) return none;
  const wrap = (title: string, company: string) => {
    const c = cleanCompany(company);
    return { title: title.trim(), company: c.company, companyTruncated: c.truncated };
  };
  const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(s);
  if (at && JOB_WORD.test(at[1])) return wrap(at[1], at[2]);
  const of = /^(.*?)\s+of\s+(.+)$/i.exec(s);
  if (of && OWNER_ROLE.test(of[1].trim())) return wrap(of[1], of[2]);
  const comma = /^([^,]{2,60}),\s+(.+)$/.exec(s);
  if (comma && JOB_WORD.test(comma[1]) && !JOB_WORD.test(comma[2]) && !DEPARTMENT.test(comma[2].trim())) return wrap(comma[1], comma[2]);
  // Just a role ("Managing Partner"), or a headline with no role in it.
  return JOB_WORD.test(s) && s.length <= 70 ? { title: s.replace(/\s*(\.\.\.|…)\s*$/, ''), company: '', companyTruncated: false } : none;
}

/** Google's line under a profile result: "location · role · company". */
export function parseSubtitle(subtitle: string | undefined): { location: string; title: string; company: string } {
  const parts = String(subtitle ?? '').split(/\s+·\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return { location: parts[0], title: parts[parts.length - 2], company: parts[parts.length - 1] };
  if (parts.length === 2) return { location: parts[0], title: '', company: '' };
  return { location: '', title: '', company: '' };
}

const UAE_PLACES = /united arab emirates|\buae\b|dubai|abu dhabi|sharjah|ajman|ras al[- ]khaimah|fujairah|umm al[- ]quwain|الإمارات|دبي|أبوظبي|الشارقة/i;
const US_PLACES = /united states|\busa\b|\bu\.s\.|,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY|DC)\b|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming|bay area|los angeles|san francisco|san diego|san jose|chicago|houston|miami|boston|seattle|austin|dallas|atlanta|denver|las vegas|philadelphia|phoenix|nashville|brooklyn/i;
const OTHER_PLACES = /india|pakistan|bangladesh|sri lanka|nepal|united kingdom|\buk\b|england|scotland|london|manchester|ireland|germany|france|paris|italy|spain|portugal|netherlands|belgium|switzerland|zurich|geneva|sweden|norway|denmark|finland|poland|turkey|russia|ukraine|saudi|riyadh|jeddah|qatar|doha|oman|muscat|kuwait|bahrain|egypt|cairo|jordan|lebanon|israel|canada|toronto|vancouver|montreal|mexico|brazil|argentina|australia|sydney|melbourne|singapore|malaysia|indonesia|philippines|thailand|china|hong kong|japan|tokyo|korea|south africa|nigeria|kenya|lagos|nairobi/i;

/** Is the profile's location in the country we searched? "San Francisco Bay Area" is 'other' for the UAE. */
export function geoMatch(location: string, geo: Geo): Person['geoMatch'] {
  if (!location) return 'unknown';
  const here = geo === 'ae' ? UAE_PLACES : US_PLACES;
  if (here.test(location)) return 'match';
  const elsewhere = geo === 'ae' ? [US_PLACES, OTHER_PLACES] : [UAE_PLACES, OTHER_PLACES];
  return elsewhere.some((re) => re.test(location)) ? 'other' : 'unknown';
}

/** Turns one Serper result into a person, or null when it isn't a LinkedIn profile or has no name. */
export function parsePerson(result: SerperResult, geo: Geo): Person | null {
  const linkedin = canonicalProfileUrl(result.link ?? '');
  if (!linkedin) return null;
  const title = String(result.title ?? '').replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '');
  const [rawName, ...rest] = title.split(/\s+[-–—]\s+/);
  const name = (rawName ?? '').trim();
  if (!name) return null;

  const fromTitle = splitRoleAndCompany((rest[0] ?? '').split(/\s*\|\s*/)[0]);
  const sub = parseSubtitle(result.subtitle);
  // The title usually has the fuller role; Google's line under it is the profile's current job and has the whole company name.
  const useSubCompany = sub.company && (!fromTitle.company || fromTitle.companyTruncated);
  return {
    name,
    title: fromTitle.title || sub.title,
    company: useSubCompany ? sub.company : fromTitle.company,
    companyTruncated: useSubCompany ? false : fromTitle.companyTruncated,
    location: sub.location,
    geoMatch: geoMatch(sub.location, geo),
    linkedin,
    snippet: result.snippet ?? '',
  };
}

/** All people in a result list, one per profile (the same profile on two hosts counts once). */
export function parsePeople(results: SerperResult[], geo: Geo): Person[] {
  const byUrl = new Map<string, Person>();
  for (const r of results) {
    const p = parsePerson(r, geo);
    if (p && !byUrl.has(p.linkedin)) byUrl.set(p.linkedin, p);
  }
  return [...byUrl.values()];
}
