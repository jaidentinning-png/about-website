const { createHash, randomBytes } = require("node:crypto");

const DISCORD_API = "https://discord.com/api/v10";
const SNOWFLAKE_EPOCH = 1420070400000n;

function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizationUrl({ clientId, redirectUri, state, challenge, scope = "identify guilds" }) {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function readConfig(environment = process.env) {
  const clientId = environment.DISCORD_CLIENT_ID;
  const clientSecret = environment.DISCORD_CLIENT_SECRET;
  const redirectUri = environment.DISCORD_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    const error = new Error("Discord linking is not configured. Contact the Owner.");
    error.status = 503;
    throw error;
  }
  let redirect;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new Error("DISCORD_REDIRECT_URI must be a valid URL.");
  }
  if (redirect.protocol !== "https:" && redirect.hostname !== "localhost") {
    throw new Error("DISCORD_REDIRECT_URI must use HTTPS.");
  }
  return { clientId, clientSecret, redirectUri: redirect.toString() };
}

async function discordFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    const error = new Error(`Discord API returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function exchangeCode(config, code, verifier) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier
  });
  const tokens = await discordFetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new Error("Discord did not return an access token.");
  }
  return tokens.access_token;
}

async function fetchIdentity(accessToken) {
  const identity = await discordFetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (typeof identity.id !== "string" || typeof identity.username !== "string") {
    throw new Error("Discord returned an incomplete user profile.");
  }
  return {
    id: identity.id,
    username: identity.discriminator && identity.discriminator !== "0"
      ? `${identity.username}#${identity.discriminator}`
      : identity.username,
    avatar: typeof identity.avatar === "string" ? identity.avatar : null
  };
}

async function fetchIdentityAndGuilds(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const [identity, firstPage] = await Promise.all([
    fetchIdentity(accessToken),
    discordFetch(`${DISCORD_API}/users/@me/guilds?limit=200`, { headers })
  ]);
  if (!Array.isArray(firstPage)) throw new Error("Discord returned an invalid server list.");

  const guilds = firstPage;
  let after = guilds.at(-1)?.id;
  for (let page = 1; guilds.length % 200 === 0 && guilds.length > 0 && page < 10; page += 1) {
    const pageRows = await discordFetch(
      `${DISCORD_API}/users/@me/guilds?limit=200&after=${encodeURIComponent(after)}`,
      { headers }
    );
    if (!Array.isArray(pageRows) || pageRows.length === 0) break;
    guilds.push(...pageRows);
    after = pageRows.at(-1)?.id;
  }

  return {
    ...identity,
    guilds: guilds.map((guild) => ({
      id: guild.id,
      name: String(guild.name || "Unknown server").slice(0, 100),
      icon: typeof guild.icon === "string" ? guild.icon : null
    }))
  };
}

function snowflakeCreatedAt(id) {
  if (typeof id !== "string" || !/^\d{17,20}$/.test(id)) return null;
  try {
    return new Date(Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH)).toISOString();
  } catch {
    return null;
  }
}

module.exports = {
  authorizationUrl,
  createPkcePair,
  exchangeCode,
  fetchIdentity,
  fetchIdentityAndGuilds,
  readConfig,
  snowflakeCreatedAt
};
