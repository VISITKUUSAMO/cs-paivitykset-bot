// CS Suomi — CS2 patch notes bot (Finnish from counter-strike.net)
// Posts plain text; splits for 2000-char limit; robust link extraction + logging.
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

const LIST_URL = "https://www.counter-strike.net/news/updates?l=finnish";
const BASE = "https://www.counter-strike.net";

// keep last posted URL (in-memory)
let lastUrl = null;

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

// Convert HTML from the update page to readable Discord text
function htmlToText(html) {
  let s = html.replace(/\r/g, "");

  // Breaks
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");

  // LI -> bullets
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

// First message includes header, then chunk body across multiple messages if needed
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

// Fetch listing page and extract latest update URL (robust)
async function fetchLatestUpdateUrl() {
  const r = await fetch(LIST_URL, { headers: { "User-Agent": "cs-suomi-bot/1.1" } });
  if (!r.ok) throw new Error("List request failed: " + r.status);
  const html = await r.text();

  // Grab all hrefs that look like /news/updates/<slug> (with ' or " quotes)
  const links = [];
  const re = /href\s*=\s*['"]([^'"]*\/news\/updates\/[^'"]+)['"]/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];

    // Ensure finnish param
    if (!/[?&]l=finnish\b/i.test(href)) {
      href += (href.includes("?") ? "&" : "?") + "l=finnish";
    }
    // Build absolute URL if needed
    const url = href.startsWith("http") ? href : BASE + href;

    links.push(url);
  }

  console.log("Found update links:", links.slice(0, 5)); // log a few candidates

  // Return the first candidate (the page usually lists newest first)
  return links.length ? links[0] : null;
}

// Fetch the update page and extract main patch notes content
async function fetchUpdateBodyText(updateUrl) {
  const r = await fetch(updateUrl, { headers: { "User-Agent": "cs-suomi-bot/1.1" } });
  if (!r.ok) throw new Error("Update request failed: " + r.status);
  const html = await r.text();

  // Prefer a known patch container; fall back to body content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;

  const candidates = [
    /<div[^>]+class="[^"]*patchnotes[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+id="patchnotes"[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i
  ];

  let content = "";
  for (const re of candidates) {
    const mm = bodyHtml.match(re);
    if (mm && mm[1]) { content = mm[1]; break; }
  }
  if (!content) content = bodyHtml;

  const text = htmlToText(content);
  console.log(`Fetched update text length: ${text.length}`);
  return text;
}

// ---- Poll loop ----
async function processOnce(reason = "poll") {
  try {
    console.log(`[${reason}] Fetching latest URL…`);
    const url = await fetchLatestUpdateUrl();
    console.log("Latest URL:", url);

    if (!url) return;

    const isNew = (url !== lastUrl);
    if (isNew || FORCE_POST_ON_BOOT) {
      console.log(`New or forced post. lastUrl=${lastUrl} next=${url}`);
      const text = await fetchUpdateBodyText(url);
      if (!text || text.trim().length < 10) {
        console.warn("Update text seems empty/short; skipping post.");
        lastUrl = url; // avoid spinning on a bad page
        return;
      }

      const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**`;
      const out = chunksWithHeader(header, text);
      for (const msg of out) await post(msg);

      lastUrl = url;
      console.log("Posted update from:", url);
    } else {
      console.log("No new update.");
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

await post(`${CUSTOM_EMOJI}  CS Suomi bot on käynnissä ✅ (FI source: counter-strike.net)`);
await processOnce("startup");
setInterval(poll, POLL_MS);
