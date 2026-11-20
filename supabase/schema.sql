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

-- Ninguém anônimo acessa nada; usuários logados podem usar a tabela
-- (e o RLS acima garante que cada um só vê as próprias linhas).
revoke all on public.entries from anon;
grant select, insert, update, delete on public.entries to authenticated;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before update on public.entries
  for each row execute function public.touch_updated_at();

-- 2FA obrigatório no banco (mesmo conteúdo de 002_mfa.sql)
create schema if not exists private;

create or replace function private.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified'
      );
$$;

revoke all on function private.mfa_ok() from public;
grant usage on schema private to authenticated;
grant execute on function private.mfa_ok() to authenticated;

drop policy if exists "mfa required" on public.entries;
create policy "mfa required" on public.entries
  as restrictive for all to authenticated
  using ((select private.mfa_ok()))
  with check ((select private.mfa_ok()));

-- Caderno de notas (mesmo conteúdo de 003_notes.sql)
create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title      text not null default '' check (char_length(title) <= 300),
  body       text not null default '' check (char_length(body) <= 100000),
  tags       text[] not null default '{}',
  pinned     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notes_user_recent on public.notes (user_id, pinned desc, updated_at desc);
create index if not exists notes_tags        on public.notes using gin (tags);

alter table public.notes enable row level security;

drop policy if exists "own rows" on public.notes;
create policy "own rows" on public.notes
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Mesmo 2FA obrigatório das tarefas (função criada em 002_mfa.sql).
drop policy if exists "mfa required" on public.notes;
create policy "mfa required" on public.notes
  as restrictive for all to authenticated
  using ((select private.mfa_ok()))
  with check ((select private.mfa_ok()));

revoke all on public.notes from anon;
grant select, insert, update, delete on public.notes to authenticated;

drop trigger if exists notes_touch on public.notes;
create trigger notes_touch before update on public.notes
  for each row execute function public.touch_updated_at();

-- Mais bullet journal (mesmo conteúdo de 004_bujo.sql)
alter table public.entries add column if not exists month_only boolean not null default false;

alter table public.entries drop constraint if exists entries_status_check;
alter table public.entries add constraint entries_status_check
  check (status in ('open','done','migrated','cancelled','scheduled'));

alter table public.notes add column if not exists day date;
create index if not exists notes_user_day on public.notes (user_id, day);

-- Transfere as notas antigas do diário (kind = 'note') para o caderno.
-- "Título: corpo" vira título + corpo; as #tags vão no fim do corpo.
with moved as (
  delete from public.entries where kind = 'note' returning *
), parts as (
  select m.*,
         substring(m.text from '^(.*?\S)\s*:(?:\s+|$)') as t,
         substring(m.text from '^.*?\S\s*:(?:\s+|$)(.*)$') as b
  from moved m
)
insert into public.notes (user_id, title, body, tags, day, created_at, updated_at)
select user_id,
       left(coalesce(t, text), 300),
       trim(concat_ws(E'\n\n',
         nullif(trim(coalesce(b, '')), ''),
         case when cardinality(tags) > 0 then '#' || array_to_string(tags, ' #') end)),
       tags, day, created_at, now()
from parts;
