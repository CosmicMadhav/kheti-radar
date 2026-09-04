// Daily AgriTech-India intel fetcher for Kheti Radar.
// Runs on GitHub Actions (no Claude/Anthropic dependency) — needs only
// SERPER_KEY and SUPABASE_SERVICE_KEY as repo secrets. Subscription-independent:
// this keeps running on GitHub's free cron infra even if Claude Code access lapses.

const SUPABASE_URL = "https://ykpsiwmbxslwezifqpoq.supabase.co";
const SERPER_KEY = process.env.SERPER_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAX_ROWS_PER_RUN = 25;
const PAGES_PER_QUERY = 2;

if (!SERPER_KEY || !SERVICE_KEY) {
  console.error("Missing SERPER_KEY or SUPABASE_SERVICE_KEY env vars.");
  process.exit(1);
}

// ---------- Query matrix: subsectors × intents × site-scoped sources ----------
// Data-driven so coverage stays broad without hand-writing hundreds of near-duplicate strings.

const SUBSECTORS = [
  "agritech", "precision farming", "farm mechanization", "agri drone",
  "dairy tech", "agri fintech", "post-harvest tech", "agri supply chain",
  "agri biotech", "aquaculture tech", "horticulture tech", "agri marketplace",
  "climate-smart agriculture", "farm-to-fork", "agri IoT sensors",
  "crop insurance tech", "soil health tech", "livestock tech",
];

const INTENTS = [
  "funding round", "seed funding", "incubator accelerator cohort",
  "government partnership", "corporate partnership", "product launch",
  "policy scheme grant", "acquisition merger", "startup award recognition",
];

const SITE_SOURCES = [
  "site:linkedin.com/posts",
  "site:linkedin.com/company",
  "site:twitter.com OR site:x.com",
  "site:startupgrantsindia.com",
  "site:inc42.com",
  "site:entrackr.com",
  "site:yourstory.com",
  "site:agfundernews.com",
  "site:startupindia.gov.in",
];

const HASHTAG_QUERIES = [
  '"#AgriTechIndia" OR "#IndianAgriculture" OR "#AgriTech" India startup',
  '"#FarmTech" OR "#AgriInnovation" OR "#Kisan" India startup',
  '"#PrecisionFarming" OR "#AgriStartup" OR "#SmartFarming" India',
  '"#AgriFintech" OR "#FarmToFork" OR "#AgTech" India funding',
];

function buildSearchQueries() {
  const queries = new Set(HASHTAG_QUERIES);
  for (const site of SITE_SOURCES) {
    queries.add(`${site} agritech India funding OR incubation OR partnership`);
  }
  // Sample a rotating slice of the subsector × intent grid each day so the
  // full matrix gets covered over a week without one run making 150+ calls.
  const dayIndex = new Date().getUTCDate();
  const grid = [];
  for (const sub of SUBSECTORS) for (const intent of INTENTS) grid.push([sub, intent]);
  const sliceSize = 14;
  const start = (dayIndex * sliceSize) % grid.length;
  for (let i = 0; i < sliceSize; i++) {
    const [sub, intent] = grid[(start + i) % grid.length];
    queries.add(`India ${sub} startup ${intent}`);
  }
  return [...queries];
}

const NEWS_QUERIES = [
  "India agritech startup funding announcement",
  "India agritech incubator accelerator cohort announcement",
  "India agritech government partnership ICAR DPIIT RKVY",
  "India agritech product launch",
  "DPIIT recognised agritech startup",
  "India agri fintech startup news",
  "India precision farming startup news",
];

// ---------- Categorisation heuristics ----------

const CATEGORY_RULES = [
  [/raises|funding round|invest(ed|s|ment)|series [a-e]\b|crore|\$\s?\d|seed round/i, "funding"],
  [/incubat|accelerat|cohort|grant\b/i, "incubation"],
  [/partner|mou\b|collaborat/i, "partnership"],
  [/launch|unveil|introduc/i, "product-launch"],
  [/policy|government|ministry|scheme|dpiit|rkvy/i, "policy"],
  [/acquir|acquisition|acquired/i, "acquisition"],
  [/award|wins|winner|recognised|recognized/i, "award"],
];

function guessCategory(text) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(text)) return cat;
  return "buzz";
}

function guessPlatform(url) {
  if (/linkedin\.com/i.test(url)) return "linkedin";
  if (/twitter\.com|x\.com/i.test(url)) return "twitter";
  return "news";
}

function extractAmount(text) {
  const usd = text.match(/\$\s?\d+(\.\d+)?\s?(million|billion|M|B|K)?/i);
  if (usd) return usd[0].replace(/\s+/g, " ").trim();
  const inr = text.match(/₹\s?\d+(\.\d+)?\s?(crore|cr|lakh|l)\b/i);
  if (inr) return inr[0].replace(/\s+/g, " ").trim();
  return null;
}

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordOverlap(a, b) {
  const wa = new Set(normalize(a).split(" ").filter((w) => w.length > 3));
  const wb = new Set(normalize(b).split(" ").filter((w) => w.length > 3));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

// ---------- Serper client with retry/backoff ----------

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function serperCall(endpoint, body, attempt = 1) {
  const res = await fetch(`https://google.serper.dev/${endpoint}`, {
    method: "POST",
    headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && attempt <= 3) {
    await sleep(attempt * 1000);
    return serperCall(endpoint, body, attempt + 1);
  }
  if (!res.ok) {
    console.error(`Serper ${endpoint} failed for "${body.q}": ${res.status}`);
    return [];
  }
  const data = await res.json();
  return [...(data.organic || []), ...(data.news || [])];
}

async function serper(endpoint, q, pages = 1) {
  const results = [];
  for (let page = 1; page <= pages; page++) {
    const items = await serperCall(endpoint, { q, gl: "in", num: 15, page });
    results.push(...items);
    if (!items.length) break;
  }
  return results;
}

// ---------- Supabase REST helpers ----------

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status}`);
  return res.json();
}

async function sbPost(path, rows) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    console.error(`Supabase POST ${path} failed: ${res.status} ${await res.text()}`);
  }
}

// ---------- Main ----------

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const [existingToday, recentWindow, knownStartups] = await Promise.all([
    sbGet(`daily_updates?select=headline,source_url&update_date=eq.${today}`),
    sbGet(
      `daily_updates?select=headline,source_url&update_date=gte.${new Date(
        Date.now() - 6 * 86400000
      )
        .toISOString()
        .slice(0, 10)}`
    ),
    sbGet(`startups?select=name`),
  ]);

  const seenUrls = new Set([...existingToday, ...recentWindow].map((r) => r.source_url).filter(Boolean));
  const seenHeadlines = [...existingToday, ...recentWindow].map((r) => r.headline);
  const startupNames = knownStartups.map((s) => s.name);

  const searchQueries = buildSearchQueries();
  console.log(`Running ${searchQueries.length} search queries + ${NEWS_QUERIES.length} news queries (day slice: ${new Date().getUTCDate()}).`);

  const candidates = [];
  for (const q of searchQueries) candidates.push(...(await serper("search", q, PAGES_PER_QUERY)));
  for (const q of NEWS_QUERIES) candidates.push(...(await serper("news", q, PAGES_PER_QUERY)));

  console.log(`Fetched ${candidates.length} raw results before filtering.`);

  const rows = [];
  const usedUrls = new Set();
  for (const item of candidates) {
    const url = item.link;
    const title = item.title;
    if (!url || !title) continue;
    if (seenUrls.has(url) || usedUrls.has(url)) continue;
    if (!/agri|farm|kisan|krishi|dairy|aquacultur|horticultur/i.test(`${title} ${item.snippet || ""}`)) continue;
    if (seenHeadlines.some((h) => wordOverlap(h, title) > 0.6)) continue;

    const summary = (item.snippet || "").slice(0, 400) || null;
    const fullText = `${title} ${summary || ""}`;
    const relatedStartup = startupNames.find((n) => fullText.toLowerCase().includes(n.toLowerCase())) || null;

    rows.push({
      update_date: today,
      headline: title.slice(0, 300),
      summary,
      category: guessCategory(fullText),
      source_platform: guessPlatform(url),
      source_url: url,
      related_startup: relatedStartup,
      amount: extractAmount(fullText),
    });
    usedUrls.add(url);
    seenHeadlines.push(title);
    if (rows.length >= MAX_ROWS_PER_RUN) break;
  }

  await sbPost("daily_updates", rows);
  console.log(`Inserted ${rows.length} daily_updates rows for ${today}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
