-- tomenota: rode isto no Supabase → SQL Editor
create table if not exists public.entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day        date not null default current_date,
  kind       text not null default 'task'  check (kind in ('task','note','event')),
  status     text not null default 'open'  check (status in ('open','done','migrated','cancelled')),
  text       text not null check (char_length(text) between 1 and 2000),
  priority   smallint not null default 0 check (priority between 0 and 3),
  tags       text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists entries_user_day  on public.entries (user_id, day);
create index if not exists entries_user_open on public.entries (user_id, status) where status = 'open';
create index if not exists entries_tags      on public.entries using gin (tags);

-- Row Level Security: cada usuário só enxerga/edita as próprias linhas.
alter table public.entries enable row level security;

drop policy if exists "own rows" on public.entries;
create policy "own rows" on public.entries
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Ninguém anônimo acessa nada.
revoke all on public.entries from anon;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before update on public.entries
  for each row execute function public.touch_updated_at();
