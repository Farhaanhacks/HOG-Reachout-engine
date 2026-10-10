import { describe, expect, it } from 'vitest';
import { tagTitle } from '../src/lib/seniority';

describe('tagTitle', () => {
  it('tags a founder who is also a CEO, founder first', () => {
    const t = tagTitle('Founder & CEO');
    expect(t.labels).toEqual(['founder', 'c_suite']);
    expect(t.seniority).toBe('founder');
    expect(t.isTarget).toBe(true);
    expect(t.keywords).toEqual(expect.arrayContaining(['Founder', 'CEO', 'Chief Executive Officer']));
  });

  it('gives acronym and long form for a C-level title', () => {
    const t = tagTitle('Chief Technology Officer');
    expect(t.seniority).toBe('c_suite');
    expect(t.keywords).toEqual(expect.arrayContaining(['CTO', 'Chief Technology Officer']));
  });

  it('reads co-founder and chairman', () => {
    const t = tagTitle('Co-Founder & Chairman');
    expect(t.labels).toEqual(['founder', 'c_suite']);
    expect(t.keywords).toEqual(expect.arrayContaining(['Co-Founder', 'Chairman']));
  });

  it('tags a managing partner at a capital firm as a fund principal', () => {
    const t = tagTitle('Managing Partner', 'Acme Capital');
    expect(t.seniority).toBe('partner');
    expect(t.fundPrincipal).toBe(true);
    expect(t.isTarget).toBe(true);
  });

  it('does not call a managing partner at a non-fund company a fund principal', () => {
    expect(tagTitle('Managing Partner', 'Smith & Co Law').fundPrincipal).toBe(false);
  });

  it('tags a chief investment officer at a fund', () => {
    const t = tagTitle('Chief Investment Officer', 'Zeta Capital');
    expect(t.seniority).toBe('c_suite');
    expect(t.fundPrincipal).toBe(true);
    expect(t.keywords).toEqual(expect.arrayContaining(['CIO', 'Chief Investment Officer']));
  });

  it('treats a managing director as C-suite and a president as C-suite', () => {
    expect(tagTitle('Managing Director').seniority).toBe('c_suite');
    expect(tagTitle('President & CEO').seniority).toBe('c_suite');
  });

  it('tags an owner', () => {
    expect(tagTitle('Owner')).toMatchObject({ seniority: 'owner', isTarget: true });
  });

  it('keeps vice presidents out of the target group and out of C-suite', () => {
    const t = tagTitle('Vice President, Sales');
    expect(t.labels).toEqual(['vp']);
    expect(t.isTarget).toBe(false);
  });

  it('keeps directors and heads of department out of the target group', () => {
    expect(tagTitle('Head of Operations')).toMatchObject({ seniority: 'director', isTarget: false });
  });

  it('does not take a partner-programme job for a partner', () => {
    expect(tagTitle('Partner Success Manager').labels).toEqual([]);
  });

  it('skips people who are not the decision maker now', () => {
    for (const title of ['Former CEO', 'Ex-Founder', 'Assistant to the CEO', 'Chief of Staff']) {
      expect(tagTitle(title)).toMatchObject({ isTarget: false, current: false, seniority: 'other' });
    }
  });

  it('keeps a current founder whose title mentions an earlier employer', () => {
    expect(tagTitle('Founder & CEO, ex-Google')).toMatchObject({ isTarget: true, current: true });
    expect(tagTitle('CEO, former Goldman Sachs banker')).toMatchObject({ isTarget: true });
  });

  it('returns nothing for an empty title', () => {
    expect(tagTitle('')).toMatchObject({ labels: [], seniority: 'other', isTarget: false });
  });
});
