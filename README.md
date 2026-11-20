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

### Notas
Aba **Notas**: um caderno para textos que não são tarefas (atas de reunião, coisas que você viu e quer lembrar).
- Título + texto livre, **salva sozinho** enquanto você digita.
- `#tags` em qualquer lugar do texto; links `https://…` ficam clicáveis abaixo da nota.
- **fixar** mantém a nota no topo. Notas vazias são descartadas.
- A **Busca** procura em notas e no diário ao mesmo tempo.

**Atalhos:** `n` nova anotação no dia · `/` focar entrada · `[` `]` dia anterior/próximo · `t` hoje · `p` pendentes · `a` notas · `s` busca

## Stack (tudo grátis)

- **Frontend:** Vite + JS puro (sem framework). Hospedado no **Cloudflare Pages** (grátis, funciona com repo privado).
- **Backend:** **Supabase** (Postgres + Auth). O plano gratuito é suficiente para uso pessoal.
- **Segurança:**
  - Login com e-mail + senha e **2FA opcional** (código de app autenticador), na página **conta**.
  - Com 2FA ativo, o próprio banco recusa sessões que não digitaram o código (`supabase/002_mfa.sql`).
  - **Row Level Security** no Postgres: cada linha pertence a um `user_id` e o banco só devolve as linhas do usuário logado. A `anon key` no frontend é pública por design; sem login ela não acessa nada.
  - Cadastro público desligado: só você entra.
  - CSP e headers de segurança em `public/_headers`.

## Setup (~10 min)

### 1. Supabase
1. Crie um projeto em https://supabase.com (plano Free).
2. **SQL Editor** → cole e rode `supabase/schema.sql`. (Projeto já existente? Rode só os arquivos novos: `002_mfa.sql`, `003_notes.sql`.)
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
