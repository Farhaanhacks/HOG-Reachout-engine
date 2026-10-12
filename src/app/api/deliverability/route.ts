import { NextResponse } from 'next/server';
import { checkPassword } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { BOUNCE_LIMIT, MIN_SENT, RAMP_START, RAMP_STEP, SPAM_LIMIT, WINDOW_DAYS, autoPause, checkDomain, domainHealth, mailboxStates, syncMailboxes, updateMailbox } from '../../../lib/deliverability';
import { keysFromEnv } from '../../../lib/services';
import { getSettings } from '../../../lib/settings';
import { lastSync, syncMessages } from '../../../lib/tracking';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The inboxes and domains with today's limits and their health. Opening the page refreshes the inbox list and reads the
 * latest bounces, spam blocks and replies from Apollo (free), then pauses any inbox over the limits.
 */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const svc = { fetch, keys: keysFromEnv() };
  try {
    const db = getDb();
    const { emailsPerPerson } = await getSettings(db);
    let apolloError = '';
    let sync = null;
    if (svc.keys.apollo) {
      try {
        await syncMailboxes(svc, db);
        sync = await syncMessages(svc, db, { budgetMs: 25_000 });
      } catch (e) {
        apolloError = (e as Error).message;
      }
    }
    const paused = await autoPause(db, emailsPerPerson);
    const inboxes = await mailboxStates(db, emailsPerPerson);
    return NextResponse.json({
      inboxes,
      domains: domainHealth(inboxes),
      paused,
      sync,
      lastSync: await lastSync(db),
      apolloError,
      emailsPerPerson,
      rules: { rampStart: RAMP_START, rampStep: RAMP_STEP, bounceLimit: BOUNCE_LIMIT, spamLimit: SPAM_LIMIT, minSent: MIN_SENT, windowDays: WINDOW_DAYS },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * action "update": changes one inbox { id, enabled?, maxPerDay?, ramp?, restartRamp?, resume?, senderName? }.
 * action "dns": checks SPF, DKIM and DMARC for the sending domains { domains }.
 */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    id?: string;
    enabled?: boolean;
    maxPerDay?: number;
    ramp?: boolean;
    restartRamp?: boolean;
    resume?: boolean;
    senderName?: string;
    domains?: string[];
  };
  const svc = { fetch, keys: keysFromEnv() };
  try {
    const db = getDb();
    if (body.action === 'update') {
      if (!body.id) return NextResponse.json({ error: 'Send an inbox id.' }, { status: 400 });
      await updateMailbox(db, body.id, body);
      const { emailsPerPerson } = await getSettings(db);
      const inboxes = await mailboxStates(db, emailsPerPerson);
      return NextResponse.json({ inboxes, domains: domainHealth(inboxes) });
    }
    if (body.action === 'dns') {
      const domains = [...new Set((body.domains ?? []).map((d) => String(d).toLowerCase().trim()).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 10);
      return NextResponse.json({ checks: await Promise.all(domains.map((d) => checkDomain(svc, d))) });
    }
    return NextResponse.json({ error: 'Send action "update" or "dns".' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
