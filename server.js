import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const host = "0.0.0.0";

const LIVE_FEED_URL =
  "https://app.atptour.com/api/v2/gateway/livematches/website?scoringTournamentLevel=tour";
const ARCHIVE_URL = "https://www.atptour.com/en/scores/results-archive";
const ATP_HOST = "https://www.atptour.com";
const ELIGIBLE_LEVELS = new Set(["250", "500", "1000", "gs"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function htmlDecode(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return htmlDecode(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function slugifyTournament(tournament) {
  const raw =
    tournament.EventType === "GS" ||
    tournament.EventType === "UC" ||
    tournament.EventType === "LVR" ||
    tournament.EventType === "LC" ||
    tournament.EventType === "WC"
      ? tournament.EventTitle
      : tournament.EventCity;

  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function parseAtpDate(value) {
  if (!value) return null;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const [, month, day, year] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function formatDateLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatEventWindow(start, end) {
  if (!start || !end) return "";
  const startDate = parseAtpDate(start);
  const endDate = parseAtpDate(end);
  if (!startDate || !endDate) return "";
  return `${formatDateLabel(startDate)} - ${formatDateLabel(endDate)}`;
}

function normalizeLevel(eventType, title = "") {
  const normalized = String(eventType || "").trim().toLowerCase();
  if (ELIGIBLE_LEVELS.has(normalized)) return normalized.toUpperCase();
  if (title.toLowerCase().includes("open") && title.toLowerCase().includes("slam")) {
    return "GS";
  }
  return normalized.toUpperCase();
}

function isEligibleTournament(tournament) {
  const normalized = String(tournament.EventType || "").trim().toLowerCase();
  return ELIGIBLE_LEVELS.has(normalized);
}

function normalizeSetScore(setScore) {
  if (setScore.SetScore === null || setScore.SetScore === undefined) return null;
  const base = String(setScore.SetScore);
  if (setScore.TieBreakScore === null || setScore.TieBreakScore === undefined) {
    return base;
  }
  return `${base}(${setScore.TieBreakScore})`;
}

function statusFromMatch(match) {
  const map = {
    P: "Live",
    F: "Final",
    C: "On Court",
    S: "Suspended",
    D: "Delayed",
    W: "Walkover",
    R: "Retired",
    M: "Medical",
    E: "Ended",
  };
  return map[match.MatchStatus] || "Scheduled";
}

function formatCompetitor(team, isDoubles) {
  if (!team?.Player) return { name: "TBD", country: "" };
  const primary = `${team.Player.PlayerFirstName || ""} ${team.Player.PlayerLastName || ""}`.trim();
  const partner =
    isDoubles && team.Partner?.PlayerLastName
      ? `${team.Partner.PlayerFirstName || ""} ${team.Partner.PlayerLastName || ""}`.trim()
      : "";

  return {
    name: partner ? `${primary} / ${partner}` : primary,
    country: team.Player.PlayerCountry || "",
    seed: team.Seed || null,
  };
}

function normalizeLiveMatch(match) {
  const player = formatCompetitor(match.PlayerTeam, match.IsDoubles);
  const opponent = formatCompetitor(match.OpponentTeam, match.IsDoubles);
  const playerSets = (match.PlayerTeam?.SetScores || []).map(normalizeSetScore).filter(Boolean);
  const opponentSets = (match.OpponentTeam?.SetScores || []).map(normalizeSetScore).filter(Boolean);

  return {
    id: match.MatchId,
    round: match.RoundName || match.Type || "Match",
    court: match.CourtName || "",
    type: match.Type || (match.IsDoubles ? "doubles" : "singles"),
    status: statusFromMatch(match),
    statusCode: match.MatchStatus,
    updatedAt: match.LastUpdated || null,
    note: match.ExtendedMessage || match.MatchStateReasonMessage || "",
    duration: match.MatchTimeTotal || "",
    player: {
      ...player,
      score: {
        game: match.PlayerTeam?.GameScore || "",
        sets: playerSets,
      },
      winner:
        Boolean(match.WinningPlayerId) &&
        [match.PlayerTeam?.Player?.PlayerId, match.PlayerTeam?.Partner?.PlayerId].includes(
          match.WinningPlayerId,
        ),
    },
    opponent: {
      ...opponent,
      score: {
        game: match.OpponentTeam?.GameScore || "",
        sets: opponentSets,
      },
      winner:
        Boolean(match.WinningPlayerId) &&
        [match.OpponentTeam?.Player?.PlayerId, match.OpponentTeam?.Partner?.PlayerId].includes(
          match.WinningPlayerId,
        ),
    },
  };
}

function parseArchiveList(html) {
  const tournaments = [];
  const sections = html.match(/<ul class="events">[\s\S]*?<\/ul>/g) || [];

  for (const section of sections) {
    const resultsPathMatch = section.match(
      /href="(\/en\/scores\/archive\/([^/]+)\/(\d+)\/(\d+)\/(?:results|country-results))"/,
    );
    if (!resultsPathMatch) continue;

    const [, resultsPath, slug, eventId, year] = resultsPathMatch;
    const nameMatch = section.match(/<span class="name">([\s\S]*?)<\/span>/);
    const venueMatch = section.match(/<span class="venue">([\s\S]*?)<\/span>/);
    const dateMatch = section.match(/<span class="Date">([\s\S]*?)<\/span>/);
    const badgeMatch = section.match(/categorystamps_([a-z0-9-]+)\.png/i);
    const winnerMatch = section.match(/<dt>Singles Winner<\/dt>[\s\S]*?<dd>[\s\S]*?<a [^>]+>([\s\S]*?)<\/a>/);

    const rawBadge = (badgeMatch?.[1] || "").toLowerCase();
    const level =
      rawBadge === "grandslam"
        ? "GS"
        : rawBadge === "1000"
          ? "1000"
          : rawBadge === "500"
            ? "500"
            : rawBadge === "250"
              ? "250"
              : rawBadge.toUpperCase();

    tournaments.push({
      slug,
      eventId: Number(eventId),
      year: Number(year),
      name: stripTags(nameMatch?.[1] || ""),
      venue: stripTags(venueMatch?.[1] || "").replace(/\|\s*$/, ""),
      dateLabel: stripTags(dateMatch?.[1] || ""),
      level,
      winner: stripTags(winnerMatch?.[1] || ""),
      resultsPath,
    });
  }

  return tournaments.filter((item) => ELIGIBLE_LEVELS.has(item.level.toLowerCase()));
}

function parseScoreColumns(statsItemHtml) {
  const scoreColumns = [];
  const items = statsItemHtml.split('<div class="score-item">').slice(1);

  for (const item of items) {
    const spans = [...item.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((match) => stripTags(match[1]));
    if (!spans.length || !spans[0]) continue;
    scoreColumns.push(spans[1] ? `${spans[0]}(${spans[1]})` : spans[0]);
  }

  return scoreColumns;
}

function parseStatsItem(statsItemHtml) {
  const rawNameMatches = [
    ...statsItemHtml.matchAll(/<div class="name">[\s\S]*?(?:<a [^>]*>|<p>)([\s\S]*?)(?:<\/a>|<\/p>)/g),
  ]
    .map((match) => stripTags(match[1]))
    .filter(Boolean);
  const uniqueNames = [...new Set(rawNameMatches)];
  const seedMatch = statsItemHtml.match(/<span>\((\d+)\)<\/span>/);
  const countryMatch = statsItemHtml.match(/flags\.svg#flag-([a-z]{3})/i);

  return {
    name: uniqueNames.length ? uniqueNames.join(" / ") : "TBD",
    seed: seedMatch?.[1] || null,
    country: (countryMatch?.[1] || "").toUpperCase(),
    winner: /<div class="winner">/.test(statsItemHtml),
    sets: parseScoreColumns(statsItemHtml),
    isDoublesTeam: uniqueNames.length > 1,
  };
}

function parseRecentMatches(html, limit = 6) {
  const matches = [];

  const dayBlocks = html.split('<div class="atp_accordion-item"').slice(1);

  for (const block of dayBlocks) {
    const headingHtml = block.match(/<h4>([\s\S]*?)<\/h4>/)?.[1] || "";
    const dateLabel = stripTags(headingHtml).replace(/\s*Day\s*\(\d+\)\s*/gi, "").trim();
    const matchBlocks = block.split('<div class="match">').slice(1);

    for (const matchBlock of matchBlocks) {
      const headerMatch = matchBlock.match(
        /<div class="match-header">[\s\S]*?<strong>([\s\S]*?)<\/strong>[\s\S]*?(?:<span>([\d:]+)<\/span>)?/,
      );
      const statsItems = matchBlock
        .split('<div class="stats-item">')
        .slice(1)
        .map((chunk) => `<div class="stats-item">${chunk}`);

      if (statsItems.length < 2) continue;

      const player = parseStatsItem(statsItems[0]);
      const opponent = parseStatsItem(statsItems[1]);

      matches.push({
        dateLabel,
        round: stripTags(headerMatch?.[1] || "Match"),
        duration: stripTags(headerMatch?.[2] || ""),
        player,
        opponent,
        type: player.isDoublesTeam || opponent.isDoublesTeam ? "doubles" : "singles",
        note: stripTags(
          (matchBlock.match(/<div class="match-notes">([\s\S]*?)<\/div>/) || [])[1] || "",
        ),
      });

      if (matches.length >= limit) return matches;
    }
  }

  return matches;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ATP Live Scores Demo/1.0",
      Accept: "text/html,application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ATP Live Scores Demo/1.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.json();
}

async function fetchResultsForTournament(tournament, mode) {
  const pathName =
    mode === "archive"
      ? tournament.resultsPath
      : `/en/scores/current/${slugifyTournament(tournament)}/${tournament.EventId}/results`;

  const html = await fetchText(`${ATP_HOST}${pathName}`);
  return parseRecentMatches(html, 6);
}

function selectCurrentTournaments(feedTournaments) {
  const now = new Date();
  const eligible = feedTournaments.filter(isEligibleTournament);

  return eligible.filter((tournament) => {
    const endDate = parseAtpDate(tournament.EventEndDate);
    if (!endDate) return true;
    const daysAfterEnd = (now.getTime() - endDate.getTime()) / (1000 * 60 * 60 * 24);
    return daysAfterEnd <= 1;
  });
}

export async function buildScoreboard() {
  const liveFeed = await fetchJson(LIVE_FEED_URL);
  const liveTournaments = liveFeed?.Data?.LiveMatchesTournamentsOrdered || [];
  const currentTournaments = selectCurrentTournaments(liveTournaments);

  if (currentTournaments.length > 0) {
    const tournaments = await Promise.all(
      currentTournaments.map(async (tournament) => {
        let recentResults = [];
        try {
          recentResults = await fetchResultsForTournament(tournament, "current");
        } catch {
          recentResults = [];
        }

        return {
          id: tournament.EventId,
          title: tournament.EventTitle,
          city: tournament.EventCity,
          country: tournament.EventCountryCode,
          location: tournament.EventLocation,
          level: normalizeLevel(tournament.EventType, tournament.EventTitle),
          eventType: tournament.EventType,
          isLive: Boolean(tournament.IsLive),
          isFallback: false,
          dateWindow: formatEventWindow(tournament.EventStartDate, tournament.EventEndDate),
          liveMatches: (tournament.LiveMatches || []).map(normalizeLiveMatch),
          recentResults,
        };
      }),
    );

    return {
      mode: "current",
      updatedAt: new Date().toISOString(),
      tournaments,
    };
  }

  const archiveHtml = await fetchText(ARCHIVE_URL);
  const archiveTournaments = parseArchiveList(archiveHtml);
  const latestTournament = archiveTournaments[0];

  if (!latestTournament) {
    return {
      mode: "empty",
      updatedAt: new Date().toISOString(),
      tournaments: [],
    };
  }

  const recentResults = await fetchResultsForTournament(latestTournament, "archive");

  return {
    mode: "fallback",
    updatedAt: new Date().toISOString(),
    tournaments: [
      {
        id: latestTournament.eventId,
        title: latestTournament.name,
        city: latestTournament.venue,
        country: "",
        location: latestTournament.venue,
        level: latestTournament.level,
        eventType: latestTournament.level,
        isLive: false,
        isFallback: true,
        dateWindow: latestTournament.dateLabel,
        champion: latestTournament.winner,
        liveMatches: [],
        recentResults,
      },
    ],
  };
}

async function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(publicDir, requestPath);

  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/scoreboard") {
      const payload = await buildScoreboard();
      return sendJson(res, 200, payload);
    }

    return serveStatic(req, res);
  } catch (error) {
    return sendJson(res, 500, {
      error: "Unable to load ATP scores right now.",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

if (process.argv[1] === __filename) {
  server.listen(port, host, () => {
    console.log(`ATP scores app running on http://${host}:${port}`);
  });
}
