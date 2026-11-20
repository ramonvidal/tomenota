-- tomenota: mais bullet journal.
--  * Future Log: tarefas/eventos agendados só para um mês (sem dia) → month_only
--  * "<" agendado: nova situação 'scheduled' (foi para o Future Log)
--  * Notas do diário passam a morar no caderno de Notas (com o dia em que foram anotadas)

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
