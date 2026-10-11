import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Person } from '../src/lib/linkedin';
import { outreachStatus, pendingOutreach } from '../src/lib/outreach';
import type { Services } from '../src/lib/services';
import { savePeople, type Db } from '../src/lib/store';
import { TEST_ID, readToken, syncUnsubscribes, unsubscribe, unsubscribeToken } from '../src/lib/unsubscribe';

let pg: PGlite;
let db: Db;
beforeAll(() => {
  pg = new PGlite();
});
beforeEach(async () => {
  await pg.exec('DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS outreach_log; DROP TABLE IF EXISTS enrichment_log');
  db = { query: async (text, params = []) => (await pg.query(text, params as unknown[])).rows as never };
});

/** A fake Apollo "stop in sequence" endpoint; `fail` makes it unreachable. Records the query of each stop. */
function fakeApollo(fail = false) {
  const stops: URLSearchParams[] = [];
  const f = (async (url: string) => {
    if (fail) return new Response('{"error":"down"}', { status: 503 });
    stops.push(new URL(url).searchParams);
    return new Response('{"num_contacts":1}', { status: 200 });
  }) as unknown as typeof fetch;
  const svc: Services = { fetch: f, keys: { serper: '', jina: '', deepseek: '', apollo: 'master-key' } };
  return { svc, stops };
}

const person: Person = { name: 'A One', title: 'CEO', company: 'Alpha', companyTruncated: false, location: 'Dubai', geoMatch: 'match', linkedin: 'https://www.linkedin.com/in/a', snippet: '', inferred: false };

/** One person with a personalized email; `sequenced` also puts them in an Apollo sequence. */
async function seedOne(sequenced = true): Promise<number> {
  await savePeople(db, [person], 'ae', 'q');
  await db.query("UPDATE people SET email = 'a@alpha.com', apollo_status = 'matched', email_status = 'verified', company_size = 'fit', opener = 'Your Riyadh office caught our eye.', opener_status = 'done'");
  if (sequenced) await db.query("UPDATE people SET sequence_status = 'added', apollo_contact_id = 'c-1', apollo_sequence_id = 'seq-1'");
  return (await db.query<{ id: number }>('SELECT id FROM people'))[0].id;
}

describe('tokens', () => {
  it('round-trips and rejects tampering', () => {
    const t = unsubscribeToken(42);
    expect(readToken(t)).toBe('42');
    expect(readToken(t.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBeNull();
    expect(readToken(`${Buffer.from('43').toString('base64url')}.${t.split('.')[1]}`)).toBeNull(); // someone else's id with my signature
    expect(readToken('')).toBeNull();
  });
});

describe('unsubscribe', () => {
  it('stops the person in their Apollo sequence and never sends to them again', async () => {
    const id = await seedOne();
    const { svc, stops } = fakeApollo();
    expect(await unsubscribe(svc, db, unsubscribeToken(id))).toBe('unsubscribed');
    expect(stops).toHaveLength(1);
    expect(stops[0].getAll('emailer_campaign_ids[]')).toEqual(['seq-1']);
    expect(stops[0].getAll('contact_ids[]')).toEqual(['c-1']);
    expect(stops[0].get('mode')).toBe('stop');
    expect(await outreachStatus(db)).toMatchObject({ unsubscribed: 1 });
    // Clicking again changes nothing and does not stop twice.
    expect(await unsubscribe(svc, db, unsubscribeToken(id))).toBe('unsubscribed');
    expect(stops).toHaveLength(1);
  });

  it('keeps someone not yet sent out of every future send', async () => {
    const id = await seedOne(false);
    expect(await pendingOutreach(db, 10)).toHaveLength(1);
    const { svc, stops } = fakeApollo();
    expect(await unsubscribe(svc, db, unsubscribeToken(id))).toBe('unsubscribed');
    expect(stops).toHaveLength(0); // nothing to stop in Apollo
    expect(await pendingOutreach(db, 10)).toHaveLength(0);
  });

  it('still unsubscribes when Apollo is down, and stops the sequence later', async () => {
    const id = await seedOne();
    expect(await unsubscribe(fakeApollo(true).svc, db, unsubscribeToken(id))).toBe('unsubscribed');
    const { svc, stops } = fakeApollo();
    expect(await syncUnsubscribes(svc, db)).toBe(1);
    expect(stops).toHaveLength(1);
    expect(await syncUnsubscribes(svc, db)).toBe(0);
  });

  it('does nothing for a test link or a bad link', async () => {
    await seedOne(false);
    const { svc, stops } = fakeApollo();
    expect(await unsubscribe(svc, db, unsubscribeToken(TEST_ID))).toBe('test');
    expect(await unsubscribe(svc, db, 'nonsense')).toBe('invalid');
    expect(await unsubscribe(svc, db, unsubscribeToken(999))).toBe('invalid');
    expect(stops).toEqual([]);
    expect(await pendingOutreach(db, 10)).toHaveLength(1);
  });
});
