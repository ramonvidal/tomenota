-- tomenota: ligar uma nota de detalhes a uma tarefa/evento.
-- Apagar a nota desfaz a ligação (a tarefa continua). Apagar a tarefa não apaga a nota.
alter table public.entries add column if not exists note_id uuid references public.notes(id) on delete set null;
create index if not exists entries_note on public.entries (note_id) where note_id is not null;

-- Só dá para ligar a uma nota do próprio usuário.
create or replace function public.entries_check_note() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.note_id is not null and not exists (
    select 1 from public.notes n where n.id = new.note_id and n.user_id = new.user_id
  ) then
    raise exception 'nota inválida para esta tarefa' using errcode = '23503';
  end if;
  return new;
end $$;

drop trigger if exists entries_check_note on public.entries;
create trigger entries_check_note before insert or update of note_id on public.entries
  for each row execute function public.entries_check_note();
