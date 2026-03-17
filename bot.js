import fetch from "node-fetch";
import fs from "fs";

// ---- CONFIG ----
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CUSTOM_EMOJI = "<:cssuomi:1410389173512310955>";
const POLL_MS = 5 * 60 * 1000; // 5 minutes

const FEED_URL =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=1&maxlength=0&l=english";

const STATE_FILE = "last_gid.txt";

// ---- STARTUP CHECK ----
if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing BOT_TOKEN or CHANNEL_ID");
  process.exit(1);
}

// ---- HELPERS ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadLastGid() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return fs.readFileSync(STATE_FILE, "utf8").trim() || null;
    }
  } catch (err) {
    console.warn("Could not read state file:", err);
  }
  return null;
}

function saveLastGid(gid) {
  try {
    fs.writeFileSync(STATE_FILE, String(gid), "utf8");
  } catch (err) {
    console.warn("Could not write state file:", err);
  }
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
      console.warn("429 rate limit; waiting", wait, "ms");
      await sleep(wait);
      continue;
    }

    const txt = await res.text().catch(() => "");
    throw new Error(`Post failed: ${res.status} ${txt}`);
  }
}

function cleanTitle(title) {
  if (!title) return "CS2 Update";
  return String(title).replace(/\s+/g, " ").trim();
}

function cleanUrl(url) {
  if (!url) return null;

  let u = String(url).trim();

  u = u.replace(/^http:\/\//i, "https://");
  u = u.replace("steamstore-a.akamaihd.net", "store.steampowered.com");

  return u;
}

async function fetchLatestNews() {
  const res = await fetch(FEED_URL, {
    headers: {
      "User-Agent": "cs-suomi-bot/2.0"
    }
  });

  if (!res.ok) {
    throw new Error(`Feed request failed: ${res.status}`);
  }

  const data = await res.json();
  return data?.appnews?.newsitems?.[0] || null;
}

async function poll() {
  try {
    const item = await fetchLatestNews();

    if (!item) {
      console.log("No news item found.");
      return;
    }

    const gid = String(item.gid || "").trim();
    const url = cleanUrl(item.url);
    const lastGid = loadLastGid();

    console.log("Latest gid:", gid);
    console.log("Latest url:", url);

    if (!gid) {
      console.log("Missing gid, skipping.");
      return;
    }

    if (gid === lastGid) {
      console.log("No new update.");
      return;
    }

    const message =
`${CUSTOM_EMOJI} **Uusi CS2-päivitys!**

Lue lisää Steamista: <${url}>`;

    await post(message);
    saveLastGid(gid);

    console.log("Posted update:", gid, title);
  } catch (err) {
    console.error("Poll error:", err);
  }
}

// ---- STARTUP ----
await poll();
setTimeout(() => setInterval(poll, POLL_MS), POLL_MS);
