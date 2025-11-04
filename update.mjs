// update.mjs — ESPN futures + current Season Wins (O/U) + (optional) OddsAPI H2H
// Node 20+. Writes data/predictions.json
import fs from "node:fs/promises";

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const YEAR = new Date().getFullYear();

const U = s => (s ?? "").toUpperCase().trim();

// ---------- utils ----------
function mlToProb(mlLike) {
  if (mlLike == null) return null;
  // Accept "-150", "+800", "800", etc.
  const str = String(mlLike).trim();
  const n = Number(str.replace(/[^\d-]/g, "").replace(/^$/, "NaN"));
  if (!Number.isFinite(n)) return null;
  return n < 0 ? (-n) / ((-n) + 100) : 100 / (n + 100);
}
function devigProbMap(raw) { // {TEAM: raw_p} -> normalized
  const vals = Object.values(raw).filter(v => v > 0);
  const s = vals.reduce((a, b) => a + b, 0);
  if (s <= 0) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (v > 0) out[k] = v / s;
  return out;
}
async function safeJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function tryJSON(urls) {
  for (const u of urls) {
    try { return await safeJSON(u); } catch {}
  }
  return null;
}

// ---------- Odds API (optional: next-game win probabilities) ----------
async function fetchNFLOddsH2H() {
  if (!ODDS_API_KEY) return [];
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?regions=us&markets=h2h&oddsFormat=american&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`H2H odds failed: ${res.status}`);
  const games = await res.json();
  const byTeam = {};
  for (const g of games) {
    const book = g.bookmakers?.[0];
    const m = book?.markets?.find(x => x.key === "h2h");
    if (!m) continue;
    const H = U(g.home_team), A = U(g.away_team);
    const h = m.outcomes?.find(o => U(o.name) === H);
    const a = m.outcomes?.find(o => U(o.name) === A);
    const ph = mlToProb(h?.price);
    const pa = mlToProb(a?.price);
    if (ph != null && pa != null) {
      const s = ph + pa;
      const nh = s > 0 ? ph / s : ph;
      const na = s > 0 ? pa / s : pa;
      byTeam[H] = { team: H, impliedNextGameWinProb: nh };
      byTeam[A] = { team: A, impliedNextGameWinProb: na };
    }
  }
  return Object.values(byTeam);
}

// ---------- ESPN futures helpers ----------
function kindFromTitleAndSize(title, size) {
  const t = U(title);
  // Strong matches
  if (t.includes("SUPER BOWL")) return "sb";
  if (t.includes("CONFERENCE")) return "reach_sb";
  if (t.includes("MAKE PLAYOFFS")) return "make_playoffs";
  if (t.includes("DIVISION")) return "div";
  // Heuristics by market size
  if (size >= 30) return "sb";                         // ~32-team market
  if (size >= 14 && size <= 18) return "reach_sb";     // ~16-team market
  if (size >= 4 && size <= 6 && /EAST|NORTH|SOUTH|WEST/.test(t)) return "div";
  return null;
}

async function listFuturesRefs() {
  const base = y => `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${y}/futures?lang=en&region=us`;
  const root = await tryJSON([base(YEAR), base(YEAR - 1)]);
  if (!root) return [];
  return (root.items || root.entries || []).map(x => x?.$ref).filter(Boolean);
}

async function fetchMarketMeta(ref) {
  const data = await safeJSON(ref);
  const title = data?.name || data?.title || "";
  const futs = Array.isArray(data?.futures) ? data.futures : [];
  let teamMode = false;
  for (const f of futs) {
    for (const b of (f.books || [])) if (b.team?.$ref) teamMode = true;
  }
  return { ref, title, futures: futs, teamMode };
}

async function resolveTeamName(refUrl, cache) {
  if (!refUrl) return null;
  if (cache.has(refUrl)) return cache.get(refUrl);
  try {
    const tj = await safeJSON(refUrl);
    const nm = U(tj?.displayName || tj?.name || tj?.abbreviation || "");
    cache.set(refUrl, nm);
    return nm;
  } catch { return null; }
}

function extractMLfromBook(b) {
  return b?.price?.american ?? b?.oddsAmerican ?? b?.odds?.american ?? b?.value ?? null;
}

async function extractTeamProbs(meta) {
  const raw = {};
  const teamCache = new Map();
  for (const f of meta.futures || []) {
    for (const b of (f.books || [])) {
      if (!b.team?.$ref) continue;
      const team = await resolveTeamName(b.team.$ref, teamCache);
      const ml = extractMLfromBook(b);
      const p = mlToProb(ml);
      if (team && p != null) raw[team] = Math.max(raw[team] || 0, p);
    }
  }
  return devigProbMap(raw);
}

// ---------- ESPN futures (auto-discover SB / conf / div / make playoffs) ----------
async function fetchESPNFuturesAuto() {
  const refs = await listFuturesRefs();
  const futures = {}; // TEAM -> {div, reach_sb, sb, make_playoffs}
  let teamMarkets = 0;

  for (const ref of refs) {
    let meta; try { meta = await fetchMarketMeta(ref); } catch { continue; }
    if (!meta.teamMode) continue;

    const probs = await extractTeamProbs(meta);
    const kind = kindFromTitleAndSize(meta.title, Object.keys(probs).length);
    if (!kind) continue;

    teamMarkets++;
    for (const [team, p] of Object.entries(probs)) {
      const T = U(team);
      futures[T] = futures[T] || {};
      futures[T][kind] = Math.max(futures[T][kind] || 0, p);
    }
  }

  console.log("ESPN futures: teamMarkets =", teamMarkets, "teamsWithAny =", Object.keys(futures).length);
  return futures;
}

// ---------- ESPN Regular Season Wins (O/U) — robust matcher ----------
async function fetchCurrentWinTotals() {
  const refs = await listFuturesRefs();
  const teamCache = new Map();
  const out = {};

  const TITLE_OK = (t) => {
    const s = (t || "").toLowerCase();
    return (
      /regular[\s-]?season\s+wins/.test(s) ||   // "Regular Season Wins", "Regular-Season Wins"
      /team.*season\s+wins/.test(s)       ||   // "Team Regular Season Wins"
      /win\s+totals?/.test(s)             ||   // "Win Totals", "Win Total"
      /season\s+win[s]?/.test(s)               // "Season Wins"
    );
  };

  const matched = new Set();

  for (const ref of refs) {
    let meta; try { meta = await fetchMarketMeta(ref); } catch { continue; }
    if (!meta?.teamMode) continue;
    if (!TITLE_OK(meta.title)) continue;

    matched.add(meta.title);

    for (const f of (meta.futures || [])) {
      for (const b of (f.books || [])) {
        if (!b.team?.$ref) continue;
        // ESPN typically stores the OU number in `value`; include fallbacks
        const val = b?.value ?? b?.overUnder ?? b?.total ?? b?.line ?? null;
        const n = Number(val);
        if (!Number.isFinite(n)) continue;
        const name = await resolveTeamName(b.team.$ref, teamCache);
        if (name) out[U(name)] = n;
      }
    }
  }

  console.log("OU titles matched:", [...matched].join(" | ") || "(none)");
  console.log("Fetched current O/U totals for teams:", Object.keys(out).length);
  return out; // { BILLS: 10.5, JETS: 8.5, ... }
}

// ---------- main ----------
async function main() {
  // 1) Optional next-game probs (safe if no key)
  let nflNextGame = [];
  try { nflNextGame = await fetchNFLOddsH2H(); }
  catch (e) { console.error("H2H fetch failed:", e?.message || e); }

  // 2) ESPN futures (SB / conf / div / make playoffs)
  let nflFutures = {};
  try { nflFutures = await fetchESPNFuturesAuto(); }
  catch (e) { console.error("ESPN futures failed:", e?.message || e); }

  // 3) ESPN current Season Wins (O/U)
  let nflCurrentOU = {};
  try { nflCurrentOU = await fetchCurrentWinTotals(); }
  catch (e) { console.error("Current OU fetch failed:", e?.message || e); }

  // 4) Cache last known O/U if empty this run (e.g., market hidden during games)
  try {
    if (!nflCurrentOU || Object.keys(nflCurrentOU).length === 0) {
      const prevText = await fs.readFile("data/predictions.json", "utf8").catch(() => null);
      if (prevText) {
        const prev = JSON.parse(prevText);
        if (prev?.nflCurrentOU && Object.keys(prev.nflCurrentOU).length > 0) {
          console.log("No current O/U found — keeping previous nflCurrentOU (cached).");
          nflCurrentOU = prev.nflCurrentOU;
        } else {
          console.log("No current O/U found and no previous cache.");
        }
      } else {
        console.log("No current O/U found and no previous predictions.json present.");
      }
    }
  } catch (e) {
    console.error("Cache check failed:", e?.message || e);
  }

  // 5) Write predictions.json
  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      nflNextGame: "The Odds API (h2h)",
      nflFutures:  "ESPN futures (auto-discovered; de-vigged)",
      nflCurrentOU:"ESPN Season Wins (robust matcher; cached if missing)"
    },
    nflNextGame,
    nflFutures,
    nflCurrentOU
  };

  await fs.writeFile("data/predictions.json", JSON.stringify(payload, null, 2), "utf8");
  console.log("✅ Wrote data/predictions.json",
              "teamsWithFutures=", Object.keys(nflFutures).length,
              "teamsWithCurrentOU=", Object.keys(nflCurrentOU).length);
}

main().catch(e => { console.error(e); process.exit(1); });
