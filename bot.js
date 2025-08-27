// CS Suomi — CS2 patch notes bot (Finnish from counter-strike.net)
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
const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>"; // your emoji
const POLL_MS = 5 * 60 * 1000;

const LIST_URL = "https://www.counter-strike.net/news/updates?l=finnish";
const BASE = "https://www.counter-strike.net";

// Keep last posted URL (in-memory; may repost once after restart)
let lastUrl = null;

// ---- BASIC POST ----
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

// ---- HELPERS ----

// Very light HTML → text converter tailored for CS update pages
function htmlToText(html) {
  let s = html;

  // Normalize line endings
  s = s.replace(/\r/g, "");

  // Convert <br> and <li> to line breaks
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "• ");
  s = s.replace(/<\/\s*li\s*>/gi, "\n");

  // Headings: <h1>, <h2>, <h3> -> bracketed uppercase section titles
  s = s.replace(/<\s*h[1-3][^>]*>([\s\S]*?)<\/\s*h[1-3]\s*>/gi, (_, t) => {
    const clean = t.replace(/<[^>]+>/g, "").trim().toUpperCase();
    return clean ? `\n[${clean}]\n` : "\n";
  });

  // Paragraphs -> ensure newline separation
  s = s.replace(/<\s*p[^>]*>/gi, "\n");
  s = s.replace(/<\/\s*p\s*>/gi, "\n");

  // Bold/italic basic conversions
  s = s.replace(/<\s*strong[^>]*>([\s\S]*?)<\/\s*strong\s*>/gi, "**$1**");
  s = s.replace(/<\s*b[^>]*>([\s\S]*?)<\/\s*b\s*>/gi, "**$1**");
  s = s.replace(/<\s*i[^>]*>([\s\S]*?)<\/\s*i\s*>/gi, "*$1*");
  s = s.replace(/<\s*em[^>]*>([\s\S]*?)<\/\s*em\s*>/gi, "*$1*");

  // Links: keep link text only
  s = s.replace(/<\s*a [^>]*>([\s\S]*?)<\/\s*a\s*>/gi, "$1");

  // Strip images/scripts/styles completely
  s = s.replace(/<\s*img[^>]*>/gi, "");
  s = s.replace(/<\s*script[\s\S]*?<\/\s*script\s*>/gi, "");
  s = s.replace(/<\s*style[\s\S]*?<\/\s*style\s*>/gi, "");

  // Remove all other HTML tags
  s = s.replace(/<[^>]+>/g, "");

  // Collapse 3+ newlines to 2
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// Split long text into Discord-safe chunks with header as first line
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

// Fetch the latest update page URL from the updates listing
async function fetchLatestUpdateUrl() {
  const r = await fetch(LIST_URL, { headers: { "User-Agent": "cs-suomi-bot/1.0" } });
  if (!r.ok) throw new Error("List request failed: " + r.status);
  const html = await r.text();

  // Find the first link to a specific update page
  // Typical hrefs look like /news/updates/<slug>?l=finnish or /news/updates/<slug>
  const m = html.match(/href="(\/news\/updates\/[^"]+)"/i);
  if (!m) return null;

  // Ensure we keep Finnish param
  const href = m[1].includes("?") ? m[1] : `${m[1]}?l=finnish`;
  return BASE + href;
}

// Fetch the update page and extract the main content
async function fetchUpdateBodyText(updateUrl) {
  const r = await fetch(updateUrl, { headers: { "User-Agent": "cs-suomi-bot/1.0" } });
  if (!r.ok) throw new Error("Update request failed: " + r.status);
  const html = await r.text();

  // Try to locate the primary content container
  // We fall back to whole body if we can't isolate easily.
  let content = "";

  // Heuristic: grab inside <body> first
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;

  // If page has a known wrapper (Valve changes this sometimes), try a few common sections:
  // 1) class="patchnotes" …  2) id="patchnotes" … 3) generic article divs
  const candidates = [
    /<div[^>]+class="[^"]*patchnotes[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+id="patchnotes"[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i
  ];

  for (const re of candidates) {
    const mm = bodyHtml.match(re);
    if (mm && mm[1]) {
      content = mm[1];
      break;
    }
  }

  if (!content) {
    // Fallback: use the whole body HTML
    content = bodyHtml;
  }

  return htmlToText(content);
}

// ---- POLL LOOP ----
async function poll() {
  try {
    const url = await fetchLatestUpdateUrl();
    if (!url) return;

    if (url !== lastUrl) {
      // New update detected
      const text = await fetchUpdateBodyText(url);

      // Build and send messages
      const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**`;
      const out = chunksWithHeader(header, text);
      for (const msg of out) await post(msg);

      lastUrl = url;
      console.log("Posted update from:", url);
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
await post(`${CUSTOM_EMOJI}  CS Suomi bot on käynnissä ✅ (lähde: counter-strike.net/updates FI)`);

// Run once, then poll periodically
await poll();
setInterval(poll, POLL_MS);
