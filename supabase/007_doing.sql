-- tomenota: "fazendo agora" (bullet "/"). Uma tarefa em andamento por vez.
alter table public.entries add column if not exists started_at timestamptz;

alter table public.entries drop constraint if exists entries_status_check;
alter table public.entries add constraint entries_status_check
  check (status in ('open','done','migrated','cancelled','scheduled','doing'));

-- O próprio banco garante: no máximo uma tarefa "fazendo" por usuário.
create unique index if not exists entries_one_doing on public.entries (user_id) where status = 'doing';
