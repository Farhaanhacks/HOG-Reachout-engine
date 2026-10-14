import { describe, expect, it } from 'vitest';
import { companyKey, emailDomain, entriesFor, linkedinKey, normDomain } from '../src/lib/suppression';
import { DEFAULT_RULES, checkLead, cleanRules, editionFor, editionTitle, firmSize, matchTitle, sectorOf } from '../src/lib/targeting';
import { brandOfEmail, eligibleBrands, quotasFor } from '../src/lib/brands';
import { glForCountry, marketOf } from '../src/lib/markets';
import { ICPS, checkIcpLead, laneCaps } from '../src/lib/icps';

describe('matchTitle', () => {
  it('reads how titles are really written', () => {
    expect(matchTitle('Founder & Chief Executive Officer', ['CEO'])).toBe('CEO');
    expect(matchTitle('Co-Founder, Acme', ['Owner', 'Founder'])).toBe('Founder');
    expect(matchTitle('Group Managing Director', ['Managing Director'])).toBe('Managing Director');
    expect(matchTitle('President & COO', ['President'])).toBe('President');
    expect(matchTitle('Chairwoman of the Board', ['Chairman'])).toBe('Chairman');
    expect(matchTitle('GM - Hilton Lagos', ['General Manager'])).toBe('General Manager');
    expect(matchTitle('CMO | Chief Medical Officer', ['Chief Medical Officer'])).toBe('Chief Medical Officer');
  });

  it('reads the ICP titles, and a Partner only when they are a partner of the firm', () => {
    expect(matchTitle('Managing Partner', ['Partner'])).toBe('Partner');
    expect(matchTitle('Founding Partner & CEO', ['Partner'])).toBe('Partner');
    expect(matchTitle('Partner', ['Partner'])).toBe('Partner');
    expect(matchTitle('Partner Manager, EMEA', ['Partner'])).toBe('');
    expect(matchTitle('Channel Partner Director', ['Partner'])).toBe('');
    expect(matchTitle('Head of Partnerships', ['Partner'])).toBe('');
    expect(matchTitle('Alliance Partner Lead', ['Partner'])).toBe('');
    expect(matchTitle('Co-founder & CTO', ['CTO'])).toBe('CTO');
    expect(matchTitle('Chief Technology Officer', ['CTO'])).toBe('CTO');
    expect(matchTitle('Deputy CTO', ['CTO'])).toBe('');
    expect(matchTitle('CISO', ['CISO'])).toBe('CISO');
    expect(matchTitle('Chief Information Security Officer', ['CISO'])).toBe('CISO');
    expect(matchTitle('Chief AI Officer', ['Chief AI Officer'])).toBe('Chief AI Officer');
    expect(matchTitle('Chief Innovation Officer', ['Chief Innovation Officer'])).toBe('Chief Innovation Officer');
    expect(matchTitle('CPO', ['Chief Product Officer'])).toBe('Chief Product Officer');
    expect(matchTitle('CPO - Chief People Officer', ['Chief Product Officer'])).toBe('');
    expect(matchTitle('Chief Executive', ['Chief Executive'])).toBe('Chief Executive');
  });

  it('never matches a step below, a former holder, or the wrong CMO', () => {
    expect(matchTitle('Vice President, Sales', ['President'])).toBe('');
    expect(matchTitle('Deputy General Manager', ['General Manager'])).toBe('');
    expect(matchTitle('Assistant Managing Director', ['Managing Director'])).toBe('');
    expect(matchTitle('Former CEO at Acme', ['CEO'])).toBe('');
    expect(matchTitle('Executive Assistant to the CEO', ['CEO'])).toBe('');
    expect(matchTitle('CMO (Chief Marketing Officer)', ['Chief Medical Officer'])).toBe('');
    expect(matchTitle('', ['CEO'])).toBe('');
  });

  it('matches titles the team adds on their own words', () => {
    expect(matchTitle('Medical Director, Cardiology', ['Medical Director'])).toBe('Medical Director');
    expect(matchTitle('Directrice', ['Medical Director'])).toBe('');
  });
});

describe('checkLead', () => {
  it('targets Owner, CEO or Founder at small firms and MD, President and similar at large ones', () => {
    expect(checkLead({ title: 'Owner', industry: 'retail', employees: 12 })).toMatchObject({ fit: true, size: 'small', sector: 'general', matched: 'Owner' });
    expect(checkLead({ title: 'Owner', industry: 'retail', employees: 400 })).toMatchObject({ fit: false, size: 'large' });
    expect(checkLead({ title: 'Managing Director', industry: 'retail', employees: 400 })).toMatchObject({ fit: true, matched: 'Managing Director' });
    expect(checkLead({ title: 'Managing Director', industry: 'retail', employees: 30 })).toMatchObject({ fit: false });
  });

  it('adds the Chief Medical Officer in healthcare and the General Manager in hospitality', () => {
    expect(checkLead({ title: 'Chief Medical Officer', industry: 'hospital & health care', employees: 2000 })).toMatchObject({ fit: true, sector: 'healthcare' });
    expect(checkLead({ title: 'Chief Medical Officer', industry: 'computer software', employees: 2000 }).fit).toBe(false);
    expect(checkLead({ title: 'General Manager', industry: 'hospitality', employees: 40 })).toMatchObject({ fit: true, sector: 'hospitality' });
    expect(checkLead({ title: 'General Manager', industry: 'construction', employees: 40 }).fit).toBe(false);
  });

  it('takes either list when the size is unknown, and explains a miss', () => {
    expect(checkLead({ title: 'President', industry: '', employees: null })).toMatchObject({ fit: true, size: 'unknown' });
    const miss = checkLead({ title: 'Head of Sales', industry: 'retail', employees: 9 });
    expect(miss.reason).toBe('Head of Sales is not a target title at a small retail company (wants Owner, CEO, Founder, Co-Founder)');
  });

  it('never reads hospitality as healthcare', () => {
    expect(sectorOf('hospitality')).toBe('hospitality');
    expect(sectorOf('hospital & health care')).toBe('healthcare');
    expect(editionFor('hospitality').segment).toBe('Hospitality');
    expect(editionFor('hospital & health care').segment).toBe('Healthcare');
  });

  it('counts up to 50 employees as small', () => {
    expect([firmSize(50), firmSize(51), firmSize(null), firmSize(0)]).toEqual(['small', 'large', 'unknown', 'unknown']);
  });
});

describe('cleanRules and editions', () => {
  it('keeps the team’s lists and fills anything empty from the defaults', () => {
    const r = cleanRules({ general: { small: ' Owner , Founder,, Owner ', large: [] }, sectorKeywords: { hospitality: ['Hotel'] } });
    expect(r.general.small).toEqual(['Owner', 'Founder']);
    expect(r.general.large).toEqual(DEFAULT_RULES.general.large);
    expect(r.sectorKeywords.hospitality).toEqual(['hotel']);
  });

  it('gives every industry an edition, falling back to the general one', () => {
    expect(editionFor('computer & network security')).toMatchObject({ edition: 'Top Cybersecurity Leaders to Watch in {year}', industryLine: 'Cybersecurity Leaders' });
    expect(editionFor('farming')).toMatchObject({ edition: 'Top Business Leaders to Watch in {year}', industryLine: 'Business Leaders' });
    expect(editionTitle(editionFor('banking'), new Date('2026-10-12'))).toBe('Top Fintech and Finance Players to Look Out For in 2026');
  });
});

describe('markets', () => {
  it('places countries in their market and their news country', () => {
    expect([marketOf('Nigeria'), marketOf('Germany'), marketOf('United States'), marketOf('United Arab Emirates'), marketOf('England'), marketOf('Japan'), marketOf('Egypt')]).toEqual(['af', 'eu', 'us', 'gcc', 'eu', null, 'af']);
    expect([glForCountry('South Africa'), glForCountry('Kenya'), glForCountry('Atlantis')]).toEqual(['za', 'ke', 'us']);
  });
});

describe('brands', () => {
  it('gives each country the brands that cover it', () => {
    expect(eligibleBrands('United Arab Emirates')).toEqual(['hog', 'gulficons']);
    expect(eligibleBrands('Saudi Arabia')).toEqual(['hog', 'gulficons']);
    expect(eligibleBrands('United States')).toEqual(['hog', 'ciominds']);
    expect(eligibleBrands('Germany')).toEqual(['hog', 'ciominds']);
    expect(eligibleBrands('Nigeria')).toEqual(['hog']);
    expect(eligibleBrands('Egypt')).toEqual(['hog']); // Africa
    expect(eligibleBrands('Singapore')).toEqual(['ciominds']);
    expect(eligibleBrands('Jordan')).toEqual([]); // outside the GCC: no brand
    expect(eligibleBrands('Japan')).toEqual([]);
  });

  it('splits every run 35% Gulf Icons, 30% Humans of Globe, 35% CIO Minds', () => {
    expect(quotasFor(10)).toEqual({ gulficons: 4, ciominds: 3, hog: 3 });
    expect(quotasFor(20)).toEqual({ gulficons: 7, ciominds: 7, hog: 6 });
    expect(quotasFor(30)).toEqual({ gulficons: 11, ciominds: 10, hog: 9 });
    expect(quotasFor(50)).toEqual({ gulficons: 18, ciominds: 17, hog: 15 });
    for (let t = 1; t <= 200; t++) {
      const q = quotasFor(t);
      expect(q.gulficons + q.hog + q.ciominds).toBe(t);
      expect(Math.min(q.gulficons, q.hog, q.ciominds)).toBeGreaterThanOrEqual(0);
    }
  });

  it('knows which brand an inbox sends for', () => {
    expect([brandOfEmail('aisha@gulficons.com'), brandOfEmail('alice@HumansofGlobe.com'), brandOfEmail('anam@ciominds.com'), brandOfEmail('x@gmail.com')]).toEqual(['gulficons', 'hog', 'ciominds', null]);
  });
});

describe('suppression keys', () => {
  it('matches the same email, domain, profile and company however they are written', () => {
    expect(normDomain('https://www.Acme.co.uk/about?x=1')).toBe('acme.co.uk');
    expect(emailDomain('Jane@Acme.com')).toBe('acme.com');
    expect(emailDomain('jane@gmail.com')).toBe(''); // never block a free email provider
    expect(linkedinKey('http://ng.linkedin.com/in/Jane-Doe/')).toBe('https://www.linkedin.com/in/jane-doe');
    expect(companyKey('The Acme Holdings, Inc.')).toBe(companyKey('acme holdings'));
    expect(companyKey('Société Générale S.A.')).toBe('societe generale');
  });

  it('blocks a contacted person, but a client as a whole company', () => {
    const row = { email: 'jane@acme.com', website: 'acme.com', company: 'Acme Ltd', linkedin: 'https://www.linkedin.com/in/jane' };
    expect(entriesFor(row, 'contacted')).toEqual([
      { kind: 'email', value: 'jane@acme.com' },
      { kind: 'linkedin', value: 'https://www.linkedin.com/in/jane' },
    ]);
    expect(entriesFor(row, 'client')).toEqual([
      { kind: 'email', value: 'jane@acme.com' },
      { kind: 'linkedin', value: 'https://www.linkedin.com/in/jane' },
      { kind: 'domain', value: 'acme.com' },
      { kind: 'company', value: 'acme' },
    ]);
    expect(entriesFor({ company: 'AB' }, 'client')).toEqual([]); // too short to block safely
  });
});

describe('ICPs', () => {
  const cyber = ICPS.find((i) => i.id === 'cyber')!;
  it('fits a lead on the ICP title, company size and country', () => {
    expect(checkIcpLead(cyber, { title: 'Founder & CISO', employees: 40, country: 'Germany' })).toMatchObject({ fit: true, matched: 'Founder' });
    expect(checkIcpLead(cyber, { title: 'CEO', employees: 5, country: 'Germany' })).toMatchObject({ fit: false, reason: expect.stringContaining('outside 11–200') });
    expect(checkIcpLead(cyber, { title: 'CEO', employees: 900, country: 'Germany' }).fit).toBe(false);
    expect(checkIcpLead(cyber, { title: 'CEO', employees: 40, country: 'France' })).toMatchObject({ fit: false, reason: expect.stringContaining('outside the countries') });
    expect(checkIcpLead(cyber, { title: 'Sales Director', employees: 40, country: 'Germany' }).fit).toBe(false);
    expect(checkIcpLead(cyber, { title: 'CEO', employees: null, country: 'United States' }).fit).toBe(true); // size unknown: kept
  });

  it('shares every run equally between the five ICPs, with a tenth for Africa', () => {
    expect(laneCaps(30)).toEqual({ channel: 6, cyber: 6, ai: 6, health: 6, fintech: 6, africa: 3 });
    expect(laneCaps(10)).toEqual({ channel: 2, cyber: 2, ai: 2, health: 2, fintech: 2, africa: 1 });
    expect(ICPS.map((i) => i.id)).toEqual(['channel', 'cyber', 'ai', 'health', 'fintech']);
  });
});
