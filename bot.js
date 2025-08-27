// CS Suomi päivitykset — posts CS patch notes as plain text
// Needs env vars BOT_TOKEN and CHANNEL_ID

import fetch from "node-fetch";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const FEED = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=1&maxlength=0";

if (!TOKEN || !CHANNEL_ID) {
  console.error("Missing BOT_TOKEN or CHANNEL_ID");
  process.exit(1);
}

let lastGid = null;

async function post(content) {
  const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bot ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("Post failed:", res.status, txt);
  }
}

function cleanBody(s) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/\[url=.*?\]|\[\/url\]/g, "")
    .replace(/\[img\][\s\S]*?\[\/img\]/g, "")
    .replace(/\[(\/)?(b|i|u|list|\*)\]/g, "");
}

async function poll() {
  try {
    const r = await fetch(FEED);
    if (!r.ok) throw new Error("Feed request failed: " + r.status);
    const j = await r.json();
    const item = j?.appnews?.newsitems?.[0];
    if (!item) return;

    if (item.gid !== lastGid) {
      lastGid = item.gid;

      const title = item.title || "CS Päivitys";
      let body = cleanBody(item.contents || "");

      const chunks = [];
      const head = `**${title}**\n`;
      if (body.length <= 1800) {
        chunks.push(head + body);
      } else {
        chunks.push(head + body.slice(0, 1800));
        for (let i = 1800; i < body.length; i += 1900) {
          chunks.push(body.slice(i, i + 1900));
        }
      }

      for (const c of chunks) await post(c);
      console.log("Posted update:", title);
    }
  } catch (e) {
    console.error("Poll error:", e);
  }
}

// Hello message so you see it's alive
await post("CS-päivitykset bot is live ✅");

await poll();
setInterval(poll, 5 * 60 * 1000);
