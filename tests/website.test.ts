import { describe, expect, it } from 'vitest';
import { rootDomain } from '../src/lib/text';
import { domainScore, findOfficialWebsite, nameTokens, pickOfficialDomain } from '../src/lib/website';
import type { Services } from '../src/lib/services';

const r = (link: string) => ({ link, title: '', snippet: '' });

describe('rootDomain', () => {
  it('reduces addresses to the registrable domain', () => {
    expect(rootDomain('https://www.acme.co.ae/path?x=1')).toBe('acme.co.ae');
    expect(rootDomain('https://ae.linkedin.com/in/x')).toBe('linkedin.com');
    expect(rootDomain('shop.acme.com')).toBe('acme.com');
  });
});

describe('nameTokens', () => {
  it('drops words that only say what kind of firm it is', () => {
    expect(nameTokens('DAMAC Properties')).toEqual(['damac']);
    expect(nameTokens('Danube Group')).toEqual(['danube']);
    expect(nameTokens('Access Dubai')).toEqual(['access']);
  });
});

describe('pickOfficialDomain', () => {
  it('finds the company site and skips directories', () => {
    expect(pickOfficialDomain('DAMAC Properties', [r('https://www.linkedin.com/company/damac-properties'), r('https://www.damacproperties.com/')])).toBe('damacproperties.com');
    expect(pickOfficialDomain('Danube Group', [r('https://www.crunchbase.com/organization/danube'), r('https://www.danubegroup.com')])).toBe('danubegroup.com');
    expect(pickOfficialDomain('Access Dubai', [r('https://accessdubai.ae/')])).toBe('accessdubai.ae');
  });

  it('returns nothing when only directories and other companies come back', () => {
    expect(pickOfficialDomain('Acme Capital', [r('https://www.zoominfo.com/c/acme'), r('https://www.bloomberg.com/profile/acme'), r('https://www.othername.com')])).toBe('');
  });

  it('does not accept another organisation that shares a word', () => {
    expect(domainScore('Cummins', 'cumminscollege.org')).toBe(0);
    expect(domainScore('Cummins', 'cumminsuae.com')).toBeGreaterThanOrEqual(3);
  });
});

describe('findOfficialWebsite', () => {
  function svcWith(organic: unknown[], store = new Map<string, unknown>()): { svc: Services; searches: () => number } {
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      return new Response(JSON.stringify({ organic }), { status: 200 });
    }) as unknown as typeof fetch;
    return {
      svc: {
        fetch: fakeFetch,
        keys: { serper: 'k', jina: '', deepseek: '' },
        cache: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      },
      searches: () => n,
    };
  }

  it('looks the site up once and then uses the cache', async () => {
    const { svc, searches } = svcWith([{ link: 'https://www.danubegroup.com' }]);
    expect(await findOfficialWebsite(svc, 'Danube Group', 'ae', 'Dubai')).toBe('danubegroup.com');
    expect(await findOfficialWebsite(svc, 'Danube  Group', 'ae', 'Dubai')).toBe('danubegroup.com');
    expect(searches()).toBe(1);
  });

  it('returns an empty string when the search fails', async () => {
    const svc: Services = { fetch: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch, keys: { serper: 'k', jina: '', deepseek: '' } };
    expect(await findOfficialWebsite(svc, 'Danube Group', 'ae')).toBe('');
  });
});
