const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { parseTodoMarkdown } = require("../public/todo-markdown.js");

const ROOT = path.resolve(__dirname, "..");
const MARKDOWN_TODO_LIST = `
<@&1564060956361883781>

# CARTEL EMPIRE: DOMINION

## 📋 DEVELOPMENT TO-DO LIST

### 💻・SCRIPTING
- Player data saving and loading
- Money and economy system
- Player progression system &#x20;
- Organization management system

### 🏗️・BUILDING
- Main game map
- City and street layout
- Player spawn area

### 🧊・MODELING
- Custom 3D props
- Base furniture and decorations

### 🎨・UI
- Main menu
- Player HUD
- Money display
`;

test("Markdown to-do parser separates heading sections and preserves item text", () => {
  const groups = parseTodoMarkdown(MARKDOWN_TODO_LIST);
  assert.deepEqual(groups.map((group) => group.section), [
    "💻・SCRIPTING",
    "🏗️・BUILDING",
    "🧊・MODELING",
    "🎨・UI"
  ]);
  assert.equal(groups.reduce((total, group) => total + group.items.length, 0), 12);
  assert.equal(groups[0].items[2], "Player progression system");
  assert.equal(groups[3].items[0], "Main menu");
});

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
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.csrf) headers["X-CSRF-Token"] = options.csrf;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${base}${route}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: options.redirect || "follow"
  });
}

async function responseJson(response) {
  return response.json();
}

async function signIn(base, username, password) {
  const response = await request(base, "/api/login", {
    method: "POST",
    body: { username, password }
  });
  return { response, cookie: sessionCookie(response) };
}

async function getSession(base, cookie) {
  const response = await request(base, "/api/me", { cookie });
  assert.equal(response.status, 200);
  return responseJson(response);
}

test("private portal supports accounts, documents, tasks, and Robux rewards", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cartel-portal-test-"));
  let child;
  let logs = "";
  const startServer = async (bootstrap = true) => {
    logs = "";
    child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: "0",
        DATA_DIR: dataDir,
        BOOTSTRAP_OWNER_USERNAME: bootstrap ? "portalowner" : "",
        BOOTSTRAP_OWNER_PASSWORD: bootstrap ? "test-owner-password-that-is-long" : "",
        DISCORD_CLIENT_ID: "test-discord-client",
        DISCORD_CLIENT_SECRET: "test-discord-secret",
        DISCORD_REDIRECT_URI: "https://portal.example/api/discord/callback"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
    child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
    return waitForServer(child, () => logs);
  };
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = await startServer();
  const testDb = new DatabaseSync(path.join(dataDir, "portal.sqlite"));
  const linkTestDiscord = (username, discordId, guilds = []) => {
    testDb.prepare(`
      UPDATE users SET discord_id = ?, discord_username = ?, discord_linked_at = ?,
        discord_guilds = ? WHERE username = ?
    `).run(discordId, `discord-${username}`, new Date().toISOString(), JSON.stringify(guilds), username);
  };
  t.after(() => testDb.close());
  const homepage = await request(base, "/");
  assert.equal(homepage.status, 200);
  const homepageHtml = await homepage.text();
  assert.match(homepageHtml, /PRIVATE TEAM ACCESS/);
  assert.match(homepageHtml, /app\.js\?v=10/);
  assert.match(homepageHtml, /styles\.css\?v=10/);
  assert.match(homepageHtml, /cartel-empire-logo\.png/);
  assert.equal(homepage.headers.get("cache-control"), "no-store");
  const appScript = await request(base, "/app.js?v=10");
  assert.equal(appScript.status, 200);
  assert.equal(appScript.headers.get("cache-control"), "no-store");
  const appScriptText = await appScript.text();
  assert.match(appScriptText, /documents:\s*renderDocuments/);
  assert.match(appScriptText, /"todo-list":\s*renderTodoList/);
  assert.match(appScriptText, /This portal API route returned 404/);
  assert.match(appScriptText, /staffActionsButton/);
  const logo = await request(base, "/cartel-empire-logo.png");
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get("content-type"), /image\/png/);
  const markdownScript = await request(base, "/todo-markdown.js?v=1");
  assert.equal(markdownScript.status, 200);
  assert.match(homepageHtml, /todo-markdown\.js\?v=1/);
  assert.match(await markdownScript.text(), /function parseTodoMarkdown/);
  assert.equal((await request(base, "/portfolio.html")).status, 404);
  assert.equal((await request(base, "/api/board")).status, 401);

  const badLogin = await signIn(base, "portalowner", "wrong-password");
  assert.equal(badLogin.response.status, 401);
  const ownerSession = await signIn(base, "portalowner", "test-owner-password-that-is-long");
  assert.equal(ownerSession.response.status, 200);
  const unlinkedOwnerBoard = await request(base, "/api/board", { cookie: ownerSession.cookie });
  assert.equal(unlinkedOwnerBoard.status, 428);
  const authorizeDiscord = await request(base, "/api/discord/authorize", { cookie: ownerSession.cookie, redirect: "manual" });
  assert.equal(authorizeDiscord.status, 303);
  const discordAuthorizeUrl = new URL(authorizeDiscord.headers.get("location"));
  assert.equal(discordAuthorizeUrl.origin, "https://discord.com");
  assert.equal(discordAuthorizeUrl.searchParams.get("scope"), "identify guilds");
  assert.equal(discordAuthorizeUrl.searchParams.get("code_challenge_method"), "S256");
  linkTestDiscord("portalowner", "175928847299117063", [{ id: "123", name: "Team server", icon: null }]);
  const owner = await getSession(base, ownerSession.cookie);
  assert.equal(owner.user.roleId, "owner");
  assert.equal(owner.user.mustChangePassword, false);
  assert.equal(owner.user.discordLinked, true);

  const noCsrf = await request(base, "/api/accounts", {
    method: "POST",
    cookie: ownerSession.cookie,
    body: { username: "humanresources", displayName: "Human Resources", roleId: "hr" }
  });
  assert.equal(noCsrf.status, 403);

  const createHr = await request(base, "/api/accounts", {
    method: "POST",
    cookie: ownerSession.cookie,
    csrf: owner.csrfToken,
    body: { username: "humanresources", displayName: "Human Resources", roleId: "hr" }
  });
  assert.equal(createHr.status, 201);
  const hrAccount = await responseJson(createHr);
  const duplicateAccount = await request(base, "/api/accounts", {
    method: "POST",
    cookie: ownerSession.cookie,
    csrf: owner.csrfToken,
    body: { username: "humanresources", displayName: "Duplicate Account", roleId: "hr" }
  });
  assert.equal(duplicateAccount.status, 409);

  const hrSession = await signIn(base, "humanresources", hrAccount.temporaryPassword);
  assert.equal(hrSession.response.status, 200);
  let hr = await getSession(base, hrSession.cookie);
  assert.equal(hr.user.mustChangePassword, true);
  assert.equal((await request(base, "/api/board", { cookie: hrSession.cookie })).status, 428);
  const changeHrPassword = await request(base, "/api/password", {
    method: "POST",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: {
      currentPassword: hrAccount.temporaryPassword,
      newPassword: "hr-account-new-long-password",
      confirmPassword: "hr-account-new-long-password"
    }
  });
  assert.equal(changeHrPassword.status, 200);
  const unlinkedHrBoard = await request(base, "/api/board", { cookie: hrSession.cookie });
  assert.equal(unlinkedHrBoard.status, 428);
  linkTestDiscord("humanresources", "175928847299117064", [{ id: "123", name: "Team server", icon: null }]);
  hr = await getSession(base, hrSession.cookie);
  assert.equal(hr.user.mustChangePassword, false);
  assert.equal(hr.user.discordLinked, true);

  const forbiddenRoleEdit = await request(base, "/api/roles", {
    method: "POST",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { name: "Elevated", permissions: { manageRoles: true } }
  });
  assert.equal(forbiddenRoleEdit.status, 403);

  const createDocument = await request(base, "/api/documents", {
    method: "POST",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { title: "Team handbook", content: "Welcome to the team.\nKeep project information private." }
  });
  assert.equal(createDocument.status, 201);
  const { documentId } = await responseJson(createDocument);
  const editDocument = await request(base, `/api/documents/${documentId}`, {
    method: "PATCH",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { title: "Updated handbook", content: "Welcome to the team.\nFollow the project guidelines." }
  });
  assert.equal(editDocument.status, 200);
  const disposableDocument = await request(base, "/api/documents", {
    method: "POST",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { title: "Temporary note", content: "This document will be removed." }
  });
  assert.equal(disposableDocument.status, 201);
  const { documentId: disposableDocumentId } = await responseJson(disposableDocument);
  const deleteDocument = await request(base, `/api/documents/${disposableDocumentId}`, {
    method: "DELETE",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: {}
  });
  assert.equal(deleteDocument.status, 200);

  const createDeveloper = await request(base, "/api/accounts", {
    method: "POST",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { username: "builderone", displayName: "Builder One", roleId: "developer" }
  });
  assert.equal(createDeveloper.status, 201);
  const developerAccount = await responseJson(createDeveloper);
  linkTestDiscord("builderone", "175928847299117065", [{ id: "456", name: "Build server", icon: null }]);
  const developerSession = await signIn(base, "builderone", developerAccount.temporaryPassword);
  assert.equal(developerSession.response.status, 200);
  let developer = await getSession(base, developerSession.cookie);
  assert.equal(developer.user.mustChangePassword, true);
  const changeDeveloperPassword = await request(base, "/api/password", {
    method: "POST",
    cookie: developerSession.cookie,
    csrf: developer.csrfToken,
    body: {
      currentPassword: developerAccount.temporaryPassword,
      newPassword: "developer-account-new-long-password",
      confirmPassword: "developer-account-new-long-password"
    }
  });
  assert.equal(changeDeveloperPassword.status, 200);
  developer = await getSession(base, developerSession.cookie);

  const createTodo = await request(base, "/api/todo-items", {
    method: "POST",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { title: "Test the new spawn area", description: "Check each entrance and report issues." }
  });
  assert.equal(createTodo.status, 201);
  const { todoItemId } = await responseJson(createTodo);
  const parsedGroups = parseTodoMarkdown(MARKDOWN_TODO_LIST);
  const bulkImport = await request(base, "/api/todo-items/bulk", {
    method: "POST",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: {
      items: parsedGroups.flatMap((group, sectionOrder) => group.items.map((title, itemOrder) => ({
        title,
        section: group.section,
        sectionOrder,
        itemOrder
      })))
    }
  });
  assert.equal(bulkImport.status, 201);
  assert.equal((await responseJson(bulkImport)).count, 12);
  let developerBoard = await responseJson(await request(base, "/api/board", { cookie: developerSession.cookie }));
  const basicTodo = developerBoard.todoItems.find((item) => item.id === todoItemId);
  assert.equal(basicTodo.status, "not_done");
  assert.equal(basicTodo.title, "Test the new spawn area");
  assert.equal(basicTodo.section, "General");
  assert.equal(developerBoard.todoItems.filter((item) => item.section === "💻・SCRIPTING").length, 4);
  assert.equal(developerBoard.todoItems.filter((item) => item.section === "🏗️・BUILDING").length, 3);
  const updateTodoStatus = await request(base, `/api/todo-items/${todoItemId}`, {
    method: "PATCH",
    cookie: developerSession.cookie,
    csrf: developer.csrfToken,
    body: { status: "in_progress" }
  });
  assert.equal(updateTodoStatus.status, 200);
  const updateTodoDone = await request(base, `/api/todo-items/${todoItemId}`, {
    method: "PATCH",
    cookie: developerSession.cookie,
    csrf: developer.csrfToken,
    body: { status: "done" }
  });
  assert.equal(updateTodoDone.status, 200);
  const unauthorizedTodoEdit = await request(base, `/api/todo-items/${todoItemId}`, {
    method: "PATCH",
    cookie: developerSession.cookie,
    csrf: developer.csrfToken,
    body: { status: "done", title: "Unauthorized edit" }
  });
  assert.equal(unauthorizedTodoEdit.status, 403);
  const editTodo = await request(base, `/api/todo-items/${todoItemId}`, {
    method: "PATCH",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { status: "done", title: "Finish spawn area test", description: "Check each entrance and report issues." }
  });
  assert.equal(editTodo.status, 200);

  const deniedDocumentPost = await request(base, "/api/documents", {
    method: "POST",
    cookie: developerSession.cookie,
    csrf: developer.csrfToken,
    body: { title: "Unauthorized", content: "This should not be posted." }
  });
  assert.equal(deniedDocumentPost.status, 403);

  const automation = await request(base, "/api/automations", {
    method: "POST",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { name: "Task completion reward", robuxAmount: 125 }
  });
  assert.equal(automation.status, 201);

  const taskResponse = await request(base, "/api/tasks", {
    method: "POST",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { title: "Build the armory", description: "Deliver the first pass.", assigneeId: developer.user.id }
  });
  assert.equal(taskResponse.status, 201);
  const { taskId } = await responseJson(taskResponse);
  const completeTask = await request(base, `/api/tasks/${taskId}`, {
    method: "PATCH",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { status: "done" }
  });
  assert.equal(completeTask.status, 200);

  const boardResponse = await request(base, "/api/board", { cookie: hrSession.cookie });
  const board = await responseJson(boardResponse);
  const reward = board.payroll.find((record) => record.userId === developer.user.id);
  assert.ok(reward);
  assert.equal(reward.amount, 125);
  assert.equal(reward.status, "pending");

  const approve = await request(base, `/api/payroll/${reward.id}`, {
    method: "PATCH",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { status: "approved" }
  });
  assert.equal(approve.status, 200);
  const markPaid = await request(base, `/api/payroll/${reward.id}`, {
    method: "PATCH",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { status: "paid" }
  });
  assert.equal(markPaid.status, 200);

  developerBoard = await responseJson(await request(base, "/api/board", { cookie: developerSession.cookie }));
  assert.equal(developerBoard.payroll.length, 1);
  assert.equal(developerBoard.payroll[0].status, "paid");
  assert.equal(developerBoard.documents.length, 1);
  assert.equal(developerBoard.documents[0].title, "Updated handbook");
  assert.equal(developerBoard.documents[0].content, "Welcome to the team.\nFollow the project guidelines.");
  assert.equal(developerBoard.todoItems.length, 13);
  const updatedTodo = developerBoard.todoItems.find((item) => item.id === todoItemId);
  assert.equal(updatedTodo.title, "Finish spawn area test");
  assert.equal(updatedTodo.status, "done");
  assert.equal(developerBoard.todoItems.filter((item) => item.section === "🎨・UI").length, 3);
  assert.equal(developerBoard.staff.some((person) => person.username), false);
  const deniedAccountCreation = await request(base, "/api/accounts", {
    method: "POST",
    cookie: developerSession.cookie,
    csrf: developer.csrfToken,
    body: { username: "notallowed", displayName: "No Permission", roleId: "developer" }
  });
  assert.equal(deniedAccountCreation.status, 403);

  const secondCompletion = await request(base, `/api/tasks/${taskId}`, {
    method: "PATCH",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { status: "todo" }
  });
  assert.equal(secondCompletion.status, 200);
  await request(base, `/api/tasks/${taskId}`, {
    method: "PATCH",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { status: "done" }
  });
  const finalBoard = await responseJson(await request(base, "/api/board", { cookie: hrSession.cookie }));
  assert.equal(finalBoard.payroll.filter((record) => record.userId === developer.user.id).length, 1);

  const staffMenuResponse = await request(base, `/api/accounts/${developer.user.id}/menu`, {
    cookie: hrSession.cookie
  });
  assert.equal(staffMenuResponse.status, 200);
  const staffMenu = await responseJson(staffMenuResponse);
  assert.equal(staffMenu.discord.id, "175928847299117065");
  assert.equal(staffMenu.discord.username, "discord-builderone");
  assert.equal(staffMenu.discord.guilds[0].name, "Build server");
  assert.equal(staffMenu.tasks[0].title, "Build the armory");
  assert.equal(staffMenu.payroll[0].status, "paid");
  assert.equal(staffMenu.documents.length, 0);
  const renamedStaff = await request(base, `/api/accounts/${developer.user.id}`, {
    method: "PATCH",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: { displayName: "Builder One Updated" }
  });
  assert.equal(renamedStaff.status, 200);
  const deniedStaffMenu = await request(base, `/api/accounts/${developer.user.id}/menu`, {
    cookie: developerSession.cookie
  });
  assert.equal(deniedStaffMenu.status, 403);

  const unlinkDiscord = await request(base, `/api/accounts/${developer.user.id}/unlink-discord`, {
    method: "POST",
    cookie: hrSession.cookie,
    csrf: hr.csrfToken,
    body: {}
  });
  assert.equal(unlinkDiscord.status, 200);
  assert.equal((await request(base, "/api/me", { cookie: developerSession.cookie })).status, 401);
  const developerRelogin = await signIn(base, "builderone", "developer-account-new-long-password");
  assert.equal(developerRelogin.response.status, 200);
  const unlinkedDeveloper = await getSession(base, developerRelogin.cookie);
  assert.equal(unlinkedDeveloper.user.discordLinked, false);
  assert.equal((await request(base, "/api/board", { cookie: developerRelogin.cookie })).status, 428);

  child.kill("SIGTERM");
  await once(child, "exit");
  const restartedBase = await startServer(false);
  const ownerAfterRestart = await signIn(restartedBase, "portalowner", "test-owner-password-that-is-long");
  assert.equal(ownerAfterRestart.response.status, 200);
  const restored = await responseJson(await request(restartedBase, "/api/board", { cookie: ownerAfterRestart.cookie }));
  assert.equal(restored.tasks.length, 1);
  assert.equal(restored.payroll[0].status, "paid");
  assert.equal(restored.documents.length, 1);
  assert.equal(restored.documents[0].title, "Updated handbook");
  assert.equal(restored.todoItems.length, 13);
  assert.equal(restored.todoItems.find((item) => item.id === todoItemId).status, "done");
  assert.equal(restored.todoItems.filter((item) => item.section === "🧊・MODELING").length, 2);
});
