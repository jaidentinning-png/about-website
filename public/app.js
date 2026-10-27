const state = {
  route: "home",
  content: {
    name: "Your Name",
    tagline: "Creator, developer, and community builder.",
    about: "Write your story here. This section is fully editable from the owner panel.",
    youtube: "", discord: "", twitter: "", twitch: "", github: "", email: "",
    portfolio: []
  },
  promotions: [],
  user: null,
  csrfToken: "",
  panelSection: "content",
  tickets: [],
  activeTicket: null,
  toastTimer: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function currentRoute() {
  const hash = window.location.hash.replace(/^#/, "") || "home";
  return ["home", "about", "portfolio", "promotions", "support", "panel"].includes(hash) ? hash : "home";
}

async function api(url, options = {}) {
  const method = options.method || "GET";
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = state.csrfToken;
  const response = await fetch(url, { method, credentials: "same-origin", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error("The server returned an unexpected response.");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
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

function setDialog(html) {
  $("#siteDialogContent").innerHTML = html;
  if (!$("#siteDialog").open) $("#siteDialog").showModal();
}

function closeDialog() {
  if ($("#siteDialog").open) $("#siteDialog").close();
}

function socialLinks() {
  const links = [
    ["YouTube", state.content.youtube], ["Discord", state.content.discord],
    ["Twitter / X", state.content.twitter], ["Twitch", state.content.twitch],
    ["GitHub", state.content.github], ["Email", state.content.email ? `mailto:${state.content.email}` : ""]
  ].filter(([, url]) => url);
  return links.length ? links.map(([label, url]) => `<a class="socialLink" href="${escapeHtml(url)}" target="${label === "Email" ? "_self" : "_blank"}" rel="noreferrer">${escapeHtml(label)} <span>↗</span></a>`).join("") : '<p class="emptyCopy">Social links will appear here once they are added in the Panel.</p>';
}

function renderPublicHeader() {
  $$('[data-bind="name"]').forEach((element) => { element.textContent = state.content.name; });
  document.title = `${state.content.name} | Portfolio`;
  $$(".siteNav a, .panelLink").forEach((link) => link.classList.toggle("active", link.dataset.route === state.route));
  $("#footerYear").textContent = new Date().getFullYear();
}

function renderHome() {
  const featured = state.promotions.find((item) => item.featured && item.active) || state.promotions.find((item) => item.active);
  return `
    <section class="heroSection">
      <div class="heroCopy">
        <p class="sectionKicker">WELCOME</p>
        <h1>${escapeHtml(state.content.name)}</h1>
        <p class="heroTagline">${escapeHtml(state.content.tagline)}</p>
        <div class="heroActions">
          <a class="primaryButton" href="#portfolio">View portfolio</a>
          <a class="quietButton" href="#support">Get in touch</a>
        </div>
      </div>
      <div class="heroPortrait"><div class="portraitFrame"><img src="/site-logo.jpg" alt="${escapeHtml(state.content.name)} logo"></div></div>
    </section>
    <section class="homeIntro">
      <div><p class="sectionKicker">ABOUT ME</p><h2>A quick introduction.</h2></div>
      <p>${escapeHtml(state.content.about).replace(/\n/g, "<br>")}</p>
      <div class="socialRow">${socialLinks()}</div>
    </section>
    ${featured ? `<section class="featuredPromotion"><div><p class="sectionKicker">FEATURED COMMUNITY</p><h2>${escapeHtml(featured.name)}</h2><p>${escapeHtml(featured.description)}</p></div><a class="primaryButton" href="${escapeHtml(featured.inviteUrl)}" target="_blank" rel="noreferrer">Join Discord</a></section>` : ""}`;
}

function renderAbout() {
  return `
    <section class="pageHero"><p class="sectionKicker">ABOUT</p><h1>Behind the work.</h1></section>
    <section class="aboutLayout">
      <div class="aboutPortrait"><img src="/site-logo.jpg" alt="${escapeHtml(state.content.name)} logo"></div>
      <article class="aboutCopy"><p class="sectionKicker">MY STORY</p><h2>${escapeHtml(state.content.name)}</h2><div>${escapeHtml(state.content.about).replace(/\n/g, "<br>")}</div><div class="socialRow">${socialLinks()}</div></article>
    </section>`;
}

function renderPortfolio() {
  const items = Array.isArray(state.content.portfolio) ? state.content.portfolio : [];
  return `
    <section class="pageHero"><p class="sectionKicker">PORTFOLIO</p><h1>Selected work.</h1><p>Projects, creations, and collaborations.</p></section>
    ${items.length ? `<section class="portfolioGrid">${items.map((item) => `<article class="portfolioCard">${item.image ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}">` : `<div class="portfolioPlaceholder"><span>PROJECT</span></div>`}<div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.description)}</p>${item.link ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">View project ↗</a>` : ""}</div></article>`).join("")}</section>` : `<section class="largeEmpty"><h2>No projects added yet.</h2><p>Projects can be added from the owner Panel once the portfolio editor is opened.</p></section>`}`;
}

function renderPromotions() {
  const active = state.promotions.filter((item) => item.active);
  return `
    <section class="pageHero"><p class="sectionKicker">COMMUNITY</p><h1>Promotions.</h1><p>Featured Discord communities and partner servers.</p></section>
    <section class="promotionGrid">${active.length ? active.map((item) => `<article class="promotionCard">${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}">` : `<div class="promotionMark">${escapeHtml(item.name.slice(0, 1).toUpperCase())}</div>`}<div><span>${item.featured ? "FEATURED" : "COMMUNITY"}</span><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.description)}</p><a class="primaryButton" href="${escapeHtml(item.inviteUrl)}" target="_blank" rel="noreferrer">Join server</a></div></article>`).join("") : `<div class="largeEmpty"><h2>No promotions posted yet.</h2><p>Discord communities can be added from the owner Panel.</p></div>`}</section>`;
}

function renderSupport() {
  return `
    <section class="pageHero"><p class="sectionKicker">SUPPORT</p><h1>Start a ticket.</h1><p>Ask about promotion, collaborations, work, or general support.</p></section>
    <section class="supportLayout"><aside><p class="sectionKicker">CONTACT</p><h2>Tell me what you need.</h2><p>Your message is saved privately and can be viewed from the owner Panel.</p>${state.content.email ? `<a class="directEmail" href="mailto:${escapeHtml(state.content.email)}">${escapeHtml(state.content.email)}</a>` : ""}</aside>
    <form id="ticketForm" class="ticketForm"><div class="formGrid"><label>Name<input name="name" required maxlength="80" autocomplete="name"></label><label>Email<input name="email" type="email" required maxlength="160" autocomplete="email"></label></div><label>Subject<input name="subject" required maxlength="160"></label><label>Message<textarea name="message" required maxlength="5000" rows="8"></textarea></label><button class="primaryButton" type="submit">Submit ticket</button></form></section>`;
}

async function checkPanelSession() {
  try {
    const result = await api("/api/me");
    state.user = result.user;
    state.csrfToken = result.csrfToken;
  } catch {
    state.user = null;
    state.csrfToken = "";
  }
}

function renderPanelLogin() {
  return `<section class="panelLoginWrap"><form id="panelLoginForm" class="panelLogin"><img src="/site-logo.jpg" alt=""><p class="sectionKicker">OWNER ACCESS</p><h1>Open Panel.</h1><label>Username<input name="username" autocomplete="username" required maxlength="24"></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p id="panelLoginError" class="formError" hidden></p><button class="primaryButton" type="submit">Sign in</button></form></section>`;
}

function renderPanelContent() {
  return `<form id="siteContentForm" class="panelForm"><div class="panelFormGrid"><label>Display name<input name="name" value="${escapeHtml(state.content.name)}" maxlength="80"></label><label>Email<input name="email" type="email" value="${escapeHtml(state.content.email)}" maxlength="160"></label></div><label>Tagline<input name="tagline" value="${escapeHtml(state.content.tagline)}" maxlength="180"></label><label>About section<textarea name="about" rows="8" maxlength="5000">${escapeHtml(state.content.about)}</textarea></label><div class="panelFormGrid"><label>YouTube<input name="youtube" value="${escapeHtml(state.content.youtube)}" maxlength="300"></label><label>Discord<input name="discord" value="${escapeHtml(state.content.discord)}" maxlength="300"></label><label>Twitter / X<input name="twitter" value="${escapeHtml(state.content.twitter)}" maxlength="300"></label><label>Twitch<input name="twitch" value="${escapeHtml(state.content.twitch)}" maxlength="300"></label><label>GitHub<input name="github" value="${escapeHtml(state.content.github)}" maxlength="300"></label></div><button class="primaryButton" type="submit">Save website content</button></form>`;
}

function renderPortfolioEditor() {
  const items = Array.isArray(state.content.portfolio) ? state.content.portfolio : [];
  return `<div class="editorHeading"><div><p class="sectionKicker">PORTFOLIO</p><h2>Projects</h2></div><button class="secondaryButton" type="button" data-panel-action="add-project">＋ Add project</button></div><div class="panelList">${items.length ? items.map((item, index) => `<article class="panelListRow"><div><strong>${escapeHtml(item.title || "Untitled project")}</strong><p>${escapeHtml(item.description)}</p></div><button class="iconButton" type="button" data-panel-action="edit-project" data-index="${index}" aria-label="Edit project">•••</button></article>`).join("") : `<div class="panelEmpty">No portfolio projects yet.</div>`}</div>`;
}

async function loadPromotions() {
  const result = await api("/api/promotions");
  state.promotions = result.promotions || [];
}

function renderPromotionsEditor() {
  return `<div class="editorHeading"><div><p class="sectionKicker">PROMOTIONS</p><h2>Discord servers</h2></div><button class="secondaryButton" type="button" data-panel-action="add-promotion">＋ Add promotion</button></div><div class="panelList">${state.promotions.length ? state.promotions.map((item) => `<article class="panelListRow"><div><strong>${escapeHtml(item.name)}</strong><p>${item.featured ? "Featured · " : ""}${item.active ? "Visible" : "Hidden"}</p></div><button class="iconButton" type="button" data-panel-action="edit-promotion" data-id="${escapeHtml(item.id)}" aria-label="Edit promotion">•••</button></article>`).join("") : `<div class="panelEmpty">No promotions yet.</div>`}</div>`;
}

async function loadTickets() {
  const result = await api("/api/tickets");
  state.tickets = result.tickets || [];
}

function renderTicketsEditor() {
  return `<div class="ticketAdminLayout"><div><div class="editorHeading"><div><p class="sectionKicker">SUPPORT</p><h2>Tickets</h2></div></div><div class="ticketList">${state.tickets.length ? state.tickets.map((ticket) => `<button class="ticketRow" type="button" data-panel-action="open-ticket" data-id="${escapeHtml(ticket.id)}"><span><strong>${escapeHtml(ticket.subject)}</strong><small>${escapeHtml(ticket.name)} · ${escapeHtml(ticket.email)}</small></span><b class="status-${escapeHtml(ticket.status)}">${escapeHtml(ticket.status)}</b></button>`).join("") : `<div class="panelEmpty">No support tickets yet.</div>`}</div></div><article id="ticketDetail" class="ticketDetail"><div class="panelEmpty">Select a ticket to view and reply.</div></article></div>`;
}

async function renderPanel() {
  await checkPanelSession();
  if (!state.user) {
    return renderPanelLogin();
  }
  if (state.user.roleId !== "owner") {
    return `<section class="panelDenied"><p class="sectionKicker">ACCESS DENIED</p><h1>Owner access required.</h1><p>This panel can only be used by the owner account.</p><button class="secondaryButton" type="button" data-panel-action="logout">Sign out</button></section>`;
  }
  await Promise.all([loadPromotions(), loadTickets()]);
  return `<section class="panelShell"><aside class="panelSidebar"><img src="/site-logo.jpg" alt=""><strong>Owner Panel</strong><nav><button class="${state.panelSection === "content" ? "active" : ""}" type="button" data-panel-tab="content">Website content</button><button class="${state.panelSection === "portfolio" ? "active" : ""}" type="button" data-panel-tab="portfolio">Portfolio</button><button class="${state.panelSection === "promotions" ? "active" : ""}" type="button" data-panel-tab="promotions">Promotions</button><button class="${state.panelSection === "tickets" ? "active" : ""}" type="button" data-panel-tab="tickets">Support tickets</button></nav><button class="panelLogout" type="button" data-panel-action="logout">Sign out</button></aside><main class="panelWorkspace"><div class="panelWorkspaceHeading"><div><p class="sectionKicker">CONTROL CENTER</p><h1>${state.panelSection === "content" ? "Website content" : state.panelSection === "portfolio" ? "Portfolio" : state.panelSection === "promotions" ? "Promotions" : "Support tickets"}</h1></div><a href="#home">View site ↗</a></div>${state.panelSection === "content" ? renderPanelContent() : state.panelSection === "portfolio" ? renderPortfolioEditor() : state.panelSection === "promotions" ? renderPromotionsEditor() : renderTicketsEditor()}</main></section>`;
}

async function render() {
  state.route = currentRoute();
  renderPublicHeader();
  $("#content").classList.toggle("panelContent", state.route === "panel");
  if (state.route === "home") $("#content").innerHTML = renderHome();
  else if (state.route === "about") $("#content").innerHTML = renderAbout();
  else if (state.route === "portfolio") $("#content").innerHTML = renderPortfolio();
  else if (state.route === "promotions") $("#content").innerHTML = renderPromotions();
  else if (state.route === "support") $("#content").innerHTML = renderSupport();
  else $("#content").innerHTML = await renderPanel();
  window.scrollTo({ top: 0, behavior: "instant" });
}

async function loadSite() {
  try {
    const result = await api("/api/site");
    state.content = { ...state.content, ...result.content };
    state.promotions = result.promotions || [];
    if (typeof state.content.portfolio === "string") {
      try { state.content.portfolio = JSON.parse(state.content.portfolio); } catch { state.content.portfolio = []; }
    }
  } catch (error) {
    console.error(error);
  }
  await render();
}

function projectDialog(index = null) {
  const items = Array.isArray(state.content.portfolio) ? state.content.portfolio : [];
  const item = index === null ? { title: "", description: "", link: "", image: "" } : (items[index] || { title: "", description: "", link: "", image: "" });
  setDialog(`<form id="projectForm" class="dialogForm"><div class="dialogHeading"><div><p class="sectionKicker">PORTFOLIO</p><h2>${index === null ? "Add project" : "Edit project"}</h2></div><button class="dialogClose" type="button" data-dialog-action="close" aria-label="Close">×</button></div><label>Project name<input name="title" value="${escapeHtml(item.title)}" maxlength="120" required></label><label>Description<textarea name="description" rows="5" maxlength="1000">${escapeHtml(item.description)}</textarea></label><label>Project link<input name="link" type="url" value="${escapeHtml(item.link)}" maxlength="500"></label><label>Image URL<input name="image" type="url" value="${escapeHtml(item.image)}" maxlength="500"></label><input type="hidden" name="index" value="${index === null ? "" : index}"><div class="dialogActions"><button class="dangerButton" type="button" data-dialog-action="delete-project" ${index === null ? "hidden" : ""}>Delete</button><button class="primaryButton" type="submit">Save project</button></div></form>`);
}

function promotionDialog(id = null) {
  const item = id ? state.promotions.find((promotion) => promotion.id === id) : null;
  const promotion = item || { name: "", description: "", inviteUrl: "", imageUrl: "", featured: false, active: true };
  setDialog(`<form id="promotionForm" class="dialogForm"><div class="dialogHeading"><div><p class="sectionKicker">PROMOTION</p><h2>${id ? "Edit promotion" : "Add promotion"}</h2></div><button class="dialogClose" type="button" data-dialog-action="close" aria-label="Close">×</button></div><input type="hidden" name="id" value="${escapeHtml(id || "")}"><label>Server name<input name="name" value="${escapeHtml(promotion.name)}" maxlength="120" required></label><label>Description<textarea name="description" rows="4" maxlength="1000">${escapeHtml(promotion.description)}</textarea></label><label>Discord invite URL<input name="inviteUrl" type="url" value="${escapeHtml(promotion.inviteUrl)}" maxlength="500" required></label><label>Image URL<input name="imageUrl" type="url" value="${escapeHtml(promotion.imageUrl)}" maxlength="500"></label><div class="checkGrid"><label><input type="checkbox" name="featured" ${promotion.featured ? "checked" : ""}> Featured</label><label><input type="checkbox" name="active" ${promotion.active ? "checked" : ""}> Visible</label></div><div class="dialogActions"><button class="dangerButton" type="button" data-dialog-action="delete-promotion" ${id ? "" : "hidden"}>Delete</button><button class="primaryButton" type="submit">Save promotion</button></div></form>`);
}

document.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();
  try {
    if (form.id === "ticketForm") {
      const data = Object.fromEntries(new FormData(form));
      await api("/api/tickets", { method: "POST", body: data });
      form.reset();
      setDialog(`<section class="successDialog"><div class="successMark">✓</div><p class="sectionKicker">TICKET SUBMITTED</p><h2>Message received.</h2><p>Your support ticket has been saved successfully.</p><button class="primaryButton" type="button" data-dialog-action="close">Done</button></section>`);
    }
    if (form.id === "panelLoginForm") {
      const data = Object.fromEntries(new FormData(form));
      await api("/api/login", { method: "POST", body: data });
      await loadSite();
      await render();
      showToast("Signed in.");
    }
    if (form.id === "siteContentForm") {
      const data = Object.fromEntries(new FormData(form));
      data.portfolio = state.content.portfolio || [];
      await api("/api/site", { method: "PUT", body: data });
      state.content = { ...state.content, ...data };
      renderPublicHeader();
      showToast("Website content saved.");
    }
    if (form.id === "projectForm") {
      const data = Object.fromEntries(new FormData(form));
      const items = Array.isArray(state.content.portfolio) ? [...state.content.portfolio] : [];
      const project = { title: data.title, description: data.description, link: data.link, image: data.image };
      const index = data.index === "" ? null : Number(data.index);
      if (index === null) items.push(project); else items[index] = project;
      await api("/api/site", { method: "PUT", body: { ...state.content, portfolio: items } });
      state.content.portfolio = items;
      closeDialog();
      await render();
      showToast("Portfolio updated.");
    }
    if (form.id === "promotionForm") {
      const data = Object.fromEntries(new FormData(form));
      const promotion = { name: data.name, description: data.description, inviteUrl: data.inviteUrl, imageUrl: data.imageUrl, featured: form.elements.featured.checked, active: form.elements.active.checked };
      if (data.id) await api(`/api/promotions/${data.id}`, { method: "PATCH", body: promotion });
      else await api("/api/promotions", { method: "POST", body: promotion });
      closeDialog();
      await loadSite();
      await render();
      showToast("Promotion saved.");
    }
  } catch (error) {
    if (form.id === "panelLoginForm") {
      $("#panelLoginError").textContent = error.message;
      $("#panelLoginError").hidden = false;
    } else showToast(error.message, true);
  }
});

document.addEventListener("click", async (event) => {
  const menuButton = event.target.closest(".menuButton");
  if (menuButton) {
    const open = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!open));
    $(".siteNav").classList.toggle("open", !open);
    return;
  }

  const dialogAction = event.target.closest("[data-dialog-action]");
  if (dialogAction) {
    const action = dialogAction.dataset.dialogAction;
    if (action === "close") closeDialog();
    if (action === "delete-project") {
      const form = $("#projectForm");
      const index = Number(new FormData(form).get("index"));
      const items = (state.content.portfolio || []).filter((_, itemIndex) => itemIndex !== index);
      try {
        await api("/api/site", { method: "PUT", body: { ...state.content, portfolio: items } });
        state.content.portfolio = items;
        closeDialog(); await render(); showToast("Project deleted.");
      } catch (error) { showToast(error.message, true); }
    }
    if (action === "delete-promotion") {
      const id = $("#promotionForm [name=id]").value;
      try { await api(`/api/promotions/${id}`, { method: "DELETE" }); closeDialog(); await loadSite(); await render(); showToast("Promotion deleted."); } catch (error) { showToast(error.message, true); }
    }
    return;
  }

  const panelTab = event.target.closest("[data-panel-tab]");
  if (panelTab) { state.panelSection = panelTab.dataset.panelTab; await render(); return; }

  const panelAction = event.target.closest("[data-panel-action]");
  if (panelAction) {
    const action = panelAction.dataset.panelAction;
    if (action === "add-project") projectDialog();
    if (action === "edit-project") projectDialog(Number(panelAction.dataset.index));
    if (action === "add-promotion") promotionDialog();
    if (action === "edit-promotion") promotionDialog(panelAction.dataset.id);
    if (action === "logout") {
      try { await api("/api/logout", { method: "POST" }); } catch {}
      state.user = null; state.csrfToken = ""; await render();
    }
    if (action === "open-ticket") {
      try {
        const result = await api(`/api/tickets/${panelAction.dataset.id}`);
        $("#ticketDetail").innerHTML = `<div class="ticketDetailHead"><div><p class="sectionKicker">TICKET</p><h2>${escapeHtml(result.ticket.subject)}</h2></div><select id="ticketStatus"><option value="open" ${result.ticket.status === "open" ? "selected" : ""}>Open</option><option value="pending" ${result.ticket.status === "pending" ? "selected" : ""}>Pending</option><option value="closed" ${result.ticket.status === "closed" ? "selected" : ""}>Closed</option></select></div><p class="ticketPerson">${escapeHtml(result.ticket.name)} · ${escapeHtml(result.ticket.email)}</p><div class="messageThread">${result.messages.map((message) => `<article class="${message.sender === "owner" ? "ownerMessage" : "visitorMessage"}"><small>${message.sender === "owner" ? "You" : "Visitor"}</small><p>${escapeHtml(message.message)}</p></article>`).join("")}</div><form id="ticketReplyForm" data-ticket-id="${escapeHtml(result.ticket.id)}"><label>Reply<textarea name="message" rows="5" maxlength="5000" required></textarea></label><button class="primaryButton" type="submit">Send reply</button></form>`;
      } catch (error) { showToast(error.message, true); }
    }
    return;
  }

  const navLink = event.target.closest(".siteNav a, .panelLink, .siteBrand");
  if (navLink) {
    if ($(".siteNav").classList.contains("open")) $(".siteNav").classList.remove("open");
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.id === "ticketStatus") {
    const active = $(".ticketRow.active");
    const ticketButton = $(".ticketRow[aria-current=true]") || event.target.closest(".ticketDetail");
    const ticketId = $("#ticketReplyForm")?.dataset.ticketId;
    if (!ticketId) return;
    try { await api(`/api/tickets/${ticketId}`, { method: "PATCH", body: { status: event.target.value } }); await loadTickets(); showToast("Ticket status updated."); } catch (error) { showToast(error.message, true); }
  }
});

// Reply submits use the shared submit listener.
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "ticketReplyForm") return;
  event.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(event.target));
    await api(`/api/tickets/${event.target.dataset.ticketId}/messages`, { method: "POST", body: data });
    const result = await api(`/api/tickets/${event.target.dataset.ticketId}`);
    $("#ticketDetail").innerHTML = `<div class="ticketDetailHead"><div><p class="sectionKicker">TICKET</p><h2>${escapeHtml(result.ticket.subject)}</h2></div><select id="ticketStatus"><option value="open" ${result.ticket.status === "open" ? "selected" : ""}>Open</option><option value="pending" ${result.ticket.status === "pending" ? "selected" : ""}>Pending</option><option value="closed" ${result.ticket.status === "closed" ? "selected" : ""}>Closed</option></select></div><p class="ticketPerson">${escapeHtml(result.ticket.name)} · ${escapeHtml(result.ticket.email)}</p><div class="messageThread">${result.messages.map((message) => `<article class="${message.sender === "owner" ? "ownerMessage" : "visitorMessage"}"><small>${message.sender === "owner" ? "You" : "Visitor"}</small><p>${escapeHtml(message.message)}</p></article>`).join("")}</div><form id="ticketReplyForm" data-ticket-id="${escapeHtml(result.ticket.id)}"><label>Reply<textarea name="message" rows="5" maxlength="5000" required></textarea></label><button class="primaryButton" type="submit">Send reply</button></form>`;
    await loadTickets(); showToast("Reply saved.");
  } catch (error) { showToast(error.message, true); }
});

window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", loadSite);
