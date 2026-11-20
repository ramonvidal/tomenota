-- tomenota: dias úteis.
--  * user_settings.off_weekdays: dias da semana de folga (0 = domingo … 6 = sábado). Padrão: sábado e domingo.
--  * calendar_days: exceções por data. off = true → folga/feriado; off = false → dia útil (ex.: um sábado de trabalho).
create table if not exists public.user_settings (
  user_id      uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  off_weekdays smallint[] not null default '{0,6}',
  updated_at   timestamptz not null default now()
);

create table if not exists public.calendar_days (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day     date not null,
  off     boolean not null default true,
  label   text not null default '' check (char_length(label) <= 100),
  primary key (user_id, day)
);

alter table public.user_settings enable row level security;
alter table public.calendar_days enable row level security;

drop policy if exists "own rows" on public.user_settings;
create policy "own rows" on public.user_settings for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "own rows" on public.calendar_days;
create policy "own rows" on public.calendar_days for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "mfa required" on public.user_settings;
create policy "mfa required" on public.user_settings as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
drop policy if exists "mfa required" on public.calendar_days;
create policy "mfa required" on public.calendar_days as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.user_settings, public.calendar_days from anon;
grant select, insert, update, delete on public.user_settings, public.calendar_days to authenticated;
