# tomenota

Notas rápidas + bullet journal. Simples, rápido, privado.

## Como usar

Digite e aperte **Enter**. A sintaxe é opcional:

| Você digita | Vira |
|---|---|
| `comprar pão` | • tarefa |
| `- ideia solta` | – nota |
| `o dentista 14h` | ○ evento |
| `#casa` | tag (clique para filtrar) |
| `!` `!!` `!!!` | prioridade |
| `@amanhã` `@sex` `@25/12` `@2026-12-25` | anota em outro dia |

- Clique no `•` para concluir (`×`). Dê dois cliques no texto para editar.
- **→ hoje / → amanhã**: migração estilo bullet journal. O original vira `>` e uma cópia vai para o novo dia.
- Tarefas abertas de dias anteriores aparecem num aviso em "hoje", com um botão para migrar todas.

**Atalhos:** `n` nova nota · `/` focar entrada · `[` `]` dia anterior/próximo · `t` hoje · `p` pendentes · `s` busca

## Stack (tudo grátis)

- **Frontend:** Vite + JS puro (sem framework). Hospedado no **Cloudflare Pages** (grátis, funciona com repo privado).
- **Backend:** **Supabase** (Postgres + Auth). O plano gratuito é suficiente para uso pessoal.
- **Segurança:**
  - Login por link mágico no e-mail (sem senha para vazar), com fluxo PKCE.
  - **Row Level Security** no Postgres: cada linha pertence a um `user_id` e o banco só devolve as linhas do usuário logado. A `anon key` no frontend é pública por design; sem login ela não acessa nada.
  - Cadastro público desligado: só você entra.
  - CSP e headers de segurança em `public/_headers`.

## Setup (~10 min)

### 1. Supabase
1. Crie um projeto em https://supabase.com (plano Free).
2. **SQL Editor** → cole e rode `supabase/schema.sql`.
3. **Authentication → Users → Add user → Send invitation** com seu e-mail.
4. **Authentication → Sign In / Providers**: desative *Allow new users to sign up*.
5. **Authentication → URL Configuration**: em *Site URL*, coloque a URL do Cloudflare Pages (ex.: `https://tomenota.pages.dev`). Adicione `http://localhost:5173` em *Redirect URLs* para desenvolvimento.
6. Copie *Project URL* e *anon public key* (Project Settings → API).

### 2. Local
```bash
cp .env.example .env   # preencha as duas variáveis
npm install
npm run dev
```

### 3. Cloudflare Pages
1. https://dash.cloudflare.com → Workers & Pages → Create → Pages → conecte o repositório.
2. Build command: `npm run build` · Output: `dist`
3. Environment variables: `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.

> Obs.: projetos Supabase Free são pausados após 7 dias sem uso. Basta reativar no painel (os dados ficam). Usando todo dia, isso não acontece.
