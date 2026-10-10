import { geoShort } from './geo';
import { addLeads, type InstantlyLead } from './instantly';
import { draftEmail } from './pitch';
import type { Services } from './services';
import { READY_SQL, ensureSchema, type Db, type SavedPerson } from './store';

export const DEFAULT_OUTREACH_DAILY_LIMIT = 500;

/** The most leads sent to Instantly per day: INSTANTLY_DAILY_LIMIT, or 500. Instantly itself paces the actual sending per mailbox. */
export function outreachDailyLimitFromEnv(): number {
  return Math.max(1, Number(process.env.INSTANTLY_DAILY_LIMIT) || DEFAULT_OUTREACH_DAILY_LIMIT);
}

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A saved person as an Instantly lead. The draft travels as custom variables, so the campaign's email step can be just
 * {{subject}} and {{body_html}} (or {{body}}): each lead then receives their own email.
 */
export function toInstantlyLead(p: Pick<SavedPerson, 'name' | 'title' | 'company' | 'email' | 'linkedin_url' | 'geo'>): InstantlyLead {
  const d = draftEmail(p);
  const words = p.name.trim().split(/\s+/).filter(Boolean);
  const at = words.findIndex((w) => w.toLowerCase() === d.firstName.toLowerCase());
  const lastName = at >= 0 ? words.slice(at + 1).join(' ') : words.slice(1).join(' ');
  const lead: InstantlyLead = {
    email: p.email,
    custom_variables: {
      subject: d.subject,
      body: d.body,
      body_html: d.body.split('\n').map(html).join('<br>'),
      linkedin: p.linkedin_url,
      country: geoShort(p.geo),
    },
  };
  if (d.firstName !== 'there') lead.first_name = d.firstName;
  if (lastName) lead.last_name = lastName;
  if (p.company) lead.company_name = p.company;
  if (p.title) lead.job_title = p.title;
  return lead;
}

const COLUMNS = `id, linkedin_url, name, title, company, location, geo, geo_match, labels, is_target, inferred, status, seen_count, first_seen, last_seen,
  email, email_status, apollo_status, apollo_confidence, apollo_tier, rank, company_employees, company_size, instantly_status, instantly_at`;

/** Who goes to Instantly next: people with an email ready who have not been sent yet; main people first, then in the order they got their email. */
export async function pendingOutreach(db: Db, limit: number): Promise<SavedPerson[]> {
  await ensureSchema(db);
  return db.query<SavedPerson>(
    `SELECT ${COLUMNS} FROM people
     WHERE ${READY_SQL} AND email <> '' AND instantly_status = ''
     ORDER BY COALESCE(rank, 3) ASC, apollo_checked_at ASC NULLS LAST, id ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 1000))],
  );
}

export type OutreachStatus = { waiting: number; sent: number; skipped: number; sentToday: number; dailyLimit: number };

export async function outreachStatus(db: Db, dailyLimit = DEFAULT_OUTREACH_DAILY_LIMIT): Promise<OutreachStatus> {
  await ensureSchema(db);
  const [p] = await db.query<{ waiting: number; sent: number; skipped: number }>(
    `SELECT count(*) FILTER (WHERE ${READY_SQL} AND email <> '' AND instantly_status = '')::int AS waiting,
            count(*) FILTER (WHERE instantly_status = 'added')::int AS sent,
            count(*) FILTER (WHERE instantly_status = 'skipped')::int AS skipped
     FROM people`,
  );
  const [t] = await db.query<{ n: number }>(`SELECT coalesce(sum(requested), 0)::int AS n FROM outreach_log WHERE ran_at >= date_trunc('day', now())`);
  return { waiting: p?.waiting ?? 0, sent: p?.sent ?? 0, skipped: p?.skipped ?? 0, sentToday: t?.n ?? 0, dailyLimit };
}

export type PushSummary = {
  requested: number;
  added: number;
  /** Already in Instantly, a duplicate, blocklisted or an invalid email: Instantly did not add them. */
  skipped: number;
  invalid: number;
  blocklisted: number;
  remainingInPlan?: number;
  stopped?: string;
};

/**
 * Sends the next people with an email ready to an Instantly campaign, up to the daily cap. People Instantly creates are
 * marked "added"; people it declines (already in the workspace, duplicate, blocklisted, invalid) are marked "skipped",
 * so neither is sent again. If the request fails, nobody is marked and the same people go next time.
 */
export async function pushToInstantly(svc: Services, db: Db, opts: { campaignId: string; limit: number; dailyLimit?: number }): Promise<PushSummary> {
  const dailyLimit = opts.dailyLimit ?? DEFAULT_OUTREACH_DAILY_LIMIT;
  const status = await outreachStatus(db, dailyLimit);
  const room = dailyLimit - status.sentToday;
  const none: PushSummary = { requested: 0, added: 0, skipped: 0, invalid: 0, blocklisted: 0 };
  if (room <= 0) return { ...none, stopped: `Daily limit of ${dailyLimit} leads sent to Instantly reached` };
  const people = await pendingOutreach(db, Math.min(opts.limit, room));
  if (!people.length) return none;

  const res = await addLeads(svc, opts.campaignId, people.map(toInstantlyLead));
  const created = new Map(res.created_leads.map((c) => [c.index, c.id]));
  let added = 0;
  for (let i = 0; i < people.length; i++) {
    const id = created.get(i);
    if (id) added++;
    await db.query(`UPDATE people SET instantly_status = $2, instantly_lead_id = $3, instantly_campaign_id = $4, instantly_at = now() WHERE id = $1`, [
      people[i].id,
      id ? 'added' : 'skipped',
      id ?? '',
      opts.campaignId,
    ]);
  }
  await db.query('INSERT INTO outreach_log (campaign_id, requested, added, skipped) VALUES ($1, $2, $3, $4)', [opts.campaignId, people.length, added, people.length - added]);
  return {
    requested: people.length,
    added,
    skipped: people.length - added,
    invalid: res.invalid_email_count,
    blocklisted: res.in_blocklist,
    remainingInPlan: res.remaining_in_plan,
  };
}

/**
 * A test: one saved person's email (their real draft) sent to an address the team owns, so the campaign's formatting can
 * be checked in a real inbox. The person themself is not contacted and not marked.
 */
export async function sendTest(svc: Services, db: Db, opts: { campaignId: string; testEmail: string; personId?: number | string }): Promise<{ added: boolean; skipped: number }> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.testEmail)) throw new Error('Enter a valid test email address.');
  await ensureSchema(db);
  const [person] = opts.personId
    ? await db.query<SavedPerson>(`SELECT ${COLUMNS} FROM people WHERE id = $1`, [opts.personId])
    : await db.query<SavedPerson>(`SELECT ${COLUMNS} FROM people WHERE ${READY_SQL} ORDER BY COALESCE(rank, 3), id LIMIT 1`);
  const sample = person ?? { name: 'Test Person', title: 'CEO', company: 'Example Company', linkedin_url: '', geo: 'ae', email: '' };
  const res = await addLeads(svc, opts.campaignId, [toInstantlyLead({ ...sample, email: opts.testEmail })], { skipIfInWorkspace: false });
  return { added: res.created_leads.length > 0, skipped: res.skipped_count + res.duplicate_email_count + res.duplicated_leads };
}
