import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listSequences } from '../src/lib/apollo-sequences';
import type { Person } from '../src/lib/linkedin';
import { APOLLO_LABEL, fullEmail, outreachStatus, pushToApollo, sendTest, toApolloContact } from '../src/lib/outreach';
import { sequenceTemplate } from '../src/lib/pitch';
import type { Services } from '../src/lib/services';
import { savePeople, type Db } from '../src/lib/store';
import { TEST_ID, unsubscribeUrl } from '../src/lib/unsubscribe';

const FIELDS = [
  { id: 'f-subject', name: 'HOG Subject', modality: 'contact' },
  { id: 'f-opener', name: 'HOG Opener', modality: 'contact' },
  { id: 'f-unsub', name: 'HOG Unsubscribe link', modality: 'contact' },
];
const fieldIds = { subject: 'f-subject', opener: 'f-opener', unsubscribe: 'f-unsub' };

type ContactBody = { email: string; first_name?: string; last_name?: string; organization_name?: string; title?: string; label_names: string[]; typed_custom_fields: Record<string, string>; run_dedupe: boolean };

/** A fake Apollo. `skip` maps an email to the reason Apollo gives for not adding that contact to the sequence. */
function fakeApollo(opts: { fields?: typeof FIELDS; skip?: Record<string, string>; failAdd?: boolean; failContact?: string } = {}) {
  const contacts: ContactBody[] = [];
  const adds: URLSearchParams[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.pathname.endsWith('/typed_custom_fields')) return json({ typed_custom_fields: opts.fields ?? FIELDS });
    if (u.pathname.endsWith('/contacts')) {
      const body = JSON.parse(String(init.body)) as ContactBody;
      if (body.email === opts.failContact) return json({ error: 'Invalid email' }, 422);
      contacts.push(body);
      return json({ contact: { id: `c-${body.email}` } });
    }
    if (u.pathname.includes('/add_contact_ids')) {
      adds.push(u.searchParams);
      if (opts.failAdd) return json({ error: 'Rate limit exceeded' }, 429);
      const ids = u.searchParams.getAll('contact_ids[]');
      const skipped: Record<string, string> = {};
      for (const id of ids) {
        const reason = opts.skip?.[id.replace(/^c-/, '')];
        if (reason) skipped[id] = reason;
      }
      return json({ contacts: ids.filter((id) => !skipped[id]).map((id) => ({ id })), skipped_contact_ids: skipped });
    }
    if (u.pathname.endsWith('/emailer_campaigns/search')) {
      const page = Number(u.searchParams.get('page'));
      return json(
        page === 1
          ? { emailer_campaigns: [{ id: 's1', name: 'HoG invite', active: true }, { id: 's0', name: 'Old', archived: true }], pagination: { total_pages: 2 } }
          : { emailer_campaigns: [{ id: 's2', name: 'HoG follow-up', active: false }], pagination: { total_pages: 2 } },
      );
    }
    return json({ error: `unexpected ${u.pathname}` }, 404);
  }) as unknown as typeof fetch;
  const svc: Services = { fetch: f, keys: { serper: '', jina: '', deepseek: '', apollo: 'master-key' } };
  return { svc, contacts, adds };
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
async function seed(withEmail: Record<string, { size?: string; opener?: string | null }>, others: string[] = []) {
  const all = [...Object.keys(withEmail), ...others];
  await savePeople(db, all.map((s) => person(s, s.startsWith('cto') ? 'CTO' : 'Founder & CEO')), 'ae', 'q');
  for (const [slug, o] of Object.entries(withEmail)) {
    const opener = o.opener === null ? '' : (o.opener ?? `Your launch at ${slug}co this year caught our eye.`);
    await db.query(
      "UPDATE people SET email = $2, apollo_status = 'matched', company_size = $3, apollo_checked_at = now(), opener = $4, opener_status = $5 WHERE linkedin_url = $1",
      [`https://www.linkedin.com/in/${slug}`, `${slug}@${slug}co.com`, o.size ?? 'fit', opener, o.opener === null ? '' : 'done'],
    );
  }
}
const rowOf = async (slug: string) =>
  (
    await db.query<{ sequence_status: string; apollo_contact_id: string; apollo_sequence_id: string; sequence_note: string }>(
      'SELECT sequence_status, apollo_contact_id, apollo_sequence_id, sequence_note FROM people WHERE linkedin_url = $1',
      [`https://www.linkedin.com/in/${slug}`],
    )
  )[0];
const push = (svc: Services, extra: Partial<{ limit: number; dailyLimit: number }> = {}) => pushToApollo(svc, db, { sequenceId: 'seq-1', emailAccountId: 'mbox-1', limit: 10, ...extra });

describe('the Apollo contact and email', () => {
  it('puts the subject, opener and unsubscribe link in the custom fields', () => {
    const c = toApolloContact({ id: 7, name: 'Dr. Ahmed Al Sayed', title: 'CEO', company: 'Acme', email: 'a@acme.com', opener: 'Your Riyadh office caught our eye.' }, fieldIds);
    expect(c).toEqual({
      email: 'a@acme.com',
      first_name: 'Ahmed',
      last_name: 'Al Sayed',
      organization_name: 'Acme',
      title: 'CEO',
      label_names: [APOLLO_LABEL],
      typed_custom_fields: { 'f-subject': "Featuring Acme's leadership story", 'f-opener': 'Your Riyadh office caught our eye.', 'f-unsub': unsubscribeUrl(7) },
    });
  });

  it('never leaves the opener empty', () => {
    const c = toApolloContact({ id: 8, name: 'B C', title: 'Founder', company: 'Beta', email: 'b@beta.com', opener: '' }, fieldIds);
    expect(c.typed_custom_fields['f-opener']).toBe('Leading Beta as Founder puts you among the leaders our readers want to hear from.');
  });

  it('previews the email exactly as the sequence template renders it', () => {
    const e = fullEmail({ id: 7, name: 'Ahmed Al Sayed', title: 'CEO', company: 'Acme', email: 'a@acme.com', opener: 'Your Riyadh office caught our eye.' });
    const t = sequenceTemplate();
    const rendered = t.body
      .replace('{{#if first_name}}{{first_name}}{{#else}}there{{#endif}}', 'Ahmed')
      .replace('{{HOG Opener}}', 'Your Riyadh office caught our eye.')
      .replace('{{HOG Unsubscribe link}}', unsubscribeUrl(7));
    expect(e.body).toBe(rendered);
    expect(t.subject).toBe('{{HOG Subject}}');
  });
});

describe('listSequences', () => {
  it('reads every page and leaves out archived sequences', async () => {
    const { svc } = fakeApollo();
    expect((await listSequences(svc)).map((s) => s.id)).toEqual(['s1', 's2']);
  });
});

describe('pushToApollo', () => {
  it('creates personalized people as contacts and adds them to the sequence from the chosen mailbox, main people first', async () => {
    await seed({ cto1: {}, a: {}, small: { size: 'too_small' }, raw: { opener: null } }, ['noemail']);
    const { svc, contacts, adds } = fakeApollo();
    const summary = await push(svc);
    expect(contacts.map((c) => c.email)).toEqual(['a@aco.com', 'cto1@cto1co.com']); // not personalized, too small and no email are left out
    expect(contacts[0]).toMatchObject({ run_dedupe: true, label_names: [APOLLO_LABEL] });
    expect(contacts[0].typed_custom_fields['f-opener']).toBe('Your launch at aco this year caught our eye.');
    expect(adds[0].get('emailer_campaign_id')).toBe('seq-1');
    expect(adds[0].get('send_email_from_email_account_id')).toBe('mbox-1');
    expect(adds[0].getAll('contact_ids[]')).toEqual(['c-a@aco.com', 'c-cto1@cto1co.com']);
    expect(adds[0].get('sequence_active_in_other_campaigns')).toBe('false');
    expect(summary).toMatchObject({ requested: 2, added: 2, skipped: 0, failed: 0 });
    expect(await rowOf('a')).toEqual({ sequence_status: 'added', apollo_contact_id: 'c-a@aco.com', apollo_sequence_id: 'seq-1', sequence_note: '' });
    expect(await outreachStatus(db)).toMatchObject({ sent: 2, waiting: 0, toPersonalize: 1 });

    expect((await push(svc)).requested).toBe(0); // nobody twice
    expect(adds).toHaveLength(1);
  });

  it('marks people Apollo declines, with its reason, so they are not sent again', async () => {
    await seed({ a: {}, b: {} });
    const { svc } = fakeApollo({ skip: { 'b@bco.com': 'contacts_active_in_other_campaigns' } });
    const summary = await push(svc);
    expect(summary).toMatchObject({ added: 1, skipped: 1, reasons: { 'contacts active in other campaigns': 1 } });
    expect(await rowOf('b')).toMatchObject({ sequence_status: 'skipped', sequence_note: 'contacts active in other campaigns' });
  });

  it('keeps going when one contact cannot be created, and sends that person next time', async () => {
    await seed({ a: {}, b: {} });
    const { svc } = fakeApollo({ failContact: 'a@aco.com' });
    expect(await push(svc)).toMatchObject({ added: 1, failed: 1 });
    expect(await rowOf('a')).toMatchObject({ sequence_status: '' });
  });

  it('marks nobody when adding to the sequence fails, so the same people go next time', async () => {
    await seed({ a: {} });
    const { svc } = fakeApollo({ failAdd: true });
    await expect(push(svc)).rejects.toThrow('429');
    expect(await rowOf('a')).toMatchObject({ sequence_status: '', apollo_contact_id: 'c-a@aco.com' });
  });

  it('refuses to send while the custom fields are missing', async () => {
    await seed({ a: {} });
    const { svc, contacts } = fakeApollo({ fields: [FIELDS[0]] });
    await expect(push(svc)).rejects.toThrow('Create these custom contact fields in Apollo first: HOG Opener, HOG Unsubscribe link.');
    expect(contacts).toHaveLength(0);
  });

  it('needs a sequence and a mailbox', async () => {
    const { svc } = fakeApollo();
    await expect(pushToApollo(svc, db, { sequenceId: '', emailAccountId: 'm', limit: 1 })).rejects.toThrow('Choose an Apollo sequence first.');
    await expect(pushToApollo(svc, db, { sequenceId: 's', emailAccountId: '', limit: 1 })).rejects.toThrow('Choose the mailbox to send from first.');
  });

  it('stops at the daily limit', async () => {
    await seed({ a: {}, b: {}, c: {} });
    const { svc } = fakeApollo();
    expect((await push(svc, { dailyLimit: 2 })).requested).toBe(2);
    expect(await push(svc, { dailyLimit: 2 })).toMatchObject({ requested: 0, stopped: 'Daily limit of 2 people added to Apollo reached' });
  });
});

describe('sendTest', () => {
  it("sends a real lead's personalized email to the test address without touching the lead", async () => {
    await seed({ a: {} });
    const { svc, contacts, adds } = fakeApollo();
    expect(await sendTest(svc, db, { sequenceId: 'seq-1', emailAccountId: 'mbox-1', testEmail: 'me@team.com' })).toEqual({ added: true, reason: undefined });
    expect(contacts[0]).toMatchObject({ email: 'me@team.com', first_name: 'A', organization_name: 'Humans of Globe (test)' });
    expect(contacts[0].typed_custom_fields['f-unsub']).toBe(unsubscribeUrl(TEST_ID));
    expect(adds[0].getAll('contact_ids[]')).toEqual(['c-me@team.com']);
    expect(await rowOf('a')).toMatchObject({ sequence_status: '' });
  });

  it('refuses an invalid address', async () => {
    const { svc } = fakeApollo();
    await expect(sendTest(svc, db, { sequenceId: 's', emailAccountId: 'm', testEmail: 'nope' })).rejects.toThrow('Enter a valid test email address.');
  });
});
