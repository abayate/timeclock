'use strict';

// All times are stored as New York wall-clock time: { date: 'YYYY-MM-DD', start: 'HH:MM', end: 'HH:MM' }.
const TZ = 'America/New_York';
const STORE_KEY = 'timeclock.v1';
const TEMPLATE_KEY = 'timeclock.template';
const TEMPLATE_NAME_KEY = 'timeclock.templateName';
const STARTER_TEMPLATE = 'template/invoice-template.docx';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const $ = (id) => document.getElementById(id);

// ---------- storage ----------

function defaultState() {
  return {
    shifts: [],
    active: null,
    // Invoice number used for each month ('YYYY-MM' -> number). September 2026 was #9.
    invoices: { '2026-09': 9 },
    nextInvoice: 10,
    settings: {
      name: '', email: '', billTo: '', rate: 0, wireFee: 15, notes: '',
      days: [2, 4, 5], start: '10:00', end: '15:00',
    },
  };
}

// Merge saved data over defaults and make sure the next invoice number is above every one already used.
function fromSaved(saved) {
  const base = defaultState();
  const s = {
    ...base, ...saved,
    settings: { ...base.settings, ...saved.settings },
    invoices: { ...base.invoices, ...saved.invoices },
  };
  s.nextInvoice = Math.max(Number(s.nextInvoice) || 1, base.nextInvoice, ...Object.values(s.invoices).map((n) => n + 1));
  return s;
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved) return fromSaved(saved);
  } catch (e) { /* fall through to a fresh state */ }
  return defaultState();
}

let state = load();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('Could not save on this device');
  }
}

// ---------- time helpers ----------

function nyNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function shiftMinutes(s) {
  let diff = toMin(s.end) - toMin(s.start);
  if (diff < 0) diff += 1440; // shift ran past midnight
  return diff;
}

const hours = (min) => (min / 60).toFixed(2);

function time12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Date strings are calendar dates, so format them in UTC to avoid shifting a day.
const asDate = (ymd) => new Date(`${ymd}T12:00:00Z`);
const fmtDate = (ymd, opts) => asDate(ymd).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
const dayName = (ymd) => DAY_NAMES[asDate(ymd).getUTCDay()];
const monthName = (ym) => fmtDate(`${ym}-01`, { month: 'long', year: 'numeric' });

function money(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shiftMonth(ym, step) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + step, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftsIn(ym) {
  return state.shifts
    .filter((s) => s.date.startsWith(ym))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

const sumMinutes = (list) => list.reduce((t, s) => t + shiftMinutes(s), 0);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- UI: tabs + month ----------

let viewMonth = nyNow().date.slice(0, 7);

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('title').textContent = name[0].toUpperCase() + name.slice(1);
  render();
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.querySelectorAll('[data-month-step]').forEach((b) => b.addEventListener('click', () => {
  viewMonth = shiftMonth(viewMonth, Number(b.dataset.monthStep));
  $('invoiceOut').classList.add('hidden');
  render();
}));

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
}

// ---------- clock ----------

$('clockBtn').addEventListener('click', () => {
  const now = nyNow();
  if (state.active) {
    if (now.time === state.active.start && Date.now() - state.active.startedAt < 60000) {
      toast('Clock-in canceled (under a minute)');
    } else {
      state.shifts.push({ id: newId(), date: state.active.date, start: state.active.start, end: now.time });
      toast(`Clocked out at ${time12(now.time)}`);
    }
    state.active = null;
  } else {
    state.active = { date: now.date, start: now.time, startedAt: Date.now() };
    toast(`Clocked in at ${time12(now.time)}`);
  }
  save();
  render();
});

function renderClock() {
  const now = nyNow();
  $('nowText').textContent = `${fmtDate(now.date, { weekday: 'long', month: 'long', day: 'numeric' })} · ${time12(now.time)} NY`;
  const btn = $('clockBtn');
  if (state.active) {
    const secs = Math.max(0, Math.floor((Date.now() - state.active.startedAt) / 1000));
    $('timer').textContent = `${Math.floor(secs / 3600)}:${String(Math.floor(secs / 60) % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    $('statusText').textContent = `Clocked in since ${time12(state.active.start)}`;
    btn.textContent = 'Clock Out';
    btn.className = 'big out';
  } else {
    $('timer').textContent = '0:00:00';
    $('statusText').textContent = 'Not clocked in';
    btn.textContent = 'Clock In';
    btn.className = 'big in';
  }
  const today = state.shifts.filter((s) => s.date === now.date);
  let todayMin = sumMinutes(today);
  let monthMin = sumMinutes(shiftsIn(now.date.slice(0, 7)));
  if (state.active) {
    const running = shiftMinutes({ start: state.active.start, end: now.time });
    todayMin += running;
    monthMin += running;
  }
  $('todayHours').textContent = `${hours(todayMin)} h`;
  $('monthHours').textContent = `${hours(monthMin)} h`;
}

// ---------- hours list ----------

function renderHours() {
  const list = shiftsIn(viewMonth);
  const ul = $('shiftList');
  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = '<li class="empty">No shifts this month</li>';
  }
  for (const s of list) {
    const li = document.createElement('li');
    li.innerHTML = `<div><div class="when"></div><div class="times"></div></div><div class="hrs"></div>`;
    li.querySelector('.when').textContent = `${dayName(s.date)} ${fmtDate(s.date, { month: 'short', day: 'numeric' })}`;
    li.querySelector('.times').textContent = `${time12(s.start)} – ${time12(s.end)}`;
    li.querySelector('.hrs').textContent = `${hours(shiftMinutes(s))} h`;
    li.addEventListener('click', () => openShift(s));
    ul.appendChild(li);
  }
  $('hoursTotal').textContent = `${hours(sumMinutes(list))} h`;
}

let editing = null;

function openShift(s) {
  editing = s || null;
  const st = state.settings;
  const today = nyNow().date;
  $('shiftDialogTitle').textContent = s ? 'Edit shift' : 'Add shift';
  $('fDate').value = s ? s.date : (today.startsWith(viewMonth) ? today : `${viewMonth}-01`);
  $('fStart').value = s ? s.start : st.start;
  $('fEnd').value = s ? s.end : st.end;
  $('fDelete').classList.toggle('hidden', !s);
  $('shiftDialog').showModal();
}

$('addShiftBtn').addEventListener('click', () => openShift(null));

$('shiftDialog').addEventListener('close', () => {
  const action = $('shiftDialog').returnValue;
  if (action === 'save') {
    const data = { date: $('fDate').value, start: $('fStart').value, end: $('fEnd').value };
    if (!data.date || !data.start || !data.end) return;
    if (editing) Object.assign(editing, data);
    else state.shifts.push({ id: newId(), ...data });
    save();
    toast('Shift saved');
  } else if (action === 'delete' && editing) {
    state.shifts = state.shifts.filter((s) => s.id !== editing.id);
    save();
    toast('Shift deleted');
  }
  editing = null;
  render();
});

$('fillBtn').addEventListener('click', () => {
  const st = state.settings;
  const [y, m] = viewMonth.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const taken = new Set(shiftsIn(viewMonth).map((s) => s.date));
  let added = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${viewMonth}-${String(d).padStart(2, '0')}`;
    if (st.days.includes(asDate(date).getUTCDay()) && !taken.has(date)) {
      state.shifts.push({ id: newId(), date, start: st.start, end: st.end });
      added++;
    }
  }
  save();
  render();
  toast(added ? `Added ${added} shifts. Tap any day to change or delete it.` : 'Schedule already filled');
});

// ---------- template ----------

function templateName() {
  try { return localStorage.getItem(TEMPLATE_NAME_KEY) || 'Starter template'; } catch (e) { return 'Starter template'; }
}

async function getTemplateBytes() {
  try {
    const b64 = localStorage.getItem(TEMPLATE_KEY);
    if (b64) return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch (e) { /* use starter */ }
  const res = await fetch(STARTER_TEMPLATE);
  return new Uint8Array(await res.arrayBuffer());
}

$('templateFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    fillTemplate(bytes, invoiceData(viewMonth, 1)); // make sure it actually works before keeping it
  } catch (err) {
    toast(`That template has a problem: ${templateError(err)}`);
    return;
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  try {
    localStorage.setItem(TEMPLATE_KEY, btoa(bin));
    localStorage.setItem(TEMPLATE_NAME_KEY, file.name);
    toast('Template saved. Invoices will use it from now on.');
  } catch (err) {
    toast('Template is too big to save on this device');
  }
  render();
});

$('resetTemplateBtn').addEventListener('click', () => {
  try {
    localStorage.removeItem(TEMPLATE_KEY);
    localStorage.removeItem(TEMPLATE_NAME_KEY);
  } catch (e) { /* nothing stored */ }
  toast('Using the starter template');
  render();
});

$('shareTemplateBtn').addEventListener('click', async () => {
  const name = templateName() === 'Starter template' ? 'invoice-template.docx' : templateName();
  deliver([new File([await getTemplateBytes()], name, { type: DOCX_TYPE })]);
});

// ---------- invoice ----------

function invoiceData(ym, number) {
  const st = state.settings;
  const list = shiftsIn(ym);
  const totalMin = sumMinutes(list);
  const totalHours = Number(hours(totalMin));
  const subtotal = Math.round(totalHours * Number(st.rate || 0) * 100) / 100;
  const wireFee = Number(st.wireFee || 0);
  return {
    my_name: st.name,
    my_email: st.email,
    bill_to: st.billTo,
    notes: st.notes,
    invoice_number: String(number),
    // Always the day the invoice is made, in New York time
    invoice_date: fmtDate(nyNow().date, { month: 'long', day: 'numeric', year: 'numeric' }),
    period: monthName(ym),
    shifts: list.map((s) => ({
      date: fmtDate(s.date, { month: '2-digit', day: '2-digit' }),
      in: time12(s.start),
      out: time12(s.end),
      hours: hours(shiftMinutes(s)),
    })),
    total_hours: totalHours.toFixed(2),
    rate: money(st.rate),
    subtotal: money(subtotal),
    wire_fee: money(wireFee),
    total: money(subtotal + wireFee),
  };
}

function fillTemplate(bytes, data) {
  const doc = new window.docxtemplater(new PizZip(bytes), {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  });
  doc.render(data);
  return doc.getZip().generate({ type: 'blob', mimeType: DOCX_TYPE, compression: 'DEFLATE' });
}

function templateError(err) {
  const first = err && err.properties && err.properties.errors && err.properties.errors[0];
  return (first && first.properties && first.properties.explanation) || (err && err.message) || 'unknown error';
}

async function docxToPdf(docxBlob) {
  // Draw into a child of the off-screen holder so the snapshot doesn't inherit the off-screen position.
  const holder = $('render');
  holder.innerHTML = '<div></div>';
  const box = holder.firstChild;
  await window.docx.renderAsync(docxBlob, box, null, {
    inWrapper: false, ignoreLastRenderedPageBreak: true, breakPages: true, experimental: true,
  });
  try {
    return await html2pdf()
      .set({
        margin: 0,
        html2canvas: { scale: 2, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
        pagebreak: { mode: ['css'], before: 'section.docx + section.docx', avoid: 'tr' },
      })
      .from(box)
      .outputPdf('blob');
  } finally {
    holder.innerHTML = '';
  }
}

let madeFiles = { pdf: null, docx: null };

// A month keeps its number once invoiced; a new month gets the next number.
const invoiceNumberFor = (ym) => state.invoices[ym] ?? state.nextInvoice;

function renderInvoice() {
  const data = invoiceData(viewMonth, 1);
  const done = state.invoices[viewMonth] != null;
  $('invNumber').textContent = `#${invoiceNumberFor(viewMonth)}`;
  $('invNumberHint').textContent = done
    ? `${monthName(viewMonth)} was already invoiced as #${state.invoices[viewMonth]}. Making it again keeps the same number.`
    : `Next invoice number. It goes up by one each month and can't go backward.`;
  $('invShifts').textContent = data.shifts.length;
  $('invHours').textContent = data.total_hours;
  $('invRate').textContent = `$${data.rate}/hr`;
  $('invSubtotal').textContent = `$${data.subtotal}`;
  $('invWire').textContent = `$${data.wire_fee}`;
  $('invTotal').textContent = `$${data.total}`;
}

$('makeInvoiceBtn').addEventListener('click', async () => {
  const btn = $('makeInvoiceBtn');
  const number = invoiceNumberFor(viewMonth);
  const data = invoiceData(viewMonth, number);
  if (!data.shifts.length) { toast('No shifts in this month yet'); return; }
  if (!state.settings.rate) toast('Tip: set your hourly rate in Settings');
  btn.disabled = true;
  btn.textContent = 'Making invoice…';
  try {
    const base = `Invoice-${number}-${viewMonth}`;
    const docxBlob = fillTemplate(await getTemplateBytes(), data);
    const pdfBlob = await docxToPdf(docxBlob);
    madeFiles = {
      docx: new File([docxBlob], `${base}.docx`, { type: DOCX_TYPE }),
      pdf: new File([pdfBlob], `${base}.pdf`, { type: 'application/pdf' }),
    };
    if (state.invoices[viewMonth] == null) {
      state.invoices[viewMonth] = number;
      state.nextInvoice = number + 1;
    }
    save();
    $('invoiceMsg').textContent = `Invoice #${number} for ${data.period}: ${data.total_hours} h, $${data.total}`;
    $('invoiceOut').classList.remove('hidden');
    renderInvoice();
  } catch (err) {
    console.error(err);
    toast(`Could not make invoice: ${templateError(err)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Make Invoice';
  }
});

// Sharing has to start from a tap, so the share buttons appear after the files are made.
$('sharePdfBtn').addEventListener('click', () => madeFiles.pdf && deliver([madeFiles.pdf]));
$('shareDocxBtn').addEventListener('click', () => madeFiles.docx && deliver([madeFiles.docx]));

async function deliver(files) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
}

// ---------- settings ----------

const SETTING_FIELDS = [
  ['sName', 'name'], ['sEmail', 'email'], ['sBillTo', 'billTo'], ['sRate', 'rate'],
  ['sWireFee', 'wireFee'], ['sNotes', 'notes'], ['sStart', 'start'], ['sEnd', 'end'],
];
const NUMBER_SETTINGS = ['rate', 'wireFee'];

function renderSettings() {
  const st = state.settings;
  for (const [id, key] of SETTING_FIELDS) {
    if (document.activeElement !== $(id)) $(id).value = st[key] ?? '';
  }
  const days = $('sDays');
  if (!days.children.length) {
    DAY_NAMES.forEach((name, i) => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" value="${i}"><span>${name}</span>`;
      label.querySelector('input').addEventListener('change', (e) => {
        const set = new Set(state.settings.days);
        e.target.checked ? set.add(i) : set.delete(i);
        state.settings.days = [...set].sort();
        save();
      });
      days.appendChild(label);
    });
  }
  days.querySelectorAll('input').forEach((inp) => { inp.checked = st.days.includes(Number(inp.value)); });
}

for (const [id, key] of SETTING_FIELDS) {
  $(id).addEventListener('input', (e) => {
    state.settings[key] = NUMBER_SETTINGS.includes(key) ? Number(e.target.value) : e.target.value;
    save();
  });
}

$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  deliver([new File([blob], `timeclock-backup-${nyNow().date}.json`, { type: 'application/json' })]);
});

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.shifts)) throw new Error('not a backup');
    state = fromSaved(data);
    save();
    toast(`Restored ${state.shifts.length} shifts`);
    render();
  } catch (err) {
    toast('That file is not a Time Clock backup');
  }
});

// ---------- boot ----------

function render() {
  document.querySelectorAll('.month-label').forEach((el) => { el.textContent = monthName(viewMonth); });
  $('templateName').textContent = templateName();
  $('templateName2').textContent = templateName();
  renderClock();
  renderHours();
  renderInvoice();
  renderSettings();
}

render();
setInterval(renderClock, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
