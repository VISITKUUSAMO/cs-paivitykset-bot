// CS Suomi — CS2 patch notes bot (Finnish from counter-strike.net)
// - Source: https://www.counter-strike.net/news/updates?l=finnish
// - Finds newest /news/updates/... link, fetches page, converts HTML -> Discord text
// - Posts header + body, then the updates page link at the end with embeds SUPPRESSED
//
// Env vars (Render):
//   BOT_TOKEN              -> Discord bot token
//   CHANNEL_ID             -> target channel ID
//   FORCE_POST_ON_BOOT     -> "true" to force-post the latest once after deploy (optional)
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

const LIST_URL_FI = "https://www.counter-strike.net/news/updates?l=finnish";
const BASE = "https://www.counter-strike.net";

// keep last posted update URL (in-memory)
let lastUrl = null;

// ---- Discord helpers ----
async function post(content, { suppressEmbeds = false } = {}) {
  const payload = suppressEmbeds ? { content, flags: 4 } : { content }; // flags:4 = SUPPRESS_EMBEDS
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

// ---- HTML -> text ----
function htmlToText(html) {
  let s = (html || "").replace(/\r/g, "");

  // <br> -> newline
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");

  // <li> items -> asterisk bullets (your preference)
  s = s.replace(/<\s*li[^>]*>/gi, "* ");
  s = s.replace(/<\/\s*li\s*>/gi, "\n");

  // Headings -> [ UPPERCASE ] (keep bracketed look)
  s = s.replace(/<\s*h[1-3][^>]*>([\s\S]*?)<\/\s*h[1-3]\s*>/gi, (_, t) => {
    const clean = (t || "").replace(/<[^>]+>/g, "").trim().toUpperCase();
    return clean ? `\n[ ${clean} ]\n` : "\n";
  });

  // Paragraphs -> separate with newlines
  s = s.replace(/<\s*p[^>]*>/gi, "\n");
  s = s.replace(/<\/\s*p\s*>/gi, "\n");

  // Basic text formatting
  s = s.replace(/<\s*strong[^>]*>([\s\S]*?)<\/\s*strong\s*>/gi, "**$1**");
  s = s.replace(/<\s*b[^>]*>([\s\S]*?)<\/\s*b\s*>/gi, "**$1**");
  s = s.replace(/<\s*i[^>]*>([\s\S]*?)<\/\s*i\s*>/gi, "*$1*");
  s = s.replace(/<\s*em[^>]*>([\s\S]*?)<\/\s*em\s*>/gi, "*$1*");

  // Links: keep text only
  s = s.replace(/<\s*a [^>]*>([\s\S]*?)<\/\s*a\s*>/gi, "$1");

  // Strip images/scripts/styles/other tags
  s = s.replace(/<\s*img[^>]*>/gi, "");
  s = s.replace(/<\s*script[\s\S]*?<\/\s*script\s*>/gi, "");
  s = s.replace(/<\s*style[\s\S]*?<\/\s*style\s*>/gi, "");
  s = s.replace(/<[^>]+>/g, "");

  // Collapse multiple blank lines
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// Split for Discord limit; first chunk gets header
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

// ---- Fetch helpers ----
async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "cs-suomi-bot/3.0" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return await r.text();
}

// Extract newest /news/updates/... URL from the Finnish updates listing
function extractLatestUpdateUrl(listHtml) {
  const links = [];
  const re = /href\s*=\s*['"]([^'"]*\/news\/updates\/[^'"]+)['"]/gi;
  let m;
  while ((m = re.exec(listHtml)) !== null) {
    let href = m[1];
    // guarantee Finnish param
    if (!/[?&]l=finnish\b/i.test(href)) {
      href += (href.includes("?") ? "&" : "?") + "l=finnish";
    }
    const full = href.startsWith("http") ? href : BASE + href;
    links.push(full);
  }
  // Page usually lists newest first; take the first valid link
  return links.length ? links[0] : null;
}

// Pull main content from the update page (fall back to body if needed)
function extractContentHtml(updateHtml) {
  const bodyMatch = updateHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : updateHtml;

  const candidates = [
    /<div[^>]+class="[^"]*patchnotes[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+id="patchnotes"[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
  ];
  for (const re of candidates) {
    const mm = bodyHtml.match(re);
    if (mm && mm[1]) return mm[1];
  }
  return bodyHtml;
}

// ---- Core cycle ----
async function processOnce(reason = "poll") {
  try {
    console.log(`[${reason}] Fetching updates list…`);
    const listHtml = await fetchText(LIST_URL_FI);

    const latestUrl = extractLatestUpdateUrl(listHtml);
    console.log("Latest updates URL:", latestUrl);

    if (!latestUrl) return;

    const isNew = latestUrl !== lastUrl;
    if (isNew || FORCE_POST_ON_BOOT) {
      console.log("New or forced. Fetching update page…");
      const updateHtml = await fetchText(latestUrl);
      const contentHtml = extractContentHtml(updateHtml);
      const text = htmlToText(contentHtml);
      console.log("Extracted text length:", text.length);

      if (!text || text.trim().length < 10) {
        console.warn("Update text empty/short; skipping post.");
        lastUrl = latestUrl;
        return;
      }

      // 1) Post header + body (split)
      const header = `${CUSTOM_EMOJI}  **Uusi CS2-päivitys!**`;
      const parts = chunksWithHeader(header, text);
      for (const p of parts) await post(p);

      // 2) Post the source link at the end, with embeds suppressed
      //    (so it shows the link text only, no preview)
      await post(latestUrl, { suppressEmbeds: true });

      lastUrl = latestUrl;
      console.log("Posted update from:", latestUrl);
    } else {
      console.log("No new update.");
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

await post(`${CUSTOM_EMOJI}  CS Suomi bot on käynnissä ✅ (lähde: counter-strike.net/updates FI)`);
await processOnce("startup");
setInterval(() => processOnce("poll"), POLL_MS);
