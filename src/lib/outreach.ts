import { addToSequence, createContact, findCustomFields, missingFields, skipReason, type ApolloContactInput, type FieldIds } from './apollo-sequences';
import { fallbackOpener, personalizeNext } from './personalize';
import { draftEmail, unsubscribeLineText } from './pitch';
import type { Services } from './services';
import { READY_SQL, ensureSchema, type Db, type SavedPerson } from './store';
import { TEST_ID, unsubscribeUrl } from './unsubscribe';

export const DEFAULT_OUTREACH_DAILY_LIMIT = 500;

/** The most people added to Apollo sequences per day: OUTREACH_DAILY_LIMIT, or 500. Apollo itself paces the emails per mailbox. */
export function outreachDailyLimitFromEnv(): number {
  return Math.max(1, Number(process.env.OUTREACH_DAILY_LIMIT) || DEFAULT_OUTREACH_DAILY_LIMIT);
}

/** The label every contact the engine creates in Apollo gets, so the team can find them there. */
export const APOLLO_LABEL = 'Humans of Globe lead engine';

type ContactSource = Pick<SavedPerson, 'id' | 'name' | 'title' | 'company' | 'email' | 'opener'>;

/** The three personal parts of a person's email, as they go into Apollo's custom fields. */
export function emailParts(p: ContactSource, opts: { unsubscribeId?: number | string } = {}): { subject: string; opener: string; unsubscribe: string } {
  const d = draftEmail(p);
  return {
    subject: d.subject,
    opener: p.opener?.trim() || fallbackOpener(p),
    unsubscribe: unsubscribeUrl(opts.unsubscribeId ?? p.id),
  };
}

/** The full email a person will receive, as the sequence template renders it. For previews. */
export function fullEmail(p: ContactSource, opts: { unsubscribeId?: number | string } = {}): { subject: string; body: string } {
  const parts = emailParts(p, opts);
  const d = draftEmail({ ...p, opener: parts.opener });
  return { subject: parts.subject, body: `${d.body}\n\n${unsubscribeLineText(parts.unsubscribe)}` };
}

/** A saved person as an Apollo contact, with their personal subject, opener and unsubscribe link in the custom fields. */
export function toApolloContact(p: ContactSource, fields: FieldIds, opts: { unsubscribeId?: number | string; organizationName?: string } = {}): ApolloContactInput {
  const d = draftEmail(p);
  const parts = emailParts(p, opts);
  const words = p.name.trim().split(/\s+/).filter(Boolean);
  const at = words.findIndex((w) => w.toLowerCase() === d.firstName.toLowerCase());
  const lastName = at >= 0 ? words.slice(at + 1).join(' ') : words.slice(1).join(' ');
  const custom: Record<string, string> = {};
  if (fields.subject) custom[fields.subject] = parts.subject;
  if (fields.opener) custom[fields.opener] = parts.opener;
  if (fields.unsubscribe) custom[fields.unsubscribe] = parts.unsubscribe;
  const contact: ApolloContactInput = { email: p.email, label_names: [APOLLO_LABEL], typed_custom_fields: custom };
  if (d.firstName !== 'there') contact.first_name = d.firstName;
  if (lastName) contact.last_name = lastName;
  const organization = opts.organizationName ?? p.company;
  if (organization) contact.organization_name = organization;
  if (p.title) contact.title = p.title;
  return contact;
}

/** The custom fields must exist in Apollo, or the sequence would send emails with empty gaps. */
async function requireFields(svc: Services): Promise<FieldIds> {
  const fields = await findCustomFields(svc);
  const missing = missingFields(fields);
  if (missing.length) throw new Error(`Create these custom contact fields in Apollo first: ${missing.join(', ')}.`);
  return fields;
}

const COLUMNS = `id, linkedin_url, name, title, company, location, geo, geo_match, labels, is_target, inferred, status, seen_count, first_seen, last_seen,
  email, email_status, apollo_status, apollo_confidence, apollo_tier, rank, company_employees, company_size, sequence_status, sequence_note, sequenced_at,
  opener, opener_fact, opener_status`;

/**
 * Who goes to Apollo next: people with an email ready and a personal opener, not sent yet; main people first, then in
 * the order they got their email.
 */
export async function pendingOutreach(db: Db, limit: number): Promise<SavedPerson[]> {
  await ensureSchema(db);
  return db.query<SavedPerson>(
    `SELECT ${COLUMNS} FROM people
     WHERE ${READY_SQL} AND email <> '' AND sequence_status = '' AND opener_status = 'done' AND opener <> ''
     ORDER BY COALESCE(rank, 3) ASC, apollo_checked_at ASC NULLS LAST, id ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 1000))],
  );
}

export type OutreachStatus = {
  /** Personalized and ready to send. */
  waiting: number;
  /** Email ready but not personalized yet (it happens automatically). */
  toPersonalize: number;
  sent: number;
  skipped: number;
  unsubscribed: number;
  sentToday: number;
  dailyLimit: number;
};

export async function outreachStatus(db: Db, dailyLimit = DEFAULT_OUTREACH_DAILY_LIMIT): Promise<OutreachStatus> {
  await ensureSchema(db);
  const unsent = `${READY_SQL} AND email <> '' AND sequence_status = ''`;
  const [p] = await db.query<{ waiting: number; to_personalize: number; sent: number; skipped: number; unsubscribed: number }>(
    `SELECT count(*) FILTER (WHERE ${unsent} AND opener_status = 'done' AND opener <> '')::int AS waiting,
            count(*) FILTER (WHERE ${unsent} AND opener_status IN ('', 'none'))::int AS to_personalize,
            count(*) FILTER (WHERE sequence_status = 'added')::int AS sent,
            count(*) FILTER (WHERE sequence_status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed
     FROM people`,
  );
  const [t] = await db.query<{ n: number }>(`SELECT coalesce(sum(requested), 0)::int AS n FROM outreach_log WHERE ran_at >= date_trunc('day', now())`);
  return {
    waiting: p?.waiting ?? 0,
    toPersonalize: p?.to_personalize ?? 0,
    sent: p?.sent ?? 0,
    skipped: p?.skipped ?? 0,
    unsubscribed: p?.unsubscribed ?? 0,
    sentToday: t?.n ?? 0,
    dailyLimit,
  };
}

export type PushSummary = {
  requested: number;
  added: number;
  /** Apollo declined them (for example, already in another sequence); marked so they are not sent again. */
  skipped: number;
  /** Could not be created in Apollo this time; they go again next time. */
  failed: number;
  /** Apollo's reasons for declining, with counts. */
  reasons: Record<string, number>;
  error?: string;
  stopped?: string;
};

/**
 * Sends the next people with a personalized email ready into an Apollo sequence, up to the daily cap: each becomes an
 * Apollo contact (their subject, opener and unsubscribe link in custom fields), then all are added to the sequence,
 * sending from the chosen mailbox. Anyone not yet personalized is personalized first, so nothing plain is ever sent.
 */
export async function pushToApollo(svc: Services, db: Db, opts: { sequenceId: string; emailAccountId: string; limit: number; dailyLimit?: number }): Promise<PushSummary> {
  if (!opts.sequenceId) throw new Error('Choose an Apollo sequence first.');
  if (!opts.emailAccountId) throw new Error('Choose the mailbox to send from first.');
  const fields = await requireFields(svc);
  const dailyLimit = opts.dailyLimit ?? DEFAULT_OUTREACH_DAILY_LIMIT;
  const status = await outreachStatus(db, dailyLimit);
  const room = dailyLimit - status.sentToday;
  const summary: PushSummary = { requested: 0, added: 0, skipped: 0, failed: 0, reasons: {} };
  if (room <= 0) return { ...summary, stopped: `Daily limit of ${dailyLimit} people added to Apollo reached` };
  // Safety net: the pages normally personalize earlier.
  if (svc.keys.deepseek && status.toPersonalize > 0) await personalizeNext(svc, db, Math.min(opts.limit, room, 20)).catch(() => undefined);
  const people = await pendingOutreach(db, Math.min(opts.limit, room, 50));
  if (!people.length) return summary;

  const contactOf = new Map<string, SavedPerson>();
  for (const p of people) {
    try {
      const contactId = await createContact(svc, toApolloContact(p, fields));
      contactOf.set(contactId, p);
      await db.query('UPDATE people SET apollo_contact_id = $2 WHERE id = $1', [p.id, contactId]);
    } catch (e) {
      summary.failed++;
      summary.error = (e as Error).message;
    }
  }
  if (!contactOf.size) return summary;

  // If this fails, the contacts exist in Apollo but nobody is marked, so the same people go next time (Apollo matches
  // them by email, so no duplicates are created).
  const res = await addToSequence(svc, opts.sequenceId, [...contactOf.keys()], opts.emailAccountId);
  const added = new Set(res.added);
  for (const [contactId, p] of contactOf) {
    const reason = res.skipped[contactId];
    const result = reason ? 'skipped' : added.has(contactId) ? 'added' : 'skipped';
    if (result === 'added') summary.added++;
    else {
      summary.skipped++;
      const why = skipReason(reason ?? 'not added');
      summary.reasons[why] = (summary.reasons[why] ?? 0) + 1;
    }
    await db.query('UPDATE people SET sequence_status = $2, apollo_sequence_id = $3, sequence_note = $4, sequenced_at = now() WHERE id = $1', [
      p.id,
      result,
      opts.sequenceId,
      result === 'added' ? '' : skipReason(reason ?? 'not added'),
    ]);
  }
  summary.requested = contactOf.size;
  await db.query('INSERT INTO outreach_log (campaign_id, requested, added, skipped) VALUES ($1, $2, $3, $4)', [opts.sequenceId, summary.requested, summary.added, summary.skipped]);
  return summary;
}

/** People held back from an earlier rule, for the team to write an opener by hand (normally empty now). */
export async function heldBack(db: Db, limit = 50): Promise<SavedPerson[]> {
  await ensureSchema(db);
  return db.query<SavedPerson>(
    `SELECT ${COLUMNS} FROM people WHERE ${READY_SQL} AND email <> '' AND sequence_status = '' AND opener_status = 'none'
     ORDER BY COALESCE(rank, 3) ASC, id ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 200))],
  );
}

/**
 * A test: one saved person's real personalized email, sent through the sequence to an address the team owns. The test
 * contact gets a separate company name so Apollo never treats the real person's company as already in the sequence,
 * and an unsubscribe link that unsubscribes nobody. The real person is not contacted or marked.
 */
export async function sendTest(svc: Services, db: Db, opts: { sequenceId: string; emailAccountId: string; testEmail: string; personId?: number | string }): Promise<{ added: boolean; reason?: string }> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.testEmail)) throw new Error('Enter a valid test email address.');
  const fields = await requireFields(svc);
  await ensureSchema(db);
  const [person] = opts.personId
    ? await db.query<SavedPerson>(`SELECT ${COLUMNS} FROM people WHERE id = $1`, [opts.personId])
    : await db.query<SavedPerson>(`SELECT ${COLUMNS} FROM people WHERE ${READY_SQL} ORDER BY (opener_status = 'done') DESC, COALESCE(rank, 3), id LIMIT 1`);
  const sample: ContactSource = person ?? { id: TEST_ID, name: 'Test Person', title: 'CEO', company: 'Example Company', email: '', opener: '' };
  const contactId = await createContact(svc, toApolloContact({ ...sample, email: opts.testEmail }, fields, { unsubscribeId: TEST_ID, organizationName: 'Humans of Globe (test)' }));
  const res = await addToSequence(svc, opts.sequenceId, [contactId], opts.emailAccountId);
  const reason = res.skipped[contactId];
  return { added: !reason && res.added.includes(contactId), reason: reason ? skipReason(reason) : undefined };
}
