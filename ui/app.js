const state = {
  view: "overview",
  overview: null,
  missions: [],
  proposals: [],
  forgeReviews: [],
  decisions: [],
  capabilities: [],
  sense: null,
  command: {
    state: "ready",
    title: "Idle",
    output: "No command has run from this UI yet.",
  },
};

const viewRoot = document.querySelector("#view-root");
const commandOutput = document.querySelector("#command-output");
const pageTitle = document.querySelector("#page-title");
const pageSubtitle = document.querySelector("#page-subtitle");
const commandCard = document.querySelector("#command-card");
const commandTitle = document.querySelector("#command-title");
const commandState = document.querySelector("#command-state");

const viewCopy = {
  overview: ["HyperAgent Cockpit", "Local evidence, review gates, and verification state."],
  missions: ["Mission Timeline", "Task records with verification, risk, and changed-file evidence."],
  workshop: ["Workshop Queue", "Suit upgrades waiting for evidence-backed review."],
  forge: ["Forge Review", "Process quality signals for the Workshop itself."],
  capabilities: ["Capability Registry", "Accepted local capabilities and their decision trail."],
  sensing: ["Sensing Layer", "Branch, working tree, command evidence, and Workbench trace state."],
};

const api = async (path, options) => {
  const response = await fetch(path, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
};

const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const compact = (value, fallback = "Not recorded") => {
  const text = String(value || "").trim();
  return text || fallback;
};

async function loadAll() {
  const [overview, missions, proposals, forgeReviews, decisions, capabilities, sense] = await Promise.all([
    api("/api/overview"),
    api("/api/missions"),
    api("/api/proposals"),
    api("/api/forge-reviews"),
    api("/api/decisions"),
    api("/api/capabilities"),
    api("/api/sense"),
  ]);
  Object.assign(state, { overview, missions, proposals, forgeReviews, decisions, capabilities, sense });
  updateChrome();
  render();
}

function updateChrome() {
  const sense = state.sense || {};
  const [title, subtitle] = viewCopy[state.view] || viewCopy.overview;
  pageTitle.textContent = title;
  pageSubtitle.textContent = subtitle;
  document.querySelector("#workspace").textContent = shortPath(state.overview?.repoRoot || "--");
  document.querySelector("#branch").textContent = sense.branch || "--";
  document.querySelector("#worktree").textContent = workingTreeLabel(sense.git_status_counts);
  document.querySelector("#mode").textContent = state.overview?.safetyMode || "human review required";
  const pending = state.overview?.pendingProposalCount || 0;
  const failed = countMissions("needs-attention");
  document.querySelector("#attention-title").textContent = pending
    ? `${pending} proposal${pending === 1 ? "" : "s"} need review`
    : failed
      ? `${failed} mission${failed === 1 ? "" : "s"} need evidence`
      : "Loop is quiet";
  document.querySelector("#attention-copy").textContent = pending
    ? "Review proposal evidence before accepting persistent behavior."
    : failed
      ? "Check failures or unresolved risk before closeout."
      : "No urgent review item is visible in local artifacts.";
  document.querySelector("#attention-list").innerHTML = attentionItems();
  updateCommandChrome();
}

function updateCommandChrome() {
  commandTitle.textContent = state.command.title;
  commandState.textContent = state.command.state;
  commandState.className = `pill ${state.command.state}`;
  commandCard.dataset.state = state.command.state;
  commandOutput.textContent = state.command.output;
}

function attentionItems() {
  const pending = state.proposals.filter((proposal) => proposal.status === "review").slice(0, 3);
  if (pending.length) {
    return pending.map((proposal) => `
      <div class="attention-item">
        <span class="pill review">review</span>
        <strong>${escapeHtml(compact(proposal.title))}</strong>
      </div>
    `).join("");
  }
  const risky = state.missions.filter((mission) => mission.status === "needs-attention").slice(0, 3);
  if (risky.length) {
    return risky.map((mission) => `
      <div class="attention-item">
        <span class="pill needs-attention">risk</span>
        <strong>${escapeHtml(compact(mission.request))}</strong>
      </div>
    `).join("");
  }
  return `
    <div class="attention-item">
      <span class="pill verified">clear</span>
      <strong>Verifier and sensing are ready.</strong>
    </div>
  `;
}

function countMissions(status) {
  return state.missions.filter((mission) => mission.status === status).length;
}

function shortPath(path) {
  if (!path || path === "--") {
    return "--";
  }
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function workingTreeLabel(counts = "") {
  const match = String(counts).match(/modified=(\d+).*added=(\d+).*deleted=(\d+).*renamed=(\d+).*untracked=(\d+)/);
  if (!match) {
    return counts || "--";
  }
  const [, modified, added, deleted, renamed, untracked] = match.map(Number);
  const total = modified + added + deleted + renamed + untracked;
  if (total === 0) {
    return "clean";
  }
  return `${total} changed`;
}

function freshness(value) {
  if (!value) {
    return "No timestamp";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function setCommand(next) {
  state.command = { ...state.command, ...next };
  updateCommandChrome();
}

function renderSectionHeader(kicker, title, copy) {
  return `
    <div class="section-header">
      <div>
        <p class="eyebrow">${escapeHtml(kicker)}</p>
        <h2>${escapeHtml(title)}</h2>
      </div>
      <p>${escapeHtml(copy)}</p>
    </div>
  `;
}

function riskSentence() {
  const pending = state.overview?.pendingProposalCount || 0;
  const changed = workingTreeLabel(state.sense?.git_status_counts);
  if (pending > 0) {
    return "Human review is the active gate.";
  }
  if (changed !== "clean" && changed !== "--") {
    return "Working tree changes are visible.";
  }
  return "No urgent local gate detected.";
}

function latestVerification() {
  const latest = state.overview?.latestMission;
  return latest?.verification || "No mission verification recorded yet.";
}

function render() {
  document.body.dataset.view = state.view;
  const renderers = {
    overview: renderOverview,
    missions: renderMissions,
    workshop: renderWorkshop,
    forge: renderForge,
    capabilities: renderCapabilities,
    sensing: renderSensing,
  };
  viewRoot.innerHTML = renderers[state.view]();
}

function renderOverview() {
  const overview = state.overview || {};
  const latest = overview.latestMission || {};
  const pending = overview.pendingProposalCount || 0;
  return `
    <section class="hero-panel" aria-label="Current operating state">
      <div class="hero-copy">
        <p class="eyebrow">Mission -> Workshop -> Forge</p>
        <h2>${escapeHtml(pending ? "Human review gate active" : "Workspace loop ready")}</h2>
        <p>${escapeHtml(riskSentence())}</p>
        <div class="latest-callout">
          <span>Latest mission</span>
          <strong>${escapeHtml(compact(latest.request, "No mission recorded yet"))}</strong>
        </div>
      </div>
      <div class="hero-gauge">
        <span>${pending ? "Review" : "Ready"}</span>
        <strong>${pending || "OK"}</strong>
        <em>${pending ? "pending proposal" : "local gate"}</em>
      </div>
    </section>
    <section class="metrics-grid" aria-label="Artifact counts">
      ${metric("Missions", overview.missionCount, `${countMissions("verified")} verified`)}
      ${metric("Review queue", overview.pendingProposalCount, "human gate")}
      ${metric("Decisions", overview.decisionCount, "recorded")}
      ${metric("Capabilities", overview.capabilityCount, "accepted")}
    </section>
    <section class="loop-lane" aria-label="HyperAgent loop">
      ${loopStep("Mission", overview.missionCount, "Evidence captured")}
      ${loopStep("Workshop", overview.proposalCount, "Upgrades proposed")}
      ${loopStep("Human review", overview.decisionCount, "Persistence gated")}
      ${loopStep("Forge", overview.forgeReviewCount, "Process checked")}
    </section>
    <section class="split">
      <div>
        ${renderSectionHeader("Recent work", "Mission records", latestVerification())}
        <div class="artifact-list">${cards(overview.recentMissions, missionCard)}</div>
      </div>
      <div>
        ${renderSectionHeader("Review gate", "Workshop queue", "Persistent behavior stays behind explicit approval.")}
        <div class="artifact-list">${cards(overview.pendingProposals, proposalCard)}</div>
      </div>
    </section>
  `;
}

function renderMissions() {
  return `
    ${renderSectionHeader("Mission layer", "Mission timeline", "Newest records first, with verification and changed-file evidence visible.")}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Status</th><th>Request</th><th>Verification</th><th>Evidence</th></tr></thead>
        <tbody>
          ${state.missions.map((mission) => `
            <tr>
              <td><span class="pill ${escapeHtml(mission.status)}">${escapeHtml(mission.status)}</span></td>
              <td><strong>${escapeHtml(compact(mission.request))}</strong><div class="file-path">${escapeHtml(mission.file)}</div><span class="meta">${escapeHtml(freshness(mission.modifiedAt))}</span></td>
              <td><span class="cell-copy">${escapeHtml(compact(mission.verification))}</span></td>
              <td>${escapeHtml(compact(mission.changedFiles?.slice(0, 3).join(", "), "No changed files listed"))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderWorkshop() {
  return `
    ${renderSectionHeader("Workshop", "Upgrade proposals", "Proposal quality depends on linked evidence, concrete tests, and explicit activation policy.")}
    <div class="artifact-list">${cards(state.proposals, proposalCard)}</div>
  `;
}

function renderForge() {
  return `
    ${renderSectionHeader("Forge", "Workshop quality reviews", "Process reviews keep the upgrade loop specific, testable, and safe.")}
    <div class="artifact-list">
      ${cards(state.forgeReviews, (review) => `
        <article class="artifact-card">
          <header>
            <div>
              <h3>${escapeHtml(review.reviewId)}</h3>
              <p>${escapeHtml(compact(review.recommendation, "No recommendation recorded"))}</p>
            </div>
            <span class="pill">${escapeHtml(compact(review.processScore, "unscored"))}</span>
          </header>
          <p>${escapeHtml(compact(review.friction, "No process friction recorded"))}</p>
          <div class="file-path">${escapeHtml(review.file)}</div>
        </article>
      `)}
    </div>
  `;
}

function renderCapabilities() {
  return `
    ${renderSectionHeader("Registry", "Accepted capabilities", "Every accepted capability needs a decision record and rollback path.")}
    <div class="artifact-list">
      ${cards(state.capabilities, (capability) => `
        <article class="artifact-card">
          <header>
            <div>
              <h3>${escapeHtml(capability.id)}</h3>
              <p>${escapeHtml(compact(capability.title))}</p>
            </div>
            <span class="pill accepted">${escapeHtml(compact(capability.status, "accepted"))}</span>
          </header>
          <p>${escapeHtml(compact(capability.verification, "No verification recorded"))}</p>
          <div class="file-path">${escapeHtml(compact(capability.decisionRecord, "Registry entry"))}</div>
        </article>
      `)}
    </div>
  `;
}

function renderSensing() {
  const sense = state.sense || {};
  return `
    ${renderSectionHeader("Local senses", "Signal board", "Branch, working tree, command evidence, and local Workbench trace health.")}
    <section class="sense-grid">
      <article class="artifact-card">
        <p class="eyebrow">Git</p>
        <h3>${escapeHtml(compact(sense.branch, "Branch unavailable"))}</h3>
        <p>HEAD ${escapeHtml(compact(sense.head, "--"))} with ${escapeHtml(compact(sense.git_status_counts, "no status counts"))}</p>
      </article>
      <article class="artifact-card">
        <p class="eyebrow">Workbench</p>
        <h3>${escapeHtml(compact(sense.workbench?.status, "No trace status"))}</h3>
        <p>${escapeHtml(compact(sense.workbench?.trace_log, "No trace log configured"))}</p>
      </article>
      <article class="artifact-card">
        <p class="eyebrow">Changed files</p>
        ${monoList(sense.changed_files)}
      </article>
      <article class="artifact-card">
        <p class="eyebrow">Recent commands</p>
        ${monoList(sense.recent_commands)}
      </article>
    </section>
  `;
}

function metric(label, value, note) {
  return `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${Number(value || 0)}</strong><em>${escapeHtml(note || "")}</em></article>`;
}

function loopStep(label, value, note) {
  return `
    <article class="loop-step">
      <span>${escapeHtml(label)}</span>
      <strong>${Number(value || 0)}</strong>
      <em>${escapeHtml(note)}</em>
    </article>
  `;
}

function cards(items, renderer) {
  return items && items.length ? items.map(renderer).join("") : `<div class="empty">No local artifacts found.</div>`;
}

function missionCard(mission) {
  return `
    <article class="artifact-card">
      <header>
        <div>
          <h3>${escapeHtml(compact(mission.request))}</h3>
          <p>${escapeHtml(compact(mission.outcome))}</p>
        </div>
        <span class="pill ${escapeHtml(mission.status)}">${escapeHtml(mission.status)}</span>
      </header>
      <div class="artifact-meta">
        <span>${escapeHtml(compact(mission.verification, "No verification"))}</span>
        <span>${escapeHtml(freshness(mission.modifiedAt))}</span>
      </div>
      <div class="file-path">${escapeHtml(mission.file)}</div>
    </article>
  `;
}

function proposalCard(proposal) {
  return `
    <article class="artifact-card">
      <header>
        <div>
          <h3>${escapeHtml(compact(proposal.title))}</h3>
          <p>${escapeHtml(compact(proposal.problem, "No problem statement recorded"))}</p>
        </div>
        <span class="pill ${escapeHtml(proposal.status)}">${escapeHtml(proposal.status)}</span>
      </header>
      <p>${escapeHtml(compact(proposal.firstStep, "No first implementation step recorded"))}</p>
      <div class="artifact-meta">
        <span>${escapeHtml(compact(proposal.activationMode, "activation unknown"))}</span>
        <span>${escapeHtml(freshness(proposal.modifiedAt))}</span>
      </div>
      <div class="file-path">${escapeHtml(proposal.file)}</div>
    </article>
  `;
}

function monoList(items = []) {
  return items.length
    ? `<ul class="mono-list">${items.slice(0, 8).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<div class="empty">None recorded.</div>`;
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("is-active", item === button));
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    updateChrome();
    render();
  });
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    const action = button.dataset.action;
    setCommand({
      state: "running",
      title: `Running ${action}`,
      output: `Running ${action}...`,
    });
    document.querySelectorAll("[data-action]").forEach((item) => {
      item.disabled = true;
      item.setAttribute("aria-busy", "true");
    });
    try {
      const result = await api("/api/actions/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setCommand({
        state: result.ok ? "pass" : "fail",
        title: `${result.ok ? "Passed" : "Failed"}: ${action}`,
        output: `${result.ok ? "PASS" : "FAIL"} ${action}\n\n${result.output || ""}${result.errorOutput || ""}`,
      });
      await loadAll();
    } catch (error) {
      setCommand({
        state: "fail",
        title: `Failed: ${action}`,
        output: `FAIL ${action}\n\n${error.message}`,
      });
    } finally {
      document.querySelectorAll("[data-action]").forEach((item) => {
        item.disabled = false;
        item.removeAttribute("aria-busy");
      });
    }
  });
});

loadAll().catch((error) => {
  viewRoot.innerHTML = `<div class="empty">Unable to load HyperAgent UI: ${escapeHtml(error.message)}</div>`;
});
