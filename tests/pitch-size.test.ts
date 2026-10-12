import { describe, expect, it } from 'vitest';
import { geoMatch } from '../src/lib/linkedin';
import { draftEmail, firstNameOf } from '../src/lib/pitch';
import { sizeVerdict } from '../src/lib/size';

describe('draftEmail', () => {
  it('greets by first name and puts the congratulations line, role and edition in place', () => {
    const d = draftEmail({ name: 'Jason English', title: 'CEO', company: 'CG Tech', opener: "Congratulations on CG Tech's Series B!", edition: 'Top Fintech Players to Look Out For in 2026' });
    expect(d.subject).toBe('Cover Story invite for CG Tech');
    expect(d.body.startsWith("Dear Jason,\n\nCongratulations on CG Tech's Series B!\n\nYour recent achievement in your role as CEO at CG Tech reflects")).toBe(true);
    expect(d.body).toContain('special edition, "Top Fintech Players to Look Out For in 2026".');
    expect(d.body).toContain('At Humans of Globe, we take pride');
  });

  it('still reads well with no name, title or company', () => {
    const d = draftEmail({ name: '', title: '', company: '' });
    expect(d.subject).toBe('Cover Story invite');
    expect(d.body.startsWith('Dear Sir or Madam,\n\nCongratulations on your continued leadership!')).toBe(true);
    expect(d.body).toContain('Your recent achievement in your work reflects');
  });

  it('skips honorifics and handles a missing name', () => {
    expect(firstNameOf('Dr. Ahmed Al Sayed')).toBe('Ahmed');
    expect(firstNameOf('H.E. Khalid Al Malik')).toBe('Khalid');
    expect(firstNameOf('')).toBe('');
  });
});

describe('sizeVerdict', () => {
  const facts = (o: Partial<{ employees: number | null; revenue: number | null; funding: number | null; publicCompany: boolean }>) => ({
    employees: null,
    revenue: null,
    funding: null,
    publicCompany: false,
    ...o,
  });
  it('judges by employee count when Apollo has one', () => {
    expect(sizeVerdict(facts({ employees: 120 }))).toBe('fit');
    expect(sizeVerdict(facts({ employees: 8 }))).toBe('too_small');
    expect(sizeVerdict(facts({ employees: 50_000 }))).toBe('too_large');
  });
  it('accepts a company with no employee count that is big enough by other signs', () => {
    expect(sizeVerdict(facts({ revenue: 15_000_000 }))).toBe('big_enough');
    expect(sizeVerdict(facts({ funding: 3_000_000 }))).toBe('big_enough');
    expect(sizeVerdict(facts({ publicCompany: true }))).toBe('big_enough');
  });
  it('keeps a company it cannot judge', () => {
    expect(sizeVerdict(facts({}))).toBe('unknown');
    expect(sizeVerdict(undefined)).toBe('unknown');
  });
});

describe('geoMatch for the UK and Canada', () => {
  it('recognises UK and Canadian locations', () => {
    expect(geoMatch('London, England, United Kingdom', 'uk')).toBe('match');
    expect(geoMatch('Toronto, Ontario, Canada', 'ca')).toBe('match');
    expect(geoMatch('Greater Manchester', 'uk')).toBe('match');
  });
  it('lets a country name decide between places with the same name', () => {
    expect(geoMatch('London, Ontario, Canada', 'uk')).toBe('other');
    expect(geoMatch('London, Ontario, Canada', 'ca')).toBe('match');
    expect(geoMatch('Sydney, New South Wales, Australia', 'uk')).toBe('other');
  });
  it('treats the other markets as elsewhere', () => {
    expect(geoMatch('Toronto, Ontario, Canada', 'us')).toBe('other');
    expect(geoMatch('Dubai, United Arab Emirates', 'uk')).toBe('other');
  });
});
