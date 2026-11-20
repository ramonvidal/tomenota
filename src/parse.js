// Entrada rápida estilo "smart add":
//   "comprar pão #casa"          → tarefa, tag casa
//   "* pagar imposto"            → tarefa importante (*)
//   "- Reunião X: sem ações"     → nota (vai para o caderno de Notas e aparece no dia)
//   "o dentista 14h @amanhã"     → evento, amanhã
//   "renovar passaporte @mar"    → tarefa no Future Log de março (sem dia definido)

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
export const MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Primeiro dia do mês (índice 0-11). Sem ano: o próximo mês com esse nome (o atual conta).
function monthStart(mi, year) {
  const now = new Date();
  if (year == null) year = mi >= now.getMonth() ? now.getFullYear() : now.getFullYear() + 1;
  if (year < 100) year += 2000;
  return isoDay(new Date(year, mi, 1));
}

export const firstOfMonth = (iso) => iso.slice(0, 8) + '01';

function strip(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// "@token" → { day, monthOnly } ou null. monthOnly = agendado só para o mês (Future Log).
export function parseDate(token, baseDay = isoDay()) {
  const t = strip(token);
  const today = isoDay();
  const exact = (day) => ({ day, monthOnly: false });
  if (t === 'hoje') return exact(today);
  if (t === 'amanha') return exact(addDays(today, 1));
  if (t === 'ontem') return exact(addDays(today, -1));
  let m = t.match(/^([a-z]+)(?:\/(\d{2}|\d{4}))?$/);
  if (m) {
    const mi = MONTHS.findIndex((n) => m[1] === n || m[1] === n.slice(0, 3));
    if (mi >= 0) return { day: monthStart(mi, m[2] ? Number(m[2]) : null), monthOnly: true };
    const wd = WEEKDAYS.indexOf(m[1].slice(0, 3));
    if (wd >= 0 && !m[2] && m[1].length <= 7) {
      const cur = fromIso(today).getDay();
      return exact(addDays(today, ((wd - cur + 7) % 7) || 7));
    }
    return null;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return exact(t);
  m = t.match(/^(\d{1,2})\/(\d{4})$/);                       // 12/2027 → mês/ano
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { day: monthStart(Number(m[1]) - 1, Number(m[2])), monthOnly: true };
  m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    let year = m[3] ? Number(m[3]) : fromIso(baseDay).getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
    if (d.getMonth() === Number(m[2]) - 1) return exact(isoDay(d));
  }
  return null;
}

// Normaliza uma tag: minúsculas, sem acento ("#Orçamento" e "#orcamento" são a mesma).
export const normalizeTag = (t) => strip(t);

// Tag especial: o mesmo que escolher "Nota" (vai para o caderno de Notas).
export const NOTE_TAG = 'nota';

// "Título: corpo" → { title, body }. Só separa em ":" seguido de espaço (ou no fim),
// para não cortar horários (14:00) nem links (https://…).
export function splitTitle(text) {
  const m = text.match(/^(.*?\S)\s*:(?:\s+|$)([\s\S]*)$/);
  let title = m ? m[1].trim() : text.trim();
  let body = m ? m[2].trim() : '';
  if (title.length > 300) { body = text.trim(); title = title.slice(0, 100).trim() + '…'; }  // título longo demais: texto todo no corpo
  return { title, body };
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

// kind: 'task' | 'event' | 'note' (nota → caderno de Notas).
// defaultKind vem dos botões de tipo; um prefixo digitado ("- ", "o ", "• ") tem prioridade.
// Sinalizador "*" (importante) pode vir antes do bullet: "* o reunião com diretoria".
export function parseEntry(raw, baseDay, defaultKind = 'task') {
  let text = raw.trim();
  let kind = defaultKind;
  let priority = 0;
  for (;;) {
    if (/^\*\s+/.test(text)) { priority = 1; text = text.replace(/^\*\s+/, ''); }
    else if (/^[-–]\s+/.test(text)) { kind = 'note'; text = text.replace(/^[-–]\s+/, ''); }
    else if (/^(o|○)\s+/i.test(text)) { kind = 'event'; text = text.replace(/^(o|○)\s+/i, ''); }
    else if (/^•\s+/.test(text)) { kind = 'task'; text = text.replace(/^•\s+/, ''); }
    else break;
  }

  const tags = new Set();
  let day = baseDay;
  let monthOnly = false;

  const kept = [];
  for (const tok of text.split(/\s+/)) {
    if (/^#[\p{L}\p{N}_-]+$/u.test(tok)) { tags.add(strip(tok.slice(1))); continue; }
    if (/^!{1,3}$/.test(tok)) { priority = Math.max(priority, tok.length); continue; }
    if (tok === '*') { priority = Math.max(priority, 1); continue; }
    if (tok.startsWith('@') && tok.length > 1) {
      const d = parseDate(tok.slice(1), baseDay);
      if (d) { day = d.day; monthOnly = d.monthOnly; continue; }
    }
    kept.push(tok);
  }
  text = kept.join(' ').trim();
  if (tags.has(NOTE_TAG)) { tags.delete(NOTE_TAG); kind = 'note'; }
  return { kind, text, tags: [...tags], priority, day, month_only: monthOnly };
}
