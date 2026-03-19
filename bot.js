import fetch from "node-fetch";
import fs from "fs";

// ---- CONFIG ----
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";
const POLL_MS = 5 * 60 * 1000;

const FEED_URL =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=5&maxlength=0&l=english";

const STATE_FILE = "last_gid.txt";

// ---- STARTUP CHECK ----
if (!TOKEN || !CHANNEL_ID) {
  process.exit(1);
}

// ---- HELPERS ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadLastGid() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return fs.readFileSync(STATE_FILE, "utf8").trim() || null;
    }
  } catch {}
  return null;
}

function saveLastGid(gid) {
  try {
    fs.writeFileSync(STATE_FILE, String(gid), "utf8");
  } catch {}
}

async function post(content) {
  if (!content) return;

  while (true) {
    const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        flags: 4
      }),
    });

    if (res.ok) return;

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const wait = Math.ceil((data.retry_after || 0.5) * 1000);
      await sleep(wait);
      continue;
    }

    throw new Error("Post failed");
  }
}

function cleanUrl(url) {
  if (!url) return null;
  let u = String(url).trim();
  u = u.replace(/^http:\/\//i, "https://");
  u = u.replace("steamstore-a.akamaihd.net", "store.steampowered.com");
  return u;
}

// ✅ ONLY allow real Steam announcements
function isOfficial(item) {
  if (!item || !item.url) return false;

  const url = item.url.toLowerCase();

  return url.includes("steamcommunity.com") ||
         url.includes("steam_community_announcements");
}

async function fetchLatestNews() {
  const res = await fetch(FEED_URL, {
    headers: {
      "User-Agent": "cs-suomi-bot/2.0"
    }
  });

  if (!res.ok) return null;

  const data = await res.json();
  const items = data?.appnews?.newsitems || [];

  // ✅ pick first valid official item
  return items.find(isOfficial) || null;
}

async function poll() {
  try {
    const item = await fetchLatestNews();
    if (!item) return;

    const gid = String(item.gid || "").trim();
    const url = cleanUrl(item.url);
    const lastGid = loadLastGid();

    if (!gid || gid === lastGid) return;

    const message =
`${CUSTOM_EMOJI} **Uusi CS2-päivitys!**

Lue lisää Steamista: <${url}>`;

    await post(message);
    saveLastGid(gid);
  } catch {}
}

// ---- STARTUP ----
await poll();
setTimeout(() => setInterval(poll, POLL_MS), POLL_MS);
