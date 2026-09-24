/* ============================================================
   تطبيق متابعة عُهد السواقين - المنطق الرئيسي
   ============================================================ */

const SERVER_URL = localStorage.getItem('server_url') || 'https://by1010.onrender.com';

const STORAGE = {
  SESSION: 'dt_session',
  TRIPS: 'dt_trips',
  PENDING: 'dt_pending_sync',
  UPDATES: 'dt_updates',
  DRIVERS: 'dt_drivers_overrides'
};

/* ============================================================
   الحالة العامة
   ============================================================ */
const state = {
  user: null,
  currentTrip: null,
  online: navigator.onLine,
  drivers: {},
  trips: [],
  updates: [],
  pendingSync: [],
  selectedAdminDriver: null,
  reportTripId: null,
  listeners: [],
  editingTxId: null,
  editingModal: null // 'income' | 'expense'
};

/* ============================================================
   أدوات مساعدة
   ============================================================ */
const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => {
  const num = Number(n || 0);
  return num.toLocaleString('en-US') + ' ريال';
};
const nowDate = () => {
  const d = new Date();
  const days = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const dayName = days[d.getDay()];
  const date = d.toLocaleDateString('en-GB');
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return { dayName, date, time, iso: d.toISOString() };
};
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const days = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  return `${days[d.getDay()]} ${d.toLocaleDateString('en-GB')} - ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

/* ============================================================
   التخزين المحلي
   ============================================================ */
const store = {
  get(key, def = null) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : def;
    } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  },
  remove(key) { localStorage.removeItem(key); }
};

/* ============================================================
   إعداد السواقين
   ============================================================ */
function getDrivers() {
  const overrides = store.get(STORAGE.DRIVERS, {});
  const base = {
    driver1: { ...USERS.driver1 },
    driver2: { ...USERS.driver2 },
    driver3: { ...USERS.driver3 }
  };
  for (const id in overrides) {
    if (base[id]) base[id] = { ...base[id], ...overrides[id] };
  }
  state.drivers = base;
  return base;
}

function saveDriverOverride(id, patch) {
  const overrides = store.get(STORAGE.DRIVERS, {});
  overrides[id] = { ...(overrides[id] || {}), ...patch };
  store.set(STORAGE.DRIVERS, overrides);
  getDrivers();
}

/* ============================================================
   إدارة الشاشات
   ============================================================ */
function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const el = $(screenId);
  if (el) el.classList.remove('hidden');
  window.scrollTo(0, 0);
}

/* ============================================================
   إدارة الحملات
   ============================================================ */
function loadTrips() {
  state.trips = store.get(STORAGE.TRIPS, []);
  return state.trips;
}
function saveTrips() {
  store.set(STORAGE.TRIPS, state.trips);
}

function getDriverTrips(driverId) {
  return state.trips
    .filter(t => t.driverId === driverId)
    .sort((a,b) => (a.tripNumber||0) - (b.tripNumber||0));
}

function getActiveTrip(driverId) {
  return state.trips.find(t => t.driverId === driverId && t.status === 'ongoing');
}

function nextTripNumber(driverId) {
  const trips = getDriverTrips(driverId);
  return trips.length + 1;
}

async function startNewTrip() {
  const driverId = state.user.id;
  if (getActiveTrip(driverId)) {
    toast('لديك حملة نشطة بالفعل', 'err');
    return;
  }
  const now = nowDate();
  const trip = {
    id: uid(),
    driverId,
    tripNumber: nextTripNumber(driverId),
    status: 'ongoing',
    startDay: now.dayName,
    startDate: now.date,
    startTime: now.time,
    startISO: now.iso,
    endDay: null, endDate: null, endTime: null, endISO: null,
    transactions: [],
    finishInfo: null,
    duePerTrip: state.drivers[driverId]?.duePerTrip || 50000,
    synced: false
  };
  state.trips.push(trip);
  saveTrips();

  const ok = await fbPushTrip(trip);
  trip.synced = ok;
  saveTrips();

  queueSync('trip_start', { tripId: trip.id });
  openTripScreen(trip.id);
}

function openTripScreen(tripId) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return;
  state.currentTrip = trip;
  renderTripScreen();
  show('tripScreen');
  updateSyncIndicator();
}

/* ============================================================
   حساب الأرصدة - ✅ تصحيح المنطق
   ============================================================
   القاعدة:
     المطلوب = المخارج + مستحق السواق
     الفارق = العُهد - المطلوب
     - إذا الفارق موجب (العُهد أكبر) ⇒ متبقي عليه (بالأحمر)
     - إذا الفارق سالب (المخارج أكبر) ⇒ متبقي له (بالأخضر)
     - إذا صفر ⇒ مُسوَّى
*/
function computeTripBalance(trip) {
  let income = 0, expense = 0;
  for (const t of trip.transactions || []) {
    if (t.kind === 'income') income += Number(t.amount);
    else if (t.kind === 'expense') expense += Number(t.amount);
  }
  const due = Number(trip.duePerTrip || 0);
  const required = expense + due;          // المطلوب من السواق
  const diff = income - required;          // موجب = عليه، سالب = له
  return { income, expense, due, required, diff };
}

function computeDriverOverallBalance(driverId) {
  const trips = getDriverTrips(driverId);
  let balance = 0; // موجب = عليه، سالب = له
  for (const t of trips) {
    if (t.status === 'finished') {
      const b = computeTripBalance(t);
      balance += b.diff;
    }
  }
  const updates = state.updates.filter(u => u.driverId === driverId);
  for (const u of updates) {
    balance += Number(u.delta || 0);
  }
  return balance;
}

// دالة مساعدة للعرض: ترجع نص + كلاس
function balanceLabel(diff) {
  if (diff > 0) return { text: `متبقي عليه ${fmtMoney(diff)}`, cls: 'pos' };     // أحمر
  if (diff < 0) return { text: `متبقي له ${fmtMoney(Math.abs(diff))}`, cls: 'neg' }; // أخضر
  return { text: 'مُسوَّى', cls: '' };
}

/* ============================================================
   عرض شاشة الحملة
   ============================================================ */
function renderTripScreen() {
  const trip = state.currentTrip;
  if (!trip) return;
  $('tripTitle').textContent = `الحملة رقم ${trip.tripNumber}`;
  $('tripStartInfo').textContent = `${trip.startDay} ${trip.startDate} - ${trip.startTime}`;

  const b = computeTripBalance(trip);
  $('tripTotalIncome').textContent = fmtMoney(b.income);
  $('tripTotalExpense').textContent = fmtMoney(b.expense);
  $('tripDue').textContent = fmtMoney(b.due);

  const resultEl = $('tripResult');
  const r = balanceLabel(b.diff);
  resultEl.textContent = r.text;
  resultEl.className = r.cls;

  renderTransactions();
  updateSyncIndicator();
}

function renderTransactions() {
  const trip = state.currentTrip;
  const list = $('transactionsList');
  if (!trip || !trip.transactions || !trip.transactions.length) {
    list.innerHTML = '<div class="empty-state">لا توجد حركات بعد</div>';
    return;
  }
  list.innerHTML = '';
  trip.transactions.forEach((tx, idx) => {
    const item = document.createElement('div');
    item.className = 'tx-item ' + tx.kind;
    const kindLabel = tx.kind === 'income' ? 'استلام عهدة' : 'خرج';
    const sign = tx.kind === 'income' ? '+' : '-';
    const amountClass = tx.kind === 'income' ? 'income' : 'expense';

    let actions = `
      <button class="btn-edit" data-act="edit" data-id="${tx.id}">✏️ تعديل</button>
      <button class="btn-del" data-act="del" data-id="${tx.id}">🗑️ حذف</button>
    `;
    if (tx.kind === 'expense' && tx.imageUrl) {
      actions += `<button class="btn-view" data-act="view" data-id="${tx.id}">👁️ معاينة</button>`;
    }

    item.innerHTML = `
      <div class="tx-head">
        <div>
          <span class="tx-num">حركة #${idx + 1}</span>
          <span class="tx-type ${amountClass}">${kindLabel}</span>
        </div>
        <div class="tx-amount ${amountClass}">${sign} ${fmtMoney(tx.amount)}</div>
      </div>
      <div class="tx-meta">
        ${tx.kind === 'income'
          ? `المسلم: ${tx.from || '—'} • النوع: ${tx.payType || 'نقدا'}`
          : `البيان: ${tx.note || '—'}`}
        <br/>${fmtDateTime(tx.iso)}
      </div>
      <div class="tx-actions">${actions}</div>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('button[data-act]').forEach(btn => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if (act === 'del') deleteTransaction(id);
      if (act === 'edit') editTransaction(id);
      if (act === 'view') viewTransactionImage(id);
    };
  });
}

async function deleteTransaction(txId) {
  if (!confirm('تأكيد حذف الحركة؟')) return;
  const trip = state.currentTrip;
  trip.transactions = trip.transactions.filter(t => t.id !== txId);
  saveTrips();
  renderTripScreen();

  await fbPushTrip(trip);
  queueSync('trip_update', { tripId: trip.id });
  toast('تم الحذف', 'ok');
}

function viewTransactionImage(txId) {
  const trip = state.currentTrip;
  const tx = trip.transactions.find(t => t.id === txId);
  if (!tx || !tx.imageUrl) return;
  $('previewImage').src = tx.imageUrl;
  $('imagePreviewModal').classList.remove('hidden');
}

/* ============================================================
   ✅ تعديل حركة موجودة
   ============================================================ */
function editTransaction(txId) {
  const trip = state.currentTrip;
  const tx = trip.transactions.find(t => t.id === txId);
  if (!tx) return;

  state.editingTxId = txId;

  if (tx.kind === 'income') {
    state.editingModal = 'income';
    $('incomeHeader').textContent = 'تعديل عهدة';
    $('incomeFrom').value = tx.from || '';
    $('incomeAmount').value = tx.amount || '';
    const typeRadio = document.querySelector(`input[name="incomeType"][value="${tx.payType || 'نقدا'}"]`);
    if (typeRadio) typeRadio.checked = true;
    $('incomeModal').classList.remove('hidden');
  } else {
    state.editingModal = 'expense';
    $('expenseHeader').textContent = 'تعديل خرج';
    $('expenseAmount').value = tx.amount || '';
    $('expenseNote').value = tx.note || '';
    $('expenseImage').value = '';
    $('expensePreview').classList.add('hidden');
    $('expensePreview').innerHTML = '';
    state._pendingExpenseImage = tx.imageUrl && tx.imageUrl.startsWith('data:') ? tx.imageUrl : null;
    if (tx.imageUrl) {
      const prev = $('expensePreview');
      prev.classList.remove('hidden');
      prev.innerHTML = `<img src="${tx.imageUrl}" alt="preview" />`;
    }
    $('expenseModal').classList.remove('hidden');
  }
}

/* ============================================================
   استلام عهدة (إضافة/تعديل)
   ============================================================ */
function openIncomeModal() {
  state.editingTxId = null;
  state.editingModal = 'income';
  $('incomeHeader').textContent = 'استلام عهدة';
  $('incomeFrom').value = '';
  $('incomeAmount').value = '';
  document.querySelector('input[name="incomeType"][value="نقدا"]').checked = true;
  $('incomeModal').classList.remove('hidden');
}

async function confirmIncome() {
  const from = $('incomeFrom').value.trim();
  const amount = Number($('incomeAmount').value);
  const payType = document.querySelector('input[name="incomeType"]:checked').value;

  if (!from) return toast('أدخل اسم المسلم', 'err');
  if (!amount || amount <= 0) return toast('أدخل مبلغاً صحيحاً', 'err');

  const trip = state.currentTrip;

  if (state.editingTxId) {
    // تعديل
    const tx = trip.transactions.find(t => t.id === state.editingTxId);
    if (tx) {
      tx.from = from;
      tx.amount = amount;
      tx.payType = payType;
      tx.editedAt = new Date().toISOString();
    }
    toast('تم تعديل العهدة', 'ok');
  } else {
    // إضافة
    const now = nowDate();
    const tx = {
      id: uid(),
      kind: 'income',
      from,
      amount,
      payType,
      day: now.dayName, date: now.date, time: now.time, iso: now.iso
    };
    trip.transactions.push(tx);
    toast('تمت إضافة العهدة', 'ok');
  }

  saveTrips();
  $('incomeModal').classList.add('hidden');
  state.editingTxId = null;
  state.editingModal = null;
  renderTripScreen();

  await fbPushTrip(trip);
  queueSync('trip_update', { tripId: trip.id });
}

/* ============================================================
   إدراج خرج (إضافة/تعديل)
   ============================================================ */
function openExpenseModal() {
  state.editingTxId = null;
  state.editingModal = 'expense';
  $('expenseHeader').textContent = 'إدراج خرج';
  $('expenseAmount').value = '';
  $('expenseNote').value = '';
  $('expenseImage').value = '';
  $('expensePreview').classList.add('hidden');
  $('expensePreview').innerHTML = '';
  state._pendingExpenseImage = null;
  $('expenseModal').classList.remove('hidden');
}

function handleExpenseImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state._pendingExpenseImage = reader.result;
    const prev = $('expensePreview');
    prev.classList.remove('hidden');
    prev.innerHTML = `<img src="${reader.result}" alt="preview" />`;
  };
  reader.readAsDataURL(file);
}

async function confirmExpense() {
  const amount = Number($('expenseAmount').value);
  const note = $('expenseNote').value.trim();

  if (!amount || amount <= 0) return toast('أدخل مبلغاً صحيحاً', 'err');
  if (!note) return toast('أدخل البيان', 'err');

  const trip = state.currentTrip;

  if (state.editingTxId) {
    // تعديل
    const tx = trip.transactions.find(t => t.id === state.editingTxId);
    if (tx) {
      tx.amount = amount;
      tx.note = note;
      if (state._pendingExpenseImage !== null) {
        tx.imageUrl = state._pendingExpenseImage;
      }
      tx.editedAt = new Date().toISOString();
    }
    toast('تم تعديل الخرج', 'ok');
  } else {
    // إضافة
    const now = nowDate();
    const tx = {
      id: uid(),
      kind: 'expense',
      amount,
      note,
      imageUrl: state._pendingExpenseImage || null,
      day: now.dayName, date: now.date, time: now.time, iso: now.iso
    };
    trip.transactions.push(tx);
    toast('تمت إضافة الخرج', 'ok');
  }

  saveTrips();
  state._pendingExpenseImage = null;
  $('expenseModal').classList.add('hidden');
  state.editingTxId = null;
  state.editingModal = null;
  renderTripScreen();

  await fbPushTrip(trip);
  queueSync('trip_update', { tripId: trip.id });
}

/* ============================================================
   إنهاء الحملة
   ============================================================ */
function openFinishModal() {
  $('finishSupplier').value = '';
  $('finishSupplierRegion').value = '';
  $('finishMerchant').value = '';
  $('finishMerchantRegion').value = '';
  $('finishGoodsType').value = '';
  $('finishQuantity').value = '';
  $('finishModal').classList.remove('hidden');
}

async function confirmFinish() {
  const info = {
    supplier: $('finishSupplier').value.trim(),
    supplierRegion: $('finishSupplierRegion').value.trim(),
    merchant: $('finishMerchant').value.trim(),
    merchantRegion: $('finishMerchantRegion').value.trim(),
    goodsType: $('finishGoodsType').value.trim(),
    quantity: $('finishQuantity').value.trim()
  };
  if (!info.supplier || !info.merchant || !info.goodsType || !info.quantity) {
    return toast('أكمل جميع الحقول المطلوبة', 'err');
  }

  const trip = state.currentTrip;
  const now = nowDate();
  trip.finishInfo = info;
  trip.status = 'finished';
  trip.endDay = now.dayName;
  trip.endDate = now.date;
  trip.endTime = now.time;
  trip.endISO = now.iso;
  saveTrips();

  $('finishModal').classList.add('hidden');

  await fbPushTrip(trip);
  queueSync('trip_finish', { tripId: trip.id });

  const report = buildTripReport(trip);
  showReport(report);
}

/* ============================================================
   بناء تقرير الحملة
   ============================================================ */
function buildTripReport(trip) {
  const driver = state.drivers[trip.driverId];
  const b = computeTripBalance(trip);
  const incomeTx = (trip.transactions || []).filter(t => t.kind === 'income');
  const expenseTx = (trip.transactions || []).filter(t => t.kind === 'expense');

  return {
    trip,
    driver,
    summary: {
      incomeTotal: b.income,
      expenseTotal: b.expense,
      due: b.due,
      required: b.required,
      diff: b.diff,
      incomeCount: incomeTx.length,
      expenseCount: expenseTx.length,
      txCount: (trip.transactions || []).length
    }
  };
}

function showReport(report) {
  const { trip, driver, summary } = report;
  const body = $('reportBody');

  const rowsHtml = (trip.transactions || []).map((t, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${t.kind === 'income' ? 'استلام عهدة' : 'خرج'}</td>
      <td>${fmtMoney(t.amount)}</td>
      <td>${t.kind === 'income' ? (t.from || '—') + ' - ' + (t.payType||'') : (t.note || '—')}</td>
      <td>${t.date} ${t.time}</td>
    </tr>
  `).join('');

  const r = balanceLabel(summary.diff);

  body.innerHTML = `
    <div style="margin-bottom:14px;font-size:14px;line-height:2;">
      <div><b>الحملة:</b> رقم ${trip.tripNumber}</div>
      <div><b>السائق:</b> ${driver.name}</div>
      <div><b>القاطرة:</b> ${driver.trailer}</div>
      <div><b>البدء:</b> ${trip.startDay} ${trip.startDate} - ${trip.startTime}</div>
      <div><b>الانتهاء:</b> ${trip.endDay || ''} ${trip.endDate || ''} - ${trip.endTime || ''}</div>
      ${trip.finishInfo ? `
        <div><b>المورد:</b> ${trip.finishInfo.supplier} (${trip.finishInfo.supplierRegion})</div>
        <div><b>التاجر:</b> ${trip.finishInfo.merchant} (${trip.finishInfo.merchantRegion})</div>
        <div><b>البضاعة:</b> ${trip.finishInfo.goodsType} - ${trip.finishInfo.quantity}</div>
      ` : ''}
    </div>
    <table>
      <thead>
        <tr><th>#</th><th>النوع</th><th>المبلغ</th><th>البيان</th><th>التاريخ</th></tr>
      </thead>
      <tbody>${rowsHtml || '<tr><td colspan="5">لا توجد حركات</td></tr>'}</tbody>
    </table>
    <div class="rep-summary">
      <div><b>إجمالي العُهد:</b> ${fmtMoney(summary.incomeTotal)}</div>
      <div><b>إجمالي المخارج:</b> ${fmtMoney(summary.expenseTotal)}</div>
      <div><b>مستحق السائق (خصم تلقائي):</b> ${fmtMoney(summary.due)}</div>
      <div><b>إجمالي المطلوب:</b> ${fmtMoney(summary.required)}</div>
      <div style="font-size:16px;margin-top:8px;" class="${r.cls}"><b>${r.text}</b></div>
    </div>
  `;

  state.reportTripId = trip.id;
  $('reportModal').classList.remove('hidden');
}

/* ============================================================
   توليد PDF مع دعم الخط العربي
   ============================================================ */
let _arabicFontBase64 = null;

async function loadArabicFont() {
  if (_arabicFontBase64) return _arabicFontBase64;
  try {
    // خط Amiri من CDN (base64 جاهز)
    const res = await fetch('https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/amiri/Amiri-Regular.ttf');
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // تحويل إلى base64
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    _arabicFontBase64 = btoa(binary);
    return _arabicFontBase64;
  } catch (e) {
    console.warn('Failed to load Arabic font:', e);
    return null;
  }
}

async function generatePDF(trip) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });

  // تحميل الخط العربي
  const fontB64 = await loadArabicFont();
  let hasArabic = false;
  if (fontB64) {
    try {
      doc.addFileToVFS('Amiri-Regular.ttf', fontB64);
      doc.addFont('Amiri-Regular.ttf', 'Amiri', 'normal');
      doc.setFont('Amiri');
      hasArabic = true;
    } catch (e) {
      console.warn('Failed to register Arabic font:', e);
    }
  }

  const driver = state.drivers[trip.driverId];
  const b = computeTripBalance(trip);
  const r = balanceLabel(b.diff);

  // ================= Header =================
  const pageW = doc.internal.pageSize.getWidth();

  // شريط علوي ملوّن
  doc.setFillColor(21, 26, 61);
  doc.rect(0, 0, pageW, 30, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  const title = hasArabic ? `تقرير الحملة رقم ${trip.tripNumber}` : `Trip Report #${trip.tripNumber}`;
  doc.text(title, pageW / 2, 15, { align: 'center' });

  doc.setFontSize(11);
  const subtitle = hasArabic ? `${driver.name} - ${driver.trailer}` : `${driver.name} (${driver.trailer})`;
  doc.text(subtitle, pageW / 2, 24, { align: 'center' });

  doc.setTextColor(0, 0, 0);

  // ================= معلومات عامة =================
  let y = 40;
  doc.setFontSize(11);
  const dateRange = `${trip.startDate} ${trip.startTime}  →  ${trip.endDate || ''} ${trip.endTime || ''}`;
  doc.text(hasArabic ? `الفترة: ${dateRange}` : `Period: ${dateRange}`, pageW - 14, y, { align: 'right' });
  y += 6;

  if (trip.finishInfo) {
    doc.text(hasArabic
      ? `المورد: ${trip.finishInfo.supplier} (${trip.finishInfo.supplierRegion})`
      : `Supplier: ${trip.finishInfo.supplier} (${trip.finishInfo.supplierRegion})`,
      pageW - 14, y, { align: 'right' }); y += 6;
    doc.text(hasArabic
      ? `التاجر: ${trip.finishInfo.merchant} (${trip.finishInfo.merchantRegion})`
      : `Merchant: ${trip.finishInfo.merchant} (${trip.finishInfo.merchantRegion})`,
      pageW - 14, y, { align: 'right' }); y += 6;
    doc.text(hasArabic
      ? `البضاعة: ${trip.finishInfo.goodsType} - ${trip.finishInfo.quantity}`
      : `Goods: ${trip.finishInfo.goodsType} - ${trip.finishInfo.quantity}`,
      pageW - 14, y, { align: 'right' }); y += 6;
  }
  y += 4;

  // ================= جدول الحركات =================
  const head = hasArabic
    ? [['#', 'النوع', 'المبلغ', 'البيان', 'التاريخ']]
    : [['#', 'Type', 'Amount', 'Note', 'Date']];

  const body = (trip.transactions || []).map((t, i) => [
    String(i + 1),
    hasArabic ? (t.kind === 'income' ? 'استلام عهدة' : 'خرج') : (t.kind === 'income' ? 'Income' : 'Expense'),
    String(t.amount),
    t.kind === 'income' ? (t.from || '') : (t.note || ''),
    `${t.date} ${t.time}`
  ]);

  doc.autoTable({
    startY: y,
    head: head,
    body: body.length ? body : [[ '-', '-', '-', '-', '-' ]],
    styles: {
      font: hasArabic ? 'Amiri' : 'helvetica',
      fontSize: 10,
      halign: 'center',
      cellPadding: 3
    },
    headStyles: {
      fillColor: [21, 26, 61],
      textColor: [255, 255, 255],
      fontStyle: 'bold'
    },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    theme: 'grid'
  });

  // ================= ملخص =================
  y = doc.lastAutoTable.finalY + 12;
  doc.setFontSize(12);
  doc.setFont(hasArabic ? 'Amiri' : 'helvetica');

  const lineH = 7;
  const rightX = pageW - 14;

  doc.setTextColor(16, 185, 129);
  doc.text(hasArabic ? `إجمالي العُهد: ${b.income} ريال` : `Total Income: ${b.income}`, rightX, y, { align: 'right' }); y += lineH;

  doc.setTextColor(239, 68, 68);
  doc.text(hasArabic ? `إجمالي المخارج: ${b.expense} ريال` : `Total Expense: ${b.expense}`, rightX, y, { align: 'right' }); y += lineH;

  doc.setTextColor(245, 158, 11);
  doc.text(hasArabic ? `مستحق السائق (خصم تلقائي): ${b.due} ريال` : `Driver Due (auto): ${b.due}`, rightX, y, { align: 'right' }); y += lineH;

  doc.setTextColor(31, 41, 55);
  doc.text(hasArabic ? `إجمالي المطلوب: ${b.required} ريال` : `Total Required: ${b.required}`, rightX, y, { align: 'right' }); y += lineH + 4;

  // النتيجة النهائية بلون
  if (b.diff > 0) doc.setTextColor(220, 38, 38);       // أحمر = عليه
  else if (b.diff < 0) doc.setTextColor(5, 150, 105);   // أخضر = له
  else doc.setTextColor(100, 100, 100);

  doc.setFontSize(14);
  const finalText = hasArabic
    ? (b.diff > 0 ? `متبقي عليه: ${b.diff} ريال` : b.diff < 0 ? `متبقي له: ${Math.abs(b.diff)} ريال` : 'مُسوَّى')
    : (b.diff > 0 ? `Due from driver: ${b.diff}` : b.diff < 0 ? `Credit to driver: ${Math.abs(b.diff)}` : 'Settled');
  doc.text(finalText, rightX, y, { align: 'right' });

  // Footer
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFontSize(9);
  doc.setTextColor(150, 150, 150);
  doc.text(hasArabic ? 'تطبيق متابعة عُهد السواقين' : 'Driver Tracking App', pageW / 2, pageH - 10, { align: 'center' });

  return doc;
}

async function downloadReportPDF() {
  const trip = state.trips.find(t => t.id === state.reportTripId);
  if (!trip) return;
  toast('جاري تحضير التقرير...', '');
  const doc = await generatePDF(trip);
  doc.save(`Trip_${trip.tripNumber}_${trip.driverId}.pdf`);
  toast('تم تحميل التقرير', 'ok');
}

/* ============================================================
   نظام المزامنة
   ============================================================ */
function queueSync(action, payload) {
  const item = {
    id: uid(), action, payload,
    createdAt: new Date().toISOString(),
    tries: 0
  };
  state.pendingSync.push(item);
  store.set(STORAGE.PENDING, state.pendingSync);
  updateSyncIndicator();
  trySync();
}

async function trySync() {
  if (!state.online) return;
  if (!state.pendingSync.length) return;

  const queue = [...state.pendingSync];
  const remaining = [];

  for (const item of queue) {
    try {
      await sendToServer(item);
      markSynced(item);
    } catch (e) {
      item.tries++;
      remaining.push(item);
    }
  }

  state.pendingSync = remaining;
  store.set(STORAGE.PENDING, state.pendingSync);
  updateSyncIndicator();
}

async function markSynced(item) {
  const { action, payload } = item;
  if (action.startsWith('trip_')) {
    const trip = state.trips.find(t => t.id === payload.tripId);
    if (trip) {
      trip.synced = true;
      saveTrips();
      await fbPushTrip(trip);
    }
  }
}

async function sendToServer(item) {
  const { action, payload } = item;
  const trip = payload.tripId ? state.trips.find(t => t.id === payload.tripId) : null;

  if (trip) {
    try { await fbPushTrip(trip); } catch (e) {}
  }

  try {
    if (action === 'trip_finish' && trip) {
      const doc = await generatePDF(trip);
      const blob = doc.output('blob');
      const fd = new FormData();
      fd.append('file', blob, `Trip_${trip.tripNumber}.pdf`);
      fd.append('caption', buildCaption(trip));
      const res = await fetch(`${SERVER_URL}/api/upload-report`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error('report upload failed');
      return res.json();
    }

    if (action === 'transaction_add' && trip) {
      const tx = trip.transactions.find(t => t.id === payload.txId);
      if (!tx) return;
      if (tx.kind === 'expense' && tx.imageUrl && tx.imageUrl.startsWith('data:')) {
        const blob = dataURLtoBlob(tx.imageUrl);
        const fd = new FormData();
        fd.append('file', blob, `tx_${tx.id}.jpg`);
        fd.append('caption', `📸 توثيق خرج - ${state.drivers[trip.driverId].name} - حملة ${trip.tripNumber}`);
        const res = await fetch(`${SERVER_URL}/api/upload-to-telegram`, { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          tx.imageUrl = data.permanentLink || tx.imageUrl;
          saveTrips();
          await fbPushTrip(trip);
        }
      }
      await sendTextToServer(buildTxCaption(trip, tx));
      return;
    }

    if (trip) {
      await sendTextToServer(buildTripCaption(trip, action));
    }
  } catch (e) {
    console.warn('Telegram sync failed:', e);
  }
}

async function sendTextToServer(text) {
  const res = await fetch(`${SERVER_URL}/api/send-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error('send message failed');
  return res.json();
}

function buildCaption(trip) {
  const d = state.drivers[trip.driverId];
  const b = computeTripBalance(trip);
  const r = balanceLabel(b.diff);
  return `📊 <b>تقرير حملة رقم ${trip.tripNumber}</b>\n` +
         `👤 السائق: ${d.name}\n` +
         `🚛 ${d.trailer}\n` +
         `📅 البدء: ${trip.startDay} ${trip.startDate} ${trip.startTime}\n` +
         `📅 الانتهاء: ${trip.endDay} ${trip.endDate} ${trip.endTime}\n` +
         `💰 العُهد: ${b.income}\n` +
         `💸 المخارج: ${b.expense}\n` +
         `📉 مستحق السائق: ${b.due}\n` +
         `📌 النتيجة: ${r.text}`;
}

function buildTxCaption(trip, tx) {
  const d = state.drivers[trip.driverId];
  if (tx.kind === 'income') {
    return `💰 <b>عهدة جديدة</b>\n👤 ${d.name}\n🚛 حملة ${trip.tripNumber}\nالمبلغ: ${tx.amount}\nالمسلم: ${tx.from}\nالنوع: ${tx.payType}\n⏰ ${tx.day} ${tx.date} ${tx.time}`;
  }
  return `💸 <b>خرج جديد</b>\n👤 ${d.name}\n🚛 حملة ${trip.tripNumber}\nالمبلغ: ${tx.amount}\nالبيان: ${tx.note}\n⏰ ${tx.day} ${tx.date} ${tx.time}`;
}

function buildTripCaption(trip, action) {
  const d = state.drivers[trip.driverId];
  if (action === 'trip_start') {
    return `🚀 <b>بدأ حملة جديدة</b>\n👤 ${d.name}\n🚛 ${d.trailer}\n📋 حملة رقم ${trip.tripNumber}\n⏰ ${trip.startDay} ${trip.startDate} ${trip.startTime}`;
  }
  return `🔄 تحديث على حملة ${trip.tripNumber} - ${d.name}`;
}

function dataURLtoBlob(dataURL) {
  const parts = dataURL.split(',');
  const mime = parts[0].match(/:(.*?);/)[1];
  const bin = atob(parts[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* ============================================================
   مؤشر المزامنة
   ============================================================ */
function updateSyncIndicator() {
  const online = state.online;
  const pendingCount = state.pendingSync.length;

  document.querySelectorAll('.sync-indicator').forEach(ind => {
    const dot = ind.querySelector('.dot');
    const txt = ind.querySelector('.sync-text');
    if (!dot || !txt) return;
    if (online && pendingCount === 0) {
      dot.className = 'dot dot-green';
      txt.textContent = 'متزامن';
    } else if (online && pendingCount > 0) {
      dot.className = 'dot dot-green';
      txt.textContent = `مزامنة (${pendingCount})`;
    } else {
      dot.className = 'dot dot-red';
      txt.textContent = 'غير متصل';
    }
  });
}

/* ============================================================
   عرض الشاشات
   ============================================================ */
function renderDriverHome() {
  const u = state.user;
  const d = state.drivers[u.id];
  if (!d) return;
  $('dName').textContent = d.name;
  $('dPhone').textContent = '📞 ' + d.phone;
  $('dTrailer').textContent = '🚛 ' + d.trailer;

  const bal = computeDriverOverallBalance(u.id); // موجب = عليه
  const el = $('dBalance');
  el.textContent = fmtMoney(Math.abs(bal));
  el.className = 'balance-value ' + (bal > 0 ? 'positive' : bal < 0 ? 'negative' : '');
  $('dBalanceStatus').textContent = bal > 0 ? 'متبقي عليه' : bal < 0 ? 'متبقي له' : 'مُسوَّى';
}

function renderHistory() {
  const trips = getDriverTrips(state.user.id);
  const list = $('historyList');
  if (!trips.length) {
    list.innerHTML = '<div class="empty-state">لا توجد حملات بعد</div>';
    return;
  }
  list.innerHTML = '';
  trips.slice().reverse().forEach(trip => {
    const b = computeTripBalance(trip);
    const ongoing = trip.status === 'ongoing';
    const r = balanceLabel(b.diff);
    const card = document.createElement('div');
    card.className = 'history-card' + (ongoing ? ' active' : '');
    card.innerHTML = `
      <div class="hc-head">
        <div class="hc-title">الحملة رقم ${trip.tripNumber}</div>
        <div class="hc-status ${ongoing ? 'ongoing' : ''}">${ongoing ? 'جارية' : 'منتهية'}</div>
      </div>
      <div class="hc-grid">
        <div>البدء: <b>${trip.startDate} ${trip.startTime}</b></div>
        <div>الانتهاء: <b>${trip.endDate ? trip.endDate + ' ' + trip.endTime : '—'}</b></div>
        <div>عدد الحركات: <b>${(trip.transactions||[]).length}</b></div>
        <div>العُهد: <b>${fmtMoney(b.income)}</b></div>
      </div>
      <div class="hc-balance">
        <span>النتيجة:</span>
        <span class="${r.cls}">${r.text}</span>
      </div>
      <div class="tx-actions" style="margin-top:10px;">
        <button class="btn-view" data-trip="${trip.id}">👁️ معاينة التقرير</button>
        ${ongoing ? `<button data-open="${trip.id}">فتح الحملة</button>` : ''}
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('button[data-trip]').forEach(btn => {
    btn.onclick = () => {
      const trip = state.trips.find(t => t.id === btn.dataset.trip);
      if (trip) showReport(buildTripReport(trip));
    };
  });
  list.querySelectorAll('button[data-open]').forEach(btn => {
    btn.onclick = () => openTripScreen(btn.dataset.open);
  });
}

function renderUpdates() {
  const updates = state.updates
    .filter(u => u.driverId === state.user.id || u.driverId === 'all')
    .sort((a,b) => b.ts - a.ts);

  const list = $('updatesList');
  if (!updates.length) {
    list.innerHTML = '<div class="empty-state">لا توجد تحديثات</div>';
    return;
  }
  list.innerHTML = '';
  updates.forEach(u => {
    const item = document.createElement('div');
    item.className = 'tx-item';
    const sign = u.delta >= 0 ? '+' : '-';
    const cls = u.delta >= 0 ? 'income' : 'expense';
    item.innerHTML = `
      <div class="tx-head">
        <div class="tx-type ${cls}">${u.type === 'settle' ? 'تسوية رصيد' : 'تحديث'}</div>
        <div class="tx-amount ${cls}">${sign} ${fmtMoney(Math.abs(u.delta))}</div>
      </div>
      <div class="tx-meta">${u.note || '—'}<br/>${fmtDateTime(new Date(u.ts).toISOString())}</div>
    `;
    list.appendChild(item);
  });
}

/* ============================================================
   واجهة المشرف
   ============================================================ */
function renderAdminHome() {
  const grid = $('driversGrid');
  grid.innerHTML = '';
  const driverIds = ['driver1','driver2','driver3'];
  driverIds.forEach(id => {
    const d = state.drivers[id];
    if (!d) return;
    const bal = computeDriverOverallBalance(id); // موجب = عليه
    const row = document.createElement('div');
    row.className = 'driver-row';
    const label = bal > 0 ? `عليه ${fmtMoney(bal)}` : bal < 0 ? `له ${fmtMoney(Math.abs(bal))}` : 'مُسوَّى';
    const cls = bal > 0 ? 'pos' : bal < 0 ? 'neg' : '';
    row.innerHTML = `
      <div class="driver-avatar">👤</div>
      <div class="driver-info">
        <div class="driver-name">${d.name}</div>
        <div class="driver-meta">${d.trailer} • ${d.phone}</div>
      </div>
      <div class="${cls}" style="font-weight:800;font-size:13px;">${label}</div>
      <div class="chev">›</div>
    `;
    row.onclick = () => openAdminDriver(id);
    grid.appendChild(row);
  });

  const act = $('adminActivityList');
  const all = [...state.updates].sort((a,b) => b.ts - a.ts).slice(0, 20);
  if (!all.length) {
    act.innerHTML = '<div class="empty-state">لا توجد نشاطات</div>';
  } else {
    act.innerHTML = '';
    all.forEach(u => {
      const d = state.drivers[u.driverId];
      const item = document.createElement('div');
      item.className = 'tx-item';
      const sign = u.delta >= 0 ? '+' : '-';
      const cls = u.delta >= 0 ? 'income' : 'expense';
      item.innerHTML = `
        <div class="tx-head">
          <div class="tx-type ${cls}">${d ? d.name : 'عام'} - ${u.type === 'settle' ? 'تسوية' : u.type}</div>
          <div class="tx-amount ${cls}">${sign} ${fmtMoney(Math.abs(u.delta))}</div>
        </div>
        <div class="tx-meta">${u.note || ''}<br/>${fmtDateTime(new Date(u.ts).toISOString())}</div>
      `;
      act.appendChild(item);
    });
  }
}

function openAdminDriver(driverId) {
  state.selectedAdminDriver = driverId;
  const d = state.drivers[driverId];
  $('adminDriverTitle').textContent = d.name;
  $('adName').textContent = d.name;
  $('adPhone').textContent = '📞 ' + d.phone;
  $('adTrailer').textContent = '🚛 ' + d.trailer;

  const bal = computeDriverOverallBalance(driverId);
  const el = $('adBalance');
  el.textContent = fmtMoney(Math.abs(bal));
  el.className = 'balance-value ' + (bal > 0 ? 'positive' : bal < 0 ? 'negative' : '');
  $('adBalanceStatus').textContent = bal > 0 ? 'متبقي عليه' : bal < 0 ? 'متبقي له' : 'مُسوَّى';

  const trips = getDriverTrips(driverId);
  const lastTrip = trips.slice().sort((a,b) => new Date(b.startISO) - new Date(a.startISO))[0];
  $('adLastSync').textContent = lastTrip ? 'آخر نشاط: ' + fmtDateTime(lastTrip.startISO) : 'آخر نشاط: —';

  const list = $('adminTripsList');
  if (!trips.length) {
    list.innerHTML = '<div class="empty-state">لا توجد حملات</div>';
  } else {
    list.innerHTML = '';
    trips.slice().reverse().forEach(trip => {
      const b = computeTripBalance(trip);
      const ongoing = trip.status === 'ongoing';
      const r = balanceLabel(b.diff);
      const card = document.createElement('div');
      card.className = 'history-card' + (ongoing ? ' active' : '');
      card.innerHTML = `
        <div class="hc-head">
          <div class="hc-title">الحملة رقم ${trip.tripNumber}</div>
          <div class="hc-status ${ongoing ? 'ongoing' : ''}">${ongoing ? 'جارية' : 'منتهية'}</div>
        </div>
        <div class="hc-grid">
          <div>البدء: <b>${trip.startDate} ${trip.startTime}</b></div>
          <div>الانتهاء: <b>${trip.endDate ? trip.endDate + ' ' + trip.endTime : '—'}</b></div>
          <div>عدد الحركات: <b>${(trip.transactions||[]).length}</b></div>
          <div>${trip.synced ? '✅ متزامنة' : '⏳ معلقة'}</div>
        </div>
        <div class="hc-balance">
          <span>النتيجة:</span>
          <span class="${r.cls}">${r.text}</span>
        </div>
        <div class="tx-actions" style="margin-top:10px;">
          <button class="btn-view" data-trip="${trip.id}">👁️ معاينة التقرير</button>
        </div>
      `;
      list.appendChild(card);
    });

    list.querySelectorAll('button[data-trip]').forEach(btn => {
      btn.onclick = () => {
        const trip = state.trips.find(t => t.id === btn.dataset.trip);
        if (trip) showReport(buildTripReport(trip));
      };
    });
  }

  show('adminDriverScreen');
}

function openEditDriverModal() {
  const d = state.drivers[state.selectedAdminDriver];
  $('editDriverName').value = d.name;
  $('editDriverTrailer').value = d.trailer;
  $('editDriverDue').value = d.duePerTrip || 50000;
  $('editDriverModal').classList.remove('hidden');
}

async function confirmEditDriver() {
  const name = $('editDriverName').value.trim();
  const trailer = $('editDriverTrailer').value.trim();
  const due = Number($('editDriverDue').value) || 50000;
  if (!name || !trailer) return toast('أكمل الحقول', 'err');

  const patch = { name, trailer, duePerTrip: due };
  saveDriverOverride(state.selectedAdminDriver, patch);

  const ok = await fbPushDriverOverride(state.selectedAdminDriver, patch);
  if (!ok) toast('فشل المزامنة', 'err');

  $('editDriverModal').classList.add('hidden');
  toast('تم حفظ الإعدادات', 'ok');
  openAdminDriver(state.selectedAdminDriver);
}

function openSettleModal(isDeduct) {
  state._settleMode = isDeduct ? 'deduct' : 'add';
  $('settleHeader').textContent = isDeduct ? 'خصم من الرصيد' : 'إضافة إلى الرصيد';
  $('settleAmount').value = '';
  $('settleNote').value = '';
  $('settleModal').classList.remove('hidden');
}

async function confirmSettle() {
  const amount = Number($('settleAmount').value);
  const note = $('settleNote').value.trim();
  if (!amount || amount <= 0) return toast('أدخل مبلغاً صحيحاً', 'err');

  // ملاحظة:
  // delta موجب ⇒ إضافة مبلغ للرصيد
  //   في منطقنا "موجب = عليه" ⇒ إضافة تعني زيادة ما عليه؟
  //   لكن تسوية المشرف تعني: خصم من المبلغ اللي عليه ⇒ delta سالب
  // لتوضيح: المشرف يعمل "تسوية" لصالح السواق (خصم من اللي عليه) ⇒ delta سالب
  // أو "خصم على السواق" (زيادة ما عليه) ⇒ delta موجب
  const delta = state._settleMode === 'deduct' ? amount : -amount;

  const update = {
    id: uid(),
    driverId: state.selectedAdminDriver,
    type: 'settle',
    delta,
    note: note || (delta > 0 ? 'خصم على الرصيد' : 'تسوية لصالح السواق'),
    ts: Date.now()
  };

  state.updates.push(update);
  store.set(STORAGE.UPDATES, state.updates);

  const ok = await fbPushUpdate(update);
  if (!ok) toast('فشل المزامنة', 'err');

  $('settleModal').classList.add('hidden');
  toast('تم تنفيذ التسوية', 'ok');
  openAdminDriver(state.selectedAdminDriver);

  sendTextToServer(
    `⚙️ <b>${state._settleMode === 'deduct' ? 'خصم على' : 'تسوية لصالح'} السواق</b>\n` +
    `👤 ${state.drivers[state.selectedAdminDriver].name}\n` +
    `💰 المبلغ: ${amount} ريال\n` +
    `📝 البيان: ${update.note}`
  ).catch(()=>{});
}

/* ============================================================
   تسجيل الدخول
   ============================================================ */
function doLogin() {
  const id = $('loginUserSelect').value;
  const pass = $('loginPassword').value;
  const errEl = $('loginError');
  errEl.classList.add('hidden');

  if (!id) {
    errEl.textContent = 'اختر الحساب';
    errEl.classList.remove('hidden');
    return;
  }
  const user = id === 'admin' ? USERS.admin : getDrivers()[id];
  if (!user || user.password !== pass) {
    errEl.textContent = 'كلمة المرور غير صحيحة';
    errEl.classList.remove('hidden');
    return;
  }

  state.user = { id: user.id, role: user.role, name: user.name };
  store.set(STORAGE.SESSION, state.user);
  afterLogin();
}

function afterLogin() {
  state.listeners.forEach(unsub => { try { unsub(); } catch(e){} });
  state.listeners = [];

  if (state.user.role === 'driver') {
    renderDriverHome();
    const active = getActiveTrip(state.user.id);
    if (active) {
      show('tripScreen');
      openTripScreen(active.id);
    } else {
      show('driverScreen');
    }

    const unsub1 = fbListenDriverUpdates(state.user.id, (updates) => {
      state.updates = updates;
      store.set(STORAGE.UPDATES, updates);
      renderDriverHome();
      if (state.currentTrip) renderTripScreen();
    });
    state.listeners.push(unsub1);

    const unsub2 = fbListenDriverOverride(state.user.id, (override) => {
      if (override && Object.keys(override).length) {
        saveDriverOverride(state.user.id, override);
        renderDriverHome();
        if (state.currentTrip) renderTripScreen();
      }
    });
    state.listeners.push(unsub2);

  } else {
    show('adminScreen');
    renderAdminHome();

    const unsub1 = fbListenAllDrivers((allTrips) => {
      const firebaseTrips = [];
      for (const driverId in allTrips) {
        const driverTrips = allTrips[driverId];
        for (const tripId in driverTrips) {
          firebaseTrips.push(driverTrips[tripId]);
        }
      }
      const localAdminTrips = state.trips.filter(t => t.driverId === 'admin');
      const mergedMap = new Map();
      firebaseTrips.forEach(t => mergedMap.set(t.id, t));
      state.trips = [...localAdminTrips, ...Array.from(mergedMap.values())];
      saveTrips();
      renderAdminHome();
      if (state.selectedAdminDriver) openAdminDriver(state.selectedAdminDriver);
    });
    state.listeners.push(unsub1);

    const unsub2 = fbListenAllUpdates((allUpdates) => {
      state.updates = allUpdates;
      store.set(STORAGE.UPDATES, allUpdates);
      renderAdminHome();
      if (state.selectedAdminDriver) openAdminDriver(state.selectedAdminDriver);
    });
    state.listeners.push(unsub2);

    const unsub3 = fbListenAllOverrides((data) => {
      store.set(STORAGE.DRIVERS, data || {});
      getDrivers();
      renderAdminHome();
    });
    state.listeners.push(unsub3);
  }
  updateSyncIndicator();
}

function logout() {
  if (!confirm('تأكيد الخروج؟')) return;
  store.remove(STORAGE.SESSION);
  state.user = null;
  state.currentTrip = null;
  state.listeners.forEach(unsub => { try { unsub(); } catch(e){} });
  state.listeners = [];
  show('loginScreen');
  $('loginPassword').value = '';
}

/* ============================================================
   ربط الأحداث
   ============================================================ */
function bindEvents() {
  $('loginBtn').onclick = doLogin;
  $('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  $('driverLogout').onclick = logout;
  $('adminLogout').onclick = logout;

  $('btnStartTrip').onclick = startNewTrip;
  $('btnHistory').onclick = () => { renderHistory(); show('historyScreen'); };
  $('btnUpdates').onclick = () => { renderUpdates(); show('updatesScreen'); };
  $('historyBack').onclick = () => show('driverScreen');
  $('updatesBack').onclick = () => show('driverScreen');

  $('tripBack').onclick = () => { show('driverScreen'); renderDriverHome(); };

  $('btnAddIncome').onclick = openIncomeModal;
  $('incomeConfirm').onclick = confirmIncome;
  $('incomeCancel').onclick = () => { $('incomeModal').classList.add('hidden'); state.editingTxId = null; };

  $('btnAddExpense').onclick = openExpenseModal;
  $('expenseConfirm').onclick = confirmExpense;
  $('expenseCancel').onclick = () => { $('expenseModal').classList.add('hidden'); state.editingTxId = null; };
  $('expenseImage').onchange = handleExpenseImage;

  $('btnFinishTrip').onclick = openFinishModal;
  $('finishConfirm').onclick = confirmFinish;
  $('finishCancel').onclick = () => $('finishModal').classList.add('hidden');

  $('closePreview').onclick = () => $('imagePreviewModal').classList.add('hidden');

  $('reportClose').onclick = () => $('reportModal').classList.add('hidden');
  $('reportDownload').onclick = downloadReportPDF;

  $('adminDriverBack').onclick = () => { renderAdminHome(); show('adminScreen'); };
  $('btnEditDriver').onclick = openEditDriverModal;
  $('editDriverConfirm').onclick = confirmEditDriver;
  $('editDriverCancel').onclick = () => $('editDriverModal').classList.add('hidden');

  $('btnSettle').onclick = () => openSettleModal(false);
  $('btnDeduct').onclick = () => openSettleModal(true);
  $('settleConfirm').onclick = confirmSettle;
  $('settleCancel').onclick = () => $('settleModal').classList.add('hidden');

  window.addEventListener('online', () => {
    state.online = true;
    updateSyncIndicator();
    trySync();
    toast('عاد الاتصال، جاري المزامنة...', 'ok');
  });
  window.addEventListener('offline', () => {
    state.online = false;
    updateSyncIndicator();
    toast('انقطع الاتصال، سيتم المزامنة لاحقاً', 'err');
  });

  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m && !m.classList.contains('modal-image')) {
        m.classList.add('hidden');
        state.editingTxId = null;
      }
    });
  });
}

/* ============================================================
   تهيئة التطبيق
   ============================================================ */
function init() {
  loadTrips();
  state.updates = store.get(STORAGE.UPDATES, []);
  state.pendingSync = store.get(STORAGE.PENDING, []);
  getDrivers();
  bindEvents();

  const session = store.get(STORAGE.SESSION);
  setTimeout(() => {
    $('splash').classList.add('hide');
    setTimeout(() => $('splash').remove(), 500);

    if (session && session.id) {
      state.user = session;
      afterLogin();
    } else {
      show('loginScreen');
    }
    updateSyncIndicator();
    trySync();
  }, 900);
}

document.addEventListener('DOMContentLoaded', init);
