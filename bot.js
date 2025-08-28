// CS Suomi — CS2 patch notes bot (Finnish via Steam Store News RSS)
// Filters for counter-strike.net/news/updates/... links only.
// Posts plain text; adds link at the end with preview suppressed.
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

// Steam Store News RSS (Finnish) for app 730 (CS2)
const RSS_URL = "https://store.steampowered.com/feeds/news/?appids=730&l=finnish";

// Keep last posted link (in-memory; may repost once after restart)
let lastLink = null;

// ---- Discord helpers ----
async function post(content, { suppressEmbeds = false } = {}) {
  const payload = suppressEmbeds ? { content, flags: 4 } : { content }; // 4 = SUPPRESS_EMBEDS
  const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
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

// ---- HTML -> text (Finnish formatting as requested) ----
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

// ---- Core: fetch & filter the RSS feed ----
async function fetchLatestUpdateItem() {
  const r = await fetch(RSS_URL, { headers: { "User-Agent": "cs-suomi-bot/3.1" } });
  if (!r.ok) throw new Error("RSS request failed: " + r.status);
  const xml = await r.text();

  // RSS uses <item> blocks; pick the first whose <link> matches counter-strike.net/news/updates/
  const itemBlocks = findAll(/<item>([\s\S]*?)<\/item>/gi, xml);
  console.log(`RSS items found: ${itemBlocks.length}`);

  let chosen = null;
  let chosenLink = null;

  for (const it of itemBlocks) {
    const link = firstMatch(/<link>([\s\S]*?)<\/link>/i, it);
    if (link && /counter-strike\.net\/news\/updates\//i.test(link)) {
      chosen = it;
      chosenLink = link.trim();
      break;
    }
  }

  // Fallback: if none matched (Valve sometimes varies), take the first item but we’ll still post its link
  if (!chosen && itemBlocks.length) {
    chosen = itemBlocks[0];
    chosenLink = firstMatch(/<link>([\s\S]*?)<\/link>/i, chosen)?.trim() || null;
  }

  if (!chosen) return null;

  // Title & content (prefer content:encoded, else description)
  const title =
    firstMatch(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i, chosen) ||
    firstMatch(/<title>([\s\S]*?)<\/title>/i, chosen) ||
    "CS Päivitys";

  const encoded = firstMatch(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/i, chosen);
  const desc =
    firstMatch(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i, chosen) ||
    firstMatch(/<description>([\s\S]*?)<\/description>/i, chosen);

  const html = encoded || desc || "";
  const text = htmlToText(html);

  console.log("Chosen link:", chosenLink);
  console.log("Title:", title);
  console.log("Text length:", text.length);

  // Make sure posted link is the Finnish updates listing if the link isn't an updates page
  let postLink = chosenLink || "https://www.counter-strike.net/news/updates?l=finnish";
  if (/counter-strike\.net\/news\/updates\//i.test(postLink) && !/[?&]l=finnish\b/i.test(postLink)) {
    // ensure Finnish query (not always needed, but safe)
    postLink += (postLink.includes("?") ? "&" : "?") + "l=finnish";
  }

  return { title, text, postLink };
}

async function processOnce(reason = "poll") {
  try {
    console.log(`[${reason}] Fetching RSS…`);
    const item = await fetchLatestUpdateItem();
    if (!item) {
      console.log("No suitable RSS item parsed.");
      return;
    }

    const isNew = item.postLink && item.postLink !== lastLink;
    if (isNew || FORCE_POST_ON_BOOT) {
      // Build & send body
      const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**`;
      const parts = chunksWithHeader(header, item.text);
      for (const p of parts) await post(p);

      // Send the source link at the end, preview suppressed
      await post(item.postLink, { suppressEmbeds: true });

      lastLink = item.postLink || lastLink;
      console.log("Posted update from:", item.postLink);
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

await post(`${CUSTOM_EMOJI}  CS Suomi bot on käynnissä ✅ (lähde: Steam Store News RSS FI, updates only)`);
await processOnce("startup");
setInterval(poll, POLL_MS);
