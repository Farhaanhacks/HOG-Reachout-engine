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

/** A fake Instantly blocklist; `fail` makes it unreachable. */
function fakeBlocklist(fail = false) {
  const blocked: string[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    if (fail) return new Response('{"message":"down"}', { status: 503 });
    blocked.push(JSON.parse(String(init.body)).bl_value);
    return new Response('{"id":"b1"}', { status: 200 });
  }) as unknown as typeof fetch;
  const svc: Services = { fetch: f, keys: { serper: '', jina: '', deepseek: '', instantly: 'k' } };
  return { svc, blocked };
}

const person: Person = { name: 'A One', title: 'CEO', company: 'Alpha', companyTruncated: false, location: 'Dubai', geoMatch: 'match', linkedin: 'https://www.linkedin.com/in/a', snippet: '', inferred: false };

async function seedOne(): Promise<number> {
  await savePeople(db, [person], 'ae', 'q');
  await db.query("UPDATE people SET email = 'a@alpha.com', apollo_status = 'matched', company_size = 'fit', opener = 'Your Riyadh office caught our eye.', opener_status = 'done'");
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
  it('marks the person, blocklists the email in Instantly, and stops all sending to them', async () => {
    const id = await seedOne();
    expect(await pendingOutreach(db, 10)).toHaveLength(1);
    const { svc, blocked } = fakeBlocklist();
    expect(await unsubscribe(svc, db, unsubscribeToken(id))).toBe('unsubscribed');
    expect(blocked).toEqual(['a@alpha.com']);
    expect(await pendingOutreach(db, 10)).toHaveLength(0);
    expect(await outreachStatus(db)).toMatchObject({ unsubscribed: 1, waiting: 0 });
    // Clicking again changes nothing and does not blocklist twice.
    expect(await unsubscribe(svc, db, unsubscribeToken(id))).toBe('unsubscribed');
    expect(blocked).toHaveLength(1);
  });

  it('still unsubscribes when Instantly is down, and blocklists later', async () => {
    const id = await seedOne();
    expect(await unsubscribe(fakeBlocklist(true).svc, db, unsubscribeToken(id))).toBe('unsubscribed');
    expect(await pendingOutreach(db, 10)).toHaveLength(0);
    const { svc, blocked } = fakeBlocklist();
    expect(await syncUnsubscribes(svc, db)).toBe(1);
    expect(blocked).toEqual(['a@alpha.com']);
    expect(await syncUnsubscribes(svc, db)).toBe(0);
  });

  it('does nothing for a test link or a bad link', async () => {
    await seedOne();
    const { svc, blocked } = fakeBlocklist();
    expect(await unsubscribe(svc, db, unsubscribeToken(TEST_ID))).toBe('test');
    expect(await unsubscribe(svc, db, 'nonsense')).toBe('invalid');
    expect(await unsubscribe(svc, db, unsubscribeToken(999))).toBe('invalid');
    expect(blocked).toEqual([]);
    expect(await pendingOutreach(db, 10)).toHaveLength(1);
  });
});
