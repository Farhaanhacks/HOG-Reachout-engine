import { addToSequence, createContact, findCustomFields, missingFields, skipReason, type ApolloContactInput, type FieldIds } from './apollo-sequences';
import { BRANDS, brandOfEmail, isBrand, type Brand } from './brands';
import { allocate, autoPause, mailboxStates, senderNameOf, syncMailboxes, type MailboxState } from './deliverability';
import { personalizeNext } from './personalize';
import { draftEmail, fallbackOpenerFor, firstNameOf, roleFor, subjectFor, unsubscribeLine, type UnsubscribeStyle, type Variant } from './pitch';
import { mapLimit, type Services } from './services';
import { getSettings } from './settings';
import { PERSON_COLUMNS, READY_SQL, ensureSchema, type Db, type SavedPerson } from './store';
import { editionFor, editionTitle, type Edition } from './targeting';
import { syncIfStale } from './tracking';
import { TEST_ID, unsubscribeUrl } from './unsubscribe';

export const DEFAULT_OUTREACH_DAILY_LIMIT = 500;
/** People added per click; "Send all ready" repeats it. */
export const BATCH = 25;

/** The most people added to Apollo sequences per day across all inboxes: OUTREACH_DAILY_LIMIT, or 500. */
export function outreachDailyLimitFromEnv(): number {
  return Math.max(1, Number(process.env.OUTREACH_DAILY_LIMIT) || DEFAULT_OUTREACH_DAILY_LIMIT);
}

/** The label every contact the engine creates in Apollo gets, so the team can find them there. */
export const APOLLO_LABEL = 'Humans of Globe lead engine';

type ContactSource = Pick<SavedPerson, 'id' | 'name' | 'title' | 'company' | 'email' | 'opener'> & {
  industry?: string;
  segment?: string;
  edition_name?: string;
  brand?: string;
};

/**
 * The personal parts of a person's email, as they go into Apollo's custom fields: the subject, the congratulations
 * line, their role, the edition they are shortlisted for (from the news research, or the edition table for their
 * industry), the industry line and their unsubscribe link.
 */
export function emailParts(p: ContactSource, opts: { unsubscribeId?: number | string; editions?: Edition[]; senderName?: string } = {}) {
  const e = editionFor(p.industry, opts.editions);
  return {
    subject: subjectFor(p.company),
    opener: p.opener?.trim() || fallbackOpenerFor(p.company),
    role: roleFor(p.title, p.company),
    edition: p.edition_name?.trim() || editionTitle(e),
    industry: e.industryLine,
    sender: opts.senderName?.trim() || 'The editorial team',
    unsubscribe: unsubscribeUrl(opts.unsubscribeId ?? p.id),
  };
}

/** The full email a person will receive (version A unless asked), as their brand's sequence template renders it. For previews. */
export function fullEmail(
  p: ContactSource,
  opts: { unsubscribeId?: number | string; editions?: Edition[]; style?: UnsubscribeStyle; variant?: Variant; senderName?: string } = {},
): { subject: string; body: string } {
  const parts = emailParts(p, opts);
  const brand: Brand = isBrand(p.brand) ? p.brand : 'hog';
  const d = draftEmail({ ...p, opener: parts.opener, edition: parts.edition, brand, variant: opts.variant ?? 'A', senderName: opts.senderName });
  return { subject: parts.subject, body: `${d.body}\n\n${unsubscribeLine(opts.style ?? 'button', parts.unsubscribe)}` };
}

/** A saved person as an Apollo contact, with their personal parts in the custom fields. */
export function toApolloContact(
  p: ContactSource,
  fields: FieldIds,
  opts: { unsubscribeId?: number | string; organizationName?: string; editions?: Edition[]; senderName?: string } = {},
): ApolloContactInput {
  const firstName = firstNameOf(p.name);
  const parts = emailParts(p, opts);
  const words = p.name.trim().split(/\s+/).filter(Boolean);
  const at = words.findIndex((w) => w.toLowerCase() === firstName.toLowerCase());
  const lastName = at >= 0 ? words.slice(at + 1).join(' ') : words.slice(1).join(' ');
  const custom: Record<string, string> = {};
  for (const k of Object.keys(parts) as (keyof typeof parts)[]) {
    const id = fields[k];
    if (id) custom[id] = parts[k];
  }
  const contact: ApolloContactInput = { email: p.email, label_names: [APOLLO_LABEL], typed_custom_fields: custom };
  if (firstName) contact.first_name = firstName;
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

/**
 * Who goes to Apollo next for a brand: its people who can be emailed (verified email, target title, not suppressed or
 * unsubscribed) with a personal opener, not sent yet; main people first, then in the order they were found.
 */
export async function pendingOutreach(db: Db, limit: number, brand: Brand = 'hog'): Promise<SavedPerson[]> {
  await ensureSchema(db);
  return db.query<SavedPerson>(
    `SELECT ${PERSON_COLUMNS} FROM people
     WHERE ${READY_SQL} AND brand = $2 AND sequence_status = '' AND opener_status = 'done' AND opener <> ''
     ORDER BY COALESCE(rank, 3) ASC, apollo_checked_at ASC NULLS LAST, id ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 1000)), brand],
  );
}

/** A brand's own inboxes: those on its domain. Every other inbox is left out, so a lead only hears from its own brand. */
export function brandInboxes(inboxes: MailboxState[], brand: Brand): MailboxState[] {
  return inboxes.filter((s) => brandOfEmail(s.email) === brand);
}

export type OutreachStatus = {
  /** Personalized and ready to send. */
  waiting: number;
  /** Ready to send but not personalized yet (it happens automatically). */
  toPersonalize: number;
  sent: number;
  skipped: number;
  unsubscribed: number;
  /** Leads with an email that is not verified, or a title that is not a target: never sent. */
  notSendable: number;
  /** Leads the suppression list blocks. */
  suppressed: number;
  sentToday: number;
  dailyLimit: number;
};

/** Counts for one brand's leads (or every lead without a brand). The daily cap is shared by all brands. */
export async function outreachStatus(db: Db, dailyLimit = DEFAULT_OUTREACH_DAILY_LIMIT, brand?: Brand): Promise<OutreachStatus> {
  await ensureSchema(db);
  const unsent = `${READY_SQL} AND sequence_status = ''`;
  const [p] = await db.query<{ waiting: number; to_personalize: number; sent: number; skipped: number; unsubscribed: number; not_sendable: number; suppressed: number }>(
    `SELECT count(*) FILTER (WHERE ${unsent} AND opener_status = 'done' AND opener <> '')::int AS waiting,
            count(*) FILTER (WHERE ${unsent} AND opener_status IN ('', 'none'))::int AS to_personalize,
            count(*) FILTER (WHERE sequence_status = 'added')::int AS sent,
            count(*) FILTER (WHERE sequence_status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed,
            count(*) FILTER (WHERE email <> '' AND (email_status <> 'verified' OR icp_fit = FALSE))::int AS not_sendable,
            count(*) FILTER (WHERE email <> '' AND suppressed_reason <> '')::int AS suppressed
     FROM people ${brand ? 'WHERE brand = $1' : ''}`,
    brand ? [brand] : [],
  );
  const [t] = await db.query<{ n: number }>(`SELECT coalesce(sum(requested), 0)::int AS n FROM outreach_log WHERE ran_at >= date_trunc('day', now())`);
  return {
    waiting: p?.waiting ?? 0,
    toPersonalize: p?.to_personalize ?? 0,
    sent: p?.sent ?? 0,
    skipped: p?.skipped ?? 0,
    unsubscribed: p?.unsubscribed ?? 0,
    notSendable: p?.not_sendable ?? 0,
    suppressed: p?.suppressed ?? 0,
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
  /** How many went to each inbox. */
  byInbox: Record<string, number>;
  /** Inboxes paused just now for bounces or spam blocks. */
  paused: { email: string; reason: string }[];
  error?: string;
  stopped?: string;
};

/** Room left today for a brand: the overall daily cap, and each of the brand's own inboxes' (warm-up) limit. */
export async function sendingRoom(db: Db, dailyLimit: number, emailsPerPerson: number, brand: Brand = 'hog'): Promise<{ room: number; inboxes: MailboxState[] }> {
  const status = await outreachStatus(db, dailyLimit);
  const inboxes = brandInboxes(await mailboxStates(db, emailsPerPerson), brand);
  const inboxRoom = inboxes.reduce((n, s) => n + s.room, 0);
  return { room: Math.max(0, Math.min(dailyLimit - status.sentToday, inboxRoom)), inboxes };
}

/**
 * Sends the next people with a personalized email ready into an Apollo sequence. First the inbox list is refreshed from
 * Apollo and, if the last check is over half an hour old, bounces and spam blocks are read and any inbox over the limits
 * is paused. Then each of the brand's people is created as an Apollo contact (their personal parts in custom fields) and
 * given to one of the brand's own inboxes: they take turns, each within its warm-up limit for today.
 */
export async function pushToApollo(svc: Services, db: Db, opts: { sequenceId: string; limit: number; dailyLimit?: number; brand?: Brand }): Promise<PushSummary> {
  const brand = opts.brand ?? 'hog';
  if (!opts.sequenceId) throw new Error('Choose an Apollo sequence first.');
  const fields = await requireFields(svc);
  const settings = await getSettings(db);
  const dailyLimit = opts.dailyLimit ?? DEFAULT_OUTREACH_DAILY_LIMIT;
  const summary: PushSummary = { requested: 0, added: 0, skipped: 0, failed: 0, reasons: {}, byInbox: {}, paused: [] };

  await syncMailboxes(svc, db);
  await syncIfStale(svc, db, 30 * 60_000, 15_000).catch(() => null);
  summary.paused = await autoPause(db, settings.emailsPerPerson);

  const { room, inboxes } = await sendingRoom(db, dailyLimit, settings.emailsPerPerson, brand);
  if (!inboxes.some((s) => s.usable)) {
    return { ...summary, stopped: `No ${BRANDS[brand].label} inbox (@${BRANDS[brand].domain}) can send: connect one in Apollo, or turn one on or resume it on the Deliverability page` };
  }
  if (room <= 0) return { ...summary, stopped: "Today's sending limit is used up across all inboxes (their warm-up limits and the daily cap). More can go tomorrow" };
  // Safety net: the pages normally personalize earlier.
  const status = await outreachStatus(db, dailyLimit, brand);
  if (svc.keys.deepseek && status.toPersonalize > 0) await personalizeNext(svc, db, Math.min(opts.limit, room, 10)).catch(() => undefined);
  const people = await pendingOutreach(db, Math.min(opts.limit, room, BATCH), brand);
  if (!people.length) return summary;

  // Each person's inbox is chosen first, so their email is signed with that inbox's own name.
  const inboxFor = allocate(inboxes, people.length);
  const byId = new Map(inboxes.map((s) => [s.id, s]));
  const contacts = await mapLimit(people.slice(0, inboxFor.length), 4, async (p, i) => {
    const inbox = inboxFor[i];
    try {
      const contactId = await createContact(svc, toApolloContact(p, fields, { editions: settings.editions, senderName: senderNameOf(byId.get(inbox) ?? { email: '' }) }));
      await db.query('UPDATE people SET apollo_contact_id = $2 WHERE id = $1', [p.id, contactId]);
      return { p, contactId, inbox };
    } catch (e) {
      summary.failed++;
      summary.error = (e as Error).message;
      return null;
    }
  });
  const created = contacts.filter((c): c is { p: SavedPerson; contactId: string; inbox: string } => !!c);
  if (!created.length) return summary;

  const groups = new Map<string, { p: SavedPerson; contactId: string }[]>();
  for (const c of created) groups.set(c.inbox, [...(groups.get(c.inbox) ?? []), c]);
  const emailOf = new Map(inboxes.map((s) => [s.id, s.email]));

  for (const [inbox, list] of groups) {
    let res: Awaited<ReturnType<typeof addToSequence>>;
    try {
      res = await addToSequence(svc, opts.sequenceId, list.map((c) => c.contactId), inbox);
    } catch (e) {
      // The contacts exist in Apollo but nobody is marked, so the same people go next time (Apollo matches them by email).
      summary.failed += list.length;
      summary.error = (e as Error).message;
      continue;
    }
    const added = new Set(res.added);
    for (const { p, contactId } of list) {
      const reason = res.skipped[contactId];
      const ok = !reason && added.has(contactId);
      if (ok) {
        summary.added++;
        summary.byInbox[emailOf.get(inbox) ?? inbox] = (summary.byInbox[emailOf.get(inbox) ?? inbox] ?? 0) + 1;
      } else {
        summary.skipped++;
        const why = skipReason(reason ?? 'not added');
        summary.reasons[why] = (summary.reasons[why] ?? 0) + 1;
      }
      await db.query(
        `UPDATE people SET sequence_status = $2, apollo_sequence_id = $3, sequence_note = $4, sequenced_at = now(), sent_from = $5, sent_from_email = $6 WHERE id = $1`,
        [p.id, ok ? 'added' : 'skipped', opts.sequenceId, ok ? '' : skipReason(reason ?? 'not added'), ok ? inbox : '', ok ? (emailOf.get(inbox) ?? '') : ''],
      );
    }
    summary.requested += list.length;
  }
  if (summary.requested) {
    await db.query('INSERT INTO outreach_log (campaign_id, requested, added, skipped) VALUES ($1, $2, $3, $4)', [opts.sequenceId, summary.added, summary.added, summary.skipped]);
  }
  return summary;
}

/** People held back from an earlier rule, for the team to write an opener by hand (normally empty now). */
export async function heldBack(db: Db, limit = 50): Promise<SavedPerson[]> {
  await ensureSchema(db);
  return db.query<SavedPerson>(
    `SELECT ${PERSON_COLUMNS} FROM people WHERE ${READY_SQL} AND sequence_status = '' AND opener_status = 'none'
     ORDER BY COALESCE(rank, 3) ASC, id ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 200))],
  );
}

/** Providers that deliver name+tag@domain to name@domain, so each test can be a new Apollo contact in the same inbox. */
const PLUS_ADDRESSING = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com']);

/**
 * The address a test goes to: for providers that support it, a fresh +tag (me+hogtest1a2b@gmail.com), which arrives in
 * the same inbox but is a new contact to Apollo, so a test never collides with an earlier test already in the sequence.
 */
export function testAddress(email: string, tag: string = Date.now().toString(36)): string {
  const [local, domain] = email.trim().split('@');
  if (!local || !domain || !PLUS_ADDRESSING.has(domain.toLowerCase())) return email.trim();
  return `${local.split('+')[0]}+hogtest${tag}@${domain}`;
}

/**
 * A test: one saved person's real personalized email, sent through the sequence to an address the team owns, from the
 * chosen inbox (or the first one that can send). The test contact gets a separate company name so Apollo never treats
 * the real person's company as already in the sequence, and an unsubscribe link that unsubscribes nobody. The real
 * person is not contacted or marked.
 */
export async function sendTest(
  svc: Services,
  db: Db,
  opts: { sequenceId: string; emailAccountId?: string; testEmail: string; personId?: number | string; brand?: Brand },
): Promise<{ added: boolean; reason?: string; from: string; to: string }> {
  const brand = opts.brand ?? 'hog';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.testEmail)) throw new Error('Enter a valid test email address.');
  if (!opts.sequenceId) throw new Error('Choose an Apollo sequence first.');
  const fields = await requireFields(svc);
  const settings = await getSettings(db);
  await syncMailboxes(svc, db);
  // Tests send from the brand's own inboxes too.
  const inboxes = brandInboxes(await mailboxStates(db, settings.emailsPerPerson), brand);
  const inbox = inboxes.find((s) => s.id === opts.emailAccountId) ?? inboxes.find((s) => s.usable) ?? inboxes.find((s) => s.apollo_active);
  if (!inbox) throw new Error(`No ${BRANDS[brand].label} inbox (@${BRANDS[brand].domain}) is connected in Apollo yet.`);
  const [person] = opts.personId
    ? await db.query<SavedPerson>(`SELECT ${PERSON_COLUMNS} FROM people WHERE id = $1`, [opts.personId])
    : await db.query<SavedPerson>(
        `SELECT ${PERSON_COLUMNS} FROM people WHERE ${READY_SQL} ORDER BY (brand = $1) DESC, (opener_status = 'done') DESC, COALESCE(rank, 3), id LIMIT 1`,
        [brand],
      );
  const sample: ContactSource = person ?? { id: TEST_ID, name: 'Test Person', title: 'CEO', company: 'Example Company', email: '', opener: '' };
  const to = testAddress(opts.testEmail);
  const contactId = await createContact(
    svc,
    toApolloContact({ ...sample, email: to }, fields, {
      unsubscribeId: TEST_ID,
      organizationName: `${BRANDS[brand].label} (test)`,
      editions: settings.editions,
      senderName: senderNameOf(inbox),
    }),
    { dedupe: false },
  );
  const res = await addToSequence(svc, opts.sequenceId, [contactId], inbox.id, { allowUnverified: true });
  const reason = res.skipped[contactId];
  return { added: !reason && res.added.includes(contactId), reason: reason ? skipReason(reason) : undefined, from: inbox.email, to };
}
