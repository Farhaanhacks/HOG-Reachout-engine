import { getJson, type Services } from './services';
import { getSetting, setSetting } from './settings';
import { ensureSchema, type Db } from './store';

/**
 * What happened to every email: Apollo's record of each email sent from our sequences (delivered, bounced, blocked as
 * spam, replied and how, opened), copied into the messages table and joined to the leads, for the inbox health checks and
 * the Results page. Reading it costs no Apollo credits.
 */

const URL_BASE = 'https://api.apollo.io/api/v1/emailer_messages/search';
const PER_PAGE = 100;
/** Replies that are interest: a meeting, a question, or pointing to the right person. */
export const INTERESTED = ['willing_to_meet', 'follow_up_question', 'person_referral'];
/** Replies that mean "do not contact me again". */
export const OPTED_OUT_REPLIES = ['unsubscribe', 'not_interested'];
const REPLY_CLASSES = [...INTERESTED, 'out_of_office', 'already_left_company_or_not_right_person', 'not_interested', 'unsubscribe', 'none_of_the_above'];

type ApolloMessage = {
  id?: string;
  contact_id?: string | null;
  emailer_campaign_id?: string | null;
  email_account_id?: string | null;
  from_email?: string | null;
  to_email?: string | null;
  status?: string | null;
  campaign_position?: number | null;
  completed_at?: string | null;
  failed_at?: string | null;
  due_at?: string | null;
  created_at?: string | null;
  bounce?: boolean | null;
  spam_blocked?: boolean | null;
  replied?: boolean | null;
  reply_class?: string | null;
  not_sent_reason?: string | null;
};

const day = (d: Date) => d.toISOString().slice(0, 10);

function url(params: { sequences: string[]; from: string; to: string; page: number; stats?: string[]; replyClasses?: string[] }): string {
  const parts: string[] = [];
  const add = (k: string, v: string) => parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  for (const s of params.sequences) add('emailer_campaign_ids[]', s);
  for (const s of params.stats ?? []) add('emailer_message_stats[]', s);
  for (const r of params.replyClasses ?? []) add('emailer_message_reply_classes[]', r);
  add('emailer_message_date_range_mode', 'completed_at');
  add('emailer_message_date_range[min]', params.from);
  add('emailer_message_date_range[max]', params.to);
  add('page', String(params.page));
  add('per_page', String(PER_PAGE));
  return `${URL_BASE}?${parts.join('&')}`;
}

async function saveMessages(db: Db, list: ApolloMessage[], mark: { opened?: boolean; unsubscribed?: boolean }): Promise<void> {
  for (const m of list) {
    if (!m.id) continue;
    await db.query(
      `INSERT INTO messages (id, contact_id, sequence_id, email_account_id, from_email, to_email, status, step, completed_at, happened_at, bounced, spam_blocked,
         replied, reply_class, opened, not_sent_reason, unsubscribed, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, completed_at = COALESCE(EXCLUDED.completed_at, messages.completed_at),
         happened_at = COALESCE(EXCLUDED.happened_at, messages.happened_at), bounced = messages.bounced OR EXCLUDED.bounced,
         spam_blocked = messages.spam_blocked OR EXCLUDED.spam_blocked, replied = messages.replied OR EXCLUDED.replied,
         reply_class = COALESCE(NULLIF(EXCLUDED.reply_class, ''), messages.reply_class), opened = messages.opened OR EXCLUDED.opened,
         not_sent_reason = EXCLUDED.not_sent_reason, unsubscribed = messages.unsubscribed OR EXCLUDED.unsubscribed, synced_at = now()`,
      [
        m.id,
        m.contact_id ?? '',
        m.emailer_campaign_id ?? '',
        m.email_account_id ?? '',
        m.from_email ?? '',
        m.to_email ?? '',
        m.status ?? '',
        m.campaign_position ?? null,
        m.completed_at ?? null,
        m.completed_at ?? m.failed_at ?? m.due_at ?? m.created_at ?? null,
        !!m.bounce,
        !!m.spam_blocked,
        !!m.replied || !!m.reply_class,
        m.reply_class ?? '',
        !!mark.opened,
        m.not_sent_reason ?? '',
        !!mark.unsubscribed,
      ],
    );
  }
}

export type SyncSummary = { messages: number; passes: number; complete: boolean; error?: string; syncedAt: string };

/**
 * Copies Apollo's email records for every sequence the engine has used: recent emails (since a few days before the last
 * sync, or the past 7 days the first time), and over the past 30 days the ones that bounced, were blocked, got a reply or
 * (past 7 days) were opened, since those change after sending. Stops at the time budget and continues next time.
 */
export async function syncMessages(svc: Services, db: Db, opts: { budgetMs?: number; now?: Date } = {}): Promise<SyncSummary> {
  await ensureSchema(db);
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const summary: SyncSummary = { messages: 0, passes: 0, complete: true, syncedAt: now.toISOString() };
  if (!svc.keys.apollo) return { ...summary, complete: false, error: 'APOLLO_API_KEY is not set' };
  const sequences = (await db.query<{ id: string }>("SELECT DISTINCT apollo_sequence_id AS id FROM people WHERE apollo_sequence_id <> ''")).map((r) => r.id);
  if (!sequences.length) return summary;

  const last = await getSetting<string>(db, 'messagesSyncedAt', '');
  const daysAgo = (n: number) => day(new Date(now.getTime() - n * 86_400_000));
  const recentFrom = last ? day(new Date(Math.max(Date.parse(last) - 3 * 86_400_000, now.getTime() - 30 * 86_400_000))) : daysAgo(7);
  const to = day(new Date(now.getTime() + 86_400_000));
  const passes: { from: string; stats?: string[]; replyClasses?: string[]; opened?: boolean; unsubscribed?: boolean }[] = [
    { from: recentFrom },
    { from: daysAgo(30), stats: ['bounced'] },
    { from: daysAgo(30), stats: ['spam_blocked'] },
    { from: daysAgo(30), replyClasses: REPLY_CLASSES },
    { from: daysAgo(30), stats: ['unsubscribed'], unsubscribed: true },
    { from: daysAgo(7), stats: ['opened'], opened: true },
  ];
  const key = svc.keys.apollo;
  try {
    for (const p of passes) {
      for (let page = 1; page <= 50; page++) {
        if (Date.now() > deadline) {
          summary.complete = false;
          break;
        }
        const res = await getJson<{ emailer_messages?: ApolloMessage[] }>(
          svc,
          url({ sequences, from: p.from, to, page, stats: p.stats, replyClasses: p.replyClasses }),
          { headers: { 'x-api-key': key, accept: 'application/json', 'cache-control': 'no-cache' } },
        );
        const list = res.emailer_messages ?? [];
        await saveMessages(db, list, { opened: p.opened, unsubscribed: p.unsubscribed });
        summary.messages += list.length;
        if (list.length < PER_PAGE) break;
      }
      if (!summary.complete) break;
      summary.passes++;
    }
  } catch (e) {
    summary.complete = false;
    summary.error = (e as Error).message;
  }
  await markOptOuts(db);
  if (summary.complete) await setSetting(db, 'messagesSyncedAt', now.toISOString());
  return summary;
}

/**
 * Anyone who opted out through Apollo (its unsubscribe link or one-click header) or replied "unsubscribe" or "not
 * interested" is marked unsubscribed, so the engine never contacts them again. Apollo has already stopped their
 * sequence, so nothing is sent to Apollo.
 */
export async function markOptOuts(db: Db): Promise<number> {
  const rows = await db.query(
    `UPDATE people SET unsubscribed_at = now(), unsubscribe_blocked = TRUE
     WHERE unsubscribed_at IS NULL AND apollo_contact_id <> '' AND apollo_contact_id IN (
       SELECT contact_id FROM messages WHERE unsubscribed OR reply_class IN (${OPTED_OUT_REPLIES.map((c) => `'${c}'`).join(', ')})
     ) RETURNING id`,
  );
  return rows.length;
}

/** When the last complete sync finished, or ''. */
export async function lastSync(db: Db): Promise<string> {
  return getSetting<string>(db, 'messagesSyncedAt', '');
}

/** Syncs only if the last complete sync is older than `maxAgeMs` (used before sending, to catch a burning inbox). */
export async function syncIfStale(svc: Services, db: Db, maxAgeMs: number, budgetMs: number): Promise<SyncSummary | null> {
  const last = await lastSync(db);
  if (last && Date.now() - Date.parse(last) < maxAgeMs) return null;
  return syncMessages(svc, db, { budgetMs });
}

export type Metrics = {
  /** People emailed at least once. */
  people: number;
  emails: number;
  bounced: number;
  spam: number;
  opened: number;
  replied: number;
  interested: number;
  unsubscribed: number;
};

export type GroupRow = Metrics & { group: string };

const METRICS_SQL = `count(DISTINCT p.id) FILTER (WHERE m.completed_at IS NOT NULL)::int AS people,
  count(m.id) FILTER (WHERE m.completed_at IS NOT NULL)::int AS emails,
  count(DISTINCT p.id) FILTER (WHERE m.bounced)::int AS bounced,
  count(m.id) FILTER (WHERE m.spam_blocked)::int AS spam,
  count(DISTINCT p.id) FILTER (WHERE m.opened)::int AS opened,
  count(DISTINCT p.id) FILTER (WHERE m.replied)::int AS replied,
  count(DISTINCT p.id) FILTER (WHERE m.reply_class IN (${INTERESTED.map((c) => `'${c}'`).join(', ')}))::int AS interested,
  count(DISTINCT p.id) FILTER (WHERE p.unsubscribed_at IS NOT NULL)::int AS unsubscribed`;

/** Groups the Results page breaks the numbers down by. Each is an SQL expression over the lead (p) or the email (m). */
export const GROUPS = {
  segment: { label: 'Segment', sql: "COALESCE(NULLIF(p.segment, ''), 'Earlier leads')" },
  size: { label: 'Company size', sql: "CASE p.firm_size WHEN 'small' THEN 'Small (up to 50)' WHEN 'large' THEN 'Large (51+)' ELSE 'Unknown' END" },
  market: { label: 'Market', sql: "CASE p.geo WHEN 'af' THEN 'Africa' WHEN 'eu' THEN 'Europe' WHEN 'us' THEN 'US' WHEN 'ae' THEN 'UAE' WHEN 'uk' THEN 'UK' WHEN 'ca' THEN 'Canada' ELSE p.geo END" },
  country: { label: 'Country', sql: "COALESCE(NULLIF(p.country, ''), 'Unknown')" },
  title: { label: 'Target title', sql: "COALESCE(NULLIF(p.target_title, ''), NULLIF(p.title, ''), 'Unknown')" },
  sector: { label: 'Title rules used', sql: "CASE p.sector WHEN 'healthcare' THEN 'Healthcare' WHEN 'hospitality' THEN 'Hospitality' WHEN 'general' THEN 'Other industries' ELSE 'Earlier leads' END" },
  opener: { label: 'Opener', sql: "CASE WHEN p.opener_fact LIKE 'role and company%' THEN 'From role and company' WHEN p.opener_fact = 'edited by the team' THEN 'Written by the team' ELSE 'From the news' END" },
  inbox: { label: 'Sending inbox', sql: "COALESCE(NULLIF(m.from_email, ''), 'Unknown')" },
} as const;

export type GroupKey = keyof typeof GROUPS;

export async function totals(db: Db, days = 30): Promise<Metrics> {
  await ensureSchema(db);
  const [row] = await db.query<Metrics>(
    `SELECT ${METRICS_SQL} FROM messages m JOIN people p ON p.apollo_contact_id = m.contact_id AND p.apollo_contact_id <> ''
     WHERE m.happened_at >= now() - ($1::int * interval '1 day')`,
    [days],
  );
  return row;
}

export async function breakdown(db: Db, group: GroupKey, days = 30): Promise<GroupRow[]> {
  await ensureSchema(db);
  return db.query<GroupRow>(
    `SELECT ${GROUPS[group].sql} AS "group", ${METRICS_SQL}
     FROM messages m JOIN people p ON p.apollo_contact_id = m.contact_id AND p.apollo_contact_id <> ''
     WHERE m.happened_at >= now() - ($1::int * interval '1 day')
     GROUP BY 1 ORDER BY people DESC, 1 LIMIT 30`,
    [days],
  );
}

export type Reply = { id: number | string; name: string; title: string; company: string; email: string; country: string; segment: string; reply_class: string; at: string; from_email: string };

/** Everyone who replied, newest first, with the kind of reply. */
export async function replies(db: Db, limit = 100): Promise<Reply[]> {
  await ensureSchema(db);
  return db.query<Reply>(
    `SELECT * FROM (
       SELECT DISTINCT ON (p.id) p.id, p.name, p.title, p.company, p.email, p.country, p.segment, m.reply_class, m.happened_at AS at, m.from_email
       FROM messages m JOIN people p ON p.apollo_contact_id = m.contact_id AND p.apollo_contact_id <> ''
       WHERE m.replied ORDER BY p.id, m.happened_at DESC NULLS LAST
     ) r ORDER BY at DESC NULLS LAST LIMIT $1`,
    [Math.max(1, Math.min(limit, 500))],
  );
}
