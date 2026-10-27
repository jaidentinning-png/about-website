const {
  createHash,
  randomBytes,
  randomUUID,
  scrypt: scryptCallback,
  timingSafeEqual
} = require("node:crypto");
const { promisify } = require("node:util");
const { neon } = require("@neondatabase/serverless");
const {
  authorizationUrl,
  createPkcePair,
  exchangeCode,
  fetchIdentity,
  fetchIdentityAndGuilds,
  readConfig,
  snowflakeCreatedAt
} = require("../discord-oauth");

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 96 * 1024;
const PASSWORD_MIN_LENGTH = 12;
const TODO_STATUSES = new Set(["not_done", "in_progress", "done"]);
const TASK_STATUSES = new Set(["todo", "in_progress", "done"]);
const PERMISSIONS = [
  "manageAccounts",
  "manageRoles",
  "manageTasks",
  "managePayroll",
  "viewAllPayroll",
  "manageAutomations",
  "manageCanvas",
  "manageDocuments"
];

let databaseUrl;
let sql;
let schemaPromise;

function json(response, status, payload, headers = {}) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  return response.status(status).json(payload);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function setCookie(token, maxAge = SESSION_TTL_MS / 1000) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `ce_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function cookieToken(request) {
  const cookies = String(request.headers.cookie || "").split(";").map((part) => part.trim());
  const session = cookies.find((part) => part.startsWith("ce_session="));
  return session ? session.slice("ce_session=".length) : "";
}

function verifyOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    fail(403, "This request did not come from the portal.");
  }
  if (process.env.TRUSTED_ORIGIN) {
    let trusted;
    try {
      trusted = new URL(process.env.TRUSTED_ORIGIN);
    } catch {
      throw new Error("TRUSTED_ORIGIN must be a valid origin URL.");
    }
    if (parsed.origin === trusted.origin) return;
  }
  if (parsed.host !== request.headers.host) fail(403, "This request did not come from the portal.");
}

function verifyCsrf(request, user) {
  verifyOrigin(request);
  if (!user || request.headers["x-csrf-token"] !== user.csrfToken) {
    fail(403, "Your session has expired. Refresh the page and try again.");
  }
}

function readBody(request) {
  if (request.body !== undefined) {
    if (typeof request.body === "string") {
      try {
        return JSON.parse(request.body || "{}");
      } catch {
        fail(400, "The request body is not valid JSON.");
      }
    }
    if (Buffer.isBuffer(request.body)) {
      if (request.body.length > MAX_BODY_BYTES) fail(413, "Request is too large.");
      try {
        return JSON.parse(request.body.toString("utf8") || "{}");
      } catch {
        fail(400, "The request body is not valid JSON.");
      }
    }
    if (typeof request.body === "object" && request.body !== null) {
      if (Buffer.byteLength(JSON.stringify(request.body)) > MAX_BODY_BYTES) fail(413, "Request is too large.");
      return request.body;
    }
  }
  return {};
}

function text(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function ownerAccountName() {
  return text(process.env.BOOTSTRAP_OWNER_USERNAME, 24);
}

async function passwordHash(password) {
  const salt = randomBytes(16).toString("base64url");
  const digest = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${digest.toString("base64url")}`;
}

async function verifyPassword(password, storedHash) {
  const [algorithm, salt, expected] = String(storedHash || "").split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const actual = await scrypt(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function can(user, permission) {
  return user.roleId === "owner" || user.permissions?.[permission] === true;
}

function redirect(response, location, headers = {}) {
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  return response.status(303).end();
}

function discordResultUrl(config, result) {
  const url = new URL("/", config.redirectUri);
  url.searchParams.set("discord", result);
  return url.toString();
}

function requirePermission(user, permission) {
  requireUser(user);
  if (!can(user, permission)) fail(403, "You do not have permission to do that.");
}

function requireUser(user) {
  if (!user) fail(401, "Please log in to continue.");
  if (!user.active) fail(403, "This account is disabled. Contact an administrator.");
}

function requireChangedPassword(user, pathname) {
  if (user.mustChangePassword && !["/api/password", "/api/logout", "/api/me"].includes(pathname)) {
    fail(428, "Change your temporary password before using the portal.");
  }
}

function requireDiscordLinked(user, pathname) {
  if (!user.discordId && !["/api/discord/authorize", "/api/password"].includes(pathname)) {
    fail(428, "Connect your Discord account before using the workspace.");
  }
}

function validateRobux(amount) {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10_000_000) {
    fail(400, "Enter a whole-number Robux amount between 1 and 10,000,000.");
  }
}

function validateUsername(username) {
  if (!/^[a-zA-Z0-9._-]{3,24}$/.test(username)) {
    fail(400, "Usernames must be 3-24 characters: letters, numbers, dots, underscores, or hyphens.");
  }
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > 200) {
    fail(400, `Passwords must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
}

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
        system BOOLEAN NOT NULL DEFAULT FALSE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS roles_name_lower_idx ON roles (lower(name))`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        role_id TEXT NOT NULL REFERENCES roles(id),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
        discord_id TEXT,
        discord_username TEXT,
        discord_avatar TEXT,
        discord_linked_at TEXT,
        discord_guilds JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TEXT NOT NULL
      )`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_id TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_username TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_avatar TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_linked_at TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_guilds JSONB NOT NULL DEFAULT '[]'::jsonb`,
      `CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id_unique_idx ON users(discord_id) WHERE discord_id IS NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username))`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL, expires_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS discord_oauth_states (
        state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        code_verifier TEXT NOT NULL, expires_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS discord_login_states (
        state_hash TEXT PRIMARY KEY, code_verifier TEXT NOT NULL, expires_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done')),
        assignee_id TEXT REFERENCES users(id), created_by TEXT NOT NULL REFERENCES users(id),
        due_date TEXT, canvas_x DOUBLE PRECISION NOT NULL DEFAULT 60,
        canvas_y DOUBLE PRECISION NOT NULL DEFAULT 60,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS payroll (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        amount INTEGER NOT NULL CHECK(amount > 0), note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')),
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        trigger_event TEXT NOT NULL CHECK(trigger_event = 'task_completed'),
        robux_amount INTEGER NOT NULL CHECK(robux_amount > 0),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id),
        task_id TEXT NOT NULL REFERENCES tasks(id), created_at TEXT NOT NULL,
        UNIQUE(automation_id, task_id)
      )`,
      `CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS documents_updated_idx ON documents(updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS todo_items (
        id TEXT PRIMARY KEY, section TEXT NOT NULL DEFAULT 'General',
        section_order INTEGER NOT NULL DEFAULT 0, item_order INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'not_done' CHECK(status IN ('not_done','in_progress','done')),
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS todo_items_status_updated_idx ON todo_items(section_order, item_order, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS login_attempts (
        ip_hash TEXT PRIMARY KEY, window_started_at BIGINT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0
      )`
    ];
    for (const statement of statements) await sql.query(statement);

    await sql.query(
      `INSERT INTO roles (id, name, permissions, system)
       VALUES
         ('owner', 'Owner', '{}'::jsonb, TRUE),
         ('hr', 'HR', '{"manageAccounts":true,"manageTasks":true,"managePayroll":true,"viewAllPayroll":true,"manageAutomations":true,"manageCanvas":true,"manageDocuments":true}'::jsonb, FALSE),
         ('developer', 'Developer', '{}'::jsonb, FALSE)
       ON CONFLICT (id) DO NOTHING`
    );
    await sql.query(
      `UPDATE roles SET permissions = permissions || '{"manageDocuments":true}'::jsonb WHERE id = 'hr'`
    );

    const existingOwner = await sql.query("SELECT id FROM users WHERE role_id = 'owner' LIMIT 1");
    if (existingOwner.length) return;
    const existingUser = await sql.query("SELECT id FROM users LIMIT 1");
    if (existingUser.length) {
      throw new Error("No Owner account exists. Configure bootstrap credentials to recover access.");
    }

    const username = ownerAccountName();
    const password = process.env.BOOTSTRAP_OWNER_PASSWORD || "";
    if (!/^[a-zA-Z0-9._-]{3,24}$/.test(username) || password.length < PASSWORD_MIN_LENGTH) {
      throw new Error("Set BOOTSTRAP_OWNER_USERNAME and BOOTSTRAP_OWNER_PASSWORD (at least 12 characters) in Vercel before the first sign-in.");
    }
    await sql.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id, active, must_change_password, created_at)
       VALUES ($1, $2, $3, $4, 'owner', TRUE, FALSE, $5)`,
      [randomUUID(), username, "Cartel Empire Owner", await passwordHash(password), new Date().toISOString()]
    );
    console.log(`Created initial Owner account "${username}".`);
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function database() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("Connect a Neon Postgres database to Vercel and set DATABASE_URL.");
  if (databaseUrl !== url) {
    databaseUrl = url;
    sql = neon(url);
    schemaPromise = null;
  }
  return sql;
}

async function currentUser(request) {
  const token = cookieToken(request);
  if (!token) return null;
  const rows = await sql.query(
    `SELECT s.csrf_token, s.expires_at, u.id, u.username, u.display_name,
            u.role_id, u.active, u.must_change_password, u.discord_id,
            r.name AS role_name,
            r.permissions
     FROM sessions s JOIN users u ON u.id = s.user_id
     JOIN roles r ON r.id = u.role_id WHERE s.token_hash = $1`,
    [hash(token)]
  );
  const row = rows[0];
  if (!row || Number(row.expires_at) < Date.now()) return null;
  const permissions = typeof row.permissions === "string" ? JSON.parse(row.permissions) : row.permissions;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleId: row.role_id,
    roleName: row.role_name,
    active: row.active,
    mustChangePassword: row.must_change_password,
    discordId: row.discord_id,
    permissions,
    csrfToken: row.csrf_token
  };
}

async function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  await sql.query(
    "INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)",
    [hash(token), userId, csrfToken, Date.now() + SESSION_TTL_MS]
  );
  return { token, csrfToken };
}

async function staffList(includeDisabled = false) {
  const rows = await sql.query(
    `SELECT u.id, u.username, u.display_name AS "displayName",
            u.role_id AS "roleId", r.name AS "roleName", u.active,
            (u.discord_id IS NOT NULL) AS "discordLinked"
     FROM users u JOIN roles r ON r.id = u.role_id
     ${includeDisabled ? "" : "WHERE u.active = TRUE"}
     ORDER BY r.name, u.display_name`
  );
  return rows;
}

async function staffOverview(user, staffId) {
  requirePermission(user, "manageAccounts");
  const targets = await sql.query(
    `SELECT u.id, u.username, u.display_name AS "displayName", u.role_id AS "roleId",
            r.name AS "roleName", u.active, u.created_at AS "createdAt",
            u.discord_id AS "discordId", u.discord_username AS "discordUsername",
            u.discord_avatar AS "discordAvatar", u.discord_linked_at AS "discordLinkedAt",
            u.discord_guilds AS "discordGuilds"
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [staffId]
  );
  const target = targets[0];
  if (!target) fail(404, "That staff account could not be found.");
  const [tasks, payroll, documents] = await Promise.all([
    sql.query(
      `SELECT id, title, description, status, due_date AS "dueDate", created_at AS "createdAt"
       FROM tasks WHERE assignee_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [staffId]
    ),
    can(user, "managePayroll") || can(user, "viewAllPayroll")
      ? sql.query(
        `SELECT id, amount, note, status, created_at AS "createdAt"
         FROM payroll WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [staffId]
      )
      : Promise.resolve([]),
    sql.query(
      `SELECT id, title, content, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM documents WHERE created_by = $1 ORDER BY updated_at DESC LIMIT 100`,
      [staffId]
    )
  ]);
  const guilds = typeof target.discordGuilds === "string"
    ? JSON.parse(target.discordGuilds)
    : target.discordGuilds;
  return {
    canViewPayroll: can(user, "managePayroll") || can(user, "viewAllPayroll"),
    staff: {
      id: target.id,
      username: target.username,
      displayName: target.displayName,
      roleName: target.roleName,
      active: target.active,
      createdAt: target.createdAt
    },
    discord: target.discordId ? {
      id: target.discordId,
      username: target.discordUsername,
      avatar: target.discordAvatar,
      linkedAt: target.discordLinkedAt,
      accountCreatedAt: snowflakeCreatedAt(target.discordId),
      guilds: Array.isArray(guilds) ? guilds : []
    } : null,
    tasks,
    payroll,
    documents
  };
}

async function boardData(user) {
  const [tasks, payroll, roles, automations, documents, todoItems, staff] = await Promise.all([
    sql.query(
      `SELECT t.id, t.title, t.description, t.status, t.assignee_id AS "assigneeId",
              a.display_name AS "assigneeName", t.created_by AS "createdBy",
              t.due_date AS "dueDate", t.canvas_x AS "canvasX", t.canvas_y AS "canvasY",
              t.created_at AS "createdAt", t.updated_at AS "updatedAt"
       FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id ORDER BY t.created_at DESC`
    ),
    can(user, "viewAllPayroll") || can(user, "managePayroll")
      ? sql.query(
        `SELECT p.id, p.user_id AS "userId", u.display_name AS "displayName",
                p.amount, p.note, p.status, p.created_by AS "createdBy", p.created_at AS "createdAt"
         FROM payroll p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC`
      )
      : sql.query(
        `SELECT p.id, p.user_id AS "userId", u.display_name AS "displayName",
                p.amount, p.note, p.status, p.created_by AS "createdBy", p.created_at AS "createdAt"
         FROM payroll p JOIN users u ON u.id = p.user_id
         WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
        [user.id]
      ),
    sql.query("SELECT id, name, permissions, system FROM roles ORDER BY name"),
    can(user, "manageAutomations")
      ? sql.query(
        `SELECT id, name, trigger_event AS trigger, robux_amount AS "robuxAmount",
                active, created_at AS "createdAt" FROM automations ORDER BY created_at DESC`
      )
      : Promise.resolve([]),
    sql.query(
      `SELECT d.id, d.title, d.content, d.created_by AS "createdBy",
              u.display_name AS "authorName", d.created_at AS "createdAt", d.updated_at AS "updatedAt"
       FROM documents d JOIN users u ON u.id = d.created_by ORDER BY d.updated_at DESC`
    ),
    sql.query(
      `SELECT t.id, t.section, t.section_order AS "sectionOrder", t.item_order AS "itemOrder",
              t.title, t.description, t.status, t.created_by AS "createdBy",
              u.display_name AS "authorName", t.created_at AS "createdAt", t.updated_at AS "updatedAt"
       FROM todo_items t JOIN users u ON u.id = t.created_by
       ORDER BY t.section_order, t.item_order,
         CASE t.status WHEN 'not_done' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
         t.updated_at DESC`
    ),
    staffList(can(user, "manageAccounts"))
  ]);
  return {
    tasks,
    payroll,
    roles: roles.map((role) => ({
      ...role,
      permissions: typeof role.permissions === "string" ? JSON.parse(role.permissions) : role.permissions,
      system: role.system
    })),
    automations: automations.map((rule) => ({ ...rule, active: rule.active })),
    documents,
    todoItems,
    staff: can(user, "manageAccounts")
      ? staff
      : staff.map(({ id, displayName, roleName }) => ({ id, displayName, roleName }))
  };
}

function loginRateKey(request, username) {
  return hash(`${request.headers["x-forwarded-for"] || "unknown"}:${username}`);
}

async function checkLoginLimit(request, username) {
  const key = loginRateKey(request, username);
  const now = Date.now();
  const rows = await sql.query("SELECT window_started_at, attempt_count FROM login_attempts WHERE ip_hash = $1", [key]);
  const row = rows[0];
  if (row && now - Number(row.window_started_at) < 15 * 60 * 1000 && row.attempt_count >= 10) {
    fail(429, "Too many sign-in attempts. Wait 15 minutes before trying again.");
  }
  if (row && now - Number(row.window_started_at) >= 15 * 60 * 1000) {
    await sql.query("DELETE FROM login_attempts WHERE ip_hash = $1", [key]);
  }
  return key;
}

async function recordLoginFailure(key) {
  const now = Date.now();
  await sql.query(
    `INSERT INTO login_attempts (ip_hash, window_started_at, attempt_count) VALUES ($1, $2, 1)
     ON CONFLICT (ip_hash) DO UPDATE SET
       attempt_count = CASE
         WHEN EXCLUDED.window_started_at - login_attempts.window_started_at >= 900000 THEN 1
         ELSE login_attempts.attempt_count + 1 END,
       window_started_at = CASE
         WHEN EXCLUDED.window_started_at - login_attempts.window_started_at >= 900000 THEN EXCLUDED.window_started_at
         ELSE login_attempts.window_started_at END`,
    [key, now]
  );
}

async function handle(request, response) {
  const requestUrl = new URL(request.url, "https://vercel.invalid");
  const rewrittenPath = requestUrl.searchParams.get("__api_path");
  const path = rewrittenPath
    ? `/api/${rewrittenPath.replace(/^\/?api\/?/, "").replace(/^\/+/, "")}`
    : requestUrl.pathname;
  if (request.method === "OPTIONS") {
    response.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return response.status(204).end();
  }
  if (!path.startsWith("/api/")) return json(response, 404, { error: "API route not found." });

  try {
    if (request.method !== "GET" && request.method !== "HEAD") verifyOrigin(request);
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
      return json(response, 503, { error: "Connect a Neon Postgres database to Vercel and set DATABASE_URL." });
    }
    database();
    await ensureSchema();

    if (request.method === "POST" && path === "/api/login") {
      const body = readBody(request);
      const username = text(body.username, 80).toLowerCase();
      const password = typeof body.password === "string" ? body.password : "";
      const rateKey = await checkLoginLimit(request, username);
      const rows = await sql.query(
        `SELECT id, password_hash, active, must_change_password FROM users
         WHERE lower(username) = $1 LIMIT 1`,
        [username]
      );
      const user = rows[0];
      if (!user || !user.active || password.length > 200 || !(await verifyPassword(password, user.password_hash))) {
        await recordLoginFailure(rateKey);
        fail(401, "The username or password was not recognized.");
      }
      await sql.query("DELETE FROM login_attempts WHERE ip_hash = $1", [rateKey]);
      const session = await createSession(user.id);
      return json(response, 200, { ok: true, mustChangePassword: user.must_change_password }, {
        "Set-Cookie": setCookie(session.token)
      });
    }

    if (request.method === "GET" && path === "/api/discord/login") {
      const config = readConfig();
      const state = randomBytes(32).toString("base64url");
      const { verifier, challenge } = createPkcePair();
      await sql.query("DELETE FROM discord_login_states WHERE expires_at <= $1", [Date.now()]);
      await sql.query(
        "INSERT INTO discord_login_states (state_hash, code_verifier, expires_at) VALUES ($1, $2, $3)",
        [hash(state), verifier, Date.now() + 10 * 60 * 1000]
      );
      return redirect(response, authorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state,
        challenge,
        scope: "identify"
      }));
    }

    if (request.method === "GET" && path === "/api/discord/callback") {
      const config = readConfig();
      const callbackUrl = (result) => discordResultUrl(config, result);
      const callback = new URL(request.url, "https://vercel.invalid");
      const state = callback.searchParams.get("state") || "";
      const code = callback.searchParams.get("code") || "";
      if (!state) return redirect(response, callbackUrl("invalid"));
      const stateHash = hash(state);
      const loginRows = await sql.query(
        "SELECT code_verifier, expires_at FROM discord_login_states WHERE state_hash = $1",
        [stateHash]
      );
      const loginState = loginRows[0];
      if (loginState) {
        await sql.query("DELETE FROM discord_login_states WHERE state_hash = $1", [stateHash]);
        if (Number(loginState.expires_at) < Date.now()) return redirect(response, callbackUrl("login-expired"));
        if (callback.searchParams.has("error") || !code) return redirect(response, callbackUrl("login-cancelled"));
        try {
          const accessToken = await exchangeCode(config, code, loginState.code_verifier);
          const discord = await fetchIdentity(accessToken);
          const linkedAccounts = await sql.query(
            "SELECT id, active, must_change_password FROM users WHERE discord_id = $1 LIMIT 1",
            [discord.id]
          );
          const linkedAccount = linkedAccounts[0];
          if (!linkedAccount) return redirect(response, callbackUrl("login-not-linked"));
          if (!linkedAccount.active) return redirect(response, callbackUrl("login-disabled"));
          if (linkedAccount.must_change_password) return redirect(response, callbackUrl("login-password-required"));
          const session = await createSession(linkedAccount.id);
          return redirect(response, callbackUrl("login"), { "Set-Cookie": setCookie(session.token) });
        } catch (error) {
          console.error("Discord login failed:", error);
          return redirect(response, callbackUrl("login-failed"));
        }
      }
      const stateRows = await sql.query(
        `SELECT o.user_id, o.code_verifier, o.expires_at
         FROM discord_oauth_states o JOIN sessions s ON s.token_hash = o.session_hash
         JOIN users u ON u.id = o.user_id
         WHERE o.state_hash = $1 AND s.user_id = o.user_id AND s.expires_at > $2 AND u.active = TRUE`,
        [stateHash, Date.now()]
      );
      const oauthState = stateRows[0];
      await sql.query("DELETE FROM discord_oauth_states WHERE state_hash = $1", [stateHash]);
      if (!oauthState || Number(oauthState.expires_at) < Date.now()) {
        return redirect(response, callbackUrl("expired"));
      }
      if (callback.searchParams.has("error") || !code) return redirect(response, callbackUrl("cancelled"));
      try {
        const accessToken = await exchangeCode(config, code, oauthState.code_verifier);
        const discord = await fetchIdentityAndGuilds(accessToken);
        const updated = await sql.query(
          `UPDATE users SET discord_id = $1, discord_username = $2, discord_avatar = $3,
            discord_linked_at = $4, discord_guilds = $5::jsonb
           WHERE id = $6 AND active = TRUE AND must_change_password = FALSE RETURNING id`,
          [
            discord.id,
            discord.username,
            discord.avatar,
            new Date().toISOString(),
            JSON.stringify(discord.guilds),
            oauthState.user_id
          ]
        );
        if (!updated.length) return redirect(response, callbackUrl("expired"));
        return redirect(response, callbackUrl("linked"));
      } catch (error) {
        if (error.code === "23505") return redirect(response, callbackUrl("already-linked"));
        console.error("Discord OAuth callback failed:", error);
        return redirect(response, callbackUrl("failed"));
      }
    }

    if (request.method === "GET" && path === "/api/me") {
      const user = await currentUser(request);
      requireUser(user);
      return json(response, 200, {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          roleId: user.roleId,
          roleName: user.roleName,
          permissions: user.permissions,
          mustChangePassword: user.mustChangePassword,
          discordLinked: Boolean(user.discordId)
        },
        csrfToken: user.csrfToken
      });
    }

    if (request.method === "POST" && path === "/api/logout") {
      const user = await currentUser(request);
      if (user) verifyCsrf(request, user);
      const token = cookieToken(request);
      if (token) await sql.query("DELETE FROM sessions WHERE token_hash = $1", [hash(token)]);
      return json(response, 200, { ok: true }, { "Set-Cookie": setCookie("", 0) });
    }

    const user = await currentUser(request);
    requireUser(user);
    requireChangedPassword(user, path);
    requireDiscordLinked(user, path);

    if (request.method === "GET" && path === "/api/discord/authorize") {
      const config = readConfig();
      const sessionToken = cookieToken(request);
      const state = randomBytes(32).toString("base64url");
      const { verifier, challenge } = createPkcePair();
      await sql.query("DELETE FROM discord_oauth_states WHERE expires_at <= $1", [Date.now()]);
      await sql.query(
        `INSERT INTO discord_oauth_states (state_hash, user_id, session_hash, code_verifier, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [hash(state), user.id, hash(sessionToken), verifier, Date.now() + 10 * 60 * 1000]
      );
      return redirect(response, authorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state,
        challenge
      }));
    }

    if (request.method === "POST" && path === "/api/password") {
      verifyCsrf(request, user);
      const body = readBody(request);
      const rows = await sql.query("SELECT password_hash FROM users WHERE id = $1", [user.id]);
      if (typeof body.currentPassword !== "string" || !rows[0] || !(await verifyPassword(body.currentPassword, rows[0].password_hash))) {
        fail(400, "The current password is incorrect.");
      }
      validatePassword(body.newPassword);
      await sql.query("UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2", [
        await passwordHash(body.newPassword), user.id
      ]);
      await sql.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [user.id, hash(cookieToken(request))]);
      return json(response, 200, { ok: true });
    }

    if (request.method === "GET" && path === "/api/board") {
      return json(response, 200, await boardData(user));
    }

    if (request.method === "POST" && path === "/api/accounts") {
      verifyCsrf(request, user);
      requirePermission(user, "manageAccounts");
      const body = readBody(request);
      const username = text(body.username, 24);
      validateUsername(username);
      const displayName = text(body.displayName, 50);
      if (!displayName) fail(400, "Enter a display name.");
      const roles = await sql.query("SELECT id FROM roles WHERE id = $1", [body.roleId]);
      if (!roles.length || body.roleId === "owner") fail(400, "Choose a staff role other than Owner.");
      const password = randomBytes(18).toString("base64url");
      try {
        await sql.query(
          `INSERT INTO users (id, username, display_name, password_hash, role_id, active, must_change_password, created_at)
           VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, $6)`,
          [randomUUID(), username, displayName, await passwordHash(password), body.roleId, new Date().toISOString()]
        );
      } catch (error) {
        if (error.code === "23505") fail(409, "That username is already in use.");
        throw error;
      }
      return json(response, 201, { ok: true, username, temporaryPassword: password });
    }

    const accountMenuRoute = path.match(/^\/api\/accounts\/([0-9a-f-]{36})\/menu$/i);
    if (accountMenuRoute && request.method === "GET") {
      return json(response, 200, await staffOverview(user, accountMenuRoute[1]));
    }

    const unlinkDiscordRoute = path.match(/^\/api\/accounts\/([0-9a-f-]{36})\/unlink-discord$/i);
    if (unlinkDiscordRoute && request.method === "POST") {
      verifyCsrf(request, user);
      requirePermission(user, "manageAccounts");
      const targetRows = await sql.query("SELECT id, role_id FROM users WHERE id = $1", [unlinkDiscordRoute[1]]);
      const target = targetRows[0];
      if (!target || target.role_id === "owner" || target.id === user.id) {
        fail(404, "That staff account cannot be unlinked.");
      }
      await sql.query(
        `UPDATE users SET discord_id = NULL, discord_username = NULL, discord_avatar = NULL,
          discord_linked_at = NULL, discord_guilds = '[]'::jsonb WHERE id = $1`,
        [target.id]
      );
      await sql.query("DELETE FROM sessions WHERE user_id = $1", [target.id]);
      return json(response, 200, { ok: true });
    }

    const accountRoute = path.match(/^\/api\/accounts\/([0-9a-f-]{36})(?:\/(reset-password))?$/i);
    if (accountRoute && request.method === "POST" && accountRoute[2] === "reset-password") {
      verifyCsrf(request, user);
      requirePermission(user, "manageAccounts");
      const rows = await sql.query("SELECT id, username, role_id FROM users WHERE id = $1", [accountRoute[1]]);
      const target = rows[0];
      if (!target || target.role_id === "owner") fail(404, "That staff account could not be found.");
      if (target.id === user.id) fail(400, "Ask another administrator to reset your own account.");
      const password = randomBytes(18).toString("base64url");
      await sql.query("UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2", [
        await passwordHash(password), target.id
      ]);
      await sql.query("DELETE FROM sessions WHERE user_id = $1", [target.id]);
      return json(response, 200, { ok: true, username: target.username, temporaryPassword: password });
    }

    if (accountRoute && request.method === "PATCH" && !accountRoute[2]) {
      verifyCsrf(request, user);
      requirePermission(user, "manageAccounts");
      const rows = await sql.query("SELECT id, role_id, active, display_name FROM users WHERE id = $1", [accountRoute[1]]);
      const target = rows[0];
      if (!target || target.role_id === "owner" || target.id === user.id) fail(404, "That staff account could not be changed.");
      const body = readBody(request);
      if (body.active === undefined && body.roleId === undefined && body.displayName === undefined) fail(400, "Choose an account detail to update.");
      const active = body.active === undefined ? target.active : body.active;
      if (typeof active !== "boolean") fail(400, "Choose whether the account should be active.");
      const displayName = body.displayName === undefined ? target.display_name : text(body.displayName, 50);
      if (body.displayName !== undefined && !displayName) fail(400, "Enter a display name.");
      let roleId = target.role_id;
      if (body.roleId !== undefined) {
        const role = await sql.query("SELECT id FROM roles WHERE id = $1", [body.roleId]);
        if (!role.length || body.roleId === "owner") fail(400, "Choose a staff role other than Owner.");
        roleId = body.roleId;
      }
      await sql.query(
        "UPDATE users SET active = $1, role_id = $2, display_name = $3 WHERE id = $4",
        [active, roleId, displayName, target.id]
      );
      if (!active) await sql.query("DELETE FROM sessions WHERE user_id = $1", [target.id]);
      return json(response, 200, { ok: true });
    }

    if (request.method === "POST" && path === "/api/roles") {
      verifyCsrf(request, user);
      requirePermission(user, "manageRoles");
      const body = readBody(request);
      const name = text(body.name, 40);
      if (name.length < 2) fail(400, "Role names must be at least 2 characters.");
      if (!body.permissions || typeof body.permissions !== "object" || Array.isArray(body.permissions)) fail(400, "Select role permissions.");
      const existing = await sql.query("SELECT id FROM roles WHERE lower(name) = lower($1)", [name]);
      if (existing.length) fail(409, "A role with that name already exists.");
      const permissions = Object.fromEntries(PERMISSIONS.map((key) => [key, body.permissions[key] === true]));
      await sql.query("INSERT INTO roles (id, name, permissions, system) VALUES ($1, $2, $3::jsonb, FALSE)", [
        randomUUID(), name, JSON.stringify(permissions)
      ]);
      return json(response, 201, { ok: true });
    }

    const roleRoute = path.match(/^\/api\/roles\/([0-9a-f-]{36})$/i);
    if (roleRoute && request.method === "PATCH") {
      verifyCsrf(request, user);
      requirePermission(user, "manageRoles");
      const existing = await sql.query("SELECT id, system FROM roles WHERE id = $1", [roleRoute[1]]);
      if (!existing.length || existing[0].system) fail(404, "That role cannot be changed.");
      const body = readBody(request);
      const name = text(body.name, 40);
      if (name.length < 2) fail(400, "Role names must be at least 2 characters.");
      if (!body.permissions || typeof body.permissions !== "object" || Array.isArray(body.permissions)) fail(400, "Select role permissions.");
      const duplicate = await sql.query("SELECT id FROM roles WHERE lower(name) = lower($1) AND id <> $2", [name, roleRoute[1]]);
      if (duplicate.length) fail(409, "A role with that name already exists.");
      const permissions = Object.fromEntries(PERMISSIONS.map((key) => [key, body.permissions[key] === true]));
      await sql.query("UPDATE roles SET name = $1, permissions = $2::jsonb WHERE id = $3", [
        name, JSON.stringify(permissions), roleRoute[1]
      ]);
      return json(response, 200, { ok: true });
    }

    if (roleRoute && request.method === "DELETE") {
      verifyCsrf(request, user);
      requirePermission(user, "manageRoles");
      const existing = await sql.query("SELECT id, system FROM roles WHERE id = $1", [roleRoute[1]]);
      if (!existing.length || existing[0].system) fail(404, "That role cannot be deleted.");
      const assigned = await sql.query("SELECT id FROM users WHERE role_id = $1 LIMIT 1", [roleRoute[1]]);
      if (assigned.length) fail(409, "Move staff to another role before deleting this role.");
      await sql.query("DELETE FROM roles WHERE id = $1", [roleRoute[1]]);
      return json(response, 200, { ok: true });
    }

    if (request.method === "POST" && path === "/api/tasks") {
      verifyCsrf(request, user);
      const body = readBody(request);
      const title = text(body.title, 120);
      if (!title) fail(400, "Enter a task title.");
      const description = text(body.description, 2000);
      const assigneeId = can(user, "manageTasks") && typeof body.assigneeId === "string" ? body.assigneeId : user.id;
      const activeAssignee = await sql.query("SELECT id FROM users WHERE id = $1 AND active = TRUE", [assigneeId]);
      if (!activeAssignee.length) fail(400, "Choose an active staff member.");
      const dueDate = body.dueDate || null;
      if (dueDate !== null && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) fail(400, "Choose a valid due date.");
      const now = new Date().toISOString();
      const id = randomUUID();
      await sql.query(
        `INSERT INTO tasks (id, title, description, status, assignee_id, created_by, due_date, canvas_x, canvas_y, created_at, updated_at)
         VALUES ($1, $2, $3, 'todo', $4, $5, $6, $7, $8, $9, $9)`,
        [id, title, description, assigneeId, user.id, dueDate, 60 + Math.random() * 200, 60 + Math.random() * 160, now]
      );
      return json(response, 201, { ok: true, taskId: id });
    }

    const taskRoute = path.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
    if (taskRoute && request.method === "PATCH") {
      verifyCsrf(request, user);
      const body = readBody(request);
      const rows = await sql.query("SELECT * FROM tasks WHERE id = $1", [taskRoute[1]]);
      const task = rows[0];
      if (!task) fail(404, "That task could not be found.");
      const canManage = can(user, "manageTasks");
      if (!canManage && task.assignee_id !== user.id && task.created_by !== user.id) fail(403, "You can only update tasks assigned to you or created by you.");
      const title = body.title === undefined ? task.title : text(body.title, 120);
      if (!title) fail(400, "Task titles cannot be empty.");
      const description = body.description === undefined ? task.description : text(body.description, 2000);
      const status = body.status === undefined ? task.status : body.status;
      if (!TASK_STATUSES.has(status)) fail(400, "Choose a valid task status.");
      let assigneeId = task.assignee_id;
      if (body.assigneeId !== undefined) {
        if (!canManage) fail(403, "You do not have permission to reassign tasks.");
        if (body.assigneeId !== null) {
          const activeAssignee = await sql.query("SELECT id FROM users WHERE id = $1 AND active = TRUE", [body.assigneeId]);
          if (!activeAssignee.length) fail(400, "Choose an active staff member.");
        }
        assigneeId = body.assigneeId;
      }
      let dueDate = task.due_date;
      if (body.dueDate !== undefined) {
        dueDate = body.dueDate || null;
        if (dueDate !== null && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) fail(400, "Choose a valid due date.");
      }
      let canvasX = task.canvas_x;
      let canvasY = task.canvas_y;
      if (body.canvasX !== undefined || body.canvasY !== undefined) {
        if (!can(user, "manageCanvas") && !canManage) fail(403, "You do not have permission to move canvas cards.");
        canvasX = Number(body.canvasX);
        canvasY = Number(body.canvasY);
        if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY) || canvasX < 0 || canvasY < 0 || canvasX > 5000 || canvasY > 5000) fail(400, "Canvas position is outside the allowed area.");
      }
      await sql.query(
        `UPDATE tasks SET title = $1, description = $2, status = $3, assignee_id = $4,
          due_date = $5, canvas_x = $6, canvas_y = $7, updated_at = $8 WHERE id = $9`,
        [title, description, status, assigneeId, dueDate, canvasX, canvasY, new Date().toISOString(), task.id]
      );
      let noticeWarning = null;
      if (status === "done" && task.status !== "done" && assigneeId) {
        const rules = await sql.query("SELECT id, robux_amount FROM automations WHERE active = TRUE AND trigger_event = 'task_completed'");
        const now = new Date().toISOString();
        for (const rule of rules) {
          const run = await sql.query(
            `INSERT INTO automation_runs (id, automation_id, task_id, created_at)
             VALUES ($1, $2, $3, $4) ON CONFLICT (automation_id, task_id) DO NOTHING RETURNING id`,
            [randomUUID(), rule.id, task.id, now]
          );
          if (run.length) {
            await sql.query(
              `INSERT INTO payroll (id, user_id, amount, note, status, created_by, created_at)
               VALUES ($1, $2, $3, 'Automated task-completion reward', 'pending', $4, $5)`,
              [randomUUID(), assigneeId, rule.robux_amount, task.created_by, now]
            );
          }
        }
      }
      if (status === "done" && task.status !== "done" && process.env.DISCORD_WEBHOOK_URL) {
        try {
          const webhookUrl = new URL(process.env.DISCORD_WEBHOOK_URL);
          if (!["discord.com", "discordapp.com"].includes(webhookUrl.hostname) || !webhookUrl.pathname.startsWith("/api/webhooks/")) {
            throw new Error("DISCORD_WEBHOOK_URL must be a Discord webhook URL.");
          }
          const notice = await fetch(webhookUrl, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(5000),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Task completed: ${title} (${task.id})`,
              allowed_mentions: { parse: [] }
            })
          });
          if (!notice.ok) throw new Error(`Discord webhook returned HTTP ${notice.status}.`);
        } catch (error) {
          console.error("Discord notification failed:", error.message);
          noticeWarning = "The change was saved, but the Discord notification could not be delivered.";
        }
      }
      return json(response, 200, { ok: true, noticeWarning });
    }

    if (taskRoute && request.method === "DELETE") {
      verifyCsrf(request, user);
      requirePermission(user, "manageTasks");
      await sql.query("DELETE FROM automation_runs WHERE task_id = $1", [taskRoute[1]]);
      const deleted = await sql.query("DELETE FROM tasks WHERE id = $1 RETURNING id", [taskRoute[1]]);
      if (!deleted.length) fail(404, "That task could not be found.");
      return json(response, 200, { ok: true });
    }

    if (request.method === "POST" && path === "/api/payroll") {
      verifyCsrf(request, user);
      requirePermission(user, "managePayroll");
      const body = readBody(request);
      const target = await sql.query("SELECT id FROM users WHERE id = $1 AND active = TRUE", [body.userId]);
      if (!target.length) fail(400, "Choose an active staff member.");
      validateRobux(body.amount);
      await sql.query(
        `INSERT INTO payroll (id, user_id, amount, note, status, created_by, created_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
        [randomUUID(), body.userId, body.amount, text(body.note, 500), user.id, new Date().toISOString()]
      );
      return json(response, 201, { ok: true });
    }

    const payrollRoute = path.match(/^\/api\/payroll\/([0-9a-f-]{36})$/i);
    if (payrollRoute && request.method === "PATCH") {
      verifyCsrf(request, user);
      requirePermission(user, "managePayroll");
      const body = readBody(request);
      if (!["approved", "rejected", "paid"].includes(body.status)) fail(400, "Choose approved, rejected, or paid.");
      const records = await sql.query("SELECT status FROM payroll WHERE id = $1", [payrollRoute[1]]);
      if (!records.length) fail(404, "That payroll entry could not be found.");
      const allowed = records[0].status === "pending"
        ? ["approved", "rejected"]
        : records[0].status === "approved" ? ["paid"] : [];
      if (!allowed.includes(body.status)) fail(409, "That payroll status change is not allowed.");
      await sql.query("UPDATE payroll SET status = $1 WHERE id = $2", [body.status, payrollRoute[1]]);
      return json(response, 200, { ok: true });
    }

    if (request.method === "POST" && path === "/api/automations") {
      verifyCsrf(request, user);
      requirePermission(user, "manageAutomations");
      const body = readBody(request);
      const name = text(body.name, 80);
      if (!name) fail(400, "Enter an automation name.");
      validateRobux(body.robuxAmount);
      await sql.query(
        `INSERT INTO automations (id, name, trigger_event, robux_amount, active, created_by, created_at)
         VALUES ($1, $2, 'task_completed', $3, TRUE, $4, $5)`,
        [randomUUID(), name, body.robuxAmount, user.id, new Date().toISOString()]
      );
      return json(response, 201, { ok: true });
    }

    const automationRoute = path.match(/^\/api\/automations\/([0-9a-f-]{36})$/i);
    if (automationRoute && request.method === "PATCH") {
      verifyCsrf(request, user);
      requirePermission(user, "manageAutomations");
      const body = readBody(request);
      if (typeof body.active !== "boolean") fail(400, "Choose whether the automation should be active.");
      const rows = await sql.query("UPDATE automations SET active = $1 WHERE id = $2 RETURNING id", [body.active, automationRoute[1]]);
      if (!rows.length) fail(404, "That automation could not be found.");
      return json(response, 200, { ok: true });
    }
    if (automationRoute && request.method === "DELETE") {
      verifyCsrf(request, user);
      requirePermission(user, "manageAutomations");
      await sql.query("DELETE FROM automation_runs WHERE automation_id = $1", [automationRoute[1]]);
      const rows = await sql.query("DELETE FROM automations WHERE id = $1 RETURNING id", [automationRoute[1]]);
      if (!rows.length) fail(404, "That automation could not be found.");
      return json(response, 200, { ok: true });
    }

    if (request.method === "POST" && path === "/api/documents") {
      verifyCsrf(request, user);
      requirePermission(user, "manageDocuments");
      const body = readBody(request);
      const title = text(body.title, 120);
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!title) fail(400, "Enter a document title.");
      if (!content) fail(400, "Enter some document content.");
      if (content.length > 20000) fail(400, "Document content must be 20,000 characters or fewer.");
      const now = new Date().toISOString();
      const id = randomUUID();
      await sql.query(
        "INSERT INTO documents (id, title, content, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
        [id, title, content, user.id, now]
      );
      return json(response, 201, { ok: true, documentId: id });
    }
    const documentRoute = path.match(/^\/api\/documents\/([0-9a-f-]{36})$/i);
    if (documentRoute && request.method === "PATCH") {
      verifyCsrf(request, user);
      requirePermission(user, "manageDocuments");
      const body = readBody(request);
      const title = text(body.title, 120);
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!title) fail(400, "Enter a document title.");
      if (!content) fail(400, "Enter some document content.");
      if (content.length > 20000) fail(400, "Document content must be 20,000 characters or fewer.");
      const rows = await sql.query(
        "UPDATE documents SET title = $1, content = $2, updated_at = $3 WHERE id = $4 RETURNING id",
        [title, content, new Date().toISOString(), documentRoute[1]]
      );
      if (!rows.length) fail(404, "That document could not be found.");
      return json(response, 200, { ok: true });
    }
    if (documentRoute && request.method === "DELETE") {
      verifyCsrf(request, user);
      requirePermission(user, "manageDocuments");
      const rows = await sql.query("DELETE FROM documents WHERE id = $1 RETURNING id", [documentRoute[1]]);
      if (!rows.length) fail(404, "That document could not be found.");
      return json(response, 200, { ok: true });
    }

    if (request.method === "POST" && path === "/api/todo-items") {
      verifyCsrf(request, user);
      requirePermission(user, "manageTasks");
      const body = readBody(request);
      const title = text(body.title, 160);
      if (!title) fail(400, "Enter a to-do item.");
      const id = randomUUID();
      const now = new Date().toISOString();
      await sql.query(
        `INSERT INTO todo_items (id, section, title, description, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'not_done', $5, $6, $6)`,
        [id, text(body.section, 80) || "General", title, text(body.description, 4000), user.id, now]
      );
      return json(response, 201, { ok: true, todoItemId: id });
    }
    if (request.method === "POST" && path === "/api/todo-items/bulk") {
      verifyCsrf(request, user);
      requirePermission(user, "manageTasks");
      const body = readBody(request);
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 300) fail(400, "Import between 1 and 300 to-do items at a time.");
      const items = body.items.map((item) => {
        const title = text(item?.title, 160);
        const section = text(item?.section, 80) || "General";
        const sectionOrder = Number(item?.sectionOrder);
        const itemOrder = Number(item?.itemOrder);
        if (!title) fail(400, "Every imported item needs a title.");
        if (!Number.isSafeInteger(sectionOrder) || sectionOrder < 0 || !Number.isSafeInteger(itemOrder) || itemOrder < 0) fail(400, "The imported section ordering is invalid.");
        return { title, section, sectionOrder, itemOrder };
      });
      const parameters = [];
      const rowsSql = items.map((item, index) => {
        const offset = index * 8;
        const now = new Date().toISOString();
        parameters.push(
          randomUUID(), item.section, item.sectionOrder, item.itemOrder, item.title,
          text(body.items[index].description, 4000), user.id, now
        );
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, 'not_done', $${offset + 7}, $${offset + 8}, $${offset + 8})`;
      });
      await sql.query(
        `INSERT INTO todo_items (id, section, section_order, item_order, title, description, status, created_by, created_at, updated_at)
         VALUES ${rowsSql.join(", ")}`,
        parameters
      );
      return json(response, 201, { ok: true, count: items.length });
    }
    const todoRoute = path.match(/^\/api\/todo-items\/([0-9a-f-]{36})$/i);
    if (todoRoute && request.method === "PATCH") {
      verifyCsrf(request, user);
      const body = readBody(request);
      const rows = await sql.query("SELECT id, section, title, description FROM todo_items WHERE id = $1", [todoRoute[1]]);
      const item = rows[0];
      if (!item) fail(404, "That to-do item could not be found.");
      if (!TODO_STATUSES.has(body.status)) fail(400, "Choose Not done, In progress, or Done.");
      let { section, title, description } = item;
      if (body.title !== undefined || body.description !== undefined || body.section !== undefined) {
        requirePermission(user, "manageTasks");
        section = text(body.section, 80) || "General";
        title = text(body.title, 160);
        description = text(body.description, 4000);
        if (!title) fail(400, "Enter a to-do item.");
      }
      await sql.query(
        "UPDATE todo_items SET section = $1, title = $2, description = $3, status = $4, updated_at = $5 WHERE id = $6",
        [section, title, description, body.status, new Date().toISOString(), item.id]
      );
      return json(response, 200, { ok: true });
    }
    if (todoRoute && request.method === "DELETE") {
      verifyCsrf(request, user);
      requirePermission(user, "manageTasks");
      const rows = await sql.query("DELETE FROM todo_items WHERE id = $1 RETURNING id", [todoRoute[1]]);
      if (!rows.length) fail(404, "That to-do item could not be found.");
      return json(response, 200, { ok: true });
    }

    return json(response, 404, { error: "That portal API route was not found." });
  } catch (error) {
    if (error.status) return json(response, error.status, { error: error.message });
    console.error("Vercel portal API error:", error);
    const message = error.message.includes("DATABASE_URL") || error.message.includes("bootstrap")
      ? error.message
      : "The portal API could not complete this request. Check the Vercel function logs.";
    return json(response, 503, { error: message });
  }
}

module.exports = async function portalApi(request, response) {
  try {
    await handle(request, response);
  } catch (error) {
    console.error("Vercel portal handler failed:", error);
    return json(response, 500, { error: "The portal API encountered an unexpected error." });
  }
};
