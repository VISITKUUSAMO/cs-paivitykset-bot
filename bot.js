// CS Suomi — CS2 patch notes bot
// Posts English body (from Steam Store News RSS) + links (source + Finnish updates page).
// No startup message; embeds suppressed for links; gentle filtering to prefer patch notes.
//
// Env vars (Render):
//   BOT_TOKEN              -> Discord bot token
//   CHANNEL_ID             -> target channel ID
//   FORCE_POST_ON_BOOT     -> "true" to force-post latest once on startup (optional)
//
// package.json:
// {
//   "type": "module",
//   "scripts": { "start": "node bot.js" },
//   "dependencies": { "node-fetch": "^3.3.2" }
// }

import fetch from "node-fetch";

// ---- CONFIG ----
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const FORCE_POST_ON_BOOT =
  (process.env.FORCE_POST_ON_BOOT || "").toLowerCase() === "true";

const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";
const POLL_MS = 5 * 60 * 1000; // 5 min

// Steam Store News RSS for app 730 (CS2). `l=finnish` mainly localizes UI on the Steam site.
const RSS_URL =
  "https://store.steampowered.com/feeds/news/?appids=730&l=finnish";

// Keep last posted link (in-memory)
let lastLink = null;

// ---- Discord helpers ----
async function post(content, { suppressEmbeds = false } = {}) {
  if (!content) return;
  const payload = suppressEmbeds ? { content, flags: 4 } : { content }; // 4 = SUPPRESS_EMBEDS
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
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("Post failed:", res.status, txt);
  }
}

// ---- Utility: lightweight XML parsing ----
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

// ---- HTML -> text ----
function htmlToText(html) {
  let s = (html || "").replace(/\r/g, "");

  // line breaks & list items
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "* ");
  s = s.replace(/<\/\s*li\s*>/gi, "\n");

  // headings -> [ UPPERCASE ]
  s = s.replace(/<\s*h[1-3][^>]*>([\s\S]*?)<\/\s*h[1-3]\s*>/gi, (_, t) => {
    const clean = (t || "").replace(/<[^>]+>/g, "").trim().toUpperCase();
    return clean ? `\n[ ${clean} ]\n` : "\n";
  });

  // paragraphs
  s = s.replace(/<\s*p[^>]*>/gi, "\n");
  s = s.replace(/<\/\s*p\s*>/gi, "\n");

  // bold/italic
  s = s.replace(/<\s*strong[^>]*>([\s\S]*?)<\/\s*strong\s*>/gi, "**$1**");
  s = s.replace(/<\s*b[^>]*>([\s\S]*?)<\/\s*b\s*>/gi, "**$1**");
  s = s.replace(/<\s*i[^>]*>([\s\S]*?)<\/\s*i\s*>/gi, "*$1*");
  s = s.replace(/<\s*em[^>]*>([\s\S]*?)<\/\s*em\s*>/gi, "*$1*");

  // links: keep text only
  s = s.replace(/<\s*a [^>]*>([\s\S]*?)<\/\s*a\s*>/gi, "$1");

  // strip images/scripts/styles/other tags
  s = s.replace(/<\s*img[^>]*>/gi, "");
  s = s.replace(/<\s*script[\s\S]*?<\/\s*script\s*>/gi, "");
  s = s.replace(/<\s*style[\s\S]*?<\/\s*style\s*>/gi, "");
  s = s.replace(/<[^>]+>/g, "");

  // collapse extra blank lines
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// First message includes header; subsequent messages are body chunks
function chunksWithHeader(headerLine, body) {
  const LIMIT = 2000;
  const header = `${headerLine}\n\n`;
  const chunks = [];

  if ((header + body).length <= LIMIT) {
    chunks.push(header + body);
    return chunks;
  }

  const firstRoom = LIMIT - header.length;
  chunks.push(header + body.slice(0, firstRoom));

  for (let i = firstRoom; i < body.length; i += 1900) {
    chunks.push(body.slice(i, i + 1900));
  }
  return chunks;
}

// ---- Patch-notes heuristics ----
function looksLikePatchNotes(title, link) {
  const t = (title || "").toLowerCase();
  const l = (link || "").toLowerCase();
  return (
    /update|release notes|patch|client update/i.test(t) ||
    /\/news\/updates\//.test(l) || // counter-strike.net
    /store\.steampowered\.com\/news\/app\/730\/view\//.test(l) // Steam News for CS2
  );
}

// ---- Core: fetch & pick the latest likely patch-notes item ----
async function fetchLatestUpdateItem() {
  const r = await fetch(RSS_URL, { headers: { "User-Agent": "cs-suomi-bot/3.3" } });
  if (!r.ok) throw new Error("RSS request failed: " + r.status);
  const xml = await r.text();

  const itemBlocks = findAll(/<item>([\s\S]*?)<\/item>/gi, xml);
  console.log(`RSS items found: ${itemBlocks.length}`);

  let best = null;
  let bestLink = null;
  let bestTitle = null;

  for (const it of itemBlocks) {
    const link =
      firstMatch(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/i, it) ||
      firstMatch(/<link>([\s\S]*?)<\/link>/i, it);
    const title =
      firstMatch(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i, it) ||
      firstMatch(/<title>([\s\S]*?)<\/title>/i, it) ||
      "";

    if (looksLikePatchNotes(title, link)) {
      best = it;
      bestLink = (link || "").trim();
      bestTitle = title.trim();
      break;
    }
  }

  // Fallback: take newest if none matched heuristics
  if (!best && itemBlocks.length) {
    best = itemBlocks[0];
    bestLink =
      (firstMatch(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/i, best) ||
        firstMatch(/<link>([\s\S]*?)<\/link>/i, best) ||
        "").trim();
    bestTitle =
      firstMatch(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i, best) ||
      firstMatch(/<title>([\s\S]*?)<\/title>/i, best) ||
      "CS Update";
  }

  if (!best) return null;

  // Body: prefer <content:encoded>, else <description>
  const encoded = firstMatch(
    /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/i,
    best
  );
  const desc =
    firstMatch(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i, best) ||
    firstMatch(/<description>([\s\S]*?)<\/description>/i, best);

  const html = encoded || desc || "";
  const text = htmlToText(html);

  // Source link we discovered from RSS
  const sourceLink = bestLink;

  // A Finnish landing page to share as well
  const finnishUpdatesLanding =
    "https://www.counter-strike.net/news/updates?l=finnish";

  return { title: bestTitle, text, sourceLink, finnishUpdatesLanding };
}

async function processOnce(reason = "poll") {
  try {
    console.log(`[${reason}] Fetching RSS…`);
    const item = await fetchLatestUpdateItem();
    if (!item) {
      console.log("No suitable RSS item parsed.");
      return;
    }

    const isNew = item.sourceLink && item.sourceLink !== lastLink;
    if (isNew || FORCE_POST_ON_BOOT) {
      const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**`;

      // English body, Finnish header
      const parts = chunksWithHeader(header, item.text || "Patch notes available at the links below.");
      for (const p of parts) await post(p);

      // 1) Original source link (embed suppressed)
      if (item.sourceLink) await post(item.sourceLink, { suppressEmbeds: true });

      // 2) Finnish updates landing (embed suppressed)
      await post(item.finnishUpdatesLanding, { suppressEmbeds: true });

      lastLink = item.sourceLink || lastLink;
      console.log("Posted update from:", item.sourceLink);
    } else {
      console.log("No new update (same link).");
    }
  } catch (e) {
    console.error("Process error:", e);
  }
}

async function poll() {
  await processOnce("poll");
}

// ---- Startup ----
if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing BOT_TOKEN or CHANNEL_ID");
  process.exit(1);
}

// No startup announcement
await processOnce("startup");
setInterval(poll, POLL_MS);
