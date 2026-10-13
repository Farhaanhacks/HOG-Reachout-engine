import { NextResponse } from 'next/server';
import { findCustomFields, listSequences, missingFields, type Sequence } from '../../../lib/apollo-sequences';
import { checkPassword } from '../../../lib/auth';
import { BRANDS, BRAND_LIST, isBrand, type Brand } from '../../../lib/brands';
import { getDb } from '../../../lib/db';
import { syncMailboxes, type MailboxState } from '../../../lib/deliverability';
import { fullEmail, heldBack, outreachDailyLimitFromEnv, outreachStatus, pendingOutreach, pushToApollo, sendTest, sendingRoom } from '../../../lib/outreach';
import { personalizeNext, personalizeOne, setOpener } from '../../../lib/personalize';
import { CUSTOM_FIELDS, followUpTemplate, followUpTemplateHtml, sequenceTemplate, sequenceTemplateHtml } from '../../../lib/pitch';
import type { Variant } from '../../../lib/pitch';
import { keysFromEnv } from '../../../lib/services';
import { getSettings } from '../../../lib/settings';
import { listPeople } from '../../../lib/store';
import { syncUnsubscribes } from '../../../lib/unsubscribe';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** For one brand (?brand=hog|gulficons|ciominds): status, sequences, its inboxes and today's room, the field check, the template, who was sent. Spends nothing. */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const b = new URL(req.url).searchParams.get('brand');
  const brand: Brand = isBrand(b) ? b : 'hog';
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
    const { room, inboxes } = await sendingRoom(db, dailyLimit, settings.emailsPerPerson, brand);
    const sent = (await listPeople(db, { brand, limit: 1000 })).filter((p) => p.sequence_status).slice(0, 100);
    return NextResponse.json({
      brand,
      brands: BRAND_LIST.map((id) => ({ id, ...BRANDS[id] })),
      configured: !!svc.keys.apollo,
      aiConfigured: !!svc.keys.deepseek,
      defaultSequenceId: settings.sequences[brand] ?? (brand === 'hog' ? (process.env.APOLLO_SEQUENCE_ID ?? '') : ''),
      sequences,
      inboxes: inboxes.map((s: MailboxState) => ({ id: s.id, email: s.email, domain: s.domain, usable: s.usable, room: s.room, newToday: s.newToday, addedToday: s.addedToday, paused: s.paused_reason })),
      room,
      emailsPerPerson: settings.emailsPerPerson,
      missingFields: missing,
      // Version A shows the featuring fee, version B does not (Test A and Test B in the same Apollo step).
      template: {
        subject: sequenceTemplate(brand).subject,
        versions: (['A', 'B'] as Variant[]).map((v) => ({
          variant: v,
          body: sequenceTemplate(brand, v, settings.unsubscribeStyle).body,
          html: settings.unsubscribeStyle === 'button' ? sequenceTemplateHtml(brand, v) : '',
        })),
        // Step 2: the next day, in the same thread.
        followUp: {
          body: followUpTemplate(brand, settings.unsubscribeStyle).body,
          html: settings.unsubscribeStyle === 'button' ? followUpTemplateHtml(brand) : '',
        },
      },
      unsubscribeStyle: settings.unsubscribeStyle,
      apolloError,
      status: await outreachStatus(db, dailyLimit, brand),
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
    brand?: string;
    runId?: string | number;
  };
  // Run workflow sends only the leads its own run found.
  const runId = body.runId ? String(body.runId) : undefined;
  const brand: Brand = isBrand(body.brand) ? body.brand : 'hog';
  const limit = Math.max(1, Math.min(Number(body.limit) || 25, 50));
  const svc = { fetch, keys: keysFromEnv() };
  try {
    const db = getDb();
    if (body.action === 'personalize-one') {
      if (!body.personId) return NextResponse.json({ error: 'Send a personId.' }, { status: 400 });
      return NextResponse.json(await personalizeOne(svc, db, body.personId));
    }
    if (body.action === 'personalize') {
      const summary = await personalizeNext(svc, db, Math.min(limit, 10), runId);
      return NextResponse.json({ summary, status: await outreachStatus(db, outreachDailyLimitFromEnv(), brand) });
    }
    if (body.action === 'opener') {
      if (!body.personId) return NextResponse.json({ error: 'Send a personId.' }, { status: 400 });
      await setOpener(db, body.personId, String(body.opener ?? ''));
      return NextResponse.json({ ok: true, status: await outreachStatus(db, outreachDailyLimitFromEnv()) });
    }
    if (body.action === 'preview') {
      const { editions, unsubscribeStyle } = await getSettings(db);
      const people = await pendingOutreach(db, limit, brand);
      // Half the people get version B; the preview shows A and B alternately so both can be checked.
      return NextResponse.json({ people: people.map((p, i) => ({ ...p, preview: fullEmail(p, { editions, style: unsubscribeStyle, variant: i % 2 ? 'B' : 'A' }) })) });
    }
    if (body.action === 'push') {
      if (body.confirm !== true) return NextResponse.json({ error: 'Adding people to a sequence starts real emails: send confirm true.' }, { status: 400 });
      const summary = await pushToApollo(svc, db, { sequenceId: String(body.sequenceId ?? ''), limit, dailyLimit: outreachDailyLimitFromEnv(), brand, runId });
      return NextResponse.json({ summary, status: await outreachStatus(db, outreachDailyLimitFromEnv(), brand) });
    }
    if (body.action === 'test') {
      return NextResponse.json(
        await sendTest(svc, db, {
          sequenceId: String(body.sequenceId ?? ''),
          emailAccountId: body.emailAccountId || undefined,
          testEmail: String(body.testEmail ?? '').trim(),
          personId: body.personId || undefined,
          brand,
        }),
      );
    }
    return NextResponse.json({ error: 'Send action "personalize", "personalize-one", "opener", "preview", "push" or "test".' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
