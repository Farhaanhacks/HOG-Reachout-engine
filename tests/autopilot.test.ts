import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setAutopilot, tick } from '../src/lib/autopilot';
import type { Services } from '../src/lib/services';
import { saveSettings } from '../src/lib/settings';
import type { Db } from '../src/lib/store';

let pg: PGlite;
let db: Db;
beforeAll(() => {
  pg = new PGlite();
});
beforeEach(async () => {
  await pg.exec(
    'DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS searched_queries; DROP TABLE IF EXISTS enrichment_log; DROP TABLE IF EXISTS outreach_log; DROP TABLE IF EXISTS settings; DROP TABLE IF EXISTS mailboxes; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS locks; DROP TABLE IF EXISTS suppression',
  );
  db = { query: async (text, params = []) => (await pg.query(text, params as unknown[])).rows as never };
});

const FIELDS = ['HOG Subject', 'HOG Opener', 'HOG Role', 'HOG Edition', 'HOG Industry', 'HOG Sender', 'HOG Unsubscribe link'].map((name, i) => ({ id: `f${i}`, name, modality: 'contact' }));

/** Every outside service the autopilot touches: Apollo (search, lookups, contacts, sequences), Serper news and DeepSeek. */
function fakeWorld() {
  const added: { inbox: string; ids: string[] }[] = [];
  const country = (id: string) => ({ g: 'United Arab Emirates', u: 'United States', e: 'Germany' })[id[0]] ?? 'Nigeria';
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname.endsWith('/mixed_people/api_search')) {
      const where = u.searchParams.getAll('person_locations[]');
      const prefix = where.includes('United Arab Emirates') ? 'g' : where.includes('United States') ? 'u' : where.includes('Germany') ? 'e' : 'a';
      const page = u.searchParams.get('page');
      return json({ people: Array.from({ length: 50 }, (_, i) => ({ id: `${prefix}${page}-${i}`, first_name: 'X', title: 'CEO', organization: { name: `${prefix}${page}co${i}` }, has_email: true })) });
    }
    if (u.pathname.endsWith('/people/bulk_match')) {
      const ids = (JSON.parse(String(init.body)) as { details: { id: string }[] }).details.map((d) => d.id);
      return json({
        credits_consumed: ids.length,
        matches: ids.map((id) => ({
          id,
          name: `P ${id}`,
          title: 'CEO',
          email: `${id}@${id}co.com`,
          email_status: 'verified',
          country: country(id),
          organization: { name: `${id}co`, industry: 'information technology & services', estimated_num_employees: 20 },
        })),
      });
    }
    if (u.hostname === 'google.serper.dev') return json({ news: [] });
    if (u.hostname === 'api.deepseek.com') {
      return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ achievement: '', edition: '', fact_used: '' }) } }] });
    }
    if (u.pathname.endsWith('/typed_custom_fields')) return json({ typed_custom_fields: FIELDS });
    if (u.pathname.endsWith('/email_accounts')) return json({ email_accounts: [{ id: 'h1', email: 'ava@humansofglobe.com', active: true }] });
    if (u.pathname.endsWith('/emailer_messages/search')) return json({ emailer_messages: [] });
    if (u.pathname.endsWith('/contacts')) return json({ contact: { id: `c-${(JSON.parse(String(init.body)) as { email: string }).email}` } });
    if (u.pathname.includes('/add_contact_ids')) {
      const ids = u.searchParams.getAll('contact_ids[]');
      added.push({ inbox: u.searchParams.get('send_email_from_email_account_id') ?? '', ids });
      return json({ contacts: ids.map((id) => ({ id })), skipped_contact_ids: {} });
    }
    return new Response(JSON.stringify({ error: `unexpected ${u.hostname}${u.pathname}` }), { status: 404 });
  }) as unknown as typeof fetch;
  const svc: Services = { fetch: f, keys: { serper: 's', jina: '', deepseek: 'd', apollo: 'master' } };
  return { svc, added };
}

describe('autopilot', () => {
  it('does nothing while switched off', async () => {
    expect(await tick(fakeWorld().svc, db)).toMatchObject({ ran: false, reason: 'Autopilot is off' });
  });

  it("finds the hour's leads, writes their emails and sends each brand with a sequence, over as many ticks as it takes", async () => {
    const { svc, added } = fakeWorld();
    await setAutopilot(db, { enabled: true, perHour: 10 });
    await saveSettings(db, { sequences: { hog: 'seq-hog' } }); // only Humans of Globe has a sequence so far
    let last = await tick(svc, db, { budgetMs: 60_000 });
    for (let i = 0; i < 10 && last.phase !== 'done'; i++) last = await tick(svc, db, { budgetMs: 60_000 });
    expect(last.phase).toBe('done');
    const [run] = await db.query<{ auto: boolean; status: string; brand_ready: string; apollo_with_email: number }>('SELECT auto, status, brand_ready, apollo_with_email FROM runs');
    expect(run).toMatchObject({ auto: true, status: 'done', apollo_with_email: 10 });
    expect(JSON.parse(run.brand_ready)).toEqual({ gulficons: 4, hog: 3, ciominds: 3 });
    // Humans of Globe's 3 went out from its own inbox; the other brands' leads wait for their sequences.
    expect(added.flatMap((a) => a.ids)).toHaveLength(3);
    expect(added.every((a) => a.inbox === 'h1')).toBe(true);
    const waiting = await db.query<{ brand: string; n: number }>("SELECT brand, count(*)::int AS n FROM people WHERE sequence_status = '' AND opener_status = 'done' GROUP BY brand ORDER BY brand");
    expect(waiting).toEqual([{ brand: 'ciominds', n: 3 }, { brand: 'gulficons', n: 4 }]);

    // The same hour does not start a second run.
    expect(await tick(svc, db)).toMatchObject({ ran: true, reason: expect.stringContaining("This hour's run is finished") });
    expect(await db.query('SELECT 1 FROM runs')).toHaveLength(1);
  });

  it('never lets two scheduler calls work at once', async () => {
    await setAutopilot(db, { enabled: true });
    await tick(fakeWorld().svc, db, { budgetMs: 1 }); // creates the tables
    await db.query("INSERT INTO locks (name, until) VALUES ('autopilot', now() + interval '1 minute') ON CONFLICT (name) DO UPDATE SET until = EXCLUDED.until");
    expect(await tick(fakeWorld().svc, db)).toMatchObject({ ran: false, reason: 'Another tick is still working' });
  });
});
