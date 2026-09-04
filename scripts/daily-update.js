// Daily AgriTech-India intel fetcher for Kheti Radar.
// Runs on GitHub Actions (no Claude/Anthropic dependency) — needs only
// SERPER_KEY and SUPABASE_SERVICE_KEY as repo secrets. Subscription-independent:
// this keeps running on GitHub's free cron infra even if Claude Code access lapses.

const SUPABASE_URL = "https://ykpsiwmbxslwezifqpoq.supabase.co";
const SERPER_KEY = process.env.SERPER_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAX_ROWS_PER_RUN = 60;
const PAGES_PER_QUERY = 3;

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
  "vertical farming", "controlled environment agriculture", "agri robotics",
  "seed tech", "biofertilizer", "biopesticide", "cold chain logistics",
  "warehouse tech", "electric tractor", "water management tech",
  "weather intelligence agri", "blockchain traceability agri",
  "farm labor tech", "agri export tech", "rural fintech", "kisan credit tech",
  "mandi digitisation", "crop residue management", "agri e-commerce",
];

const INTENTS = [
  "funding round", "seed funding", "pre-seed funding", "series A funding",
  "incubator accelerator cohort", "government partnership",
  "corporate partnership", "CSR initiative", "research collaboration",
  "product launch", "pilot program", "policy scheme grant",
  "state government scheme", "budget allocation", "acquisition merger",
  "startup award recognition", "MoU signed", "IPO",
];

const SITE_SOURCES = [
  "site:linkedin.com/posts",
  "site:linkedin.com/company",
  "site:linkedin.com/pulse",
  "site:twitter.com OR site:x.com",
  "site:startupgrantsindia.com",
  "site:inc42.com",
  "site:entrackr.com",
  "site:yourstory.com",
  "site:agfundernews.com",
  "site:startupindia.gov.in",
  "site:vccircle.com",
  "site:livemint.com",
  "site:economictimes.indiatimes.com",
  "site:business-standard.com",
  "site:moneycontrol.com",
  "site:pib.gov.in",
  "site:nasscom.in",
  "site:crunchbase.com",
  "site:tracxn.com",
  "site:dealstreetasia.com",
  "site:techcircle.in",
  "site:forbesindia.com",
  "site:cnbctv18.com",
  "site:financialexpress.com",
  "site:timesofindia.indiatimes.com",
];

// AgriTech activity concentrates heavily in these states — a rotating
// state × subsector slice surfaces hyperlocal news the generic queries miss.
const STATES = [
  "Punjab", "Haryana", "Maharashtra", "Karnataka", "Madhya Pradesh",
  "Uttar Pradesh", "Bihar", "Tamil Nadu", "Gujarat", "Rajasthan",
  "Telangana", "Andhra Pradesh", "West Bengal", "Odisha", "Kerala",
];

const HASHTAG_QUERIES = [
  '"#AgriTechIndia" OR "#IndianAgriculture" OR "#AgriTech" India startup',
  '"#FarmTech" OR "#AgriInnovation" OR "#Kisan" India startup',
  '"#PrecisionFarming" OR "#AgriStartup" OR "#SmartFarming" India',
  '"#AgriFintech" OR "#FarmToFork" OR "#AgTech" India funding',
  '"#VerticalFarming" OR "#AgriRobotics" OR "#ClimateSmartAg" India',
  '"#RuralFintech" OR "#MandiTech" OR "#ColdChain" India agritech',
];

function rotatingSlice(items, dayIndex, sliceSize) {
  const start = (dayIndex * sliceSize) % items.length;
  const out = [];
  for (let i = 0; i < sliceSize; i++) out.push(items[(start + i) % items.length]);
  return out;
}

function buildSearchQueries() {
  const queries = new Set(HASHTAG_QUERIES);
  for (const site of SITE_SOURCES) {
    queries.add(`${site} agritech India funding OR incubation OR partnership`);
  }

  const dayIndex = new Date().getUTCDate();

  // Subsector × intent grid — rotated so the full ~630-combination matrix
  // gets covered over about a month without one run making hundreds of calls.
  const subIntentGrid = [];
  for (const sub of SUBSECTORS) for (const intent of INTENTS) subIntentGrid.push([sub, intent]);
  for (const [sub, intent] of rotatingSlice(subIntentGrid, dayIndex, 20)) {
    queries.add(`India ${sub} startup ${intent}`);
  }

  // State × subsector grid — surfaces hyperlocal news the national queries miss.
  const stateSubGrid = [];
  for (const state of STATES) for (const sub of SUBSECTORS) stateSubGrid.push([state, sub]);
  for (const [state, sub] of rotatingSlice(stateSubGrid, dayIndex, 10)) {
    queries.add(`${state} agritech startup ${sub} funding OR launch OR partnership`);
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
  "India dairy tech startup news",
  "India agri drone startup news",
  "India vertical farming startup news",
  "India agri biotech startup news",
  "India cold chain logistics startup news",
];

// Free supplementary source: Google News RSS needs no API key/quota, so it
// widens coverage without spending Serper credits.
const GNEWS_QUERIES = [
  "India agritech startup",
  "India agritech funding",
  "India agri fintech",
  "India precision farming startup",
  "India dairy technology startup",
  "India agri drone company",
  "India vertical farming startup",
  "India agri supply chain startup",
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

// Accepts either Serper's relative strings ("2 hours ago", "1 day ago") or an
// absolute date (RFC822 from RSS, or "Sep 4, 2026" from Serper). Missing/
// unparseable dates are treated as unknown, not rejected outright — the
// caller decides how strict to be.
const MAX_AGE_HOURS = 30;

function parseRelativeOrAbsolute(dateStr) {
  if (!dateStr) return null;
  const rel = /^(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago$/i.exec(dateStr.trim());
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unitHours = { minute: 1 / 60, hour: 1, day: 24, week: 24 * 7, month: 24 * 30, year: 24 * 365 };
    return new Date(Date.now() - n * unitHours[rel[2].toLowerCase()] * 3600000);
  }
  const abs = new Date(dateStr);
  return isNaN(abs.getTime()) ? null : abs;
}

function isRecentEnough(dateStr) {
  const parsed = parseRelativeOrAbsolute(dateStr);
  if (!parsed) return null; // unknown — caller decides
  return (Date.now() - parsed.getTime()) / 3600000 <= MAX_AGE_HOURS;
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

// tbs:"qdr:d" restricts Google's own results to roughly the last 24 hours —
// the strongest lever we have for "today's news only", applied at the source
// rather than trying to guess an article's age after the fact.
async function serper(endpoint, q, pages = 1) {
  const results = [];
  for (let page = 1; page <= pages; page++) {
    const items = await serperCall(endpoint, { q, gl: "in", num: 15, page, tbs: "qdr:d" });
    results.push(...items);
    if (!items.length) break;
  }
  return results;
}

// ---------- Google News RSS (free, no key/quota — widens coverage) ----------

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function googleNews(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  } catch (err) {
    console.error(`Google News RSS fetch failed for "${q}": ${err.message}`);
    return [];
  }
  if (!res.ok) {
    console.error(`Google News RSS failed for "${q}": ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < 15) {
    const block = m[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1];
    const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1];
    const desc = /<description>([\s\S]*?)<\/description>/.exec(block)?.[1];
    const pubDate = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1];
    if (title && link) {
      items.push({
        title: decodeEntities(title.replace(/<!\[CDATA\[|\]\]>/g, "").trim()),
        link: link.trim(),
        snippet: desc ? decodeEntities(desc.replace(/<!\[CDATA\[|\]\]>|<[^>]+>/g, "").trim()) : "",
        date: pubDate ? pubDate.trim() : null,
      });
    }
  }
  return items;
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
  console.log(
    `Running ${searchQueries.length} Serper search queries + ${NEWS_QUERIES.length} Serper news queries + ${GNEWS_QUERIES.length} Google News RSS queries (day slice: ${new Date().getUTCDate()}).`
  );

  const candidates = [];
  for (const q of searchQueries) candidates.push(...(await serper("search", q, PAGES_PER_QUERY)));
  for (const q of NEWS_QUERIES) candidates.push(...(await serper("news", q, PAGES_PER_QUERY)));
  for (const q of GNEWS_QUERIES) candidates.push(...(await googleNews(q)));

  console.log(`Fetched ${candidates.length} raw results before filtering.`);

  const rows = [];
  const usedUrls = new Set();
  let staleDropped = 0;
  for (const item of candidates) {
    const url = item.link;
    const title = item.title;
    if (!url || !title) continue;
    if (seenUrls.has(url) || usedUrls.has(url)) continue;
    if (!/agri|farm|kisan|krishi|dairy|aquacultur|horticultur/i.test(`${title} ${item.snippet || ""}`)) continue;
    if (seenHeadlines.some((h) => wordOverlap(h, title) > 0.6)) continue;
    // Only known-stale items are dropped here — tbs:qdr:d already restricts
    // Serper's own results to ~last 24h, this catches RSS/date-bearing items
    // that slipped through with an older date.
    if (isRecentEnough(item.date) === false) { staleDropped++; continue; }

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
  console.log(`Inserted ${rows.length} daily_updates rows for ${today} (dropped ${staleDropped} as stale).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
