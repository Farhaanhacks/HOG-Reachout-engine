import { describe, expect, it } from 'vitest';
import { companyKey, emailDomain, entriesFor, linkedinKey, normDomain } from '../src/lib/suppression';
import { DEFAULT_RULES, checkLead, cleanRules, editionFor, editionTitle, firmSize, matchTitle, sectorOf } from '../src/lib/targeting';
import { brandOfEmail, eligibleBrands, quotasFor } from '../src/lib/brands';
import { glForCountry, marketOf } from '../src/lib/markets';

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
    expect(eligibleBrands('Jordan')).toEqual([]); // outside the GCC: no brand
    expect(eligibleBrands('Japan')).toEqual([]);
  });

  it('splits every run 40% Gulf Icons, 30% Humans of Globe, 30% CIO Minds', () => {
    expect(quotasFor(10)).toEqual({ gulficons: 4, ciominds: 3, hog: 3 });
    expect(quotasFor(20)).toEqual({ gulficons: 8, ciominds: 6, hog: 6 });
    expect(quotasFor(50)).toEqual({ gulficons: 20, ciominds: 15, hog: 15 });
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
