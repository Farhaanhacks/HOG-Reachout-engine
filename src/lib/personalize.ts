import { askDeepSeekJson } from './ai';
import { icpByLabel } from './icps';
import { isGeo } from './geo';
import { glForCountry } from './markets';
import { newsSearch, mapLimit, type NewsResult, type Services } from './services';
import { fallbackOpenerFor } from './pitch';
import { READY_SQL, ensureSchema, type Db } from './store';

/**
 * The personal parts of each email, written by DeepSeek from the lead's LinkedIn snippet and their company's recent
 * news: the achievement the email opens by congratulating them on ("Congratulations on <achievement>!"), and the name
 * of the special edition they are shortlisted for ("Top Fintech Players to Look Out For in 2026").
 *
 * Data rule: DeepSeek never receives the person's name or email. Their name is replaced with "the person" in everything
 * sent.
 */

export function systemPrompt(year: number): string {
  return `You help write a cold email inviting a business leader to a Cover Story Profile in a business magazine.

You get facts about one leader, called "the person", and their company. Write two things:

1. "achievement": what the email congratulates them on. It completes the sentence "Congratulations on ___!". A short noun phrase, at most 18 words, about one concrete, recent and true fact: a launch, expansion, funding round, deal, partnership, award or milestone of theirs or their company. Write it about the company or "your" (for example "Acme's expansion into Saudi Arabia" or "your appointment as CEO of Acme"). If the facts hold nothing specific beyond their job title and company, return "".

2. "edition": the name of the special edition they are shortlisted for, tied to their company's field, at most 9 words, ending with "in ${year}". For example "Top Fintech Players to Look Out For in ${year}" or "Top Logistics Innovators to Watch in ${year}". Name the field, never the person or the company.

Rules:
- Use only the facts given. Never invent numbers, dates, awards or events.
- Plain, professional wording. No flattery words (impressive, amazing, incredible, inspiring), no exclamation marks, no questions, no links, no emojis, no quotation marks.

Reply with JSON only: {"achievement": "...", "edition": "...", "fact_used": "the fact you referred to, in a few words"}`;
}

type Lead = { id: number | string; name: string; title: string; company: string; geo: string; country?: string; industry?: string; segment?: string; snippet: string };

/** Replaces the person's full name and each part of it (3+ letters) with "the person", case-insensitively. */
export function redactName(text: string, name: string): string {
  let out = text;
  const parts = [name.trim(), ...name.trim().split(/\s+/)].filter((p) => p.length >= 3).sort((a, b) => b.length - a.length);
  for (const p of parts) {
    // Whole words only, so "Ali" does not touch "Alibaba".
    out = out.replace(new RegExp(`(?<!\\p{L})${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'giu'), 'the person');
  }
  return out
    .replace(/\b(?:al|el|bin|ibn|abu|van|von|de|der|da|di)\s+the person/gi, 'the person') // "El the person" from "El Chaar"
    .replace(/(the person)(\s+the person)+/gi, '$1');
}

/** The facts sent to DeepSeek for one lead: no name, no email. */
export function factsFor(lead: Lead, news: NewsResult[]): string {
  const lines = [
    `Job title: ${lead.title || 'unknown'}`,
    `Company: ${lead.company || 'unknown'}`,
    `Country: ${lead.country || lead.geo.toUpperCase()}`,
    lead.industry ? `Industry: ${lead.industry}` : '',
    icpByLabel(lead.segment) ? `Edition theme (name the edition in this field): ${icpByLabel(lead.segment)?.label}` : '',
    lead.snippet ? `From their LinkedIn profile: ${redactName(lead.snippet, lead.name).slice(0, 600)}` : '',
    ...news.slice(0, 4).map((n, i) => `News ${i + 1}${n.date ? ` (${n.date})` : ''}${n.source ? `, ${n.source}` : ''}: ${redactName(`${n.title ?? ''}. ${n.snippet ?? ''}`, lead.name).slice(0, 300)}`),
  ];
  return lines.filter(Boolean).join('\n');
}

const UNSAFE = /https?:|www\.|[{}[\]<>"“”]|the person|!|\?/i;
const FLATTERY = /\b(impressive|amazing|incredible|inspiring)\b/i;

/** An achievement is usable only if it is a short plain phrase. "Congratulations on" and end punctuation are trimmed. */
export function cleanAchievement(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^congratulations( to you)? on\s+/i, '')
    .replace(/[.!,;:\s]+$/, '');
  if (!s || s.length > 160 || s.split(' ').length > 22) return '';
  if (UNSAFE.test(s) || FLATTERY.test(s)) return '';
  return s;
}

/** An edition name is usable only if it is short, plain and names a year. */
export function cleanEdition(raw: unknown): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().replace(/[.!,;:\s]+$/, '');
  if (!s || s.length > 80 || s.split(' ').length > 12 || !/\b20\d\d\b/.test(s)) return '';
  if (UNSAFE.test(s) || FLATTERY.test(s)) return '';
  return s;
}

/** The opening line: "Congratulations on <achievement>!", or on their leadership at their company when nothing specific was found. */
export function openerFor(achievement: string, company: string): string {
  return achievement ? `Congratulations on ${achievement}!` : fallbackOpenerFor(company);
}

/** The opener when no news or profile fact can be used: built from their company only, so it is never wrong. */
export function fallbackOpener(lead: { title: string; company: string }): string {
  return fallbackOpenerFor(lead.company);
}

export type PersonalizeSummary = { done: number; none: number; failed: number; searches: number; error?: string };

/** People with an email ready, not yet sent, and not yet personalized (only one run's, if given): main people first. */
async function waiting(db: Db, limit: number, runId?: number | string): Promise<Lead[]> {
  return db.query<Lead>(
    `SELECT id, name, title, company, geo, country, industry, segment, snippet FROM people
     WHERE ${READY_SQL} AND email <> '' AND sequence_status = '' AND opener_status IN ('', 'none') ${runId ? 'AND run_id = $2' : ''}
     ORDER BY COALESCE(rank, 3) ASC, apollo_checked_at ASC NULLS LAST, id ASC LIMIT $1`,
    runId ? [Math.max(1, Math.min(limit, 25)), runId] : [Math.max(1, Math.min(limit, 25))],
  );
}

/**
 * Writes openers for the next `limit` people (at most 25 per call, four at a time). Each person costs one Serper news
 * search (when we know their company) and one DeepSeek call. Every lead handled gets an opener: from the news, or with nothing
 * specific, from their role and company. A failure leaves them unmarked to try again.
 */
export async function personalizeNext(svc: Services, db: Db, limit: number, runId?: number | string): Promise<PersonalizeSummary> {
  if (!svc.keys.deepseek) throw new Error('DEEPSEEK_API_KEY is not set');
  await ensureSchema(db);
  const leads = await waiting(db, limit, runId);
  const summary: PersonalizeSummary = { done: 0, none: 0, failed: 0, searches: 0 };
  await mapLimit(leads, 4, async (lead) => {
    try {
      const result = await personalizeLead(svc, db, lead);
      summary.searches += result.searches;
      if (result.opener) summary.done++;
      else summary.none++;
    } catch (e) {
      summary.failed++;
      summary.error = (e as Error).message;
      // Searches made before the failure were still charged.
      summary.searches += (e as Error & { searches?: number }).searches ?? 0;
    }
  });
  return summary;
}

/**
 * Researches one lead and saves their opener: news about the person at their company first (most personal), then
 * about the company. A name alone is too ambiguous to search, so without a company only their LinkedIn snippet is used.
 * Searches go to Google through Serper; only what DeepSeek sees is stripped of the name. Throws when Serper or DeepSeek
 * cannot be reached, leaving the lead as it was.
 */
async function personalizeLead(svc: Services, db: Db, lead: Lead): Promise<{ opener: string; fact: string; edition: string; searches: number }> {
  const geo = isGeo(lead.geo) && !lead.country ? lead.geo : glForCountry(lead.country);
  const news: NewsResult[] = [];
  let searches = 0;
  if (lead.company) {
    const seen = new Set<string>();
    for (const q of [`"${lead.name}" "${lead.company}"`, `"${lead.company}"`]) {
      searches++;
      for (const n of await newsSearch(svc, q, geo).catch(() => [] as NewsResult[])) {
        const key = n.link || n.title || '';
        if (key && !seen.has(key)) {
          seen.add(key);
          news.push(n);
        }
      }
    }
  }
  let reply: Awaited<ReturnType<typeof askDeepSeekJson>>;
  try {
    reply = await askDeepSeekJson(svc, systemPrompt(new Date().getFullYear()), factsFor(lead, news));
  } catch (e) {
    throw Object.assign(e as Error, { searches });
  }
  // Every lead gets an opener: from the news or their profile when DeepSeek finds something, otherwise from their
  // company. Nobody is held back. Without an edition name, the edition table's one for their industry is used.
  const achievement = cleanAchievement(reply?.achievement);
  const opener = openerFor(achievement, lead.company);
  const edition = cleanEdition(reply?.edition);
  const fact = achievement ? String(reply?.fact_used ?? '').slice(0, 200) : 'role and company (no news found)';
  await db.query("UPDATE people SET opener = $2, opener_fact = $3, edition_name = $4, opener_status = 'done', personalized_at = now() WHERE id = $1", [
    lead.id,
    opener,
    fact,
    edition,
  ]);
  return { opener, fact, edition, searches };
}

/**
 * Personalizes one person on demand (the "Personalize from news" button on a lead's email draft), whether or not they
 * have an email yet, and even if they were personalized before.
 */
export async function personalizeOne(svc: Services, db: Db, id: number | string): Promise<{ status: 'done' | 'none'; opener: string; fact: string }> {
  if (!svc.keys.deepseek) throw new Error('DEEPSEEK_API_KEY is not set');
  await ensureSchema(db);
  const [lead] = await db.query<Lead>('SELECT id, name, title, company, geo, country, industry, snippet FROM people WHERE id = $1', [id]);
  if (!lead) throw new Error('Lead not found');
  const { opener, fact } = await personalizeLead(svc, db, lead);
  return { status: opener ? 'done' : 'none', opener, fact };
}

/** Lets the team rewrite or approve an opener by hand. An empty opener holds the person back from sending. */
export async function setOpener(db: Db, id: number | string, opener: string): Promise<void> {
  await ensureSchema(db);
  const text = opener.replace(/\s+/g, ' ').trim().slice(0, 400);
  await db.query("UPDATE people SET opener = $2, opener_fact = CASE WHEN $2 = '' THEN '' ELSE 'edited by the team' END, opener_status = $3, personalized_at = now() WHERE id = $1", [
    id,
    text,
    text ? 'done' : 'none',
  ]);
}
