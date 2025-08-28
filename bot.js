// CS Suomi — CS2 patch notes bot
// English only, plain text output with Discord markdown.
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

// ---- CONFIG ----
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";
const POLL_MS = 5 * 60 * 1000; // every 5 min

// Steam CS2 news feed (app 730)
const FEED_URL =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=1&maxlength=0&l=english";

let lastGid = null;

// ---- Discord post helper ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(content) {
  if (!content) return;
  while (true) {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
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

// ---- Text cleanup ----
function transformSteamToDiscord(raw) {
  let s = (raw || "").replace(/\r/g, "");

  // Remove [img] tags
  s = s.replace(/\[img\][\s\S]*?\[\/img\]/gi, "");

  // [url=...]text[/url] → text
  s = s.replace(/\[url=.*?\]([\s\S]*?)\[\/url\]/gi, "$1");

  // Bold/italic/underline
  s = s.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, "**$1**");
  s = s.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, "*$1*");
  s = s.replace(/\[u\]([\s\S]*?)\[\/u\]/gi, "__$1__");

  // Lists
  s = s.replace(/\[\*\]\s*/gi, "• ");
  s = s.replace(/\[\/?list\]/gi, "");

  // Strip other BBCode but keep inner text
  s = s.replace(/\[([a-z0-9]+)(?:=[^\]]+)?\]([\s\S]*?)\[\/\1\]/gi, "$2");

  // Collapse blank lines
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// Split into safe chunks
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

// ---- Fetch latest news item ----
async function fetchLatestNews() {
  const r = await fetch(FEED_URL, { headers: { "User-Agent": "cs-suomi-bot/1.0" } });
  if (!r.ok) throw new Error(`Feed request failed: ${r.status}`);
  const j = await r.json();
  return j?.appnews?.newsitems?.[0] || null;
}

// ---- Poll ----
async function poll() {
  try {
    const item = await fetchLatestNews();
    if (!item) {
      console.log("No news item.");
      return;
    }
    if (item.gid === lastGid) {
      console.log("No new update (same gid).");
      return;
    }

    lastGid = item.gid;

    const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**`;
    const body = transformSteamToDiscord(item.contents || "");
    const out = chunksWithHeader(header, body);

    for (const msg of out) {
      await post(msg);
      await sleep(600); // gentle pacing
    }

    // Always drop the source link (embed suppressed)
    if (item.url) {
      await post(`<${item.url}>`); // angled brackets suppress embed
    }

    console.log("Posted update:", item.title || item.gid);
  } catch (e) {
    console.error("Poll error:", e);
  }
}

// ---- Startup ----
if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing BOT_TOKEN or CHANNEL_ID");
  process.exit(1);
}

await poll();
setInterval(poll, POLL_MS);
