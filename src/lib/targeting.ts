/**
 * Who to target at each company, from the client brief: the title depends on the company's size and industry, so every
 * lead's industry and employee count are read and the title is picked from these rules, not from one flat list.
 *
 *  - Small firms (up to 50 employees): Owner, CEO, Founder.
 *  - Large firms: Managing Director, President and similar senior titles (CEO, Chairman, Managing Partner).
 *  - Healthcare: Chief Medical Officer, plus the CEO or Managing Director depending on size.
 *  - Hospitality: General Manager, plus the Owner or Managing Director depending on size.
 *
 * The team can change every list on the Targeting page; these are the defaults.
 */

export const SMALL_MAX_EMPLOYEES = 50;

export type FirmSize = 'small' | 'large' | 'unknown';
export type Sector = 'healthcare' | 'hospitality' | 'general';
export type SizeTitles = { small: string[]; large: string[] };
export type TitleRules = Record<Sector, SizeTitles> & { sectorKeywords: Record<Exclude<Sector, 'general'>, string[]> };

export const DEFAULT_RULES: TitleRules = {
  general: {
    small: ['Owner', 'CEO', 'Founder', 'Co-Founder'],
    large: ['Managing Director', 'President', 'CEO', 'Chairman', 'Managing Partner'],
  },
  healthcare: {
    small: ['Chief Medical Officer', 'CEO'],
    large: ['Chief Medical Officer', 'Managing Director', 'CEO', 'President'],
  },
  hospitality: {
    small: ['General Manager', 'Owner'],
    large: ['General Manager', 'Managing Director', 'CEO', 'President'],
  },
  // Words in Apollo's industry name that put a company in the sector.
  sectorKeywords: {
    healthcare: ['hospital', 'health care', 'healthcare', 'medical', 'pharmaceutical', 'biotechnology', 'mental health', 'clinic', 'dental', 'veterinary'],
    hospitality: ['hospitality', 'hotel', 'restaurant', 'leisure, travel', 'tourism', 'resort'],
  },
};

export const SECTORS: Sector[] = ['general', 'healthcare', 'hospitality'];
export const SECTOR_LABEL: Record<Sector, string> = { general: 'All other industries', healthcare: 'Healthcare', hospitality: 'Hospitality' };

export function firmSize(employees: number | null | undefined): FirmSize {
  if (!employees || employees <= 0) return 'unknown';
  return employees <= SMALL_MAX_EMPLOYEES ? 'small' : 'large';
}

/**
 * Whether an industry name contains a keyword at the start of a word. Hospitality is always checked before healthcare,
 * since "hospitality" begins with "hospital".
 */
export function industryHas(industry: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return false;
  return new RegExp(`(?:^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(industry.toLowerCase());
}

export function sectorOf(industry: string | null | undefined, rules: TitleRules = DEFAULT_RULES): Sector {
  const i = (industry ?? '').toLowerCase();
  if (!i) return 'general';
  for (const s of ['hospitality', 'healthcare'] as const) if (rules.sectorKeywords[s].some((k) => industryHas(i, k))) return s;
  return 'general';
}

/** The titles to target for a sector and size; with the size unknown, either list. */
export function titlesFor(rules: TitleRules, sector: Sector, size: FirmSize): string[] {
  const t = rules[sector];
  return size === 'unknown' ? [...new Set([...t.small, ...t.large])] : t[size];
}

const VICE_PRESIDENT = /\b(?:(?:executive|senior|associate|assistant|regional|group)\s+)?vice[- ]president\b/gi;
/** Not the person to write to: former holders, assistants, chiefs of staff. */
const NOT_THE_PERSON = /^\s*(former|past|ex|retired|aspiring|future)\b[\s-]|\bformer\s+\w|\bemeritus\b|\bassistant to\b|\bexecutive assistant\b|\bchief of staff\b|\badvisor to\b|\bpersonal assistant\b/i;
/** Words that make a title a step below the one named: Deputy General Manager, Assistant Managing Director. */
const BELOW = /(deputy|assistant|associate|vice|sub|junior|trainee)[\s-]+$/i;

/** How each well-known title is written in practice. Other titles match on their own words. */
const PATTERNS: Record<string, RegExp> = {
  ceo: /\b(ceo|chief executive(?: officer)?)\b/i,
  'chief executive officer': /\b(ceo|chief executive(?: officer)?)\b/i,
  founder: /\b(co-?founder|founder|founding (?:partner|director|ceo|member))\b/i,
  'co-founder': /\b(co-?founder|founder)\b/i,
  owner: /\b(owner|co-?owner|proprietor)\b/i,
  'managing director': /\bmanaging director\b/i,
  president: /\bpresident\b/i,
  chairman: /\b(chairman|chairwoman|chairperson|chair)\b/i,
  'managing partner': /\bmanaging partner\b/i,
  'chief medical officer': /\b(chief medical officer|chief medical|cmo)\b/i,
  'general manager': /\b(general manager|gm)\b/i,
};

function patternFor(title: string): RegExp {
  const key = title.trim().toLowerCase();
  if (PATTERNS[key]) return PATTERNS[key];
  const words = key.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b${words.join('\\s+')}\\b`, 'i');
}

/** The first wanted title this job title is, or '' when it is none of them. "Founder & CEO" is a Founder and a CEO. */
export function matchTitle(rawTitle: string | null | undefined, wanted: string[]): string {
  const title = String(rawTitle ?? '').trim();
  if (!title || NOT_THE_PERSON.test(title)) return '';
  const t = title.replace(VICE_PRESIDENT, ' VP ');
  for (const w of wanted) {
    const re = new RegExp(patternFor(w).source, 'gi');
    for (let m = re.exec(t); m; m = re.exec(t)) {
      if (BELOW.test(t.slice(0, m.index))) continue;
      // "CMO" at a healthcare company is its Chief Medical Officer, never its Chief Marketing Officer.
      if (w.toLowerCase() === 'chief medical officer' && /marketing/i.test(t)) continue;
      return w;
    }
  }
  return '';
}

export type LeadCheck = {
  fit: boolean;
  sector: Sector;
  size: FirmSize;
  /** The titles this company calls for. */
  wanted: string[];
  /** Which of them the person holds. */
  matched: string;
  /** Why they are not a fit, in plain words. */
  reason: string;
};

/** Reads one lead's industry and company size, picks the titles to target there, and checks the person holds one. */
export function checkLead(lead: { title: string; industry?: string | null; employees?: number | null }, rules: TitleRules = DEFAULT_RULES): LeadCheck {
  const sector = sectorOf(lead.industry, rules);
  const size = firmSize(lead.employees);
  const wanted = titlesFor(rules, sector, size);
  const matched = matchTitle(lead.title, wanted);
  const where = `${size === 'unknown' ? '' : `${size} `}${sector === 'general' ? (lead.industry ? `${lead.industry} company` : 'company') : `${SECTOR_LABEL[sector].toLowerCase()} company`}`;
  return { fit: !!matched, sector, size, wanted, matched, reason: matched ? '' : `${lead.title || 'No title'} is not a target title at a ${where} (wants ${wanted.join(', ')})` };
}

/** Lists of titles typed by the team: trimmed, no blanks or repeats, at most 20. */
export function cleanTitles(list: unknown): string[] {
  const items = Array.isArray(list) ? list : String(list ?? '').split(',');
  return [...new Set(items.map((t) => String(t).replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 20);
}

/** Rules sent from the Targeting page, with anything missing or empty taken from the defaults. */
export function cleanRules(input: unknown): TitleRules {
  const r = (input ?? {}) as Partial<Record<Sector, Partial<SizeTitles>>> & { sectorKeywords?: Partial<Record<string, unknown>> };
  const out = structuredClone(DEFAULT_RULES);
  for (const s of SECTORS) {
    for (const size of ['small', 'large'] as const) {
      const titles = cleanTitles(r[s]?.[size]);
      if (titles.length) out[s][size] = titles;
    }
  }
  for (const s of ['healthcare', 'hospitality'] as const) {
    const words = cleanTitles(r.sectorKeywords?.[s]).map((w) => w.toLowerCase());
    if (words.length) out.sectorKeywords[s] = words;
  }
  return out;
}

/**
 * The edition a lead is pitched for, by industry: the edition title and the industry line in the email ("Cybersecurity
 * Leaders") change per segment, so they go into each contact's own fields instead of being written into the template.
 */
export type Edition = { segment: string; keywords: string[]; edition: string; industryLine: string };

export const DEFAULT_EDITIONS: Edition[] = [
  { segment: 'Hospitality', keywords: ['hospitality', 'hotel', 'restaurant', 'leisure, travel', 'tourism', 'resort'], edition: 'Hospitality Leaders Edition', industryLine: 'Hospitality Leaders' },
  { segment: 'Healthcare', keywords: ['hospital', 'health care', 'healthcare', 'medical', 'pharmaceutical', 'biotechnology', 'mental health', 'clinic', 'dental'], edition: 'Healthcare Leaders Edition', industryLine: 'Healthcare Leaders' },
  { segment: 'Cybersecurity', keywords: ['computer & network security', 'cyber', 'security'], edition: 'Cybersecurity Leaders Edition', industryLine: 'Cybersecurity Leaders' },
  { segment: 'Technology', keywords: ['software', 'information technology', 'internet', 'computer', 'telecommunications', 'artificial intelligence'], edition: 'Technology Leaders Edition', industryLine: 'Technology Leaders' },
  { segment: 'Finance', keywords: ['financial', 'banking', 'investment', 'insurance', 'capital markets', 'venture capital', 'accounting'], edition: 'Finance Leaders Edition', industryLine: 'Finance Leaders' },
  { segment: 'Real estate', keywords: ['real estate', 'construction', 'architecture', 'building materials'], edition: 'Real Estate Leaders Edition', industryLine: 'Real Estate Leaders' },
  { segment: 'Energy', keywords: ['oil & energy', 'renewables', 'energy', 'utilities', 'mining'], edition: 'Energy Leaders Edition', industryLine: 'Energy Leaders' },
  { segment: 'Education', keywords: ['education', 'e-learning', 'higher education'], edition: 'Education Leaders Edition', industryLine: 'Education Leaders' },
  { segment: 'Media and marketing', keywords: ['marketing', 'advertising', 'media', 'public relations', 'entertainment'], edition: 'Media & Marketing Leaders Edition', industryLine: 'Media & Marketing Leaders' },
  { segment: 'Retail and consumer', keywords: ['retail', 'consumer', 'apparel', 'fashion', 'cosmetics', 'food & beverages'], edition: 'Consumer Brands Leaders Edition', industryLine: 'Consumer Brand Leaders' },
  { segment: 'Logistics', keywords: ['logistics', 'transportation', 'maritime', 'airlines', 'automotive'], edition: 'Logistics & Mobility Leaders Edition', industryLine: 'Logistics & Mobility Leaders' },
  { segment: 'Professional services', keywords: ['management consulting', 'legal', 'law practice', 'staffing', 'human resources'], edition: 'Professional Services Leaders Edition', industryLine: 'Professional Services Leaders' },
];

/** Used when no segment's keywords match the lead's industry. */
export const FALLBACK_EDITION: Edition = { segment: 'Business', keywords: [], edition: 'Global Leaders Edition', industryLine: 'Business Leaders' };

/** The first segment whose keywords appear in the lead's industry, in table order. */
export function editionFor(industry: string | null | undefined, editions: Edition[] = DEFAULT_EDITIONS): Edition {
  const i = (industry ?? '').toLowerCase();
  if (i) for (const e of editions) if (e.keywords.some((k) => industryHas(i, k))) return e;
  return editions.find((e) => !e.keywords.length) ?? FALLBACK_EDITION;
}

export function cleanEditions(input: unknown): Edition[] {
  if (!Array.isArray(input)) return DEFAULT_EDITIONS;
  const out = input
    .map((e) => {
      const x = (e ?? {}) as Partial<Record<keyof Edition, unknown>>;
      return {
        segment: String(x.segment ?? '').trim().slice(0, 60),
        keywords: cleanTitles(x.keywords).map((k) => k.toLowerCase()),
        edition: String(x.edition ?? '').trim().slice(0, 120),
        industryLine: String(x.industryLine ?? '').trim().slice(0, 120),
      };
    })
    .filter((e) => e.segment && e.edition && e.industryLine)
    .slice(0, 50);
  return out.length ? out : DEFAULT_EDITIONS;
}
