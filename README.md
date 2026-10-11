# Humans of Globe Lead Engine

Finds company leaders in Africa, Europe, the US and the UAE through Apollo People Search, picks the
title to target by each company's size and industry (small firms: Owner, CEO, Founder; large firms:
Managing Director, President and similar; healthcare adds the Chief Medical Officer, hospitality the
General Manager), skips clients and anyone contacted before (suppression list), gets each lead's
verified email, personalizes every email from the news, and sends through Apollo sequences rotating
across all inboxes and domains with warm-up limits, automatic pausing on bounces or spam blocks, and
a Results page. Earlier build steps are under Tools; see [PLAN.md](PLAN.md).

Stack: TypeScript, Next.js 16, React 19, Vitest.

## Deploy on Vercel

1. Push this folder to a GitHub repository.
2. At [vercel.com/new](https://vercel.com/new), import the repository. Vercel detects Next.js.
3. Under Settings, Environment Variables, add:

   | Variable | Required | What it is |
   |---|---|---|
   | `APP_PASSWORD` | yes | Password the Step 1 page asks for. Without it the API refuses to run in production. |
   | `SERPER_API_KEY` | yes | Key from serper.dev |
   | `DATABASE_URL` | yes (step 6) | Postgres connection string (Supabase: Transaction pooler) |
   | `APOLLO_API_KEY` | yes (step 9) | Apollo master API key: finds emails and sends through sequences |
   | `APOLLO_SEQUENCE_ID` | optional | Sequence chosen by default on the Outreach page |
   | `OUTREACH_DAILY_LIMIT` | optional | Most people added to Apollo sequences per day across all inboxes (default 500) |
   | `APOLLO_DAILY_LIMIT` | optional | Most people looked up in Apollo per day, about 1 credit each (default 600) |
   | `UNSUBSCRIBE_SECRET` | yes (step 10) | Long random string that signs unsubscribe links. Set once, never change. |
   | `APP_URL` | optional | Public address for unsubscribe links when using a custom domain |
   | `JINA_API_KEY` | later | Used from step 5 |
   | `DEEPSEEK_API_KEY` | later | Used from step 4 onward |

4. Deploy (or redeploy after adding the variables). Then, on the site: import the client and
   previously contacted lists (Suppression list), check the title rules and editions (Targeting),
   create the five `HOG …` contact fields and the sequence in Apollo (Outreach, setup), connect the
   inboxes in Apollo with warm-up on (Deliverability), and press Find leads.

## Local development

Needs Node 20.9 or newer.

```bash
npm install
cp .env.example .env     # then fill in SERPER_API_KEY (APP_PASSWORD is optional locally)
npm run dev              # http://localhost:3000
npm test
npm run typecheck
```
