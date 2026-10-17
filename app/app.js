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
    // One record per invoiced month: 'YYYY-MM' -> { number, amount, hours, madeOn, sent, sentOn, paid, paidOn }.
    // Past invoices come in through a backup restore, so no personal amounts live in this (public) code.
    invoices: {},
    nextInvoice: 10, // September 2026 was #9
    settings: {
      name: '', email: '', billTo: '', rate: 0, wireFee: 15, notes: '',
      days: [2, 4, 5], start: '10:00', end: '15:00',
    },
  };
}

// Merge saved data over defaults and make sure the next invoice number is above every one already used.
function fromSaved(saved) {
  const base = defaultState();
  const savedInvoices = saved.invoices || {};
  const invoices = {};
  for (const ym of new Set([...Object.keys(base.invoices), ...Object.keys(savedInvoices)])) {
    const v = savedInvoices[ym];
    // Older versions stored just the number for a month.
    invoices[ym] = typeof v === 'number' ? { ...base.invoices[ym], number: v } : { ...base.invoices[ym], ...v };
  }
  const s = { ...base, ...saved, settings: { ...base.settings, ...saved.settings }, invoices };
  s.nextInvoice = Math.max(Number(s.nextInvoice) || 1, base.nextInvoice, ...Object.values(invoices).map((r) => r.number + 1));
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
    amount: subtotal + wireFee,
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
const invoiceNumberFor = (ym) => state.invoices[ym]?.number ?? state.nextInvoice;

function statusText(rec) {
  const on = (ymd) => (ymd ? ` ${fmtDate(ymd, { month: 'short', day: 'numeric' })}` : '');
  if (rec.paid) return `Paid${on(rec.paidOn)}`;
  if (rec.sent) return `Sent${on(rec.sentOn)}, not paid yet`;
  return 'Made, not sent yet';
}

function renderInvoice() {
  const data = invoiceData(viewMonth, 1);
  const rec = state.invoices[viewMonth];
  $('invNumber').textContent = `#${invoiceNumberFor(viewMonth)}`;
  $('invStatus').textContent = rec ? statusText(rec) : 'Not made yet';
  $('invNumberHint').textContent = rec
    ? `${monthName(viewMonth)} was already invoiced as #${rec.number}. Making it again keeps the same number.`
    : `Next invoice number. It goes up by one each month and can't go backward.`;
  $('markSentBtn').classList.toggle('hidden', !rec || !!rec.sent);
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
  const rec = state.invoices[viewMonth];
  if (rec && rec.sent && !confirm(`Invoice #${number} was already sent. Make it again with the current hours? Your boss may have the old version.`)) return;
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
    if (!rec) state.nextInvoice = number + 1;
    state.invoices[viewMonth] = {
      ...rec, number, amount: data.amount, hours: Number(data.total_hours), madeOn: nyNow().date,
    };
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
$('markSentBtn').addEventListener('click', () => markInvoice(viewMonth, 'sent'));

// ---------- paid (invoice history) ----------

function markInvoice(ym, step) {
  const rec = state.invoices[ym];
  if (!rec) return;
  const today = nyNow().date;
  rec.sent = true;
  rec.sentOn = rec.sentOn || today;
  if (step === 'paid') {
    rec.paid = true;
    rec.paidOn = today;
  }
  save();
  toast(`Invoice #${rec.number} marked ${step}`);
  render();
}

// Saved amount, or for invoices made before amounts were saved, the amount from that month's shifts.
function invoiceAmount(ym) {
  const rec = state.invoices[ym];
  if (rec.amount != null) return rec.amount;
  return shiftsIn(ym).length ? invoiceData(ym, rec.number).amount : null;
}

function renderPaid() {
  const months = Object.keys(state.invoices).sort().reverse();
  const owed = months.filter((ym) => state.invoices[ym].sent && !state.invoices[ym].paid);
  $('owedTotal').textContent = `$${money(owed.reduce((t, ym) => t + Number(invoiceAmount(ym) || 0), 0))}`;
  $('owedCount').textContent = owed.length === 1 ? '1 invoice sent and not paid' : `${owed.length} invoices sent and not paid`;
  const ul = $('invoiceList');
  ul.innerHTML = '';
  for (const ym of months) {
    const rec = state.invoices[ym];
    const li = document.createElement('li');
    li.innerHTML = `<div><div class="when"></div><div class="times inv-status"></div></div><div class="right"><div class="hrs"></div></div>`;
    li.querySelector('.when').textContent = `#${rec.number} · ${monthName(ym)}`;
    const st = li.querySelector('.inv-status');
    st.textContent = statusText(rec);
    st.classList.add(rec.paid ? 'st-paid' : rec.sent ? 'st-sent' : 'st-made');
    const amount = invoiceAmount(ym);
    li.querySelector('.hrs').textContent = amount != null ? `$${money(amount)}` : '—';
    if (!rec.paid) {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = rec.sent ? 'Mark paid' : 'Mark sent';
      b.addEventListener('click', (e) => { e.stopPropagation(); markInvoice(ym, rec.sent ? 'paid' : 'sent'); });
      li.querySelector('.right').appendChild(b);
    }
    li.addEventListener('click', () => openInvoice(ym));
    ul.appendChild(li);
  }
}

// ---------- income (yearly totals) ----------

let viewYear = Number(nyNow().date.slice(0, 4));

$('yearPrev').addEventListener('click', () => { viewYear--; render(); });
$('yearNext').addEventListener('click', () => { viewYear++; render(); });

function renderIncome() {
  $('yearLabel').textContent = viewYear;
  const months = Object.keys(state.invoices).filter((ym) => ym.startsWith(`${viewYear}-`)).sort();
  let total = 0, received = 0, owed = 0, hoursSum = 0;
  const missing = [];
  const rows = months.map((ym) => {
    const rec = state.invoices[ym];
    const amount = invoiceAmount(ym);
    const hrs = rec.hours ?? (shiftsIn(ym).length ? sumMinutes(shiftsIn(ym)) / 60 : null);
    if (amount == null) missing.push(fmtDate(`${ym}-01`, { month: 'long' }));
    else {
      total += amount;
      if (rec.paid) received += amount;
      else if (rec.sent) owed += amount;
    }
    if (hrs != null) hoursSum += hrs;
    return { ym, rec, amount, hrs };
  });

  $('incTotal').textContent = `$${money(total)}`;
  $('incReceived').textContent = `$${money(received)}`;
  $('incOwed').textContent = `$${money(owed)}`;
  $('incHours').textContent = hoursSum ? hoursSum.toFixed(2) : '—';
  $('incMissing').textContent = missing.length
    ? `Missing an amount: ${missing.join(', ')}. Tap the month to add it.`
    : '';

  const max = Math.max(1, ...rows.map((r) => r.amount || 0));
  const ul = $('incomeList');
  ul.innerHTML = rows.length ? '' : '<li class="empty">No invoices this year</li>';
  for (const { ym, rec, amount } of rows) {
    const li = document.createElement('li');
    li.className = 'bar-row';
    li.innerHTML = `<div class="bar-top"><span class="when"></span><span class="hrs"></span></div><div class="bar"><span></span></div><div class="times inv-status"></div>`;
    li.querySelector('.when').textContent = fmtDate(`${ym}-01`, { month: 'long' });
    li.querySelector('.hrs').textContent = amount != null ? `$${money(amount)}` : 'amount missing';
    const fill = li.querySelector('.bar span');
    fill.style.width = `${amount != null ? Math.max(2, (amount / max) * 100) : 0}%`;
    fill.className = rec.paid ? 'paid' : rec.sent ? 'sent' : 'made';
    const st = li.querySelector('.inv-status');
    st.textContent = `#${rec.number} · ${statusText(rec)}`;
    st.classList.add(rec.paid ? 'st-paid' : rec.sent ? 'st-sent' : 'st-made');
    li.addEventListener('click', () => openInvoice(ym));
    ul.appendChild(li);
  }
}

let editingMonth = null;

function openInvoice(ym) {
  const rec = state.invoices[ym];
  editingMonth = ym;
  $('invDialogTitle').textContent = `Invoice #${rec.number} · ${monthName(ym)}`;
  $('iAmount').value = invoiceAmount(ym) ?? '';
  $('iSent').checked = !!rec.sent;
  $('iSentOn').value = rec.sentOn || '';
  $('iPaid').checked = !!rec.paid;
  $('iPaidOn').value = rec.paidOn || '';
  $('invDialog').showModal();
}

// Checking a box fills in today's date; paid implies sent.
$('iSent').addEventListener('change', (e) => {
  if (e.target.checked && !$('iSentOn').value) $('iSentOn').value = nyNow().date;
  if (!e.target.checked) $('iPaid').checked = false;
});
$('iPaid').addEventListener('change', (e) => {
  if (e.target.checked) {
    if (!$('iPaidOn').value) $('iPaidOn').value = nyNow().date;
    if (!$('iSent').checked) $('iSent').click();
  }
});

$('invDialog').addEventListener('close', () => {
  const rec = state.invoices[editingMonth];
  if ($('invDialog').returnValue === 'save' && rec) {
    const amount = $('iAmount').value;
    rec.amount = amount === '' ? undefined : Number(amount);
    rec.sent = $('iSent').checked;
    rec.sentOn = rec.sent ? $('iSentOn').value || undefined : undefined;
    rec.paid = $('iPaid').checked;
    rec.paidOn = rec.paid ? $('iPaidOn').value || undefined : undefined;
    save();
    toast('Invoice updated');
  }
  editingMonth = null;
  render();
});

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
  renderPaid();
  renderIncome();
  renderSettings();
}

render();
setInterval(renderClock, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
