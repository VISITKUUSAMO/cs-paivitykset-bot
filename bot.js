// CS Suomi — CS2 patch notes bot (Finnish first, EN fallback)
// Posts as plain text (so #channels/emojis/@roles work).
//
// Env vars (Render):
//   BOT_TOKEN  -> Discord bot token
//   CHANNEL_ID -> target channel ID
//
// package.json must have:
// {
//   "type": "module",
//   "scripts": { "start": "node bot.js" },
//   "dependencies": { "node-fetch": "^3.3.2" }
// }

import fetch from "node-fetch";

// ---- CONFIG ----
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// Your custom emoji tag (full form with ID)
const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";

// Poll every 5 minutes
const POLL_MS = 5 * 60 * 1000;

// Steam CS2 news feed (app 730)
const FEED_BASE =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=1&maxlength=0";

// Keep last posted gid (in-memory; may repost once after restart)
let lastGid = null;

// ---- HELPERS ----

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

// Convert Steam BBCode-like markup to Discord-friendly text.
// NOTE: This does NOT invent headings or bullets; it only transforms existing tags.
// - Preserves any bracketed headings already in text (e.g., [SEKALAISTA])
// - Converts [list][*] items to "• " bullets IF they exist
// - Strips [img], [url=], and generic bbcode formatting
function transformSteamToDiscord(raw) {
  let s = (raw || "").replace(/\r/g, "");

  // Remove images entirely
  s = s.replace(/\[img\][\s\S]*?\[\/img\]/gi, "");

  // [url=...]text[/url] -> text
  s = s.replace(/\[url=.*?\]([\s\S]*?)\[\/url\]/gi, "$1");

  // Optional: basic bbcode bold/italic/underline -> Discord markdown
  s = s.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, "**$1**");
  s = s.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, "*$1*");
  s = s.replace(/\[u\]([\s\S]*?)\[\/u\]/gi, "__$1__");

  // Convert list items if present: [list] [*]item ... [/list]
  // Replace [*] with bullet prefix; leave text intact if no [*] exists
  s = s.replace(/\[\*\]\s*/gi, "• ");
  // Remove [list] wrappers but keep inner text
  s = s.replace(/\[\/?list\]/gi, "");

  // Remove other harmless/unknown paired tags while keeping inner text
  s = s.replace(/\[([a-z0-9]+)(?:=[^\]]+)?\]([\s\S]*?)\[\/\1\]/gi, "$2");

  // Collapse excessive blank lines
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// Split long text to Discord-safe chunks (2000 char limit). First message includes header.
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

async function fetchNews(lang = "finnish") {
  const r = await fetch(`${FEED_BASE}&l=${lang}`);
  if (!r.ok) throw new Error(`Feed request failed (${lang}): ${r.status}`);
  const j = await r.json();
  return j?.appnews?.newsitems?.[0] || null;
}

// ---- MAIN LOOP ----

async function poll() {
  try {
    // Try Finnish first
    let usedLang = "finnish";
    let item = await fetchNews("finnish");

    // If nothing or clearly empty, fall back to English
    if (!item || !item.contents || item.contents.trim().length < 20) {
      item = await fetchNews("english");
      usedLang = "english";
    }
    if (!item) return;

    if (item.gid !== lastGid) {
      lastGid = item.gid;

      // Header (always the same Finnish headline; add [EN] tag if fallback)
      const langTag = usedLang === "finnish" ? "" : " [EN]";
      const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**${langTag}`;

      // Body is exactly what Valve posts, cleaned/converted — no fabricated sections
      const body = transformSteamToDiscord(item.contents || "");

      const out = chunksWithHeader(header, body);
      for (const msg of out) await post(msg);

      console.log(`Posted update (${usedLang}):`, item.title || item.gid);
    }
  } catch (e) {
    console.error("Poll error:", e);
  }
}

// ---- STARTUP ----

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing BOT_TOKEN or CHANNEL_ID env vars");
  process.exit(1);
}

// Simple boot message so you know it's alive
await post(`${CUSTOM_EMOJI}  CS Suomi bot on käynnissä ✅`);

// Run once, then poll periodically
await poll();
setInterval(poll, POLL_MS);
