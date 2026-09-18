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
