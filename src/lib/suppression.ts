import { FREEMAIL, companyKey, emailDomain, linkedinKey, normDomain, normEmail } from './keys';
import { NOT_SUPPRESSED_SQL, ensureSchema, type Db } from './store';

export { companyKey, emailDomain, isFreemail, linkedinKey, normDomain, normEmail } from './keys';

/**
 * Suppression: the client list and everyone contacted before, so no prospect is ever contacted again.
 *  - Previously contacted people are blocked by their email and LinkedIn profile.
 *  - Clients are blocked as a whole company: their website domain, their email domain and their company name, so nobody
 *    else at a client company is pitched either.
 * The list is checked before Apollo is paid for an email (by company name), when a lead is saved (by email, LinkedIn and
 * domain) and again just before anyone is sent (READY_SQL), so a list imported later still protects leads found earlier.
 */

export type SuppressionKind = 'email' | 'domain' | 'linkedin' | 'company';
export type SuppressionSource = 'client' | 'contacted' | 'manual';

/** One row of an imported list; any column may be blank. */
export type ImportRow = { email?: string; website?: string; linkedin?: string; company?: string; name?: string };

/** The entries one row adds: a contacted person by email and LinkedIn; a client as a whole company. */
export function entriesFor(row: ImportRow, source: SuppressionSource): { kind: SuppressionKind; value: string }[] {
  const out: { kind: SuppressionKind; value: string }[] = [];
  const email = normEmail(row.email);
  const linkedin = linkedinKey(row.linkedin);
  if (email) out.push({ kind: 'email', value: email });
  if (linkedin) out.push({ kind: 'linkedin', value: linkedin });
  if (source === 'client') {
    const site = normDomain(row.website);
    if (site && !FREEMAIL.has(site)) out.push({ kind: 'domain', value: site });
    const fromEmail = emailDomain(row.email);
    if (fromEmail && fromEmail !== site) out.push({ kind: 'domain', value: fromEmail });
    const company = companyKey(row.company);
    // Very short names ("ab", "co") would block unrelated companies.
    if (company.length >= 3) out.push({ kind: 'company', value: company });
  }
  return out;
}

export type ImportSummary = { rows: number; added: number; alreadyListed: number; unusable: number };

/** Adds an imported list. Re-importing the same file adds nothing new. */
export async function importSuppression(db: Db, rows: ImportRow[], source: SuppressionSource, note = ''): Promise<ImportSummary> {
  await ensureSchema(db);
  const summary: ImportSummary = { rows: rows.length, added: 0, alreadyListed: 0, unusable: 0 };
  const entries = new Map<string, { kind: SuppressionKind; value: string }>();
  for (const row of rows) {
    const e = entriesFor(row, source);
    if (!e.length) summary.unusable++;
    for (const x of e) entries.set(`${x.kind}|${x.value}`, x);
  }
  const list = [...entries.values()];
  // In chunks, so a list of tens of thousands goes in a few statements.
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const params: unknown[] = [];
    const values = chunk.map((x, j) => {
      params.push(x.kind, x.value, source, note.slice(0, 200));
      return `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`;
    });
    const inserted = await db.query<{ kind: string }>(
      `INSERT INTO suppression (kind, value, source, note) VALUES ${values.join(', ')} ON CONFLICT (kind, value) DO NOTHING RETURNING kind`,
      params,
    );
    summary.added += inserted.length;
    summary.alreadyListed += chunk.length - inserted.length;
  }
  return summary;
}

export type SuppressionStatus = {
  bySource: { source: string; kind: string; n: number }[];
  total: number;
  /** Saved leads the list currently blocks. */
  blockedLeads: number;
};

export async function suppressionStatus(db: Db): Promise<SuppressionStatus> {
  await ensureSchema(db);
  const bySource = await db.query<{ source: string; kind: string; n: number }>('SELECT source, kind, count(*)::int AS n FROM suppression GROUP BY source, kind ORDER BY source, kind');
  const [b] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM people WHERE NOT (${NOT_SUPPRESSED_SQL})`);
  return { bySource, total: bySource.reduce((n, r) => n + r.n, 0), blockedLeads: b?.n ?? 0 };
}

/** Removes every entry from one source (for re-importing a corrected list). */
export async function clearSuppression(db: Db, source: SuppressionSource): Promise<number> {
  await ensureSchema(db);
  return (await db.query('DELETE FROM suppression WHERE source = $1 RETURNING 1', [source])).length;
}

/** Why a lead is suppressed, or '' when it is not. Company names are checked even before the lead has an email. */
export async function suppressedReason(db: Db, lead: { email?: string; domain?: string; linkedin?: string; company?: string }): Promise<string> {
  await ensureSchema(db);
  const checks: [SuppressionKind, string, string][] = [
    ['email', normEmail(lead.email), 'email already contacted'],
    ['linkedin', linkedinKey(lead.linkedin), 'LinkedIn profile already contacted'],
    ['domain', normDomain(lead.domain), 'client company (website)'],
    ['domain', emailDomain(lead.email), 'client company (email domain)'],
    ['company', companyKey(lead.company), 'client company (name)'],
  ];
  const wanted = checks.filter(([, v]) => v);
  if (!wanted.length) return '';
  const rows = await db.query<{ kind: string; value: string }>(
    `SELECT kind, value FROM suppression WHERE (kind, value) IN (${wanted.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')})`,
    wanted.flatMap(([k, v]) => [k, v]),
  );
  const hit = wanted.find(([k, v]) => rows.some((r) => r.kind === k && r.value === v));
  return hit ? hit[2] : '';
}

/** Of these company names, the ones that belong to clients (by name), checked in one query. */
export async function clientCompanies(db: Db, companies: string[]): Promise<Set<string>> {
  await ensureSchema(db);
  const keys = [...new Set(companies.map(companyKey).filter(Boolean))];
  if (!keys.length) return new Set();
  const rows = await db.query<{ value: string }>(`SELECT value FROM suppression WHERE kind = 'company' AND value IN (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys);
  return new Set(rows.map((r) => r.value));
}
