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
  drivers: {},          // نسخة معدلة من بيانات السواقين
  trips: [],            // كل الحملات
  updates: [],          // تحديثات المشرف
  pendingSync: [],      // عناصر بانتظار المزامنة
  selectedAdminDriver: null,
  reportTripId: null
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
  const date = d.toLocaleDateString('en-GB'); // dd/mm/yyyy
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
   إعداد السواقين (قابل للتعديل من المشرف)
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
  return state.trips.filter(t => t.driverId === driverId).sort((a,b) => (a.tripNumber||0) - (b.tripNumber||0));
}

function getActiveTrip(driverId) {
  return state.trips.find(t => t.driverId === driverId && t.status === 'ongoing');
}

function nextTripNumber(driverId) {
  const trips = getDriverTrips(driverId);
  return trips.length + 1;
}

function startNewTrip() {
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
   حساب الأرصدة
   ============================================================ */
function computeTripBalance(trip) {
  let income = 0, expense = 0;
  for (const t of trip.transactions) {
    if (t.kind === 'income') income += Number(t.amount);
    else if (t.kind === 'expense') expense += Number(t.amount);
  }
  // خصم مستحق السواق تلقائياً
  const due = Number(trip.duePerTrip || 0);
  const totalExpense = expense + due;
  const diff = income - totalExpense; // موجب = متبقي له ، سالب = متبقي عليه
  return { income, expense, due, totalExpense, diff };
}

function computeDriverOverallBalance(driverId) {
  const trips = getDriverTrips(driverId);
  let balance = 0; // موجب = له ، سالب = عليه
  for (const t of trips) {
    if (t.status === 'finished') {
      const b = computeTripBalance(t);
      balance += b.diff;
    }
  }
  // إضافات/خصومات المشرف
  const updates = state.updates.filter(u => u.driverId === driverId);
  for (const u of updates) {
    balance += Number(u.delta || 0);
  }
  return balance;
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
  $('tripTotalExpense').textContent = fmtMoney(b.totalExpense);
  const dueEl = $('tripDue');
  dueEl.textContent = fmtMoney(Math.abs(b.diff));
  dueEl.className = b.diff >= 0 ? 'txt-green' : 'txt-red';

  renderTransactions();
  updateSyncIndicator();
}

function renderTransactions() {
  const trip = state.currentTrip;
  const list = $('transactionsList');
  if (!trip || !trip.transactions.length) {
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
      <button class="btn-del" data-act="del" data-id="${tx.id}">حذف</button>
    `;
    if (tx.kind === 'expense' && tx.imageUrl) {
      actions += `<button class="btn-view" data-act="view" data-id="${tx.id}">معاينة</button>`;
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
      if (act === 'view') viewTransactionImage(id);
    };
  });
}

function deleteTransaction(txId) {
  if (!confirm('تأكيد حذف الحركة؟')) return;
  const trip = state.currentTrip;
  trip.transactions = trip.transactions.filter(t => t.id !== txId);
  saveTrips();
  renderTripScreen();
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
   إضافة حركات
   ============================================================ */
function openIncomeModal() {
  $('incomeFrom').value = '';
  $('incomeAmount').value = '';
  document.querySelector('input[name="incomeType"][value="نقدا"]').checked = true;
  $('incomeModal').classList.remove('hidden');
}

function confirmIncome() {
  const from = $('incomeFrom').value.trim();
  const amount = Number($('incomeAmount').value);
  const payType = document.querySelector('input[name="incomeType"]:checked').value;

  if (!from) return toast('أدخل اسم المسلم', 'err');
  if (!amount || amount <= 0) return toast('أدخل مبلغاً صحيحاً', 'err');

  const now = nowDate();
  const tx = {
    id: uid(),
    kind: 'income',
    from,
    amount,
    payType,
    day: now.dayName, date: now.date, time: now.time, iso: now.iso
  };
  state.currentTrip.transactions.push(tx);
  saveTrips();
  $('incomeModal').classList.add('hidden');
  renderTripScreen();
  queueSync('transaction_add', { tripId: state.currentTrip.id, txId: tx.id });
  toast('تمت إضافة العهدة', 'ok');
}

function openExpenseModal() {
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

function confirmExpense() {
  const amount = Number($('expenseAmount').value);
  const note = $('expenseNote').value.trim();

  if (!amount || amount <= 0) return toast('أدخل مبلغاً صحيحاً', 'err');
  if (!note) return toast('أدخل البيان', 'err');

  const now = nowDate();
  const tx = {
    id: uid(),
    kind: 'expense',
    amount,
    note,
    imageUrl: state._pendingExpenseImage || null,
    day: now.dayName, date: now.date, time: now.time, iso: now.iso
  };
  state.currentTrip.transactions.push(tx);
  saveTrips();
  state._pendingExpenseImage = null;
  $('expenseModal').classList.add('hidden');
  renderTripScreen();
  queueSync('transaction_add', { tripId: state.currentTrip.id, txId: tx.id });
  toast('تمت إضافة الخرج', 'ok');
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

  // توليد التقرير
  const report = buildTripReport(trip);

  // إرسال للسيرفر (fire & forget - المزامنة تتم في الخلفية)
  queueSync('trip_finish', { tripId: trip.id });

  // إظهار شاشة التقرير
  showReport(report);
}

/* ============================================================
   بناء تقرير الحملة
   ============================================================ */
function buildTripReport(trip) {
  const driver = state.drivers[trip.driverId];
  const b = computeTripBalance(trip);
  const incomeTx = trip.transactions.filter(t => t.kind === 'income');
  const expenseTx = trip.transactions.filter(t => t.kind === 'expense');

  return {
    trip,
    driver,
    summary: {
      incomeTotal: b.income,
      expenseTotal: b.expense,
      due: b.due,
      totalExpense: b.totalExpense,
      diff: b.diff,
      incomeCount: incomeTx.length,
      expenseCount: expenseTx.length,
      txCount: trip.transactions.length
    }
  };
}

function showReport(report) {
  const { trip, driver, summary } = report;
  const body = $('reportBody');

  const rowsHtml = trip.transactions.map((t, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${t.kind === 'income' ? 'استلام عهدة' : 'خرج'}</td>
      <td>${fmtMoney(t.amount)}</td>
      <td>${t.kind === 'income' ? (t.from || '—') + ' - ' + (t.payType||'') : (t.note || '—')}</td>
      <td>${t.date} ${t.time}</td>
    </tr>
  `).join('');

  const finalText = summary.diff >= 0
    ? `متبقي له: ${fmtMoney(summary.diff)}`
    : `متبقي عليه: ${fmtMoney(Math.abs(summary.diff))}`;

  body.innerHTML = `
    <div style="margin-bottom:12px;font-size:14px;line-height:2;">
      <div><b>الحملة:</b> رقم ${trip.tripNumber}</div>
      <div><b>السائق:</b> ${driver.name}</div>
      <div><b>القاطرة:</b> ${driver.trailer}</div>
      <div><b>البدء:</b> ${trip.startDay} ${trip.startDate} - ${trip.startTime}</div>
      <div><b>الانتهاء:</b> ${trip.endDay} ${trip.endDate} - ${trip.endTime}</div>
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
      <div><b>إجمالي الخصومات:</b> ${fmtMoney(summary.totalExpense)}</div>
      <div style="font-size:16px;margin-top:8px;" class="${summary.diff>=0?'pos':'neg'}"><b>${finalText}</b></div>
    </div>
  `;

  state.reportTripId = trip.id;
  $('reportModal').classList.remove('hidden');
}

/* ============================================================
   توليد PDF
   ============================================================ */
function generatePDF(trip) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });

  const driver = state.drivers[trip.driverId];
  const b = computeTripBalance(trip);

  // محاولة استخدام خط عربي افتراضي (النص العربي قد لا يظهر بدون خط مخصص)
  doc.setFontSize(16);
  doc.text(`Trip Report #${trip.tripNumber}`, 105, 15, { align: 'center' });
  doc.setFontSize(11);
  doc.text(`Driver: ${driver.name} (${driver.trailer})`, 105, 23, { align: 'center' });
  doc.text(`Start: ${trip.startDate} ${trip.startTime}  |  End: ${trip.endDate||''} ${trip.endTime||''}`, 105, 29, { align: 'center' });

  const rows = trip.transactions.map((t, i) => [
    i + 1,
    t.kind === 'income' ? 'Income' : 'Expense',
    String(t.amount),
    t.kind === 'income' ? (t.from || '') : (t.note || ''),
    `${t.date} ${t.time}`
  ]);

  doc.autoTable({
    startY: 36,
    head: [['#', 'Type', 'Amount', 'Note', 'Date']],
    body: rows.length ? rows : [['-','-','-','-','-']],
    styles: { fontSize: 9, halign: 'center' },
    headStyles: { fillColor: [27, 38, 59] }
  });

  let y = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(11);
  doc.text(`Total Income: ${b.income}`, 15, y); y += 6;
  doc.text(`Total Expense: ${b.expense}`, 15, y); y += 6;
  doc.text(`Driver Due (auto): ${b.due}`, 15, y); y += 6;
  doc.text(`Total Deductions: ${b.totalExpense}`, 15, y); y += 6;
  doc.text(`Difference: ${b.diff}`, 15, y);

  return doc;
}

async function downloadReportPDF() {
  const trip = state.trips.find(t => t.id === state.reportTripId);
  if (!trip) return;
  const doc = generatePDF(trip);
  doc.save(`Trip_${trip.tripNumber}_${trip.driverId}.pdf`);
  toast('تم تحميل التقرير', 'ok');
}

/* ============================================================
   نظام المزامنة (Offline-First)
   ============================================================ */
function queueSync(action, payload) {
  const item = {
    id: uid(),
    action,
    payload,
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

function markSynced(item) {
  const { action, payload } = item;
  if (action === 'trip_start' || action === 'trip_finish' || action === 'trip_update') {
    const trip = state.trips.find(t => t.id === payload.tripId);
    if (trip) { trip.synced = true; saveTrips(); }
  }
  // push إلى Firebase (يعمل عبر الإنترنت فقط)
  pushToFirebase(item).catch(()=>{});
}

async function sendToServer(item) {
  const { action, payload } = item;
  const trip = payload.tripId ? state.trips.find(t => t.id === payload.tripId) : null;

  if (action === 'trip_finish' && trip) {
    // رفع تقرير PDF
    const doc = generatePDF(trip);
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
    // لو في صورة، نرفعها أولاً
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
      }
    }
    // إرسال رسالة نصية عن الحركة
    await sendTextToServer(buildTxCaption(trip, tx));
    return;
  }

  // رسالة عامة
  if (trip) {
    await sendTextToServer(buildTripCaption(trip, action));
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
  return `📊 <b>تقرير حملة رقم ${trip.tripNumber}</b>\n` +
         `👤 السائق: ${d.name}\n` +
         `🚛 ${d.trailer}\n` +
         `📅 البدء: ${trip.startDay} ${trip.startDate} ${trip.startTime}\n` +
         `📅 الانتهاء: ${trip.endDay} ${trip.endDate} ${trip.endTime}\n` +
         `💰 العُهد: ${b.income}\n` +
         `💸 المخارج: ${b.expense}\n` +
         `📉 مستحق السائق: ${b.due}\n` +
         `📌 الفارق: ${b.diff}`;
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
   Firebase Push
   ============================================================ */
async function pushToFirebase(item) {
  if (!state.online) return;
  try {
    const ref = db.ref('sync_log');
    await ref.push({
      action: item.action,
      payload: item.payload,
      user: state.user?.id || 'unknown',
      ts: Date.now()
    });
    // تحديث رصيد السائق في Firebase
    if (state.user?.role === 'driver') {
      const bal = computeDriverOverallBalance(state.user.id);
      await db.ref(`balances/${state.user.id}`).set({
        balance: bal,
        updatedAt: Date.now()
      });
    }
  } catch (e) { /* ignore */ }
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
  $('dName').textContent = d.name;
  $('dPhone').textContent = '📞 ' + d.phone;
  $('dTrailer').textContent = '🚛 ' + d.trailer;

  const bal = computeDriverOverallBalance(u.id);
  const el = $('dBalance');
  el.textContent = fmtMoney(Math.abs(bal));
  el.className = 'balance-value ' + (bal >= 0 ? 'positive' : 'negative');
  $('dBalanceStatus').textContent = bal >= 0 ? 'متبقي له' : 'متبقي عليه';
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
        <div>عدد الحركات: <b>${trip.transactions.length}</b></div>
        <div>العُهد: <b>${fmtMoney(b.income)}</b></div>
      </div>
      <div class="hc-balance">
        <span>النتيجة:</span>
        <span class="${b.diff >= 0 ? 'pos' : 'neg'}">
          ${b.diff >= 0 ? 'له ' : 'عليه '}${fmtMoney(Math.abs(b.diff))}
        </span>
      </div>
      <div class="tx-actions" style="margin-top:10px;">
        <button class="btn-view" data-trip="${trip.id}">معاينة التقرير</button>
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
    const bal = computeDriverOverallBalance(id);
    const row = document.createElement('div');
    row.className = 'driver-row';
    row.innerHTML = `
      <div class="driver-avatar">👤</div>
      <div class="driver-info">
        <div class="driver-name">${d.name}</div>
        <div class="driver-meta">${d.trailer} • ${d.phone}</div>
      </div>
      <div class="${bal >= 0 ? 'pos' : 'neg'}" style="font-weight:800;font-size:14px;">
        ${bal >= 0 ? 'له ' : 'عليه '}${fmtMoney(Math.abs(bal))}
      </div>
      <div class="chev">›</div>
    `;
    row.onclick = () => openAdminDriver(id);
    grid.appendChild(row);
  });

  // النشاطات
  const act = $('adminActivityList');
  const all = state.updates.sort((a,b) => b.ts - a.ts).slice(0, 20);
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
  el.className = 'balance-value ' + (bal >= 0 ? 'positive' : 'negative');
  $('adBalanceStatus').textContent = bal >= 0 ? 'متبقي له' : 'متبقي عليه';

  // آخر مزامنة
  const trips = getDriverTrips(driverId);
  const lastTrip = trips.sort((a,b) => new Date(b.startISO) - new Date(a.startISO))[0];
  $('adLastSync').textContent = lastTrip ? 'آخر نشاط: ' + fmtDateTime(lastTrip.startISO) : 'آخر نشاط: —';

  // حملات السائق
  const list = $('adminTripsList');
  if (!trips.length) {
    list.innerHTML = '<div class="empty-state">لا توجد حملات</div>';
  } else {
    list.innerHTML = '';
    trips.slice().reverse().forEach(trip => {
      const b = computeTripBalance(trip);
      const ongoing = trip.status === 'ongoing';
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
          <div>عدد الحركات: <b>${trip.transactions.length}</b></div>
          <div>${trip.synced ? '✅ متزامنة' : '⏳ معلقة'}</div>
        </div>
        <div class="hc-balance">
          <span>النتيجة:</span>
          <span class="${b.diff >= 0 ? 'pos' : 'neg'}">
            ${b.diff >= 0 ? 'له ' : 'عليه '}${fmtMoney(Math.abs(b.diff))}
          </span>
        </div>
        <div class="tx-actions" style="margin-top:10px;">
          <button class="btn-view" data-trip="${trip.id}">معاينة التقرير</button>
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

function confirmEditDriver() {
  const name = $('editDriverName').value.trim();
  const trailer = $('editDriverTrailer').value.trim();
  const due = Number($('editDriverDue').value) || 50000;
  if (!name || !trailer) return toast('أكمل الحقول', 'err');

  saveDriverOverride(state.selectedAdminDriver, { name, trailer, duePerTrip: due });
  $('editDriverModal').classList.add('hidden');
  toast('تم حفظ الإعدادات', 'ok');
  openAdminDriver(state.selectedAdminDriver);
}

function openSettleModal(isDeduct) {
  state._settleMode = isDeduct ? 'deduct' : 'add';
  $('settleHeader').textContent = isDeduct ? 'خصم من الرصيد' : 'إضافة إلى الرصيد (تسوية)';
  $('settleAmount').value = '';
  $('settleNote').value = '';
  $('settleModal').classList.remove('hidden');
}

function confirmSettle() {
  const amount = Number($('settleAmount').value);
  const note = $('settleNote').value.trim();
  if (!amount || amount <= 0) return toast('أدخل مبلغاً صحيحاً', 'err');

  const delta = state._settleMode === 'deduct' ? -amount : amount;
  const update = {
    id: uid(),
    driverId: state.selectedAdminDriver,
    type: 'settle',
    delta,
    note: note || (delta > 0 ? 'إضافة رصيد' : 'خصم رصيد'),
    ts: Date.now()
  };
  state.updates.push(update);
  store.set(STORAGE.UPDATES, state.updates);
  $('settleModal').classList.add('hidden');
  toast('تم تنفيذ التسوية', 'ok');
  openAdminDriver(state.selectedAdminDriver);

  // إرسال تحديث للمشرف عبر السيرفر (اختياري)
  sendTextToServer(
    `⚙️ <b>${delta>0?'إضافة':'خصم'} رصيد</b>\n` +
    `👤 السائق: ${state.drivers[state.selectedAdminDriver].name}\n` +
    `💰 المبلغ: ${Math.abs(delta)}\n` +
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
  if (state.user.role === 'driver') {
    renderDriverHome();
    const active = getActiveTrip(state.user.id);
    if (active) {
      show('tripScreen');
      openTripScreen(active.id);
    } else {
      show('driverScreen');
    }
  } else {
    show('adminScreen');
    renderAdminHome();
  }
  updateSyncIndicator();
}

function logout() {
  if (!confirm('تأكيد الخروج؟')) return;
  store.remove(STORAGE.SESSION);
  state.user = null;
  state.currentTrip = null;
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

  $('tripBack').onclick = () => {
    if (state.currentTrip && state.currentTrip.status === 'ongoing') {
      show('driverScreen');
      renderDriverHome();
    } else {
      show('driverScreen');
      renderDriverHome();
    }
  };

  $('btnAddIncome').onclick = openIncomeModal;
  $('incomeConfirm').onclick = confirmIncome;
  $('incomeCancel').onclick = () => $('incomeModal').classList.add('hidden');

  $('btnAddExpense').onclick = openExpenseModal;
  $('expenseConfirm').onclick = confirmExpense;
  $('expenseCancel').onclick = () => $('expenseModal').classList.add('hidden');
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

  // إغلاق المودالات عند الضغط على الخلفية
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m && !m.classList.contains('modal-image')) {
        m.classList.add('hidden');
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