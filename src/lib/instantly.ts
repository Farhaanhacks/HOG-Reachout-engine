import { getJson, type Services } from './services';

const BASE = 'https://api.instantly.ai/api/v2';

export type Campaign = { id: string; name: string; status: number };

/** Instantly's campaign status numbers. */
export const CAMPAIGN_STATUS: Record<string, string> = {
  '0': 'Draft',
  '1': 'Active',
  '2': 'Paused',
  '3': 'Completed',
  '4': 'Running subsequences',
  '-99': 'Account suspended',
  '-1': 'Accounts unhealthy',
  '-2': 'Bounce protect',
};

/** One lead as Instantly's bulk import takes it. Only these fields are allowed. */
export type InstantlyLead = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  job_title?: string;
  custom_variables?: Record<string, string>;
};

export type AddResult = {
  leads_uploaded: number;
  skipped_count: number;
  invalid_email_count: number;
  duplicated_leads: number;
  duplicate_email_count: number;
  in_blocklist: number;
  remaining_in_plan?: number;
  /** The leads Instantly created; `index` is the position in what we sent. */
  created_leads: { index: number; id: string; email: string }[];
};

function headers(svc: Services): Record<string, string> {
  const key = svc.keys.instantly;
  if (!key) throw new Error('INSTANTLY_API_KEY is not set');
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' };
}

/** Every campaign in the workspace (up to 500), newest first as Instantly returns them. */
export async function listCampaigns(svc: Services): Promise<Campaign[]> {
  const out: Campaign[] = [];
  let after = '';
  for (let page = 0; page < 5; page++) {
    const url = `${BASE}/campaigns?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`;
    const res = await getJson<{ items?: Campaign[]; next_starting_after?: string }>(svc, url, { headers: headers(svc) });
    const items = Array.isArray(res.items) ? res.items : [];
    out.push(...items.map((c) => ({ id: String(c.id), name: String(c.name ?? ''), status: Number(c.status) })));
    if (!res.next_starting_after || !items.length) break;
    after = res.next_starting_after;
  }
  return out;
}

/**
 * Adds leads to a campaign (Instantly takes at most 1,000 per request). By default anyone already anywhere in the
 * Instantly workspace is skipped, so nobody is added twice; a test send turns that off.
 */
export async function addLeads(svc: Services, campaignId: string, leads: InstantlyLead[], opts: { skipIfInWorkspace?: boolean } = {}): Promise<AddResult> {
  if (!campaignId) throw new Error('Choose an Instantly campaign first.');
  const total: AddResult = { leads_uploaded: 0, skipped_count: 0, invalid_email_count: 0, duplicated_leads: 0, duplicate_email_count: 0, in_blocklist: 0, created_leads: [] };
  for (let i = 0; i < leads.length; i += 1000) {
    const chunk = leads.slice(i, i + 1000);
    const res = await getJson<Partial<AddResult>>(svc, `${BASE}/leads/add`, {
      method: 'POST',
      headers: headers(svc),
      body: JSON.stringify({ campaign_id: campaignId, leads: chunk, skip_if_in_workspace: opts.skipIfInWorkspace ?? true }),
    });
    total.leads_uploaded += Number(res.leads_uploaded) || 0;
    total.skipped_count += Number(res.skipped_count) || 0;
    total.invalid_email_count += Number(res.invalid_email_count) || 0;
    total.duplicated_leads += Number(res.duplicated_leads) || 0;
    total.duplicate_email_count += Number(res.duplicate_email_count) || 0;
    total.in_blocklist += Number(res.in_blocklist) || 0;
    if (res.remaining_in_plan != null) total.remaining_in_plan = Number(res.remaining_in_plan);
    for (const c of res.created_leads ?? []) total.created_leads.push({ index: Number(c.index) + i, id: String(c.id), email: String(c.email ?? '') });
  }
  return total;
}
