import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listSequences } from '../src/lib/apollo-sequences';
import type { Person } from '../src/lib/linkedin';
import { APOLLO_LABEL, fullEmail, outreachStatus, pushToApollo, sendTest, toApolloContact } from '../src/lib/outreach';
import { sequenceTemplate } from '../src/lib/pitch';
import type { Services } from '../src/lib/services';
import { savePeople, type Db } from '../src/lib/store';
import { importSuppression } from '../src/lib/suppression';
import { TEST_ID, unsubscribeUrl } from '../src/lib/unsubscribe';

const FIELDS = [
  { id: 'f-subject', name: 'HOG Subject', modality: 'contact' },
  { id: 'f-opener', name: 'HOG Opener', modality: 'contact' },
  { id: 'f-unsub', name: 'HOG Unsubscribe link', modality: 'contact' },
  { id: 'f-edition', name: 'HOG Edition', modality: 'contact' },
  { id: 'f-industry', name: 'HOG Industry', modality: 'contact' },
];
const fieldIds = { subject: 'f-subject', opener: 'f-opener', unsubscribe: 'f-unsub', edition: 'f-edition', industry: 'f-industry' };

/** Six inboxes on two domains, like the team's. */
const ACCOUNTS = [
  { id: 'a1', email: 'ava@hog-one.com', active: true },
  { id: 'a2', email: 'ben@hog-one.com', active: true },
  { id: 'a3', email: 'cat@hog-one.com', active: true },
  { id: 'b1', email: 'dan@hog-two.com', active: true },
  { id: 'b2', email: 'eve@hog-two.com', active: true },
  { id: 'b3', email: 'fay@hog-two.com', active: true },
];

type ContactBody = { email: string; first_name?: string; last_name?: string; organization_name?: string; title?: string; label_names: string[]; typed_custom_fields: Record<string, string>; run_dedupe: boolean };

/** A fake Apollo. `skip` maps an email to the reason Apollo gives for not adding that contact to the sequence. */
function fakeApollo(opts: { fields?: typeof FIELDS; skip?: Record<string, string>; failAdd?: boolean; failContact?: string; accounts?: typeof ACCOUNTS; messages?: unknown[] } = {}) {
  const contacts: ContactBody[] = [];
  const adds: URLSearchParams[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.pathname.endsWith('/typed_custom_fields')) return json({ typed_custom_fields: opts.fields ?? FIELDS });
    if (u.pathname.endsWith('/email_accounts')) return json({ email_accounts: opts.accounts ?? ACCOUNTS });
    if (u.pathname.endsWith('/emailer_messages/search')) return json({ emailer_messages: u.searchParams.get('page') === '1' ? (opts.messages ?? []) : [] });
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
  await pg.exec(
    'DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS outreach_log; DROP TABLE IF EXISTS enrichment_log; DROP TABLE IF EXISTS suppression; DROP TABLE IF EXISTS settings; DROP TABLE IF EXISTS mailboxes; DROP TABLE IF EXISTS messages',
  );
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

type SeedOpts = { opener?: string | null; emailStatus?: string; fit?: boolean; industry?: string };

/** Saves people and gives each a verified Apollo email (unless told otherwise) and a personal opener (unless `opener` is null). */
async function seed(withEmail: Record<string, SeedOpts>, others: string[] = []) {
  const all = [...Object.keys(withEmail), ...others];
  await savePeople(db, all.map((s) => person(s, s.startsWith('cto') ? 'CTO' : 'Founder & CEO')), 'af', 'q');
  for (const [slug, o] of Object.entries(withEmail)) {
    const opener = o.opener === null ? '' : (o.opener ?? `Your launch at ${slug}co this year caught our eye.`);
    await db.query(
      `UPDATE people SET email = $2, email_status = $3, apollo_status = 'matched', apollo_checked_at = now(), opener = $4, opener_status = $5,
         icp_fit = $6, industry = $7 WHERE linkedin_url = $1`,
      [`https://www.linkedin.com/in/${slug}`, `${slug}@${slug}co.com`, o.emailStatus ?? 'verified', opener, o.opener === null ? '' : 'done', o.fit ?? null, o.industry ?? ''],
    );
  }
}
const rowOf = async (slug: string) =>
  (
    await db.query<{ sequence_status: string; apollo_contact_id: string; apollo_sequence_id: string; sequence_note: string; sent_from: string; sent_from_email: string }>(
      'SELECT sequence_status, apollo_contact_id, apollo_sequence_id, sequence_note, sent_from, sent_from_email FROM people WHERE linkedin_url = $1',
      [`https://www.linkedin.com/in/${slug}`],
    )
  )[0];
const push = (svc: Services, extra: Partial<{ limit: number; dailyLimit: number }> = {}) => pushToApollo(svc, db, { sequenceId: 'seq-1', limit: 25, ...extra });

describe('the Apollo contact and email', () => {
  it('puts the subject, opener, edition, industry line and unsubscribe link in the custom fields', () => {
    const c = toApolloContact(
      { id: 7, name: 'Dr. Ahmed Al Sayed', title: 'CEO', company: 'Acme', email: 'a@acme.com', opener: 'Your Riyadh office caught our eye.', industry: 'hospital & health care' },
      fieldIds,
    );
    expect(c).toEqual({
      email: 'a@acme.com',
      first_name: 'Ahmed',
      last_name: 'Al Sayed',
      organization_name: 'Acme',
      title: 'CEO',
      label_names: [APOLLO_LABEL],
      typed_custom_fields: {
        'f-subject': "Featuring Acme's leadership story",
        'f-opener': 'Your Riyadh office caught our eye.',
        'f-unsub': unsubscribeUrl(7),
        'f-edition': 'Healthcare Leaders Edition',
        'f-industry': 'Healthcare Leaders',
      },
    });
  });

  it('never leaves the opener empty, and gives leads of an unknown industry the general edition', () => {
    const c = toApolloContact({ id: 8, name: 'B C', title: 'Founder', company: 'Beta', email: 'b@beta.com', opener: '' }, fieldIds);
    expect(c.typed_custom_fields['f-opener']).toBe('Leading Beta as Founder puts you among the leaders our readers want to hear from.');
    expect(c.typed_custom_fields['f-edition']).toBe('Global Leaders Edition');
  });

  it('previews the email exactly as the sequence template renders it', () => {
    const e = fullEmail({ id: 7, name: 'Ahmed Al Sayed', title: 'CEO', company: 'Acme', email: 'a@acme.com', opener: 'Your Riyadh office caught our eye.', industry: 'computer & network security' });
    const t = sequenceTemplate();
    const rendered = t.body
      .replace('{{#if first_name}}{{first_name}}{{#else}}there{{#endif}}', 'Ahmed')
      .replace('{{HOG Opener}}', 'Your Riyadh office caught our eye.')
      .replace('{{HOG Edition}}', 'Cybersecurity Leaders Edition')
      .replace('{{HOG Industry}}', 'Cybersecurity Leaders')
      .replace('{{HOG Unsubscribe link}}', unsubscribeUrl(7));
    expect(e.body).toBe(rendered);
    expect(t.subject).toBe('{{HOG Subject}}');
  });
});

describe('price and unsubscribe styles', () => {
  it('states the USD 2,500 cover price in every email', () => {
    const e = fullEmail({ id: 7, name: 'A B', title: 'CEO', company: 'Acme', email: 'a@acme.com', opener: 'Your Riyadh office caught our eye.' });
    expect(e.body).toContain('A cover feature, with your story on the cover of the edition, is USD 2,500.');
    expect(sequenceTemplate().body).toContain('USD 2,500');
  });

  it("ends with Apollo's opt-out line, a reply-to-unsubscribe line with no link, or the engine's own link", () => {
    expect(sequenceTemplate('apollo').body.endsWith('{{opt_out_message}}')).toBe(true);
    const reply = sequenceTemplate('reply').body;
    expect(reply).toContain('just reply "unsubscribe"');
    expect(reply).not.toMatch(/https?:|\{\{HOG Unsubscribe link\}\}/);
    expect(sequenceTemplate('link').body).toContain('{{HOG Unsubscribe link}}');
    const p = { id: 7, name: 'A B', title: 'CEO', company: 'Acme', email: 'a@acme.com', opener: 'x.' };
    expect(fullEmail(p, { style: 'reply' }).body).not.toContain('http');
  });
});

describe('listSequences', () => {
  it('reads every page and leaves out archived sequences', async () => {
    const { svc } = fakeApollo();
    expect((await listSequences(svc)).map((s) => s.id)).toEqual(['s1', 's2']);
  });
});

describe('pushToApollo', () => {
  it('sends only verified, target, personalized people, main people first, and only verified emails are sequenced', async () => {
    await seed({ cto1: {}, a: {}, unverified: { emailStatus: 'guessed' }, wrong: { fit: false }, raw: { opener: null } }, ['noemail']);
    const { svc, contacts, adds } = fakeApollo();
    const summary = await push(svc);
    expect(contacts.map((c) => c.email).sort()).toEqual(['a@aco.com', 'cto1@cto1co.com']);
    expect(contacts[0]).toMatchObject({ run_dedupe: true, label_names: [APOLLO_LABEL] });
    expect(adds.every((a) => a.get('sequence_unverified_email') === 'false' && a.get('sequence_active_in_other_campaigns') === 'false')).toBe(true);
    expect(summary).toMatchObject({ requested: 2, added: 2, skipped: 0, failed: 0 });
    expect(await rowOf('a')).toMatchObject({ sequence_status: 'added', apollo_contact_id: 'c-a@aco.com', apollo_sequence_id: 'seq-1', sequence_note: '' });
    expect(await outreachStatus(db)).toMatchObject({ sent: 2, waiting: 0, toPersonalize: 1, notSendable: 2 });

    expect((await push(svc)).requested).toBe(0); // nobody twice
  });

  it('takes turns across the inboxes, switching domain each time, and records who sent to whom', async () => {
    await seed({ a: {}, b: {}, c: {}, d: {} });
    const { svc, adds } = fakeApollo();
    const summary = await push(svc);
    expect(adds.map((a) => a.get('send_email_from_email_account_id'))).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(Object.keys(summary.byInbox).sort()).toEqual(['ava@hog-one.com', 'ben@hog-one.com', 'dan@hog-two.com', 'eve@hog-two.com']);
    const senders = await db.query<{ sent_from_email: string }>("SELECT sent_from_email FROM people WHERE sequence_status = 'added' ORDER BY sent_from_email");
    expect(senders.map((s) => s.sent_from_email.split('@')[1])).toEqual(['hog-one.com', 'hog-one.com', 'hog-two.com', 'hog-two.com']);
  });

  it('keeps each inbox within its warm-up limit for the day', async () => {
    // A new inbox may send 20 emails on day one; at 3 emails per person that is 6 new people.
    await seed(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, {}])));
    const { svc } = fakeApollo({ accounts: [ACCOUNTS[0]] });
    expect((await push(svc)).added).toBe(6);
    expect(await push(svc)).toMatchObject({ requested: 0, stopped: expect.stringContaining("Today's sending limit is used up") });
  });

  it('stops at the overall daily limit', async () => {
    await seed({ a: {}, b: {}, c: {} });
    const { svc } = fakeApollo();
    expect((await push(svc, { dailyLimit: 2 })).added).toBe(2);
    expect((await push(svc, { dailyLimit: 2 })).requested).toBe(0);
  });

  it('never sends to anyone on the suppression list, even if they were found before it was imported', async () => {
    await seed({ a: {}, b: {}, c: {} });
    await importSuppression(db, [{ email: 'a@aco.com' }], 'contacted');
    await importSuppression(db, [{ website: 'https://www.bco.com/about', company: 'Bco Ltd' }], 'client');
    const { svc, contacts } = fakeApollo();
    await push(svc);
    expect(contacts.map((c) => c.email)).toEqual(['c@cco.com']);
    expect(await outreachStatus(db)).toMatchObject({ sent: 1, waiting: 0 });
  });

  it('pauses an inbox whose emails bounce, before giving it anyone new', async () => {
    await seed({ a: {}, b: {} });
    // ava@hog-one.com: 30 emails sent, 3 bounced (10%).
    const messages = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, email_account_id: 'a1', from_email: 'ava@hog-one.com', completed_at: new Date().toISOString(), bounce: i < 3 }));
    await db.query("UPDATE people SET apollo_sequence_id = 'seq-1' WHERE linkedin_url LIKE '%/b'");
    const { svc, adds } = fakeApollo({ messages, accounts: ACCOUNTS.slice(0, 2) });
    const summary = await push(svc);
    expect(summary.paused).toEqual([{ email: 'ava@hog-one.com', reason: expect.stringContaining('10.0% bounced') }]);
    expect(adds.map((a) => a.get('send_email_from_email_account_id'))).toEqual(['a2']);
  });

  it('marks people Apollo declines, with its reason, so they are not sent again', async () => {
    await seed({ a: {}, b: {} });
    const { svc } = fakeApollo({ skip: { 'b@bco.com': 'contacts_active_in_other_campaigns' } });
    const summary = await push(svc);
    expect(summary).toMatchObject({ added: 1, skipped: 1, reasons: { 'contacts active in other campaigns': 1 } });
    expect(await rowOf('b')).toMatchObject({ sequence_status: 'skipped', sequence_note: 'contacts active in other campaigns', sent_from: '' });
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
    expect(await push(svc)).toMatchObject({ added: 0, failed: 1, error: expect.stringContaining('429') });
    expect(await rowOf('a')).toMatchObject({ sequence_status: '', apollo_contact_id: 'c-a@aco.com' });
  });

  it('refuses to send while the custom fields are missing', async () => {
    await seed({ a: {} });
    const { svc, contacts } = fakeApollo({ fields: FIELDS.slice(0, 3) });
    await expect(push(svc)).rejects.toThrow('Create these custom contact fields in Apollo first: HOG Edition, HOG Industry.');
    expect(contacts).toHaveLength(0);
  });

  it('needs a sequence and an inbox', async () => {
    await seed({ a: {} });
    await expect(pushToApollo(fakeApollo().svc, db, { sequenceId: '', limit: 1 })).rejects.toThrow('Choose an Apollo sequence first.');
    expect(await push(fakeApollo({ accounts: [] }).svc)).toMatchObject({ requested: 0, stopped: expect.stringContaining('No inbox can send') });
  });
});

describe('sendTest', () => {
  it("sends a real lead's personalized email to the test address without touching the lead", async () => {
    await seed({ a: {} });
    const { svc, contacts, adds } = fakeApollo();
    expect(await sendTest(svc, db, { sequenceId: 'seq-1', emailAccountId: 'b2', testEmail: 'me@team.com' })).toEqual({ added: true, reason: undefined, from: 'eve@hog-two.com' });
    expect(contacts[0]).toMatchObject({ email: 'me@team.com', first_name: 'A', organization_name: 'Humans of Globe (test)' });
    expect(contacts[0].typed_custom_fields['f-unsub']).toBe(unsubscribeUrl(TEST_ID));
    expect(adds[0].getAll('contact_ids[]')).toEqual(['c-me@team.com']);
    expect(adds[0].get('sequence_unverified_email')).toBe('true'); // the team's own address need not be verified
    expect(await rowOf('a')).toMatchObject({ sequence_status: '' });
  });

  it('refuses an invalid address', async () => {
    const { svc } = fakeApollo();
    await expect(sendTest(svc, db, { sequenceId: 's', testEmail: 'nope' })).rejects.toThrow('Enter a valid test email address.');
  });
});

describe('subject', () => {
  it('writes the possessive correctly for names ending in s', async () => {
    const { subjectFor } = await import('../src/lib/pitch');
    expect(subjectFor('DAMAC Properties')).toBe("Featuring DAMAC Properties' leadership story");
    expect(subjectFor('Acme')).toBe("Featuring Acme's leadership story");
  });
});
