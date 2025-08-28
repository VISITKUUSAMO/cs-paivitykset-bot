// CS Suomi — CS2 patch notes bot
// Source: official Counter-Strike.net Atom feed
// Posts English text body + source link + Finnish landing link
// Handles Discord rate limits, no startup announcement

import fetch from "node-fetch";

// ---- CONFIG ----
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const FORCE_POST_ON_BOOT =
  (process.env.FORCE_POST_ON_BOOT || "").toLowerCase() === "true";

const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";
const POLL_MS = 5 * 60 * 1000; // poll every 5 minutes

// Atom feed for CS2 news
const ATOM_URL = "https://www.counter-strike.net/news/atom";

// In-memory last posted link
let lastLink = null;

// ---- Discord post helpers ----
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

// ---- XML helpers ----
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

// Decode HTML entities
function htmlDecode(s = "") {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Convert Atom <content> HTML to Discord-friendly text
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

  s = s.replace(/<\s*strong[^>]*>([\s\S]*?)<\/\s*strong\s*>/gi, "**$1**");
  s = s.replace(/<\s*b[^>]*>([\s\S]*?)<\/\s*b\s*>/gi, "**$1**");
  s = s.replace(/<\s*i[^>]*>([\s\S]*?)<\/\s*i\s*>/gi, "*$1*");

  s = s.replace(/<\s*a [^>]*>([\s\S]*?)<\/\s*a\s*>/gi, "$1");

  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// Split into Discord-safe chunks
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

// ---- Fetch Atom feed & pick latest update ----
async function fetchLatestUpdate() {
  const r = await fetch(ATOM_URL, { headers: { "User-Agent": "cs-suomi-bot/1.0" } });
  if (!r.ok) throw new Error("Atom request failed: " + r.status);
  const xml = await r.text();

  const entries = findAll(/<entry>([\s\S]*?)<\/entry>/gi, xml);
  if (!entries.length) return null;

  for (const e of entries) {
    const link = firstMatch(/<link[^>]+href="([^"]+)"/i, e) || "";
    if (!/\/updates\//i.test(link)) continue; // only updates posts

    const title = firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, e)?.trim() || "CS2 Update";
    const content = firstMatch(/<content[^>]*>([\s\S]*?)<\/content>/i, e) || "";
    const text = htmlToText(content);

    return {
      title,
      text,
      sourceLink: link,
      finnishLanding: "https://www.counter-strike.net/news/updates?l=finnish",
    };
  }

  return null;
}

// ---- Main processing ----
async function processOnce(reason = "poll") {
  console.log(`[${reason}] Fetching Atom…`);
  try {
    const item = await fetchLatestUpdate();
    if (!item) {
      console.log("No CS2 update found.");
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
setInterval(() => processOnce("poll"), POLL_MS);
