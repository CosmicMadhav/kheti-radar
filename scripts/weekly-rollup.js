// Weekly rollup for Kheti Radar — summarizes the last 7 days of daily_updates
// into a single digest row so the dashboard always has a "week at a glance"
// item even on days the fetcher finds little. No Claude/Anthropic dependency.

const SUPABASE_URL = "https://ykpsiwmbxslwezifqpoq.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SERVICE_KEY) {
  console.error("Missing SUPABASE_SERVICE_KEY env var.");
  process.exit(1);
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status}`);
  return res.json();
}

async function sbPost(path, rows) {
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
  if (!res.ok) console.error(`Supabase POST ${path} failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const rows = await sbGet(
    `daily_updates?select=category,amount,related_startup&update_date=gte.${weekAgo}&update_date=lt.${today}`
  );

  if (!rows.length) {
    console.log("No rows in the last 7 days — skipping rollup.");
    return;
  }

  const counts = {};
  for (const r of rows) counts[r.category] = (counts[r.category] || 0) + 1;

  const fundingAmounts = rows
    .filter((r) => r.category === "funding" && r.amount)
    .map((r) => r.amount);

  const topStartups = [...new Set(rows.map((r) => r.related_startup).filter(Boolean))].slice(0, 5);

  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${n} ${cat}`)
    .join(", ");

  const headline = `Weekly digest: ${rows.length} AgriTech India updates (${parts})`;
  const summaryBits = [];
  if (fundingAmounts.length) summaryBits.push(`Funding mentions: ${fundingAmounts.join(", ")}.`);
  if (topStartups.length) summaryBits.push(`Startups in the news: ${topStartups.join(", ")}.`);
  const summary = summaryBits.join(" ") || `${rows.length} items tracked across the last 7 days.`;

  await sbPost("daily_updates", [
    {
      update_date: today,
      headline,
      summary,
      category: "buzz",
      source_platform: "other",
      source_url: null,
      related_startup: null,
      amount: null,
    },
  ]);

  console.log(`Posted weekly digest: ${headline}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
