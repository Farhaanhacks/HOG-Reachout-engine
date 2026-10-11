import { askDeepSeekJson } from './ai';
import { isGeo, type Geo } from './geo';
import { newsSearch, mapLimit, type NewsResult, type Services } from './services';
import { READY_SQL, ensureSchema, type Db } from './store';

/**
 * Personal openers: one or two sentences per lead that show we know something specific and true about them or their
 * company, written by DeepSeek from the lead's LinkedIn snippet and their company's recent news.
 *
 * Data rule: DeepSeek never receives the person's name or email. Their name is replaced with "the person" in everything
 * sent, and the opener speaks to them as "you".
 */

export const SYSTEM_PROMPT = `You write the opening line of a cold email from Humans of Globe, a media brand that publishes in-depth stories about business leaders in print, online and on its podcast.

You get facts about one leader, called "the person", and their company. Write one or two sentences, at most 45 words, addressed to them as "you" / "your", that show we know something specific and true about them or their company.

Rules:
- Use only the facts given. Never invent numbers, dates, awards or events.
- Refer to one concrete fact: a launch, expansion, funding, deal, award, milestone or something from their profile.
- Plain, warm, professional tone. No flattery words (impressive, amazing, incredible, inspiring), no exclamation marks, no questions, no links, no emojis.
- Do not mention Humans of Globe or ask for anything; the rest of the email does that.
- If the facts hold nothing specific beyond their job title and company, write about them leading that company, adding nothing that is not in the facts.

Reply with JSON only: {"opener": "...", "fact_used": "the fact you referred to, in a few words"}`;

type Lead = { id: number | string; name: string; title: string; company: string; geo: string; snippet: string };

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
    `Country: ${lead.geo.toUpperCase()}`,
    lead.snippet ? `From their LinkedIn profile: ${redactName(lead.snippet, lead.name).slice(0, 600)}` : '',
    ...news.slice(0, 4).map((n, i) => `News ${i + 1}${n.date ? ` (${n.date})` : ''}${n.source ? `, ${n.source}` : ''}: ${redactName(`${n.title ?? ''}. ${n.snippet ?? ''}`, lead.name).slice(0, 300)}`),
  ];
  return lines.filter(Boolean).join('\n');
}

/** An opener is usable only if it is short, plain text, and does not leak placeholders or links. */
export function cleanOpener(raw: unknown): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 320) return '';
  if (/https?:|www\.|[{}[\]<>]|the person|!|\?/i.test(s)) return '';
  if (/\b(impressive|amazing|incredible|inspiring)\b/i.test(s)) return '';
  return s;
}

/** The opener when no news or profile fact can be used: built from their role and company only, so it is never wrong. */
export function fallbackOpener(lead: { title: string; company: string }): string {
  const title = lead.title.trim();
  const company = lead.company.trim();
  if (title && company) return `Leading ${company} as ${title} puts you among the leaders our readers want to hear from.`;
  if (company) return `Your work at ${company} puts you among the leaders our readers want to hear from.`;
  return 'Your leadership journey is the kind of story our readers want to hear.';
}

export type PersonalizeSummary = { done: number; none: number; failed: number; searches: number; error?: string };

/** People with an email ready, not yet sent, and not yet personalized: main people first. */
async function waiting(db: Db, limit: number): Promise<Lead[]> {
  return db.query<Lead>(
    `SELECT id, name, title, company, geo, snippet FROM people
     WHERE ${READY_SQL} AND email <> '' AND instantly_status = '' AND opener_status IN ('', 'none')
     ORDER BY COALESCE(rank, 3) ASC, apollo_checked_at ASC NULLS LAST, id ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 25))],
  );
}

/**
 * Writes openers for the next `limit` people (at most 25 per call, four at a time). Each person costs one Serper news
 * search (when we know their company) and one DeepSeek call. Every lead handled gets an opener: from the news, or with nothing
 * specific, from their role and company. A failure leaves them unmarked to try again.
 */
export async function personalizeNext(svc: Services, db: Db, limit: number): Promise<PersonalizeSummary> {
  if (!svc.keys.deepseek) throw new Error('DEEPSEEK_API_KEY is not set');
  await ensureSchema(db);
  const leads = await waiting(db, limit);
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
async function personalizeLead(svc: Services, db: Db, lead: Lead): Promise<{ opener: string; fact: string; searches: number }> {
  const geo: Geo = isGeo(lead.geo) ? lead.geo : 'us';
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
  const reply = await askDeepSeekJson(svc, SYSTEM_PROMPT, factsFor(lead, news));
  // Every lead gets an opener: from the news or their profile when DeepSeek finds something, otherwise from their
  // role and company. Nobody is held back.
  const written = cleanOpener(reply?.opener);
  const opener = written || fallbackOpener(lead);
  const fact = written ? String(reply?.fact_used ?? '').slice(0, 200) : 'role and company (no news found)';
  await db.query("UPDATE people SET opener = $2, opener_fact = $3, opener_status = 'done', personalized_at = now() WHERE id = $1", [lead.id, opener, fact]);
  return { opener, fact, searches };
}

/**
 * Personalizes one person on demand (the "Personalize from news" button on a lead's email draft), whether or not they
 * have an email yet, and even if they were personalized before.
 */
export async function personalizeOne(svc: Services, db: Db, id: number | string): Promise<{ status: 'done' | 'none'; opener: string; fact: string }> {
  if (!svc.keys.deepseek) throw new Error('DEEPSEEK_API_KEY is not set');
  await ensureSchema(db);
  const [lead] = await db.query<Lead>('SELECT id, name, title, company, geo, snippet FROM people WHERE id = $1', [id]);
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
