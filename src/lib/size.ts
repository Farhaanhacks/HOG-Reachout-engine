/** The ICP's company size: 25 to 10,000 employees. */
export const MIN_EMPLOYEES = 25;
export const MAX_EMPLOYEES = 10_000;

/** What Apollo tells us about the person's company, when it knows. */
export type CompanyFacts = {
  employees: number | null;
  /** Yearly revenue in US dollars. */
  revenue: number | null;
  /** Total money raised, in US dollars. */
  funding: number | null;
  publicCompany: boolean;
};

/**
 * fit: employee count in range. big_enough: no employee count, but revenue, funding or a stock listing shows a real
 * company (the team's rule: still go for it). too_small / too_large: employee count outside the range, left out.
 * unknown: nothing to judge by, kept.
 */
export type SizeVerdict = 'fit' | 'big_enough' | 'too_small' | 'too_large' | 'unknown';

export const OUT_OF_RANGE: SizeVerdict[] = ['too_small', 'too_large'];

export function sizeVerdict(f: CompanyFacts | null | undefined): SizeVerdict {
  if (!f) return 'unknown';
  if (f.employees && f.employees > 0) {
    if (f.employees < MIN_EMPLOYEES) return 'too_small';
    if (f.employees > MAX_EMPLOYEES) return 'too_large';
    return 'fit';
  }
  if (f.publicCompany || (f.revenue ?? 0) >= 2_000_000 || (f.funding ?? 0) >= 1_000_000) return 'big_enough';
  return 'unknown';
}
