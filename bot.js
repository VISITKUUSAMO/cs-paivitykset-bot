// CS Suomi — CS2 patch notes bot (English body + Finnish link)
// Robust link detection for Steam RSS + counter-strike.net, with fallback keyword checks.
// HTML entity unescape, Steam bb_* heading handling, and Discord 429 retry/pacing.
// No startup announcement.
//
// Env vars:
//   BOT_TOKEN
//   CHANNEL_ID
//   FORCE_POST_ON_BOOT   -> "true" to force-post on boot (optional)
//   DEBUG                -> "1" to log item-by-item skip reasons
//
// package.json:
// { "type": "module", "scripts": { "start": "node bot.js" }, "dependencies": { "node-fetch": "^3.3.2" } }

import fetch from "node-fetch";

// ---- CONFIG ----
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const FORCE_POST_ON_BOOT = (process.env.FORCE_POST_ON_BOOT || "").toLowerCase() === "true";
const DEBUG = (process.env.DEBUG || "") === "1";

const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";
const POLL_MS = 5 * 60 * 1000; // 5 min

// Steam Store News RSS (CS2)
const RSS_URL = "https://store.steampowered.com/feeds/news/?appids=730&l=finnish";

let lastLink = null;

// ---- helpers ----
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
      let wait = 800;
      try {
        const data = JSON.parse(txt);
        wait = Math.ceil((data.retry_after || 0.5) * 1000);
      } catch {}
      if (DEBUG) console.warn("429 rate limited, waiting", wait, "ms");
      await sleep(wait);
      continue;
    }
    console.error("Post failed:", res.status, txt);
    break;
  }
}

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

// HTML entity decode (&lt; &gt; &amp; &quot; &#39; and numeric)
function htmlDecode(input) {
  if (!input) return "";
  let s = input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  s = s.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return s;
}

// HTML -> text; understands Steam bb_h2 style
function htmlToText(htmlRaw) {
  let html = htmlDecode(htmlRaw || "");

  // map Steam bb_* headings to semantic tags
  html = html.replace(/<\s*div\s+class=["']bb_h2["'][^>]*>([\s\S]*?)<\/\s*div\s*>/gi, "<h2>$1</h2>");

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
  s = s.replace(/<\s*div[^>]*>/gi, "\n");
  s = s.replace(/<\/\s*div\s*>/gi, "\n");

  s = s.replace(/<\s*strong[^>]*>([\s\S]*?)<\/\s*strong\s*>/gi, "**$1**");
  s = s.replace(/<\s*b[^>]*>([\s\S]*?)<\/\s*b\s*>/gi, "**$1**");
  s = s.replace(/<\s*i[^>]*>([\s\S]*?)<\/\s*i\s*>/gi, "*$1*");
  s = s.replace(/<\s*em[^>]*>([\s\S]*?)<\/\s*em\s*>/gi, "*$1*");

  s = s.replace(/<\s*a [^>]*>([\s\S]*?)<\/\s*a\s*>/gi, "$1");

  s = s.replace(/<\s*img[^>]*>/gi, "");
  s = s.replace(/<\s*script[\s\S]*?<\/\s*script\s*>/gi, "");
  s = s.replace(/<\s*style[\s\S]*?<\/\s*style\s*>/gi, "");
  s = s.replace(/<[^>]+>/g, "");

  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// chunking with header
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

// ---- Detection logic ----

// Known-good link shapes for CS2 updates:
function linkLooksCs2(link) {
  const l = (link || "").toLowerCase();
  return (
    /counter-strike\.net\/news\/updates\//.test(l) ||
    /store\.steampowered\.com\/news\/app\/730\/view\//.test(l) ||
    // new News Hub permalink sometimes looks like /news/post/XXXXXXXX
    // we can't confirm app from path, so we'll pair this with strong title keywords:
    /store\.steampowered\.com\/news\/post\//.test(l)
  );
}

// Strong keywords indicating an update post:
function hasUpdateKeywords(title, description = "") {
  const t = (title || "").toLowerCase();
  const d = (description || "").toLowerCase();
  const re = /(release\s*notes|patch|update|client\s*update|game\s*update)/i;
  return re.test(t) || re.test(d);
}

// Conservative acceptance:
// 1) If link explicitly looks like CS2 (app/730 or counter-strike.net) AND title/desc has update keywords -> accept.
// 2) If link is the generic /news/post/... AND title/desc has update keywords AND mentions "counter-strike" or "cs2" -> accept.
// Otherwise skip (prevents RimWorld, etc.).
function isLikelyCs2Patch({ link, title, description }) {
  const lcs2 = linkLooksCs2(link);
  const kw = hasUpdateKeywords(title, description);
  const mentionsCs = /counter[-\s]?strike|cs2\b/i.test((title || "") + " " + (description || ""));

  if (/store\.steampowered\.com\/news\/app\/730\/view\//i.test(link) || /counter-strike\.net\/news\/updates\//i.test(link)) {
    return kw; // explicit CS2 link; require update keywords
  }
  if (/store\.steampowered\.com\/news\/post\//i.test(link)) {
    return kw && mentionsCs; // generic post; ensure it actually says CS/CS2
  }
  return false;
}

// ---- RSS fetch & select ----
async function fetchLatestUpdateItem() {
  const r = await fetch(RSS_URL, { headers: { "User-Agent": "cs-suomi-bot/3.5" } });
  if (!r.ok) throw new Error("RSS request failed: " + r.status);
  const xml = await r.text();

  const itemBlocks = findAll(/<item>([\s\S]*?)<\/item>/gi, xml);
  console.log(`RSS items found: ${itemBlocks.length}`);

  let selected = null;
  let selLink = null;
  let selTitle = null;

  for (const it of itemBlocks) {
    const link =
      firstMatch(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/i, it) ||
      firstMatch(/<link>([\s\S]*?)<\/link>/i, it) ||
      "";
    const title =
      firstMatch(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i, it) ||
      firstMatch(/<title>([\s\S]*?)<\/title>/i, it) ||
      "";
    const desc =
      firstMatch(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i, it) ||
      firstMatch(/<description>([\s\S]*?)<\/description>/i, it) ||
      "";

    const ok = isLikelyCs2Patch({ link, title, description: desc });
    if (DEBUG) {
      console.log("•", title.trim());
      console.log("  ", link);
      if (!ok) console.log("   -> skipped");
    }
    if (ok) {
      selected = it;
      selLink = link.trim();
      selTitle = title.trim();
      break;
    }
  }

  if (!selected) return null;

  const encoded = firstMatch(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/i, selected);
  const desc =
    firstMatch(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i, selected) ||
    firstMatch(/<description>([\s\S]*?)<\/description>/i, selected);

  const rawHtml = encoded || desc || "";
  const text = htmlToText(rawHtml);

  const sourceLink = selLink;
  const finnishUpdatesLanding = "https://www.counter-strike.net/news/updates?l=finnish";

  return { title: selTitle, text, sourceLink, finnishUpdatesLanding };
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
        await sleep(600); // gentle pacing
      }

      if (item.sourceLink) {
        await post(item.sourceLink, { suppressEmbeds: true });
        await sleep(400);
      }
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

await processOnce("startup");
setInterval(poll, POLL_MS);
