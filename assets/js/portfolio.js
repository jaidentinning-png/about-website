const profile = window.portfolioProfile;
const projects = window.portfolioProjects;

function addListItems(elementId, items, className) {
    const list = document.getElementById(elementId);
    list.innerHTML = items.map((item) => `<li${className ? ` class="${className}"` : ""}>${item}</li>`).join("");
}

function renderProjects() {
    const grid = document.getElementById("projectGrid");
    const visibleProjects = projects.filter((project) => project.enabled !== false);

    document.getElementById("projectCount").textContent = String(visibleProjects.length).padStart(2, "0");
    grid.innerHTML = visibleProjects.map((project, index) => `
        <article class="projectCard">
            <a class="projectCover" href="${project.link}" target="_blank" rel="noopener noreferrer" aria-label="View ${project.name}">
                <img src="${project.cover}" alt="${project.name} project cover">
                <span>View project ↗</span>
            </a>
            <div class="projectMeta">
                <span>${String(index + 1).padStart(2, "0")}</span>
                <h2>${project.name}</h2>
                <p>${project.description}</p>
            </div>
        </article>
    `).join("");
}

renderProjects();
document.getElementById("portfolioRole").textContent = `${profile.name} / ${profile.role} / ${profile.location}`;
document.getElementById("portfolioSummary").textContent = profile.summary;
document.getElementById("portfolioAbout").textContent = profile.about;
document.getElementById("portfolioNow").textContent = profile.now;
addListItems("servicesList", profile.whatIDo);
addListItems("skillList", profile.skills);
document.getElementById("contactLink").href = profile.email.includes("@") ? `mailto:${profile.email}` : profile.email;
document.title = `${profile.name} | Developer Portfolio`;
