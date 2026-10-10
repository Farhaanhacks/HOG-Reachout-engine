import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseJsonObject } from '../src/lib/ai';
import type { Person } from '../src/lib/linkedin';
import { cleanOpener, factsFor, personalizeNext, redactName, setOpener } from '../src/lib/personalize';
import type { Services } from '../src/lib/services';
import { savePeople, type Db } from '../src/lib/store';

let pg: PGlite;
let db: Db;
beforeAll(() => {
  pg = new PGlite();
});
beforeEach(async () => {
  await pg.exec('DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS outreach_log; DROP TABLE IF EXISTS enrichment_log');
  db = { query: async (text, params = []) => (await pg.query(text, params as unknown[])).rows as never };
});

/** Fake Serper news and DeepSeek. `openers` maps a company name to the reply DeepSeek gives; 'fail' makes DeepSeek error. */
function fakes(openers: Record<string, string | 'fail'>) {
  const ai: { system: string; user: string }[] = [];
  const news: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.includes('serper.dev/news')) {
      news.push(body.q);
      return new Response(JSON.stringify({ news: [{ title: `${body.q.replace(/"/g, '')} opens Riyadh office`, snippet: 'Ziad El Chaar said the expansion...', date: '2 months ago', source: 'Gulf News' }] }), { status: 200 });
    }
    const user = body.messages[1].content as string;
    ai.push({ system: body.messages[0].content, user });
    const company = /Company: (.+)/.exec(user)?.[1] ?? '';
    const reply = openers[company];
    if (reply === 'fail') return new Response(JSON.stringify({ error: { message: 'Service unavailable' } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ opener: reply ?? '', fact_used: 'Riyadh office' }) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const svc: Services = { fetch: f, keys: { serper: 's', jina: '', deepseek: 'd' } };
  return { svc, ai, news };
}

const person = (name: string, company: string, snippet = ''): Person => ({
  name,
  title: 'CEO',
  company,
  companyTruncated: false,
  location: 'Dubai',
  geoMatch: 'match',
  linkedin: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, '-')}`,
  snippet,
  inferred: false,
});

async function seed(people: Person[]) {
  await savePeople(db, people, 'ae', 'q');
  await db.query("UPDATE people SET email = lower(replace(name, ' ', '')) || '@example.com', apollo_status = 'matched', company_size = 'fit', apollo_checked_at = now()");
}
const row = async (company: string) =>
  (await db.query<{ opener: string; opener_status: string; opener_fact: string }>('SELECT opener, opener_status, opener_fact FROM people WHERE company = $1', [company]))[0];

describe('privacy', () => {
  it('replaces the name in any form', () => {
    expect(redactName('Ziad El Chaar founded it; Ziad said El Chaar family...', 'Ziad El Chaar')).toBe('the person founded it; the person said the person family...');
    expect(redactName('Ali Rahman joined Alibaba', 'Ali Rahman')).toBe('the person joined Alibaba');
  });

  it('never sends the name or email to DeepSeek', async () => {
    await seed([person('Ziad El Chaar', 'DarGlobal', 'Ziad El Chaar is the CEO of DarGlobal, leading its London launch.')]);
    const { svc, ai } = fakes({ DarGlobal: 'Your London launch with DarGlobal caught our eye.' });
    await personalizeNext(svc, db, 10);
    expect(ai).toHaveLength(1);
    expect(ai[0].user).not.toMatch(/Ziad|Chaar|@example\.com/i);
    expect(ai[0].user).toContain('the person is the CEO of DarGlobal');
    expect(ai[0].user).toContain('DarGlobal opens Riyadh office');
  });
});

describe('personalizeNext', () => {
  it('saves a usable opener, holds back a lead with nothing specific, and retries failures later', async () => {
    await seed([person('A One', 'Alpha'), person('B Two', 'Beta'), person('C Three', 'Gamma')]);
    const { svc, news } = fakes({ Alpha: 'Your Riyadh office opening this year caught our eye.', Beta: '', Gamma: 'fail' });
    const summary = await personalizeNext(svc, db, 10);
    expect(summary).toMatchObject({ done: 1, none: 1, failed: 1, searches: 3 });
    expect(news).toEqual(expect.arrayContaining(['"Alpha"', '"Beta"', '"Gamma"']));
    expect(await row('Alpha')).toMatchObject({ opener: 'Your Riyadh office opening this year caught our eye.', opener_status: 'done', opener_fact: 'Riyadh office' });
    expect(await row('Beta')).toMatchObject({ opener: '', opener_status: 'none' });
    expect(await row('Gamma')).toMatchObject({ opener_status: '' }); // tried again next time

    const again = await personalizeNext(fakes({ Gamma: 'Your growth at Gamma caught our eye.' }).svc, db, 10);
    expect(again).toMatchObject({ done: 1, none: 0 });
  });

  it('rejects openers that break the rules', () => {
    expect(cleanOpener('Amazing work at Acme!')).toBe('');
    expect(cleanOpener('Have you seen this? https://x.com')).toBe('');
    expect(cleanOpener('the person launched Acme')).toBe('');
    expect(cleanOpener('Your Riyadh office opening this year caught our eye.')).toBe('Your Riyadh office opening this year caught our eye.');
  });

  it('needs a DeepSeek key', async () => {
    const { svc } = fakes({});
    svc.keys.deepseek = '';
    await expect(personalizeNext(svc, db, 10)).rejects.toThrow('DEEPSEEK_API_KEY is not set');
  });

  it('lets the team write or clear an opener by hand', async () => {
    await seed([person('A One', 'Alpha')]);
    const [p] = await db.query<{ id: number }>('SELECT id FROM people');
    await setOpener(db, p.id, '  Your new Abu Dhabi office caught our eye.  ');
    expect(await row('Alpha')).toMatchObject({ opener: 'Your new Abu Dhabi office caught our eye.', opener_status: 'done', opener_fact: 'edited by the team' });
    await setOpener(db, p.id, '');
    expect(await row('Alpha')).toMatchObject({ opener: '', opener_status: 'none' });
  });
});

describe('facts and parsing', () => {
  it('lists only job, company, country, profile text and news', () => {
    const facts = factsFor({ id: 1, name: 'A One', title: 'CEO', company: 'Alpha', geo: 'ae', snippet: 'A One runs Alpha' }, [{ title: 'Alpha raises $5M', snippet: '', date: '1 month ago' }]);
    expect(facts).toBe('Job title: CEO\nCompany: Alpha\nCountry: AE\nFrom their LinkedIn profile: the person runs Alpha\nNews 1 (1 month ago): Alpha raises $5M. ');
  });

  it('reads JSON with or without code fences', () => {
    expect(parseJsonObject('```json\n{"opener":"x"}\n```')).toEqual({ opener: 'x' });
    expect(parseJsonObject('Sure: {"opener":"y"} hope this helps')).toEqual({ opener: 'y' });
    expect(parseJsonObject('no json')).toBeNull();
  });
});
