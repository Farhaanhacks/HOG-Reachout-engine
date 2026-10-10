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
  /** The role or company was guessed from the result's description text, not read from its title: check it. */
  inferred: boolean;
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
  text = text.replace(/\s*(\.\.\.|…)\s*$/, '').replace(/\s*\([^)]*\)\s*$/, ''); // "TENDERD (YC S18)" is "TENDERD"
  // "Dubai Holding and the Chief Executive Officer of …" is the company "Dubai Holding" followed by a second role.
  text = text.replace(/\s+(?:and|&)\s+(?:the\s+)?(?:chief|ceo|cfo|coo|cto|founder|co-?founder|managing|president|chairman|director|head|partner)\b.*$/i, '');
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

/** "Jason English (CEO,YPO)" is the name "Jason English" with the hint "CEO,YPO". Degrees after a comma are dropped. */
export function splitName(raw: string): { name: string; hint: string } {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(raw.trim());
  const base = (m ? m[1] : raw).replace(/,\s*(mba|phd|cfa|cpa|fca|dba|msc|mphil)\b.*$/i, '').trim();
  return { name: base, hint: m ? m[2] : '' };
}

/** The job words in a name hint: "CEO,YPO" gives "CEO". */
function roleFromHint(hint: string): string {
  return hint.split(/[,/&]/).map((p) => p.trim()).filter((p) => p && p.length <= 40 && JOB_WORD.test(p)).slice(0, 2).join(' & ');
}

const PLACE_ONLY = /^(greater\s+)?(dubai|abu dhabi|sharjah|ajman|ras al[- ]khaimah|fujairah|umm al[- ]quwain|united arab emirates|uae|new york( city)?|san francisco|los angeles|miami|chicago|boston|austin|houston|dallas|seattle|atlanta|denver|san diego|united states|usa)(\s+bay)?(\s+metropolitan)?(\s+area)?$/i;

/** Is the whole text just a place ("Dubai", "Dubai, United Arab Emirates")? "Dubai Technologies" is not. */
export function placeOnly(text: string): boolean {
  const base = text.trim().replace(/\s*,\s*(united arab emirates|uae|united states|usa|[a-z ]{2,20})$/i, '');
  return PLACE_ONLY.test(base);
}

/** Words that describe a person, so a piece made of them is not a company name. */
const NOT_A_COMPANY = /^(entrepreneur|investor|author|speaker|advisor|adviser|consultant|student|professional|leader|expert|coach|mentor|engineer|architect|lawyer|doctor|specialist|freelancer|executive|manager|director)s?\b/i;

/** A piece of a title that looks like a company name: short, capitalised, not a role, a place or a sentence. */
function looksLikeCompany(piece: string): boolean {
  const p = piece.trim();
  if (!p || p.length > 60 || !/^[A-Z0-9]/.test(p)) return false;
  if (p.split(/\s+/).length > 6 || JOB_WORD.test(p) || placeOnly(p) || NOT_A_COMPANY.test(p)) return false;
  return !/\d+\+?\s*years/i.test(p);
}

const ROLE_PHRASE = String.raw`(?:co-?founder|founder|ceo|chief [a-z-]+(?: [a-z-]+)? officer|managing (?:partner|director)|chairman|president|owner)`;
const SNIPPET_ROLE = new RegExp(String.raw`\b(${ROLE_PHRASE}(?:\s+(?:and|&)\s+${ROLE_PHRASE})?)\s+(?:of|at|@)\s+([^,.;|·\n]{2,45})`, 'i');

/** A role and company stated in the description ("… co-founder of CG Tech, a company that …"). Used only when the title lacks them. */
export function roleFromSnippet(snippet: string): { title: string; company: string } {
  const m = SNIPPET_ROLE.exec(snippet);
  if (!m || !/^[A-Z0-9]/.test(m[2].trim())) return { title: '', company: '' };
  return { title: m[1].trim(), company: cleanCompany(m[2]).company };
}

/** A location stated in the description: "Location: Dubai, United Arab Emirates" or "Dubai, United Arab Emirates". */
export function locationFromSnippet(snippet: string): string {
  const labelled = /location:\s*([^·|.\n]{2,60})/i.exec(snippet);
  if (labelled) return labelled[1].trim();
  const named = /\b([A-Z][A-Za-z.'-]+(?:\s[A-Z][A-Za-z.'-]+){0,2},\s*(?:United Arab Emirates|UAE|United States|USA))\b/.exec(snippet);
  return named ? named[1].trim() : '';
}

/** Turns one Serper result into a person, or null when it isn't a LinkedIn profile or has no name. */
export function parsePerson(result: SerperResult, geo: Geo): Person | null {
  const linkedin = canonicalProfileUrl(result.link ?? '');
  if (!linkedin) return null;
  const title = String(result.title ?? '').replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '');
  const [rawName, ...rest] = title.split(/\s+[-–—]\s+/);
  const { name, hint } = splitName(rawName ?? '');
  if (!name) return null;
  const snippet = result.snippet ?? '';

  // Every piece of the title after the name, split on " - " and " | ": the role may be the second or third piece
  // ("Name - Long headline | Founder & CEO | SAP & Cloud"), and a place or a company may stand alone.
  const pieces = rest.flatMap((s) => s.split(/\s*\|\s*/)).map((p) => p.trim()).filter(Boolean);
  let fromTitle = { title: '', company: '', companyTruncated: false };
  let placeInTitle = '';
  let lonelyCompany = '';
  pieces.forEach((piece, i) => {
    if (placeOnly(piece)) {
      placeInTitle ||= piece;
      return;
    }
    const s = splitRoleAndCompany(piece);
    if (s.title && !fromTitle.title) fromTitle = s;
    // "Name - Company | LinkedIn": a piece with no role counts as the company only when it comes first ("| MBA" does not).
    else if (!s.title && i === 0 && looksLikeCompany(piece)) lonelyCompany = cleanCompany(piece).company;
  });
  if (!fromTitle.title) fromTitle.title = roleFromHint(hint);

  const sub = parseSubtitle(result.subtitle);
  const subCompany = sub.company ? cleanCompany(sub.company).company : '';
  // The title usually has the fuller role; Google's line under it is the profile's current job and has the whole company name.
  const useSubCompany = !!subCompany && (!fromTitle.company || fromTitle.companyTruncated);
  let titleOut = fromTitle.title || sub.title;
  let company = useSubCompany ? subCompany : fromTitle.company || lonelyCompany;
  let inferred = false;
  if (!titleOut || !company) {
    const s = roleFromSnippet(snippet);
    if (!titleOut && s.title) {
      titleOut = s.title;
      inferred = true;
    }
    if (!company && s.company) {
      company = s.company;
      inferred = true;
    }
  }

  const location = sub.location || placeInTitle || locationFromSnippet(snippet);
  return {
    name,
    title: titleOut,
    company,
    companyTruncated: useSubCompany || !fromTitle.company ? false : fromTitle.companyTruncated,
    location,
    geoMatch: geoMatch(location, geo),
    linkedin,
    snippet,
    inferred,
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
