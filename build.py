"""Builds data.json for the league hub from the Sleeper API.

Runs in GitHub Actions on a schedule (see .github/workflows/update.yml).
Standard library only. Lines for each week are frozen in lines.json the first
time they're posted, so pick'em spreads never move after people pick.
"""
import json, math, random, re, statistics, time, urllib.request
from datetime import datetime, timezone

LEAGUE_ID = "1312835814681509888"
REG_SEASON_END = 14      # last regular-season week
PLAYOFF_WEEKS = (15, 16, 17)
SD = 30.0                # weekly scoring noise per team, in points
SIMS = 20000
POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"]
SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"]
FLEX = ("RB", "WR", "TE")

def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "league-hub/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))

API = "https://api.sleeper.app/v1"
state = get(f"{API}/state/nfl")
league = get(f"{API}/league/{LEAGUE_ID}")
rosters = get(f"{API}/league/{LEAGUE_ID}/rosters")
users = {u["user_id"]: u for u in get(f"{API}/league/{LEAGUE_ID}/users")}
players = get(f"{API}/players/nfl")
S = league["scoring_settings"]
season = league["season"]
cur_week = int(state["week"]) if state.get("season_type") == "regular" else (18 if state.get("season_type") == "post" else 1)
if str(state.get("season")) != str(season):
    cur_week = 1 if state.get("season_type") in ("pre", "off") else cur_week

matchups = {w: get(f"{API}/league/{LEAGUE_ID}/matchups/{w}") or [] for w in range(1, REG_SEASON_END + 1)}

def proj_week(w):
    pos = "&".join(f"position%5B%5D={p}" for p in POSITIONS)
    rows = get(f"https://api.sleeper.app/projections/nfl/{season}/{w}?season_type=regular&{pos}")
    out = {}
    for p in rows or []:
        st = p.get("stats") or {}
        out[p["player_id"]] = sum(v * S[k] for k, v in st.items() if k in S and isinstance(v, (int, float)))
    return out

future_weeks = [w for w in range(max(cur_week, 1), 18)]
P = {w: proj_week(w) for w in future_weeks}

def positions_of(pid):
    if pid in players:
        return players[pid].get("fantasy_positions") or [players[pid].get("position")]
    return ["DEF"] if not pid.isdigit() else []

def name_of(pid):
    p = players.get(pid)
    if not p:
        return pid
    return p.get("full_name") or f'{p.get("first_name","")} {p.get("last_name","")}'.strip() or pid

def best_lineup(pool):
    """pool: list of (points, pid). Fills restrictive slots first, flex last."""
    pool = sorted(pool, reverse=True)
    used, total, picks = set(), 0.0, []
    order = ["QB", "K", "DEF", "TE", "RB", "RB", "WR", "WR", "FLEX", "FLEX"]
    for s in order:
        ok = FLEX if s == "FLEX" else (s,)
        for pts, pid in pool:
            if pid not in used and any(q in ok for q in positions_of(pid)):
                used.add(pid); total += pts; picks.append((s, pid, pts)); break
    picks.sort(key=lambda x: SLOTS.index(x[0]))
    return total, picks

# ---- teams
teams = {}
for r in rosters:
    rid = r["roster_id"]; u = users.get(r.get("owner_id"), {})
    name = ((u.get("metadata") or {}).get("team_name") or u.get("display_name") or f"Team {rid}").strip()
    excl = set((r.get("taxi") or []) + (r.get("reserve") or []))
    s = r.get("settings") or {}
    teams[rid] = dict(rid=rid, name=name, owner=u.get("display_name", ""), excl=excl,
                      active=[p for p in (r.get("players") or []) if p not in excl],
                      w=s.get("wins", 0), l=s.get("losses", 0), t=s.get("ties", 0),
                      pf=s.get("fpts", 0) + s.get("fpts_decimal", 0) / 100,
                      pa=s.get("fpts_against", 0) + s.get("fpts_against_decimal", 0) / 100)

sched = {}
for w, m in matchups.items():
    g = {}
    for x in m:
        if x.get("matchup_id") is not None:
            g.setdefault(x["matchup_id"], []).append(x["roster_id"])
    sched[w] = {}
    for mid, pair in g.items():
        if len(pair) == 2:
            a, b = pair
            sched[w][a] = (b, mid); sched[w][b] = (a, mid)

done = [w for w in range(1, min(cur_week, REG_SEASON_END + 1)) if any((x.get("points") or 0) > 0 for x in matchups.get(w, []))]

# ---- projections
proj = {rid: {} for rid in teams}
for rid, t in teams.items():
    for w in future_weeks:
        proj[rid][w] = best_lineup([(P[w].get(p, 0.0), p) for p in t["active"]])
ros_weeks = [w for w in future_weeks if w <= REG_SEASON_END]
calc_weeks = ros_weeks or [w for w in future_weeks] or [REG_SEASON_END]
for rid, t in teams.items():
    wk = [w for w in calc_weeks if w in proj[rid]]
    t["ros"] = statistics.mean(proj[rid][w][0] for w in wk) if wk else 0.0
avg = statistics.mean(t["ros"] for t in teams.values())

# ---- completed weeks: luck, efficiency, actual scoring
results = {}
for rid, t in teams.items():
    t.update(apw=0, apl=0, act=0.0, opt=0.0, bench=None, scores=[])
for w in done:
    m = matchups[w]; sc = {x["roster_id"]: x.get("points") or 0 for x in m}
    results[str(w)] = {str(k): round(v, 2) for k, v in sc.items()}
    for x in m:
        rid = x["roster_id"]; t = teams[rid]
        others = [o for o in sc if o != rid]
        t["apw"] += sum(sc[rid] > sc[o] for o in others); t["apl"] += sum(sc[rid] < sc[o] for o in others)
        pp = x.get("players_points") or {}
        starters = set(x.get("starters") or [])
        pool = [(pp.get(p, 0), p) for p in (x.get("players") or []) if p not in t["excl"] or p in starters]
        opt, _ = best_lineup(pool)
        t["act"] += sc[rid]; t["opt"] += max(opt, sc[rid]); t["scores"].append(sc[rid])
        for p in x.get("players") or []:
            if p not in starters and p not in t["excl"]:
                if t["bench"] is None or pp.get(p, 0) > t["bench"][1]:
                    t["bench"] = (name_of(p), round(pp.get(p, 0), 1), w)
gp = len(done)
league_game_avg = statistics.mean(s for t in teams.values() for s in t["scores"]) if gp else 0
w_act = gp / (gp + 9)
for rid, t in teams.items():
    games = t["apw"] + t["apl"]
    t["luck"] = (t["w"] - (t["apw"] / games) * gp) if games else 0.0
    t["eff"] = (t["act"] / t["opt"] * 100) if t["opt"] else None
    t["left"] = t["opt"] - t["act"]
    t["rating"] = t["ros"] - avg
    actual_edge = (statistics.mean(t["scores"]) - league_game_avg) if gp else 0
    t["power"] = (1 - w_act) * t["rating"] + w_act * actual_edge

def wp(a, b):
    return 0.5 * (1 + math.erf((a - b) / (SD * 2)))

# ---- strength of schedule + expected wins
for rid, t in teams.items():
    opp = [proj[sched[w][rid][0]][w][0] for w in ros_weeks if rid in sched.get(w, {})]
    t["sos"] = statistics.mean(opp) if opp else 0.0
    t["xw"] = t["w"] + sum(wp(proj[rid][w][0], proj[sched[w][rid][0]][w][0]) for w in ros_weeks if rid in sched.get(w, {}))
sos_avg = statistics.mean(t["sos"] for t in teams.values())

# ---- season + playoff simulation
n_play = int(league["settings"].get("playoff_teams", 6))
pw = {rid: {w: (proj[rid][w][0] if w in proj[rid] else teams[rid]["ros"]) for w in PLAYOFF_WEEKS} for rid in teams}
seedc = {rid: [0] * len(teams) for rid in teams}
champ = {rid: 0 for rid in teams}; final = {rid: 0 for rid in teams}
rng = random.Random(42)
for _ in range(SIMS):
    wins = {r: teams[r]["w"] for r in teams}; pf = {r: teams[r]["pf"] for r in teams}
    for w in ros_weeks:
        s = {r: rng.gauss(proj[r][w][0], SD) for r in teams}
        for r in teams:
            pf[r] += s[r]
            if r in sched.get(w, {}) and s[r] > s[sched[w][r][0]]:
                wins[r] += 1
    order = sorted(teams, key=lambda r: (wins[r], pf[r]), reverse=True)
    for k, r in enumerate(order):
        seedc[r][k] += 1
    if n_play == 6 and len(order) >= 6:
        sd = order[:6]
        play = lambda a, b, w: a if rng.gauss(pw[a][w], SD) > rng.gauss(pw[b][w], SD) else b
        f1 = play(sd[0], play(sd[3], sd[4], 15), 16)
        f2 = play(sd[1], play(sd[2], sd[5], 15), 16)
        final[f1] += 1; final[f2] += 1; champ[play(f1, f2, 17)] += 1

for rid, t in teams.items():
    t["seeds"] = [round(c / SIMS * 100, 1) for c in seedc[rid]]
    t["exp_seed"] = sum((k + 1) * c for k, c in enumerate(seedc[rid])) / SIMS
    t["po"] = sum(seedc[rid][:n_play]) / SIMS
    t["champ"] = champ[rid] / SIMS; t["final"] = final[rid] / SIMS
seeds = sorted(teams, key=lambda r: teams[r]["exp_seed"])

# ---- pick'em lines (frozen once posted)
try:
    lines = json.load(open("lines.json"))
except Exception:
    lines = {}
lw = cur_week
if 1 <= lw <= REG_SEASON_END and str(lw) not in lines and lw in P:
    seen, out = set(), []
    for rid in teams:
        if rid in seen or rid not in sched.get(lw, {}):
            continue
        o, mid = sched[lw][rid]; seen |= {rid, o}
        a, b = proj[rid][lw][0], proj[o][lw][0]
        fav, dog = (rid, o) if a >= b else (o, rid)
        out.append(dict(mid=mid, fav=fav, dog=dog, spread=round(abs(a - b) * 2) / 2,
                        total=round((a + b) * 2) / 2, favwp=round(wp(max(a, b), min(a, b)) * 100)))
    lines[str(lw)] = sorted(out, key=lambda x: x["spread"])
json.dump(lines, open("lines.json", "w"), indent=1)

# ---- output
order = sorted(teams, key=lambda r: -teams[r]["power"])
sos_rank = {r: i + 1 for i, r in enumerate(sorted(teams, key=lambda r: -teams[r]["sos"]))}
pos_keys = ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"]
def pos_breakdown(rid):
    agg = {k: [] for k in pos_keys}
    for w in calc_weeks:
        if w not in proj[rid]:
            continue
        tot = {k: 0.0 for k in pos_keys}
        for s, p, pts in proj[rid][w][1]:
            tot[s] += pts
        for k in pos_keys:
            agg[k].append(tot[k])
    return {k: statistics.mean(v) if v else 0 for k, v in agg.items()}
pos = {r: pos_breakdown(r) for r in teams}
pos_avg = {k: statistics.mean(pos[r][k] for r in teams) for k in pos_keys}
show_week = next((w for w in future_weeks if w in proj[order[0]]), None)

T = []
for i, rid in enumerate(order):
    t = teams[rid]
    T.append(dict(
        rid=rid, rank=i + 1, name=t["name"], owner=t["owner"], w=t["w"], l=t["l"], t=t["t"],
        pf=round(t["pf"], 1), pa=round(t["pa"], 1), ros=round(t["ros"], 1), power=round(t["power"], 1),
        sos=round(t["sos"], 1), sosd=round(t["sos"] - sos_avg, 1), sosr=sos_rank[rid], xw=round(t["xw"], 1),
        po=round(t["po"] * 100), champ=round(t["champ"] * 100, 1), final=round(t["final"] * 100),
        seeds=t["seeds"], exp_seed=round(t["exp_seed"], 2), apw=t["apw"], apl=t["apl"], luck=round(t["luck"], 2),
        eff=round(t["eff"], 1) if t["eff"] is not None else None, act=round(t["act"], 1), opt=round(t["opt"], 1),
        left=round(t["left"], 1), bench=t["bench"],
        pos={k: round(pos[rid][k] - pos_avg[k], 1) for k in pos_keys},
        core=[[name_of(p), s, round(pts, 1)] for s, p, pts in proj[rid][show_week][1]] if show_week else []))

data = dict(
    league=league.get("name", "").strip(), season=season, week=cur_week, lineup_week=show_week, done=done,
    updated=datetime.now(timezone.utc).isoformat(timespec="minutes"), avg=round(avg, 1),
    playoff_teams=n_play, teams=T, seeds=seeds[:n_play], lines=lines, results=results,
    sched={str(w): {str(r): o for r, (o, mid) in s.items()} for w, s in sched.items()},
    mids={str(w): {str(r): mid for r, (o, mid) in s.items()} for w, s in sched.items()},
    weekly={str(r): {str(w): round(proj[r][w][0], 1) for w in ros_weeks} for r in teams},
    pw={str(r): {str(w): round(v, 1) for w, v in pw[r].items()} for r in teams})
json.dump(data, open("data.json", "w"), ensure_ascii=False, separators=(",", ":"))
print(f"week {cur_week}, completed {done}, lines posted for weeks {sorted(lines, key=int)}")

# ---- keep the free Supabase project awake (any read counts as activity)
try:
    cfg = open("config.js").read()
    url = re.search(r'SUPABASE_URL:\s*"([^"]+)"', cfg).group(1)
    key = re.search(r'SUPABASE_KEY:\s*"([^"]+)"', cfg).group(1)
    if url.startswith("https://"):
        req = urllib.request.Request(f"{url}/rest/v1/rpc/submitted_teams", data=json.dumps({"p_week": cur_week}).encode(),
                                     headers={"apikey": key, "Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=30).read()
        print("supabase ping ok")
except Exception as e:
    print("supabase ping skipped:", e)
