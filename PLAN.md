# Humans of Globe lead engine: build plan

Goal: given a brief (titles, geography, industry), produce a deduplicated list of senior people
(C-suite, founders, fund principals) with company, company domain and LinkedIn URL.
Emails (Apollo or another finder) and email sending come after this engine works.

Stack: TypeScript, Next.js 16 (a site, like Inveck), React 19, Vitest. Database (Drizzle on Postgres,
embedded locally) arrives at step 6; Tailwind and the full UI at step 8.

Rule for every step: it has a page on the site (`/steps/N`) that runs only that step, a test that
uses fake APIs, and a "done when" check. If something breaks, the failing step tells you where.
Steps 1 to 5 also keep a terminal command for quick checks.

Ported from the Inveck engine: Serper and Jina wrappers, the LinkedIn snippet parser, the
company-domain matcher and the site reader. Everything India-specific is made a parameter.

| # | Step | Command | Done when | If it fails, look at |
|---|------|---------|-----------|----------------------|
| 0 | Project setup | `npm test` | Tests pass, TypeScript compiles | Node version, `npm install` |
| 1 | Serper search, with country (UAE, US) | `npm run step:1 -- "site:linkedin.com/in founder Dubai" ae` | 10 results come back for `ae` and for `us`, with different results | `SERPER_API_KEY`, `gl` parameter |
| 2 | Query builder: brief to X-ray queries | `npm run step:2 -- brief.json` | A brief yields N distinct `site:linkedin.com/in` queries per title and city | `src/lib/queries.ts` |
| 3 | LinkedIn snippet parser: result to person | `npm run step:3 -- "<query>" ae` | Name, title, company, location and URL parsed for 8 of 10 results | `src/lib/linkedin.ts` (port of Inveck `contacts.ts`) |
| 4 | Title normaliser and seniority tag | `npm run step:4` | "Chief Technology Officer" gives `c_suite`; "Co-Founder & CEO" gives `founder` | `src/lib/seniority.ts` |
| 5 | Company domain resolver | `npm run step:5 -- "Acme Capital" ae` | Official domain found, directories rejected | `src/lib/website.ts` (port) |
| 6 | Dedupe and store | `npm run step:6` | Same LinkedIn URL twice stores once; re-run adds only new people | `src/lib/store.ts` |
| 7 | Full run: brief to saved prospects, with a cost log. People whose location is outside the searched country are dropped; people with no location line are kept and marked for review. | `npm run run -- brief.json` | Prospects table filled; log shows queries and cost per run | `src/lib/run.ts` |
| 8 | Review screen and CSV export (UI) | `npm run dev` | The team can see, filter and tag prospects | `src/app` |

After the engine: email finder (Apollo or an alternative), then email automation and sending.

## Status
- [x] Plan
- [x] Step 1 works live for the UAE (10 results with LinkedIn profiles). US search not yet checked.
- [x] Step 9 works live: 8 lookups gave 5 confident emails, 2 low-confidence, 1 no email.
- [ ] Step 7 written (`src/lib/run.ts`, `/api/runs/*`, page `/run`, tests in `tests/run.test.ts`), not yet run. A run is worked through one search per request, driven by the open page, so no request can time out and a closed tab can be continued. The `runs` table keeps the cost log: Serper searches, Apollo lookups and credits, people found, new, already saved, skipped.
- [ ] Step 10 written (Instantly; `src/lib/instantly.ts`, `src/lib/outreach.ts`, page `/outreach`, tests in `tests/outreach.test.ts`), not yet run. Sends people with an email ready to an Instantly campaign through `POST /api/v2/leads/add` (Bearer key, `skip_if_in_workspace: true`), each lead carrying its draft as custom variables `subject`, `body`, `body_html`; the campaign step uses `{{subject}}` and `{{body_html}}`. Main people first, daily cap (`INSTANTLY_DAILY_LIMIT`), preview before sending, and a test send to the team's own inbox. Not yet built: reply, bounce and unsubscribe webhooks back into the app (needs an Instantly plan with webhooks).
- [ ] UK and Canada added as countries (all four searched by default). Company size from Apollo: 25–10,000 employees is a fit; with no employee count, revenue of $2M+, funding of $1M+ or a stock listing counts as big enough; companies known to be outside the range are not emailed; companies of unknown size are kept. Pitch (`src/lib/pitch.ts`): every lead gets a draft invitation to share their leadership story, shown on Leads and in the CSV.
- [x] First full run (Quick, 10 searches): 164 new people, but all in the UAE. Fixed: searches now alternate countries inside each segment, so every run reaches both.
- Low-confidence Apollo emails now count as ready and go to email automation (labelled "Email ready · low match"). Overview shows the latest emails; "Emails ready" opens Leads filtered to them.
- [ ] Find leads simplified, not yet run: no choices to tick. Every run covers every segment in the UAE and the US; the only settings are run size (10, 30 or 60 searches) and optional Apollo. The `searched_queries` table remembers every search and how many result pages were read, so each run picks searches never made before, then goes deeper (page 3, 4, 5) into ones already read, and retires a search once its results run out. Segments added from the AI Sales Agent ICP: software and internet, financial services, media and entertainment. Pages now fill the width (centred, up to 1480px).
- [ ] ICP built in (`src/lib/icp.ts`), not yet run: Find leads picks from preset segments (company leaders, startups, hedge funds, VC, PE, family offices, real estate), each aimed at the company's main decision-maker, and searches the UAE and the US together by default. Every saved person gets a rank (1 = main person: founder, CEO, MD, president, chairman, owner, managing/general partner, and at a fund the CIO or principal; 2 = other C-suite or partner; 3 = other). Apollo looks up rank 1 first. The UI is now dark with a blue accent and a full-screen login, after the Inveck engine.
- [ ] Step 8 written as the new UI, not yet run: login screen (cookie, replaces typing the password on each page), sidebar, Overview, Find leads, Leads (filters and CSV export), Emails (Apollo), Tools (the step pages). Functions run in Tokyo (`vercel.json` regions) to sit next to the Supabase database.
- [ ] Step 6 written (`/steps/6`, `src/lib/store.ts`, `src/lib/db.ts`; Postgres via `DATABASE_URL`; tests run against an embedded Postgres in `tests/store.test.ts`), not yet run. `/api/health` now also reports whether the database answers.
- [ ] Step 9 written (`/steps/9`, `src/lib/apollo.ts`, `src/lib/enrich.ts`, `tests/apollo.test.ts`), not yet run. Uses Apollo's bulk people match (`POST /api/v1/people/bulk_match`, `x-api-key` header, 10 people per request). Tier 1 sends LinkedIn URL + name; tier 2 sends name + company for those without an email. Only founders, C-suite, owners and partners not based outside the country are sent; each person once; a daily cap (`APOLLO_DAILY_LIMIT`, default 100) applies. No phone reveal or waterfall options are sent, so no extra credits are spent on them. Needs `APOLLO_API_KEY` in Vercel.
- Scope change: the goal is LinkedIn profile URLs; Apollo turns them into emails later (step 9). Name, title and company are best-effort only.
- [ ] Steps 4 (`/steps/4`, `src/lib/seniority.ts`) and 5 (`/steps/5`, `src/lib/website.ts`, ported from Inveck) written with tests, not yet run. Next: step 6 (dedupe and store), which needs a database.
- [ ] Steps 2 and 3 written (`/steps/2`, `/steps/3`, tests in `tests/linkedin.test.ts`), not yet run: Node is not installed on this machine
- Findings from the real step 1 output that shaped step 3: the city word can match a company name (a Bay Area CEO of "Dubai Technologies"), so each person's location line is checked; titles are cut off with "..." so the line under the result supplies the full company; profile links come on several hosts (`ae.linkedin.com`, `www.linkedin.com`) so URLs are normalised.
