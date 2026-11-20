// Entrada rápida estilo "smart add":
//   "comprar pão #casa !"      → tarefa, tag casa, prioridade 1
//   "- ideia solta"            → nota
//   "o dentista 14h @amanhã"   → evento, amanhã
//   "pagar conta @25/11 !!"    → tarefa no dia 25/11, prioridade 2

export function isoDay(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDay(new Date(y, m - 1, d + n));
}

export function fromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

function strip(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function parseDate(token, baseDay) {
  const t = strip(token);
  const today = isoDay();
  if (t === 'hoje') return today;
  if (t === 'amanha') return addDays(today, 1);
  if (t === 'ontem') return addDays(today, -1);
  const wd = WEEKDAYS.indexOf(t.slice(0, 3));
  if (wd >= 0 && t.length <= 7) {
    const cur = fromIso(today).getDay();
    return addDays(today, ((wd - cur + 7) % 7) || 7);
  }
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return t;
  m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    let year = m[3] ? Number(m[3]) : fromIso(baseDay).getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
    if (d.getMonth() === Number(m[2]) - 1) return isoDay(d);
  }
  return null;
}

// Normaliza uma tag: minúsculas, sem acento ("#Orçamento" e "#orcamento" são a mesma).
export const normalizeTag = (t) => strip(t);

// Tag especial: a entrada vai direto para o caderno de Notas.
export const NOTEBOOK_TAG = 'nota';

// "Título: corpo" → { title, body }. Só separa em ":" seguido de espaço (ou no fim),
// para não cortar horários (14:00) nem links (https://…).
export function splitTitle(text) {
  const m = text.match(/^(.*?\S)\s*:(?:\s+|$)([\s\S]*)$/);
  if (!m) return { title: text.trim(), body: '' };
  return { title: m[1].trim(), body: m[2].trim() };
}

const TAG_RE = /(^|\s)#([\p{L}\p{N}_-]+)/gu;

// Tags (#algo) em qualquer lugar de um texto livre, normalizadas (minúsculas, sem acento).
export function extractTags(text) {
  const tags = new Set();
  for (const m of text.matchAll(TAG_RE)) tags.add(strip(m[2]));
  return [...tags].slice(0, 50);
}

// Links http(s) em um texto livre.
export function extractLinks(text) {
  const links = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) links.add(m[0].replace(/[).,;:!?]+$/, ''));
  return [...links];
}

// kind: 'task' | 'event' | 'note' (diário) | 'notebook' (vai para Notas).
// defaultKind vem dos botões de tipo; um prefixo digitado ("- ", "o ", "* ") tem prioridade.
export function parseEntry(raw, baseDay, defaultKind = 'task') {
  let text = raw.trim();
  let kind = defaultKind;
  if (/^[-–]\s+/.test(text)) { kind = 'note'; text = text.replace(/^[-–]\s+/, ''); }
  else if (/^(o|○)\s+/i.test(text)) { kind = 'event'; text = text.replace(/^(o|○)\s+/i, ''); }
  else if (/^[*•]\s+/.test(text)) { text = text.replace(/^[*•]\s+/, ''); }

  const tags = new Set();
  let priority = 0;
  let day = baseDay;

  const kept = [];
  for (const tok of text.split(/\s+/)) {
    if (/^#[\p{L}\p{N}_-]+$/u.test(tok)) { tags.add(strip(tok.slice(1))); continue; }
    if (/^!{1,3}$/.test(tok)) { priority = Math.max(priority, tok.length); continue; }
    if (tok.startsWith('@') && tok.length > 1) {
      const d = parseDate(tok.slice(1), baseDay);
      if (d) { day = d; continue; }
    }
    kept.push(tok);
  }
  text = kept.join(' ').trim();
  if (tags.has(NOTEBOOK_TAG)) { tags.delete(NOTEBOOK_TAG); kind = 'notebook'; }
  return { kind, text, tags: [...tags], priority, day };
}
