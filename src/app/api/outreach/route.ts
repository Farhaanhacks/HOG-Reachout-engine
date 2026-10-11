import { NextResponse } from 'next/server';
import { findCustomFields, listSequences, missingFields, type Sequence } from '../../../lib/apollo-sequences';
import { checkPassword } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { syncMailboxes, type MailboxState } from '../../../lib/deliverability';
import { fullEmail, heldBack, outreachDailyLimitFromEnv, outreachStatus, pendingOutreach, pushToApollo, sendTest, sendingRoom } from '../../../lib/outreach';
import { personalizeNext, personalizeOne, setOpener } from '../../../lib/personalize';
import { CUSTOM_FIELDS, sequenceTemplate } from '../../../lib/pitch';
import { keysFromEnv } from '../../../lib/services';
import { getSettings } from '../../../lib/settings';
import { listPeople } from '../../../lib/store';
import { syncUnsubscribes } from '../../../lib/unsubscribe';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Status, the Apollo sequences, the inboxes and today's room, the custom-field check, the template, and who was sent recently. Spends nothing. */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const svc = { fetch, keys: keysFromEnv() };
  try {
    const db = getDb();
    const settings = await getSettings(db);
    let sequences: Sequence[] = [];
    let missing: string[] = Object.values(CUSTOM_FIELDS);
    let apolloError = '';
    if (svc.keys.apollo) {
      try {
        [sequences, missing] = await Promise.all([listSequences(svc), findCustomFields(svc).then(missingFields), syncMailboxes(svc, db)]);
      } catch (e) {
        apolloError = (e as Error).message;
      }
      // Anyone who unsubscribed while Apollo was unreachable has their sequence stopped now.
      await syncUnsubscribes(svc, db).catch(() => 0);
    }
    const dailyLimit = outreachDailyLimitFromEnv();
    const { room, inboxes } = await sendingRoom(db, dailyLimit, settings.emailsPerPerson);
    const sent = (await listPeople(db, { limit: 1000 })).filter((p) => p.sequence_status).slice(0, 100);
    return NextResponse.json({
      configured: !!svc.keys.apollo,
      aiConfigured: !!svc.keys.deepseek,
      defaultSequenceId: process.env.APOLLO_SEQUENCE_ID ?? '',
      sequences,
      inboxes: inboxes.map((s: MailboxState) => ({ id: s.id, email: s.email, domain: s.domain, usable: s.usable, room: s.room, newToday: s.newToday, addedToday: s.addedToday, paused: s.paused_reason })),
      room,
      emailsPerPerson: settings.emailsPerPerson,
      missingFields: missing,
      template: sequenceTemplate(),
      apolloError,
      status: await outreachStatus(db, dailyLimit),
      held: await heldBack(db),
      sent,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * action "personalize": writes openers for the next `limit` people waiting (Serper news + DeepSeek).
 * action "personalize-one": personalizes one person { personId }.
 * action "opener": saves an opener written or edited by the team { personId, opener }.
 * action "preview": who would be sent next, with their full email. Spends nothing.
 * action "push" with confirm true: adds up to `limit` personalized people to the sequence { sequenceId }, rotating inboxes.
 * action "test": one real personalized email to a test address the team owns { sequenceId, testEmail, emailAccountId? }.
 */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    limit?: number;
    confirm?: boolean;
    sequenceId?: string;
    emailAccountId?: string;
    testEmail?: string;
    personId?: string;
    opener?: string;
  };
  const limit = Math.max(1, Math.min(Number(body.limit) || 25, 50));
  const svc = { fetch, keys: keysFromEnv() };
  try {
    const db = getDb();
    if (body.action === 'personalize-one') {
      if (!body.personId) return NextResponse.json({ error: 'Send a personId.' }, { status: 400 });
      return NextResponse.json(await personalizeOne(svc, db, body.personId));
    }
    if (body.action === 'personalize') {
      const summary = await personalizeNext(svc, db, Math.min(limit, 10));
      return NextResponse.json({ summary, status: await outreachStatus(db, outreachDailyLimitFromEnv()) });
    }
    if (body.action === 'opener') {
      if (!body.personId) return NextResponse.json({ error: 'Send a personId.' }, { status: 400 });
      await setOpener(db, body.personId, String(body.opener ?? ''));
      return NextResponse.json({ ok: true, status: await outreachStatus(db, outreachDailyLimitFromEnv()) });
    }
    if (body.action === 'preview') {
      const { editions } = await getSettings(db);
      const people = await pendingOutreach(db, limit);
      return NextResponse.json({ people: people.map((p) => ({ ...p, preview: fullEmail(p, { editions }) })) });
    }
    if (body.action === 'push') {
      if (body.confirm !== true) return NextResponse.json({ error: 'Adding people to a sequence starts real emails: send confirm true.' }, { status: 400 });
      const summary = await pushToApollo(svc, db, { sequenceId: String(body.sequenceId ?? ''), limit, dailyLimit: outreachDailyLimitFromEnv() });
      return NextResponse.json({ summary, status: await outreachStatus(db, outreachDailyLimitFromEnv()) });
    }
    if (body.action === 'test') {
      return NextResponse.json(
        await sendTest(svc, db, {
          sequenceId: String(body.sequenceId ?? ''),
          emailAccountId: body.emailAccountId || undefined,
          testEmail: String(body.testEmail ?? '').trim(),
          personId: body.personId || undefined,
        }),
      );
    }
    return NextResponse.json({ error: 'Send action "personalize", "personalize-one", "opener", "preview", "push" or "test".' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
