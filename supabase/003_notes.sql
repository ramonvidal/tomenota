-- tomenota: caderno de notas (independente do diário/tarefas).
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
