// scripts/newsroom.mjs
import fs from "node:fs/promises";

// --- helpers ---
const out = (...a) => process.stdout.write(a.join(" ") + "\n");
const today = new Date();
const pad = (n) => String(n).padStart(2, "0");
const y = today.getFullYear();
const m = pad(today.getMonth() + 1);
const d = pad(today.getDate());
const contentDir = `content/${y}/${m}/${d}`;
const ensureDir = async (p) => fs.mkdir(p, { recursive: true }).catch(()=>{});

// --- config ---
const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID || "1228186433580171264";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// --- tiny fetch wrapper ---
async function jget(url) {
  const r = await fetch(url, { headers: { "User-Agent": "rabkl-bot" } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

// --- Sleeper fetches ---
async function fetchBundle(leagueId) {
  const league = await jget(`https://api.sleeper.app/v1/league/${leagueId}`);
  const users = await jget(`https://api.sleeper.app/v1/league/${leagueId}/users`);
  const rosters = await jget(`https://api.sleeper.app/v1/league/${leagueId}/rosters`);
  // transactions for recent rounds (grab last 6 rounds heuristically)
  const rounds = [...Array(6)].map((_, i) => (league?.season_length || 30) - i).filter(x => x > 0);
  const txns = [];
  for (const r of rounds) {
    try {
      const t = await jget(`https://api.sleeper.app/v1/league/${leagueId}/transactions/${r}`);
      txns.push(...t);
    } catch (_) {}
  }
  // players dictionary (id -> {full_name, team, position})
  const players = await jget(`https://api.sleeper.app/v1/players/nba`);
  return { league, users, rosters, txns, players };
}

// --- mapping helpers ---
function mapOwners(users, rosters) {
  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map(r => [r.roster_id, r]));
  const ownerByRoster = {};
  for (const r of rosters) {
    const u = userById[r.owner_id];
    const team = (u?.metadata?.team_name) || (u?.display_name) || (u?.username) || `Team ${r.roster_id}`;
    const gm = (u?.display_name) || (u?.username) || "GM";
    ownerByRoster[r.roster_id] = { team, gm, username: u?.username ? `@${u.username}` : "" };
  }
  return { ownerByRoster, rosterById, userById };
}

function nameFromPlayerId(players, pid) {
  const p = players[pid];
  if (!p) return { name: `Player ${pid}`, team: "", pos: "" };
  return { name: p.full_name || p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : `Player ${pid}`, team: p.team || "", pos: p.fantasy_positions?.[0] || p.position || "" };
}

// --- normalize transactions to simple events ---
function normalizeEvents(bundle) {
  const { users, rosters, txns, players } = bundle;
  const { ownerByRoster } = mapOwners(users, rosters);
  const out = [];

  for (const t of txns) {
    const ts = new Date(t.created || Date.now()).toISOString();
    if (t.type === "trade") {
      // basic trade parse
      const teamsInvolved = new Set(t.roster_ids || []);
      const assets = [];
      for (const item of (t.adds ? Object.entries(t.adds) : [])) {
        const [pid, rid] = item;
        const { name } = nameFromPlayerId(players, pid);
        assets.push({ roster_id: Number(rid), in: name });
      }
      for (const item of (t.drops ? Object.entries(t.drops) : [])) {
        const [pid, rid] = item;
        const { name } = nameFromPlayerId(players, pid);
        assets.push({ roster_id: Number(rid), out: name });
      }
      const actors = [...teamsInvolved].map(rid => ownerByRoster[rid]).filter(Boolean);
      out.push({
        event_id: t.transaction_id,
        timestamp: ts,
        type: "TRADE",
        actors,
        assets,
      });
    } else if (["free_agent", "waiver"].includes(t.type)) {
      // adds/drops as short "signings"
      const actors = t.roster_ids?.length ? [ownerByRoster[t.roster_ids[0]]] : [];
      const adds = Object.keys(t.adds || {}).map(pid => nameFromPlayerId(players, pid).name);
      const drops = Object.keys(t.drops || {}).map(pid => nameFromPlayerId(players, pid).name);
      if (adds.length || drops.length) {
        out.push({
          event_id: t.transaction_id,
          timestamp: new Date(t.created || Date.now()).toISOString(),
          type: "SIGNING",
          actors,
          adds,
          drops
        });
      }
    }
  }
  return out;
}

// --- copy generation (template fallback; AI if key present) ---
async function genCopy(event) {
  if (!OPENAI_API_KEY) {
    // Non-AI fallback (clean and short)
    if (event.type === "TRADE") {
      const a0 = event.actors?.[0]?.team || "Team A";
      const a1 = event.actors?.[1]?.team || "Team B";
      const incoming = event.assets?.filter(x => x.in).map(x => x.in).slice(0,3).join(", ");
      return {
        title: `${a0} and ${a1} agree to trade`,
        body: `League sources confirm a trade between ${a0} and ${a1}. Headliners include ${incoming || "multiple assets"}. Early grade pending Office review.`,
        tags: ["trade", a0, a1],
      };
    } else {
      const team = event.actors?.[0]?.team || "Team";
      const adds = (event.adds || []).join(", ");
      const drops = (event.drops || []).join(", ");
      return {
        title: `${team} roster move`,
        body: `According to league circles, ${team} completed a transaction: added ${adds || "—"}${drops ? `; dropped ${drops}` : ""}.`,
        tags: ["signing", team],
      };
    }
  }

  // AI version (optional)
  const sys = `You are RABKL newsroom copy editor. Woj/Shams tone with slight parody. Headlines <= 90 chars. Facts only based on inputs.`;
  const user = JSON.stringify(event);
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `Create headline (<=90 chars) and 1-2 paragraph body for this event: ${user}` }
      ]
    })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || "";
  const [firstLine, ...rest] = text.split("\n").filter(Boolean);
  return {
    title: firstLine.replace(/^["'#\s]+|["']+$/g, ""),
    body: rest.join("\n").trim() || "Office review.",
    tags: [event.type.toLowerCase(), ...(event.actors||[]).map(a => a.team).filter(Boolean)]
  };
}

// --- write one post ---
async function writePost(event, copy) {
  await ensureDir(contentDir);
  const slugBase = (copy.title || "update").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g,"").slice(0,90);
  const slug = `${slugBase || "update"}-${event.event_id}`.slice(0,100);
  const fm = [
    "---",
    `title: "${copy.title.replace(/"/g, '\\"')}"`,
    `date: "${new Date(event.timestamp).toISOString()}"`,
    `tags: ${JSON.stringify(copy.tags || [])}`,
    `hero_image: "/images/trade-hero.png"`,
    `brand_logo: "/brand/logo.svg"`,
    "theme:",
    `  background: "#FDF6E3"`,
    `  secondary: "#FAF3DD"`,
    `  primary: "#0B1D3A"`,
    `  accent_red: "#B22234"`,
    `  accent_gold: "#F2B300"`,
    "---",
    "",
  ].join("\n");
  const md = fm + copy.body + "\n";
  const file = `${contentDir}/${slug}.md`;
  await fs.writeFile(file, md, "utf8");
  out("wrote", file);
  return file;
}

// --- main ---
(async () => {
  out("RABKL newsroom starting…");
  const bundle = await fetchBundle(LEAGUE_ID);
  const events = normalizeEvents(bundle);

  if (!events.length) {
    out("No new events found.");
    return;
  }

  const written = [];
  for (const ev of events.slice(0, 5)) { // write at most 5 per run to start
    const copy = await genCopy(ev);
    const file = await writePost(ev, copy);
    written.push(file);
  }
  out("Done. Files:", JSON.stringify(written, null, 2));
})();
