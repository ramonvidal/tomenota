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

export function parseEntry(raw, baseDay) {
  let text = raw.trim();
  let kind = 'task';
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
  return { kind, text, tags: [...tags], priority, day };
}
