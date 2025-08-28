// CS Suomi — CS2 patch notes bot
// Source: official Counter-Strike.net updates RSS
// Posts English text body (from RSS) + Finnish updates link
// No startup announcement; with Discord 429 retry + pacing

import fetch from "node-fetch";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const FORCE_POST_ON_BOOT =
  (process.env.FORCE_POST_ON_BOOT || "").toLowerCase() === "true";

const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";
const POLL_MS = 5 * 60 * 1000; // every 5 min

// Official CS2 updates RSS
const RSS_URL = "https://www.counter-strike.net/news/updates/rss";

// In-memory last posted link
let lastLink = null;

// ---- Discord post helper ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(content, { suppressEmbeds = false } = {}) {
  if (!content) return;
  const payload = suppressEmbeds ? { content, flags: 4 } : { content };
  while (true) {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    if (res.ok) return;
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const wait = Math.ceil((data.retry_after || 0.5) * 1000);
      console.warn("Rate limited, waiting", wait, "ms");
      await sleep(wait);
      continue;
    }
    const txt = await res.text().catch(() => "");
    console.error("Post failed:", res.status, txt);
    break;
  }
}

// ---- Utilities ----
function firstMatch(re, text) {
  const m = re.exec(text);
  return m ? (m[1] || m[2]) : null;
}
function findAll(re, text) {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}
function htmlDecode(s = "") {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function htmlToText(htmlRaw) {
  let html = htmlDecode(htmlRaw || "");
  let s = html.replace(/\r/g, "");

  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "* ");
  s = s.replace(/<\/\s*li\s*>/gi, "\n");
  s = s.replace(/<\s*h[1-3][^>]*>([\s\S]*?)<\/\s*h[1-3]\s*>/gi, (_, t) => {
    const clean = (t || "").replace(/<[^>]+>/g, "").trim().toUpperCase();
    return clean ? `\n[ ${clean} ]\n` : "\n";
  });
  s = s.replace(/<\s*p[^>]*>/gi, "\n");
  s = s.replace(/<\/\s*p\s*>/gi, "\n");

  // Bold/italic
  s = s.replace(/<\s*strong[^>]*>([\s\S]*?)<\/\s*strong\s*>/gi, "**$1**");
  s = s.replace(/<\s*b[^>]*>([\s\S]*?)<\/\s*b\s*>/gi, "**$1**");
  s = s.replace(/<\s*i[^>]*>([\s\S]*?)<\/\s*i\s*>/gi, "*$1*");

  // Links: keep only text
  s = s.replace(/<\s*a [^>]*>([\s\S]*?)<\/\s*a\s*>/gi, "$1");

  // Strip other tags
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
function chunksWithHeader(headerLine, body) {
  const LIMIT = 2000;
  const header = `${headerLine}\n\n`;
  const chunks = [];
  if ((header + body).length <= LIMIT) {
    chunks.push(header + body);
  } else {
    const firstRoom = LIMIT - header.length;
    chunks.push(header + body.slice(0, firstRoom));
    for (let i = firstRoom; i < body.length; i += 1800) {
      chunks.push(body.slice(i, i + 1800));
    }
  }
  return chunks;
}

// ---- Fetch & parse RSS ----
async function fetchLatestItem() {
  const r = await fetch(RSS_URL, { headers: { "User-Agent": "cs-suomi-bot/4.0" } });
  if (!r.ok) throw new Error("RSS request failed: " + r.status);
  const xml = await r.text();

  const items = findAll(/<item>([\s\S]*?)<\/item>/gi, xml);
  if (!items.length) return null;

  const it = items[0]; // always latest
  const link = firstMatch(/<link>([\s\S]*?)<\/link>/i, it)?.trim();
  const title = firstMatch(/<title>([\s\S]*?)<\/title>/i, it)?.trim() || "CS2 Update";

  const encoded = firstMatch(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/i, it);
  const desc =
    firstMatch(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i, it) ||
    firstMatch(/<description>([\s\S]*?)<\/description>/i, it);

  const html = encoded || desc || "";
  const text = htmlToText(html);

  return {
    title,
    text,
    sourceLink: link,
    finnishLanding: "https://www.counter-strike.net/news/updates?l=finnish",
  };
}

// ---- Process ----
async function processOnce(reason = "poll") {
  console.log(`[${reason}] Fetching RSS…`);
  try {
    const item = await fetchLatestItem();
    if (!item) {
      console.log("No RSS item found.");
      return;
    }

    const isNew = item.sourceLink && item.sourceLink !== lastLink;
    if (isNew || FORCE_POST_ON_BOOT) {
      const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**`;
      const parts = chunksWithHeader(header, item.text);
      for (const p of parts) {
        await post(p);
        await sleep(600);
      }
      if (item.sourceLink) {
        await post(item.sourceLink, { suppressEmbeds: true });
        await sleep(400);
      }
      await post(item.finnishLanding, { suppressEmbeds: true });

      lastLink = item.sourceLink;
      console.log("Posted update from:", item.sourceLink);
    } else {
      console.log("No new update (same link).");
    }
  } catch (e) {
    console.error("Process error:", e);
  }
}

// ---- Startup ----
if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing BOT_TOKEN or CHANNEL_ID");
  process.exit(1);
}
await processOnce("startup");
setInterval(processOnce, POLL_MS);
