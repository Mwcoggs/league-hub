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

# Availability. Long-term statuses knock a player out of the lineup for the next
# LT_WEEKS weeks and discount him after that, since a return date is a guess.
# Week-only designations only affect the upcoming week.
LT_STATUS = {"Injured Reserve", "Physically Unable to Perform", "Non Football Injury", "Suspended"}
LT_INJURY = {"IR", "PUP", "NFI", "Sus", "DNR", "RET"}
WEEK_FACTOR = {"Out": 0.0, "NA": 0.0, "COV": 0.0, "Doubtful": 0.4, "Questionable": 0.9}
LT_WEEKS = 4             # weeks a long-term absence is treated as a zero
LT_AFTER = 0.5           # discount once he could plausibly be back

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
traded_picks = get(f"{API}/league/{LEAGUE_ID}/traded_picks") or []
DRAFT_ROUNDS = int(league["settings"].get("draft_rounds", 4))
PICK_SEASONS = [str(int(season) + 1), str(int(season) + 2)]

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

def avail(pid, w, cur):
    """Multiplier for a player's projection in week w, and why it isn't 1."""
    p = players.get(pid) or {}
    st, inj = p.get("status"), p.get("injury_status")
    if st in LT_STATUS or inj in LT_INJURY:
        tag = inj if inj in LT_INJURY else st
        return (0.0, tag) if w < cur + LT_WEEKS else (LT_AFTER, tag)
    if w == cur and inj in WEEK_FACTOR:
        return WEEK_FACTOR[inj], inj
    return 1.0, None

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
        proj[rid][w] = best_lineup([(P[w].get(p, 0.0) * avail(p, w, cur_week)[0], p) for p in t["active"]])
    # who availability is keeping out of the lineup right now
    t["out"] = []
    for p in t["active"]:
        f, tag = avail(p, cur_week, cur_week)
        if f < 1 and (P[cur_week].get(p, 0.0) > 0 or tag in LT_INJURY or tag in LT_STATUS):
            t["out"].append([name_of(p), tag or "out", round(f, 2)])
    t["out"].sort(key=lambda x: x[2])
    t["out"] = t["out"][:6]

# Full-strength lineup: what a team can start in a normal week, with nobody on a
# bye. Each player is valued at his average projection over the weeks his team
# actually plays, so byes stop deflating anyone. This is the basis for strength
# of schedule, since you never face an opponent in their bye week anyway.
base_pts = {}
for pid in {p for t in teams.values() for p in t["active"]}:
    vals = [P[w].get(pid, 0.0) for w in future_weeks if w <= REG_SEASON_END and P[w].get(pid, 0.0) > 0]
    lt = (players.get(pid) or {}).get("status") in LT_STATUS or (players.get(pid) or {}).get("injury_status") in LT_INJURY
    base_pts[pid] = (statistics.mean(vals) if vals else 0.0) * (LT_AFTER if lt else 1.0)
for rid, t in teams.items():
    t["peak"] = best_lineup([(base_pts.get(p, 0.0), p) for p in t["active"]])[0]
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
w_act = gp / (gp + 4)      # results outweigh projections from about week 5 on
DECAY = 0.85               # recent weeks count for more

def recent_avg(xs):
    ws = [DECAY ** (len(xs) - 1 - i) for i in range(len(xs))]
    return sum(x * k for x, k in zip(xs, ws)) / sum(ws)
for rid, t in teams.items():
    games = t["apw"] + t["apl"]
    t["luck"] = (t["w"] - (t["apw"] / games) * gp) if games else 0.0
    t["eff"] = (t["act"] / t["opt"] * 100) if t["opt"] else None
    t["left"] = t["opt"] - t["act"]
    t["rating"] = t["ros"] - avg
    actual_edge = (recent_avg(t["scores"]) - league_game_avg) if gp else 0
    t["power"] = (1 - w_act) * t["rating"] + w_act * actual_edge

def wp(a, b):
    return 0.5 * (1 + math.erf((a - b) / (SD * 2)))

# ---- strength of schedule + expected wins
for rid, t in teams.items():
    opp = [teams[sched[w][rid][0]]["peak"] for w in ros_weeks if rid in sched.get(w, {})]
    t["sos"] = statistics.mean(opp) if opp else 0.0
    live = [proj[sched[w][rid][0]][w][0] for w in ros_weeks if rid in sched.get(w, {})]
    t["sos_live"] = statistics.mean(live) if live else 0.0
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

# ---- team profiles: assets, window, and a written read on where each team stands
GAMES = len(ros_weeks) + len(done)
pf_rank = {r: i + 1 for i, r in enumerate(sorted(teams, key=lambda r: -teams[r]["pf"]))}
ros_rank = {r: i + 1 for i, r in enumerate(sorted(teams, key=lambda r: -teams[r]["ros"]))}
eff_rank = {r: i + 1 for i, r in enumerate(sorted(teams, key=lambda r: -(teams[r]["eff"] or 0)))}
ap_rank = {r: i + 1 for i, r in enumerate(sorted(teams, key=lambda r: -(teams[r]["apw"] / max(teams[r]["apw"] + teams[r]["apl"], 1))))}
SHAPE_KEYS = ["QB", "RB", "WR", "TE", "DEF"]

def art(n):
    """a/an for a number read aloud (8 and 11 take 'an')."""
    r = str(round(n))          # match the rounding used when the number is printed
    return "an" if r[0] == "8" or r[:2] == "11" else "a"

def ordinal(n):
    return f"{n}{'th' if 11 <= n % 100 <= 13 else {1:'st',2:'nd',3:'rd'}.get(n % 10, 'th')}"

# Value over replacement: in a one-QB league the 25th-best QB is worth nothing,
# so rank assets against the last starter the league would actually use.
STARTERS = {"QB": 1.0, "RB": 2.7, "WR": 2.7, "TE": 1.2, "K": 1.0, "DEF": 1.0}
by_pos = {}
for pid, v in base_pts.items():
    p0 = (positions_of(pid) or ["?"])[0]
    by_pos.setdefault(p0, []).append(v)
repl = {}
for p0, vals in by_pos.items():
    vals.sort(reverse=True)
    n = int(round(STARTERS.get(p0, 1.0) * len(teams)))
    repl[p0] = vals[min(n, len(vals)) - 1] if vals else 0.0

def vor(pid):
    return base_pts.get(pid, 0.0) - repl.get((positions_of(pid) or ["?"])[0], 0.0)

def age_of(pid):
    a = (players.get(pid) or {}).get("age")
    return a if isinstance(a, (int, float)) else None

for rid, t in teams.items():
    ranked = sorted(((vor(p), p) for p in t["active"]
                     if (positions_of(p) or ["?"])[0] not in ("K", "DEF")), reverse=True)
    t["assets"] = [[name_of(p), (positions_of(p) or ["?"])[0], age_of(p), round(base_pts.get(p, 0.0), 1), round(v, 1)]
                   for v, p in ranked[:5] if v > 0]
    top = [(v, p) for v, p in ranked[:10] if v > 0]
    wsum = sum(v for v, p in top if age_of(p))
    t["core_age"] = round(sum(v * age_of(p) for v, p in top if age_of(p)) / wsum, 1) if wsum else None
    t["proj_w"] = round(t["xw"])
    t["proj_l"] = GAMES - t["proj_w"]
    young = (t["core_age"] or 99) <= 25.8
    po = t["po"] * 100
    if po >= 65:
        t["status"] = "Contending"
    elif po >= 35:
        t["status"] = "In the hunt"
    elif po <= 12:
        t["status"] = "Should be tanking"
    elif young:
        t["status"] = "Building"
    else:
        t["status"] = "Purgatory"

ROUND_NAME = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th"}

# Rookie-pick ownership. Everyone starts with their own picks; traded_picks only
# lists the ones that changed hands.
owned = {rid: [] for rid in teams}
moved = {(tp["season"], tp["round"], tp["roster_id"]): tp["owner_id"] for tp in traded_picks}
for season_y in PICK_SEASONS:
    for rnd in range(1, DRAFT_ROUNDS + 1):
        for orig in teams:
            holder = moved.get((season_y, rnd, orig), orig)
            if holder in owned:
                owned[holder].append((season_y, rnd, orig))

# Projected draft order for next spring: worst finish picks first.
draft_slot = {r: i + 1 for i, r in enumerate(sorted(teams, key=lambda r: -teams[r]["exp_seed"]))}

def pick_label(season_y, rnd, orig, self_rid):
    tag = f"{season_y} {ROUND_NAME.get(rnd, str(rnd))}"
    if orig != self_rid:
        tag += f" (via {teams[orig]['name']})"
    if season_y == PICK_SEASONS[0] and rnd <= 2:
        tag += f" · proj. #{draft_slot[orig]}"
    return tag

for rid, t in teams.items():
    picks = sorted(owned[rid], key=lambda x: (x[0], x[1], draft_slot[x[2]]))
    t["picks"] = [pick_label(sy, rn, og, rid) for sy, rn, og in picks if rn <= 2][:6]
    t["pick_count"] = len(picks)
    t["firsts"] = sum(1 for sy, rn, og in picks if rn == 1)

ORDER_IDX = {r: i for i, r in enumerate(sorted(teams, key=lambda r: -teams[r]["power"]))}

def V(rid, salt, opts):
    """Spread phrasings across the league so no two write-ups sound alike,
    and rotate them week to week."""
    off = sum(ord(c) for c in salt) + cur_week * 3
    return opts[(ORDER_IDX[rid] + off) % len(opts)]

def blurb(rid):
    t = teams[rid]
    po, ch = t["po"] * 100, t["champ"] * 100
    pr, rr, apr = pf_rank[rid], ros_rank[rid], ap_rank[rid]
    best = max(SHAPE_KEYS, key=lambda k: pos[rid][k] - pos_avg[k])
    worst = min(SHAPE_KEYS, key=lambda k: pos[rid][k] - pos_avg[k])
    gap_b, gap_w = pos[rid][best] - pos_avg[best], pos[rid][worst] - pos_avg[worst]
    a = t["assets"]
    one = a[0][0] if a else None
    names = ", ".join(x[0] for x in a[:3])
    two = " and ".join(x[0] for x in a[:2]) if len(a) >= 2 else one
    age, rec, ap = t["core_age"], f"{t['w']}–{t['l']}", f"{t['apw']}–{t['apl']}"
    out = []

    # 1 — record against all-play
    if t["luck"] >= 0.8:
        out.append(V(rid, "lucky", [
            f"{rec} is a mirage. The all-play record is {ap}, {ordinal(apr)} in the league, and they score {ordinal(pr)} — "
            f"the draw has been carrying them.",
            f"Take the schedule away and this is a {ordinal(apr)}-place team: {ap} against the field, {ordinal(pr)} in points. "
            f"{rec} is the wrapping, not the gift.",
            f"They are {rec} and {ap} in all-play, which is the gap between a kind schedule and an honest one. "
            f"Scoring sits {ordinal(pr)}.",
        ]))
    elif t["luck"] <= -0.8:
        out.append(V(rid, "unlucky", [
            f"{rec} is a lie told by the schedule. All-play says {ap}, {ordinal(apr)} in the league, on {ordinal(pr)}-place scoring.",
            f"Few teams are this much better than their record: {ap} against the field, {ordinal(pr)} in points, and nothing to "
            f"show for it but {rec}.",
            f"{ap} in all-play, {ordinal(pr)} in scoring, {rec} in the standings. The wins will come if the scores hold.",
        ]))
    else:
        out.append(V(rid, "fair", [
            f"{rec} is the right record. All-play backs it at {ap}, {ordinal(apr)} in the league, with scoring {ordinal(pr)}.",
            f"Nothing is hiding here: {rec}, {ap} in all-play, {ordinal(pr)} in points scored.",
            f"They have earned {rec}. Against the whole field they are {ap}, {ordinal(apr)}, and they score {ordinal(pr)}.",
        ]))

    # 2 — the spine of the roster
    if names:
        out.append(V(rid, "spine", [
            f"{names} carry the weight.",
            f"Everything starts with {two}.",
            f"{one} is the engine, with {' and '.join(x[0] for x in a[1:3])} behind him." if len(a) >= 3 else f"{one} is the engine.",
            f"The spine is {names}.",
        ]))
    else:
        out.append("There is no centerpiece here, which is most of the problem.")

    # 3 — shape
    shape = None
    if gap_b >= 2 and gap_w <= -2:
        shape = V(rid, "both", [
            f"{best} is the edge at roughly {gap_b:.0f} points a week, {worst} the leak at about {abs(gap_w):.0f}.",
            f"They win the {best} slot by {gap_b:.0f} a week and give most of it back at {worst}, down {abs(gap_w):.0f}.",
            f"{art(gap_b).capitalize()} {gap_b:.0f}-point weekly edge at {best}, {art(abs(gap_w))} {abs(gap_w):.0f}-point hole at {worst}.",
        ])
    elif gap_b >= 2:
        shape = V(rid, "edge", [
            f"{best} is the one place they clearly beat the field, worth about {gap_b:.0f} a week.",
            f"The {best} group is {gap_b:.0f} points a week better than everyone else's.",
            f"Their edge is {best}, roughly {gap_b:.0f} points of it every week.",
        ])
    elif gap_w <= -2:
        shape = V(rid, "hole", [
            f"{worst} is the wound, costing about {abs(gap_w):.0f} points a week.",
            f"Nothing works at {worst}, and it runs {abs(gap_w):.0f} a week against them.",
            f"They lose roughly {abs(gap_w):.0f} points a week at {worst} alone.",
        ])
    if shape:
        out.append(shape)

    # 4 — self-inflicted damage
    if (t["eff"] or 100) < 88:
        out.append(V(rid, "bench", [
            f"{t['left']:.0f} points have died on their bench, {ordinal(eff_rank[rid])} in lineup efficiency.",
            f"Lineup decisions have cost them {t['left']:.0f} points, {ordinal(eff_rank[rid])} in the league at setting a roster.",
            f"They rank {ordinal(eff_rank[rid])} at starting the right guys, {t['left']:.0f} points of it wasted.",
        ]))
    elif len(t["out"]) >= 3:
        out.append(f"{len(t['out'])} starters are hurt or limited heading into this week.")

    # 5 — age and window
    if age:
        if age <= 25.8:
            out.append(V(rid, "young", [
                f"At {age} years old by production, the best version of this roster has not arrived yet.",
                f"A {age}-year-old core means the clock is running toward them, not away.",
                f"Production-weighted age of {age}: this team gets better on its own.",
            ]))
        elif age >= 27.5:
            out.append(V(rid, "old", [
                f"The {age}-year-old core is the problem — " + ("it has to happen now." if po >= 50 else "it is getting worse, not better."),
                f"At {age} by production, " + ("this is the last good year of it." if po >= 50 else "they are aging out without ever arriving."),
                f"Age {age} weighted by production: " + ("win now or don't bother." if po >= 50 else "every month of patience costs them money."),
            ]))
        else:
            out.append(V(rid, "prime", [
                f"The core is {age}, dead in its prime.",
                f"At {age} years old by production, nothing about the timeline forces a decision.",
                f"A {age}-year-old core buys them a year either way.",
            ]))

    # 6 — the projection
    title = (f"{ch:.0f}% to win it" if ch >= 15 else f"{ch:.0f}% on the title" if ch >= 1 else "no real title equity")
    out.append(V(rid, "proj", [
        f"The model finishes them {t['proj_w']}–{t['proj_l']}: {po:.0f}% to make the playoffs, {title}, {ordinal(rr)} in scoring the rest of the way.",
        f"Projected {t['proj_w']}–{t['proj_l']}, {po:.0f}% playoff odds, {title}. They project {ordinal(rr)} in weekly scoring from here.",
        f"{t['proj_w']}–{t['proj_l']} is the projection, with playoff odds at {po:.0f}% and {title}, on {ordinal(rr)}-ranked scoring going forward.",
    ]))

    # 7 — verdict
    cap = t["firsts"]
    if t["status"] == "Contending":
        out.append(V(rid, "contend", [
            f"Buy. The {worst} slot is the only thing standing between this roster and a title, and it is cheaper to fix now than in November.",
            "This is a championship roster. Nothing about it argues for patience.",
            f"The window is open and wide. Spend{' a first' if cap else ''} on {worst} and go.",
        ]))
    elif t["status"] == "In the hunt":
        out.append(V(rid, "hunt", [
            "Decide. This roster is close enough to buy into and good enough to sell out of, and doing neither ends at seventh.",
            f"One real move at {worst} makes them dangerous; standing pat makes them forgettable.",
            "They are the definition of a coin flip, and coin flips do not win leagues.",
        ]))
    elif t["status"] == "Building":
        out.append(V(rid, "build", [
            f"Stay the course. {cap} first-rounders and a young core is a plan — the only mistake available is trading it for a wild-card week." if cap
            else "Stay the course. The young core is the plan; the only mistake available is trading it for a wild-card week.",
            "Sell anyone the wrong side of 28 and let the kids take the hits. This gets good in a year.",
            "The timeline is a year out and that's fine. Price veterans aggressively and keep collecting.",
        ]))
    elif t["status"] == "Should be tanking":
        out.append(V(rid, "tank", [
            f"There is nothing here to save. {'Those ' + str(cap) + ' first-rounders are the franchise now' if cap else 'Next spring is the only asset'} — "
            f"sell every veteran with a name and finish last on purpose.",
            "Lose properly. Half-measures here produce a 5–9 team with no picks, which is how franchises stay bad for three years.",
            f"Blow it up. {one} is worth more to a contender in October than to this roster in December." if one else "Blow it up and start over.",
        ]))
    else:
        out.append(V(rid, "purg", [
            "Too old to wait and too thin to chase — the worst place to be, and the easiest to stay. Pick a side.",
            f"Nothing about this roster is going anywhere. {'The firsts are the only liquid assets' if cap else 'There is little left worth selling'}, and the price drops every week.",
            "Neither direction is being chosen, which is itself the choice, and it is the wrong one.",
        ]))
    return " ".join(out)

for rid in teams:
    teams[rid]["blurb"] = blurb(rid)

T = []
for i, rid in enumerate(order):
    t = teams[rid]
    T.append(dict(
        rid=rid, rank=i + 1, name=t["name"], owner=t["owner"], w=t["w"], l=t["l"], t=t["t"],
        pf=round(t["pf"], 1), pa=round(t["pa"], 1), ros=round(t["ros"], 1), power=round(t["power"], 1),
        peak=round(t["peak"], 1), out=t["out"], sos_live=round(t["sos_live"], 1),
        sos=round(t["sos"], 1), sosd=round(t["sos"] - sos_avg, 1), sosr=sos_rank[rid], xw=round(t["xw"], 1),
        po=round(t["po"] * 100), champ=round(t["champ"] * 100, 1), final=round(t["final"] * 100),
        seeds=t["seeds"], exp_seed=round(t["exp_seed"], 2), apw=t["apw"], apl=t["apl"], luck=round(t["luck"], 2),
        eff=round(t["eff"], 1) if t["eff"] is not None else None, act=round(t["act"], 1), opt=round(t["opt"], 1),
        left=round(t["left"], 1), bench=t["bench"],
        pos={k: round(pos[rid][k] - pos_avg[k], 1) for k in pos_keys},
        status=t["status"], proj_w=t["proj_w"], proj_l=t["proj_l"], core_age=t["core_age"],
        assets=t["assets"], blurb=t["blurb"], pfr=pf_rank[rid], rosr=ros_rank[rid],
        picks=t["picks"], firsts=t["firsts"], pick_count=t["pick_count"],
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
