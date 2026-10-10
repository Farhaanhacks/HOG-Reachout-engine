import type { Services } from './services';
import type { CompanyFacts } from './size';
import { getJson } from './services';

/** What we know about a person, used to ask Apollo who they are. */
export type ApolloInput = { linkedin?: string; name?: string; company?: string; domain?: string };

export type ApolloMatch = {
  /** '' when Apollo found the person but has no email. */
  email: string;
  /** Apollo's own rating, e.g. "verified". Only "verified" is safe to send to. */
  emailStatus: string;
  /** high, medium, low or none: how sure Apollo is it matched the right person. */
  confidence: string;
  title: string;
  company: string;
  linkedin: string;
  /** Size facts about the person's company, when Apollo returned its organization. */
  org?: CompanyFacts;
};

type ApolloPerson = {
  email?: string | null;
  email_status?: string | null;
  match_confidence?: string | null;
  title?: string | null;
  linkedin_url?: string | null;
  organization?: {
    name?: string | null;
    estimated_num_employees?: number | string | null;
    annual_revenue?: number | string | null;
    total_funding?: number | string | null;
    publicly_traded_symbol?: string | null;
  } | null;
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

type BulkResponse = { matches?: (ApolloPerson | null)[]; credits_consumed?: number | string };

const BULK_URL = 'https://api.apollo.io/api/v1/people/bulk_match';
/** Apollo takes at most ten people per bulk request. */
export const BATCH_SIZE = 10;

/** "Jason English" gives first "Jason", last "English"; one-word names give only a first name. */
export function splitFullName(name: string): { first_name?: string; last_name?: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  return parts.length === 1 ? { first_name: parts[0] } : { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

/** One entry of Apollo's `details` array. Only identifying fields are sent, never reveal or waterfall options (those cost extra credits). */
export function toDetail(input: ApolloInput): Record<string, string> {
  const detail: Record<string, string> = {};
  if (input.linkedin) detail.linkedin_url = input.linkedin;
  Object.assign(detail, input.name ? splitFullName(input.name) : {});
  if (input.company) detail.organization_name = input.company;
  if (input.domain) detail.domain = input.domain;
  return detail;
}

/** Apollo returns placeholders like "email_not_unlocked@domain.com" for emails it did not reveal: those are not emails. */
export function usableEmail(email: string | null | undefined): string {
  const e = (email ?? '').trim();
  return e && /@/.test(e) && !/email_not_unlocked|not_unlocked/i.test(e) ? e : '';
}

export function parseMatch(p: ApolloPerson | null | undefined): ApolloMatch | null {
  if (!p) return null;
  return {
    email: usableEmail(p.email),
    emailStatus: p.email_status ?? '',
    confidence: p.match_confidence ?? '',
    title: p.title ?? '',
    company: p.organization?.name ?? '',
    linkedin: p.linkedin_url ?? '',
    org: p.organization
      ? {
          employees: num(p.organization.estimated_num_employees),
          revenue: num(p.organization.annual_revenue),
          funding: num(p.organization.total_funding),
          publicCompany: !!p.organization.publicly_traded_symbol,
        }
      : undefined,
  };
}

export type BulkResult = { matches: (ApolloMatch | null)[]; credits: number };

/**
 * Looks people up in Apollo, ten per request, one request at a time. Returns one result per input in the same order
 * (null = no match). Credits are reported as Apollo states them. Throws on an HTTP error (bad key, rate limit, no credits),
 * naming how many people were done, so the caller can keep what was finished.
 */
export async function bulkMatch(svc: Services, inputs: ApolloInput[]): Promise<BulkResult> {
  const key = svc.keys.apollo;
  if (!key) throw new Error('APOLLO_API_KEY is not set');
  const matches: (ApolloMatch | null)[] = [];
  let credits = 0;
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const chunk = inputs.slice(i, i + BATCH_SIZE);
    let res: BulkResponse;
    try {
      res = await getJson<BulkResponse>(svc, BULK_URL, {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json', 'cache-control': 'no-cache' },
        body: JSON.stringify({ details: chunk.map(toDetail) }),
      });
    } catch (e) {
      const err = new Error(`Apollo: ${(e as Error).message} (${matches.length} of ${inputs.length} people done)`);
      (err as Error & { partial?: BulkResult }).partial = { matches, credits };
      throw err;
    }
    credits += Number(res.credits_consumed ?? 0) || 0;
    const got = Array.isArray(res.matches) ? res.matches : [];
    for (let j = 0; j < chunk.length; j++) matches.push(parseMatch(got[j]));
  }
  return { matches, credits };
}
