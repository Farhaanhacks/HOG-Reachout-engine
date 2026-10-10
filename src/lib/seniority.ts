export type Seniority = 'founder' | 'c_suite' | 'owner' | 'partner' | 'vp' | 'director' | 'other';

/** The order a person's main label is chosen in when they hold several ("Founder & CEO" is a founder first). */
const ORDER: Seniority[] = ['founder', 'c_suite', 'owner', 'partner', 'vp', 'director'];

/** The labels this campaign targets. */
export const TARGET_LABELS: Seniority[] = ['founder', 'c_suite', 'owner', 'partner'];

export type TitleTag = {
  labels: Seniority[];
  /** The main label, or 'other'. */
  seniority: Seniority;
  /** Search words for an email finder or Apollo: acronym and long form ("CTO", "Chief Technology Officer"). */
  keywords: string[];
  /** A fund's decision maker: managing partner, portfolio manager, CIO and the like, at a fund-like company. */
  fundPrincipal: boolean;
  /** False for "Former CEO", "Assistant to the CEO", "Chief of Staff": not the person to write to. */
  current: boolean;
  isTarget: boolean;
};

// "Former CEO" or "Ex-Founder" at the start, or "former" right before a role. "Founder & CEO, ex-Google" is still a founder.
const NOT_THE_PERSON = /^\s*(former|past|ex|retired|aspiring|future)\b[\s-]|\bformer\s+(?=ceo|coo|cfo|cto|cio|chief|founder|co-?founder|president|partner|owner|managing|chairman)|\bemeritus\b|\bassistant to\b|\bexecutive assistant\b|\bchief of staff\b|\badvisor to\b/i;
const VICE_PRESIDENT = /\b(?:(?:executive|senior|associate|assistant|regional|group)\s+)?vice[- ]president\b/gi;
const FUND_COMPANY = /capital|fund|asset management|investments?|hedge|equity|ventures|wealth|family office|partners|advisors|holdings/i;

// [acronym, long form, pattern]
const C_ROLES: [string, string, RegExp][] = [
  ['CEO', 'Chief Executive Officer', /\b(ceo|chief executive( officer)?)\b/i],
  ['CFO', 'Chief Financial Officer', /\b(cfo|chief financial( officer)?)\b/i],
  ['COO', 'Chief Operating Officer', /\b(coo|chief operating( officer)?)\b/i],
  ['CTO', 'Chief Technology Officer', /\b(cto|chief technology( officer)?)\b/i],
  ['CIO', 'Chief Investment Officer', /\b(cio|chief investment( officer)?)\b/i],
  ['CIO', 'Chief Information Officer', /\b(cio|chief information( officer)?)\b/i],
  ['CMO', 'Chief Marketing Officer', /\b(cmo|chief marketing( officer)?)\b/i],
  ['CRO', 'Chief Revenue Officer', /\b(cro|chief revenue( officer)?)\b/i],
  ['CSO', 'Chief Strategy Officer', /\b(cso|chief strategy( officer)?)\b/i],
  ['CPO', 'Chief Product Officer', /\b(cpo|chief product( officer)?)\b/i],
  ['CHRO', 'Chief Human Resources Officer', /\b(chro|chief human resources?( officer)?)\b/i],
];

const unique = (list: string[]) => [...new Set(list)];

/** Reads a job title into seniority labels and search keywords. Pure text rules, no AI. */
export function tagTitle(rawTitle: string, company = ''): TitleTag {
  const title = String(rawTitle ?? '').trim();
  const empty: TitleTag = { labels: [], seniority: 'other', keywords: [], fundPrincipal: false, current: true, isTarget: false };
  if (!title) return empty;
  if (NOT_THE_PERSON.test(title)) return { ...empty, current: false };

  const t = title.replace(VICE_PRESIDENT, ' VP ');
  const noManagingDirector = t.replace(/\bmanaging director\b/gi, ' ');
  const found = new Set<Seniority>();
  const keywords: string[] = [];

  if (/\b(co-?founder|founder|founding (partner|member|ceo|director))\b/i.test(t)) {
    found.add('founder');
    keywords.push(/co-?founder/i.test(t) ? 'Co-Founder' : 'Founder');
  }
  for (const [acronym, long, re] of C_ROLES) {
    if (re.test(t)) {
      found.add('c_suite');
      keywords.push(acronym, long);
    }
  }
  if (/\bchief (?!of staff)[a-z]/i.test(t) || /\b(president|chairman|chairwoman|chairperson)\b/i.test(t) || /\bmanaging director\b/i.test(t)) {
    found.add('c_suite');
    if (/\bpresident\b/i.test(t)) keywords.push('President');
    if (/\bchair(man|woman|person)\b/i.test(t)) keywords.push('Chairman');
    if (/\bmanaging director\b/i.test(t)) keywords.push('Managing Director');
  }
  if (/\b(owner|proprietor|co-?owner)\b/i.test(t)) {
    found.add('owner');
    keywords.push('Owner');
  }
  if (/\bpartner\b(?!\s+(manager|success|development|marketing|alliances?|programs?|engineer|account|sales|solutions))/i.test(t)) {
    found.add('partner');
    keywords.push(/managing partner/i.test(t) ? 'Managing Partner' : 'Partner');
  }
  if (/\b(vp|svp|evp|avp)\b/i.test(t)) found.add('vp');
  if (/\b(director|head of)\b/i.test(noManagingDirector)) found.add('director');

  const labels = ORDER.filter((l) => found.has(l));
  const fundPrincipal =
    labels.some((l) => l === 'partner' || l === 'c_suite' || l === 'founder') &&
    /\b(managing partner|general partner|founding partner|portfolio manager|chief investment officer|cio|principal|chairman|founder)\b/i.test(t) &&
    FUND_COMPANY.test(company);

  return {
    labels,
    seniority: labels[0] ?? 'other',
    keywords: unique(keywords),
    fundPrincipal,
    current: true,
    isTarget: labels.some((l) => TARGET_LABELS.includes(l)),
  };
}
