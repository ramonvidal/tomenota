-- tomenota: exigir 2FA no banco de dados.
-- Se o usuário tem 2FA ativado, a sessão só acessa as notas depois de digitar o código (aal2).
-- Sem isso, alguém com só a senha poderia pular a tela do código chamando a API direto.
-- Usuários sem 2FA continuam funcionando normalmente.
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
