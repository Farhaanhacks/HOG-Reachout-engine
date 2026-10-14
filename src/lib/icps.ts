import { EUROPE } from './markets';
import { firmSize, matchTitle, type LeadCheck } from './targeting';

/**
 * The five ideal customer profiles leads are found for (from 15 Oct 2026). Each is searched per region in two steps:
 * Apollo's company search for companies tagged with one of these keywords, of this size, in these countries; then People
 * Search for people there with one of these titles and seniorities. Every run is split equally between them. Africa keeps the earlier size-and-industry title rules
 * (Targeting page) and goes to Humans of Globe only.
 */
export type Icp = {
  id: string;
  label: string;
  /** Apollo company keyword tags; a company with any of them matches. */
  keywords: string[];
  titles: string[];
  /** Apollo seniority filter. */
  seniorities: string[];
  employees: [number, number];
  countries: string[];
  /** Edition the lead is pitched for when the news research names none ("{year}" is the current year). */
  edition: string;
  industryLine: string;
};

const US = 'United States';
const UK = 'United Kingdom';
const GERMANY = 'Germany';
const UAE = 'United Arab Emirates';
const SAUDI = 'Saudi Arabia';
const SINGAPORE = 'Singapore';
const OWNER_FOUNDER_CSUITE = ['owner', 'founder', 'c_suite'];

export const ICPS: Icp[] = [
  {
    id: 'channel',
    label: 'Enterprise software channel partners',
    keywords: [
      'IT services', 'IT consulting', 'systems integrator', 'AWS partner', 'Oracle partner', 'NetSuite partner', 'HubSpot partner', 'Salesforce partner',
      'SAP partner', 'Microsoft partner', 'IBM partner', 'Odoo partner', 'Siemens partner', 'Databricks partner',
    ],
    titles: ['Founder', 'CEO', 'Managing Director', 'Partner', 'Chief Executive', 'Owner'],
    seniorities: [...OWNER_FOUNDER_CSUITE, 'partner'],
    employees: [11, 200],
    countries: [US, UK, GERMANY, UAE, SAUDI],
    edition: 'Top Enterprise Technology Partners to Watch in {year}',
    industryLine: 'Enterprise Technology Leaders',
  },
  {
    id: 'cyber',
    label: 'Cybersecurity companies',
    keywords: ['cybersecurity', 'information security', 'network security', 'cloud security'],
    titles: ['Founder', 'CEO', 'CISO', 'CTO', 'Owner'],
    seniorities: OWNER_FOUNDER_CSUITE,
    employees: [11, 200],
    countries: [US, UK, GERMANY, UAE],
    edition: 'Top Cybersecurity Leaders to Watch in {year}',
    industryLine: 'Cybersecurity Leaders',
  },
  {
    id: 'ai',
    label: 'AI companies',
    keywords: ['artificial intelligence', 'generative AI', 'machine learning', 'data science'],
    titles: ['Founder', 'CEO', 'CTO', 'Chief AI Officer', 'Owner'],
    seniorities: OWNER_FOUNDER_CSUITE,
    employees: [11, 200],
    countries: [US, ...EUROPE, UAE],
    edition: 'Top AI Innovators to Watch in {year}',
    industryLine: 'AI Leaders',
  },
  {
    id: 'health',
    label: 'HealthTech and life sciences',
    keywords: ['healthtech', 'digital health', 'medical devices', 'biotech', 'pharmaceuticals', 'hospital'],
    titles: ['Founder', 'CEO', 'Chief Medical Officer', 'Chief Innovation Officer', 'Owner'],
    seniorities: OWNER_FOUNDER_CSUITE,
    employees: [11, 500],
    countries: [US, ...EUROPE, UAE],
    edition: 'Top HealthTech and Life Sciences Leaders to Watch in {year}',
    industryLine: 'HealthTech & Life Sciences Leaders',
  },
  {
    id: 'fintech',
    label: 'Banking and fintech technology',
    keywords: ['fintech', 'banking technology', 'payments', 'financial software'],
    titles: ['Founder', 'CEO', 'CTO', 'Chief Product Officer', 'Owner'],
    seniorities: OWNER_FOUNDER_CSUITE,
    employees: [11, 500],
    countries: [US, UK, GERMANY, SINGAPORE, UAE],
    edition: 'Top Fintech Players to Look Out For in {year}',
    industryLine: 'Fintech Leaders',
  },
];

/** The lane for Africa: the earlier title rules, Humans of Globe only. */
export const AFRICA_LANE = 'africa';
/** Africa's share of each run, on top of the ICPs' equal shares (which fill the rest). */
export const AFRICA_SHARE = 0.1;

export function icpById(id: string | null | undefined): Icp | undefined {
  return ICPS.find((i) => i.id === id);
}

/** The ICP a lead was found for, from its saved segment (the ICP's label). */
export function icpByLabel(label: string | null | undefined): Icp | undefined {
  return ICPS.find((i) => i.label === label);
}

/**
 * The most leads each lane may take in a run of `target`: every ICP an equal fifth (rounded up), Africa a tenth. The caps
 * add up to a little more than the target, so the brand split can still be met when one lane runs short.
 */
export function laneCaps(target: number): Record<string, number> {
  const caps: Record<string, number> = Object.fromEntries(ICPS.map((i) => [i.id, Math.ceil(target / ICPS.length)]));
  caps[AFRICA_LANE] = Math.max(1, Math.round(target * AFRICA_SHARE));
  return caps;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Whether a looked-up lead fits the ICP they were found for: a wanted title, the company size, one of its countries. */
export function checkIcpLead(icp: Icp, lead: { title: string; employees?: number | null; country?: string | null }): LeadCheck {
  const matched = matchTitle(lead.title, icp.titles);
  const size = firmSize(lead.employees);
  const [lo, hi] = icp.employees;
  const base = { sector: 'general' as const, size, wanted: icp.titles, matched };
  if (!matched) return { ...base, fit: false, reason: `${lead.title || 'No title'} is not a target title for ${icp.label} (wants ${icp.titles.join(', ')})` };
  if (lead.employees && (lead.employees < lo || lead.employees > hi)) {
    return { ...base, fit: false, reason: `${lead.employees} employees, outside ${lo}–${hi} for ${icp.label}` };
  }
  if (lead.country && !icp.countries.some((c) => norm(c) === norm(lead.country ?? ''))) {
    return { ...base, fit: false, reason: `Based in ${lead.country}, outside the countries for ${icp.label}` };
  }
  return { ...base, fit: true, reason: '' };
}
