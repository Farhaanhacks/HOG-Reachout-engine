import { listEmailAccounts } from './apollo-sequences';
import { getJson, mapLimit, type Services } from './services';
import { ensureSchema, type Db } from './store';

/**
 * Keeping the sending domains healthy: the six inboxes on two domains take turns, each inbox has a daily limit that
 * starts low and rises over weeks (the warm-up ramp), and every inbox and domain is watched for bounces and spam blocks.
 * An inbox (or a whole domain) that crosses the limits is paused automatically: nobody new is given to it until the team
 * resumes it.
 *
 * Warming an inbox up (exchanging emails with a network of real inboxes) is done by a warm-up service, such as the
 * warm-up setting on each mailbox in Apollo; this file does everything around it.
 */

/** A new inbox starts at 20 emails a day and adds 3 a day until it reaches its own limit (about two weeks to 50). */
export const RAMP_START = 20;
export const RAMP_STEP = 3;
/** Pause when more than 3% bounce or more than 1% are blocked as spam, once at least 20 emails were sent in 7 days. */
export const BOUNCE_LIMIT = 0.03;
export const SPAM_LIMIT = 0.01;
export const MIN_SENT = 20;
export const WINDOW_DAYS = 7;

type MailboxRow = {
  id: string;
  email: string;
  enabled: boolean;
  max_per_day: number;
  ramp: boolean;
  ramp_days: number;
  paused_reason: string;
  paused_at: string | null;
  apollo_active: boolean;
};

export type Health = { sent: number; bounced: number; spam: number; replied: number; opened: number; unsubscribed: number; bounceRate: number; spamRate: number };

export type MailboxState = MailboxRow & {
  domain: string;
  /** Emails it may send today: its limit, or less while it is still ramping up. */
  emailsToday: number;
  /** New people it can start today: its emails for today divided by the emails each person gets in the sequence. */
  newToday: number;
  addedToday: number;
  room: number;
  /** Can be given new people right now. */
  usable: boolean;
  health: Health;
};

const EMPTY: Health = { sent: 0, bounced: 0, spam: 0, replied: 0, opened: 0, unsubscribed: 0, bounceRate: 0, spamRate: 0 };

export const domainOf = (email: string) => (email.split('@')[1] ?? '').toLowerCase();

export function emailsToday(mb: { max_per_day: number; ramp: boolean; ramp_days: number }): number {
  if (!mb.ramp) return mb.max_per_day;
  return Math.min(mb.max_per_day, RAMP_START + RAMP_STEP * Math.max(0, mb.ramp_days));
}

export function newPeopleToday(emails: number, emailsPerPerson: number): number {
  return Math.max(0, Math.floor(emails / Math.max(1, emailsPerPerson)));
}

const rate = (n: number, of: number) => (of ? n / of : 0);

/** Adds inboxes connected in Apollo since last time, and notes the ones Apollo no longer has active. */
export async function syncMailboxes(svc: Services, db: Db): Promise<void> {
  await ensureSchema(db);
  const accounts = await listEmailAccounts(svc);
  for (const a of accounts) {
    await db.query(
      `INSERT INTO mailboxes (id, email, apollo_active) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, apollo_active = EXCLUDED.apollo_active`,
      [a.id, a.email, a.active],
    );
  }
  const ids = accounts.map((a) => a.id);
  if (ids.length) await db.query(`UPDATE mailboxes SET apollo_active = FALSE WHERE id NOT IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids);
}

/** Bounces, spam blocks, replies and opens per inbox over the last 7 days, from the emails Apollo reported. */
async function healthByMailbox(db: Db): Promise<Map<string, Health>> {
  const rows = await db.query<{ id: string; sent: number; bounced: number; spam: number; replied: number; opened: number }>(
    `SELECT email_account_id AS id,
            count(*) FILTER (WHERE completed_at IS NOT NULL OR bounced)::int AS sent,
            count(*) FILTER (WHERE bounced)::int AS bounced,
            count(*) FILTER (WHERE spam_blocked)::int AS spam,
            count(*) FILTER (WHERE replied)::int AS replied,
            count(*) FILTER (WHERE opened)::int AS opened
     FROM messages WHERE happened_at >= now() - interval '${WINDOW_DAYS} days' GROUP BY email_account_id`,
  );
  const unsub = await db.query<{ id: string; n: number }>(
    `SELECT sent_from AS id, count(*)::int AS n FROM people WHERE unsubscribed_at >= now() - interval '${WINDOW_DAYS} days' AND sent_from <> '' GROUP BY sent_from`,
  );
  const out = new Map<string, Health>();
  for (const r of rows) {
    // Spam blocks are counted against everything attempted, since a blocked email never counts as sent.
    const attempted = r.sent + r.spam;
    out.set(r.id, { ...EMPTY, ...r, bounceRate: rate(r.bounced, r.sent), spamRate: rate(r.spam, attempted) });
  }
  for (const u of unsub) out.set(u.id, { ...(out.get(u.id) ?? EMPTY), unsubscribed: u.n });
  return out;
}

/** Every inbox with today's limit, room, health and whether it can take new people. */
export async function mailboxStates(db: Db, emailsPerPerson: number): Promise<MailboxState[]> {
  await ensureSchema(db);
  const rows = await db.query<MailboxRow>(
    `SELECT id, email, enabled, max_per_day, ramp, (current_date - ramp_start)::int AS ramp_days, paused_reason, paused_at, apollo_active
     FROM mailboxes ORDER BY email`,
  );
  const added = new Map(
    (
      await db.query<{ id: string; n: number }>(
        "SELECT sent_from AS id, count(*)::int AS n FROM people WHERE sequence_status = 'added' AND sequenced_at >= date_trunc('day', now()) GROUP BY sent_from",
      )
    ).map((r) => [r.id, r.n]),
  );
  const health = await healthByMailbox(db);
  return rows.map((r) => {
    const emails = emailsToday(r);
    const newToday = newPeopleToday(emails, emailsPerPerson);
    const addedToday = added.get(r.id) ?? 0;
    const usable = r.enabled && r.apollo_active && !r.paused_reason;
    return { ...r, domain: domainOf(r.email), emailsToday: emails, newToday, addedToday, room: usable ? Math.max(0, newToday - addedToday) : 0, usable, health: health.get(r.id) ?? EMPTY };
  });
}

/** Totals per sending domain. */
export function domainHealth(states: MailboxState[]): { domain: string; inboxes: number; usable: number; health: Health }[] {
  const by = new Map<string, MailboxState[]>();
  for (const s of states) by.set(s.domain, [...(by.get(s.domain) ?? []), s]);
  return [...by.entries()].map(([domain, list]) => {
    const sum = (k: keyof Health) => list.reduce((n, s) => n + s.health[k], 0);
    const h = { sent: sum('sent'), bounced: sum('bounced'), spam: sum('spam'), replied: sum('replied'), opened: sum('opened'), unsubscribed: sum('unsubscribed') };
    return { domain, inboxes: list.length, usable: list.filter((s) => s.usable).length, health: { ...h, bounceRate: rate(h.bounced, h.sent), spamRate: rate(h.spam, h.sent + h.spam) } };
  });
}

/** Why an inbox or domain should stop taking new people, or ''. */
export function pauseReason(h: Health): string {
  if (h.sent < MIN_SENT) return '';
  if (h.bounceRate > BOUNCE_LIMIT) return `${(h.bounceRate * 100).toFixed(1)}% bounced in ${WINDOW_DAYS} days (limit ${BOUNCE_LIMIT * 100}%)`;
  if (h.spamRate > SPAM_LIMIT) return `${(h.spamRate * 100).toFixed(1)}% blocked as spam in ${WINDOW_DAYS} days (limit ${SPAM_LIMIT * 100}%)`;
  return '';
}

/**
 * Pauses every inbox that crossed the limits, and every inbox on a domain whose other inboxes are over the limits
 * together (one bad inbox is paused on its own, without taking its healthy neighbours down). Returns what it paused.
 */
export async function autoPause(db: Db, emailsPerPerson: number): Promise<{ email: string; reason: string }[]> {
  const states = await mailboxStates(db, emailsPerPerson);
  const paused: { email: string; reason: string }[] = [];
  const rest = states.filter((s) => !pauseReason(s.health));
  const domains = new Map(domainHealth(rest).map((d) => [d.domain, pauseReason(d.health)]));
  for (const s of states) {
    if (s.paused_reason) continue;
    const own = pauseReason(s.health);
    const viaDomain = domains.get(s.domain);
    const reason = own || (viaDomain ? `domain ${s.domain}: ${viaDomain}` : '');
    if (!reason) continue;
    await db.query('UPDATE mailboxes SET paused_reason = $2, paused_at = now() WHERE id = $1', [s.id, reason]);
    paused.push({ email: s.email, reason });
  }
  return paused;
}

/**
 * Which inbox sends to each of the next `n` people: the inboxes take turns, switching domain every time where possible,
 * and each takes no more than its room for today.
 */
export function allocate(states: MailboxState[], n: number): string[] {
  const room = new Map(states.filter((s) => s.usable && s.room > 0).map((s) => [s.id, s.room]));
  const byDomain = new Map<string, string[]>();
  for (const s of states) if (room.has(s.id)) byDomain.set(s.domain, [...(byDomain.get(s.domain) ?? []), s.id]);
  // Interleave: domain A inbox 1, domain B inbox 1, domain A inbox 2…
  const order: string[] = [];
  const lists = [...byDomain.values()];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i]) order.push(l[i]);
  const out: string[] = [];
  while (out.length < n && order.some((id) => (room.get(id) ?? 0) > 0)) {
    for (const id of order) {
      if (out.length >= n) break;
      const left = room.get(id) ?? 0;
      if (left <= 0) continue;
      out.push(id);
      room.set(id, left - 1);
    }
  }
  return out;
}

export async function updateMailbox(db: Db, id: string, change: { enabled?: boolean; maxPerDay?: number; ramp?: boolean; restartRamp?: boolean; resume?: boolean }): Promise<void> {
  await ensureSchema(db);
  if (change.enabled !== undefined) await db.query('UPDATE mailboxes SET enabled = $2 WHERE id = $1', [id, !!change.enabled]);
  if (change.maxPerDay !== undefined) await db.query('UPDATE mailboxes SET max_per_day = $2 WHERE id = $1', [id, Math.max(1, Math.min(200, Math.round(change.maxPerDay) || 50))]);
  if (change.ramp !== undefined) await db.query('UPDATE mailboxes SET ramp = $2 WHERE id = $1', [id, !!change.ramp]);
  if (change.restartRamp) await db.query('UPDATE mailboxes SET ramp = TRUE, ramp_start = current_date WHERE id = $1', [id]);
  if (change.resume) await db.query("UPDATE mailboxes SET paused_reason = '', paused_at = NULL WHERE id = $1", [id]);
}

/** SPF, DKIM and DMARC for a sending domain, read from public DNS. */
export type DomainCheck = {
  domain: string;
  spf: { ok: boolean; record: string };
  dkim: { ok: boolean; selectors: string[] };
  dmarc: { ok: boolean; policy: string; record: string };
  error?: string;
};

/** Selectors the common mail providers use (Google, Microsoft 365, Zoho and most others). */
const DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'dkim', 'k1', 'k2', 's1', 's2', 'mail', 'zoho', 'zmail', 'smtp', 'mx', 'protonmail', 'everlytickey1'];

async function txt(svc: Services, name: string): Promise<string[]> {
  const res = await getJson<{ Answer?: { type: number; data: string }[] }>(svc, `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
    headers: { accept: 'application/dns-json' },
  }, 10_000);
  // TXT records come quoted and may be split into several quoted pieces.
  return (res.Answer ?? []).filter((a) => a.type === 16).map((a) => a.data.replace(/"\s*"/g, '').replace(/^"|"$/g, ''));
}

export async function checkDomain(svc: Services, domain: string): Promise<DomainCheck> {
  const out: DomainCheck = { domain, spf: { ok: false, record: '' }, dkim: { ok: false, selectors: [] }, dmarc: { ok: false, policy: '', record: '' } };
  try {
    const spf = (await txt(svc, domain)).find((r) => /^v=spf1\b/i.test(r)) ?? '';
    out.spf = { ok: !!spf, record: spf };
    const dmarc = (await txt(svc, `_dmarc.${domain}`)).find((r) => /^v=DMARC1\b/i.test(r)) ?? '';
    const policy = /;\s*p=(\w+)/i.exec(dmarc)?.[1]?.toLowerCase() ?? '';
    // p=none only reports; quarantine or reject is what tells inbox providers the domain is protected.
    out.dmarc = { ok: !!dmarc && policy !== '', policy, record: dmarc };
    const found = await mapLimit(DKIM_SELECTORS, 6, async (sel) => ((await txt(svc, `${sel}._domainkey.${domain}`).catch(() => [])).some((r) => /v=DKIM1|\bp=/i.test(r)) ? sel : ''));
    out.dkim = { ok: found.some(Boolean), selectors: found.filter(Boolean) };
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}
