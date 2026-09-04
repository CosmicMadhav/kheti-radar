# Kheti Radar

Daily India AgriTech intel — funding, incubation & partnership updates from across LinkedIn, Twitter/X and news, plus a searchable directory of Indian AgriTech startups with direct links to their website and LinkedIn.

Live data via [Supabase](https://supabase.com) (public read-only, RLS enforced). No backend server — this is a single static `index.html` that queries Supabase directly and redirects out to each startup's own site.

## Live site

Hosted via GitHub Pages from this repo (`index.html` at the root).

## Data model

- `startups` — curated directory: name, tagline, category tags, website, LinkedIn, city/state, founded year, funding stage
- `daily_updates` — the daily feed: headline, summary, category (funding / incubation / partnership / product-launch / policy / acquisition / award / buzz), source platform, source URL, related startup, amount

## Keeping it fresh

A scheduled job searches for new India AgriTech news each day and inserts rows into `daily_updates` via the Supabase `service_role` key (server-side only — never in this repo or the page).
