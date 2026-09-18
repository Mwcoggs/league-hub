window.HUB_CONFIG = { SUPABASE_URL: "PASTE_PROJECT_URL", SUPABASE_KEY: "PASTE_PUBLISHABLE_KEY" };

name: Update league data

on:
  schedule:
    - cron: "15 11 * * *"   # every morning, about 7 AM Eastern
    - cron: "15 17 * * 3"   # Wednesday midday, to post the week's lines
  workflow_dispatch:         # lets you run it by hand from the Actions tab

permissions:
  contents: write

concurrency:
  group: update-data
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Build data.json from Sleeper
        run: python build.py
      - name: Commit updated data
        run: |
          git config user.name "league-hub-bot"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data.json lines.json
          git diff --cached --quiet || (git commit -m "Update league data" && git push)

{
 "2": [
  {
   "mid": 1,
   "fav": 8,
   "dog": 5,
   "spread": 2.0,
   "total": 261.5,
   "favwp": 52
  },
  {
   "mid": 5,
   "fav": 7,
   "dog": 9,
   "spread": 9.0,
   "total": 281.5,
   "favwp": 58
  },
  {
   "mid": 3,
   "fav": 3,
   "dog": 1,
   "spread": 9.5,
   "total": 271.0,
   "favwp": 59
  },
  {
   "mid": 2,
   "fav": 10,
   "dog": 4,
   "spread": 11.0,
   "total": 255.0,
   "favwp": 60
  },
  {
   "mid": 4,
   "fav": 6,
   "dog": 2,
   "spread": 13.0,
   "total": 303.0,
   "favwp": 62
  }
 ]
}
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

-- League hub: run this once in Supabase > SQL Editor > New query > Run.
-- Sets up pick'em and the loser's parlay. Safe to re-run any time.

-- ===== Pick'em =====

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.team_pins (
  team_id    int primary key,
  pin_hash   text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.picks (
  team_id    int not null,
  week       int not null,
  picks      jsonb not null,          -- {"<matchup_id>": <roster_id picked>}
  updated_at timestamptz not null default now(),
  primary key (team_id, week)
);

alter table public.team_pins enable row level security;
alter table public.picks     enable row level security;

-- When each week's picks lock: 7:00 PM Eastern on the day of that week's first game (2026 season).
-- To change a lock, edit a date or time here and re-run this file.
create or replace function public.pick_lock(p_week int)
returns timestamptz language sql stable as $$
  select (d + time '19:00') at time zone 'America/New_York'
  from (select case p_week
    when 1  then date '2026-09-10' when 2  then date '2026-09-17' when 3  then date '2026-09-24'
    when 4  then date '2026-10-01' when 5  then date '2026-10-08' when 6  then date '2026-10-15'
    when 7  then date '2026-10-22' when 8  then date '2026-10-29' when 9  then date '2026-11-05'
    when 10 then date '2026-11-12' when 11 then date '2026-11-19' when 12 then date '2026-11-25'
    when 13 then date '2026-12-03' when 14 then date '2026-12-10' when 15 then date '2026-12-17'
    when 16 then date '2026-12-24' when 17 then date '2026-12-31'
    else date '2026-09-10' + (p_week - 1) * 7 end as d) x
$$;

-- Everyone's picks become visible once that week locks.
drop policy if exists "picks visible after lock" on public.picks;
create policy "picks visible after lock" on public.picks
  for select to anon, authenticated
  using (now() >= public.pick_lock(week));

-- Save picks. The first save for a team sets its PIN; later saves must match it.
create or replace function public.submit_picks(p_team int, p_pin text, p_week int, p_picks jsonb)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare h text;
begin
  if p_team is null or p_team < 1 or p_team > 32 or p_week is null or p_week < 1 or p_week > 18 then
    raise exception 'Invalid team or week';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'object' or pg_column_size(p_picks) > 4000 then
    raise exception 'Invalid picks';
  end if;
  if now() >= public.pick_lock(p_week) then
    raise exception 'Week % picks are locked', p_week;
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN must be 4 to 8 digits';
  end if;
  select pin_hash into h from team_pins where team_id = p_team;
  if h is null then
    insert into team_pins (team_id, pin_hash) values (p_team, crypt(p_pin, gen_salt('bf')));
  elsif crypt(p_pin, h) <> h then
    perform pg_sleep(1);
    raise exception 'Wrong PIN for this team';
  end if;
  insert into picks (team_id, week, picks, updated_at) values (p_team, p_week, p_picks, now())
  on conflict (team_id, week) do update set picks = excluded.picks, updated_at = now();
  return 'saved';
end $$;

-- Load your own picks before lock (PIN required).
create or replace function public.get_my_picks(p_team int, p_pin text, p_week int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare h text; r jsonb;
begin
  select pin_hash into h from team_pins where team_id = p_team;
  if h is null then return null; end if;
  if p_pin is null or crypt(p_pin, h) <> h then
    perform pg_sleep(1);
    raise exception 'Wrong PIN for this team';
  end if;
  select picks into r from picks where team_id = p_team and week = p_week;
  return r;
end $$;

-- Which teams have picks in for a week (no picks revealed).
create or replace function public.submitted_teams(p_week int)
returns setof int language sql security definer set search_path = public as $$
  select team_id from picks where week = p_week order by team_id
$$;

-- Access for the public site key
revoke all on public.team_pins from anon, authenticated;
revoke all on public.picks from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.picks to anon, authenticated;
revoke all on function public.submit_picks(int, text, int, jsonb) from public;
revoke all on function public.get_my_picks(int, text, int) from public;
revoke all on function public.submitted_teams(int) from public;
grant execute on function public.pick_lock(int) to anon, authenticated;
grant execute on function public.submit_picks(int, text, int, jsonb) to anon, authenticated;
grant execute on function public.get_my_picks(int, text, int) to anon, authenticated;
grant execute on function public.submitted_teams(int) to anon, authenticated;

-- ===== Loser's parlay board =====
create table if not exists public.parlay_legs (
  team_id    int not null,
  week       int not null,
  leg        text not null,
  updated_at timestamptz not null default now(),
  primary key (team_id, week)
);

create table if not exists public.parlay_results (
  week       int primary key,
  status     text not null,          -- pending | hit | miss
  odds       text,                   -- e.g. "+1400"
  note       text,
  settled_by int,
  updated_at timestamptz not null default now()
);

alter table public.parlay_legs    enable row level security;
alter table public.parlay_results enable row level security;

-- Legs are due Sunday 1:00 PM Eastern (Thanksgiving week, Thursday noon).
create or replace function public.parlay_lock(p_week int)
returns timestamptz language sql stable as $$
  select case when p_week = 12
    then (date '2026-11-26' + time '12:00') at time zone 'America/New_York'
    else (((public.pick_lock(p_week) at time zone 'America/New_York')::date + 3) + time '13:00')
         at time zone 'America/New_York'
  end
$$;

drop policy if exists "legs are public" on public.parlay_legs;
create policy "legs are public" on public.parlay_legs for select to anon, authenticated using (true);
drop policy if exists "results are public" on public.parlay_results;
create policy "results are public" on public.parlay_results for select to anon, authenticated using (true);

-- Add or change your leg. Sending an empty leg removes it.
create or replace function public.submit_leg(p_team int, p_pin text, p_week int, p_leg text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare h text; t text;
begin
  if p_team is null or p_team < 1 or p_team > 32 or p_week is null or p_week < 1 or p_week > 18 then
    raise exception 'Invalid team or week';
  end if;
  if now() >= public.parlay_lock(p_week) then
    raise exception 'Week % legs are locked', p_week;
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN must be 4 to 8 digits';
  end if;
  select pin_hash into h from team_pins where team_id = p_team;
  if h is null then
    insert into team_pins (team_id, pin_hash) values (p_team, crypt(p_pin, gen_salt('bf')));
  elsif crypt(p_pin, h) <> h then
    perform pg_sleep(1);
    raise exception 'Wrong PIN for this team';
  end if;
  t := btrim(coalesce(p_leg, ''));
  if t = '' then
    delete from parlay_legs where team_id = p_team and week = p_week;
    return 'removed';
  end if;
  if length(t) > 140 then raise exception 'Keep the leg under 140 characters'; end if;
  insert into parlay_legs (team_id, week, leg, updated_at) values (p_team, p_week, t, now())
  on conflict (team_id, week) do update set leg = excluded.leg, updated_at = now();
  return 'saved';
end $$;

-- Whoever placed the bet records how it went.
create or replace function public.settle_parlay(p_team int, p_pin text, p_week int, p_status text, p_odds text, p_note text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare h text;
begin
  if p_status not in ('pending', 'hit', 'miss') then raise exception 'Status must be pending, hit or miss'; end if;
  if length(coalesce(p_odds, '')) > 20 or length(coalesce(p_note, '')) > 140 then raise exception 'Odds or note too long'; end if;
  select pin_hash into h from team_pins where team_id = p_team;
  if h is null or p_pin is null or crypt(p_pin, h) <> h then
    perform pg_sleep(1);
    raise exception 'Wrong PIN for this team';
  end if;
  insert into parlay_results (week, status, odds, note, settled_by, updated_at)
  values (p_week, p_status, nullif(btrim(coalesce(p_odds,'')),''), nullif(btrim(coalesce(p_note,'')),''), p_team, now())
  on conflict (week) do update set status = excluded.status, odds = excluded.odds, note = excluded.note,
    settled_by = excluded.settled_by, updated_at = now();
  return 'saved';
end $$;

revoke all on public.parlay_legs from anon, authenticated;
revoke all on public.parlay_results from anon, authenticated;
grant select on public.parlay_legs, public.parlay_results to anon, authenticated;
revoke all on function public.submit_leg(int, text, int, text) from public;
revoke all on function public.settle_parlay(int, text, int, text, text, text) from public;
grant execute on function public.parlay_lock(int) to anon, authenticated;
grant execute on function public.submit_leg(int, text, int, text) to anon, authenticated;
grant execute on function public.settle_parlay(int, text, int, text, text, text) to anon, authenticated;

<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>League hub</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#EEF1EC; --panel:#FFFFFF; --ink:#18263A; --muted:#5B6878; --rule:#D5DBD3;
  --pos:#2E7250; --neg:#B23A48; --gold:#A67A06; --track:#E2E7E0; --chip:#E8EDE6; --sel:#18263A; --selink:#FFFFFF;
  --display:"Barlow Condensed","Arial Narrow","Roboto Condensed",sans-serif;
  --body:"Barlow","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#101A26; --panel:#172333; --ink:#E8EDF2; --muted:#9AA8B8; --rule:#2A384A;
    --pos:#5BBF8A; --neg:#E2707E; --gold:#E0B04A; --track:#233246; --chip:#223044; --sel:#E8EDF2; --selink:#101A26;
  }
}
:root[data-theme="dark"]{
  --bg:#101A26; --panel:#172333; --ink:#E8EDF2; --muted:#9AA8B8; --rule:#2A384A;
  --pos:#5BBF8A; --neg:#E2707E; --gold:#E0B04A; --track:#233246; --chip:#223044; --sel:#E8EDF2; --selink:#101A26;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.45;font-variant-numeric:tabular-nums}
main{max-width:760px;margin:0 auto;padding:28px 16px 64px}
header h1{font-family:var(--display);font-weight:800;font-size:clamp(2.2rem,8vw,3.4rem);line-height:.95;margin:0 0 10px;letter-spacing:-.01em}
header p{margin:0;color:var(--muted);max-width:60ch}
nav{position:sticky;top:0;z-index:5;background:var(--bg);margin:20px -16px 0;padding:10px 16px;overflow-x:auto;white-space:nowrap;border-bottom:1px solid var(--rule)}
nav button{font:600 1.05rem var(--display);letter-spacing:.01em;color:var(--muted);background:none;border:0;padding:6px 12px;border-radius:999px;cursor:pointer}
nav button[aria-selected="true"]{background:var(--sel);color:var(--selink)}
nav button:focus-visible,button:focus-visible,summary:focus-visible,select:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
section[hidden]{display:none}
h2{font-family:var(--display);font-weight:700;font-size:1.75rem;margin:30px 0 4px}
h3{font-family:var(--display);font-weight:700;font-size:1.3rem;margin:26px 0 8px}
.lede{color:var(--muted);margin:0 0 16px;max-width:62ch}
.panel{background:var(--panel);border:1px solid var(--rule);border-radius:10px;overflow:hidden}
details.row{border-top:1px solid var(--rule)}
details.row:first-child{border-top:0}
summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:2.2rem 1fr auto;gap:10px;align-items:center;padding:12px 14px}
summary::-webkit-details-marker{display:none}
.rk{font-family:var(--display);font-weight:800;font-size:1.9rem;line-height:1;text-align:center}
.tn{font-weight:600;line-height:1.2}
.ow{color:var(--muted);font-size:.85rem}
.rt{font-family:var(--display);font-weight:700;font-size:1.5rem;text-align:right;min-width:4.2rem}
.rt small{display:block;font-family:var(--body);font-weight:500;font-size:.72rem;color:var(--muted);margin-top:-2px}
.bar{height:8px;position:relative;background:var(--track);border-radius:4px}
summary .bar,summary .stats{grid-column:2 / 4}
.bar i{position:absolute;top:0;bottom:0;border-radius:4px}
.bar b{position:absolute;left:50%;top:-3px;bottom:-3px;width:2px;background:var(--muted);opacity:.6}
.bar.fill b{display:none}
.stats{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.84rem;color:var(--muted)}
.stats strong{color:var(--ink);font-weight:600}
.detail{padding:4px 14px 16px calc(2.2rem + 24px)}
.detail h4{font-size:.9rem;font-weight:600;margin:10px 0 6px}
.pos{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.pos div{background:var(--chip);border-radius:6px;padding:5px 2px;text-align:center;font-size:.78rem}
.pos span{display:block;font-weight:600;font-size:.9rem}
.core{margin:0;padding:0;list-style:none;columns:2;column-gap:16px;font-size:.84rem}
.core li{break-inside:avoid;display:flex;justify-content:space-between;gap:6px;padding:2px 0;border-bottom:1px dotted var(--rule)}
.core em{font-style:normal;color:var(--muted);width:2.6rem;flex:none}
.core li span:first-of-type{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list{padding:4px 14px}
.lrow{display:grid;grid-template-columns:minmax(0,1fr) 38% 3.6rem;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--rule);font-size:.9rem}
.lrow:first-child{border-top:0}
.lrow .t{min-width:0}
.lrow .t b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lrow .t span{color:var(--muted);font-size:.8rem}
.lrow .v{text-align:right;font-family:var(--display);font-weight:700;font-size:1.2rem}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{padding:8px 10px;text-align:left;border-top:1px solid var(--rule)}
thead th{border-top:0;font-weight:600;color:var(--muted);font-size:.8rem}
td.num,th.num{text-align:right}
.wp{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.wp i{display:block;width:54px;height:6px;border-radius:3px;background:var(--track);position:relative;overflow:hidden}
.wp i::after{content:"";position:absolute;inset:0 auto 0 0;width:var(--w);background:var(--c)}
select{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:8px 10px;max-width:100%}
.pickwrap{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
/* bracket */
.bracket{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;min-width:560px;padding:14px}
.round h4{font:600 .85rem var(--body);color:var(--muted);margin:0 0 8px}
.round{display:flex;flex-direction:column;justify-content:space-around;gap:14px}
.game{border:1px solid var(--rule);border-radius:8px;overflow:hidden;background:var(--bg)}
.slot{display:grid;grid-template-columns:1.4rem 1fr auto;gap:6px;padding:7px 9px;font-size:.84rem;align-items:center}
.slot+.slot{border-top:1px solid var(--rule)}
.slot .sd{font-family:var(--display);font-weight:800;color:var(--muted)}
.slot .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.slot .pc{color:var(--muted);font-size:.78rem}
.slot.tbd .nm{font-weight:400;color:var(--muted)}
.heat{border-collapse:separate;border-spacing:2px;font-size:.78rem;min-width:520px}
.heat th,.heat td{border:0;padding:5px 4px;text-align:center}
.heat td{border-radius:4px}
.heat th:first-child,.heat td:first-child{text-align:left;white-space:nowrap;max-width:9rem;overflow:hidden;text-overflow:ellipsis}
/* pickem */
.game-pick{padding:12px 14px;border-top:1px solid var(--rule)}
.game-pick:first-child{border-top:0}
.game-pick .meta{font-size:.8rem;color:var(--muted);margin-bottom:8px}
.sides{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.side{font:inherit;text-align:left;color:var(--ink);background:var(--chip);border:1.5px solid transparent;border-radius:8px;padding:9px 10px;cursor:pointer;min-width:0}
.side b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9rem}
.side span{font-family:var(--display);font-weight:700;font-size:1.15rem}
.side[aria-pressed="true"]{background:var(--sel);color:var(--selink)}
.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
.btn{font:600 1rem var(--body);color:var(--selink);background:var(--sel);border:0;border-radius:8px;padding:10px 16px;cursor:pointer}
.btn[disabled]{opacity:.45;cursor:default}
.note{font-size:.85rem;color:var(--muted)}
.btn.ghost{background:transparent;color:var(--ink);border:1.5px solid var(--rule)}
input{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:8px 10px;width:7.5rem}
input:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:12px 14px}
.chip{font-size:.82rem;padding:4px 10px;border-radius:999px;background:var(--chip);color:var(--muted)}
.chip.in{background:var(--sel);color:var(--selink)}
.grid td.hit{color:var(--pos);font-weight:600}.grid td.miss{color:var(--neg)}.grid td{white-space:nowrap}
textarea{width:100%;min-height:150px;margin-top:10px;font:.85rem/1.4 var(--body);color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:10px}
.empty{padding:18px 14px;color:var(--muted);font-size:.9rem}
.award{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px}
.award div{background:var(--panel);border:1px solid var(--rule);border-radius:10px;padding:10px 12px}
.award small{display:block;color:var(--muted);font-size:.78rem}
.award b{display:block;font-weight:600;line-height:1.2;margin:2px 0}
.award span{font-family:var(--display);font-weight:700;font-size:1.25rem}
.method{margin-top:44px;font-size:.9rem;color:var(--muted);max-width:64ch}
.method p{margin:0 0 10px}
.up{color:var(--pos)} .dn{color:var(--neg)}
@media (max-width:480px){.detail{padding-left:14px}.core{columns:1}.lrow{grid-template-columns:minmax(0,1fr) 30% 3.2rem}.award{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
<header>
<h1 id="title">League hub</h1>
<p id="sub"></p>
</header>
<nav role="tablist" aria-label="Sections">
  <button role="tab" data-tab="rank" aria-selected="true">Rankings</button>
  <button role="tab" data-tab="bracket" aria-selected="false">Playoffs</button>
  <button role="tab" data-tab="pick" aria-selected="false">Pick'em</button>
  <button role="tab" data-tab="parlay" aria-selected="false">Parlay</button>
  <button role="tab" data-tab="luck" aria-selected="false">Luck</button>
  <button role="tab" data-tab="eff" aria-selected="false">Lineups</button>
  <button role="tab" data-tab="sched" aria-selected="false">Schedule</button>
</nav>

<section id="rank" role="tabpanel">
  <h2>Power ranking</h2>
  <p class="lede">Rating is projected points per week above or below the league average of <strong id="avg"></strong>. Tap a team for positional edges and its projected lineup.</p>
  <div class="panel" id="board"></div>
</section>

<section id="bracket" role="tabpanel" hidden>
  <h2>Projected playoff bracket</h2>
  <p class="lede">Seeds by average finish across 20,000 simulated seasons. Top 6 make it, seeds 1 and 2 get byes. Percentages are each team's chance to win that projected game.</p>
  <div class="panel scroll"><div class="bracket" id="br"></div></div>
  <h3>Title odds</h3>
  <div class="panel list" id="champ"></div>
  <h3>Seed chances</h3>
  <p class="lede">How often each team finished in each seed. Seeds 7–10 miss the playoffs.</p>
  <div class="panel scroll" style="padding:8px"><table class="heat" id="heat"></table></div>
</section>

<section id="pick" role="tabpanel" hidden>
  <h2 id="pickTitle">Pick'em</h2>
  <p class="lede" id="lockLine">Pick every game against the spread. Everyone's picks are revealed when the week locks.</p>
  <div class="panel" id="pickSetup" hidden><div class="empty">Pick'em isn't connected yet. Add your Supabase project URL and key to config.js.</div></div>
  <div id="pickUI">
    <div class="pickwrap">
      <label for="picker">Team</label><select id="picker"><option value="">Choose your team</option></select>
      <label for="pin">PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]*" maxlength="8" placeholder="4–8 digits">
    </div>
    <p class="note" style="margin:-4px 0 12px">Your first save sets your team's PIN. Use the same PIN to change picks until lock.</p>
    <div class="panel" id="games"></div>
    <div class="actions">
      <button class="btn" id="save" disabled>Save picks</button>
      <button class="btn ghost" id="load">Load my picks</button>
      <span class="note" id="saveNote" aria-live="polite"></span>
    </div>
    <h3 id="inTitle">Who's in</h3>
    <div class="panel" id="inList"></div>
  </div>
  <h3>Leaderboard</h3>
  <div class="panel" id="board2"><div class="empty">Loading…</div></div>
</section>

<section id="parlay" role="tabpanel" hidden>
  <h2 id="parlayTitle">Loser's parlay</h2>
  <p class="lede" id="parlayLede">Everyone adds one leg. Last week's low scorer places the bet.</p>
  <div class="panel" id="parlaySetup" hidden><div class="empty">The parlay board isn't connected yet. Add your Supabase project URL and key to config.js and run setup-parlay.sql.</div></div>
  <div id="parlayUI">
    <div class="award" id="onHook"></div>
    <div class="panel list" id="legs"></div>
    <h3>Your leg</h3>
    <div class="pickwrap">
      <label for="legTeam">Team</label><select id="legTeam"><option value="">Choose your team</option></select>
      <label for="legPin">PIN</label><input id="legPin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="4–8 digits">
    </div>
    <input id="legText" maxlength="140" placeholder="e.g. Bijan Robinson over 85.5 rush yards" style="width:100%">
    <div class="actions">
      <button class="btn" id="legSave">Save my leg</button>
      <button class="btn ghost" id="legCopy">Copy all legs</button>
      <span class="note" id="legNote" aria-live="polite"></span>
    </div>
    <textarea id="legOut" readonly hidden aria-label="All legs"></textarea>
    <details class="panel" style="margin-top:20px;padding:12px 14px">
      <summary style="display:block;padding:0;font-weight:600;cursor:pointer">Record how it went</summary>
      <p class="note" style="margin:8px 0 10px">Whoever placed the bet fills this in, using their own team and PIN above.</p>
      <div class="pickwrap">
        <label for="stStatus">Result</label><select id="stStatus"><option value="pending">Pending</option><option value="hit">Hit</option><option value="miss">Miss</option></select>
        <label for="stOdds">Odds</label><input id="stOdds" maxlength="20" placeholder="+1400" style="width:6rem">
      </div>
      <input id="stNote" maxlength="140" placeholder="Optional note, e.g. died on the last leg" style="width:100%">
      <div class="actions"><button class="btn" id="stSave">Save result</button><span class="note" id="stNoteMsg" aria-live="polite"></span></div>
    </details>
    <h3>Parlay history</h3>
    <div class="panel" id="parlayHist"></div>
  </div>
</section>

<section id="luck" role="tabpanel" hidden>
  <h2>Luck index</h2>
  <p class="lede">All-play record is how a team would do against every other team each week. Luck is actual wins minus the wins that all-play rate would earn. Positive means the schedule has been kind.</p>
  <div class="panel list" id="luckList"></div>
</section>

<section id="eff" role="tabpanel" hidden>
  <h2>Manager efficiency</h2>
  <p class="lede">Points actually started as a share of the best possible lineup from the same roster. Taxi and IR players aren't counted.</p>
  <div class="award" id="awards"></div>
  <div class="panel list" id="effList"></div>
</section>

<section id="sched" role="tabpanel" hidden>
  <h2>Rest-of-season strength of schedule</h2>
  <p class="lede">Average projected score of each opponent in the week you face them, byes included. The whole spread is under 5 points a week, so schedule is a small factor in this league.</p>
  <div class="panel list" id="sos"></div>
  <h3>Weekly outlook</h3>
  <div class="pickwrap"><label for="pickT">Team</label><select id="pickT"></select></div>
  <div class="panel scroll"><table style="min-width:420px"><thead><tr><th>Wk</th><th>Opponent</th><th class="num">Proj</th><th class="num">Opp</th><th class="num">Win chance</th></tr></thead><tbody id="rows"></tbody></table></div>
</section>

<section class="method">
<h2>How it's built</h2>
<p>Player projections come from Sleeper's weekly feed, rescored with this league's rules (6-point passing TDs, full PPR, custom kicker and defense scoring). Each week the model starts the highest-projected legal lineup from active roster players; taxi and IR spots are excluded and players on bye score zero.</p>
<p>Power score blends the rest-of-season rating with actual points versus average; actual results count 10% after week 1 and grow to 50% by week 9. Win chances assume each team's weekly score varies by about 30 points around its projection. Playoff seeding uses wins, then points for, and the bracket runs 4 vs 5 and 3 vs 6 in week 15, with the winners facing seeds 1 and 2 in week 16 and the final in week 17.</p>
<p>The loser's parlay board is on the honor system: everyone adds a leg before Sunday 1:00 PM Eastern, the previous week's low scorer places it, and whoever placed it records the result.</p>
<p>Data refreshes every morning from Sleeper. Spreads are the projected margin rounded to the nearest half point and are frozen once posted. Later-week projections are rougher and don't know about future injuries or trades.</p>
</section>
</main>
<script src="config.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const sg=(v,d=1)=>(v>0?"+":v<0?"−":"")+Math.abs(v).toFixed(d);
const erf=x=>{const s=Math.sign(x);x=Math.abs(x);const a=1/(1+0.3275911*x);return s*(1-(((((1.061405429*a-1.453152027)*a)+1.421413741)*a-0.284496736)*a+0.254829592)*a*Math.exp(-x*x));};
const wpc=(a,b)=>0.5*(1+erf((a-b)/60));
const store={get(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
const divBar=(v,max,goodPos=true)=>{const pct=max?Math.abs(v)/max*50:0,left=v>=0?50:50-pct;const c=(v>=0)===goodPos?'var(--pos)':'var(--neg)';return {html:`<span class="bar" aria-hidden="true"><b></b><i style="left:${left}%;width:${pct}%;background:${c}"></i></span>`,c}};
const $=id=>document.getElementById(id);

// tabs
const tabs=[...document.querySelectorAll('nav button')];
function show(id){tabs.forEach(b=>{const on=b.dataset.tab===id;b.setAttribute('aria-selected',on);$(b.dataset.tab).hidden=!on});store.set('hubtab',id)}
tabs.forEach(b=>b.addEventListener('click',()=>show(b.dataset.tab)));
const saved=store.get('hubtab'); if(saved&&$(saved)) show(saved);

fetch('data.json?v='+Date.now()).then(r=>{if(!r.ok) throw new Error(r.status);return r.json()}).then(init).catch(e=>{
  $('sub').textContent='League data hasn\'t been built yet. Run the "Update league data" workflow in GitHub Actions, then reload.';
});

function init(DATA){
const T=DATA.teams, byId={}; T.forEach(t=>byId[t.rid]=t);
const updated=new Date(DATA.updated);
$('title').innerHTML=esc(DATA.league||'League')+'<br>League hub';
document.title=(DATA.league||'League')+' hub';
$('sub').textContent=`Week ${DATA.week}, updated ${updated.toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}. Power ratings, playoff odds, luck, lineup grades and a live pick'em.`;
$('avg').textContent=DATA.avg.toFixed(1);

// rankings
const maxP=Math.max(...T.map(t=>Math.abs(t.power)))||1;
$('board').innerHTML=T.map(t=>{
  const b=divBar(t.power,maxP);
  const pos=Object.entries(t.pos).map(([k,v])=>`<div>${k}<span class="${v>0.2?'up':v<-0.2?'dn':''}">${sg(v)}</span></div>`).join('');
  const core=t.core.map(c=>`<li><em>${c[1]}</em><span>${esc(c[0])}</span><span>${c[2].toFixed(1)}</span></li>`).join('');
  return `<details class="row"><summary>
    <span class="rk">${t.rank}</span>
    <span><span class="tn">${esc(t.name)}</span><br><span class="ow">${esc(t.owner)}, ${t.w}–${t.l}${t.t?'–'+t.t:''}</span></span>
    <span class="rt" style="color:${b.c}">${sg(t.power)}<small>power</small></span>
    ${b.html}
    <span class="stats"><span>ROS <strong>${t.ros.toFixed(1)}</strong>/wk</span><span>Exp. wins <strong>${t.xw.toFixed(1)}</strong></span><span>Playoffs <strong>${t.po}%</strong></span><span>Title <strong style="color:var(--gold)">${t.champ<1?'<1':t.champ.toFixed(0)}%</strong></span></span>
  </summary><div class="detail">
    <h4>Positional edge vs. league average (pts/wk)</h4><div class="pos">${pos}</div>
    ${core?`<h4>Projected week ${DATA.lineup_week} lineup</h4><ul class="core">${core}</ul>`:''}
  </div></details>`}).join('');

// bracket
(function(){
  const s=DATA.seeds, pw=DATA.pw;
  if(!s||s.length<6){$('br').innerHTML='<div class="empty">Bracket view supports 6-team playoffs.</div>';return}
  const slot=(rid,seed,p)=>`<div class="slot"><span class="sd">${seed}</span><span class="nm">${esc(byId[rid].name)}</span><span class="pc">${p}%</span></div>`;
  const game=(a,sa,b,sb,w)=>{const p=Math.round(wpc(pw[a][w],pw[b][w])*100);return {html:`<div class="game">${slot(a,sa,p)}${slot(b,sb,100-p)}</div>`,win:p>=50?[a,sa]:[b,sb]}};
  const g45=game(s[3],4,s[4],5,15), g36=game(s[2],3,s[5],6,15);
  const sf1=game(s[0],1,g45.win[0],g45.win[1],16), sf2=game(s[1],2,g36.win[0],g36.win[1],16);
  const fin=game(sf1.win[0],sf1.win[1],sf2.win[0],sf2.win[1],17);
  $('br').innerHTML=`<div class="round"><h4>Round 1, week 15</h4>${g45.html}${g36.html}</div>
    <div class="round"><h4>Semifinals, week 16</h4>${sf1.html}${sf2.html}</div>
    <div class="round"><h4>Final, week 17</h4>${fin.html}</div>`;
  const ch=[...T].sort((a,b)=>b.champ-a.champ), mx=ch[0].champ||1;
  $('champ').innerHTML=ch.map(t=>`<div class="lrow"><span class="t"><b>${esc(t.name)}</b><span>Final ${t.final}%, playoffs ${t.po}%</span></span><span class="bar fill"><i style="left:0;width:${t.champ/mx*100}%;background:var(--gold)"></i></span><span class="v">${t.champ<1?'<1':t.champ.toFixed(0)}%</span></div>`).join('');
  const bySeed=[...T].sort((a,b)=>a.exp_seed-b.exp_seed), n=T.length;
  let h='<thead><tr><th>Team</th>'+[...Array(n)].map((_,i)=>`<th>${i+1}</th>`).join('')+'</tr></thead><tbody>';
  bySeed.forEach(t=>{h+=`<tr><td title="${esc(t.name)}">${esc(t.name)}</td>`+t.seeds.map((v,i)=>{const a=Math.min(v/60,1)*80;const base=i<DATA.playoff_teams?'var(--pos)':'var(--neg)';return `<td style="background:color-mix(in srgb, ${base} ${a.toFixed(0)}%, transparent);${a>45?'color:var(--selink)':''}">${v>=1?Math.round(v):v>0?'·':''}</td>`}).join('')+'</tr>'});
  $('heat').innerHTML=h+'</tbody>';
})();

// luck
(function(){
  if(!DATA.done.length){$('luckList').innerHTML='<div class="empty">Luck shows up after week 1 is scored.</div>';return}
  const L=[...T].sort((a,b)=>b.luck-a.luck), mx=Math.max(...T.map(t=>Math.abs(t.luck)))||1;
  $('luckList').innerHTML=L.map(t=>{const b=divBar(t.luck,mx);return `<div class="lrow"><span class="t"><b>${esc(t.name)}</b><span>${t.w}–${t.l} actual, ${t.apw}–${t.apl} all-play, PF ${t.pf.toFixed(1)}, PA ${t.pa.toFixed(1)}</span></span>${b.html}<span class="v" style="color:${b.c}">${sg(t.luck,2)}</span></div>`}).join('');
})();

// efficiency
(function(){
  if(!DATA.done.length){$('effList').innerHTML='<div class="empty">Lineup grades show up after week 1 is scored.</div>';return}
  const E=[...T].sort((a,b)=>b.eff-a.eff), worst=[...T].sort((a,b)=>b.left-a.left)[0], bb=[...T].filter(t=>t.bench).sort((a,b)=>b.bench[1]-a.bench[1])[0];
  $('awards').innerHTML=`<div><small>Best lineup management</small><b>${esc(E[0].name)}</b><span>${E[0].eff.toFixed(1)}%</span></div>
   <div><small>Most left on the bench</small><b>${esc(worst.name)}</b><span>${worst.left.toFixed(1)} pts</span></div>`+
   (bb?`<div><small>Biggest bench game</small><b>${esc(bb.bench[0])}, ${esc(bb.name)}</b><span>${bb.bench[1].toFixed(1)} pts, wk ${bb.bench[2]}</span></div>`:'');
  $('effList').innerHTML=E.map(t=>{const c=t.eff>=90?'var(--pos)':t.eff>=80?'var(--gold)':'var(--neg)';
    return `<div class="lrow"><span class="t"><b>${esc(t.name)}</b><span>${t.act.toFixed(1)} of ${t.opt.toFixed(1)} possible, ${t.left.toFixed(1)} left on bench</span></span><span class="bar fill"><i style="left:0;width:${Math.max(0,(t.eff-50)*2)}%;background:${c}"></i></span><span class="v" style="color:${c}">${t.eff.toFixed(0)}%</span></div>`}).join('');
})();

// schedule
(function(){
  const S=[...T].sort((a,b)=>a.sosr-b.sosr), mx=Math.max(...T.map(t=>Math.abs(t.sosd)))||1;
  $('sos').innerHTML=S.map(t=>{const b=divBar(t.sosd,mx,false);return `<div class="lrow"><span class="t"><b>${t.sosr}. ${esc(t.name)}</b><span>Opponents average ${t.sos.toFixed(1)}</span></span>${b.html}<span class="v" style="color:${b.c}">${sg(t.sosd)}</span></div>`}).join('');
  const pick=$('pickT'), rows=$('rows');
  T.forEach(t=>pick.insertAdjacentHTML('beforeend',`<option value="${t.rid}">${esc(t.name)}</option>`));
  function render(rid){let h='';Object.keys(DATA.weekly[rid]||{}).map(Number).sort((a,b)=>a-b).forEach(w=>{const o=DATA.sched[w][rid],me=DATA.weekly[rid][w],op=DATA.weekly[o][w];const pc=Math.round(wpc(me,op)*100),c=pc>=50?'var(--pos)':'var(--neg)';
    h+=`<tr><td>${w}</td><td>${esc(byId[o].name)}</td><td class="num">${me.toFixed(1)}</td><td class="num">${op.toFixed(1)}</td><td class="num"><span class="wp"><i style="--w:${pc}%;--c:${c}"></i>${pc}%</span></td></tr>`});rows.innerHTML=h||'<tr><td colspan="5">Regular season is over.</td></tr>'}
  pick.addEventListener('change',e=>render(e.target.value)); render(T[0].rid);
})();

// pick'em and parlay
pickem(DATA,T,byId);
parlay(DATA,T,byId);
}

let _sb;
function client(){
  const cfg=window.HUB_CONFIG||{};
  if(!(cfg.SUPABASE_URL&&/^https:\/\//.test(cfg.SUPABASE_URL)&&window.supabase)) return null;
  if(!_sb) _sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_KEY,{auth:{persistSession:false}});
  return _sb;
}

async function pickem(DATA,T,byId){
  const ready=!!client();
  const wk=DATA.week, lines=(DATA.lines||{})[wk]||[];
  const lab=sp=>sp?sp.toFixed(1):'PK';
  $('pickTitle').textContent=`Week ${wk} pick'em against the spread`;
  if(!ready){$('pickSetup').hidden=false;$('pickUI').hidden=true;$('board2').innerHTML='<div class="empty">Leaderboard appears once pick\'em is connected.</div>';return}
  const sb=client();
  const picker=$('picker'), pin=$('pin'), note=$('saveNote');
  T.forEach(t=>picker.insertAdjacentHTML('beforeend',`<option value="${t.rid}">${esc(t.name)}</option>`));
  const prefs=store.get('hubpick')||{}; if(prefs.team) picker.value=prefs.team;
  let mine={}, locked=false, lockAt=null;

  const {data:lockData}=await sb.rpc('pick_lock',{p_week:wk});
  if(lockData){lockAt=new Date(lockData); locked=Date.now()>=lockAt}
  function lockText(){
    if(!lockAt) return 'Pick every game against the spread.';
    const when=lockAt.toLocaleString([], {weekday:'long',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    if(locked) return `Picks locked ${when}. Everyone's picks are below.`;
    const ms=lockAt-Date.now(), h=Math.floor(ms/36e5), m=Math.floor(ms%36e5/6e4);
    return `Picks lock ${when} (${h>=24?Math.floor(h/24)+'d '+(h%24)+'h':h+'h '+m+'m'} left). Everyone's picks are revealed at lock.`;
  }
  $('lockLine').textContent=lockText();

  function renderGames(){
    $('games').innerHTML=lines.map(g=>{
      const f=byId[g.fav], d=byId[g.dog];
      return `<div class="game-pick"><div class="meta">Total ${g.total.toFixed(1)}, favorite wins ${g.favwp}% of the time</div><div class="sides">
        <button class="side" data-m="${g.mid}" data-r="${g.fav}" aria-pressed="${mine[g.mid]==g.fav}" ${locked?'disabled':''}><b>${esc(f.name)}</b><span>${g.spread?'−'+lab(g.spread):'PK'}</span></button>
        <button class="side" data-m="${g.mid}" data-r="${g.dog}" aria-pressed="${mine[g.mid]==g.dog}" ${locked?'disabled':''}><b>${esc(d.name)}</b><span>${g.spread?'+'+lab(g.spread):'PK'}</span></button>
      </div></div>`}).join('')||'<div class="empty">Lines for this week post Wednesday.</div>';
    const n=lines.filter(g=>mine[g.mid]!=null).length;
    $('save').disabled=locked||!lines.length||n<lines.length;
    $('load').hidden=locked;
    if(!locked&&lines.length&&!note.dataset.hold) note.textContent=n<lines.length?`${n} of ${lines.length} picked`:'';
  }
  $('games').addEventListener('click',e=>{const b=e.target.closest('.side');if(!b||locked)return;mine[b.dataset.m]=Number(b.dataset.r);delete note.dataset.hold;renderGames()});
  picker.addEventListener('change',()=>{prefs.team=picker.value;store.set('hubpick',prefs);mine={};renderGames()});
  const check=()=>{if(!picker.value){note.textContent='Choose your team first.';return false}if(!/^\d{4,8}$/.test(pin.value)){note.textContent='Enter a 4–8 digit PIN.';return false}return true};
  const hold=t=>{note.dataset.hold=1;note.textContent=t};
  $('save').addEventListener('click',async()=>{
    if(!check())return; $('save').disabled=true; hold('Saving…');
    const {error}=await sb.rpc('submit_picks',{p_team:Number(picker.value),p_pin:pin.value,p_week:wk,p_picks:mine});
    hold(error?error.message:'Picks saved. You can change them until lock.');
    renderGames(); loadIn();
  });
  $('load').addEventListener('click',async()=>{
    if(!check())return; hold('Loading…');
    const {data,error}=await sb.rpc('get_my_picks',{p_team:Number(picker.value),p_pin:pin.value,p_week:wk});
    if(error){hold(error.message);return}
    if(!data){hold('No saved picks for this team yet.');return}
    mine=data; hold('Loaded your saved picks.'); renderGames();
  });

  async function loadIn(){
    if(!locked){
      $('inTitle').textContent="Who's in";
      const {data}=await sb.rpc('submitted_teams',{p_week:wk});
      const set=new Set((data||[]).map(Number));
      $('inList').innerHTML=`<div class="chips">${T.map(t=>`<span class="chip ${set.has(t.rid)?'in':''}">${set.has(t.rid)?'✓ ':''}${esc(t.name)}</span>`).join('')}</div>`;
    }
  }
  renderGames(); loadIn();

  // all visible (locked) picks → reveal grid + leaderboard
  const {data:all,error}=await sb.from('picks').select('team_id,week,picks');
  if(error){$('board2').innerHTML=`<div class="empty">Couldn't load picks: ${esc(error.message)}</div>`;return}
  const res=DATA.results||{};
  const grade=(w,g,pick)=>{const r=res[w];if(!r||pick==null)return null;const m=r[g.fav]-r[g.dog]-g.spread;return m===0?'push':((m>0)===(pick==g.fav)?'win':'loss')};
  if(locked){
    $('inTitle').textContent=`Week ${wk} picks`;
    const wkPicks=(all||[]).filter(p=>p.week==wk);
    if(!wkPicks.length){$('inList').innerHTML='<div class="empty">Nobody picked this week.</div>'}
    else{
      let h='<div class="scroll"><table class="grid"><thead><tr><th>Team</th>'+lines.map(g=>`<th>${esc(byId[g.fav].name.slice(0,10))} −${lab(g.spread)}</th>`).join('')+'</tr></thead><tbody>';
      wkPicks.forEach(p=>{h+=`<tr><td>${esc(byId[p.team_id]?.name||p.team_id)}</td>`+lines.map(g=>{const pk=p.picks[g.mid];const gr=grade(wk,g,pk);return `<td class="${gr==='win'?'hit':gr==='loss'?'miss':''}">${pk==null?'–':pk==g.fav?'Fav':'Dog'}</td>`}).join('')+'</tr>'});
      $('inList').innerHTML=h+'</tbody></table></div>';
    }
  }
  const rec={};
  (all||[]).forEach(p=>{
    const ls=(DATA.lines||{})[p.week]; if(!ls||!res[p.week]) return;
    const r=rec[p.team_id]=rec[p.team_id]||{w:0,l:0,p:0,weeks:{}};
    let ww=0;
    ls.forEach(g=>{const gr=grade(p.week,g,p.picks[g.mid]); if(gr==='win'){r.w++;ww++} else if(gr==='loss') r.l++; else if(gr==='push') r.p++;});
    r.weeks[p.week]=ww;
  });
  const rows=Object.entries(rec).sort((a,b)=>(b[1].w-b[1].l)-(a[1].w-a[1].l)||b[1].w-a[1].w);
  $('board2').innerHTML=rows.length?rows.map(([rid,r],i)=>{const g=r.w+r.l;return `<div class="lrow" style="padding:10px 14px;grid-template-columns:1.6rem minmax(0,1fr) 5rem"><span class="rk" style="font-size:1.2rem">${i+1}</span><span class="t"><b>${esc(byId[rid]?.name||rid)}</b><span>${g?Math.round(r.w/g*100):0}% against the spread, best week ${Math.max(...Object.values(r.weeks))} right</span></span><span class="v">${r.w}–${r.l}${r.p?'–'+r.p:''}</span></div>`}).join(''):`<div class="empty">No graded weeks yet. The leaderboard fills in after week ${wk} is scored.</div>`;
}

async function parlay(DATA,T,byId){
  const sb=client(), wk=DATA.week;
  if(!sb){$('parlaySetup').hidden=false;$('parlayUI').hidden=true;return}
  const prefs=store.get('hubpick')||{};
  const team=$('legTeam'), pin=$('legPin'), text=$('legText'), note=$('legNote');
  T.forEach(t=>team.insertAdjacentHTML('beforeend',`<option value="${t.rid}">${esc(t.name)}</option>`));
  if(prefs.team) team.value=prefs.team;
  team.addEventListener('change',()=>{prefs.team=team.value;store.set('hubpick',prefs);fill()});

  // who is on the hook: low scorer of the last completed week
  const last=(DATA.done||[]).slice(-1)[0];
  let loser=null;
  if(last!=null){
    const r=DATA.results[last]||{};
    const low=Object.entries(r).sort((a,b)=>a[1]-b[1])[0];
    if(low) loser={team:byId[low[0]], pts:low[1], week:last};
  }
  $('onHook').innerHTML=loser
    ? `<div><small>Placing this week's parlay</small><b>${esc(loser.team.name)}</b><span>Low scorer in week ${loser.week}, ${loser.pts.toFixed(1)} pts</span></div>
       <div><small>Legs due</small><b id="dueLine">Sunday 1:00 PM ET</b><span id="legCount">—</span></div>`
    : `<div><small>Placing this week's parlay</small><b>To be decided</b><span>Set once a week is scored</span></div>`;

  const {data:lockData}=await sb.rpc('parlay_lock',{p_week:wk});
  const lockAt=lockData?new Date(lockData):null, locked=lockAt?Date.now()>=lockAt:false;
  $('parlayTitle').textContent=`Week ${wk} loser's parlay`;
  if(lockAt&&$('dueLine')) $('dueLine').textContent=lockAt.toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  $('parlayLede').textContent=locked
    ? `Legs are locked for week ${wk}. ${loser?loser.team.name+' places it.':''}`
    : `Everyone adds one leg before the deadline. The previous week's low scorer places the bet.`;
  [text,$('legSave')].forEach(el=>el.disabled=locked);

  let legs=[];
  async function fill(){
    const {data,error}=await sb.from('parlay_legs').select('team_id,week,leg').eq('week',wk);
    if(error){$('legs').innerHTML=`<div class="empty">Couldn't load legs: ${esc(error.message)}</div>`;return}
    legs=data||[];
    const have=new Map(legs.map(l=>[String(l.team_id),l.leg]));
    if($('legCount')) $('legCount').textContent=`${have.size} of ${T.length} legs in`;
    $('legs').innerHTML=T.map(t=>{
      const leg=have.get(String(t.rid));
      return `<div class="lrow" style="grid-template-columns:8.5rem minmax(0,1fr)"><span class="t"><b>${esc(t.name)}</b></span><span style="${leg?'':'color:var(--muted)'}">${leg?esc(leg):'no leg yet'}</span></div>`;
    }).join('');
    if(team.value&&have.has(team.value)&&!text.value) text.value=have.get(team.value);
  }
  await fill();

  const check=()=>{if(!team.value){note.textContent='Choose your team first.';return false}if(!/^\d{4,8}$/.test(pin.value)){note.textContent='Enter your 4–8 digit PIN.';return false}return true};
  $('legSave').addEventListener('click',async()=>{
    if(!check())return; note.textContent='Saving…';
    const {data,error}=await sb.rpc('submit_leg',{p_team:Number(team.value),p_pin:pin.value,p_week:wk,p_leg:text.value});
    note.textContent=error?error.message:(data==='removed'?'Leg removed.':'Leg saved. Change it any time before the deadline.');
    fill();
  });
  $('legCopy').addEventListener('click',async()=>{
    if(!legs.length){note.textContent='No legs in yet.';return}
    const txt=`Week ${wk} loser's parlay${loser?', placed by '+loser.team.name:''}:\n`+legs.map(l=>`• ${byId[l.team_id]?.name||l.team_id}: ${l.leg}`).join('\n');
    const ta=$('legOut');
    try{await navigator.clipboard.writeText(txt);note.textContent='Copied all legs.';ta.hidden=true}
    catch(e){ta.value=txt;ta.hidden=false;ta.focus();ta.select();note.textContent='Copy the text below.'}
  });
  $('stSave').addEventListener('click',async()=>{
    if(!check())return; $('stNoteMsg').textContent='Saving…';
    const {error}=await sb.rpc('settle_parlay',{p_team:Number(team.value),p_pin:pin.value,p_week:wk,p_status:$('stStatus').value,p_odds:$('stOdds').value,p_note:$('stNote').value});
    $('stNoteMsg').textContent=error?error.message:'Result saved.';
    hist();
  });
  async function hist(){
    const {data}=await sb.from('parlay_results').select('week,status,odds,note,settled_by');
    const rows=(data||[]).sort((a,b)=>b.week-a.week);
    $('parlayHist').innerHTML=rows.length?rows.map(r=>{
      const c=r.status==='hit'?'var(--pos)':r.status==='miss'?'var(--neg)':'var(--muted)';
      const who=byId[r.settled_by]?.name;
      return `<div class="lrow" style="grid-template-columns:3.5rem minmax(0,1fr) 4.5rem"><span class="rk" style="font-size:1.1rem">W${r.week}</span><span class="t"><b>${r.odds?esc(r.odds):'Parlay'}</b><span>${[who?'placed by '+esc(who):'',r.note?esc(r.note):''].filter(Boolean).join(', ')||'&nbsp;'}</span></span><span class="v" style="color:${c};text-transform:capitalize">${esc(r.status)}</span></div>`;
    }).join(''):'<div class="empty">No parlays recorded yet.</div>';
  }
  hist();
}
</script>
</body>
</html>

{"league":"808 Marck Buyck Way","season":"2026","week":2,"lineup_week":2,"done":[1],"updated":"2026-09-16T13:41+00:00","avg":132.8,"playoff_teams":6,"teams":[{"rid":6,"rank":1,"name":"2020 Washington Redskins","owner":"sampompeo","w":1,"l":0,"t":0,"pf":169.3,"pa":157.0,"ros":147.4,"power":16.2,"sos":133.7,"sosd":0.9,"sosr":3,"xw":9.1,"po":96,"champ":35.2,"final":56,"seeds":[35.1,23.3,16.2,10.7,6.5,3.9,2.5,1.2,0.5,0.2],"exp_seed":2.62,"apw":7,"apl":2,"luck":0.22,"eff":93.1,"act":169.3,"opt":181.8,"left":12.5,"bench":["Aaron Jones",10.0,1],"pos":{"QB":-0.3,"RB":12.2,"WR":4.3,"TE":-0.2,"FLEX":-0.9,"K":-0.0,"DEF":-0.4},"core":[["Lamar Jackson","QB",23.6],["Jahmyr Gibbs","RB",26.1],["Bijan Robinson","RB",22.2],["Puka Nacua","WR",20.1],["George Pickens","WR",16.3],["Tyler Warren","TE",11.3],["Garrett Wilson","FLEX",15.1],["Aaron Jones","FLEX",11.7],["Tyler Loop","K",6.8],["Pittsburgh Steelers","DEF",4.7]]},{"rid":2,"rank":2,"name":"Boom or Bust","owner":"Pferry21","w":1,"l":0,"t":0,"pf":235.0,"pa":119.8,"ros":137.9,"power":14.2,"sos":132.0,"sosd":-0.7,"sosr":7,"xw":8.2,"po":88,"champ":13.5,"final":29,"seeds":[18.2,18.4,17.5,14.6,11.6,8.1,5.6,3.2,1.8,0.9],"exp_seed":3.63,"apw":9,"apl":0,"luck":0.0,"eff":98.0,"act":235.0,"opt":239.8,"left":4.8,"bench":["Tyler Shough",29.2,1],"pos":{"QB":1.5,"RB":-3.4,"WR":1.2,"TE":3.9,"FLEX":1.9,"K":0.2,"DEF":-0.1},"core":[["Josh Allen","QB",24.7],["David Montgomery","RB",16.9],["Jacory Croskey-Merritt","RB",12.3],["Justin Jefferson","WR",17.5],["Christian Watson","WR",14.9],["Trey McBride","TE",14.9],["Zay Flowers","FLEX",14.4],["Ladd McConkey","FLEX",13.2],["Ka'imi Fairbairn","K",7.3],["Kansas City Chiefs","DEF",8.8]]},{"rid":3,"rank":3,"name":"One Time","owner":"mwcoggs","w":1,"l":0,"t":0,"pf":186.3,"pa":130.1,"ros":139.3,"power":10.6,"sos":130.0,"sosd":-2.8,"sosr":10,"xw":8.6,"po":91,"champ":18.8,"final":42,"seeds":[20.1,21.6,18.4,14.4,10.2,6.6,4.1,2.5,1.4,0.7],"exp_seed":3.35,"apw":8,"apl":1,"luck":0.11,"eff":94.2,"act":186.3,"opt":197.8,"left":11.5,"bench":["Patrick Mahomes",25.7,1],"pos":{"QB":0.6,"RB":3.5,"WR":-1.6,"TE":2.6,"FLEX":1.7,"K":0.6,"DEF":-0.8},"core":[["Patrick Mahomes","QB",20.1],["Jonathan Taylor","RB",18.8],["Ashton Jeanty","RB",14.7],["Chris Olave","WR",15.6],["DJ Moore","WR",13.1],["Brock Bowers","TE",13.7],["Bucky Irving","FLEX",13.8],["Cam Skattebo","FLEX",13.4],["Matt Gay","K",7.2],["Tampa Bay Buccaneers","DEF",9.8]]},{"rid":7,"rank":4,"name":"Ça c’est bon","owner":"Joshbarnett99","w":1,"l":0,"t":0,"pf":124.0,"pa":79.9,"ros":140.4,"power":5.4,"sos":131.6,"sosd":-1.2,"sosr":9,"xw":8.5,"po":90,"champ":17.5,"final":33,"seeds":[18.4,19.1,18.1,15.0,11.3,7.7,4.9,3.1,1.7,0.7],"exp_seed":3.55,"apw":4,"apl":5,"luck":0.56,"eff":72.5,"act":124.0,"opt":171.1,"left":47.1,"bench":["Jaxson Dart",32.6,1],"pos":{"QB":-0.5,"RB":-0.0,"WR":4.7,"TE":1.2,"FLEX":1.1,"K":0.3,"DEF":1.0},"core":[["Jordan Love","QB",23.3],["James Cook","RB",17.0],["Kenneth Walker","RB",16.3],["Nico Collins","WR",17.8],["Ja'Marr Chase","WR",16.8],["Tucker Kraft","TE",11.8],["Malik Nabers","FLEX",13.8],["Chuba Hubbard","FLEX",12.2],["Cameron Dicker","K",7.4],["Seattle Seahawks","DEF",8.9]]},{"rid":10,"rank":5,"name":"My Year","owner":"drewdautel","w":0,"l":1,"t":0,"pf":119.8,"pa":235.0,"ros":133.5,"power":-1.3,"sos":134.7,"sosd":2.0,"sosr":1,"xw":6.4,"po":52,"champ":4.4,"final":11,"seeds":[2.1,4.6,7.4,10.4,13.4,14.6,14.9,12.9,11.0,8.8],"exp_seed":6.23,"apw":3,"apl":6,"luck":-0.33,"eff":83.6,"act":119.8,"opt":143.2,"left":23.4,"bench":["Bryce Young",37.4,1],"pos":{"QB":-0.2,"RB":-3.9,"WR":2.0,"TE":0.1,"FLEX":2.6,"K":-0.4,"DEF":0.5},"core":[["Jalen Hurts","QB",23.5],["Breece Hall","RB",13.9],["Rhamondre Stevenson","RB",12.3],["CeeDee Lamb","WR",18.6],["Drake London","WR",14.1],["Sam LaPorta","TE",11.2],["Tee Higgins","FLEX",13.8],["Jaylen Waddle","FLEX",12.7],["Cam Little","K",6.2],["Denver Broncos","DEF",6.9]]},{"rid":9,"rank":6,"name":"We’ll be back","owner":"SamuMoor1501","w":0,"l":1,"t":0,"pf":157.0,"pa":169.3,"ros":128.4,"power":-2.2,"sos":133.2,"sosd":0.5,"sosr":4,"xw":5.9,"po":42,"champ":2.9,"final":7,"seeds":[1.3,2.7,5.3,8.0,11.1,13.7,15.1,15.2,14.7,12.8],"exp_seed":6.8,"apw":6,"apl":3,"luck":-0.67,"eff":90.9,"act":157.0,"opt":172.8,"left":15.8,"bench":["Dalton Kincaid",18.0,1],"pos":{"QB":0.0,"RB":1.2,"WR":-4.4,"TE":-0.9,"FLEX":1.1,"K":0.0,"DEF":-1.3},"core":[["Dak Prescott","QB",24.1],["Javonte Williams","RB",17.5],["Chase Brown","RB",15.4],["Rashee Rice","WR",13.4],["Deebo Samuel","WR",11.0],["Dalton Kincaid","TE",12.1],["Derrick Henry","FLEX",14.7],["Jaylen Warren","FLEX",12.1],["Brandon Aubrey","K",7.3],["Los Angeles Chargers","DEF",8.5]]},{"rid":8,"rank":7,"name":"GreaneyGate","owner":"cgreaney90","w":1,"l":0,"t":0,"pf":119.7,"pa":75.5,"ros":127.3,"power":-6.9,"sos":132.7,"sosd":-0.0,"sosr":6,"xw":6.9,"po":58,"champ":4.0,"final":11,"seeds":[3.0,5.8,8.3,12.1,13.9,14.3,13.8,12.2,9.6,6.9],"exp_seed":5.93,"apw":2,"apl":7,"luck":0.78,"eff":83.2,"act":119.7,"opt":143.8,"left":24.1,"bench":["D'Andre Swift",32.4,1],"pos":{"QB":-4.0,"RB":-5.0,"WR":4.4,"TE":-2.2,"FLEX":1.7,"K":0.0,"DEF":-0.4},"core":[["Bo Nix","QB",17.4],["Omarion Hampton","RB",13.7],["MarShawn Lloyd","RB",11.1],["Jaxon Smith-Njigba","WR",19.5],["DeVonta Smith","WR",14.7],["Mark Andrews","TE",10.1],["Tetairoa McMillan","FLEX",14.6],["Terry McLaurin","FLEX",14.3],["Jason Myers","K",6.8],["San Francisco 49ers","DEF",9.5]]},{"rid":5,"rank":8,"name":"The Butane Warriors","owner":"adamcthomas","w":0,"l":1,"t":0,"pf":130.1,"pa":186.3,"ros":125.0,"power":-7.9,"sos":132.0,"sosd":-0.8,"sosr":8,"xw":5.7,"po":34,"champ":1.5,"final":5,"seeds":[0.7,1.9,3.9,6.2,9.1,11.8,14.2,16.8,17.7,17.8],"exp_seed":7.27,"apw":5,"apl":4,"luck":-0.56,"eff":81.1,"act":130.1,"opt":160.4,"left":30.3,"bench":["Jared Goff",20.4,1],"pos":{"QB":-0.4,"RB":-3.9,"WR":1.2,"TE":-2.8,"FLEX":-1.6,"K":-0.2,"DEF":-0.1},"core":[["Matthew Stafford","QB",19.7],["De'Von Achane","RB",17.1],["Quinshon Judkins","RB",12.4],["Amon-Ra St. Brown","WR",17.4],["Mike Evans","WR",13.7],["T.J. Hockenson","TE",9.1],["Jalen Coker","FLEX",12.9],["Stefon Diggs","FLEX",12.6],["Will Reichard","K",6.2],["New England Patriots","DEF",8.5]]},{"rid":1,"rank":9,"name":"Treveyon My Wayward Son","owner":"andrewsnyder23","w":0,"l":1,"t":0,"pf":79.9,"pa":124.0,"ros":127.1,"power":-11.0,"sos":134.6,"sosd":1.8,"sosr":2,"xw":5.7,"po":31,"champ":1.4,"final":5,"seeds":[0.7,1.8,3.2,5.6,8.5,11.4,13.7,16.8,18.4,20.0],"exp_seed":7.42,"apw":1,"apl":8,"luck":-0.11,"eff":82.7,"act":79.9,"opt":96.6,"left":16.7,"bench":["Brock Purdy",27.1,1],"pos":{"QB":2.2,"RB":-2.4,"WR":-3.7,"TE":0.7,"FLEX":-2.8,"K":-0.1,"DEF":0.4},"core":[["Brock Purdy","QB",24.3],["Kyren Williams","RB",17.0],["Saquon Barkley","RB",16.6],["Jameson Williams","WR",12.6],["Alec Pierce","WR",11.6],["Colston Loveland","TE",12.1],["TreVeyon Henderson","FLEX",9.5],["Marvin Harrison","FLEX",9.5],["Jake Bates","K",6.1],["Philadelphia Eagles","DEF",11.6]]},{"rid":4,"rank":10,"name":"We Here","owner":"carsonwiley11","w":0,"l":1,"t":0,"pf":75.5,"pa":119.7,"ros":121.1,"power":-16.9,"sos":133.1,"sosd":0.3,"sosr":5,"xw":5.1,"po":18,"champ":0.8,"final":2,"seeds":[0.2,0.8,1.6,3.0,4.6,7.9,11.2,16.1,23.2,31.4],"exp_seed":8.19,"apw":0,"apl":9,"luck":0.0,"eff":65.6,"act":75.5,"opt":115.0,"left":39.5,"bench":["Trevor Lawrence",34.1,1],"pos":{"QB":1.1,"RB":1.7,"WR":-8.1,"TE":-2.3,"FLEX":-4.8,"K":-0.4,"DEF":1.3},"core":[["Drake Maye","QB",21.0],["Christian McCaffrey","RB",19.7],["Jeremiyah Love","RB",12.4],["DK Metcalf","WR",12.1],["Michael Pittman","WR",11.7],["Jake Ferguson","TE",10.0],["Jordan Addison","FLEX",10.9],["Jordan Mason","FLEX",10.5],["Chase McLaughlin","K",6.5],["Houston Texans","DEF",7.0]]}],"seeds":[6,3,7,2,8,10],"lines":{"2":[{"mid":1,"fav":8,"dog":5,"spread":2.0,"total":261.5,"favwp":52},{"mid":5,"fav":7,"dog":9,"spread":9.0,"total":281.5,"favwp":58},{"mid":3,"fav":3,"dog":1,"spread":9.5,"total":271.0,"favwp":59},{"mid":2,"fav":10,"dog":4,"spread":11.0,"total":255.0,"favwp":60},{"mid":4,"fav":6,"dog":2,"spread":13.0,"total":303.0,"favwp":62}]},"results":{"1":{"1":79.86,"2":234.96,"3":186.26,"4":75.46,"5":130.1,"6":169.26,"7":124.04,"8":119.74,"9":157.0,"10":119.82}},"sched":{"1":{"1":7,"7":1,"2":10,"10":2,"3":5,"5":3,"4":8,"8":4,"6":9,"9":6},"2":{"1":3,"3":1,"2":6,"6":2,"4":10,"10":4,"5":8,"8":5,"7":9,"9":7},"3":{"1":5,"5":1,"2":7,"7":2,"3":9,"9":3,"4":6,"6":4,"8":10,"10":8},"4":{"1":8,"8":1,"2":3,"3":2,"4":7,"7":4,"5":9,"9":5,"6":10,"10":6},"5":{"1":9,"9":1,"2":5,"5":2,"3":4,"4":3,"6":8,"8":6,"7":10,"10":7},"6":{"1":2,"2":1,"3":10,"10":3,"4":5,"5":4,"6":7,"7":6,"8":9,"9":8},"7":{"1":4,"4":1,"2":9,"9":2,"3":6,"6":3,"5":10,"10":5,"7":8,"8":7},"8":{"1":10,"10":1,"2":8,"8":2,"3":7,"7":3,"4":9,"9":4,"5":6,"6":5},"9":{"1":6,"6":1,"2":4,"4":2,"3":8,"8":3,"5":7,"7":5,"9":10,"10":9},"10":{"1":7,"7":1,"2":10,"10":2,"3":5,"5":3,"4":8,"8":4,"6":9,"9":6},"11":{"1":3,"3":1,"2":6,"6":2,"4":10,"10":4,"5":8,"8":5,"7":9,"9":7},"12":{"1":5,"5":1,"2":7,"7":2,"3":9,"9":3,"4":6,"6":4,"8":10,"10":8},"13":{"1":8,"8":1,"2":3,"3":2,"4":7,"7":4,"5":9,"9":5,"6":10,"10":6},"14":{"1":9,"9":1,"2":5,"5":2,"3":4,"4":3,"6":8,"8":6,"7":10,"10":7}},"mids":{"1":{"1":4,"7":4,"2":3,"10":3,"3":2,"5":2,"4":1,"8":1,"6":5,"9":5},"2":{"1":3,"3":3,"2":4,"6":4,"4":2,"10":2,"5":1,"8":1,"7":5,"9":5},"3":{"1":2,"5":2,"2":5,"7":5,"3":4,"9":4,"4":3,"6":3,"8":1,"10":1},"4":{"1":1,"8":1,"2":5,"3":5,"4":4,"7":4,"5":3,"9":3,"6":2,"10":2},"5":{"1":2,"9":2,"2":4,"5":4,"3":5,"4":5,"6":1,"8":1,"7":3,"10":3},"6":{"1":3,"2":3,"3":4,"10":4,"4":5,"5":5,"6":2,"7":2,"8":1,"9":1},"7":{"1":4,"4":4,"2":2,"9":2,"3":3,"6":3,"5":5,"10":5,"7":1,"8":1},"8":{"1":5,"10":5,"2":1,"8":1,"3":2,"7":2,"4":3,"9":3,"5":4,"6":4},"9":{"1":5,"6":5,"2":2,"4":2,"3":1,"8":1,"5":3,"7":3,"9":4,"10":4},"10":{"1":4,"7":4,"2":3,"10":3,"3":2,"5":2,"4":1,"8":1,"6":5,"9":5},"11":{"1":3,"3":3,"2":4,"6":4,"4":2,"10":2,"5":1,"8":1,"7":5,"9":5},"12":{"1":2,"5":2,"2":5,"7":5,"3":4,"9":4,"4":3,"6":3,"8":1,"10":1},"13":{"1":1,"8":1,"2":5,"3":5,"4":4,"7":4,"5":3,"9":3,"6":2,"10":2},"14":{"1":2,"9":2,"2":4,"5":4,"3":5,"4":5,"6":1,"8":1,"7":3,"10":3}},"weekly":{"1":{"2":130.9,"3":121.0,"4":122.4,"5":128.2,"6":122.6,"7":126.5,"8":136.5,"9":139.2,"10":109.6,"11":117.8,"12":134.0,"13":133.3,"14":130.9},"2":{"2":145.0,"3":141.5,"4":147.8,"5":135.7,"6":134.6,"7":131.3,"8":126.1,"9":132.3,"10":142.4,"11":142.8,"12":138.7,"13":135.9,"14":138.4},"3":{"2":140.1,"3":141.8,"4":146.0,"5":142.8,"6":144.2,"7":140.2,"8":133.0,"9":147.7,"10":132.6,"11":135.7,"12":147.9,"13":121.2,"14":137.8},"4":{"2":121.9,"3":128.2,"4":124.0,"5":121.8,"6":125.6,"7":121.1,"8":110.5,"9":118.0,"10":127.9,"11":121.5,"12":122.8,"13":124.4,"14":106.9},"5":{"2":129.5,"3":130.2,"4":121.8,"5":129.4,"6":96.9,"7":130.3,"8":119.7,"9":130.2,"10":131.8,"11":112.5,"12":131.1,"13":128.3,"14":133.4},"6":{"2":158.0,"3":152.7,"4":156.5,"5":154.6,"6":143.0,"7":154.4,"8":150.1,"9":153.7,"10":148.1,"11":130.5,"12":150.8,"13":116.6,"14":147.6},"7":{"2":145.3,"3":146.1,"4":142.4,"5":136.8,"6":136.7,"7":127.0,"8":132.9,"9":144.8,"10":149.7,"11":133.1,"12":145.3,"13":141.5,"14":144.0},"8":{"2":131.7,"3":138.7,"4":133.2,"5":124.0,"6":124.6,"7":128.7,"8":125.9,"9":129.0,"10":107.2,"11":117.1,"12":133.0,"13":127.1,"14":134.6},"9":{"2":136.2,"3":130.8,"4":130.6,"5":130.8,"6":123.5,"7":117.4,"8":132.7,"9":129.3,"10":134.4,"11":139.8,"12":121.9,"13":119.8,"14":122.1},"10":{"2":133.2,"3":135.3,"4":136.4,"5":133.5,"6":128.2,"7":133.9,"8":139.9,"9":139.9,"10":122.6,"11":132.9,"12":137.8,"13":134.0,"14":127.8}},"pw":{"1":{"15":128.5,"16":128.6,"17":124.8},"2":{"15":140.7,"16":138.8,"17":142.7},"3":{"15":142.6,"16":151.1,"17":143.2},"4":{"15":123.0,"16":125.8,"17":127.0},"5":{"15":129.9,"16":126.4,"17":130.2},"6":{"15":155.5,"16":156.5,"17":156.2},"7":{"15":146.8,"16":140.8,"17":149.9},"8":{"15":129.4,"16":130.3,"17":133.3},"9":{"15":130.1,"16":130.7,"17":136.0},"10":{"15":138.6,"16":132.2,"17":134.5}}}
