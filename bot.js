// CS Suomi — CS2 patch notes bot
// English-only CS2 patch notes from Steam News API (appid 730).
// De-duplicates using a stable announcement ID parsed from the URL,
// and checks only the last 3 messages from THIS BOT in the channel.
//
// Env vars:
//   BOT_TOKEN  -> Discord bot token
//   CHANNEL_ID -> target channel ID
//
// package.json:
// {
//   "type": "module",
//   "scripts": { "start": "node bot.js" },
//   "dependencies": { "node-fetch": "^3.3.2" }
// }

import fetch from "node-fetch";
import fs from "fs";

// ---- CONFIG ----
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";
const POLL_MS = 5 * 60 * 1000; // 5 minutes

const FEED_URL =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=1&maxlength=0&l=english";

// Persist last posted key (announcement ID or normalized URL)
const STATE_FILE = "last_key.txt";

// ---- STATE ----
let lastKey = null;
let botUserId = null;

if (fs.existsSync(STATE_FILE)) {
  try {
    lastKey = fs.readFileSync(STATE_FILE, "utf8").trim() || null;
    console.log("Loaded lastKey:", lastKey);
  } catch (e) {
    console.warn("Could not read state:", e);
  }
}

// ---- HELPERS ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(content) {
  if (!content) return;
  while (true) {
    const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const wait = Math.ceil((data.retry_after || 0.5) * 1000);
      console.warn("429 rate limit; waiting", wait, "ms");
      await sleep(wait);
      continue;
    }
    const txt = await res.text().catch(() => "");
    console.error("Post failed:", res.status, txt);
    break;
  }
}

// Bot identity (to filter messages by author)
async function ensureBotUserId() {
  if (botUserId) return botUserId;
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${TOKEN}` },
  });
  if (!res.ok) throw new Error("Failed to fetch bot user: " + res.status);
  const me = await res.json();
  botUserId = me.id;
  return botUserId;
}

// Get last N messages authored by THIS bot (scan up to ~50 recent)
async function fetchLastBotMessages(n = 3) {
  await ensureBotUserId();
  const res = await fetch(
    `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=50`,
    { headers: { Authorization: `Bot ${TOKEN}` } }
  );
  if (!res.ok) return [];
  const msgs = await res.json().catch(() => []);
  return msgs.filter((m) => m?.author?.id === botUserId).slice(0, n);
}

// Extract stable announcement ID from Steam URL
function extractAnnouncementId(url) {
  if (!url) return null;
  const m = String(url).match(/(\d{9,})$/); // long numeric id at end
  return m ? m[1] : null;
}

// Fallback normalization if ID cannot be extracted (rare)
function normalizeUrl(url) {
  if (!url) return null;
  let u = url.trim().toLowerCase();
  u = u.replace(/^http:\/\//, "https://");
  u = u.replace("steamstore-a.akamaihd.net", "store.steampowered.com");
  u = u.split("?")[0].replace(/\/$/, "");
  return u;
}

// BBCode -> Discord markdown
function transformSteamToDiscord(raw) {
  let s = (raw || "").replace(/\r/g, "");

  // Remove images
  s = s.replace(/\[img\][\s\S]*?\[\/img\]/gi, "");

  // [url=...]text[/url] -> text
  s = s.replace(/\[url=[^\]]+\]([\s\S]*?)\[\/url\]/gi, "$1");

  // Basic formatting
  s = s.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, "**$1**");
  s = s.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, "*$1*");
  s = s.replace(/\[u\]([\s\S]*?)\[\/u\]/gi, "__$1__");

  // Kill odd BBCode closers some Steam posts include
  s = s.replace(/\[\/\]|\[\/\*\]/g, "");

  // Remove [list] wrappers
  s = s.replace(/\[\/?list(?:=[^\]]+)?\]/gi, "");

  // Ensure each bullet item starts on a new line
  // (any amount of whitespace before [*] becomes a single newline)
  s = s.replace(/\s*\[\*\]\s*/gi, "\n• ");

  // Tidy whitespace
  s = s.replace(/^\n+/, "");     // leading newlines
  s = s.replace(/\n{3,}/g, "\n\n"); // collapse 3+ to 2

  return s.trim();
}

// Discord chunking
function chunksWithHeader(headerLine, body) {
  const LIMIT = 2000;
  const header = `${headerLine}\n\n`;
  const out = [];
  if ((header + body).length <= LIMIT) out.push(header + body);
  else {
    const firstRoom = LIMIT - header.length;
    out.push(header + body.slice(0, firstRoom));
    for (let i = firstRoom; i < body.length; i += 1800) out.push(body.slice(i, i + 1800));
  }
  return out;
}

// Fetch latest news item from Steam
async function fetchLatestNews() {
  const r = await fetch(FEED_URL, { headers: { "User-Agent": "cs-suomi-bot/1.6" } });
  if (!r.ok) throw new Error(`Feed request failed: ${r.status}`);
  const j = await r.json();
  return j?.appnews?.newsitems?.[0] || null;
}

// ---- MAIN POLL ----
async function poll() {
  try {
    const item = await fetchLatestNews();
    if (!item || !item.url) {
      console.log("No news item or URL.");
      return;
    }

    const key = extractAnnouncementId(item.url) || normalizeUrl(item.url);
    if (!key) {
      console.log("Could not form dedupe key; skipping.");
      return;
    }

    // Check last 3 messages authored by this bot
    const recentBotMsgs = await fetchLastBotMessages(3);
    const alreadyPostedInChannel = recentBotMsgs.some((m) => (m?.content || "").includes(key));
    if (alreadyPostedInChannel) {
      // Persist state anyway so restarts also skip
      try { fs.writeFileSync(STATE_FILE, key, "utf8"); } catch {}
      console.log("Duplicate detected in last 3 bot messages; skipping.");
      return;
    }

    // Check state file too
    if (key === lastKey) {
      console.log("No new update (same key).");
      return;
    }

    // Mark as posted BEFORE sending
    lastKey = key;
    try { fs.writeFileSync(STATE_FILE, lastKey, "utf8"); } catch (e) { console.warn("State write failed:", e); }

    const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**`;
    const body = transformSteamToDiscord(item.contents || "");
    const parts = chunksWithHeader(header, body);

    for (const p of parts) { await post(p); await sleep(600); }
    await post(`<${item.url}>`); // suppress embed with <...>

    console.log("Posted update:", item.title || item.url);
  } catch (e) {
    console.error("Poll error:", e);
  }
}

// ---- STARTUP ----
if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing BOT_TOKEN or CHANNEL_ID");
  process.exit(1);
}

// One immediate poll
await poll();

// Start repeating interval only after first delay (prevents double at boot)
setTimeout(() => setInterval(poll, POLL_MS), POLL_MS);
