const { createHash, randomBytes, scrypt: scryptCallback, timingSafeEqual, randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const { createServer } = require("node:http");
const { readFile, mkdir, stat } = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  authorizationUrl,
  createPkcePair,
  exchangeCode,
  fetchIdentity,
  fetchIdentityAndGuilds,
  readConfig,
  snowflakeCreatedAt
} = require("./discord-oauth");

const scrypt = promisify(scryptCallback);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, "portal.sqlite"));
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_BODY_BYTES = 96 * 1024;
const PASSWORD_MIN_LENGTH = 12;
const TASK_STATUSES = new Set(["todo", "in_progress", "done"]);
const TODO_ITEM_STATUSES = new Set(["not_done", "in_progress", "done"]);
const PERMISSIONS = new Set([
  "manageAccounts",
  "manageRoles",
  "manageTasks",
  "managePayroll",
  "viewAllPayroll",
  "manageAutomations",
  "manageCanvas",
  "manageDocuments"
]);

process.umask(0o077);

let db;

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function inTransaction(operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
    ...headers
  });
  res.end(body);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function readJson(req) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    fail(415, "Send this request as JSON.");
  }

  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
      fail(413, "Request is too large.");
    }
  }

  try {
    return JSON.parse(data || "{}");
  } catch {
    fail(400, "The request body is not valid JSON.");
  }
}

function sessionCookie(token, maxAge = SESSION_TTL_MS / 1000) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `ce_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function requestToken(req) {
  const cookie = (req.headers.cookie || "").split(";").map((part) => part.trim());
  const sessionCookieValue = cookie.find((part) => part.startsWith("ce_session="));
  return sessionCookieValue ? sessionCookieValue.slice("ce_session=".length) : "";
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    fail(403, "This request did not come from the portal.");
  }
  const trustedOrigin = process.env.TRUSTED_ORIGIN;
  if (trustedOrigin) {
    let trusted;
    try {
      trusted = new URL(trustedOrigin);
    } catch {
      throw new Error("TRUSTED_ORIGIN must be a valid origin URL.");
    }
    if (parsed.origin === trusted.origin) return;
  }
  if (parsed.host !== req.headers.host) {
    fail(403, "This request did not come from the portal.");
  }
}

async function passwordHash(password) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

async function verifyPassword(password, storedHash) {
  const [algorithm, salt, expected] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const actual = await scrypt(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function rolePermissions(role) {
  try {
    return JSON.parse(role.permissions);
  } catch {
    return {};
  }
}

function hasPermission(user, permission) {
  return user.roleId === "owner" || user.permissions?.[permission] === true;
}

function requireUser(user) {
  if (!user) fail(401, "Please log in to continue.");
  if (!user.active) fail(403, "This account is disabled. Contact an administrator.");
}

function requirePermission(user, permission) {
  requireUser(user);
  if (!hasPermission(user, permission)) fail(403, "You do not have permission to do that.");
}

function requireDiscordLinked(user, pathName) {
  if (!user.discordId && pathName !== "/api/discord/authorize" && pathName !== "/api/password") {
    fail(428, "Connect your Discord account before using the workspace.");
  }
}

function currentUser(req) {
  const token = requestToken(req);
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.csrf_token, s.expires_at, u.id, u.username, u.display_name, u.role_id,
           u.discord_id,
           u.active, u.must_change_password, r.name AS role_name, r.permissions
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN roles r ON r.id = u.role_id
    WHERE s.token_hash = ?
  `).get(hashToken(token));
  if (!row || row.expires_at < Date.now()) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleId: row.role_id,
    roleName: row.role_name,
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.must_change_password),
    discordId: row.discord_id,
    permissions: rolePermissions(row),
    csrfToken: row.csrf_token
  };
}

function checkCsrf(req, user) {
  checkOrigin(req);
  const supplied = req.headers["x-csrf-token"];
  if (!user || typeof supplied !== "string" || supplied !== user.csrfToken) {
    fail(403, "Your session has expired. Refresh the page and try again.");
  }
}

function normalizeText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function randomTemporaryPassword() {
  return randomBytes(18).toString("base64url");
}

function accountById(id) {
  return db.prepare("SELECT id, username, display_name, role_id, active FROM users WHERE id = ?").get(id);
}

function listStaff(activeOnly = true) {
  const query = activeOnly ? `
    SELECT u.id, u.username, u.display_name AS displayName, u.role_id AS roleId,
           r.name AS roleName, u.active, u.discord_id IS NOT NULL AS discordLinked
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.active = 1
    ORDER BY r.name, u.display_name
  ` : `
    SELECT u.id, u.username, u.display_name AS displayName, u.role_id AS roleId,
           r.name AS roleName, u.active, u.discord_id IS NOT NULL AS discordLinked
    FROM users u JOIN roles r ON r.id = u.role_id
    ORDER BY r.name, u.display_name
  `;
  return db.prepare(query).all().map((row) => ({
    ...row,
    active: Boolean(row.active),
    discordLinked: Boolean(row.discordLinked)
  }));
}

function staffOverview(user, staffId) {
  requirePermission(user, "manageAccounts");
  const target = db.prepare(`
    SELECT u.id, u.username, u.display_name AS displayName, u.role_id AS roleId,
           r.name AS roleName, u.active, u.created_at AS createdAt,
           u.discord_id AS discordId, u.discord_username AS discordUsername,
           u.discord_avatar AS discordAvatar, u.discord_linked_at AS discordLinkedAt,
           u.discord_guilds AS discordGuilds
    FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?
  `).get(staffId);
  if (!target) fail(404, "That staff account could not be found.");
  let guilds = [];
  try {
    guilds = JSON.parse(target.discordGuilds || "[]");
  } catch {
    guilds = [];
  }
  const tasks = db.prepare(`
    SELECT id, title, description, status, due_date AS dueDate, created_at AS createdAt
    FROM tasks WHERE assignee_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(staffId);
  const payroll = hasPermission(user, "managePayroll") || hasPermission(user, "viewAllPayroll")
    ? db.prepare(`
      SELECT id, amount, note, status, created_at AS createdAt
      FROM payroll WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(staffId)
    : [];
  const documents = db.prepare(`
    SELECT id, title, content, created_at AS createdAt, updated_at AS updatedAt
    FROM documents WHERE created_by = ? ORDER BY updated_at DESC LIMIT 100
  `).all(staffId);
  return {
    canViewPayroll: hasPermission(user, "managePayroll") || hasPermission(user, "viewAllPayroll"),
    staff: {
      id: target.id,
      username: target.username,
      displayName: target.displayName,
      roleName: target.roleName,
      active: Boolean(target.active),
      createdAt: target.createdAt
    },
    discord: target.discordId ? {
      id: target.discordId,
      username: target.discordUsername,
      avatar: target.discordAvatar,
      linkedAt: target.discordLinkedAt,
      accountCreatedAt: snowflakeCreatedAt(target.discordId),
      guilds
    } : null,
    tasks,
    payroll,
    documents
  };
}

function listTasks() {
  return db.prepare(`
    SELECT t.id, t.title, t.description, t.status, t.assignee_id AS assigneeId,
           a.display_name AS assigneeName, t.created_by AS createdBy,
           t.due_date AS dueDate, t.canvas_x AS canvasX, t.canvas_y AS canvasY,
           t.created_at AS createdAt, t.updated_at AS updatedAt
    FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id
    ORDER BY t.created_at DESC
  `).all();
}

function listPayroll(user) {
  const canSeeAll = hasPermission(user, "viewAllPayroll") || hasPermission(user, "managePayroll");
  const rows = canSeeAll
    ? db.prepare(`
      SELECT p.id, p.user_id AS userId, u.display_name AS displayName,
             p.amount, p.note, p.status, p.created_by AS createdBy,
             p.created_at AS createdAt
      FROM payroll p JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC
    `).all()
    : db.prepare(`
      SELECT p.id, p.user_id AS userId, u.display_name AS displayName,
             p.amount, p.note, p.status, p.created_by AS createdBy,
             p.created_at AS createdAt
      FROM payroll p JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ?
      ORDER BY p.created_at DESC
    `).all(user.id);
  return rows;
}

function listRoles() {
  return db.prepare("SELECT id, name, permissions, system FROM roles ORDER BY name")
    .all()
    .map((role) => ({
      id: role.id,
      name: role.name,
      permissions: rolePermissions(role),
      system: Boolean(role.system)
    }));
}

function listAutomations() {
  return db.prepare(`
    SELECT id, name, trigger_event AS trigger, robux_amount AS robuxAmount,
           active, created_at AS createdAt
    FROM automations ORDER BY created_at DESC
  `).all().map((row) => ({ ...row, active: Boolean(row.active) }));
}

function listDocuments() {
  return db.prepare(`
    SELECT d.id, d.title, d.content, d.created_by AS createdBy,
           u.display_name AS authorName, d.created_at AS createdAt,
           d.updated_at AS updatedAt
    FROM documents d JOIN users u ON u.id = d.created_by
    ORDER BY d.updated_at DESC
  `).all();
}

function listTodoItems() {
  return db.prepare(`
    SELECT t.id, t.section, t.section_order AS sectionOrder,
           t.item_order AS itemOrder, t.title, t.description, t.status,
           t.created_by AS createdBy,
           u.display_name AS authorName, t.created_at AS createdAt,
           t.updated_at AS updatedAt
    FROM todo_items t JOIN users u ON u.id = t.created_by
    ORDER BY t.section_order, t.item_order,
             CASE t.status WHEN 'not_done' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
             t.updated_at DESC
  `).all();
}

function buildBootstrapDb() {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      permissions TEXT NOT NULL,
      system INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role_id TEXT NOT NULL REFERENCES roles(id),
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      discord_id TEXT,
      discord_username TEXT,
      discord_avatar TEXT,
      discord_linked_at TEXT,
      discord_guilds TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS discord_oauth_states (
      state_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      code_verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discord_login_states (
      state_hash TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done')),
      assignee_id TEXT REFERENCES users(id),
      created_by TEXT NOT NULL REFERENCES users(id),
      due_date TEXT,
      canvas_x REAL NOT NULL DEFAULT 60,
      canvas_y REAL NOT NULL DEFAULT 60,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payroll (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL CHECK(amount > 0),
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trigger_event TEXT NOT NULL CHECK(trigger_event = 'task_completed'),
      robux_amount INTEGER NOT NULL CHECK(robux_amount > 0),
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      created_at TEXT NOT NULL,
      UNIQUE(automation_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS documents_updated_idx ON documents(updated_at DESC);
    CREATE TABLE IF NOT EXISTS todo_items (
      id TEXT PRIMARY KEY,
      section TEXT NOT NULL DEFAULT 'General',
      section_order INTEGER NOT NULL DEFAULT 0,
      item_order INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'not_done' CHECK(status IN ('not_done','in_progress','done')),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS todo_items_status_updated_idx ON todo_items(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip_hash TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  if (!userColumns.has("discord_id")) db.exec("ALTER TABLE users ADD COLUMN discord_id TEXT");
  if (!userColumns.has("discord_username")) db.exec("ALTER TABLE users ADD COLUMN discord_username TEXT");
  if (!userColumns.has("discord_avatar")) db.exec("ALTER TABLE users ADD COLUMN discord_avatar TEXT");
  if (!userColumns.has("discord_linked_at")) db.exec("ALTER TABLE users ADD COLUMN discord_linked_at TEXT");
  if (!userColumns.has("discord_guilds")) db.exec("ALTER TABLE users ADD COLUMN discord_guilds TEXT NOT NULL DEFAULT '[]'");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id_unique_idx ON users(discord_id) WHERE discord_id IS NOT NULL");
  const todoColumns = new Set(db.prepare("PRAGMA table_info(todo_items)").all().map((column) => column.name));
  if (!todoColumns.has("section")) {
    db.exec("ALTER TABLE todo_items ADD COLUMN section TEXT NOT NULL DEFAULT 'General'");
  }
  if (!todoColumns.has("section_order")) {
    db.exec("ALTER TABLE todo_items ADD COLUMN section_order INTEGER NOT NULL DEFAULT 0");
  }
  if (!todoColumns.has("item_order")) {
    db.exec("ALTER TABLE todo_items ADD COLUMN item_order INTEGER NOT NULL DEFAULT 0");
  }

  const roles = [
    { id: "owner", name: "Owner", permissions: {}, system: 1 },
    {
      id: "hr",
      name: "HR",
      permissions: {
        manageAccounts: true,
        manageTasks: true,
        managePayroll: true,
        viewAllPayroll: true,
        manageAutomations: true,
        manageCanvas: true,
        manageDocuments: true
      },
      system: 0
    },
    { id: "developer", name: "Developer", permissions: {}, system: 0 }
  ];
  const insertRole = db.prepare("INSERT OR IGNORE INTO roles (id, name, permissions, system) VALUES (?, ?, ?, ?)");
  for (const role of roles) {
    insertRole.run(role.id, role.name, JSON.stringify(role.permissions), role.system);
  }
  const hrRole = db.prepare("SELECT permissions FROM roles WHERE id = 'hr'").get();
  if (hrRole) {
    const hrPermissions = rolePermissions(hrRole);
    if (!Object.hasOwn(hrPermissions, "manageDocuments")) {
      hrPermissions.manageDocuments = true;
      db.prepare("UPDATE roles SET permissions = ? WHERE id = 'hr'")
        .run(JSON.stringify(hrPermissions));
    }
  }
}

async function ensureOwner() {
  const owner = db.prepare("SELECT id FROM users WHERE role_id = 'owner' LIMIT 1").get();
  if (owner) return;

  const existingUser = db.prepare("SELECT id FROM users LIMIT 1").get();
  const username = normalizeText(process.env.BOOTSTRAP_OWNER_USERNAME, 24);
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD || "";
  if (existingUser) {
    throw new Error("No Owner account exists. Set BOOTSTRAP_OWNER_USERNAME and BOOTSTRAP_OWNER_PASSWORD to recover access.");
  }
  if (!/^[a-zA-Z0-9._-]{3,24}$/.test(username)) {
    throw new Error("On first run, set BOOTSTRAP_OWNER_USERNAME (3-24 letters, numbers, dots, underscores, or hyphens).");
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`On first run, set BOOTSTRAP_OWNER_PASSWORD to a password with at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role_id, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, 'owner', 1, 0, ?)
  `).run(id, username, "Cartel Empire Owner", await passwordHash(password), new Date().toISOString());
  console.log(`Created the initial Owner account "${username}".`);
}

function loginAttemptKey(req, username) {
  return hashToken(`${req.socket.remoteAddress || "unknown"}:${username}`);
}

function checkLoginLimit(req, username) {
  const key = loginAttemptKey(req, username);
  const row = db.prepare("SELECT window_started_at, attempt_count FROM login_attempts WHERE ip_hash = ?").get(key);
  const now = Date.now();
  if (row && now - row.window_started_at < 15 * 60 * 1000 && row.attempt_count >= 10) {
    fail(429, "Too many sign-in attempts. Wait 15 minutes before trying again.");
  }
  if (row && now - row.window_started_at >= 15 * 60 * 1000) {
    db.prepare("DELETE FROM login_attempts WHERE ip_hash = ?").run(key);
  }
}

function recordFailedLogin(req, username) {
  const key = loginAttemptKey(req, username);
  const now = Date.now();
  const row = db.prepare("SELECT window_started_at, attempt_count FROM login_attempts WHERE ip_hash = ?").get(key);
  if (!row || now - row.window_started_at >= 15 * 60 * 1000) {
    db.prepare(`
      INSERT INTO login_attempts (ip_hash, window_started_at, attempt_count) VALUES (?, ?, 1)
      ON CONFLICT(ip_hash) DO UPDATE SET window_started_at = excluded.window_started_at, attempt_count = 1
    `).run(key, now);
  } else {
    db.prepare("UPDATE login_attempts SET attempt_count = attempt_count + 1 WHERE ip_hash = ?").run(key);
  }
}

function clearLoginFailures(req, username) {
  db.prepare("DELETE FROM login_attempts WHERE ip_hash = ?").run(loginAttemptKey(req, username));
}

function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare("INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), userId, csrfToken, expiresAt);
  return { token, csrfToken };
}

function validateUsername(username) {
  if (!/^[a-zA-Z0-9._-]{3,24}$/.test(username)) fail(400, "Usernames must be 3-24 characters: letters, numbers, dots, underscores, or hyphens.");
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > 200) {
    fail(400, `Passwords must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
}

function validateRobux(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    fail(400, "Enter a whole-number Robux amount between 1 and 10,000,000.");
  }
}

async function sendDiscordNotice(message) {
  const endpoint = process.env.DISCORD_WEBHOOK_URL;
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (!["discord.com", "discordapp.com"].includes(url.hostname) || !url.pathname.startsWith("/api/webhooks/")) {
    throw new Error("DISCORD_WEBHOOK_URL must be a Discord webhook URL.");
  }
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } })
  });
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}.`);
  return null;
}

function maybeNotifyDiscord(message) {
  if (!process.env.DISCORD_WEBHOOK_URL) return Promise.resolve(null);
  return sendDiscordNotice(message).catch((error) => {
    console.error("Discord notification failed:", error.message);
    return "The change was saved, but the Discord notification could not be delivered.";
  });
}

function createAutomationPayroll(taskId, assigneeId, createdBy) {
  if (!assigneeId) return;
  const automations = db.prepare(`
    SELECT id, robux_amount FROM automations
    WHERE active = 1 AND trigger_event = 'task_completed'
  `).all();
  const createRun = db.prepare(`
    INSERT OR IGNORE INTO automation_runs (id, automation_id, task_id, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const createPayroll = db.prepare(`
    INSERT INTO payroll (id, user_id, amount, note, status, created_by, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `);
  const now = new Date().toISOString();
  for (const automation of automations) {
    const result = createRun.run(randomUUID(), automation.id, taskId, now);
    if (result.changes) {
      createPayroll.run(
        randomUUID(),
        assigneeId,
        automation.robux_amount,
        "Automated task-completion reward",
        createdBy,
        now
      );
    }
  }
}

function requirePasswordChangeDone(user, pathName) {
  if (user.mustChangePassword && pathName !== "/api/password" && pathName !== "/api/logout" && pathName !== "/api/me") {
    fail(428, "Change your temporary password before using the portal.");
  }
}

function redirectResponse(res, location, headers = {}) {
  res.writeHead(303, {
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    ...headers
  });
  res.end();
}

function discordResultUrl(config, result) {
  const destination = new URL("/", config.redirectUri);
  destination.searchParams.set("discord", result);
  return destination.toString();
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    checkOrigin(req);
  }

  if (route === "POST /api/login") {
    const body = await readJson(req);
    const username = normalizeText(body.username, 80).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    checkLoginLimit(req, username);
    const user = db.prepare(`
      SELECT id, password_hash, active, must_change_password FROM users
      WHERE username = ? COLLATE NOCASE
    `).get(username);
    if (!user || !user.active || password.length > 200 || !(await verifyPassword(password, user.password_hash))) {
      recordFailedLogin(req, username);
      fail(401, "The username or password was not recognized.");
    }

    clearLoginFailures(req, username);
    const session = createSession(user.id);
    json(res, 200, { ok: true, mustChangePassword: Boolean(user.must_change_password) }, {
      "Set-Cookie": sessionCookie(session.token)
    });
    return;
  }

  if (route === "GET /api/discord/login") {
    const config = readConfig();
    const state = randomBytes(32).toString("base64url");
    const { verifier, challenge } = createPkcePair();
    db.prepare("DELETE FROM discord_login_states WHERE expires_at <= ?").run(Date.now());
    db.prepare(`
      INSERT INTO discord_login_states (state_hash, code_verifier, expires_at)
      VALUES (?, ?, ?)
    `).run(hashToken(state), verifier, Date.now() + 10 * 60 * 1000);
    return redirectResponse(res, authorizationUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state,
      challenge,
      scope: "identify"
    }));
  }

  if (route === "GET /api/me") {
    const user = currentUser(req);
    requireUser(user);
    json(res, 200, {
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
    return;
  }

  if (route === "GET /api/discord/callback") {
    const config = readConfig();
    const callbackUrl = (result) => discordResultUrl(config, result);
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    if (!state) return redirectResponse(res, callbackUrl("invalid"));
    const stateHash = hashToken(state);
    const loginState = db.prepare(`
      SELECT code_verifier AS codeVerifier, expires_at AS expiresAt
      FROM discord_login_states WHERE state_hash = ?
    `).get(stateHash);
    if (loginState) {
      db.prepare("DELETE FROM discord_login_states WHERE state_hash = ?").run(stateHash);
      if (loginState.expiresAt < Date.now()) return redirectResponse(res, callbackUrl("login-expired"));
      if (url.searchParams.has("error") || !code) return redirectResponse(res, callbackUrl("login-cancelled"));
      try {
        const accessToken = await exchangeCode(config, code, loginState.codeVerifier);
        const discord = await fetchIdentity(accessToken);
        const linkedAccount = db.prepare(`
          SELECT id, active, must_change_password AS mustChangePassword
          FROM users WHERE discord_id = ?
        `).get(discord.id);
        if (!linkedAccount) return redirectResponse(res, callbackUrl("login-not-linked"));
        if (!linkedAccount.active) return redirectResponse(res, callbackUrl("login-disabled"));
        if (linkedAccount.mustChangePassword) return redirectResponse(res, callbackUrl("login-password-required"));
        const session = createSession(linkedAccount.id);
        return redirectResponse(res, callbackUrl("login"), {
          "Set-Cookie": sessionCookie(session.token)
        });
      } catch (error) {
        console.error("Discord login failed:", error);
        return redirectResponse(res, callbackUrl("login-failed"));
      }
    }
    const oauthState = db.prepare(`
      SELECT o.user_id AS userId, o.code_verifier AS codeVerifier, o.expires_at AS expiresAt
      FROM discord_oauth_states o
      JOIN sessions s ON s.token_hash = o.session_hash
      JOIN users u ON u.id = o.user_id
      WHERE o.state_hash = ? AND s.user_id = o.user_id
        AND s.expires_at > ? AND u.active = 1
    `).get(stateHash, Date.now());
    db.prepare("DELETE FROM discord_oauth_states WHERE state_hash = ?").run(stateHash);
    if (!oauthState || oauthState.expiresAt < Date.now()) {
      return redirectResponse(res, callbackUrl("expired"));
    }
    if (url.searchParams.has("error") || !code) return redirectResponse(res, callbackUrl("cancelled"));
    try {
      const accessToken = await exchangeCode(config, code, oauthState.codeVerifier);
      const discord = await fetchIdentityAndGuilds(accessToken);
      const update = db.prepare(`
        UPDATE users SET discord_id = ?, discord_username = ?, discord_avatar = ?,
          discord_linked_at = ?, discord_guilds = ?
        WHERE id = ? AND active = 1 AND must_change_password = 0
      `).run(
        discord.id,
        discord.username,
        discord.avatar,
        new Date().toISOString(),
        JSON.stringify(discord.guilds),
        oauthState.userId
      );
      if (!update.changes) return redirectResponse(res, callbackUrl("expired"));
      return redirectResponse(res, callbackUrl("linked"));
    } catch (error) {
      if (String(error.code || "").startsWith("ERR_SQLITE_CONSTRAINT")) {
        return redirectResponse(res, callbackUrl("already-linked"));
      }
      console.error("Discord OAuth callback failed:", error);
      return redirectResponse(res, callbackUrl("failed"));
    }
  }

  if (route === "POST /api/logout") {
    const user = currentUser(req);
    if (user) checkCsrf(req, user);
    const token = requestToken(req);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
    return;
  }

  const user = currentUser(req);
  requireUser(user);
  requirePasswordChangeDone(user, url.pathname);
  requireDiscordLinked(user, url.pathname);

  if (route === "GET /api/discord/authorize") {
    const config = readConfig();
    const sessionToken = requestToken(req);
    const state = randomBytes(32).toString("base64url");
    const { verifier, challenge } = createPkcePair();
    db.prepare("DELETE FROM discord_oauth_states WHERE expires_at <= ?").run(Date.now());
    db.prepare(`
      INSERT INTO discord_oauth_states (state_hash, user_id, session_hash, code_verifier, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hashToken(state), user.id, hashToken(sessionToken), verifier, Date.now() + 10 * 60 * 1000);
    return redirectResponse(res, authorizationUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state,
      challenge
    }));
  }

  if (route === "POST /api/password") {
    checkCsrf(req, user);
    const body = await readJson(req);
    if (typeof body.currentPassword !== "string" || !(await verifyPassword(body.currentPassword, db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id).password_hash))) {
      fail(400, "The current password is incorrect.");
    }
    validatePassword(body.newPassword);
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
      .run(await passwordHash(body.newPassword), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(user.id, hashToken(requestToken(req)));
    json(res, 200, { ok: true });
    return;
  }

  if (route === "GET /api/board") {
    const roles = listRoles();
    const staff = hasPermission(user, "manageAccounts")
      ? listStaff(false)
      : listStaff().map(({ id, displayName, roleName }) => ({ id, displayName, roleName }));
    json(res, 200, {
      tasks: listTasks(),
      staff,
      roles,
      payroll: listPayroll(user),
      automations: hasPermission(user, "manageAutomations") ? listAutomations() : [],
      documents: listDocuments(),
      todoItems: listTodoItems()
    });
    return;
  }

  if (route === "POST /api/todo-items") {
    checkCsrf(req, user);
    requirePermission(user, "manageTasks");
    const body = await readJson(req);
    const title = normalizeText(body.title, 160);
    const description = normalizeText(body.description, 4000);
    const section = normalizeText(body.section, 80) || "General";
    if (!title) fail(400, "Enter a to-do item.");
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO todo_items (id, section, title, description, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'not_done', ?, ?, ?)
    `).run(id, section, title, description, user.id, now, now);
    json(res, 201, { ok: true, todoItemId: id });
    return;
  }

  if (route === "POST /api/todo-items/bulk") {
    checkCsrf(req, user);
    requirePermission(user, "manageTasks");
    const body = await readJson(req);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 300) {
      fail(400, "Import between 1 and 300 to-do items at a time.");
    }
    const items = body.items.map((item) => {
      const title = normalizeText(item?.title, 160);
      const section = normalizeText(item?.section, 80) || "General";
      const description = normalizeText(item?.description, 4000);
      const sectionOrder = Number(item?.sectionOrder);
      const itemOrder = Number(item?.itemOrder);
      if (!title) fail(400, "Every imported item needs a title.");
      if (!Number.isSafeInteger(sectionOrder) || sectionOrder < 0 || !Number.isSafeInteger(itemOrder) || itemOrder < 0) {
        fail(400, "The imported section ordering is invalid.");
      }
      return { title, section, description, sectionOrder, itemOrder };
    });
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO todo_items (
        id, section, section_order, item_order, title, description,
        status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'not_done', ?, ?, ?)
    `);
    inTransaction(() => {
      for (const item of items) {
        insert.run(
          randomUUID(), item.section, item.sectionOrder, item.itemOrder,
          item.title, item.description, user.id, now, now
        );
      }
    });
    json(res, 201, { ok: true, count: items.length });
    return;
  }

  const todoItemRoute = url.pathname.match(/^\/api\/todo-items\/([0-9a-f-]{36})$/i);
  if (todoItemRoute && req.method === "PATCH") {
    checkCsrf(req, user);
    const item = db.prepare("SELECT id, section, title, description FROM todo_items WHERE id = ?").get(todoItemRoute[1]);
    if (!item) fail(404, "That to-do item could not be found.");
    const body = await readJson(req);
    const status = body.status;
    if (!TODO_ITEM_STATUSES.has(status)) fail(400, "Choose Not done, In progress, or Done.");
    let title = item.title;
    let section = item.section;
    let description = item.description;
    if (body.title !== undefined || body.description !== undefined || body.section !== undefined) {
      requirePermission(user, "manageTasks");
      title = normalizeText(body.title, 160);
      section = normalizeText(body.section, 80) || "General";
      description = normalizeText(body.description, 4000);
      if (!title) fail(400, "Enter a to-do item.");
    }
    db.prepare("UPDATE todo_items SET section = ?, title = ?, description = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(section, title, description, status, new Date().toISOString(), item.id);
    json(res, 200, { ok: true });
    return;
  }

  if (todoItemRoute && req.method === "DELETE") {
    checkCsrf(req, user);
    requirePermission(user, "manageTasks");
    const result = db.prepare("DELETE FROM todo_items WHERE id = ?").run(todoItemRoute[1]);
    if (!result.changes) fail(404, "That to-do item could not be found.");
    json(res, 200, { ok: true });
    return;
  }

  if (route === "POST /api/documents") {
    checkCsrf(req, user);
    requirePermission(user, "manageDocuments");
    const body = await readJson(req);
    const title = normalizeText(body.title, 120);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!title) fail(400, "Enter a document title.");
    if (!content) fail(400, "Enter some document content.");
    if (content.length > 20000) fail(400, "Document content must be 20,000 characters or fewer.");
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO documents (id, title, content, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, title, content, user.id, now, now);
    json(res, 201, { ok: true, documentId: id });
    return;
  }

  const documentRoute = url.pathname.match(/^\/api\/documents\/([0-9a-f-]{36})$/i);
  if (documentRoute && req.method === "PATCH") {
    checkCsrf(req, user);
    requirePermission(user, "manageDocuments");
    const existing = db.prepare("SELECT id FROM documents WHERE id = ?").get(documentRoute[1]);
    if (!existing) fail(404, "That document could not be found.");
    const body = await readJson(req);
    const title = normalizeText(body.title, 120);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!title) fail(400, "Enter a document title.");
    if (!content) fail(400, "Enter some document content.");
    if (content.length > 20000) fail(400, "Document content must be 20,000 characters or fewer.");
    db.prepare("UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ?")
      .run(title, content, new Date().toISOString(), existing.id);
    json(res, 200, { ok: true });
    return;
  }

  if (documentRoute && req.method === "DELETE") {
    checkCsrf(req, user);
    requirePermission(user, "manageDocuments");
    const result = db.prepare("DELETE FROM documents WHERE id = ?").run(documentRoute[1]);
    if (!result.changes) fail(404, "That document could not be found.");
    json(res, 200, { ok: true });
    return;
  }

  if (route === "POST /api/accounts") {
    checkCsrf(req, user);
    requirePermission(user, "manageAccounts");
    const body = await readJson(req);
    const username = normalizeText(body.username, 24);
    validateUsername(username);
    const displayName = normalizeText(body.displayName, 50);
    if (!displayName) fail(400, "Enter a display name.");
    const role = db.prepare("SELECT id, name FROM roles WHERE id = ?").get(body.roleId);
    if (!role || role.id === "owner") fail(400, "Choose a staff role other than Owner.");
    const temporaryPassword = randomTemporaryPassword();
    try {
      db.prepare(`
        INSERT INTO users (id, username, display_name, password_hash, role_id, active, must_change_password, created_at)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?)
      `).run(randomUUID(), username, displayName, await passwordHash(temporaryPassword), role.id, new Date().toISOString());
    } catch (error) {
      if (error.errcode === 2067) fail(409, "That username is already in use.");
      throw error;
    }
    json(res, 201, { ok: true, username, temporaryPassword });
    return;
  }

  const accountMenuRoute = url.pathname.match(/^\/api\/accounts\/([0-9a-f-]{36})\/menu$/i);
  if (accountMenuRoute && req.method === "GET") {
    json(res, 200, staffOverview(user, accountMenuRoute[1]));
    return;
  }

  const unlinkDiscordRoute = url.pathname.match(/^\/api\/accounts\/([0-9a-f-]{36})\/unlink-discord$/i);
  if (unlinkDiscordRoute && req.method === "POST") {
    checkCsrf(req, user);
    requirePermission(user, "manageAccounts");
    const target = accountById(unlinkDiscordRoute[1]);
    if (!target || target.role_id === "owner" || target.id === user.id) {
      fail(404, "That staff account cannot be unlinked.");
    }
    db.prepare(`
      UPDATE users SET discord_id = NULL, discord_username = NULL, discord_avatar = NULL,
        discord_linked_at = NULL, discord_guilds = '[]' WHERE id = ?
    `).run(target.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    json(res, 200, { ok: true });
    return;
  }

  const accountRoute = url.pathname.match(/^\/api\/accounts\/([0-9a-f-]{36})(?:\/(reset-password))?$/i);
  if (accountRoute && req.method === "POST" && accountRoute[2] === "reset-password") {
    checkCsrf(req, user);
    requirePermission(user, "manageAccounts");
    const target = accountById(accountRoute[1]);
    if (!target || target.role_id === "owner") fail(404, "That staff account could not be found.");
    if (target.id === user.id) fail(400, "Ask another administrator to reset your own account.");
    const temporaryPassword = randomTemporaryPassword();
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?")
      .run(await passwordHash(temporaryPassword), target.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    json(res, 200, { ok: true, username: target.username, temporaryPassword });
    return;
  }

  if (accountRoute && req.method === "PATCH" && !accountRoute[2]) {
    checkCsrf(req, user);
    requirePermission(user, "manageAccounts");
    const target = accountById(accountRoute[1]);
    if (!target || target.role_id === "owner" || target.id === user.id) fail(404, "That staff account could not be changed.");
    const body = await readJson(req);
    if (body.active === undefined && body.roleId === undefined && body.displayName === undefined) fail(400, "Choose an account detail to update.");
    const active = body.active === undefined ? Boolean(target.active) : body.active;
    if (typeof active !== "boolean") fail(400, "Choose whether the account should be active.");
    const displayName = body.displayName === undefined ? target.display_name : normalizeText(body.displayName, 50);
    if (body.displayName !== undefined && !displayName) fail(400, "Enter a display name.");
    let roleId = target.role_id;
    if (body.roleId !== undefined) {
      const role = db.prepare("SELECT id FROM roles WHERE id = ?").get(body.roleId);
      if (!role || role.id === "owner") fail(400, "Choose a staff role other than Owner.");
      roleId = role.id;
    }
    db.prepare("UPDATE users SET active = ?, role_id = ?, display_name = ? WHERE id = ?")
      .run(Number(active), roleId, displayName, target.id);
    if (!active) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    json(res, 200, { ok: true });
    return;
  }

  if (route === "POST /api/roles") {
    checkCsrf(req, user);
    requirePermission(user, "manageRoles");
    const body = await readJson(req);
    const name = normalizeText(body.name, 40);
    if (name.length < 2) fail(400, "Role names must be at least 2 characters.");
    if (!body.permissions || typeof body.permissions !== "object" || Array.isArray(body.permissions)) fail(400, "Select role permissions.");
    const permissions = {};
    for (const key of PERMISSIONS) permissions[key] = body.permissions[key] === true;
    const existing = db.prepare("SELECT id FROM roles WHERE name = ? COLLATE NOCASE").get(name);
    if (existing) fail(409, "A role with that name already exists.");
    db.prepare("INSERT INTO roles (id, name, permissions, system) VALUES (?, ?, ?, 0)")
      .run(randomUUID(), name, JSON.stringify(permissions));
    json(res, 201, { ok: true });
    return;
  }

  const roleRoute = url.pathname.match(/^\/api\/roles\/([0-9a-f-]{36})$/i);
  if (roleRoute && req.method === "PATCH") {
    checkCsrf(req, user);
    requirePermission(user, "manageRoles");
    const role = db.prepare("SELECT id, system FROM roles WHERE id = ?").get(roleRoute[1]);
    if (!role || role.system) fail(404, "That role cannot be changed.");
    const body = await readJson(req);
    const name = normalizeText(body.name, 40);
    if (name.length < 2) fail(400, "Role names must be at least 2 characters.");
    if (!body.permissions || typeof body.permissions !== "object" || Array.isArray(body.permissions)) fail(400, "Select role permissions.");
    const duplicate = db.prepare("SELECT id FROM roles WHERE name = ? COLLATE NOCASE AND id != ?").get(name, role.id);
    if (duplicate) fail(409, "A role with that name already exists.");
    const permissions = {};
    for (const key of PERMISSIONS) permissions[key] = body.permissions[key] === true;
    db.prepare("UPDATE roles SET name = ?, permissions = ? WHERE id = ?").run(name, JSON.stringify(permissions), role.id);
    json(res, 200, { ok: true });
    return;
  }

  if (roleRoute && req.method === "DELETE") {
    checkCsrf(req, user);
    requirePermission(user, "manageRoles");
    const role = db.prepare("SELECT id, system FROM roles WHERE id = ?").get(roleRoute[1]);
    if (!role || role.system) fail(404, "That role cannot be deleted.");
    const assigned = db.prepare("SELECT id FROM users WHERE role_id = ? LIMIT 1").get(role.id);
    if (assigned) fail(409, "Move staff to another role before deleting this role.");
    db.prepare("DELETE FROM roles WHERE id = ?").run(role.id);
    json(res, 200, { ok: true });
    return;
  }

  if (route === "POST /api/tasks") {
    checkCsrf(req, user);
    const body = await readJson(req);
    const title = normalizeText(body.title, 120);
    if (!title) fail(400, "Enter a task title.");
    const description = normalizeText(body.description, 2000);
    const canManage = hasPermission(user, "manageTasks");
    const assigneeId = canManage && typeof body.assigneeId === "string" ? body.assigneeId : user.id;
    if (!accountById(assigneeId) || !db.prepare("SELECT active FROM users WHERE id = ?").get(assigneeId)?.active) {
      fail(400, "Choose an active staff member.");
    }
    const dueDate = body.dueDate || null;
    if (dueDate !== null && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) {
      fail(400, "Choose a valid due date.");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO tasks (id, title, description, status, assignee_id, created_by, due_date, canvas_x, canvas_y, created_at, updated_at)
      VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, description, assigneeId, user.id, dueDate, 60 + Math.random() * 200, 60 + Math.random() * 160, now, now);
    json(res, 201, { ok: true, taskId: id });
    return;
  }

  const taskRoute = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
  if (taskRoute && req.method === "PATCH") {
    checkCsrf(req, user);
    const body = await readJson(req);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskRoute[1]);
    if (!task) fail(404, "That task could not be found.");
    const canManage = hasPermission(user, "manageTasks");
    if (!canManage && task.assignee_id !== user.id && task.created_by !== user.id) {
      fail(403, "You can only update tasks assigned to you or created by you.");
    }
    const title = body.title === undefined ? task.title : normalizeText(body.title, 120);
    if (!title) fail(400, "Task titles cannot be empty.");
    const description = body.description === undefined ? task.description : normalizeText(body.description, 2000);
    const status = body.status === undefined ? task.status : body.status;
    if (!TASK_STATUSES.has(status)) fail(400, "Choose a valid task status.");
    let assigneeId = task.assignee_id;
    if (body.assigneeId !== undefined) {
      if (!canManage) fail(403, "You do not have permission to reassign tasks.");
      if (body.assigneeId !== null && (!accountById(body.assigneeId) || !db.prepare("SELECT active FROM users WHERE id = ?").get(body.assigneeId)?.active)) {
        fail(400, "Choose an active staff member.");
      }
      assigneeId = body.assigneeId;
    }
    let dueDate = task.due_date;
    if (body.dueDate !== undefined) {
      dueDate = body.dueDate || null;
      if (dueDate !== null && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) {
        fail(400, "Choose a valid due date.");
      }
    }
    let canvasX = task.canvas_x;
    let canvasY = task.canvas_y;
    if (body.canvasX !== undefined || body.canvasY !== undefined) {
      if (!hasPermission(user, "manageCanvas") && !canManage) fail(403, "You do not have permission to move canvas cards.");
      canvasX = Number(body.canvasX);
      canvasY = Number(body.canvasY);
      if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY) || canvasX < 0 || canvasY < 0 || canvasX > 5000 || canvasY > 5000) {
        fail(400, "Canvas position is outside the allowed area.");
      }
    }
    const becameDone = status === "done" && task.status !== "done";
    inTransaction(() => {
      db.prepare(`
        UPDATE tasks SET title = ?, description = ?, status = ?, assignee_id = ?,
          due_date = ?, canvas_x = ?, canvas_y = ?, updated_at = ? WHERE id = ?
      `).run(title, description, status, assigneeId, dueDate, canvasX, canvasY, new Date().toISOString(), task.id);
      if (becameDone) createAutomationPayroll(task.id, assigneeId, task.created_by);
    });

    let noticeWarning = null;
    if (becameDone) {
      noticeWarning = await maybeNotifyDiscord(`Task completed: ${title} (${task.id})`);
    }
    json(res, 200, { ok: true, noticeWarning });
    return;
  }

  if (taskRoute && req.method === "DELETE") {
    checkCsrf(req, user);
    requirePermission(user, "manageTasks");
    const result = inTransaction(() => {
      db.prepare("DELETE FROM automation_runs WHERE task_id = ?").run(taskRoute[1]);
      return db.prepare("DELETE FROM tasks WHERE id = ?").run(taskRoute[1]);
    });
    if (!result.changes) fail(404, "That task could not be found.");
    json(res, 200, { ok: true });
    return;
  }

  if (route === "POST /api/payroll") {
    checkCsrf(req, user);
    requirePermission(user, "managePayroll");
    const body = await readJson(req);
    const target = accountById(body.userId);
    if (!target || !target.active) fail(400, "Choose an active staff member.");
    validateRobux(body.amount);
    const note = normalizeText(body.note, 500);
    db.prepare(`
      INSERT INTO payroll (id, user_id, amount, note, status, created_by, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(randomUUID(), target.id, body.amount, note, user.id, new Date().toISOString());
    json(res, 201, { ok: true });
    return;
  }

  const payrollRoute = url.pathname.match(/^\/api\/payroll\/([0-9a-f-]{36})$/i);
  if (payrollRoute && req.method === "PATCH") {
    checkCsrf(req, user);
    requirePermission(user, "managePayroll");
    const body = await readJson(req);
    if (!["approved", "rejected", "paid"].includes(body.status)) fail(400, "Choose approved, rejected, or paid.");
    const record = db.prepare("SELECT status FROM payroll WHERE id = ?").get(payrollRoute[1]);
    if (!record) fail(404, "That payroll entry could not be found.");
    const allowed = record.status === "pending"
      ? ["approved", "rejected"]
      : record.status === "approved" ? ["paid"] : [];
    if (!allowed.includes(body.status)) fail(409, "That payroll status change is not allowed.");
    db.prepare("UPDATE payroll SET status = ? WHERE id = ?").run(body.status, payrollRoute[1]);
    json(res, 200, { ok: true });
    return;
  }

  if (route === "POST /api/automations") {
    checkCsrf(req, user);
    requirePermission(user, "manageAutomations");
    const body = await readJson(req);
    const name = normalizeText(body.name, 80);
    if (!name) fail(400, "Enter an automation name.");
    validateRobux(body.robuxAmount);
    db.prepare(`
      INSERT INTO automations (id, name, trigger_event, robux_amount, active, created_by, created_at)
      VALUES (?, ?, 'task_completed', ?, 1, ?, ?)
    `).run(randomUUID(), name, body.robuxAmount, user.id, new Date().toISOString());
    json(res, 201, { ok: true });
    return;
  }

  const automationRoute = url.pathname.match(/^\/api\/automations\/([0-9a-f-]{36})$/i);
  if (automationRoute && req.method === "PATCH") {
    checkCsrf(req, user);
    requirePermission(user, "manageAutomations");
    const body = await readJson(req);
    if (typeof body.active !== "boolean") fail(400, "Choose whether the automation should be active.");
    const result = db.prepare("UPDATE automations SET active = ? WHERE id = ?").run(Number(body.active), automationRoute[1]);
    if (!result.changes) fail(404, "That automation could not be found.");
    json(res, 200, { ok: true });
    return;
  }

  if (automationRoute && req.method === "DELETE") {
    checkCsrf(req, user);
    requirePermission(user, "manageAutomations");
    const result = inTransaction(() => {
      db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(automationRoute[1]);
      return db.prepare("DELETE FROM automations WHERE id = ?").run(automationRoute[1]);
    });
    if (!result.changes) fail(404, "That automation could not be found.");
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { error: "That portal route was not found." });
}

const PUBLIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/cartel-empire-logo.png", ["cartel-empire-logo.png", "image/png"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/todo-markdown.js", ["todo-markdown.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]]
]);

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Allow": "GET, POST, PATCH, DELETE, OPTIONS" });
        res.end();
        return;
      }
      await handleApi(req, res, url);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "Method not allowed." }, { Allow: "GET, HEAD" });
      return;
    }

    const file = PUBLIC_FILES.get(url.pathname);
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      res.end("Not found");
      return;
    }

    const filePath = path.join(__dirname, "public", file[0]);
    const contents = await readFile(filePath);
    const info = await stat(filePath);
    res.writeHead(200, {
      "Content-Type": file[1],
      "Content-Length": info.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'"
    });
    res.end(req.method === "HEAD" ? undefined : contents);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error.status) {
      json(res, error.status, { error: error.message });
      return;
    }
    console.error("Request failed:", error);
    json(res, 500, { error: "The portal could not complete that request. Please try again or contact an administrator." });
  }
}

async function start() {
  await mkdir(path.dirname(DB_FILE), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(DB_FILE);
  buildBootstrapDb();
  await ensureOwner();
  const server = createServer(handleRequest);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Cartel Empire: Dominion staff portal listening on port ${server.address().port}.`);
    console.log(`Persistent portal data: ${DB_FILE}`);
  });
}

start().catch((error) => {
  console.error("Portal startup failed:", error.message);
  process.exitCode = 1;
});
