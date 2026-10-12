import { NextResponse } from 'next/server';
import { findCustomFields, listSequences, missingFields, type Sequence } from '../../../lib/apollo-sequences';
import { checkPassword } from '../../../lib/auth';
import { BRANDS, BRAND_LIST, BRAND_SHARE } from '../../../lib/brands';
import { getDb } from '../../../lib/db';
import { mailboxStates, syncMailboxes } from '../../../lib/deliverability';
import { dailyLimitFromEnv, enrichStatus } from '../../../lib/enrich';
import { brandInboxes, outreachDailyLimitFromEnv, outreachStatus } from '../../../lib/outreach';
import { CUSTOM_FIELDS } from '../../../lib/pitch';
import { keysFromEnv } from '../../../lib/services';
import { getSettings } from '../../../lib/settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * What Run workflow needs to know before it starts: each brand's sequence and whether it is active, how many of its
 * inboxes can send and their room today, the custom-field check, and today's Apollo lookups. Spends nothing.
 */
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
    }
    const inboxes = await mailboxStates(db, settings.emailsPerPerson);
    const status = await outreachStatus(db, outreachDailyLimitFromEnv());
    return NextResponse.json({
      configured: !!svc.keys.apollo,
      aiConfigured: !!svc.keys.deepseek,
      apolloError,
      missingFields: missing,
      sequences,
      enrich: await enrichStatus(db, dailyLimitFromEnv()),
      sendingRoomToday: Math.max(0, status.dailyLimit - status.sentToday),
      brands: BRAND_LIST.map((id) => {
        const own = brandInboxes(inboxes, id);
        const sequenceId = settings.sequences[id] ?? '';
        return {
          id,
          ...BRANDS[id],
          share: BRAND_SHARE[id],
          sequenceId,
          sequenceActive: sequences.find((s) => s.id === sequenceId)?.active ?? null,
          inboxes: own.length,
          usableInboxes: own.filter((s) => s.usable).length,
          room: own.reduce((n, s) => n + s.room, 0),
        };
      }),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
