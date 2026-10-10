# Humans of Globe Lead Engine

Finds senior people (C-suite, founders, fund principals) in the UAE and the US and tags their
LinkedIn profiles. Built step by step; see [PLAN.md](PLAN.md). Status: step 1 (Serper search by
country) is built; the other steps are not.

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
   | `APOLLO_API_KEY` | yes (step 9) | Apollo API key; needs a plan with API access |
   | `APOLLO_DAILY_LIMIT` | optional | Most people sent to Apollo per day (default 100) |
   | `JINA_API_KEY` | later | Used from step 5 |
   | `DEEPSEEK_API_KEY` | later | Used from step 4 onward |

4. Deploy (or redeploy after adding the variables), open the site and go to Step 1.

## Local development

Needs Node 20.9 or newer.

```bash
npm install
cp .env.example .env     # then fill in SERPER_API_KEY (APP_PASSWORD is optional locally)
npm run dev              # http://localhost:3000
npm test
npm run typecheck
```
