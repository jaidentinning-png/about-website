const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function waitForServer(child, output) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start. ${output()}`)), 10_000);
    const check = () => {
      const match = output().match(/listening on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited during startup (${code}). ${output()}`));
    });
  });
}

function sessionCookie(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] || "";
}

async function request(base, route, options = {}) {
  const headers = { Origin: base, ...(options.headers || {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.csrf) headers["X-CSRF-Token"] = options.csrf;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${base}${route}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

async function getJson(response) {
  return response.json();
}

test("personal portfolio serves public content and support tickets", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "personal-site-test-"));
  let child;
  let logs = "";
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: "0",
      DATA_DIR: dataDir,
      BOOTSTRAP_OWNER_USERNAME: "portalowner",
      BOOTSTRAP_OWNER_PASSWORD: "test-owner-password-that-is-long"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = await waitForServer(child, () => logs);
  const homepage = await request(base, "/");
  assert.equal(homepage.status, 200);
  const html = await homepage.text();
  assert.match(html, /My Portfolio/);
  assert.match(html, /site-logo\.jpg/);
  assert.match(html, /data-route="portfolio"/);
  assert.equal(homepage.headers.get("cache-control"), "no-store");

  const styles = await request(base, "/styles.css?v=20");
  assert.equal(styles.status, 200);
  assert.doesNotMatch(await styles.text(), /neon|#00ffff|#ff00ff/i);

  const site = await request(base, "/api/site");
  assert.equal(site.status, 200);
  const siteJson = await getJson(site);
  assert.equal(siteJson.content.name, "Your Name");

  const ticket = await request(base, "/api/tickets", {
    method: "POST",
    body: { name: "Test Visitor", email: "visitor@example.com", subject: "Promotion", message: "Please promote my server." }
  });
  assert.equal(ticket.status, 201);

  const login = await request(base, "/api/login", {
    method: "POST",
    body: { username: "portalowner", password: "test-owner-password-that-is-long" }
  });
  assert.equal(login.status, 200);
  const loginJson = await getJson(login);
  const cookie = sessionCookie(login);
  assert.equal(loginJson.ok, true);
  assert.ok(cookie);

  const me = await request(base, "/api/me", { cookie });
  assert.equal(me.status, 200);
  const meJson = await getJson(me);
  assert.ok(meJson.csrfToken);

  const ownerTickets = await request(base, "/api/tickets", { cookie });
  assert.equal(ownerTickets.status, 200);
  const tickets = await getJson(ownerTickets);
  assert.equal(tickets.tickets.length, 1);
});
