const assert = require("node:assert/strict");
const test = require("node:test");
const portalApi = require("../api/[...path].js");

function fakeResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      this.ended = true;
    }
  };
}

test("Vercel API reports missing Neon configuration as JSON without proxying", async (t) => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousPostgresUrl = process.env.POSTGRES_URL;
  const previousBackendUrl = process.env.PORTAL_BACKEND_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  process.env.PORTAL_BACKEND_URL = "http://127.0.0.1:1";
  t.after(() => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousPostgresUrl;
    if (previousBackendUrl === undefined) delete process.env.PORTAL_BACKEND_URL;
    else process.env.PORTAL_BACKEND_URL = previousBackendUrl;
  });

  const response = fakeResponse();
  await portalApi({
    method: "POST",
    url: "/api/login",
    headers: { host: "jaitinn.site", origin: "https://jaitinn.site" },
    body: { username: "staff", password: "example" }
  }, response);

  assert.equal(response.statusCode, 503);
  assert.match(response.headers["content-type"], /application\/json/);
  assert.match(response.body.error, /Neon Postgres database/);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("Vercel API rejects cross-origin state changes", async (t) => {
  const previousTrustedOrigin = process.env.TRUSTED_ORIGIN;
  delete process.env.TRUSTED_ORIGIN;
  t.after(() => {
    if (previousTrustedOrigin === undefined) delete process.env.TRUSTED_ORIGIN;
    else process.env.TRUSTED_ORIGIN = previousTrustedOrigin;
  });
  const response = fakeResponse();
  await portalApi({
    method: "POST",
    url: "/api/login",
    headers: { host: "jaitinn.site", origin: "https://attacker.example" },
    body: { username: "staff", password: "example" }
  }, response);
  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /did not come from the portal/);
});

test("Vercel API handles preflight without requiring a database", async () => {
  const response = fakeResponse();
  await portalApi({ method: "OPTIONS", url: "/api/login", headers: {} }, response);
  assert.equal(response.statusCode, 204);
  assert.equal(response.ended, true);
  assert.equal(response.headers.allow, "GET, POST, PATCH, DELETE, OPTIONS");
});
