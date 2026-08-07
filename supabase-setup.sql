-- Overclock: ingame_bans table + RLS
-- Run this once in your Supabase project (SQL Editor).

create table if not exists public.ingame_bans (
  name text primary key,
  roblox_id text,
  reason text not null,
  banned_by text not null,
  banned_by_id text,
  created_at timestamptz not null default now()
);

alter table public.ingame_bans enable row level security;

-- anon can only SELECT (read by the Lua script)
drop policy if exists "anon read ingame_bans" on public.ingame_bans;
create policy "anon read ingame_bans"
  on public.ingame_bans
  for select
  to anon
  using (true);
