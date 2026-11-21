// Exportar notas e/ou tarefas em Markdown (para guardar ou levar para uma conversa com o Claude).
// Filtros: conteúdo (notas, tarefas/eventos), tag e período.
import { isoDay, addDays, fromIso } from './parse.js';

const PERIODS = [
  ['all', 'Tudo'],
  ['7d', 'Últimos 7 dias'],
  ['30d', 'Últimos 30 dias'],
  ['month', 'Este mês'],
  ['year', 'Este ano'],
  ['custom', 'Personalizado'],
];

const fmtDate = (iso) => fromIso(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtLongDay = (iso) => fromIso(iso).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtMonth = (iso) => fromIso(iso).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
const noteDay = (n) => n.day || isoDay(new Date(n.created_at));

export function createExport({ sb, h, check, toast, tags }) {
  const opt = { notes: true, entries: true, tag: '', period: 'all', from: '', to: '' };
  let data = null;        // { notes, entries } já filtrados
  let loading = false;
  let ui = null;

  function range() {
    const t = isoDay();
    const d = fromIso(t);
    switch (opt.period) {
      case '7d': return [addDays(t, -6), t];
      case '30d': return [addDays(t, -29), t];
      case 'month': return [isoDay(new Date(d.getFullYear(), d.getMonth(), 1)), isoDay(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
      case 'year': return [`${d.getFullYear()}-01-01`, `${d.getFullYear()}-12-31`];
      case 'custom': return [opt.from || null, opt.to || null];
      default: return [null, null];
    }
  }

  // Busca tudo em páginas de 1000 (limite por requisição do Supabase).
  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const res = await build().range(from, from + 999);
      check(res);
      out.push(...res.data);
      if (res.data.length < 1000) return out;
    }
  }

  async function refresh() {
    loading = true; paint();
    const [from, to] = range();
    const [notes, entries] = await Promise.all([
      opt.notes ? fetchAll(() => {
        let q = sb.from('notes').select('*').order('created_at');
        if (opt.tag) q = q.contains('tags', [opt.tag]);
        return q;
      }) : [],
      opt.entries ? fetchAll(() => {
        let q = sb.from('entries').select('*').not('status', 'in', '(migrated,scheduled)').order('day').order('created_at');
        if (opt.tag) q = q.contains('tags', [opt.tag]);
        if (from) q = q.gte('day', from);
        if (to) q = q.lte('day', to);
        return q;
      }) : [],
    ]);
    // Período das notas: dia em que foram anotadas.
    const inRange = (d) => (!from || d >= from) && (!to || d <= to);
    // Ordem cronológica garantida no próprio app (dia; itens "só do mês" no início do mês; depois a hora em que foram anotados).
    entries.sort((a, b) => a.day.localeCompare(b.day) || (b.month_only - a.month_only) || a.created_at.localeCompare(b.created_at));
    data = { notes: notes.filter((n) => inRange(noteDay(n))), entries };
    loading = false;
    paint();
  }

  function filtersLine() {
    const parts = [];
    parts.push(opt.notes && opt.entries ? 'notas e tarefas' : opt.notes ? 'só notas' : 'só tarefas e eventos');
    parts.push(opt.tag ? `tag #${opt.tag}` : 'todas as tags');
    const [from, to] = range();
    parts.push(from || to ? `${from ? fmtDate(from) : 'início'} – ${to ? fmtDate(to) : 'hoje'}` : 'todo o período');
    return parts.join(' · ');
  }

  function toMarkdown() {
    const L = [];
    L.push('# Tome Nota! — exportação', '');
    L.push(`Exportado em ${fmtDate(isoDay())}. Filtros: ${filtersLine()}.`, '');
    if (opt.entries) {
      L.push('Legenda: `[ ]` tarefa aberta · `[x]` feita · `○` evento · `◉` evento que aconteceu · **(importante)** = marcado com *', '');
    }

    if (opt.notes) {
      L.push(`## Notas (${data.notes.length})`, '');
      for (const n of [...data.notes].sort((a, b) => noteDay(a).localeCompare(noteDay(b)) || a.created_at.localeCompare(b.created_at))) {
        L.push(`### ${n.title.trim() || 'Sem título'}`);
        const meta = [fmtDate(noteDay(n)), ...n.tags.map((t) => '#' + t)];
        if (n.pinned) meta.push('fixada');
        L.push(`*${meta.join(' · ')}*`, '');
        if (n.body.trim()) L.push(n.body.trim(), '');
      }
    }

    if (opt.entries) {
      L.push(`## Tarefas e eventos (${data.entries.length})`, '');
      let group = null;
      for (const e of data.entries) {
        const g = e.month_only ? `### ${fmtMonth(e.day)} (sem dia definido)` : `### ${fmtLongDay(e.day)}`;
        if (g !== group) { if (group) L.push(''); L.push(g); group = g; }
        const box = e.kind === 'event' ? (e.status === 'done' ? '◉' : '○') : e.status === 'done' ? '[x]' : '[ ]';
        const extra = [e.priority ? '**(importante)**' : '', ...e.tags.map((t) => '#' + t)].filter(Boolean).join(' ');
        L.push(`- ${box} ${e.text}${extra ? ' ' + extra : ''}`);
      }
      L.push('');
    }
    return L.join('\n');
  }

  function fileName() {
    return `tomenota-${isoDay()}${opt.tag ? '-' + opt.tag : ''}.md`;
  }

  function download() {
    const blob = new Blob([toMarkdown()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: fileName() });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Arquivo ${fileName()} baixado.`);
  }

  async function copy() {
    try { await navigator.clipboard.writeText(toMarkdown()); toast('Copiado! Cole numa conversa com o Claude.'); }
    catch { toast('Não foi possível copiar. Use "Baixar .md".'); }
  }

  // ---------- Tela ----------
  const chip = (on, label, onclick) => h('button', { type: 'button', class: 'kind' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick }, label);

  function paint() {
    if (!ui) return;
    const content = [
      chip(opt.notes, 'Notas', () => { if (opt.notes && !opt.entries) return; opt.notes = !opt.notes; refresh(); }),
      chip(opt.entries, 'Tarefas e eventos', () => { if (opt.entries && !opt.notes) return; opt.entries = !opt.entries; refresh(); }),
    ];
    ui.content.replaceChildren(...content);
    ui.tag.replaceChildren(h('option', { value: '' }, 'Todas as tags'), ...tags.list().map(([t, n]) => h('option', { value: t }, `#${t} (${n})`)));
    ui.tag.value = opt.tag;
    ui.period.replaceChildren(...PERIODS.map(([v, label]) => chip(opt.period === v, label, () => { opt.period = v; refresh(); })));
    ui.custom.hidden = opt.period !== 'custom';

    if (loading || !data) {
      ui.summary.textContent = 'Carregando…';
      ui.preview.textContent = '';
      ui.download.disabled = ui.copy.disabled = true;
      return;
    }
    const n = opt.notes ? data.notes.length : 0, t = opt.entries ? data.entries.length : 0;
    const parts = [];
    if (opt.notes) parts.push(`${n} nota${n === 1 ? '' : 's'}`);
    if (opt.entries) parts.push(`${t} tarefa${t === 1 ? '' : 's'}/evento${t === 1 ? '' : 's'}`);
    ui.summary.textContent = `${parts.join(' e ')} · ${filtersLine()}`;
    const md = toMarkdown();
    ui.preview.textContent = md.length > 4000 ? md.slice(0, 4000) + '\n…' : md;
    ui.download.disabled = ui.copy.disabled = n + t === 0;
  }

  function render(main, back) {
    const tag = h('select', { class: 'select', onchange: (ev) => { opt.tag = ev.target.value; refresh(); } });
    const from = h('input', { type: 'date', class: 'date-pick', value: opt.from, onchange: (ev) => { opt.from = ev.target.value; refresh(); } });
    const to = h('input', { type: 'date', class: 'date-pick', value: opt.to, onchange: (ev) => { opt.to = ev.target.value; refresh(); } });
    ui = {
      content: h('div', { class: 'kinds' }),
      tag,
      period: h('div', { class: 'kinds' }),
      custom: h('div', { class: 'export-custom' }, h('label', {}, 'de ', from), h('label', {}, 'até ', to)),
      summary: h('p', { class: 'export-summary' }),
      preview: h('pre', { class: 'export-preview' }),
      download: h('button', { type: 'button', class: 'primary', onclick: download }, 'Baixar .md'),
      copy: h('button', { type: 'button', class: 'secondary-btn', onclick: copy }, 'Copiar'),
    };
    main.append(
      h('div', { class: 'note-bar' }, h('button', { class: 'back', onclick: back }, '‹ índice')),
      h('h2', { class: 'view-title' }, 'exportar'),
      h('p', { class: 'muted small' }, 'Gera um arquivo Markdown com o que você escolher, para guardar ou levar para uma conversa com o Claude (ex.: num Projeto no claude.ai).'),
      h('section', { class: 'card' },
        h('h3', {}, 'Conteúdo'), ui.content,
        h('h3', { class: 'sub' }, 'Tag'), tag,
        h('h3', { class: 'sub' }, 'Período'), ui.period, ui.custom),
      ui.summary,
      h('div', { class: 'export-actions' }, ui.download, ui.copy),
      h('h3', { class: 'section' }, 'Prévia'),
      ui.preview,
    );
    paint();
    refresh();
  }

  return { render, toMarkdown, get options() { return opt; } };
}
