# Kheti Radar

Daily India AgriTech intel — funding, incubation & partnership updates pulled from LinkedIn, Twitter/X, news and government sources, plus a searchable directory of Indian AgriTech startups that links straight out to each founder's own site and LinkedIn.

**Live dashboard:** https://cosmicmadhav.github.io/kheti-radar/

## Why it's built this way

The whole pipeline is designed to keep running with **no dependency on any Claude/Anthropic subscription or session**. Everything that has to run every day lives in GitHub Actions, which is free and runs on GitHub's own infrastructure. If you never open Claude Code again, the dashboard still gets fresh data every morning.

```
                 ┌─────────────────────────────┐
                 │   GitHub Actions (free)      │
                 │   cron: 01:03 UTC daily      │
                 │                               │
                 │   scripts/daily-update.js    │
                 └───────────────┬───────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
      Serper.dev API      Google News RSS      Supabase REST API
   (Google-indexed        (free, no key,        (service_role key,
   search + news;          extra coverage)       server-side only)
   site:linkedin.com,
   hashtags, 16 news
   sites)
              │                  │                   │
              └──────────────────┴─────────►  daily_updates table
                                                       │
                 ┌─────────────────────────────────────┘
                 │
        index.html (this repo, GitHub Pages)
        — static page, queries Supabase directly
          with the public `anon` key (RLS: read-only),
          no backend server of its own
```

## Data model (Supabase)

- **`startups`** — curated directory: name, tagline, description, category tags, website URL, LinkedIn URL, city/state, founded year, funding stage.
- **`daily_updates`** — the daily feed: `update_date`, `headline`, `summary`, `category` (`funding` / `incubation` / `partnership` / `product-launch` / `policy` / `acquisition` / `award` / `buzz`), `source_platform` (`linkedin` / `twitter` / `news` / `other`), `source_url`, `related_startup`, `amount`.

Both tables have RLS enabled: anyone can `SELECT` (the dashboard uses the public `anon` key for this), but only the `service_role` key — held only in GitHub Actions secrets — can insert or update.

## Automation

### `daily-update.yml` — runs every day at 01:03 UTC (06:33 IST)

Runs `scripts/daily-update.js`, which:

1. Reads today's + the last 7 days' `daily_updates` headlines/URLs from Supabase to avoid reposting.
2. Fires a wide, data-driven query matrix at **Serper.dev** (`/search` and `/news`, with pagination and 429 backoff):
   - 35 AgriTech subsectors (precision farming, agri-drones, dairy tech, vertical farming, agri-robotics, cold chain, kisan credit, mandi digitisation, ...) crossed with 18 intents (funding, incubation, MoU, policy scheme, acquisition, ...) — a 20-query rotating slice fires each day so the full 630-combination grid gets covered over about a month without one run making hundreds of calls.
   - 16 site-scoped searches (`site:linkedin.com/posts`, `site:linkedin.com/company`, Twitter/X, Inc42, Entrackr, YourStory, AgFunderNews, Startup India, VCCircle, LiveMint, Economic Times, Business Standard, Moneycontrol, PIB, NASSCOM, Startup Grants India).
   - 6 hashtag-targeted queries (`#AgriTechIndia`, `#FarmTech`, `#VerticalFarming`, ...).
   - 12 general India-agritech news queries.
3. Also pulls **Google News RSS** (8 queries) — free, no API key or quota, purely additive coverage.
4. Filters results to agriculture-relevant items, drops near-duplicates (word-overlap against the last 7 days), guesses `category` / `source_platform` / `amount` / `related_startup` from the text with regex heuristics, and inserts up to 40 new rows.
5. On failure, opens (or comments on) a `daily-fetch-failure`-labelled GitHub issue so a silent outage never goes unnoticed again — this is exactly what happened with the earlier Claude-cloud-routine version, which failed silently behind an organization network policy block.

### `weekly-rollup.yml` — runs every Monday at 03:17 UTC

Runs `scripts/weekly-rollup.js`, which summarizes the previous 7 days of `daily_updates` (counts per category, funding amounts mentioned, startups in the news) into one digest row, so the feed always has a "week at a glance" item. Same failure-alert pattern as the daily job.

Both workflows can also be triggered manually: `gh workflow run daily-update.yml` / `gh workflow run weekly-rollup.yml`.

## Required secrets (repo → Settings → Secrets and variables → Actions)

- `SERPER_KEY` — Serper.dev API key.
- `SUPABASE_SERVICE_KEY` — Supabase `service_role` key (server-side only; never used in `index.html`).

## Local/manual run

```bash
SERPER_KEY=... SUPABASE_SERVICE_KEY=... node scripts/daily-update.js
SUPABASE_SERVICE_KEY=... node scripts/weekly-rollup.js
```

## Frontend

`index.html` is a single static file — no build step, no framework, no backend of its own. It queries Supabase's REST API directly with the public `anon` key (safe to embed: RLS restricts it to read-only) and renders the daily feed + startup directory client-side. Deployed via GitHub Pages (classic branch build from `master` / `/`) and mirrored as a Claude Artifact.
