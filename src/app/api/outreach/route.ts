import { NextResponse } from 'next/server';
import { checkPassword } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { listCampaigns } from '../../../lib/instantly';
import { heldBack, outreachDailyLimitFromEnv, outreachStatus, pendingOutreach, pushToInstantly, sendTest, toInstantlyLead } from '../../../lib/outreach';
import { personalizeNext, setOpener } from '../../../lib/personalize';
import { keysFromEnv } from '../../../lib/services';
import { listPeople } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Status, the Instantly campaigns, who is held back, and who was sent most recently. Spends nothing. */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const svc = { fetch, keys: keysFromEnv() };
  try {
    const db = getDb();
    let campaigns: Awaited<ReturnType<typeof listCampaigns>> = [];
    let campaignError = '';
    if (svc.keys.instantly) {
      try {
        campaigns = await listCampaigns(svc);
      } catch (e) {
        campaignError = (e as Error).message;
      }
    }
    const sent = (await listPeople(db, { limit: 1000 })).filter((p) => p.instantly_status).slice(0, 100);
    return NextResponse.json({
      configured: !!svc.keys.instantly,
      aiConfigured: !!svc.keys.deepseek,
      defaultCampaignId: process.env.INSTANTLY_CAMPAIGN_ID ?? '',
      campaigns,
      campaignError,
      status: await outreachStatus(db, outreachDailyLimitFromEnv()),
      held: await heldBack(db),
      sent,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * action "personalize": writes openers for the next `limit` people (Serper news + DeepSeek).
 * action "opener": saves an opener written or edited by the team { personId, opener }.
 * action "preview": who would be sent next, with their full email. Spends nothing.
 * action "push" with confirm true: sends up to `limit` personalized people to the campaign.
 * action "test": one personalized email to a test address the team owns.
 */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { action?: string; limit?: number; confirm?: boolean; campaignId?: string; testEmail?: string; personId?: string; opener?: string };
  const limit = Math.max(1, Math.min(Number(body.limit) || 25, 500));
  const svc = { fetch, keys: keysFromEnv() };
  try {
    const db = getDb();
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
      const people = await pendingOutreach(db, limit);
      return NextResponse.json({ people: people.map((p) => ({ ...p, lead: toInstantlyLead(p) })) });
    }
    if (body.action === 'push') {
      if (body.confirm !== true) return NextResponse.json({ error: 'Sending to Instantly starts real emails: send confirm true.' }, { status: 400 });
      const summary = await pushToInstantly(svc, db, { campaignId: String(body.campaignId ?? ''), limit, dailyLimit: outreachDailyLimitFromEnv() });
      return NextResponse.json({ summary, status: await outreachStatus(db, outreachDailyLimitFromEnv()) });
    }
    if (body.action === 'test') {
      return NextResponse.json(await sendTest(svc, db, { campaignId: String(body.campaignId ?? ''), testEmail: String(body.testEmail ?? '').trim(), personId: body.personId || undefined }));
    }
    return NextResponse.json({ error: 'Send action "personalize", "opener", "preview", "push" or "test".' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
