// Daily AgriTech-India intel fetcher for Kheti Radar.
// Runs on GitHub Actions (no Claude/Anthropic dependency) — needs only
// SERPER_KEY and SUPABASE_SERVICE_KEY as repo secrets.

const SUPABASE_URL = "https://ykpsiwmbxslwezifqpoq.supabase.co";
const SERPER_KEY = process.env.SERPER_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SERPER_KEY || !SERVICE_KEY) {
  console.error("Missing SERPER_KEY or SUPABASE_SERVICE_KEY env vars.");
  process.exit(1);
}

const QUERIES_SEARCH = [
  "site:linkedin.com/posts agritech India funding OR incubation OR partnership",
  "site:linkedin.com/company agritech India startup",
  '"#AgriTechIndia" OR "#IndianAgriculture" OR "#AgriTech" India startup',
  '"#FarmTech" OR "#AgriInnovation" OR "#Kisan" India startup',
  "site:twitter.com OR site:x.com agritech India funding",
  "site:startupgrantsindia.com agritech grants funding",
];

const QUERIES_NEWS = [
  "India agritech startup funding announcement",
  "India agritech incubator accelerator cohort announcement",
  "India agritech government partnership ICAR DPIIT RKVY",
  "India agritech product launch",
  "DPIIT recognised agritech startup",
];

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

async function serper(endpoint, q) {
  const res = await fetch(`https://google.serper.dev/${endpoint}`, {
    method: "POST",
    headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q, gl: "in", num: 15 }),
  });
  if (!res.ok) {
    console.error(`Serper ${endpoint} failed for "${q}": ${res.status}`);
    return [];
  }
  const data = await res.json();
  return [...(data.organic || []), ...(data.news || [])];
}

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

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await sbGet(
    `daily_updates?select=headline,source_url&update_date=eq.${today}`
  );
  const seenUrls = new Set(existing.map((r) => r.source_url).filter(Boolean));
  const seenHeadlines = new Set(existing.map((r) => (r.headline || "").toLowerCase()));

  const candidates = [];
  for (const q of QUERIES_SEARCH) candidates.push(...(await serper("search", q)));
  for (const q of QUERIES_NEWS) candidates.push(...(await serper("news", q)));

  const rows = [];
  const usedUrls = new Set();
  for (const item of candidates) {
    const url = item.link;
    const title = item.title;
    if (!url || !title) continue;
    if (seenUrls.has(url) || usedUrls.has(url)) continue;
    if (seenHeadlines.has(title.toLowerCase())) continue;
    if (!/agri|farm|kisan|krishi/i.test(`${title} ${item.snippet || ""}`)) continue;

    const summary = (item.snippet || "").slice(0, 400) || null;
    rows.push({
      update_date: today,
      headline: title.slice(0, 300),
      summary,
      category: guessCategory(`${title} ${summary || ""}`),
      source_platform: guessPlatform(url),
      source_url: url,
      related_startup: null,
      amount: extractAmount(`${title} ${summary || ""}`),
    });
    usedUrls.add(url);
    if (rows.length >= 15) break;
  }

  await sbPost("daily_updates", rows);
  console.log(`Inserted ${rows.length} daily_updates rows for ${today}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
