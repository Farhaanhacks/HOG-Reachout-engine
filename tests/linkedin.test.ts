import { describe, expect, it } from 'vitest';
import { canonicalProfileUrl, geoMatch, locationFromSnippet, parsePeople, parsePerson, parseSubtitle, placeOnly, roleFromSnippet, splitRoleAndCompany } from '../src/lib/linkedin';
import { buildQueries } from '../src/lib/queries';

// Real results from the step 1 search "site:linkedin.com/in founder Dubai" (UAE).
const r = (title: string, link: string, subtitle = '', snippet = '') => ({ title, link, subtitle, snippet });

describe('canonicalProfileUrl', () => {
  it('gives the same address for every LinkedIn host and drops the query', () => {
    expect(canonicalProfileUrl('https://ae.linkedin.com/in/MustafaAlAnsari?trk=x')).toBe('https://www.linkedin.com/in/mustafaalansari');
    expect(canonicalProfileUrl('https://www.linkedin.com/in/mustafaalansari/')).toBe('https://www.linkedin.com/in/mustafaalansari');
  });
  it('rejects pages that are not profiles', () => {
    expect(canonicalProfileUrl('https://www.linkedin.com/company/damac')).toBe('');
    expect(canonicalProfileUrl('https://example.com/in/x')).toBe('');
  });
});

describe('splitRoleAndCompany', () => {
  it.each([
    ['Founder & CEO at Access Dubai', 'Founder & CEO', 'Access Dubai', false],
    ['Founder, DAMAC Properties', 'Founder', 'DAMAC Properties', false],
    ['CEO @ Dubai Technologies', 'CEO', 'Dubai Technologies', false],
    ['Founder & Chairman, Danube Group', 'Founder & Chairman', 'Danube Group', false],
    ['Founder & CEO of Destino Dubai', 'Founder & CEO', 'Destino Dubai', false],
    ['Cofounder at Sooner, YC Alum', 'Cofounder', 'Sooner', false],
    ['Founder & CEO at Dubai Euro ...', 'Founder & CEO', 'Dubai Euro', true],
    ['Head of Operations at Acme, Inc.', 'Head of Operations', 'Acme, Inc', false],
  ])('%s', (input, title, company, truncated) => {
    expect(splitRoleAndCompany(input)).toEqual({ title, company, companyTruncated: truncated });
  });

  it('does not take a department for a company', () => {
    expect(splitRoleAndCompany('Head, Operations')).toMatchObject({ company: '' });
  });
  it('finds no role in a headline', () => {
    expect(splitRoleAndCompany('I put 1% Founders with Dubai Investors')).toMatchObject({ title: '' });
  });
});

describe('parseSubtitle', () => {
  it('reads location, role and company', () => {
    expect(parseSubtitle('دبي، الإمارات العربية المتحدة · Founder · DAMAC Properties')).toEqual({
      location: 'دبي، الإمارات العربية المتحدة',
      title: 'Founder',
      company: 'DAMAC Properties',
    });
  });
  it('returns empty for no subtitle', () => {
    expect(parseSubtitle(undefined)).toEqual({ location: '', title: '', company: '' });
  });
});

describe('geoMatch', () => {
  it('recognises UAE locations, including Arabic', () => {
    expect(geoMatch('دبي، الإمارات العربية المتحدة', 'ae')).toBe('match');
    expect(geoMatch('Dubai, United Arab Emirates', 'ae')).toBe('match');
  });
  it('flags a Bay Area profile found by a Dubai search', () => {
    expect(geoMatch('San Francisco Bay Area', 'ae')).toBe('other');
  });
  it('matches US places and rejects the UAE for a US search', () => {
    expect(geoMatch('Austin, Texas, United States', 'us')).toBe('match');
    expect(geoMatch('Dubai, United Arab Emirates', 'us')).toBe('other');
  });
  it('says unknown when there is no location', () => {
    expect(geoMatch('', 'ae')).toBe('unknown');
  });
});

describe('parsePerson', () => {
  it('reads a plain result', () => {
    const p = parsePerson(r('Mustafa Al Ansari - Founder & CEO at Access Dubai', 'https://ae.linkedin.com/in/mustafaalansari'), 'ae');
    expect(p).toMatchObject({ name: 'Mustafa Al Ansari', title: 'Founder & CEO', company: 'Access Dubai', geoMatch: 'unknown' });
  });
  it('flags a person based outside the searched country', () => {
    const p = parsePerson(
      r('Sohail Rashid - CEO @ Dubai Technologies | MBA', 'https://www.linkedin.com/in/sohail-rashid-60973b2', 'San Francisco Bay Area · CEO · Dubai Technologies'),
      'ae',
    );
    expect(p).toMatchObject({ title: 'CEO', company: 'Dubai Technologies', geoMatch: 'other' });
  });
  it('takes role and company from the line under the result when the title has none', () => {
    const p = parsePerson(
      r('Mena Botros - I put 1% Founders with Dubai Investors', 'https://ae.linkedin.com/in/mena-botros-bb303452', 'دبي، الإمارات العربية المتحدة · Founder & Director of Operations · DoubleMorgan'),
      'ae',
    );
    expect(p).toMatchObject({ name: 'Mena Botros', title: 'Founder & Director of Operations', company: 'DoubleMorgan', geoMatch: 'match' });
  });
  it('replaces a cut-off company name with the full one from the line under the result', () => {
    const p = parsePerson(r('Mohammed Mashroom - Founder & CEO at Dubai Euro ...', 'https://ae.linkedin.com/in/mohammed-al-mashroom', 'Dubai · Founder & CEO · Dubai Euro Group'), 'ae');
    expect(p).toMatchObject({ company: 'Dubai Euro Group', companyTruncated: false });
  });
  it('skips results that are not profiles', () => {
    expect(parsePerson(r('DAMAC | LinkedIn', 'https://www.linkedin.com/company/damac'), 'ae')).toBeNull();
  });
});

describe('results seen on the live site', () => {
  it('reads a name with a credential in brackets and a place as the second part (Jason English)', () => {
    const p = parsePerson(
      r(
        'Jason English (CEO,YPO) - Dubai',
        'https://ae.linkedin.com/in/jasonenglish',
        '',
        'Jason English is an Entrepreneur, Author, Speaker and the Chief Eco-System Officer and co-founder of CG Tech, a company that provides strategic management ...',
      ),
      'ae',
    );
    expect(p).toMatchObject({ name: 'Jason English', title: 'CEO', company: 'CG Tech', location: 'Dubai', geoMatch: 'match', inferred: true });
  });

  it('finds the role among the pieces of a long headline (George Thomas)', () => {
    const p = parsePerson(
      r(
        'George Thomas - Building Enduring Partnerships for Business Agility Through Technology | Founder & CEO | SAP & Cloud / IT Infrastructure Expertise | 30+ years in the Middle East',
        'https://ae.linkedin.com/in/georgethomas',
        '',
        'Location: Dubai, United Arab Emirates. Experience: Pinnacle Smart Technologies.',
      ),
      'ae',
    );
    expect(p).toMatchObject({ name: 'George Thomas', title: 'Founder & CEO', location: 'Dubai, United Arab Emirates', geoMatch: 'match' });
  });

  it('takes a lone piece after the name as the company', () => {
    const p = parsePerson(r('George Thomas - Pinnacle Smart Technologies', 'https://ae.linkedin.com/in/georgethomas'), 'ae');
    expect(p).toMatchObject({ company: 'Pinnacle Smart Technologies', title: '' });
  });

  it('does not take "MBA" or a job description for a company', () => {
    expect(parsePerson(r('A Person - Founder | MBA', 'https://www.linkedin.com/in/ap'), 'ae')).toMatchObject({ title: 'Founder', company: '' });
    expect(parsePerson(r('A Person - Entrepreneur', 'https://www.linkedin.com/in/ap'), 'ae')).toMatchObject({ company: '' });
  });

  it('stops the company name where a second role starts (Khalid Al Malik)', () => {
    expect(splitRoleAndCompany('Managing Director at Dubai Holding and the Chief Executive Officer')).toMatchObject({ title: 'Managing Director', company: 'Dubai Holding' });
    expect(splitRoleAndCompany('CEO at Johnson & Johnson')).toMatchObject({ company: 'Johnson & Johnson' });
  });

  it('drops a bracketed programme from a company name (TENDERD)', () => {
    expect(splitRoleAndCompany('Founder & CEO at TENDERD (YC S18)')).toMatchObject({ title: 'Founder & CEO', company: 'TENDERD' });
  });
});

describe('placeOnly', () => {
  it('accepts places and rejects company names that contain one', () => {
    expect(placeOnly('Dubai')).toBe(true);
    expect(placeOnly('Dubai, United Arab Emirates')).toBe(true);
    expect(placeOnly('San Francisco Bay Area')).toBe(true);
    expect(placeOnly('Dubai Technologies')).toBe(false);
    expect(placeOnly('Dubai Future Foundation')).toBe(false);
  });
});

describe('locationFromSnippet and roleFromSnippet', () => {
  it('reads a labelled or country-qualified location', () => {
    expect(locationFromSnippet('Location: Dubai, United Arab Emirates · 500+ connections')).toBe('Dubai, United Arab Emirates');
    expect(locationFromSnippet('Based in Austin, United States and working remotely')).toBe('Austin, United States');
    expect(locationFromSnippet('No place mentioned')).toBe('');
  });
  it('reads a role and company stated in prose, and ignores lowercase words', () => {
    expect(roleFromSnippet('He is the founder and CEO of Zeta Capital, a fund').company).toBe('Zeta Capital');
    expect(roleFromSnippet('she is a founder of great things').company).toBe('');
  });
});

describe('parsePeople', () => {
  it('counts the same profile on two hosts once', () => {
    const people = parsePeople(
      [r('A B - CEO at X', 'https://ae.linkedin.com/in/ab'), r('A B - CEO at X', 'https://www.linkedin.com/in/ab/')],
      'ae',
    );
    expect(people).toHaveLength(1);
  });
});

describe('buildQueries', () => {
  it('makes one query per title group and city, with quoted terms', () => {
    const q = buildQueries({ geo: 'ae', titles: ['Founder', 'CEO', 'Managing Partner', 'CIO'], cities: ['Dubai'], keywords: ['hedge fund'], titlesPerQuery: 3 });
    expect(q).toEqual([
      'site:linkedin.com/in ("Founder" OR "CEO" OR "Managing Partner") "Dubai" "hedge fund"',
      'site:linkedin.com/in ("CIO") "Dubai" "hedge fund"',
    ]);
  });
  it('uses the geo cities by default and never repeats a query', () => {
    const q = buildQueries({ geo: 'us', titles: ['CEO', 'CEO'] });
    expect(q.length).toBe(7);
    expect(new Set(q).size).toBe(q.length);
  });
});
