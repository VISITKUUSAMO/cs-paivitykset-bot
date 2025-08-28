// CS Suomi — CS2 patch notes bot (Finnish via official blog RSS)
// Posts plain text; splits for 2000-char; robust logging.
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
const FORCE_POST_ON_BOOT = (process.env.FORCE_POST_ON_BOOT || "").toLowerCase() === "true";

const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";
const POLL_MS = 5 * 60 * 1000;

// Official Counter-Strike blog RSS (Finnish)
const RSS_URL = "https://blog.counter-strike.net/index.php/feed/?l=finnish";

// keep last posted link (in-memory)
let lastLink = null;

// ---- Discord post ----
async function post(content) {
  const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("Post failed:", res.status, txt);
  }
}

// ---- Helpers ----

// Super-light XML extractors (good enough for RSS)
function firstMatch(re, text) {
  const m = re.exec(text);
  return m ? m[1] : null;
}

function findAll(re, text) {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// Clean HTML from RSS content into Discord-friendly text
function htmlToText(html) {
  let s = (html || "").replace(/\r/g, "");

  // Line breaks and list items
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "• ");
  s = s.replace(/<\/\s*li\s*>/gi, "\n");

  // Headings -> [UPPERCASE]
  s = s.replace(/<\s*h[1-3][^>]*>([\s\S]*?)<\/\s*h[1-3]\s*>/gi, (_, t) => {
    const clean = (t || "").replace(/<[^>]+>/g, "").trim().toUpperCase();
    return clean ? `\n[ ${clean} ]\n` : "\n";
  });

  // Paragraphs
  s = s.replace(/<\s*p[^>]*>/gi, "\n");
  s = s.replace(/<\/\s*p\s*>/gi, "\n");

  // Bold/italic
  s = s.replace(/<\s*strong[^>]*>([\s\S]*?)<\/\s*strong\s*>/gi, "**$1**");
  s = s.replace(/<\s*b[^>]*>([\s\S]*?)<\/\s*b\s*>/gi, "**$1**");
  s = s.replace(/<\s*i[^>]*>([\s\S]*?)<\/\s*i\s*>/gi, "*$1*");
  s = s.replace(/<\s*em[^>]*>([\s\S]*?)<\/\s*em\s*>/gi, "*$1*");

  // Links: keep text only
  s = s.replace(/<\s*a [^>]*>([\s\S]*?)<\/\s*a\s*>/gi, "$1");

  // Strip images/scripts/styles
  s = s.replace(/<\s*img[^>]*>/gi, "");
  s = s.replace(/<\s*script[\s\S]*?<\/\s*script\s*>/gi, "");
  s = s.replace(/<\s*style[\s\S]*?<\/\s*style\s*>/gi, "");

  // Remove other tags
  s = s.replace(/<[^>]+>/g, "");

  // Collapse triple+ newlines
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// First message includes header, then chunk body if needed
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

// Fetch and parse the RSS feed, return the latest "updates" item
async function fetchLatestRssItem() {
  const r = await fetch(RSS_URL, { headers: { "User-Agent": "cs-suomi-bot/2.0" } });
  if (!r.ok) throw new Error("RSS request failed: " + r.status);
  const xml = await r.text();

  // Split items
  const itemBlocks = findAll(/<item>([\s\S]*?)<\/item>/gi, xml);
  console.log(`RSS items found: ${itemBlocks.length}`);

  // Choose the first item whose link looks like an update (safer),
  // otherwise just take the very first item.
  let chosen = null;
  for (const it of itemBlocks) {
    const link = firstMatch(/<link>([\s\S]*?)<\/link>/i, it) || "";
    if (/\/updates\//i.test(link) || /updates/i.test(it)) {
      chosen = it;
      break;
    }
  }
  if (!chosen && itemBlocks.length) chosen = itemBlocks[0];
  if (!chosen) return null;

  const link = firstMatch(/<link>([\s\S]*?)<\/link>/i, chosen)?.trim() || null;
  const title = firstMatch(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i, chosen) || "CS Päivitys";

  // Prefer <content:encoded>, else <description>
  const encoded = firstMatch(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/i, chosen);
  const desc = firstMatch(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description>([\s\S]*?)<\/description>/i, chosen);
  const html = encoded || desc || "";

  const text = htmlToText(html);
  console.log("Chosen title:", (Array.isArray(title) ? title.find(Boolean) : title), " | link:", link, " | textLen:", text.length);

  return { link, title: Array.isArray(title) ? title.find(Boolean) : title, text };
}

async function processOnce(reason = "poll") {
  try {
    console.log(`[${reason}] Fetching RSS…`);
    const item = await fetchLatestRssItem();
    if (!item) {
      console.log("No RSS item parsed.");
      return;
    }

    const isNew = (item.link && item.link !== lastLink);
    if (isNew || FORCE_POST_ON_BOOT) {
      const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**`;
      const out = chunksWithHeader(header, item.text);
      for (const msg of out) await post(msg);

      lastLink = item.link || lastLink; // avoid reposts
      console.log("Posted update from RSS link:", item.link || "(no link)");
    } else {
      console.log("No new update (same link).");
    }
  } catch (e) {
    console.error("Process error:", e);
  }
}

async function poll() { await processOnce("poll"); }

// ---- Startup ----
if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing BOT_TOKEN or CHANNEL_ID");
  process.exit(1);
}

await post(`${CUSTOM_EMOJI}  CS Suomi bot on käynnissä ✅ (lähde: blog.counter-strike.net FI RSS)`);

// Force one post on boot if requested
await processOnce("startup");
setInterval(poll, POLL_MS);
