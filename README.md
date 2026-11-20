# Tome Nota!

Notas rápidas + bullet journal. Simples, rápido, privado.

## Como usar

Escolha o tipo nos botões abaixo da entrada (**• Tarefa · ○ Evento · – Nota**, ou `Alt+1…3`), digite e aperte **Enter**.

| Você digita | Vira |
|---|---|
| `comprar pão` | • tarefa |
| `o dentista 14h` | ○ evento |
| `- Reunião com X: decidimos adiar` | – nota → vai para o caderno de **Notas** (título "Reunião com X") e aparece no dia |
| `* pagar imposto` | `*` importante. Depois de criada: ação **"* importante"** na linha (no celular, toque na entrada), clique na margem à esquerda, ou edite começando com `* ` |
| `#casa` | tag / coleção (`#nota` = vira Nota) |
| `@amanhã` `@sex` `@25/12` | anota em outro dia |
| `@dez` `@março` `@12/2027` | **Future Log**: agendado só para o mês, sem dia |

### Bullets e sinalizadores
`•` tarefa · `×` feita · `>` migrada (outro dia) · `<` agendada (foi para o Futuro) · `○` evento · `–` nota · `*` importante

- Clique no `•` para concluir. Dois cliques no texto para editar. Clique na margem à esquerda para marcar `*`.
- Menu **⋯** de cada linha (no celular, sobe da parte de baixo): **→ hoje**, **→ amanhã** (próximo dia útil), **Agendar…** (um dia ou um mês), importante, tipo, editar, apagar. A original fica `>` (ou `<` se foi para um mês futuro) e uma cópia vai para o destino.
- Tarefas abertas de dias (ou meses) anteriores aparecem num aviso em "hoje", com um botão para migrar todas.

### Dias úteis
"Amanhã" (`@amanhã` e o botão **→ amanhã**) vai sempre para o **próximo dia útil**. Em **conta → Dias úteis** você escolhe os dias da semana úteis (padrão: seg–sex) e adiciona os feriados oficiais da **Baixa Saxônia (Niedersachsen)** do ano. No topo de cada dia: **marcar como dia não útil** (com nome, ex.: "férias") ou **tornar dia útil** (ex.: um sábado de trabalho). Datas explícitas (`@sáb`, `@25/12`) valem como escritas.

### Aparência
Em **conta → Aparência**: **Automático** (segue o modo claro/escuro do aparelho), **Claro** ou **Preto** (fundo preto puro, bom para telas OLED). Fica salvo em cada navegador.

### Abas
No computador ficam no topo; no celular, embaixo, com ícones.
- **Índice**: busca em tudo + coleções (tags) + notas fixadas + resumo do futuro.
- **Dia**: o daily log, com a faixa da semana para pular de dia (hoje destacado, dias não úteis apagados). Ordem: importantes (`*`) primeiro, depois agrupado por #tag em ordem alfabética (sem tag por último), notas no fim.
- **Futuro**: o Future Log, por mês. Sem `@data`, o que você digita ali vai para o próximo mês.
- **Pendentes**: todas as tarefas abertas.
- **Notas**: o caderno. Título + texto, salva sozinho, `#tags`, links clicáveis, fixar.

**Atalhos:** `n` nova anotação · `/` focar entrada · `[` `]` dia anterior/próximo · `t` hoje · `f` futuro · `p` pendentes · `a` notas · `i` índice

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
2. **SQL Editor** → cole e rode `supabase/schema.sql`. (Projeto já existente? Rode só os arquivos novos, em ordem: `002_mfa.sql`, `003_notes.sql`, `004_bujo.sql`, `005_workdays.sql`.)
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
