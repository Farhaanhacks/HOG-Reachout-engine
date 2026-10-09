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
| 7 | Full run: brief to saved prospects, with a cost log | `npm run run -- brief.json` | Prospects table filled; log shows queries and cost per run | `src/lib/run.ts` |
| 8 | Review screen and CSV export (UI) | `npm run dev` | The team can see, filter and tag prospects | `src/app` |

After the engine: email finder (Apollo or an alternative), then email automation and sending.

## Status
- [x] Plan
- [ ] Step 0 and 1 written (including the site page `/steps/1`), not yet run (Node is not installed on this machine)
