const content = document.querySelector("#content");
const statusText = document.querySelector("#status-text");
const refreshButton = document.querySelector("#refresh-button");
const updatedAt = document.querySelector("#updated-at");
const modePill = document.querySelector("#mode-pill");

const tournamentTemplate = document.querySelector("#tournament-template");
const matchTemplate = document.querySelector("#match-template");
let retryTimeoutId = null;
let refreshInFlight = false;
let liveAgeIntervalId = null;
const previousMatchSnapshots = new Map();

function snapshotMatch(match, recent = false) {
  return JSON.stringify({
    status: recent ? "Final" : match.status,
    statusCode: recent ? "F" : match.statusCode,
    note: match.note,
    playerSets: recent ? match.player.sets : match.player.score?.sets,
    opponentSets: recent ? match.opponent.sets : match.opponent.score?.sets,
    playerGame: recent ? "" : match.player.score?.game,
    opponentGame: recent ? "" : match.opponent.score?.game,
    winnerPlayer: match.player.winner,
    winnerOpponent: match.opponent.winner,
  });
}

function getMatchKey(match, recent = false) {
  if (recent) {
    return `recent:${match.dateLabel}:${match.round}:${match.player.name}:${match.opponent.name}`;
  }
  return `live:${match.id}`;
}

function formatTimestamp(iso) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatRelativeAge(iso) {
  if (!iso) return "";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSeconds < 5) return "Updated just now";
  if (diffSeconds < 60) return `Updated ${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `Updated ${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  return `Updated ${diffHours}h ago`;
}

function formatMode(mode) {
  if (mode === "current") return "Current ATP events";
  if (mode === "fallback") return "Latest finished event";
  return "No ATP data";
}

function formatTournamentMeta(tournament) {
  const parts = [tournament.city, tournament.dateWindow].filter(Boolean);
  if (tournament.champion) {
    parts.push(`Champion: ${tournament.champion}`);
  }
  return parts.join(" • ");
}

function getTournamentState(tournament, mode) {
  if (mode === "fallback" || tournament.isFallback) {
    return { label: "Finished tournament", className: "fallback" };
  }
  if (tournament.isLive || tournament.liveMatches.some((match) => match.statusCode === "P")) {
    return { label: "Matches live", className: "live" };
  }
  return { label: "Current event", className: "scheduled" };
}

function getMatchStatusClass(status) {
  if (status === "Final") return "final";
  if (status === "Scheduled" || status === "On Court") return "scheduled";
  return "";
}

function renderCompetitor(competitor, options = {}) {
  const row = document.createElement("div");
  row.className = `competitor${competitor.winner ? " winner" : ""}`;

  const main = document.createElement("div");
  main.className = "competitor-main";

  const nameRow = document.createElement("div");
  nameRow.className = "competitor-name-row";

  const name = document.createElement("span");
  name.className = "competitor-name";
  name.textContent = competitor.name;

  nameRow.appendChild(name);

  if (competitor.winner) {
    const winnerPill = document.createElement("span");
    winnerPill.className = "winner-pill";
    winnerPill.textContent = "Won";
    nameRow.appendChild(winnerPill);
  }

  if (competitor.country) {
    const country = document.createElement("span");
    country.className = "competitor-country";
    country.textContent = competitor.country;
    nameRow.appendChild(country);
  }

  if (competitor.seed) {
    const seed = document.createElement("span");
    seed.className = "competitor-seed";
    seed.textContent = `(${competitor.seed})`;
    nameRow.appendChild(seed);
  }

  main.appendChild(nameRow);

  const scoreline = document.createElement("div");
  scoreline.className = "scoreline";

  const sets = options.sets || competitor.score?.sets || competitor.sets || [];
  for (const set of sets) {
    const setScore = document.createElement("span");
    setScore.className = "set-score";
    setScore.textContent = set;
    scoreline.appendChild(setScore);
  }

  const game = options.game || competitor.score?.game;
  if (game) {
    const gameScore = document.createElement("span");
    gameScore.className = "game-score";
    gameScore.textContent = game;
    scoreline.appendChild(gameScore);
  }

  row.append(main, scoreline);
  return row;
}

function createDayGroup(label, matches, recent = false) {
  const group = document.createElement("section");
  group.className = "day-group";

  const heading = document.createElement("div");
  heading.className = "day-heading";

  const title = document.createElement("h4");
  title.className = "day-title";
  title.textContent = label;

  const count = document.createElement("span");
  count.className = "day-count";
  count.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;

  const typedSections = createTypeSections(matches, recent);
  heading.append(title, count);
  group.append(heading);
  if (typedSections) {
    group.append(typedSections);
  }

  return group;
}

function createTypeSections(matches, recent = false) {
  const wrapper = document.createElement("div");
  wrapper.className = "type-sections";

  const types = [
    { key: "singles", label: "Singles" },
    { key: "doubles", label: "Doubles" },
  ];

  let renderedSections = 0;

  types.forEach(({ key, label }) => {
    const typeMatches = matches.filter((match) => (match.type || "singles") === key);
    if (!typeMatches.length) return;

    const section = document.createElement("section");
    section.className = "type-section";

    const heading = document.createElement("div");
    heading.className = "type-heading";

    const title = document.createElement("h5");
    title.className = "type-title";
    title.textContent = label;

    const count = document.createElement("span");
    count.className = "type-count";
    count.textContent = `${typeMatches.length} match${typeMatches.length === 1 ? "" : "es"}`;

    const list = document.createElement("div");
    list.className = "matches-list";
    typeMatches.forEach((match) => list.appendChild(renderMatch(match, recent)));

    heading.append(title, count);
    section.append(heading, list);
    wrapper.appendChild(section);
    renderedSections += 1;
  });

  return renderedSections ? wrapper : null;
}

function groupRecentResultsByDay(matches) {
  const groups = new Map();

  matches.forEach((match) => {
    const key = match.dateLabel || "Recent matches";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  });

  return [...groups.entries()].map(([label, items]) => ({ label, items }));
}

function groupOngoingMatchesByDay(matches) {
  if (!matches.length) return [];
  return [
    {
      label: "Today",
      items: matches,
    },
  ];
}

function setupTabs(node) {
  const buttons = node.querySelectorAll(".tab-button");
  const panels = node.querySelectorAll(".tab-panel");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;

      buttons.forEach((item) => item.classList.toggle("is-active", item === button));
      panels.forEach((panel) =>
        panel.classList.toggle("is-active", panel.dataset.panel === tab),
      );
    });
  });
}

function createTabButton(label, tabKey, active = false) {
  const button = document.createElement("button");
  button.className = `tab-button${active ? " is-active" : ""}`;
  button.type = "button";
  button.dataset.tab = tabKey;
  button.textContent = label;
  return button;
}

function createTabPanel(tabKey, titleText, kickerText, contentNode, emptyMessage, active = false) {
  const panel = document.createElement("div");
  panel.className = `tab-panel${active ? " is-active" : ""}`;
  panel.dataset.panel = tabKey;

  const head = document.createElement("div");
  head.className = "panel-head";

  const title = document.createElement("h3");
  title.textContent = titleText;

  const kicker = document.createElement("span");
  kicker.className = "panel-kicker";
  kicker.textContent = kickerText;

  head.append(title, kicker);
  panel.appendChild(head);

  if (contentNode) {
    panel.appendChild(contentNode);
  } else {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyMessage;
    panel.appendChild(empty);
  }

  return panel;
}

function renderMatch(match, recent = false) {
  const fragment = matchTemplate.content.cloneNode(true);
  const node = fragment.querySelector(".match-card");
  const round = node.querySelector(".match-round");
  const subline = node.querySelector(".match-subline");
  const status = node.querySelector(".match-status");
  const note = node.querySelector(".match-note");
  const competitors = node.querySelector(".competitors");
  const matchKey = getMatchKey(match, recent);
  const currentSnapshot = snapshotMatch(match, recent);
  const previousSnapshot = previousMatchSnapshots.get(matchKey);
  const hasChanged = previousSnapshot && previousSnapshot !== currentSnapshot;

  round.textContent = match.round || "Match";

  const sublineParts = [];
  if (recent && match.dateLabel) sublineParts.push(match.dateLabel);
  if (match.court) sublineParts.push(match.court);
  if (match.duration) sublineParts.push(match.duration);
  if (match.type) sublineParts.push(match.type);
  subline.textContent = sublineParts.join(" • ");

  status.textContent = recent ? "Final" : match.status;
  const statusClass = getMatchStatusClass(recent ? "Final" : match.status);
  if (statusClass) {
    status.classList.add(statusClass);
  }
  if (!recent && match.statusCode === "P") {
    status.classList.add("live-now");
  }

  if (!recent && match.updatedAt) {
    const freshness = document.createElement("p");
    freshness.className = "match-freshness";
    freshness.dataset.updatedAt = match.updatedAt;
    freshness.textContent = formatRelativeAge(match.updatedAt);
    node.querySelector(".match-topline > div").appendChild(freshness);
  }

  competitors.appendChild(
    renderCompetitor(match.player, {
      sets: recent ? match.player.sets : undefined,
      game: recent ? "" : match.player.score?.game,
    }),
  );
  competitors.appendChild(
    renderCompetitor(match.opponent, {
      sets: recent ? match.opponent.sets : undefined,
      game: recent ? "" : match.opponent.score?.game,
    }),
  );

  if (match.note) {
    note.textContent = match.note;
  } else {
    note.classList.add("hidden");
  }

  if (hasChanged) {
    node.classList.add("match-card--changed");
  }

  previousMatchSnapshots.set(matchKey, currentSnapshot);

  return fragment;
}

function renderTournament(tournament, mode) {
  const fragment = tournamentTemplate.content.cloneNode(true);
  const node = fragment.querySelector(".tournament-card");
  const levelBadge = node.querySelector(".level-badge");
  const stateBadge = node.querySelector(".state-badge");
  const title = node.querySelector(".tournament-title");
  const meta = node.querySelector(".tournament-meta");
  const tabBar = node.querySelector(".tournament-tab-bar");
  const tabPanels = node.querySelector(".tab-panels");

  const state = getTournamentState(tournament, mode);
  const ongoingMatches = tournament.liveMatches
    .filter((match) => match.statusCode === "P")
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
  const ongoingDayGroups = groupOngoingMatchesByDay(ongoingMatches);
  const recentDayGroups = groupRecentResultsByDay(tournament.recentResults);

  levelBadge.textContent = tournament.level;
  stateBadge.textContent = state.label;
  stateBadge.classList.add(state.className);
  title.textContent = tournament.title;
  meta.textContent = formatTournamentMeta(tournament);

  const ongoingTabKey = "ongoing";
  tabBar.appendChild(createTabButton("Ongoing", ongoingTabKey, true));

  const ongoingContent = ongoingDayGroups.length
    ? (() => {
        const groups = document.createElement("div");
        groups.className = "day-groups";
        ongoingDayGroups.forEach((group) =>
          groups.appendChild(createDayGroup(group.label, group.items, false)),
        );
        return groups;
      })()
    : null;

  tabPanels.appendChild(
    createTabPanel(
      ongoingTabKey,
      "Currently live matches",
      "Grouped by match day",
      ongoingContent,
      "No matches are live right now for this tournament.",
      true,
    ),
  );

  recentDayGroups.forEach((group, index) => {
    const tabKey = `results-${index}`;
    const content = document.createElement("div");
    content.className = "day-groups";
    const dayGroup = document.createElement("section");
    dayGroup.className = "day-group";

    const heading = document.createElement("div");
    heading.className = "day-heading";

    const title = document.createElement("h4");
    title.className = "day-title";
    title.textContent = group.label;

    const count = document.createElement("span");
    count.className = "day-count";
    count.textContent = `${group.items.length} match${group.items.length === 1 ? "" : "es"}`;

    const typedSections = createTypeSections(group.items, true);

    heading.append(title, count);
    dayGroup.append(heading);
    if (typedSections) dayGroup.append(typedSections);
    content.appendChild(dayGroup);

    tabBar.appendChild(createTabButton(group.label, tabKey, false));
    tabPanels.appendChild(
      createTabPanel(
        tabKey,
        `Completed matches for ${group.label}`,
        "Only matches from this day",
        content,
        "No recent completed matches were found.",
        false,
      ),
    );
  });

  setupTabs(node);

  return fragment;
}

function renderScoreboard(data) {
  content.innerHTML = "";
  modePill.textContent = formatMode(data.mode);
  updatedAt.textContent = `Updated ${formatTimestamp(data.updatedAt)}`;

  if (!data.tournaments.length) {
    statusText.textContent = "No qualifying ATP tournaments are available right now.";
    const empty = document.createElement("article");
    empty.className = "tournament-card";
    empty.innerHTML =
      '<p class="empty-state">The ATP feed did not return any ATP 250, ATP 500, ATP 1000, or Grand Slam events.</p>';
    content.appendChild(empty);
    return;
  }

  statusText.textContent =
    data.mode === "current"
      ? `Showing ${data.tournaments.length} current tournament${data.tournaments.length > 1 ? "s" : ""}.`
      : "No current tournaments were found, so this view is showing the latest finished event.";

  data.tournaments.forEach((tournament) => content.appendChild(renderTournament(tournament, data.mode)));

  if (liveAgeIntervalId) clearInterval(liveAgeIntervalId);
  liveAgeIntervalId = setInterval(() => {
    document.querySelectorAll(".match-freshness[data-updated-at]").forEach((element) => {
      element.textContent = formatRelativeAge(element.dataset.updatedAt);
    });
  }, 1000);
}

async function loadScoreboard() {
  if (refreshInFlight) return;
  if (retryTimeoutId) {
    clearTimeout(retryTimeoutId);
    retryTimeoutId = null;
  }

  refreshInFlight = true;
  refreshButton.disabled = true;
  statusText.textContent = "Refreshing ATP scoreboard…";

  try {
    const response = await fetch("/api/scoreboard", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderScoreboard(data);
  } catch (error) {
    statusText.textContent = "ATP data could not be loaded right now. Retrying shortly…";
    modePill.textContent = "Retrying";
    updatedAt.textContent = "";
    content.innerHTML =
      '<article class="tournament-card"><p class="empty-state">The ATP score feed or archive lookup failed. Try refreshing in a moment.</p></article>';
    console.error(error);
    retryTimeoutId = setTimeout(loadScoreboard, 3000);
  } finally {
    refreshInFlight = false;
    refreshButton.disabled = false;
  }
}

function getPollingInterval() {
  return document.visibilityState === "visible" ? 10000 : 45000;
}

let pollTimeoutId = null;

function scheduleNextPoll() {
  if (pollTimeoutId) clearTimeout(pollTimeoutId);
  pollTimeoutId = setTimeout(async () => {
    await loadScoreboard();
    scheduleNextPoll();
  }, getPollingInterval());
}

refreshButton.addEventListener("click", loadScoreboard);
document.addEventListener("visibilitychange", () => {
  scheduleNextPoll();
  if (document.visibilityState === "visible") {
    loadScoreboard();
  }
});
window.addEventListener("online", loadScoreboard);

loadScoreboard().finally(scheduleNextPoll);
