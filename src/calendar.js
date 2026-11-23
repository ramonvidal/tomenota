// Dias úteis: quais dias da semana são folga + exceções por data (feriados, sábados de trabalho).
// Fica no banco (vale em todos os aparelhos) e alimenta o "amanhã = próximo dia útil".
import { fromIso, isoDay, setOffDayChecker } from './parse.js';

export const WEEKDAY_NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano).
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// Feriados oficiais da Baixa Saxônia (Niedersachsen, Alemanha).
export function lowerSaxonyHolidays(year) {
  const e = easter(year);
  const rel = (n) => isoDay(new Date(e.getFullYear(), e.getMonth(), e.getDate() + n));
  const fixed = (m, d) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return [
    [fixed(1, 1), 'Ano Novo (Neujahr)'],
    [rel(-2), 'Sexta-feira Santa (Karfreitag)'],
    [rel(1), 'Segunda de Páscoa (Ostermontag)'],
    [fixed(5, 1), 'Dia do Trabalho (Tag der Arbeit)'],
    [rel(39), 'Ascensão (Christi Himmelfahrt)'],
    [rel(50), 'Segunda de Pentecostes (Pfingstmontag)'],
    [fixed(10, 3), 'Dia da Unidade Alemã (Tag der Deutschen Einheit)'],
    [fixed(10, 31), 'Dia da Reforma (Reformationstag)'],
    [fixed(12, 25), 'Natal (1. Weihnachtstag)'],
    [fixed(12, 26), '2º dia de Natal (2. Weihnachtstag)'],
  ].map(([day, label]) => ({ day, label }));
}

export function createCalendar({ sb, check, state, toast }) {
  let offWeekdays = [0, 6];
  const days = new Map();   // 'YYYY-MM-DD' → { off, label }

  function isOff(iso) {
    const x = days.get(iso);
    if (x) return x.off;
    return offWeekdays.includes(fromIso(iso).getDay());
  }
  setOffDayChecker(isOff);

  // Por que este dia não é útil (ou null se é útil).
  function reason(iso) {
    const x = days.get(iso);
    if (x) return x.off ? (x.label || 'folga') : null;
    return offWeekdays.includes(fromIso(iso).getDay()) ? 'fim de semana' : null;
  }

  // Cópia no aparelho, para "amanhã = próximo dia útil" funcionar offline.
  const cacheKey = () => `tomenota-cal-${state.session?.user?.id}`;
  function saveCache() {
    try { localStorage.setItem(cacheKey(), JSON.stringify({ offWeekdays, days: [...days] })); } catch {}
  }
  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
      if (c) { offWeekdays = c.offWeekdays; days.clear(); for (const [k, v] of c.days) days.set(k, v); }
    } catch {}
  }
  const clearCache = () => { try { localStorage.removeItem(cacheKey()); } catch {} };

  async function load() {
    loadCache();
    const [s, d] = await Promise.all([
      sb.from('user_settings').select('off_weekdays').maybeSingle(),
      sb.from('calendar_days').select('day, off, label').limit(5000),
    ]);
    // Sem conexão: fica com a cópia do aparelho. Antes do 005_workdays.sql: padrão (sáb/dom).
    if (s.error || d.error) { console.warn('dias úteis: usando cópia/padrão', s.error || d.error); return; }
    offWeekdays = s.data?.off_weekdays ?? [0, 6];
    days.clear();
    for (const r of d.data) days.set(r.day, { off: r.off, label: r.label });
    saveCache();
  }
  // Mudar dias úteis/feriados precisa de internet (o resto do app funciona offline).
  const needOnline = () => {
    if (navigator.onLine) return;
    toast?.('Sem conexão: mudar dias úteis e feriados precisa de internet.');
    throw { code: 'offline', message: 'offline' };
  };

  async function setWeekdays(list) {
    needOnline();
    check(await sb.from('user_settings').upsert({ user_id: state.session.user.id, off_weekdays: list, updated_at: new Date().toISOString() }));
    offWeekdays = list;
    saveCache();
  }

  // Marca/desmarca um dia. Volta ao padrão da semana quando a exceção coincide com ele.
  async function setDay(iso, off, label = '') {
    needOnline();
    const weekdayOff = offWeekdays.includes(fromIso(iso).getDay());
    if (off === weekdayOff && !label) {
      check(await sb.from('calendar_days').delete().eq('day', iso));
      days.delete(iso);
    } else {
      check(await sb.from('calendar_days').upsert({ user_id: state.session.user.id, day: iso, off, label }));
      days.set(iso, { off, label });
    }
    saveCache();
  }

  async function addHolidays(list) {
    needOnline();
    const rows = list.filter((x) => !days.has(x.day)).map((x) => ({ user_id: state.session.user.id, day: x.day, off: true, label: x.label }));
    if (rows.length) check(await sb.from('calendar_days').upsert(rows));
    for (const r of rows) days.set(r.day, { off: true, label: r.label });
    saveCache();
    return rows.length;
  }

  // Exceções de hoje em diante (para a página conta).
  function upcoming() {
    const t = isoDay();
    return [...days].filter(([d]) => d >= t).sort(([a], [b]) => a.localeCompare(b)).map(([day, x]) => ({ day, ...x }));
  }

  return { load, clearCache, isOff, reason, setWeekdays, setDay, addHolidays, upcoming, get offWeekdays() { return offWeekdays; } };
}
