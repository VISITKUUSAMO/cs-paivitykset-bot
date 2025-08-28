// CS Suomi — CS2 patch notes bot (English body + Finnish link)
// Fixes:
//  - Strict CS2 filtering (/app/730/ or counter-strike.net)
//  - HTML entity unescape before cleaning (Steam RSS ships escaped HTML)
//  - Basic handling for Steam bb_* blocks
//  - Discord 429 retry + pacing between messages
//
// Env vars:
//   BOT_TOKEN
//   CHANNEL_ID
//   FORCE_POST_ON_BOOT ("true" to force-post latest once on startup; optional)
//
// package.json:
// { "type": "module", "scripts": { "start": "node bot.js" }, "dependencies": { "node-fetch": "^3.3.2" } }

import fetch from "node-fetch";

// ---- CONFIG ----
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const FORCE_POST_ON_BOOT = (process.env.FORCE_POST_ON_BOOT || "").toLowerCase() === "true";

const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";
const POLL_MS = 5 * 60 * 1000; // 5 min

// Steam Store News RSS for CS2
const RSS_URL = "https://store.steampowered.com/feeds/news/?appids=730&l=finnish";

// Remember last posted link (in-memory)
let lastLink = null;

// ---- Helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(content, { suppressEmbeds = false, attempts = 3 } = {}) {
  if (!content) return;
  const payload = suppressEmbeds ? { content, flags: 4 } : { content };

  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) return;
    const txt = await res.text().catch(() => "");
    if (res.status === 429) {
      // Respect rate limit and retry
      try {
        const data = JSON.parse(txt);
        const wait = Math.ceil((data.retry_after || 0.5) * 1000);
        console.warn("Rate limited, waiting", wait, "ms");
        await sleep(wait);
        continue;
      } catch {
        await sleep(800);
        continue;
      }
    }
    console.error("Post failed:", res.status, txt);
    // For non-429 errors, do not retry aggressively
    break;
  }
}

// Lightweight XML helpers
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

// Decode HTML entities (&lt; &gt; &amp; &quot; &#39; and numeric)
function htmlDecode(input) {
  if (!input) return "";
  let s = input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // numeric entities
  s = s.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return s;
}

// HTML -> text with Steam bb_* awareness
function htmlToText(htmlRaw) {
  // Step 1: unescape if escaped
  let html = htmlDecode(htmlRaw || "");

  // Normalize Steam bb_* block classes to semantic tags
  // <div class="bb_h2"> -> <h2> ... </h2>
  html = html.replace(/<\s*div\s+class=["']bb_h2["'][^>]*>([\s\S]*?)<\/\s*div\s*>/gi, "<h2>$1</h2>");
  // Lists already come as <ul class="bb_ul"> with <li>, fine.

  // Now standard cleaning
  let s = html.replace(/\r/g, "");

  // line breaks & list items
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "* ");
  s = s.replace(/<\/\s*li\s*>/gi, "\n");

  // headings -> [ UPPERCASE ]
  s = s.replace(/<\s*h[1-3][^>]*>([\s\S]*?)<\/\s*h[1-3]\s*>/gi, (_, t) => {
    const clean = (t || "").replace(/<[^>]+>/g, "").trim().toUpperCase();
    return clean ? `\n[ ${clean} ]\n` : "\n";
  });

  // paragraphs/divs as breaks
  s = s.replace(/<\s*p[^>]*>/gi, "\n");
  s = s.replace(/<\/\s*p\s*>/gi, "\n");
  s = s.replace(/<\s*div[^>]*>/gi, "\n");
  s = s.replace(/<\/\s*div\s*>/gi, "\n");

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

  // collapse whitespace
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// First message includes header; subsequent are body chunks
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

// Identify CS2 patch notes and ensure it's really CS2
function isCs2Link(link) {
  const l = (link || "").toLowerCase();
  return (
    /counter-strike\.net\/news\/updates\//.test(l) ||
    /store\.steampowered\.com\/news\/app\/730\/view\//.test(l)
  );
}
function looksLikePatchNotes(title, link) {
  const t = (title || "").toLowerCase();
  return (
    isCs2Link(link) &&
    (/update|release notes|patch|client update/i.test(title || "") || /updates\//i.test(link || ""))
  );
}

// ---- RSS fetch & select latest CS2 update ----
async function fetchLatestUpdateItem() {
  const r = await fetch(RSS_URL, { headers: { "User-Agent": "cs-suomi-bot/3.4" } });
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
      firstMatch(/<link>([\s\S]*?)<\/link>/i, it) ||
      "";
    const title =
      firstMatch(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i, it) ||
      firstMatch(/<title>([\s\S]*?)<\/title>/i, it) ||
      "";

    if (looksLikePatchNotes(title, link)) {
      best = it;
      bestLink = link.trim();
      bestTitle = title.trim();
      break;
    }
  }

  if (!best) {
    console.log("No CS2 update item matched. Skipping.");
    return null;
  }

  // Body: prefer <content:encoded>, else <description>
  const encoded = firstMatch(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/i, best);
  const desc =
    firstMatch(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i, best) ||
    firstMatch(/<description>([\s\S]*?)<\/description>/i, best);

  const rawHtml = encoded || desc || "";
  const text = htmlToText(rawHtml);

  const sourceLink = bestLink;
  const finnishUpdatesLanding = "https://www.counter-strike.net/news/updates?l=finnish";

  return { title: bestTitle, text, sourceLink, finnishUpdatesLanding };
}

async function processOnce(reason = "poll") {
  try {
    console.log(`[${reason}] Fetching RSS…`);
    const item = await fetchLatestUpdateItem();
    if (!item) {
      console.log("No suitable CS2 update found.");
      return;
    }

    const isNew = item.sourceLink && item.sourceLink !== lastLink;
    if (isNew || FORCE_POST_ON_BOOT) {
      const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**`;
      const body = item.text || "Patch notes available at the links below.";

      const parts = chunksWithHeader(header, body);
      for (const p of parts) {
        await post(p);
        await sleep(600); // pace messages to avoid 429
      }

      // 1) Original source (embed suppressed)
      if (item.sourceLink) {
        await post(item.sourceLink, { suppressEmbeds: true });
        await sleep(400);
      }

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
