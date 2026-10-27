const state = {
  user: null,
  csrfToken: "",
  board: null,
  tab: "board",
  forcePasswordChange: false,
  toastTimer: null
};

const PERMISSION_LABELS = {
  manageAccounts: "Create, disable, and reset staff accounts",
  manageRoles: "Create roles and assign permissions",
  manageTasks: "Manage and assign every task",
  managePayroll: "Create, approve, reject, and pay Robux entries",
  viewAllPayroll: "View every staff member's payroll",
  manageAutomations: "Manage task-completion automations",
  manageCanvas: "Move tasks on the team canvas",
  manageDocuments: "Post, edit, and delete team documents"
};
const TABS = {
  board: "Work board",
  canvas: "Team canvas",
  payroll: "Robux payroll",
  staff: "Staff & accounts",
  automations: "Automations",
  documents: "Documents",
  "todo-list": "To-do list",
  roles: "Roles & access"
};
const TODO_ITEM_STATUSES = [
  { id: "not_done", label: "Not done" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" }
];
const STATUSES = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" }
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function can(permission) {
  return state.user?.roleId === "owner" || state.user?.permissions?.[permission] === true;
}

async function api(url, options = {}) {
  const method = options.method || "GET";
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = state.csrfToken;
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if (url.startsWith("/api/") && response.status === 404) {
      throw new Error("This portal API route returned 404. The site owner needs to deploy the latest API routes.");
    }
    if (url.startsWith("/api/") && response.status >= 500) {
      throw new Error(`The portal backend is unavailable (HTTP ${response.status}). Please try again later or contact the Owner.`);
    }
    throw new Error(`The portal server returned an unexpected response (HTTP ${response.status}). Please contact the Owner.`);
  }
  let result = {};
  try {
    result = await response.json();
  } catch {
    throw new Error("The portal server returned invalid JSON. Please contact the Owner.");
  }
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      state.board = null;
      $("#portalScreen").hidden = true;
      $("#loginScreen").hidden = false;
    }
    throw new Error(result.error || "That request could not be completed.");
  }
  return result;
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 3600);
}

function initials(name) {
  return String(name || "CE").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function formatDate(value) {
  if (!value) return "No due date";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function money(value) {
  return `${Number(value || 0).toLocaleString()} R$`;
}

function setLoggedOut() {
  state.user = null;
  state.board = null;
  state.csrfToken = "";
  $("#portalScreen").hidden = true;
  $("#loginScreen").hidden = false;
  $("#loginForm").reset();
  $("#loginError").hidden = true;
  $("#username").focus();
}

async function loadCurrentUser() {
  const result = await api("/api/me");
  state.user = result.user;
  state.csrfToken = result.csrfToken;
  state.forcePasswordChange = result.user.mustChangePassword;
  if (!state.forcePasswordChange) await loadBoard();
  showPortal();
}

async function loadBoard() {
  state.board = await api("/api/board");
}

function showPortal() {
  $("#loginScreen").hidden = true;
  $("#portalScreen").hidden = false;
  $("#userDisplayName").textContent = state.user.displayName;
  $("#userRole").textContent = state.user.roleName;
  $("#avatarInitials").textContent = initials(state.user.displayName);
  $$("[data-permission]").forEach((item) => {
    item.hidden = !can(item.dataset.permission);
  });
  if (state.forcePasswordChange) {
    openPasswordDialog(true);
    return;
  }
  renderTab();
}

function setDialog(content, required = false) {
  state.forcePasswordChange = required;
  $("#dialogContent").innerHTML = content;
  const dialog = $("#dialog");
  if (!dialog.open) dialog.showModal();
  const closeForm = $(".dialogCloseWrap");
  closeForm.hidden = required;
}

function closeDialog() {
  if (state.forcePasswordChange) return;
  $("#dialog").close();
}

function openPasswordDialog(required = false) {
  setDialog(`
    <p class="eyebrow">${required ? "FIRST SIGN-IN" : "ACCOUNT SECURITY"}</p>
    <h2>${required ? "Choose your password" : "Change your password"}</h2>
    <p>${required ? "This account was created for you. Set a new password before opening your workspace." : "Use a unique password with at least 12 characters."}</p>
    <form id="passwordForm" class="dialogForm">
      <label>Temporary or current password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
      <label>New password<input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="200" required></label>
      <label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="200" required></label>
      <p class="formError" data-form-error hidden></p>
      <div class="dialogActions"><button class="button buttonPrimary" type="submit">Save password</button></div>
    </form>
  `, required);
}

function renderTab() {
  if (state.forcePasswordChange || !state.user) return;
  const tab = TABS[state.tab] ? state.tab : "board";
  const nav = $(`[data-tab="${tab}"]`);
  if (nav?.hidden) state.tab = "board";
  $$(".navItem").forEach((item) => item.classList.toggle("active", item.dataset.tab === state.tab));
  $("#currentSection").textContent = TABS[state.tab];
  if (!state.board) {
    $("#content").innerHTML = `<section class="accessNotice"><h2>Loading your workspace…</h2></section>`;
    return;
  }
  const renderers = {
    board: renderBoard,
    canvas: renderCanvas,
    payroll: renderPayroll,
    staff: renderStaff,
    automations: renderAutomations,
    documents: renderDocuments,
    "todo-list": renderTodoList,
    roles: renderRoles
  };
  $("#content").innerHTML = renderers[state.tab]();
}

function renderBoard() {
  const tasks = state.board.tasks;
  const mine = tasks.filter((task) => task.assigneeId === state.user.id);
  const done = mine.filter((task) => task.status === "done").length;
  const open = tasks.filter((task) => task.status !== "done").length;
  const canManageTasks = can("manageTasks");
  return `
    <div class="pageHeading">
      <div><p class="eyebrowMuted">PROJECT OVERVIEW</p><h1>Work board</h1><p>Keep the team aligned and every task moving forward.</p></div>
      <div class="headingActions"><button class="button buttonPrimary" data-action="new-task">＋ New task</button></div>
    </div>
    <section class="summaryGrid" aria-label="Task summary">
      <div class="summaryCard"><span>Open tasks</span><strong>${open}<small>across the team</small></strong></div>
      <div class="summaryCard"><span>Assigned to you</span><strong>${mine.filter((task) => task.status !== "done").length}<small>in progress</small></strong></div>
      <div class="summaryCard"><span>Completed by you</span><strong>${done}<small>tasks</small></strong></div>
    </section>
    <section class="boardGrid" aria-label="Kanban board">
      ${STATUSES.map((status) => {
        const statusTasks = tasks.filter((task) => task.status === status.id);
        return `<div class="boardColumn">
          <div class="columnHead"><div class="columnLabel ${status.id}"><i></i>${status.label}</div><span class="columnCount">${statusTasks.length}</span></div>
          ${statusTasks.length ? statusTasks.map((task) => renderTaskCard(task, canManageTasks)).join("") : `<div class="emptyState">Nothing here yet</div>`}
        </div>`;
      }).join("")}
    </section>`;
}

function renderTaskCard(task, canManageTasks) {
  const canEdit = canManageTasks || task.assigneeId === state.user.id || task.createdBy === state.user.id;
  const assignableStaff = state.board.staff.filter((staff) => staff.active !== false);
  const statusControl = canEdit
    ? `<select aria-label="Task status" data-task-status="${task.id}">${STATUSES.map((option) => `<option value="${option.id}" ${task.status === option.id ? "selected" : ""}>${option.label}</option>`).join("")}</select>`
    : `<span class="statusPill">${escapeHtml(task.status.replace("_", " "))}</span>`;
  const assigneeControl = canManageTasks
    ? `<select class="selectAssignee" aria-label="Assign task" data-task-assignee="${task.id}">
        <option value="">Unassigned</option>${assignableStaff.map((staff) => `<option value="${escapeHtml(staff.id)}" ${task.assigneeId === staff.id ? "selected" : ""}>${escapeHtml(staff.displayName)}</option>`).join("")}
      </select>`
    : `<span class="assigneePill">${escapeHtml(task.assigneeName || "Unassigned")}</span>`;
  return `<article class="taskCard">
    <h3 class="taskTitle">${escapeHtml(task.title)}</h3>
    ${task.description ? `<p class="taskDescription">${escapeHtml(task.description)}</p>` : ""}
    <div class="taskMeta"><span>${escapeHtml(formatDate(task.dueDate))}</span>${canManageTasks ? "" : assigneeControl}</div>
    <div class="taskFooter">${statusControl}${canManageTasks ? assigneeControl : ""}
      ${canEdit ? `<button class="button buttonSmall buttonQuiet" data-action="edit-task" data-id="${task.id}">Edit</button>` : ""}
      ${canManageTasks ? `<button class="button buttonSmall buttonDanger" data-action="delete-task" data-id="${task.id}">Delete</button>` : ""}
    </div>
  </article>`;
}

function renderCanvas() {
  const canMove = can("manageCanvas") || can("manageTasks");
  return `
    <div class="pageHeading"><div><p class="eyebrowMuted">PLANNING SPACE</p><h1>Team canvas</h1><p>Arrange work spatially to map out the next steps.</p></div></div>
    <p class="canvasHint">${canMove ? "Drag cards to organize the shared team canvas. Positions are saved for everyone." : "Shared planning canvas. Ask an administrator for permission to rearrange cards."}</p>
    <div class="canvasWrap"><div class="canvas" id="canvas">
      ${state.board.tasks.map((task) => `<article class="canvasCard" ${canMove ? `data-canvas-id="${task.id}"` : ""} style="left:${Math.max(0, task.canvasX)}px;top:${Math.max(0, task.canvasY)}px">
        <h3 class="taskTitle">${escapeHtml(task.title)}</h3>
        ${task.description ? `<p class="taskDescription">${escapeHtml(task.description)}</p>` : ""}
        <div class="taskMeta"><span class="statusPill ${task.status}">${escapeHtml(task.status.replace("_", " "))}</span><span>${escapeHtml(task.assigneeName || "Unassigned")}</span></div>
      </article>`).join("")}
    </div></div>`;
}

function renderPayroll() {
  const records = state.board.payroll;
  const manageable = can("managePayroll");
  const paidTotal = records.filter((row) => row.status === "paid").reduce((sum, row) => sum + row.amount, 0);
  const pendingTotal = records.filter((row) => row.status === "pending").reduce((sum, row) => sum + row.amount, 0);
  const staffOptions = manageable ? state.board.staff.filter((person) => person.active !== false).map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.displayName)}</option>`).join("") : "";
  return `
    <div class="pageHeading"><div><p class="eyebrowMuted">TEAM REWARDS</p><h1>Robux payroll</h1><p>Track pending rewards, approvals, and completed payouts. Transfers happen outside this portal.</p></div></div>
    <section class="summaryGrid">
      <div class="summaryCard"><span>${manageable ? "Awaiting review" : "Your pending rewards"}</span><strong>${money(pendingTotal)}</strong></div>
      <div class="summaryCard"><span>${manageable ? "Marked as paid" : "Your paid rewards"}</span><strong>${money(paidTotal)}</strong></div>
      <div class="summaryCard"><span>${manageable ? "Payroll entries" : "Your entries"}</span><strong>${records.length}<small>tracked</small></strong></div>
    </section>
    ${manageable ? `<div class="panel" style="margin-bottom:16px">
      <h2>Create a Robux entry</h2><p>Record a reward for approval. This portal does not send Robux.</p>
      <form class="panelForm payrollForm" id="payrollForm">
        <label>Staff member<select name="userId" required>${staffOptions}</select></label>
        <label>Robux amount<input name="amount" type="number" min="1" max="10000000" step="1" required></label>
        <label>Note<input name="note" maxlength="500" placeholder="Reason or payout period"></label>
        <button class="button buttonPrimary" type="submit">Add entry</button>
      </form>
    </div>` : ""}
    <div class="tableWrap"><table><thead><tr><th>Staff member</th><th>Amount</th><th>Note</th><th>Status</th><th>Created</th>${manageable ? "<th>Actions</th>" : ""}</tr></thead><tbody>
      ${records.length ? records.map((record) => `<tr>
        <td><span class="personCell"><strong>${escapeHtml(record.displayName)}</strong><small>Team reward</small></span></td>
        <td>${money(record.amount)}</td><td>${escapeHtml(record.note || "—")}</td>
        <td><span class="statusPill ${escapeHtml(record.status)}">${escapeHtml(record.status)}</span></td>
        <td>${escapeHtml(new Date(record.createdAt).toLocaleDateString())}</td>
        ${manageable ? `<td><div class="tableActions">${record.status === "pending" ? `<button class="button buttonSmall" data-action="payroll-status" data-id="${record.id}" data-status="approved">Approve</button><button class="button buttonSmall buttonDanger" data-action="payroll-status" data-id="${record.id}" data-status="rejected">Reject</button>` : ""}${record.status === "approved" ? `<button class="button buttonSmall buttonPrimary" data-action="payroll-status" data-id="${record.id}" data-status="paid">Mark paid</button>` : ""}</div></td>` : ""}
      </tr>`).join("") : `<tr><td colspan="${manageable ? 6 : 5}" class="emptyState">No payroll entries yet.</td></tr>`}
    </tbody></table></div>`;
}

function renderStaff() {
  if (!can("manageAccounts")) return renderNoAccess();
  return `
    <div class="pageHeading"><div><p class="eyebrowMuted">TEAM DIRECTORY</p><h1>Staff &amp; accounts</h1><p>Issue invite-only accounts. New staff must set a password on their first sign-in.</p></div>
      <div class="headingActions"><button class="button buttonPrimary" data-action="new-account">＋ Create account</button></div>
    </div>
    <div class="notice">Temporary passwords are shown only once. Share them directly with the intended team member; never post them publicly.</div>
    <div class="tableWrap"><table><thead><tr><th>Team member</th><th>Role</th><th>Account</th><th>Actions</th></tr></thead><tbody>
      ${state.board.staff.map((person) => `<tr>
        <td><span class="personCell"><strong>${escapeHtml(person.displayName)}</strong><small>@${escapeHtml(person.username || "staff")}</small></span></td>
        <td><select aria-label="Staff role" data-account-role="${person.id}" ${person.active ? "" : "disabled"}>${state.board.roles.filter((role) => role.id !== "owner").map((role) => `<option value="${escapeHtml(role.id)}" ${person.roleId === role.id ? "selected" : ""}>${escapeHtml(role.name)}</option>`).join("")}</select></td>
        <td><span class="statusPill ${person.active ? "approved" : "rejected"}">${person.active ? "Active" : "Disabled"}</span></td>
        <td><div class="tableActions"><button class="button buttonSmall" data-action="reset-account" data-id="${person.id}">Reset password</button><button class="button buttonSmall ${person.active ? "buttonDanger" : ""}" data-action="toggle-account" data-id="${person.id}" data-active="${person.active}">${person.active ? "Disable" : "Enable"}</button></div></td>
      </tr>`).join("") || `<tr><td colspan="4" class="emptyState">No staff accounts yet.</td></tr>`}
    </tbody></table></div>`;
}

function renderAutomations() {
  if (!can("manageAutomations")) return renderNoAccess();
  const automations = state.board.automations;
  return `
    <div class="pageHeading"><div><p class="eyebrowMuted">WORKFLOW RULES</p><h1>Automations</h1><p>Automatically create a pending Robux reward when an assigned task is completed.</p></div></div>
    <div class="panelGrid">
      <section class="panel"><h2>New automation</h2><p>Rewards are only recorded as pending payroll entries. HR or the Owner must approve and mark actual transfers as paid.</p>
        <form class="panelForm" id="automationForm">
          <label>Rule name<input name="name" maxlength="80" placeholder="e.g. Sprint task reward" required></label>
          <label>Trigger<select disabled><option>When a task is completed</option></select></label>
          <label>Robux reward<input name="robuxAmount" type="number" min="1" max="10000000" step="1" required></label>
          <button class="button buttonPrimary" type="submit">Create automation</button>
        </form>
      </section>
      <section class="panel"><h2>Active rules</h2><p>Automations only apply to tasks assigned to a staff member.</p>
        <div class="listStack">${automations.length ? automations.map((rule) => `<div class="listRow">
          <div><strong>${escapeHtml(rule.name)}</strong><small>On task completion · creates a ${money(rule.robuxAmount)} pending reward</small></div>
          <div class="tableActions"><button class="button buttonSmall" data-action="toggle-automation" data-id="${rule.id}" data-active="${rule.active}">${rule.active ? "Pause" : "Resume"}</button><button class="button buttonSmall buttonDanger" data-action="delete-automation" data-id="${rule.id}">Delete</button></div>
        </div>`).join("") : `<div class="emptyState">No automations configured yet.</div>`}</div>
      </section>
    </div>`;
}

function renderDocuments() {
  const documents = state.board.documents || [];
  const canManage = can("manageDocuments");
  return `
    <div class="pageHeading">
      <div><p class="eyebrowMuted">TEAM KNOWLEDGE</p><h1>Documents</h1><p>Shared guides, announcements, and reference notes for the team.</p></div>
      ${canManage ? `<div class="headingActions"><button class="button buttonPrimary" data-action="new-document">＋ Post document</button></div>` : ""}
    </div>
    ${documents.length ? `<section class="documentList" aria-label="Team documents">
      ${documents.map((document) => `<article class="documentCard">
        <div class="documentHeader">
          <div><p class="eyebrowMuted">${escapeHtml(document.authorName)} <span aria-hidden="true">·</span> ${escapeHtml(new Date(document.updatedAt).toLocaleString())}${document.createdAt !== document.updatedAt ? " · Edited" : ""}</p><h2>${escapeHtml(document.title)}</h2></div>
          ${canManage ? `<div class="tableActions"><button class="button buttonSmall" data-action="edit-document" data-id="${document.id}">Edit</button><button class="button buttonSmall buttonDanger" data-action="delete-document" data-id="${document.id}">Delete</button></div>` : ""}
        </div>
        <div class="documentContent">${escapeHtml(document.content)}</div>
      </article>`).join("")}
    </section>` : `<section class="accessNotice"><h2>No documents posted yet</h2><p>${canManage ? "Post the first team document to share a guide, announcement, or reference with everyone." : "Team guides, announcements, and other shared notes will appear here."}</p></section>`}`;
}

function renderTodoList() {
  const items = state.board.todoItems || [];
  const canManage = can("manageTasks");
  const doneCount = items.filter((item) => item.status === "done").length;
  const sections = [];
  const sectionsByName = new Map();
  for (const item of items) {
    const name = item.section || "General";
    let section = sectionsByName.get(name);
    if (!section) {
      section = { name, items: [] };
      sectionsByName.set(name, section);
      sections.push(section);
    }
    section.items.push(item);
  }
  return `
    <div class="pageHeading">
      <div><p class="eyebrowMuted">TEAM CHECKLIST</p><h1>To-do list</h1><p>Shared checklist. Staff can update the status of each item.</p></div>
      ${canManage ? `<div class="headingActions"><button class="button" data-action="new-todo-item">＋ Add item</button><button class="button buttonPrimary" data-action="import-todo-list">＋ Import full list</button></div>` : ""}
    </div>
    ${items.length ? `<section class="summaryGrid" aria-label="To-do summary">
      <div class="summaryCard"><span>Not done</span><strong>${items.filter((item) => item.status === "not_done").length}<small>items</small></strong></div>
      <div class="summaryCard"><span>In progress</span><strong>${items.filter((item) => item.status === "in_progress").length}<small>items</small></strong></div>
      <div class="summaryCard"><span>Done</span><strong>${doneCount}<small>of ${items.length} items</small></strong></div>
    </section>
    <section class="todoSections" aria-label="Shared to-do items">
      ${sections.map((section) => `<section class="todoSection">
        <div class="todoSectionHeader"><h2>${escapeHtml(section.name)}</h2><span>${section.items.length} ${section.items.length === 1 ? "item" : "items"}</span></div>
        <div class="todoList">${section.items.map((item) => `<article class="todoCard ${item.status === "done" ? "todoComplete" : ""}">
          <div class="todoMain">
            <div class="todoCopy"><h3>${escapeHtml(item.title)}</h3>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
              <small>Posted by ${escapeHtml(item.authorName)} · ${escapeHtml(new Date(item.createdAt).toLocaleDateString())}</small>
            </div>
            <div class="todoControls">
              <label class="srOnly" for="todo-status-${item.id}">Status for ${escapeHtml(item.title)}</label>
              <select id="todo-status-${item.id}" data-todo-status="${item.id}" aria-label="Status for ${escapeHtml(item.title)}">
                ${TODO_ITEM_STATUSES.map((status) => `<option value="${status.id}" ${item.status === status.id ? "selected" : ""}>${status.label}</option>`).join("")}
              </select>
              ${canManage ? `<button class="button buttonSmall" data-action="edit-todo-item" data-id="${item.id}">Edit</button><button class="button buttonSmall buttonDanger" data-action="delete-todo-item" data-id="${item.id}">Delete</button>` : ""}
            </div>
          </div>
        </article>`).join("")}
      </section>`).join("")}
    </section>` : `<section class="accessNotice"><h2>The list is empty</h2><p>${canManage ? "Add the first to-do item or import a full Markdown list." : "To-do items added by HR or the Owner will appear here."}</p></section>`}`;
}

function permissionChecks(values = {}) {
  return Object.entries(PERMISSION_LABELS).map(([key, label]) => `<label class="checkRow"><input type="checkbox" name="${key}" ${values[key] ? "checked" : ""}>${escapeHtml(label)}</label>`).join("");
}

function renderRoles() {
  if (!can("manageRoles")) return renderNoAccess();
  const roles = state.board.roles;
  return `
    <div class="pageHeading"><div><p class="eyebrowMuted">ACCESS CONTROL</p><h1>Roles &amp; access</h1><p>Customize what staff roles are allowed to do. The Owner is the system superadmin.</p></div></div>
    <div class="notice">HR is the highest staff rank and can create accounts. Owner is the site superadmin and always retains full control.</div>
    <div class="panelGrid">
      <section class="panel"><h2>Create a role</h2><p>Permissions can be changed later. Existing accounts keep their role assignment.</p>
        <form class="panelForm" id="roleCreateForm">
          <label>Role name<input name="name" maxlength="40" minlength="2" required></label>
          <div class="rolePermissionList">${permissionChecks()}</div>
          <button class="button buttonPrimary" type="submit">Create role</button>
        </form>
      </section>
      <section class="panel"><h2>Current roles</h2><p>Owner permissions are fixed and cannot be removed.</p>
        <div class="listStack">${roles.map((role) => `<div class="listRow">
          <div><strong>${escapeHtml(role.name)} ${role.system ? '<span class="roleTag">System</span>' : ""}</strong><small>${role.system ? "Unrestricted site owner" : Object.entries(role.permissions).filter(([, enabled]) => enabled).map(([key]) => PERMISSION_LABELS[key]).join(" · ") || "Standard staff access"}</small></div>
          ${role.system ? "" : `<div class="tableActions"><button class="button buttonSmall" data-action="edit-role" data-id="${role.id}">Edit</button><button class="button buttonSmall buttonDanger" data-action="delete-role" data-id="${role.id}">Delete</button></div>`}
        </div>`).join("")}</div>
      </section>
    </div>`;
}

function renderNoAccess() {
  return `<section class="accessNotice"><h2>Restricted area</h2><p>Your account does not have permission to access this section. Contact the Owner or HR administrator if you need access.</p></section>`;
}

function openTaskForm(task = null) {
  const canAssign = can("manageTasks");
  const assignableStaff = state.board.staff.filter((person) => person.active !== false);
  setDialog(`
    <p class="eyebrow">TEAM WORKFLOW</p><h2>${task ? "Edit task" : "Create a task"}</h2><p>${task ? "Update the task details and assignment." : "Add a clear assignment for the team. Staff can create tasks for themselves; managers can assign them to others."}</p>
    <form id="taskForm" class="dialogForm" ${task ? `data-id="${task.id}"` : ""}>
      <label>Task title<input name="title" maxlength="120" value="${escapeHtml(task?.title || "")}" required autofocus></label>
      <label>Description<textarea name="description" maxlength="2000" placeholder="Add context, links, or acceptance criteria">${escapeHtml(task?.description || "")}</textarea></label>
      ${canAssign ? `<label>Assign to<select name="assigneeId">${assignableStaff.map((person) => `<option value="${escapeHtml(person.id)}" ${task?.assigneeId === person.id ? "selected" : ""}>${escapeHtml(person.displayName)}</option>`).join("")}<option value="" ${task?.assigneeId ? "" : "selected"}>Unassigned</option></select></label>` : ""}
      <label>Due date<input name="dueDate" type="date" value="${escapeHtml(task?.dueDate || "")}"></label>
      ${task ? `<label>Status<select name="status">${STATUSES.map((status) => `<option value="${status.id}" ${task.status === status.id ? "selected" : ""}>${status.label}</option>`).join("")}</select></label>` : ""}
      <p class="formError" data-form-error hidden></p>
      <div class="dialogActions"><button type="button" class="button buttonQuiet" data-action="close-dialog">Cancel</button><button class="button buttonPrimary" type="submit">${task ? "Save changes" : "Create task"}</button></div>
    </form>`);
  $("#taskForm input[name=title]").focus();
}

function openAccountForm() {
  const roles = state.board.roles.filter((role) => role.id !== "owner");
  setDialog(`
    <p class="eyebrow">STAFF MANAGEMENT</p><h2>Create a staff account</h2><p>A one-time temporary password will be generated. Staff must change it when they first sign in.</p>
    <form id="accountForm" class="dialogForm">
      <label>Username<input name="username" minlength="3" maxlength="24" pattern="[A-Za-z0-9._-]+" autocomplete="off" required></label>
      <label>Display name<input name="displayName" maxlength="50" required></label>
      <label>Role<select name="roleId" required>${roles.map((role) => `<option value="${escapeHtml(role.id)}">${escapeHtml(role.name)}</option>`).join("")}</select></label>
      <p class="formError" data-form-error hidden></p>
      <div class="dialogActions"><button type="button" class="button buttonQuiet" data-action="close-dialog">Cancel</button><button class="button buttonPrimary" type="submit">Create account</button></div>
    </form>`);
  $("#accountForm input[name=username]").focus();
}

function openDocumentForm(document = null) {
  setDialog(`
    <p class="eyebrow">TEAM KNOWLEDGE</p><h2>${document ? "Edit document" : "Post a document"}</h2><p>Write a shared guide, announcement, or reference note. Plain text and line breaks are supported.</p>
    <form id="documentForm" class="dialogForm" ${document ? `data-id="${document.id}"` : ""}>
      <label>Title<input name="title" maxlength="120" value="${escapeHtml(document?.title || "")}" required autofocus></label>
      <label>Document<textarea name="content" maxlength="20000" rows="12" placeholder="Write the document here…" required>${escapeHtml(document?.content || "")}</textarea></label>
      <p class="formError" data-form-error hidden></p>
      <div class="dialogActions"><button type="button" class="button buttonQuiet" data-action="close-dialog">Cancel</button><button class="button buttonPrimary" type="submit">${document ? "Save changes" : "Post document"}</button></div>
    </form>`);
  $("#documentForm input[name=title]").focus();
}

function openTodoItemForm(item = null) {
  setDialog(`
    <p class="eyebrow">TEAM CHECKLIST</p><h2>${item ? "Edit to-do item" : "Add a to-do item"}</h2><p>Staff will be able to set this item to Not done, In progress, or Done.</p>
    <form id="todoItemForm" class="dialogForm" ${item ? `data-id="${item.id}"` : ""}>
      <label>Section<input name="section" maxlength="80" value="${escapeHtml(item?.section || "General")}" required></label>
      <label>To-do item<input name="title" maxlength="160" value="${escapeHtml(item?.title || "")}" required autofocus></label>
      <label>Details<textarea name="description" maxlength="4000" placeholder="Optional details or instructions">${escapeHtml(item?.description || "")}</textarea></label>
      ${item ? `<label>Status<select name="status">${TODO_ITEM_STATUSES.map((status) => `<option value="${status.id}" ${item.status === status.id ? "selected" : ""}>${status.label}</option>`).join("")}</select></label>` : ""}
      <p class="formError" data-form-error hidden></p>
      <div class="dialogActions"><button type="button" class="button buttonQuiet" data-action="close-dialog">Cancel</button><button class="button buttonPrimary" type="submit">${item ? "Save changes" : "Add item"}</button></div>
    </form>`);
  $("#todoItemForm input[name=title]").focus();
}

function updateTodoImportPreview() {
  const preview = $("#todoImportPreview");
  if (!preview) return;
  const groups = window.parseTodoMarkdown($("#todoMarkdownInput").value);
  const count = groups.reduce((total, group) => total + group.items.length, 0);
  if (!count) {
    preview.innerHTML = `<p class="importHint">Paste Markdown headings and bullet lists. Headings become sections; each bullet becomes a to-do item.</p>`;
    return;
  }
  preview.innerHTML = `<p class="importPreviewCount">${count} ${count === 1 ? "item" : "items"} in ${groups.length} ${groups.length === 1 ? "section" : "sections"}</p>
    <div class="importPreviewGroups">${groups.map((group) => `<div><strong>${escapeHtml(group.section)}</strong><span>${group.items.length} ${group.items.length === 1 ? "item" : "items"}</span></div>`).join("")}</div>`;
}

function openTodoImportForm() {
  setDialog(`
    <p class="eyebrow">BULK IMPORT</p><h2>Import a full to-do list</h2>
    <p>Paste Markdown text. Headings become sections, and each bullet or numbered line becomes a separate item.</p>
    <form id="todoImportForm" class="dialogForm">
      <label>Markdown list<textarea id="todoMarkdownInput" name="markdown" maxlength="32000" rows="14" placeholder="# Project name&#10;&#10;## Development to-do list&#10;&#10;### SCRIPTING&#10;- Player data saving and loading&#10;- Money and economy system&#10;&#10;### BUILDING&#10;- Main game map" required></textarea></label>
      <div id="todoImportPreview" class="importPreview" aria-live="polite"><p class="importHint">Paste Markdown headings and bullet lists. Headings become sections; each bullet becomes a to-do item.</p></div>
      <p class="formError" data-form-error hidden></p>
      <div class="dialogActions"><button type="button" class="button buttonQuiet" data-action="close-dialog">Cancel</button><button class="button buttonPrimary" type="submit">Import list</button></div>
    </form>`);
  $("#todoMarkdownInput").addEventListener("input", updateTodoImportPreview);
  $("#todoMarkdownInput").focus();
}

function showTemporaryPassword(username, password) {
  setDialog(`
    <p class="eyebrow">ACCOUNT READY</p><h2>Share this temporary password</h2>
    <p>Give this directly to <strong>${escapeHtml(username)}</strong>. It will not be shown again. The staff member must choose a new password at first sign-in.</p>
    <div class="secretBox"><small>One-time temporary password</small><code id="temporaryPassword">${escapeHtml(password)}</code><small>Do not send this in a public channel.</small></div>
    <div class="dialogActions"><button class="button" data-action="copy-password">Copy password</button><button class="button buttonPrimary" data-action="close-dialog">Done</button></div>`);
}

function openRoleEditor(role) {
  setDialog(`
    <p class="eyebrow">ROLE CONFIGURATION</p><h2>Edit ${escapeHtml(role.name)}</h2><p>Changes apply to all staff members with this role as soon as they make their next request.</p>
    <form id="roleEditForm" class="dialogForm" data-id="${role.id}">
      <label>Role name<input name="name" maxlength="40" minlength="2" value="${escapeHtml(role.name)}" required></label>
      <div class="rolePermissionList">${permissionChecks(role.permissions)}</div>
      <p class="formError" data-form-error hidden></p>
      <div class="dialogActions"><button type="button" class="button buttonQuiet" data-action="close-dialog">Cancel</button><button class="button buttonPrimary" type="submit">Save role</button></div>
    </form>`);
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function checkedPermissions(form) {
  return Object.fromEntries(Object.keys(PERMISSION_LABELS).map((key) => [key, Boolean(form.elements.namedItem(key)?.checked)]));
}

function formError(form, error) {
  const element = $("[data-form-error]", form);
  if (element) {
    element.textContent = error.message;
    element.hidden = false;
  } else {
    showToast(error.message, true);
  }
}

async function refresh() {
  await loadBoard();
  renderTab();
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.classList.contains("dialogCloseWrap")) return;
  event.preventDefault();

  if (form.id === "loginForm") {
    const errorEl = $("#loginError");
    errorEl.hidden = true;
    try {
      await api("/api/login", { method: "POST", body: formValues(form) });
      form.reset();
      await loadCurrentUser();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    }
    return;
  }

  try {
    if (form.id === "passwordForm") {
      const values = formValues(form);
      if (values.newPassword !== values.confirmPassword) throw new Error("The new password entries do not match.");
      await api("/api/password", { method: "POST", body: values });
      $("#dialog").close();
      state.forcePasswordChange = false;
      await loadCurrentUser();
      showToast("Password updated.");
      return;
    }
    if (form.id === "taskForm") {
      const values = formValues(form);
      const taskId = form.dataset.id;
      const taskBody = {
        ...values,
        assigneeId: values.assigneeId || undefined,
        dueDate: values.dueDate || null
      };
      if (taskId) await api(`/api/tasks/${taskId}`, { method: "PATCH", body: taskBody });
      else await api("/api/tasks", { method: "POST", body: taskBody });
      $("#dialog").close();
      await refresh();
      showToast(taskId ? "Task updated." : "Task created.");
      return;
    }
    if (form.id === "accountForm") {
      const result = await api("/api/accounts", { method: "POST", body: formValues(form) });
      $("#dialog").close();
      await refresh();
      showTemporaryPassword(result.username, result.temporaryPassword);
      return;
    }
    if (form.id === "payrollForm") {
      const values = formValues(form);
      await api("/api/payroll", { method: "POST", body: { ...values, amount: Number(values.amount) } });
      form.reset();
      await refresh();
      showToast("Robux payroll entry added as pending.");
      return;
    }
    if (form.id === "automationForm") {
      const values = formValues(form);
      await api("/api/automations", { method: "POST", body: { ...values, robuxAmount: Number(values.robuxAmount) } });
      form.reset();
      await refresh();
      showToast("Automation created.");
      return;
    }
    if (form.id === "documentForm") {
      const documentId = form.dataset.id;
      if (documentId) {
        await api(`/api/documents/${documentId}`, { method: "PATCH", body: formValues(form) });
      } else {
        await api("/api/documents", { method: "POST", body: formValues(form) });
      }
      $("#dialog").close();
      await refresh();
      showToast(documentId ? "Document updated." : "Document posted.");
      return;
    }
    if (form.id === "todoItemForm") {
      const todoItemId = form.dataset.id;
      const body = formValues(form);
      if (todoItemId) {
        await api(`/api/todo-items/${todoItemId}`, { method: "PATCH", body });
      } else {
        await api("/api/todo-items", { method: "POST", body });
      }
      $("#dialog").close();
      await refresh();
      showToast(todoItemId ? "To-do item updated." : "To-do item added.");
      return;
    }
    if (form.id === "todoImportForm") {
      const groups = window.parseTodoMarkdown(form.elements.markdown.value);
      const items = groups.flatMap((group, sectionOrder) => group.items.map((title, itemOrder) => ({
        title,
        section: group.section,
        sectionOrder,
        itemOrder
      })));
      if (!items.length) throw new Error("No Markdown bullet items found. Add headings followed by lines beginning with - or *.");
      if (items.length > 300) throw new Error("Import up to 300 items at a time.");
      const result = await api("/api/todo-items/bulk", { method: "POST", body: { items } });
      $("#dialog").close();
      await refresh();
      showToast(`Imported ${result.count} to-do items in ${groups.length} sections.`);
      return;
    }
    if (form.id === "roleCreateForm") {
      const values = formValues(form);
      await api("/api/roles", { method: "POST", body: { name: values.name, permissions: checkedPermissions(form) } });
      await refresh();
      showToast("Role created.");
      return;
    }
    if (form.id === "roleEditForm") {
      const values = formValues(form);
      await api(`/api/roles/${form.dataset.id}`, { method: "PATCH", body: { name: values.name, permissions: checkedPermissions(form) } });
      $("#dialog").close();
      await refresh();
      showToast("Role updated.");
    }
  } catch (error) {
    formError(form, error);
  }
}

async function handleClick(event) {
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) {
    state.tab = tabButton.dataset.tab;
    renderTab();
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === "new-task") return openTaskForm();
    if (action === "change-password") return openPasswordDialog(false);
    if (action === "edit-task") {
      const task = state.board.tasks.find((entry) => entry.id === id);
      if (task) openTaskForm(task);
      return;
    }
    if (action === "delete-task") {
      if (!confirm("Delete this task? Existing payroll entries will be kept.")) return;
      await api(`/api/tasks/${id}`, { method: "DELETE", body: {} });
      await refresh();
      showToast("Task deleted.");
      return;
    }
    if (action === "new-account") return openAccountForm();
    if (action === "new-document") return openDocumentForm();
    if (action === "new-todo-item") return openTodoItemForm();
    if (action === "import-todo-list") return openTodoImportForm();
    if (action === "edit-todo-item") {
      const item = state.board.todoItems.find((entry) => entry.id === id);
      if (item) openTodoItemForm(item);
      return;
    }
    if (action === "delete-todo-item") {
      if (!confirm("Delete this to-do item for everyone?")) return;
      await api(`/api/todo-items/${id}`, { method: "DELETE", body: {} });
      await refresh();
      showToast("To-do item deleted.");
      return;
    }
    if (action === "edit-document") {
      const document = state.board.documents.find((entry) => entry.id === id);
      if (document) openDocumentForm(document);
      return;
    }
    if (action === "delete-document") {
      if (!confirm("Delete this document for everyone?")) return;
      await api(`/api/documents/${id}`, { method: "DELETE", body: {} });
      await refresh();
      showToast("Document deleted.");
      return;
    }
    if (action === "close-dialog") return closeDialog();
    if (action === "copy-password") {
      await navigator.clipboard.writeText($("#temporaryPassword").textContent);
      showToast("Temporary password copied.");
      return;
    }
    if (action === "reset-account") {
      if (!confirm("Reset this staff member's password? Their current sessions will be signed out.")) return;
      const result = await api(`/api/accounts/${id}/reset-password`, { method: "POST", body: {} });
      await refresh();
      showTemporaryPassword(result.username, result.temporaryPassword);
      return;
    }
    if (action === "toggle-account") {
      const active = button.dataset.active !== "true";
      if (!confirm(`${active ? "Enable" : "Disable"} this account?`)) return;
      await api(`/api/accounts/${id}`, { method: "PATCH", body: { active } });
      await refresh();
      showToast(`Account ${active ? "enabled" : "disabled"}.`);
      return;
    }
    if (action === "payroll-status") {
      const verb = button.dataset.status === "paid" ? "mark this entry as paid" : `${button.dataset.status} this entry`;
      if (!confirm(`Are you sure you want to ${verb}?`)) return;
      await api(`/api/payroll/${id}`, { method: "PATCH", body: { status: button.dataset.status } });
      await refresh();
      showToast("Payroll status updated.");
      return;
    }
    if (action === "toggle-automation") {
      const active = button.dataset.active !== "true";
      await api(`/api/automations/${id}`, { method: "PATCH", body: { active } });
      await refresh();
      showToast(`Automation ${active ? "resumed" : "paused"}.`);
      return;
    }
    if (action === "delete-automation") {
      if (!confirm("Delete this automation? Past payroll entries will remain.")) return;
      await api(`/api/automations/${id}`, { method: "DELETE", body: {} });
      await refresh();
      showToast("Automation deleted.");
      return;
    }
    if (action === "edit-role") {
      const role = state.board.roles.find((entry) => entry.id === id);
      if (role) openRoleEditor(role);
      return;
    }
    if (action === "delete-role") {
      if (!confirm("Delete this role? It must not be assigned to any staff accounts.")) return;
      await api(`/api/roles/${id}`, { method: "DELETE" });
      await refresh();
      showToast("Role deleted.");
      return;
    }
    if (action === "logout") {
      await api("/api/logout", { method: "POST", body: {} });
      setLoggedOut();
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

async function updateTask(taskId, patch) {
  try {
    const result = await api(`/api/tasks/${taskId}`, { method: "PATCH", body: patch });
    await refresh();
    if (result.noticeWarning) showToast(result.noticeWarning, true);
    else showToast("Task updated.");
  } catch (error) {
    showToast(error.message, true);
    await refresh();
  }
}

document.addEventListener("submit", (event) => void handleSubmit(event));
document.addEventListener("click", (event) => void handleClick(event));
document.addEventListener("change", (event) => {
  const todoStatus = event.target.closest("[data-todo-status]");
  if (todoStatus) {
    void api(`/api/todo-items/${todoStatus.dataset.todoStatus}`, {
      method: "PATCH",
      body: { status: todoStatus.value }
    }).then(async () => {
      await refresh();
      showToast("To-do status updated.");
    }).catch(async (error) => {
      showToast(error.message, true);
      await refresh();
    });
  }
  const statusSelect = event.target.closest("[data-task-status]");
  if (statusSelect) void updateTask(statusSelect.dataset.taskStatus, { status: statusSelect.value });
  const assigneeSelect = event.target.closest("[data-task-assignee]");
  if (assigneeSelect) void updateTask(assigneeSelect.dataset.taskAssignee, { assigneeId: assigneeSelect.value || null });
  const accountRole = event.target.closest("[data-account-role]");
  if (accountRole) {
    void api(`/api/accounts/${accountRole.dataset.accountRole}`, { method: "PATCH", body: { roleId: accountRole.value } })
      .then(async () => { await refresh(); showToast("Staff role updated."); })
      .catch(async (error) => { showToast(error.message, true); await refresh(); });
  }
});
document.addEventListener("cancel", (event) => {
  if (event.target.id === "dialog" && state.forcePasswordChange) event.preventDefault();
}, true);

let drag = null;
document.addEventListener("pointerdown", (event) => {
  const card = event.target.closest("[data-canvas-id]");
  if (!card || event.button !== 0) return;
  const rect = card.getBoundingClientRect();
  drag = { card, id: card.dataset.canvasId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
  card.setPointerCapture(event.pointerId);
});
document.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const canvas = $("#canvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(5000, event.clientX - rect.left + canvas.parentElement.scrollLeft - drag.offsetX));
  const y = Math.max(0, Math.min(5000, event.clientY - rect.top + canvas.parentElement.scrollTop - drag.offsetY));
  drag.card.style.left = `${x}px`;
  drag.card.style.top = `${y}px`;
});
document.addEventListener("pointerup", () => {
  if (!drag) return;
  const taskId = drag.id;
  const x = Math.round(parseFloat(drag.card.style.left));
  const y = Math.round(parseFloat(drag.card.style.top));
  drag = null;
  void updateTask(taskId, { canvasX: x, canvasY: y });
});
(async function initialize() {
  try {
    await loadCurrentUser();
  } catch (error) {
    setLoggedOut();
    if (error.message !== "Please log in to continue." && !error.message.includes("log in")) {
      $("#loginError").textContent = error.message;
      $("#loginError").hidden = false;
    }
  }
})();
