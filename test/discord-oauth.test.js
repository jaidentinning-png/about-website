const assert = require("node:assert/strict");
const test = require("node:test");
const {
  authorizationUrl,
  createPkcePair,
  exchangeCode,
  fetchIdentityAndGuilds,
  readConfig,
  snowflakeCreatedAt
} = require("../discord-oauth.js");

test("Discord authorization uses identify and guilds with PKCE and a state token", () => {
  const { verifier, challenge } = createPkcePair();
  assert.notEqual(verifier, challenge);
  const url = new URL(authorizationUrl({
    clientId: "client-id",
    redirectUri: "https://portal.example/api/discord/callback",
    state: "random-state",
    challenge
  }));
  assert.equal(url.origin, "https://discord.com");
  assert.equal(url.searchParams.get("scope"), "identify guilds");
  assert.equal(url.searchParams.get("state"), "random-state");
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("Discord config requires a secret and an HTTPS callback URL", () => {
  assert.throws(() => readConfig({}), (error) => error.status === 503);
  assert.throws(() => readConfig({
    DISCORD_CLIENT_ID: "id",
    DISCORD_CLIENT_SECRET: "secret",
    DISCORD_REDIRECT_URI: "http://portal.example/callback"
  }), /must use HTTPS/);
  assert.deepEqual(readConfig({
    DISCORD_CLIENT_ID: "id",
    DISCORD_CLIENT_SECRET: "secret",
    DISCORD_REDIRECT_URI: "https://portal.example/api/discord/callback"
  }), {
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "https://portal.example/api/discord/callback"
  });
});

test("Discord code exchange uses PKCE and guild membership pagination returns compact server data", async (t) => {
  const originalFetch = global.fetch;
  const requestedUrls = [];
  global.fetch = async (input, options) => {
    const url = new URL(input);
    requestedUrls.push(url);
    if (url.pathname === "/api/v10/oauth2/token") {
      assert.equal(options.body.get("code_verifier"), "test-verifier");
      return Response.json({ access_token: "mock-access-token" });
    }
    if (url.pathname === "/api/v10/users/@me") {
      assert.equal(options.headers.Authorization, "Bearer mock-access-token");
      return Response.json({ id: "175928847299117063", username: "jaiden", discriminator: "0" });
    }
    if (url.pathname === "/api/v10/users/@me/guilds" && !url.searchParams.has("after")) {
      return Response.json(Array.from({ length: 200 }, (_, index) => ({
        id: String(index + 1),
        name: `Server ${index + 1}`,
        icon: null,
        permissions: "8"
      })));
    }
    if (url.pathname === "/api/v10/users/@me/guilds") {
      assert.equal(url.searchParams.get("after"), "200");
      return Response.json([{ id: "201", name: "Last Server", icon: "abc" }]);
    }
    throw new Error(`Unexpected Discord request: ${url}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const config = {
    clientId: "test-id",
    clientSecret: "test-secret",
    redirectUri: "https://portal.example/api/discord/callback"
  };
  const token = await exchangeCode(config, "auth-code", "test-verifier");
  const linked = await fetchIdentityAndGuilds(token);
  assert.equal(linked.id, "175928847299117063");
  assert.equal(linked.username, "jaiden");
  assert.equal(linked.guilds.length, 201);
  assert.deepEqual(linked.guilds.at(-1), { id: "201", name: "Last Server", icon: "abc" });
  assert.equal(Object.hasOwn(linked.guilds[0], "permissions"), false);
  assert.equal(requestedUrls.length, 4);
});

test("Discord creation date is derived from the account snowflake", () => {
  const expected = Date.UTC(2020, 0, 2, 3, 4, 5);
  const snowflake = (((BigInt(expected) - 1420070400000n) << 22n) + 1n).toString();
  assert.equal(snowflakeCreatedAt(snowflake), new Date(expected).toISOString());
  assert.equal(snowflakeCreatedAt("not-a-snowflake"), null);
});
