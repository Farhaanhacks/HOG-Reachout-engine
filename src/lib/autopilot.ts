import { BRAND_LIST, BRANDS } from './brands';
import { dailyLimitFromEnv } from './enrich';
import { outreachDailyLimitFromEnv, pushToApollo } from './outreach';
import { personalizeNext } from './personalize';
import { createRun, finishRun, getRun, quotasMet, runStep, type Run } from './run';
import type { Services } from './services';
import { getSetting, getSettings, setSetting } from './settings';
import { ensureSchema, type Db } from './store';

/**
 * Autopilot: one run every hour, around the clock, with nobody at the keyboard. An outside scheduler (cron-job.org)
 * calls the tick endpoint every couple of minutes; it answers at once and each call then moves the hour's run on in the
 * background for up to ~45 seconds:
 *   finding (Apollo search and lookups, split 35/30/35 between the brands and equally between the ICPs) → writing (the personal emails) →
 *   sending (each brand's waiting leads into its own sequence, from its own inboxes) → done.
 * Leads an inbox has no room for today stay waiting and go out on a later tick. A run that is still unfinished three
 * hours on (say, Apollo down) is closed, so one bad hour never blocks the next.
 *
 * On alternate days (the default) it only works every other day: new leads go out on one day, and the next day is left
 * to Apollo, which sends those leads' follow-ups (step 2, one day later). Days run on UTC.
 */

export type Autopilot = {
  enabled: boolean;
  perHour: number;
  /** New leads every other day only, leaving the days between to the follow-ups. */
  alternate: boolean;
  /** A new-leads day (YYYY-MM-DD, UTC); every second day from it is one too. */
  firstDay: string;
};
export const DEFAULT_AUTOPILOT: Autopilot = { enabled: false, perHour: 30, alternate: true, firstDay: '2026-10-14' };
const STALE_HOURS = 3;
const DAY_MS = 86_400_000;

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whether new leads go out on this day: always, or every second day counted from firstDay. */
export function isNewLeadDay(ap: Pick<Autopilot, 'alternate' | 'firstDay'>, now = new Date()): boolean {
  if (!ap.alternate) return true;
  return Math.round((Date.parse(utcDay(now)) - Date.parse(ap.firstDay)) / DAY_MS) % 2 === 0;
}

export async function getAutopilot(db: Db): Promise<Autopilot> {
  const v = await getSetting<Partial<Autopilot>>(db, 'autopilot', {});
  return {
    enabled: !!v.enabled,
    perHour: Math.max(1, Math.min(100, Math.round(Number(v.perHour)) || DEFAULT_AUTOPILOT.perHour)),
    alternate: v.alternate === undefined ? DEFAULT_AUTOPILOT.alternate : !!v.alternate,
    firstDay: typeof v.firstDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.firstDay) ? v.firstDay : DEFAULT_AUTOPILOT.firstDay,
  };
}

/** Makes today a new-leads day or a follow-up day (the days after keep alternating from there). */
export function firstDayFor(today: 'new' | 'followup', now = new Date()): string {
  return utcDay(today === 'new' ? now : new Date(now.getTime() - DAY_MS));
}

export async function setAutopilot(db: Db, change: Partial<Autopilot>): Promise<Autopilot> {
  const current = await getAutopilot(db);
  await setSetting(db, 'autopilot', { ...current, ...change });
  return getAutopilot(db);
}

/** Takes a named lock for `seconds`, unless someone else holds it. */
async function takeLock(db: Db, name: string, seconds: number): Promise<boolean> {
  const rows = await db.query(
    `INSERT INTO locks (name, until) VALUES ($1, now() + ($2::int * interval '1 second'))
     ON CONFLICT (name) DO UPDATE SET until = EXCLUDED.until WHERE locks.until < now() RETURNING name`,
    [name, seconds],
  );
  return rows.length > 0;
}

async function releaseLock(db: Db, name: string): Promise<void> {
  await db.query('UPDATE locks SET until = now() - interval \'1 second\' WHERE name = $1', [name]);
}

async function setPhase(db: Db, run: Run, phase: string): Promise<void> {
  await db.query('UPDATE runs SET phase = $2 WHERE id = $1', [run.id, phase]);
  run.phase = phase;
}

export type TickResult = { ran: boolean; reason?: string; runId?: number | string; phase?: string; log: string[] };

/** One scheduler call: moves the current autopilot run on until the time budget is used. */
export async function tick(svc: Services, db: Db, opts: { budgetMs?: number; now?: Date } = {}): Promise<TickResult> {
  await ensureSchema(db);
  const ap = await getAutopilot(db);
  if (!ap.enabled) return { ran: false, reason: 'Autopilot is off', log: [] };
  const now = opts.now ?? new Date();
  if (!isNewLeadDay(ap, now)) {
    const reason = "Follow-up day: Apollo sends yesterday's follow-ups, so no new leads today. New leads start again tomorrow.";
    await setSetting(db, 'autopilotLastTick', { at: now.toISOString(), log: [reason] }).catch(() => {});
    return { ran: false, reason, log: [] };
  }
  if (!(await takeLock(db, 'autopilot', 70))) return { ran: false, reason: 'Another tick is still working', log: [] };
  const log: string[] = [];
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  let run: Run | null = null;
  try {
    // The oldest unfinished autopilot run first; a new one only when none is open and this hour has none yet.
    const [open] = await db.query<{ id: number | string; stale: boolean }>(
      `SELECT id, created_at < now() - ($1::int * interval '1 hour') AS stale FROM runs WHERE auto AND status = 'running' ORDER BY id LIMIT 1`,
      [STALE_HOURS],
    );
    if (open?.stale) {
      await finishRun(db, open.id, 'stopped');
      log.push(`Closed run ${open.id}: unfinished after ${STALE_HOURS} hours.`);
    } else if (open) {
      run = await getRun(db, open.id);
    }
    if (!run) {
      const [thisHour] = await db.query("SELECT 1 FROM runs WHERE auto AND created_at >= date_trunc('hour', now()) LIMIT 1");
      if (thisHour) return { ran: true, reason: "This hour's run is finished; the next starts on the hour", log };
      run = await createRun(db, { target: ap.perHour }, { auto: true });
      log.push(`Started run ${run.id} for ${ap.perHour} leads.`);
    }

    const settings = await getSettings(db);
    while (run && run.status === 'running' && Date.now() < deadline) {
      if (run.phase === 'finding') {
        if (quotasMet(run) || run.next_index >= run.queries.length) {
          log.push(`Found ${run.apollo_with_email} leads ready to email.`);
          await setPhase(db, run, 'writing');
          continue;
        }
        const { run: next, summary } = await runStep(svc, db, run.id, { dailyLimit: dailyLimitFromEnv() });
        run = { ...next, phase: run.phase };
        if (summary.searched) log.push(`Searched ${summary.searched}, looked up ${summary.lookedUp}, ${summary.ready} ready.`);
        if (summary.stopped) {
          log.push(summary.stopped);
          await setPhase(db, run, 'writing');
        }
        continue;
      }
      if (run.phase === 'writing') {
        const s = svc.keys.deepseek ? await personalizeNext(svc, db, 10, run.id) : { done: 0, none: 0, failed: 0 };
        if (s.done + s.none > 0) log.push(`Wrote ${s.done + s.none} emails.`);
        if (s.done + s.none === 0) await setPhase(db, run, 'sending');
        continue;
      }
      if (run.phase === 'sending') {
        // Every waiting lead of each brand, oldest first, so anything an inbox had no room for earlier goes out now.
        let moved = 0;
        for (const b of BRAND_LIST) {
          const sequenceId = settings.sequences[b];
          if (!sequenceId || Date.now() > deadline) continue;
          // On alternate days each inbox's day holds only first emails (the follow-ups get the next day), so one each.
          const p = await pushToApollo(svc, db, { sequenceId, brand: b, limit: 25, dailyLimit: outreachDailyLimitFromEnv(), emailsPerPerson: ap.alternate ? 1 : undefined });
          moved += p.requested;
          if (p.added || p.skipped || p.failed) log.push(`${BRANDS[b].label}: ${p.added} added${p.skipped ? `, ${p.skipped} declined` : ''}${p.failed ? `, ${p.failed} failed (${p.error})` : ''}.`);
          if (p.paused.length) log.push(`Paused for bounces or spam: ${p.paused.map((x) => x.email).join(', ')}.`);
        }
        if (Date.now() > deadline) break;
        if (moved === 0) {
          run = await finishRun(db, run.id, 'done');
          log.push('Run finished.');
        }
        continue;
      }
      // A run without a stage (should not happen): start it from finding.
      await setPhase(db, run, 'finding');
    }
    return { ran: true, runId: run?.id, phase: run?.status === 'running' ? run.phase : run?.status, log };
  } catch (e) {
    // The run stays at its stage; the next tick tries again.
    log.push(`Error: ${(e as Error).message}`);
    if (run) await db.query('UPDATE runs SET error = $2 WHERE id = $1', [run.id, (e as Error).message.slice(0, 300)]).catch(() => {});
    return { ran: true, runId: run?.id, phase: run?.phase, log };
  } finally {
    await setSetting(db, 'autopilotLastTick', { at: now.toISOString(), log: log.slice(-12) }).catch(() => {});
    await releaseLock(db, 'autopilot').catch(() => {});
  }
}

export type AutopilotStatus = {
  autopilot: Autopilot;
  lastTick: { at: string; log: string[] } | null;
  current: Run | null;
  today: { runs: number; found: number };
  /** Whether today (UTC) is a new-leads day, and when the day changes. */
  newLeadDay: boolean;
  dayEndsAt: string;
  /** The daily caps that stop a day early: Apollo lookups (credits) and people sent. */
  caps: { lookups: number; sends: number };
};

export async function autopilotStatus(db: Db): Promise<AutopilotStatus> {
  await ensureSchema(db);
  const [cur] = await db.query<{ id: number | string }>("SELECT id FROM runs WHERE auto ORDER BY id DESC LIMIT 1");
  const [t] = await db.query<{ runs: number; found: number }>(
    "SELECT count(*)::int AS runs, coalesce(sum(apollo_with_email), 0)::int AS found FROM runs WHERE auto AND created_at >= date_trunc('day', now())",
  );
  const autopilot = await getAutopilot(db);
  const now = new Date();
  return {
    autopilot,
    newLeadDay: isNewLeadDay(autopilot, now),
    dayEndsAt: new Date(Date.parse(utcDay(now)) + DAY_MS).toISOString(),
    caps: { lookups: dailyLimitFromEnv(), sends: outreachDailyLimitFromEnv() },
    lastTick: await getSetting<{ at: string; log: string[] } | null>(db, 'autopilotLastTick', null),
    current: cur ? await getRun(db, cur.id) : null,
    today: { runs: t?.runs ?? 0, found: t?.found ?? 0 },
  };
}
