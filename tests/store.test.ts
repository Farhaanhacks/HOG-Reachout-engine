import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Person } from '../src/lib/linkedin';
import { countPeople, listPeople, savePeople, splitByCountry, type Db } from '../src/lib/store';

// A real (embedded) Postgres, so the dedupe SQL is tested as it will run in production.
let pg: PGlite;
let db: Db;

beforeAll(() => {
  pg = new PGlite();
  db = { query: async (text, params = []) => (await pg.query(text, params as unknown[])).rows as never };
});

beforeEach(async () => {
  await pg.exec('DROP TABLE IF EXISTS people');
  // ensureSchema remembers a database it has set up, so use a fresh wrapper for each test.
  db = { query: async (text, params = []) => (await pg.query(text, params as unknown[])).rows as never };
});

const person = (o: Partial<Person> = {}): Person => ({
  name: 'A B',
  title: 'Founder & CEO',
  company: 'Acme',
  companyTruncated: false,
  location: 'Dubai',
  geoMatch: 'match',
  linkedin: 'https://www.linkedin.com/in/ab',
  snippet: '',
  inferred: false,
  ...o,
});
const cd = () => person({ name: 'C D', linkedin: 'https://www.linkedin.com/in/cd' });

describe('savePeople', () => {
  it('saves new people', async () => {
    expect(await savePeople(db, [person(), cd()], 'ae', 'q')).toEqual({ inserted: 2, updated: 0 });
    expect(await listPeople(db)).toHaveLength(2);
  });

  it('saves nobody twice when the same search runs again', async () => {
    await savePeople(db, [person(), cd()], 'ae', 'q');
    expect(await savePeople(db, [person(), cd()], 'ae', 'q')).toEqual({ inserted: 0, updated: 2 });
    const rows = await listPeople(db);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.seen_count === 2)).toBe(true);
  });

  it('counts a profile listed twice in one batch once', async () => {
    expect(await savePeople(db, [person(), person()], 'ae', 'q')).toEqual({ inserted: 1, updated: 1 });
    expect(await listPeople(db)).toHaveLength(1);
  });

  it('fills blank fields from a later sighting and never overwrites existing ones', async () => {
    await savePeople(db, [person({ title: '', company: '', location: '' })], 'ae', 'q');
    await savePeople(db, [person()], 'ae', 'q');
    let [row] = await listPeople(db);
    expect(row).toMatchObject({ title: 'Founder & CEO', company: 'Acme', location: 'Dubai', is_target: true });
    await savePeople(db, [person({ title: 'Something else', company: 'Other' })], 'ae', 'q');
    [row] = await listPeople(db);
    expect(row).toMatchObject({ title: 'Founder & CEO', company: 'Acme' });
  });

  it('tags seniority and can list only the target people', async () => {
    await savePeople(db, [person(), person({ linkedin: 'https://www.linkedin.com/in/vp', title: 'Vice President, Sales' })], 'ae', 'q');
    const targets = await listPeople(db, { targetOnly: true });
    expect(targets).toHaveLength(1);
    expect(targets[0].labels).toBe('founder, c_suite');
  });

  it('lists and counts by country', async () => {
    await savePeople(db, [person()], 'ae', 'q');
    await savePeople(db, [cd()], 'us', 'q2');
    expect(await listPeople(db, { geo: 'us' })).toHaveLength(1);
    expect(await countPeople(db)).toEqual([
      { geo: 'ae', total: 1, targets: 1, main: 1 },
      { geo: 'us', total: 1, targets: 1, main: 1 },
    ]);
  });
});

describe('splitByCountry', () => {
  it('drops people based elsewhere and keeps unknown locations', () => {
    const { kept, excluded } = splitByCountry([person(), person({ linkedin: 'x', geoMatch: 'other' }), person({ linkedin: 'y', geoMatch: 'unknown' })]);
    expect(kept).toHaveLength(2);
    expect(excluded).toHaveLength(1);
  });
});
