import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allocate, autoPause, checkDomain, emailsToday, guessSenderName, mailboxStates, newPeopleToday, pauseReason, senderNameOf, updateMailbox, type MailboxState } from '../src/lib/deliverability';
import type { Services } from '../src/lib/services';
import { saveSettings } from '../src/lib/settings';
import { savePeople, type Db } from '../src/lib/store';
import { importSuppression, suppressedReason, suppressionStatus } from '../src/lib/suppression';
import { breakdown, replies, syncMessages, totals } from '../src/lib/tracking';

let pg: PGlite;
let db: Db;
beforeAll(() => {
  pg = new PGlite();
});
beforeEach(async () => {
  await pg.exec('DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS suppression; DROP TABLE IF EXISTS settings; DROP TABLE IF EXISTS mailboxes; DROP TABLE IF EXISTS messages');
  db = { query: async (text, params = []) => (await pg.query(text, params as unknown[])).rows as never };
});

const health = { sent: 0, bounced: 0, spam: 0, replied: 0, opened: 0, unsubscribed: 0, bounceRate: 0, spamRate: 0 };
const box = (id: string, domain: string, room: number): MailboxState =>
  ({ id, email: `${id}@${domain}`, domain, usable: room > 0, room, health } as unknown as MailboxState);

describe('sender names', () => {
  it('guesses a name from the address until the team sets one', () => {
    expect(guessSenderName('zoya.farah@ciominds.com')).toBe('Zoya Farah');
    expect(guessSenderName('john@humansofglobe.com')).toBe('John');
    expect(guessSenderName('info2@x.com')).toBe('');
    expect(senderNameOf({ email: 'john@humansofglobe.com', sender_name: ' John Cooper ' })).toBe('John Cooper');
    expect(senderNameOf({ email: '123@x.com', sender_name: '' })).toBe('The editorial team');
  });
});

describe('warm-up and rotation', () => {
  it('starts each inbox at 20 a day and adds 3 a day up to its limit', () => {
    expect(emailsToday({ max_per_day: 50, ramp: true, ramp_days: 0 })).toBe(20);
    expect(emailsToday({ max_per_day: 50, ramp: true, ramp_days: 5 })).toBe(35);
    expect(emailsToday({ max_per_day: 50, ramp: true, ramp_days: 30 })).toBe(50);
    expect(emailsToday({ max_per_day: 80, ramp: false, ramp_days: 0 })).toBe(80);
    expect(newPeopleToday(50, 3)).toBe(16);
  });

  it('switches domain every time and stops at each inbox’s room', () => {
    const boxes = [box('a1', 'one.com', 2), box('a2', 'one.com', 1), box('b1', 'two.com', 3), box('x', 'two.com', 0)];
    expect(allocate(boxes, 10)).toEqual(['a1', 'b1', 'a2', 'a1', 'b1', 'b1']);
    expect(allocate(boxes, 3)).toEqual(['a1', 'b1', 'a2']);
  });

  it('pauses over 3% bounces or 1% spam blocks, but only once enough was sent to judge', () => {
    expect(pauseReason({ ...health, sent: 10, bounced: 5, bounceRate: 0.5 })).toBe('');
    expect(pauseReason({ ...health, sent: 100, bounced: 4, bounceRate: 0.04 })).toContain('4.0% bounced');
    expect(pauseReason({ ...health, sent: 100, spam: 2, spamRate: 0.0196 })).toContain('blocked as spam');
    expect(pauseReason({ ...health, sent: 100, bounced: 2, bounceRate: 0.02 })).toBe('');
  });

  it('pauses nothing while auto-pause is off (the default)', async () => {
    await mailboxStates(db, 3); // creates the tables
    await db.query("INSERT INTO mailboxes (id, email) VALUES ('a1', 'ava@one.com'), ('a2', 'ben@one.com')");
    await db.query("UPDATE mailboxes SET paused_reason = '4% bounced' WHERE id = 'a2'"); // paused before it was switched off
    for (let i = 0; i < 30; i++) await db.query('INSERT INTO messages (id, email_account_id, completed_at, happened_at, bounced) VALUES ($1, $2, now(), now(), $3)', [`m${i}`, 'a1', i < 10]);
    expect(await autoPause(db, 3)).toEqual([]);
    expect((await mailboxStates(db, 3)).every((s) => s.usable && !s.paused_reason)).toBe(true);
  });

  it('switching auto-pause off lifts the pauses it made', async () => {
    await mailboxStates(db, 3);
    await db.query("INSERT INTO mailboxes (id, email, paused_reason) VALUES ('a1', 'ava@one.com', '5% bounced')");
    await saveSettings(db, { autoPause: true });
    await saveSettings(db, { autoPause: false });
    expect((await mailboxStates(db, 3))[0]).toMatchObject({ paused_reason: '', usable: true });
  });

  it('pauses a domain whose inboxes are all bouncing, and lets the team resume', async () => {
    await mailboxStates(db, 3); // creates the tables
    await saveSettings(db, { autoPause: true });
    await db.query("INSERT INTO mailboxes (id, email) VALUES ('a1', 'ava@one.com'), ('a2', 'ben@one.com'), ('b1', 'dan@two.com')");
    const msg = (id: string, account: string, bounced: boolean) =>
      db.query('INSERT INTO messages (id, email_account_id, completed_at, happened_at, bounced) VALUES ($1, $2, now(), now(), $3)', [id, account, bounced]);
    // Each one.com inbox has sent too little to judge alone (15 each, 1 bounce), but the domain has sent enough.
    for (let i = 0; i < 15; i++) await msg(`a1-${i}`, 'a1', i < 1);
    for (let i = 0; i < 15; i++) await msg(`a2-${i}`, 'a2', i < 1);
    for (let i = 0; i < 60; i++) await msg(`b1-${i}`, 'b1', false);
    // 2 of 30 = 6.7% on one.com: both its inboxes pause; two.com keeps sending.
    const paused = await autoPause(db, 3);
    expect(paused.map((p) => p.email).sort()).toEqual(['ava@one.com', 'ben@one.com']);
    expect(paused[0].reason).toContain('domain one.com');
    await updateMailbox(db, 'a1', { resume: true });
    const states = await mailboxStates(db, 3);
    expect(states.find((s) => s.id === 'a1')).toMatchObject({ usable: true, paused_reason: '' });
    expect(states.find((s) => s.id === 'b1')).toMatchObject({ usable: true, room: 6 });
  });
});

describe('suppression list', () => {
  it('imports once, finds why a lead is blocked, and counts saved leads it blocks', async () => {
    const rows = [{ email: 'jane@acme.com', website: 'acme.com', company: 'Acme' }, { email: '' }];
    expect(await importSuppression(db, rows, 'client')).toEqual({ rows: 2, added: 3, alreadyListed: 0, unusable: 1 });
    expect((await importSuppression(db, rows, 'client')).added).toBe(0);
    expect(await suppressedReason(db, { email: 'bob@acme.com' })).toBe('client company (email domain)');
    expect(await suppressedReason(db, { company: 'ACME Inc.' })).toBe('client company (name)');
    expect(await suppressedReason(db, { email: 'bob@other.com', company: 'Other' })).toBe('');
    await savePeople(db, [{ name: 'Bob', title: 'CEO', company: 'Acme Inc', companyTruncated: false, location: '', geoMatch: 'match', linkedin: 'https://www.linkedin.com/in/bob', snippet: '', inferred: false }], 'af', 'q');
    expect((await suppressionStatus(db)).blockedLeads).toBe(1);
  });
});

describe('tracking', () => {
  function fakeMessages(pages: Record<string, unknown[]>) {
    const calls: URLSearchParams[] = [];
    const f = (async (url: string) => {
      const u = new URL(url);
      calls.push(u.searchParams);
      const kind = u.searchParams.get('emailer_message_stats[]') ?? (u.searchParams.has('emailer_message_reply_classes[]') ? 'replies' : 'all');
      return new Response(JSON.stringify({ emailer_messages: u.searchParams.get('page') === '1' ? (pages[kind] ?? []) : [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const svc: Services = { fetch: f, keys: { serper: '', jina: '', deepseek: '', apollo: 'k' } };
    return { svc, calls };
  }

  it('copies what happened to each email and breaks the results down by segment, with replies listed', async () => {
    await savePeople(
      db,
      ['a', 'b'].map((s) => ({ name: `${s.toUpperCase()} Person`, title: 'CEO', company: `${s}co`, companyTruncated: false, location: '', geoMatch: 'match' as const, linkedin: `https://www.linkedin.com/in/${s}`, snippet: '', inferred: false })),
      'af',
      'q',
    );
    await db.query("UPDATE people SET apollo_contact_id = 'c-a', apollo_sequence_id = 's1', segment = 'Healthcare', firm_size = 'small' WHERE linkedin_url LIKE '%/a'");
    await db.query("UPDATE people SET apollo_contact_id = 'c-b', apollo_sequence_id = 's1', segment = 'Finance', firm_size = 'large' WHERE linkedin_url LIKE '%/b'");
    const now = new Date().toISOString();
    const { svc, calls } = fakeMessages({
      all: [
        { id: 'm1', contact_id: 'c-a', email_account_id: 'a1', from_email: 'ava@one.com', completed_at: now },
        { id: 'm2', contact_id: 'c-b', email_account_id: 'b1', from_email: 'dan@two.com', completed_at: now },
      ],
      replies: [{ id: 'm1', contact_id: 'c-a', completed_at: now, replied: true, reply_class: 'willing_to_meet' }],
      bounced: [{ id: 'm2', contact_id: 'c-b', completed_at: now, bounce: true }],
      opened: [{ id: 'm1', contact_id: 'c-a', completed_at: now }],
    });
    const s = await syncMessages(svc, db);
    expect(s).toMatchObject({ complete: true, passes: 6 });
    expect(calls[0].getAll('emailer_campaign_ids[]')).toEqual(['s1']);
    expect(await totals(db)).toEqual({ people: 2, emails: 2, bounced: 1, spam: 0, opened: 1, replied: 1, interested: 1, unsubscribed: 0 });
    const bySegment = await breakdown(db, 'segment');
    expect(bySegment.find((r) => r.group === 'Healthcare')).toMatchObject({ people: 1, replied: 1, interested: 1, bounced: 0 });
    expect(bySegment.find((r) => r.group === 'Finance')).toMatchObject({ people: 1, replied: 0, bounced: 1 });
    expect((await breakdown(db, 'inbox')).map((r) => r.group).sort()).toEqual(['ava@one.com', 'dan@two.com']);
    expect((await replies(db)).map((r) => [r.name, r.reply_class])).toEqual([['A Person', 'willing_to_meet']]);

    // The next sync reads only recent emails again, and keeps what was learned (the reply, the open).
    await syncMessages(fakeMessages({ all: [{ id: 'm1', contact_id: 'c-a', completed_at: now }] }).svc, db);
    expect(await totals(db)).toMatchObject({ replied: 1, opened: 1 });
  });

  it('never contacts again anyone who opted out in Apollo or replied unsubscribe or not interested', async () => {
    await savePeople(
      db,
      ['a', 'b', 'c'].map((s) => ({ name: `${s.toUpperCase()} Person`, title: 'CEO', company: `${s}co`, companyTruncated: false, location: '', geoMatch: 'match' as const, linkedin: `https://www.linkedin.com/in/${s}`, snippet: '', inferred: false })),
      'af',
      'q',
    );
    for (const s of ['a', 'b', 'c']) await db.query(`UPDATE people SET apollo_contact_id = 'c-${s}', apollo_sequence_id = 's1' WHERE linkedin_url LIKE '%/${s}'`);
    const now = new Date().toISOString();
    await syncMessages(
      fakeMessages({
        unsubscribed: [{ id: 'm1', contact_id: 'c-a', completed_at: now }],
        replies: [{ id: 'm2', contact_id: 'c-b', completed_at: now, replied: true, reply_class: 'not_interested' }, { id: 'm3', contact_id: 'c-c', completed_at: now, replied: true, reply_class: 'willing_to_meet' }],
      }).svc,
      db,
    );
    const rows = await db.query<{ name: string; out: boolean }>('SELECT name, unsubscribed_at IS NOT NULL AS out FROM people ORDER BY name');
    expect(rows).toEqual([{ name: 'A Person', out: true }, { name: 'B Person', out: true }, { name: 'C Person', out: false }]);
  });
});

describe('checkDomain', () => {
  it('reads SPF, DKIM and DMARC from public DNS', async () => {
    const records: Record<string, string[]> = {
      'one.com': ['"v=spf1 include:_spf.google.com ~all"'],
      '_dmarc.one.com': ['"v=DMARC1; p=none; rua=mailto:d@one.com"'],
      'google._domainkey.one.com': ['"v=DKIM1; k=rsa; " "p=MIIB"'],
    };
    const f = (async (url: string) => {
      const name = new URL(url).searchParams.get('name') ?? '';
      return new Response(JSON.stringify({ Answer: (records[name] ?? []).map((data) => ({ type: 16, data })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = await checkDomain({ fetch: f, keys: { serper: '', jina: '', deepseek: '' } }, 'one.com');
    expect(c.spf).toEqual({ ok: true, record: 'v=spf1 include:_spf.google.com ~all' });
    expect(c.dmarc).toMatchObject({ ok: true, policy: 'none' });
    expect(c.dkim).toEqual({ ok: true, selectors: ['google'] });
  });
});
