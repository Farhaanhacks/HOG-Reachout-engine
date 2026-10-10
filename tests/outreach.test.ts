import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listCampaigns } from '../src/lib/instantly';
import type { Person } from '../src/lib/linkedin';
import { outreachStatus, pushToInstantly, sendTest, toInstantlyLead } from '../src/lib/outreach';
import type { Services } from '../src/lib/services';
import { savePeople, type Db } from '../src/lib/store';

type Call = { url: string; method: string; headers: Record<string, string>; body: { campaign_id?: string; leads?: { email: string; first_name?: string; custom_variables?: Record<string, string> }[]; skip_if_in_workspace?: boolean } | null };

/** A fake Instantly: `addReply` answers /leads/add; campaigns come in two pages. */
function fakeInstantly(addReply: (leads: { email: string }[]) => unknown, status = 200) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init.method ?? 'GET', headers, body });
    if (status !== 200) return new Response(JSON.stringify({ message: 'Too many requests' }), { status });
    if (url.includes('/campaigns')) {
      const second = url.includes('starting_after=c2');
      return new Response(JSON.stringify(second ? { items: [{ id: 'c3', name: 'Three', status: 2 }] } : { items: [{ id: 'c1', name: 'One', status: 1 }, { id: 'c2', name: 'Two', status: 0 }], next_starting_after: 'c2' }), { status: 200 });
    }
    return new Response(JSON.stringify(addReply(body.leads)), { status: 200 });
  }) as unknown as typeof fetch;
  const svc: Services = { fetch: f, keys: { serper: '', jina: '', deepseek: '', instantly: 'inst-key' } };
  return { svc, calls };
}

let pg: PGlite;
let db: Db;
beforeAll(() => {
  pg = new PGlite();
});
beforeEach(async () => {
  await pg.exec('DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS outreach_log; DROP TABLE IF EXISTS enrichment_log');
  db = { query: async (text, params = []) => (await pg.query(text, params as unknown[])).rows as never };
});

const person = (slug: string, title = 'Founder & CEO'): Person => ({
  name: `${slug.toUpperCase()} Person`,
  title,
  company: `${slug}co`,
  companyTruncated: false,
  location: 'Dubai',
  geoMatch: 'match',
  linkedin: `https://www.linkedin.com/in/${slug}`,
  snippet: '',
  inferred: false,
});

/** Saves people and gives some of them an Apollo email and (unless `opener` is null) a personal opener. */
async function seed(withEmail: Record<string, { status?: string; size?: string; opener?: string | null }>, others: string[] = []) {
  const all = [...Object.keys(withEmail), ...others];
  await savePeople(db, all.map((s) => person(s, s.startsWith('cto') ? 'CTO' : 'Founder & CEO')), 'ae', 'q');
  for (const [slug, o] of Object.entries(withEmail)) {
    const opener = o.opener === null ? '' : (o.opener ?? `Your launch at ${slug}co this year caught our eye.`);
    await db.query(
      'UPDATE people SET email = $2, apollo_status = $3, company_size = $4, apollo_checked_at = now(), opener = $5, opener_status = $6 WHERE linkedin_url = $1',
      [`https://www.linkedin.com/in/${slug}`, `${slug}@${slug}co.com`, o.status ?? 'matched', o.size ?? 'fit', opener, o.opener === null ? '' : 'done'],
    );
  }
}
const statusOf = async (slug: string) =>
  (await db.query<{ instantly_status: string; instantly_lead_id: string }>('SELECT instantly_status, instantly_lead_id FROM people WHERE linkedin_url = $1', [`https://www.linkedin.com/in/${slug}`]))[0];

describe('toInstantlyLead', () => {
  it('carries the name, company, title and the draft as custom variables', () => {
    const lead = toInstantlyLead({ name: 'Dr. Ahmed Al Sayed', title: 'CEO', company: 'Acme', email: 'a@acme.com', linkedin_url: 'https://www.linkedin.com/in/a', geo: 'ae' });
    expect(lead).toMatchObject({ email: 'a@acme.com', first_name: 'Ahmed', last_name: 'Al Sayed', company_name: 'Acme', job_title: 'CEO' });
    expect(lead.custom_variables?.subject).toBe("Featuring Acme's leadership story");
    expect(lead.custom_variables?.body.startsWith('Hi Ahmed,')).toBe(true);
    expect(lead.custom_variables?.body_html).toContain('Hi Ahmed,<br><br>');
    expect(lead.custom_variables?.country).toBe('UAE');
  });
});

describe('listCampaigns', () => {
  it('reads every page with the bearer key', async () => {
    const { svc, calls } = fakeInstantly(() => ({}));
    expect((await listCampaigns(svc)).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(calls[0].headers.authorization).toBe('Bearer inst-key');
    expect(calls).toHaveLength(2);
  });
});

describe('pushToInstantly', () => {
  it('sends only personalized people', async () => {
    await seed({ a: {}, raw: { opener: null } });
    const { svc, calls } = fakeInstantly((leads) => ({ created_leads: leads.map((l, index) => ({ index, id: `L${index}`, email: l.email })) }));
    await pushToInstantly(svc, db, { campaignId: 'camp-1', limit: 10 });
    expect(calls[0].body!.leads!.map((l) => l.email)).toEqual(['a@aco.com']);
    expect(calls[0].body!.leads![0].custom_variables?.body).toContain('Your launch at aco this year caught our eye.');
    expect(await outreachStatus(db)).toMatchObject({ waiting: 0, toPersonalize: 1, sent: 1 });
  });

  it('sends people with an email ready, main people first, and marks what Instantly did', async () => {
    await seed({ cto1: {}, a: {}, b: { status: 'low_confidence' }, small: { size: 'too_small' } }, ['noemail']);
    const { svc, calls } = fakeInstantly((leads) => ({
      leads_uploaded: 2,
      skipped_count: 1,
      remaining_in_plan: 900,
      created_leads: [
        { index: 0, id: 'L0', email: leads[0].email },
        { index: 2, id: 'L2', email: leads[2].email },
      ],
    }));

    const summary = await pushToInstantly(svc, db, { campaignId: 'camp-1', limit: 10 });
    const sent = calls[0].body!;
    expect(sent.campaign_id).toBe('camp-1');
    expect(sent.skip_if_in_workspace).toBe(true);
    expect(sent.leads!.map((l) => l.email)).toEqual(['a@aco.com', 'b@bco.com', 'cto1@cto1co.com']); // main people first; too small and no email left out
    expect(summary).toMatchObject({ requested: 3, added: 2, skipped: 1, remainingInPlan: 900 });
    expect(await statusOf('a')).toEqual({ instantly_status: 'added', instantly_lead_id: 'L0' });
    expect(await statusOf('b')).toMatchObject({ instantly_status: 'skipped' });
    expect(await statusOf('small')).toMatchObject({ instantly_status: '' });

    const again = await pushToInstantly(svc, db, { campaignId: 'camp-1', limit: 10 });
    expect(again.requested).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('stops at the daily limit', async () => {
    await seed({ a: {}, b: {}, c: {} });
    const { svc } = fakeInstantly((leads) => ({ created_leads: leads.map((l, index) => ({ index, id: `L${index}`, email: l.email })) }));
    expect((await pushToInstantly(svc, db, { campaignId: 'camp-1', limit: 10, dailyLimit: 2 })).requested).toBe(2);
    expect(await pushToInstantly(svc, db, { campaignId: 'camp-1', limit: 10, dailyLimit: 2 })).toMatchObject({ requested: 0, stopped: 'Daily limit of 2 leads sent to Instantly reached' });
    expect(await outreachStatus(db, 2)).toMatchObject({ waiting: 1, sent: 2, sentToday: 2 });
  });

  it('marks nobody when Instantly fails, so the same people go next time', async () => {
    await seed({ a: {} });
    const { svc } = fakeInstantly(() => ({}), 429);
    await expect(pushToInstantly(svc, db, { campaignId: 'camp-1', limit: 10 })).rejects.toThrow('429');
    expect(await statusOf('a')).toMatchObject({ instantly_status: '' });
  });

  it('needs a campaign', async () => {
    await seed({ a: {} });
    const { svc } = fakeInstantly(() => ({}));
    await expect(pushToInstantly(svc, db, { campaignId: '', limit: 10 })).rejects.toThrow('Choose an Instantly campaign first.');
  });
});

describe('sendTest', () => {
  it("sends a real lead's draft to the test address without touching the lead", async () => {
    await seed({ a: {} });
    const { svc, calls } = fakeInstantly((leads) => ({ created_leads: [{ index: 0, id: 'T', email: leads[0].email }] }));
    expect(await sendTest(svc, db, { campaignId: 'camp-1', testEmail: 'me@team.com' })).toMatchObject({ added: true });
    const lead = calls[0].body!.leads![0];
    expect(lead.email).toBe('me@team.com');
    expect(lead.first_name).toBe('A');
    expect(calls[0].body!.skip_if_in_workspace).toBe(false);
    expect(await statusOf('a')).toMatchObject({ instantly_status: '' });
  });

  it('refuses an invalid address', async () => {
    const { svc } = fakeInstantly(() => ({}));
    await expect(sendTest(svc, db, { campaignId: 'camp-1', testEmail: 'nope' })).rejects.toThrow('Enter a valid test email address.');
  });
});
