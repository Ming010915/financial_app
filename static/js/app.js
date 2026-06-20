// ── localStorage helpers ──────────────────────────────────────────────────────
function getExpenses() {
  return JSON.parse(localStorage.getItem('flo_expenses') || '[]');
}
function saveExpenses(exps) {
  localStorage.setItem('flo_expenses', JSON.stringify(exps));
}
function getCentroids() {
  const raw = localStorage.getItem('flo_centroids');
  return raw ? JSON.parse(raw) : null;
}
function saveCentroids(data) {
  localStorage.setItem('flo_centroids', JSON.stringify(data));
}
function getPaymentMethods() {
  const s = localStorage.getItem('flo_payment_methods');
  return s ? JSON.parse(s) : ["Cash","Debit Card","Credit Card","Mobile Pay","Bank Transfer"];
}
function savePaymentMethods(m) { localStorage.setItem('flo_payment_methods', JSON.stringify(m)); }
function getPaymentEmojis() {
  const s = localStorage.getItem('flo_payment_emojis');
  return s ? JSON.parse(s) : {};
}
function savePaymentEmojis(e) { localStorage.setItem('flo_payment_emojis', JSON.stringify(e)); }
function getCustomCurrencies() {
  const s = localStorage.getItem('flo_custom_currencies');
  return s ? JSON.parse(s) : [];
}
function saveCustomCurrencies(c) { localStorage.setItem('flo_custom_currencies', JSON.stringify(c)); }
function getBudget() {
  const v = localStorage.getItem('flo_budget');
  return v ? parseFloat(v) : null;
}
function saveBudget(amount) { localStorage.setItem('flo_budget', String(amount)); }
function clearBudget()      { localStorage.removeItem('flo_budget'); }
function getPendingScans()  { return JSON.parse(localStorage.getItem('flo_pending_scans') || '[]'); }
function savePendingScans(s){ localStorage.setItem('flo_pending_scans', JSON.stringify(s)); }
function getCustomIncomeCategories() {
  const s = localStorage.getItem('flo_income_categories');
  return s ? JSON.parse(s) : [];
}
function saveCustomIncomeCategories(list) { localStorage.setItem('flo_income_categories', JSON.stringify(list)); }
function getIncomeEmojis() {
  const s = localStorage.getItem('flo_income_emojis');
  return s ? JSON.parse(s) : {};
}
function saveIncomeEmojis(map) { localStorage.setItem('flo_income_emojis', JSON.stringify(map)); }

// ── Home widget layout ─────────────────────────────────────────────────────────
const HOME_WIDGET_DEFS = [
  { id: 'total',      label: 'Monthly Total',   icon: '💰' },
  { id: 'budget',     label: 'Budget & Stats',  icon: '📊' },
  { id: 'income',     label: 'Monthly Balance', icon: '📈' },
  { id: 'chart',      label: '7-Day Chart',     icon: '📉' },
  { id: 'categories', label: 'Categories',      icon: '🏷' },
  { id: 'pending',    label: 'Pending Scans',   icon: '⏳' },
  { id: 'recent',     label: 'Recent',          icon: '🕐' },
];

function getHomeLayout() {
  const s = localStorage.getItem('flo_home_layout');
  if (s) {
    try {
      const stored = JSON.parse(s);
      const storedIds = new Set(stored.map(w => w.id));
      const extra = HOME_WIDGET_DEFS.filter(w => !storedIds.has(w.id)).map(w => ({ id: w.id, visible: true }));
      return [...stored, ...extra];
    } catch {}
  }
  return HOME_WIDGET_DEFS.map(w => ({ id: w.id, visible: true }));
}

function saveHomeLayout(layout) {
  localStorage.setItem('flo_home_layout', JSON.stringify(layout));
}

function applyHomeLayout() {
  const layout = getHomeLayout();
  const container = document.getElementById('view-home');
  layout.forEach(({ id, visible }) => {
    const el = container.querySelector(`[data-widget-id="${id}"]`);
    if (!el) return;
    if (visible) el.removeAttribute('data-widget-hidden');
    else el.setAttribute('data-widget-hidden', '');
    container.appendChild(el);
  });
}

let _dragSortCleanup = null;

function _initDragSort(listEl, onSort) {
  if (_dragSortCleanup) _dragSortCleanup();
  let dragging = null;

  function onPointerDown(e) {
    const handle = e.target.closest('[data-drag-handle]');
    if (!handle) return;
    dragging = handle.closest('[data-widget-row]');
    if (!dragging) return;
    dragging.classList.add('dragging');
    listEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const rows = [...listEl.querySelectorAll('[data-widget-row]')];
    const y = e.clientY;
    let inserted = false;
    for (const row of rows) {
      if (row === dragging) continue;
      const rect = row.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        listEl.insertBefore(dragging, row);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      const last = rows[rows.length - 1];
      if (last && last !== dragging) listEl.appendChild(dragging);
    }
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    onSort();
  }

  function onPointerCancel() {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
  }

  listEl.addEventListener('pointerdown', onPointerDown);
  listEl.addEventListener('pointermove', onPointerMove);
  listEl.addEventListener('pointerup', onPointerUp);
  listEl.addEventListener('pointercancel', onPointerCancel);

  _dragSortCleanup = () => {
    listEl.removeEventListener('pointerdown', onPointerDown);
    listEl.removeEventListener('pointermove', onPointerMove);
    listEl.removeEventListener('pointerup', onPointerUp);
    listEl.removeEventListener('pointercancel', onPointerCancel);
    _dragSortCleanup = null;
  };
}

function openHomeCustomize() {
  const layout = getHomeLayout();
  const listEl = document.getElementById('home-customize-list');
  listEl.innerHTML = layout.map(({ id, visible }) => {
    const def = HOME_WIDGET_DEFS.find(w => w.id === id);
    if (!def) return '';
    return `
      <div class="customize-row flex items-center gap-3 py-3 px-2 border-b border-[#edeeef]" data-widget-row data-id="${id}">
        <div class="text-[#c5c6ca] text-xl leading-none px-1 select-none" data-drag-handle title="Drag to reorder">⠿</div>
        <div class="text-lg w-7 text-center select-none">${def.icon}</div>
        <div class="flex-1 text-sm font-semibold text-[#191c1d]">${def.label}</div>
        <div class="toggle-track ${visible ? 'on' : ''}" onclick="toggleHomeWidget('${id}', this)">
          <div class="toggle-thumb"></div>
        </div>
      </div>`;
  }).join('');

  _initDragSort(listEl, () => {
    const newOrder = [...listEl.querySelectorAll('[data-widget-row]')].map(r => r.dataset.id);
    const layoutMap = Object.fromEntries(getHomeLayout().map(w => [w.id, w]));
    saveHomeLayout(newOrder.map(id => layoutMap[id]).filter(Boolean));
    applyHomeLayout();
  });

  document.getElementById('home-customize-overlay').classList.remove('hidden');
}

function closeHomeCustomize() {
  document.getElementById('home-customize-overlay').classList.add('hidden');
}

function toggleHomeWidget(id, toggleEl) {
  const layout = getHomeLayout();
  const item = layout.find(w => w.id === id);
  if (!item) return;
  item.visible = !item.visible;
  saveHomeLayout(layout);
  toggleEl.classList.toggle('on', item.visible);
  applyHomeLayout();
}

function getSummaries() {
  const s = localStorage.getItem('flo_summaries');
  return s ? JSON.parse(s) : [];
}
function saveSummaries(summaries) { localStorage.setItem('flo_summaries', JSON.stringify(summaries)); }
function upsertSummary(period, text, spending) {
  const summaries = getSummaries().filter(s => s.period !== period);
  summaries.push({ period, text, spending });
  saveSummaries(summaries);
}

function generateId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}

function mergeItems(items) {
  const map = new Map();
  for (const item of items) {
    const key = (item.name || "").trim().toLowerCase();
    if (!key) { map.set(Symbol(), { ...item, quantity: item.quantity || 1 }); continue; }
    if (map.has(key)) {
      const ex = map.get(key);
      ex.quantity = (ex.quantity || 1) + (item.quantity || 1);
      if (ex.price != null && item.price != null)
        ex.price = Math.round((ex.price + item.price) * 100) / 100;
      else if (item.price != null)
        ex.price = item.price;
    } else {
      map.set(key, { ...item, quantity: item.quantity || 1 });
    }
  }
  return Array.from(map.values());
}

function computeSummary() {
  const expenses  = getExpenses();
  const today     = new Date().toISOString().split('T')[0];
  const thisMonth = today.slice(0, 7);

  const todayTotal = expenses.filter(e => isExpenseEntry(e) && e.date === today).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
  const monthTotal = expenses.filter(e => isExpenseEntry(e) && (e.date || '').startsWith(thisMonth)).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);

  // This week (Mon → today)
  const dow       = new Date().getDay(); // 0=Sun
  const daysBack  = dow === 0 ? 6 : dow - 1;
  const weekStart = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  const weekTotal = expenses
    .filter(e => isExpenseEntry(e) && (e.date || '') >= weekStart && (e.date || '') <= today)
    .reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);

  // Last calendar month full total (daily-average comparison handles unequal month lengths)
  const lastMonthDate  = new Date();
  lastMonthDate.setDate(1);
  lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonthStr   = lastMonthDate.toISOString().slice(0, 7);
  const lastMonthTotal = expenses
    .filter(e => isExpenseEntry(e) && (e.date || '').startsWith(lastMonthStr))
    .reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);

  const catBreakdown = {};
  expenses.filter(e => isExpenseEntry(e) && (e.date || '').startsWith(thisMonth)).forEach(e => {
    const cat = e.category || 'Others';
    catBreakdown[cat] = (catBreakdown[cat] || 0) + convertToDefault(e.amount, e.currency, e.rate);
  });

  const daysData  = [];
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const monday    = new Date(Date.now() - daysToMon * 86400000);
  for (let i = 0; i < 7; i++) {
    const d     = new Date(monday.getTime() + i * 86400000).toISOString().split('T')[0];
    const total = expenses.filter(e => isExpenseEntry(e) && e.date === d).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
    daysData.push({ date: d, total: Math.round(total * 100) / 100 });
  }

  const recent = expenses
    .filter(e => (e.date || '').startsWith(thisMonth))
    .sort((a, b) => {
      const ka = (a.date || '') + (a.created_at || '');
      const kb = (b.date || '') + (b.created_at || '');
      return kb > ka ? 1 : -1;
    })
    .slice(0, 3);

  const todayIncome = expenses
    .filter(e => isIncomeEntry(e) && e.date === today)
    .reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
  const monthIncome = expenses
    .filter(e => isIncomeEntry(e) && (e.date || '').startsWith(thisMonth))
    .reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);

  return {
    today_total:       Math.round(todayTotal * 100) / 100,
    month_total:       Math.round(monthTotal * 100) / 100,
    week_total:        Math.round(weekTotal * 100) / 100,
    last_month_total:  Math.round(lastMonthTotal * 100) / 100,
    today_income:      Math.round(todayIncome * 100) / 100,
    month_income:      Math.round(monthIncome * 100) / 100,
    category_breakdown: Object.fromEntries(
      Object.entries(catBreakdown).map(([k, v]) => [k, Math.round(v * 100) / 100])
    ),
    daily_chart: daysData,
    recent,
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CAT_COLOR = {
  "Banking & Fees":                "#3b82f6",
  "Entertainment & Subscriptions": "#8b5cf6",
  "Food & Beverage":               "#f97316",
  "Groceries":                     "#22c55e",
  "Health & Wellness":             "#ef4444",
  "Home & Living":                 "#d97706",
  "Personal Care":                 "#ec4899",
  "Pet Supplies":                  "#eab308",
  "Shopping":                      "#6366f1",
  "Transport":                     "#06b6d4",
  "Others":                        "#94a3b8",
};
const CAT_EMOJI = {
  "Banking & Fees":                "🏦",
  "Entertainment & Subscriptions": "🎬",
  "Food & Beverage":               "🍽️",
  "Groceries":                     "🛒",
  "Health & Wellness":             "💊",
  "Home & Living":                 "🏠",
  "Personal Care":                 "✨",
  "Pet Supplies":                  "🐾",
  "Shopping":                      "🛍️",
  "Transport":                     "🚇",
  "Others":                        "📦",
};
const INCOME_CATEGORIES = ["Salary","Freelance","Investment","Rental","Gift","Refund","Other Income"];
const INCOME_CAT_COLOR  = { "Salary":"#16a34a","Freelance":"#0891b2","Investment":"#7c3aed","Rental":"#d97706","Gift":"#db2777","Refund":"#059669","Other Income":"#64748b" };
const INCOME_CAT_EMOJI  = { "Salary":"💼","Freelance":"💻","Investment":"📈","Rental":"🏘️","Gift":"🎁","Refund":"↩️","Other Income":"💰" };

const CUR_SYM = { EUR:"€",USD:"$",GBP:"£",JPY:"¥",CHF:"Fr",SEK:"kr",NOK:"kr",DKK:"kr",PLN:"zł",CNY:"¥",HKD:"HK$",SGD:"S$",AUD:"A$",CAD:"C$" };
const PAYMENT_ICONS   = { "Cash":"💵", "Debit Card":"💳", "Credit Card":"💳", "Mobile Pay":"📱", "Bank Transfer":"🏦" };
const BUILTIN_CURRENCIES = [
  {code:"EUR",sym:"€",name:"Euro"},{code:"USD",sym:"$",name:"US Dollar"},
  {code:"GBP",sym:"£",name:"British Pound"},{code:"CHF",sym:"Fr",name:"Swiss Franc"},
  {code:"JPY",sym:"¥",name:"Japanese Yen"},{code:"CNY",sym:"¥",name:"Chinese Yuan"},
  {code:"AUD",sym:"A$",name:"Australian Dollar"},{code:"CAD",sym:"C$",name:"Canadian Dollar"},
  {code:"HKD",sym:"HK$",name:"Hong Kong Dollar"},{code:"SGD",sym:"S$",name:"Singapore Dollar"},
  {code:"SEK",sym:"kr",name:"Swedish Krona"},{code:"NOK",sym:"kr",name:"Norwegian Krone"},
  {code:"DKK",sym:"kr",name:"Danish Krone"},{code:"PLN",sym:"zł",name:"Polish Złoty"},
];

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  categories:       [],
  selectedCategory: null,
  originalCategory: null,
  selectedPayment:  null,
  isIncome:         false,
  isReceipt:        false,
  isVoice:          false,
  receiptFile:         null,
  receiptItems:        [],
  pendingReceiptData:  null,
  expenseMap:       {},   // id → full expense object
  currentEditId:    null,
  editCategory:     null,
  editPayment:      null,
  editItems:        [],
  rates:            null, // { base, rates: {USD:…}, date }
  currentPendingScanId: null,
};

let pieChartInst = null;
let lineChartInst = null;
const _pendingScansFiles  = {};  // id → File (in-memory only)
const _pendingScansAborts = {};  // id → AbortController

// ── Google Places (server-proxied — the server key never reaches the browser) ──
let _cachedPosition    = null;
let _locationTimer     = null;
let _placesKeySet      = null;   // whether the server has a Places key configured

async function placesAvailable() {
  if (_placesKeySet === null) {
    try {
      const r = await fetch('/api/settings');
      const d = await r.json();
      _placesKeySet = !!d.places_key_set;
    } catch { _placesKeySet = false; }
  }
  return _placesKeySet;
}

async function _placesProxy(endpoint, payload) {
  const r = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Places request failed');
  return d.results || [];
}

async function getPosition() {
  if (_cachedPosition) return _cachedPosition;
  try {
    _cachedPosition = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, maximumAge: 300000 })
    );
    return _cachedPosition;
  } catch { return null; }
}

function _renderPlaceResults(inputId, resultsId, places, nameKey, addrKey) {
  const resultsEl = document.getElementById(resultsId);
  if (!places?.length) { resultsEl.classList.add('hidden'); return; }
  const bg      = isDark() ? '#141414' : 'white';
  const bgHover = isDark() ? '#1e1e1e' : '#f0fdf9';
  const textCol = isDark() ? '#e0e0e0' : '#1f2937';
  const subCol  = isDark() ? '#686868' : '#9ca3af';
  resultsEl.innerHTML = places.slice(0, 12).map(place => {
    const addr = place[addrKey] || '';
    const val  = place.name + (addr ? ', ' + addr : '');
    return `
      <div class="px-3 py-2.5 cursor-pointer border-b border-[#e8e9ea] last:border-0 transition-colors"
           style="background:${bg}"
           onmouseover="this.style.background='${bgHover}'"
           onmouseout="this.style.background='${bg}'"
           data-val="${esc(val)}"
           onclick="selectNearbyPlace('${inputId}', '${resultsId}', this)">
        <div class="text-sm font-medium truncate" style="color:${textCol}">${esc(place.name)}</div>
        <div class="text-xs truncate" style="color:${subCol}">${esc(addr)}</div>
      </div>`;
  }).join('');
}

// Called by oninput on location fields — debounced textSearch biased to cached position
async function onLocationInput(inputId, resultsId) {
  const query     = (document.getElementById(inputId)?.value || '').trim();
  const resultsEl = document.getElementById(resultsId);
  clearTimeout(_locationTimer);
  if (!query) { resultsEl.classList.add('hidden'); return; }

  _locationTimer = setTimeout(async () => {
    if (!(await placesAvailable())) return;
    resultsEl.innerHTML = '<div class="px-3 py-3 text-xs text-gray-400 text-center">Searching…</div>';
    resultsEl.classList.remove('hidden');

    const pos     = _cachedPosition;
    const payload = { query };
    if (pos) {
      payload.lat = pos.coords.latitude;
      payload.lng = pos.coords.longitude;
    }
    try {
      const results = await _placesProxy('/api/places/text_search', payload);
      if (!results.length) { resultsEl.classList.add('hidden'); return; }
      _renderPlaceResults(inputId, resultsId, results, 'name', 'formatted_address');
    } catch {
      resultsEl.classList.add('hidden');
    }
  }, 350);
}

// "Near me" button — nearbySearch around the user's GPS position
async function findNearbyPlaces(inputId, resultsId, btnEl) {
  const resultsEl = document.getElementById(resultsId);
  const origLabel = btnEl?.textContent ?? 'Near me';
  const setBtn    = (lbl, off) => { if (btnEl) { btnEl.textContent = lbl; btnEl.disabled = off; } };

  setBtn('…', true);
  resultsEl.innerHTML = '<div class="px-3 py-3 text-xs text-gray-400 text-center">Getting your location…</div>';
  resultsEl.classList.remove('hidden');

  const position = await getPosition();
  if (!position) {
    resultsEl.innerHTML = '<div class="px-3 py-3 text-xs text-red-500 text-center">Location access denied or unavailable</div>';
    setBtn(origLabel, false);
    return;
  }

  if (!(await placesAvailable())) {
    resultsEl.innerHTML = '<div class="px-3 py-3 text-xs text-amber-500 text-center">Google Places is not configured on the server</div>';
    setBtn(origLabel, false);
    return;
  }

  resultsEl.innerHTML = '<div class="px-3 py-3 text-xs text-gray-400 text-center">Searching nearby…</div>';

  try {
    const results = await _placesProxy('/api/places/nearby', {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
    });
    setBtn(origLabel, false);
    if (!results.length) {
      resultsEl.innerHTML = '<div class="px-3 py-3 text-xs text-gray-400 text-center">No nearby places found</div>';
      return;
    }
    _renderPlaceResults(inputId, resultsId, results, 'name', 'vicinity');
  } catch {
    setBtn(origLabel, false);
    resultsEl.innerHTML = '<div class="px-3 py-3 text-xs text-red-500 text-center">Nearby search failed</div>';
  }
}

function selectNearbyPlace(inputId, resultsId, el) {
  document.getElementById(inputId).value = el.dataset.val;
  document.getElementById(resultsId).classList.add('hidden');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function catColor(cat)      { return CAT_COLOR[cat]  || "#64748b"; }
function catEmoji(cat) {
  // User overrides always win over built-in defaults
  const data   = getCentroids();
  const custom = (data?.custom_category_emojis || {})[cat];
  if (custom) return custom;
  return CAT_EMOJI[cat] || "📦";
}
function isExpenseEntry(e)  { return !e.type || e.type === 'expense'; }
function isIncomeEntry(e)   { return e.type === 'income'; }
function getAllIncomeCategories() {
  const custom = getCustomIncomeCategories();
  return [...new Set([...INCOME_CATEGORIES, ...custom])];
}
function incomeCatColor(cat){ return INCOME_CAT_COLOR[cat] || "#16a34a"; }
function incomeCatEmoji(cat){
  const custom = getIncomeEmojis()[cat];
  if (custom) return custom;
  return INCOME_CAT_EMOJI[cat] || "💰";
}
function txnColor(exp)      { return isIncomeEntry(exp) ? incomeCatColor(exp.category) : catColor(exp.category); }
function txnEmoji(exp)      { return isIncomeEntry(exp) ? incomeCatEmoji(exp.category) : catEmoji(exp.category); }

function curSym(code)       { return CUR_SYM[(code||"EUR").toUpperCase()] || code || "€"; }
function paymentIcon(m) {
  // User overrides always win over built-in defaults
  const custom = getPaymentEmojis()[m];
  if (custom) return custom;
  return PAYMENT_ICONS[m] || "💳";
}
function isDark()           { return document.documentElement.classList.contains("dark"); }

function catBg(col) { return col + (isDark() ? "44" : "22"); }

function fmtAmount(amount, currency = "EUR") {
  const sym = curSym(currency);
  return sym + Number(amount).toFixed(2);
}

function fmtDateLabel(dateStr) {
  const today     = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  if (dateStr === today)     return "Today";
  if (dateStr === yesterday) return "Yesterday";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function updateCurrencySymbol() {
  const code   = document.getElementById("f-currency").value || "EUR";
  const defCur = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  document.getElementById("f-cur-sym").textContent = curSym(code);
  updateRateRow("f", code, defCur, null);
}

function buildCurrencyOptions(selectedCode, compact) {
  const customs = getCustomCurrencies();
  const all = [
    ...BUILTIN_CURRENCIES,
    ...customs.map(code => ({code, sym: code, name: ""}))
  ];
  return all.map(({code, sym, name}) => {
    const label = compact ? code : (name ? `${code} — ${sym} ${name}` : code);
    return `<option value="${code}"${code === selectedCode ? " selected" : ""}>${label}</option>`;
  }).join("");
}

function populateCurrencySelect(id, selectedCode) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = buildCurrencyOptions(selectedCode || "EUR", id !== "s-currency");
}

function refreshAllCurrencySelects() {
  const defaultCurrency = localStorage.getItem("defaultCurrency") || "EUR";
  populateCurrencySelect("s-currency", defaultCurrency);
  const fCur = document.getElementById("f-currency");
  if (fCur) populateCurrencySelect("f-currency", fCur.value || defaultCurrency);
  renderCustomCurrenciesSettings();
}

function renderCustomCurrenciesSettings() {
  const el = document.getElementById("s-custom-currencies");
  if (!el) return;
  const customs = getCustomCurrencies();
  el.innerHTML = customs.map(code => `
    <div class="flex items-center justify-between py-1">
      <span class="text-sm text-gray-700 font-medium">${esc(code)}</span>
      <button onclick="deleteCustomCurrency('${code.replace(/'/g, "\\'")}')"
              class="text-xs text-red-400 hover:text-red-600 font-medium">Remove</button>
    </div>`).join("");
}

function addCustomCurrency() {
  const input = document.getElementById("s-custom-currency");
  const code  = (input.value || "").trim().toUpperCase();
  if (!code) return;
  const builtinCodes = BUILTIN_CURRENCIES.map(c => c.code);
  const customs = getCustomCurrencies();
  if (builtinCodes.includes(code) || customs.includes(code)) {
    showToast("Currency already exists.", true); return;
  }
  customs.push(code);
  saveCustomCurrencies(customs);
  input.value = "";
  refreshAllCurrencySelects();
  showToast(`${code} added.`);
}

function deleteCustomCurrency(code) {
  const customs = getCustomCurrencies().filter(c => c !== code);
  saveCustomCurrencies(customs);
  refreshAllCurrencySelects();
}

// ── Exchange rates ────────────────────────────────────────────────────────────
async function loadRates() {
  const base = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  const key  = "flo_rates_" + base;
  const hit  = localStorage.getItem(key);
  if (hit) {
    try {
      const { data, ts } = JSON.parse(hit);
      if (Date.now() - ts < 3_600_000) { state.rates = data; return; }
    } catch {}
  }
  try {
    const r    = await fetch("/api/exchange_rates?base=" + base);
    const data = await r.json();
    if (data.rates) {
      state.rates = data;
      localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
    }
  } catch (e) { console.warn("Exchange rates unavailable:", e); }
}

function convertToDefault(amount, fromCurrency, storedRate) {
  const base = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  const from = (fromCurrency || base).toUpperCase();
  if (from === base) return amount;
  if (storedRate != null && storedRate > 0) return amount * storedRate;
  if (!state.rates?.rates) return amount;
  const rate = state.rates.rates[from];
  return rate ? amount / rate : amount;
}

function getLiveRate(fromCurrency) {
  const base = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  const from = (fromCurrency || base).toUpperCase();
  if (from === base || !state.rates?.rates) return null;
  const rate = state.rates.rates[from];
  return rate ? 1 / rate : null;
}

function updateRateRow(prefix, fromCode, defCur, storedRate) {
  const row = document.getElementById(prefix + "-rate-row");
  if (!row) return;
  const from = (fromCode || "").toUpperCase();
  const base = defCur.toUpperCase();
  if (!from || from === base) { row.style.display = "none"; return; }

  row.style.display = "flex";
  document.getElementById(prefix + "-rate-from").textContent = from;
  document.getElementById(prefix + "-rate-sym").textContent  = curSym(defCur);

  const rateInput = document.getElementById(prefix + "-rate");
  const rateNote  = document.getElementById(prefix + "-rate-note");
  if (storedRate != null && storedRate > 0) {
    rateInput.value      = storedRate.toFixed(6);
    rateNote.textContent = "saved";
    rateNote.className   = "text-[10px] text-gray-400 flex-shrink-0";
  } else {
    const live = getLiveRate(fromCode);
    if (live != null) {
      rateInput.value      = live.toFixed(6);
      rateNote.textContent = "live";
      rateNote.className   = "text-[10px] text-emerald-500 flex-shrink-0";
    } else {
      rateInput.value      = "";
      rateNote.textContent = "enter rate manually";
      rateNote.className   = "text-[10px] text-amber-500 flex-shrink-0";
    }
  }
}

// ── Dark mode ─────────────────────────────────────────────────────────────────
function toggleDarkMode() {
  const next = !isDark();
  document.documentElement.classList.toggle("dark", next);
  localStorage.setItem("darkMode", next ? "1" : "0");
  document.getElementById("dark-toggle").classList.toggle("on", next);
  if (document.getElementById("view-summary").classList.contains("active")) {
    loadSummary();
  }
}

function syncDarkToggle() {
  document.getElementById("dark-toggle").classList.toggle("on", isDark());
}

// ── Navigation ────────────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("view-" + name).classList.add("active");
  // "add-method", "scan", "voice", and "verify" all share the nav-add highlight
  const navKey = (name === "add-method" || name === "scan" || name === "voice" || name === "verify") ? "add" : name;
  const navBtn = document.getElementById("nav-" + navKey);
  if (navBtn) navBtn.classList.add("active");
  document.getElementById("main-scroll").scrollTop = 0;
  const appHeader = document.querySelector("header");
  if (appHeader) appHeader.style.display = name === "verify" ? "none" : "";

  if (name === "home")     loadHome();
  if (name === "history")  {
    const searchEl = document.getElementById('history-search');
    if (searchEl) searchEl.value = '';
    _historySelCats.clear();
    _historySelPayments.clear();
    _historySelTime = null;
    _historySelType = null;
    if (_histViewMode === 'calendar') _resetHistToListMode();
    loadHistory();
  }
  if (name === "summary")  loadSummary();
  if (name === "add")      prepareAddForm();
  if (name === "settings")        { loadSettingsView(); syncDarkToggle(); }
  if (name === "preferences")     loadSettingsView();
  if (name === "categories")       { loadCategoriesView(); loadIncomeCategoriesSection(); loadOverrides(); }
  if (name === "payment-methods")  loadPaymentMethodsView();
}

// ── Add method shortcuts ──────────────────────────────────────────────────────
function addByReceipt() {
  clearScanView();
  resetForm();
  showView("scan");
}

function addByVoice() {
  showView("voice");
}

function addByManual() {
  showView("add");
  setTimeout(() => {
    const merchant = document.getElementById("f-merchant");
    if (merchant) {
      merchant.scrollIntoView({ behavior: "smooth", block: "center" });
      merchant.focus();
    }
  }, 200);
}

function addByIncome() {
  showView("add");
  setFormType("income");
  setTimeout(() => {
    const merchant = document.getElementById("f-merchant");
    if (merchant) {
      merchant.scrollIntoView({ behavior: "smooth", block: "center" });
      merchant.focus();
    }
  }, 200);
}

// ── Home ──────────────────────────────────────────────────────────────────────
async function loadHome() {
  applyHomeLayout();
  await loadRates();
  const data   = computeSummary();
  const defCur = localStorage.getItem("defaultCurrency") || "EUR";

  // ── Main amount
  document.getElementById("home-month").textContent = fmtAmount(data.month_total, defCur);
  document.getElementById("home-today").textContent = fmtAmount(data.today_total, defCur);
  document.getElementById("home-week").textContent  = fmtAmount(data.week_total,  defCur);

  // ── Trend badge: compare daily spending rate vs last month
  const trendEl = document.getElementById("home-trend-badge");
  if (data.last_month_total > 0) {
    const todayDay       = new Date().getDate();
    const lmDate         = new Date(); lmDate.setDate(1); lmDate.setMonth(lmDate.getMonth() - 1);
    const daysInLastMonth = new Date(lmDate.getFullYear(), lmDate.getMonth() + 1, 0).getDate();
    const thisAvg        = data.month_total / todayDay;
    const lastAvg        = data.last_month_total / daysInLastMonth;
    const diff           = thisAvg - lastAvg;
    const pct            = Math.round(Math.abs(diff / lastAvg) * 100);
    if (diff <= 0) {
      trendEl.textContent   = `↘ ${pct}% less per day`;
      trendEl.style.cssText = isDark()
        ? "background:#0d2e28;color:#6dfad2"
        : "background:#f0fdf9;color:#006b55";
    } else {
      trendEl.textContent   = `↗ ${pct}% more per day`;
      trendEl.style.cssText = isDark()
        ? "background:#2d1a08;color:#fb923c"
        : "background:#fff7ed;color:#ea580c";
    }
    trendEl.classList.remove("hidden");
  } else {
    trendEl.classList.add("hidden");
  }

  // ── Budget progress
  const budget         = getBudget();
  const budgetSection  = document.getElementById("home-budget-section");
  const homeLeftEl     = document.getElementById("home-left");
  const noBudgetBtn    = document.getElementById("home-no-budget-btn");

  if (budget && budget > 0) {
    budgetSection.classList.remove("hidden");
    noBudgetBtn.classList.add("hidden");
    const spent     = data.month_total;
    const pct       = Math.min(Math.round((spent / budget) * 100), 100);
    const remaining = Math.max(budget - spent, 0);

    document.getElementById("home-budget-pct").textContent      = `${pct}% used`;
    document.getElementById("home-budget-limit").textContent     = `Limit: ${fmtAmount(budget, defCur)}`;
    document.getElementById("home-budget-remaining").textContent = `${fmtAmount(remaining, defCur)} remaining`;
    homeLeftEl.textContent                                        = fmtAmount(remaining, defCur);

    // Bar colour: green → orange → red as budget fills up
    const barEl = document.getElementById("home-budget-bar");
    const barColour = pct >= 90 ? "#ef4444" : pct >= 75 ? "#f97316" : "#006b55";
    barEl.style.background = barColour;
    const accentCol = isDark() ? "#6dfad2" : "#006b55";
    document.getElementById("home-budget-remaining").style.color = pct >= 90 ? "#ef4444" : accentCol;
    homeLeftEl.style.color = pct >= 90 ? "#ef4444" : accentCol;
    setTimeout(() => { barEl.style.width = pct + "%"; }, 80);
  } else {
    budgetSection.classList.add("hidden");
    noBudgetBtn.classList.remove("hidden");
    homeLeftEl.textContent  = "—";
    homeLeftEl.style.color  = isDark() ? "#6dfad2" : "#006b55";
  }

  // ── Income / net balance card
  const incomeCard  = document.getElementById('home-income-card');
  const monthIncome = data.month_income || 0;
  incomeCard.classList.remove('hidden');
  document.getElementById('home-month-income').textContent  = fmtAmount(monthIncome, defCur);
  document.getElementById('home-month-expense').textContent = fmtAmount(data.month_total, defCur);
  const net   = monthIncome - data.month_total;
  const netEl = document.getElementById('home-net-balance');
  netEl.textContent = (net >= 0 ? '+' : '') + fmtAmount(Math.abs(net), defCur);
  netEl.style.color = net >= 0 ? (isDark() ? '#4ade80' : '#16a34a') : '#ef4444';

  data.recent.forEach(e => { state.expenseMap[e.id] = e; });
  renderDailyChart(data.daily_chart, defCur);
  renderCategoryBreakdown(data.category_breakdown, data.month_total, defCur);
  renderRecentExpenses(data.recent);
  renderPendingScans();
}

function toggleBudgetEdit() {
  const el = document.getElementById("home-budget-edit");
  el.classList.toggle("hidden");
  if (!el.classList.contains("hidden")) {
    document.getElementById("home-budget-input").focus();
  }
}

function saveHomeBudget() {
  const val = parseFloat(document.getElementById("home-budget-input").value);
  if (!val || val <= 0) { showToast("Enter a valid budget amount", true); return; }
  saveBudget(val);
  document.getElementById("home-budget-edit").classList.add("hidden");
  document.getElementById("home-budget-input").value = "";
  showToast("Budget saved!");
  loadHome();
}

function renderDailyChart(data, defCur = "EUR") {
  const maxVal   = Math.max(...data.map(d => d.total), 0.01);
  const today    = new Date().toISOString().split("T")[0];
  const barsEl   = document.getElementById("chart-bars");
  const labelsEl = document.getElementById("chart-labels");

  const dark = isDark();
  const todayBarCol  = "#6dfad2";
  const otherBarCol  = "#006b55";
  const todayLblCol  = dark ? "#6dfad2" : "#006b55";
  const otherLblCol  = dark ? "#686868" : "#44474a";
  const sym = curSym(defCur);

  function compactAmt(v) {
    if (v <= 0) return "";
    if (v >= 1000) return sym + (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return sym + (Number.isInteger(v) ? v : v.toFixed(1));
  }

  barsEl.innerHTML = data.map(d => {
    const pct     = Math.max(Math.round((d.total / maxVal) * 100), d.total > 0 ? 4 : 0);
    const isToday = d.date === today;
    const col     = isToday ? todayBarCol : otherBarCol;
    const lblCol  = isToday ? todayLblCol : otherLblCol;
    const label   = d.total > 0 ? `<span class="absolute -top-[18px] inset-x-0 text-center text-[8px] font-bold leading-none whitespace-nowrap overflow-hidden" style="color:${lblCol}">${compactAmt(d.total)}</span>` : "";
    return `<div class="flex-1 flex flex-col justify-end h-full">
        <div class="w-full rounded-t-md bar-fill relative"
             style="height:0%;background:${col}" data-h="${pct}%">${label}</div>
      </div>`;
  }).join("");

  labelsEl.innerHTML = data.map(d => {
    const isToday = d.date === today;
    const day = new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" }).slice(0,2);
    return `<div class="flex-1 text-center text-[10px] font-semibold" style="color:${isToday ? todayLblCol : otherLblCol}">${day}</div>`;
  }).join("");

  setTimeout(() => {
    barsEl.querySelectorAll("[data-h]").forEach(b => { b.style.height = b.dataset.h; });
  }, 60);
}

function renderCategoryBreakdown(breakdown, total, defCur = "EUR") {
  const el      = document.getElementById("home-categories");
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    el.innerHTML = `<div class="text-sm text-gray-300 text-center py-3">No spending this month</div>`;
    return;
  }
  const maxVal = Math.max(...entries.map(e => e[1]), 0.01);
  el.innerHTML = entries.map(([cat, amt]) => {
    const pct   = Math.round((amt / maxVal) * 100);
    const col   = catColor(cat);
    const em    = catEmoji(cat);
    const share = total > 0 ? Math.round((amt / total) * 100) : 0;
    return `
      <div class="flex items-center gap-2">
        <span class="text-base w-6 text-center flex-shrink-0">${em}</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-0.5">
            <span class="text-xs font-medium text-gray-700 truncate">${esc(cat)}</span>
            <span class="text-xs font-bold text-gray-700 ml-2">${fmtAmount(amt, defCur)}</span>
          </div>
          <div class="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div class="h-full rounded-full bar-fill" style="width:0%;background:${col}" data-w="${share}%"></div>
          </div>
        </div>
        <span class="text-[10px] text-gray-400 w-7 text-right flex-shrink-0">${share}%</span>
      </div>`;
  }).join("");

  setTimeout(() => {
    el.querySelectorAll("[data-w]").forEach(b => { b.style.width = b.dataset.w; });
  }, 80);
}

function renderRecentExpenses(expenses) {
  const el = document.getElementById("home-recent");
  if (!expenses || expenses.length === 0) {
    el.innerHTML = `<div class="text-sm text-gray-300 text-center py-3">No expenses yet</div>`;
    return;
  }
  el.innerHTML = expenses.map(exp => miniExpenseCard(exp)).join("");
}

function miniExpenseCard(exp) {
  const income = isIncomeEntry(exp);
  const col    = txnColor(exp);
  const em     = txnEmoji(exp);
  const badge  = income
    ? `<span class="text-[9px] px-1 py-0.5 rounded font-semibold ml-1 bg-green-100 text-green-700">+ income</span>`
    : exp.source === "receipt"
    ? `<span class="text-[9px] px-1 py-0.5 rounded font-semibold ml-1" style="background:${isDark()?"#1e1e1e":"#f0fdf9"};color:${isDark()?"#6dfad2":"#006b55"}">📷</span>` : "";
  const defCur = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  const isDiff = state.rates && exp.currency && exp.currency.toUpperCase() !== defCur;
  const cvt    = isDiff
    ? `<div class="text-[9px] text-gray-400">≈ ${fmtAmount(convertToDefault(exp.amount, exp.currency, exp.rate), defCur)}</div>` : "";
  const amtColor  = income ? (isDark() ? "#4ade80" : "#16a34a") : (isDark() ? "#f5f5f5" : "#1f2937");
  const amtPrefix = income ? "+" : "";
  return `
    <div onclick="showExpenseDetail('${exp.id}')"
         class="flex items-center gap-3 cursor-pointer active:opacity-70 rounded-xl p-1 -m-1 transition-opacity">
      <div class="w-9 h-9 rounded-xl flex items-center justify-center text-base flex-shrink-0"
           style="background:${catBg(col)}">${em}</div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-gray-900 truncate">${esc(exp.merchant)}${badge}</div>
        <div class="text-xs text-gray-400 truncate">${esc(exp.category)}</div>
      </div>
      <div class="text-right flex-shrink-0">
        <div class="text-sm font-bold" style="color:${amtColor}">${amtPrefix}${fmtAmount(exp.amount, exp.currency)}</div>
        ${cvt}
      </div>
    </div>`;
}

// ── Add form ──────────────────────────────────────────────────────────────────
function prepareAddForm() {
  state.isIncome = false;
  setFormType('expense');
  document.getElementById("f-date").value = new Date().toISOString().split("T")[0];
  const defaultCurrency = localStorage.getItem("defaultCurrency") || "EUR";
  populateCurrencySelect("f-currency", defaultCurrency);
  document.getElementById("f-cur-sym").textContent = curSym(defaultCurrency);
  renderPaymentButtons(state.selectedPayment, "payment-buttons");
}

function setFormType(type) {
  state.isIncome = (type === 'income');
  const expBtn = document.getElementById('toggle-expense');
  const incBtn = document.getElementById('toggle-income');
  if (expBtn && incBtn) {
    if (state.isIncome) {
      expBtn.className = 'flex-1 py-2 rounded-xl text-sm font-bold text-[#44474a] dark:text-[#aaa] transition-all';
      incBtn.className = 'flex-1 py-2 rounded-xl text-sm font-bold bg-white dark:bg-[#1e1e1e] text-[#006b55] dark:text-[#6dfad2] shadow-sm transition-all';
    } else {
      expBtn.className = 'flex-1 py-2 rounded-xl text-sm font-bold bg-white dark:bg-[#1e1e1e] text-[#191c1d] dark:text-white shadow-sm transition-all';
      incBtn.className = 'flex-1 py-2 rounded-xl text-sm font-bold text-[#44474a] dark:text-[#aaa] transition-all';
    }
  }
  const titleEl   = document.getElementById('add-form-title');
  const labelEl   = document.getElementById('f-merchant-label');
  const inputEl   = document.getElementById('f-merchant');
  const saveLabel = document.getElementById('save-label');
  const locWrap   = document.getElementById('f-location-wrap');
  const itemsSec  = document.getElementById('items-section');
  if (titleEl)   titleEl.textContent   = state.isIncome ? 'Add Income'              : 'Add Expense';
  if (saveLabel) saveLabel.textContent  = state.isIncome ? 'Add Income'              : 'Add Expense';
  if (labelEl)   labelEl.textContent   = state.isIncome ? 'Source *'                : 'Merchant *';
  if (inputEl)   inputEl.placeholder   = state.isIncome ? 'e.g. Employer, Client'   : "e.g. Lidl, McDonald's";
  if (locWrap)   locWrap.classList.toggle('hidden', state.isIncome);
  if (itemsSec && state.isIncome) itemsSec.classList.add('hidden');
  const confEl = document.getElementById('cat-confidence');
  if (confEl) confEl.classList.add('hidden');
  if (state.isIncome) {
    renderIncomeCatButtons(null);
  } else {
    loadCategoriesIntoButtons();
  }
  state.selectedCategory = null;
}

function renderIncomeCatButtons(selected) {
  const el = document.getElementById('cat-buttons');
  if (!el) return;
  el.innerHTML = getAllIncomeCategories().map(cat => {
    const col = incomeCatColor(cat);
    const isChosen = cat === selected;
    return `<button type="button" onclick="selectIncomeCategory('${esc(cat)}')"
              class="cat-chip px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white transition-all ${isChosen ? 'selected' : 'opacity-60'}"
              style="background:${col}">
        ${incomeCatEmoji(cat)} ${esc(cat)}
      </button>`;
  }).join('');
  state.selectedCategory = selected;
}

function selectIncomeCategory(cat) { renderIncomeCatButtons(cat); }

function getAllCategories() {
  const data   = getCentroids();
  const model  = Object.keys(data?.categories || {});
  const custom = data?.custom_categories || [];
  return [...new Set([...model, ...custom])].sort().concat("Others");
}

function loadCategoriesIntoButtons() {
  const data = getCentroids();
  if (data) {
    state.categories = getAllCategories();
    renderCatButtons(null);
  } else {
    fetch("/api/categories").then(r => r.json()).then(d => {
      state.categories = d.categories;
      renderCatButtons(null);
    }).catch(e => console.error("loadCategories:", e));
  }
}

function renderCatButtons(selected) {
  const el = document.getElementById("cat-buttons");
  el.innerHTML = state.categories.map(cat => {
    const col      = catColor(cat);
    const isChosen = cat === selected;
    return `
      <button type="button" onclick="selectCategory('${esc(cat)}')"
              class="cat-chip px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white transition-all ${isChosen ? "selected" : "opacity-60"}"
              style="background:${col}">
        ${catEmoji(cat)} ${esc(cat)}
      </button>`;
  }).join("");
  state.selectedCategory = selected;
}

function selectCategory(cat) { renderCatButtons(cat); }

function renderPaymentButtons(selected, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = getPaymentMethods().map(m => {
    const isChosen = m === selected;
    return `<button type="button" onclick="selectPayment('${m}', '${containerId}')"
      class="cat-chip px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all border ${isChosen
        ? 'text-white selected'
        : 'bg-white text-gray-600 border-gray-200 opacity-60'}"
      style="${isChosen ? 'background:#006b55;border-color:#006b55' : ''}"
    >${paymentIcon(m)} ${m}</button>`;
  }).join("");
}

function selectPayment(method, containerId) {
  if (containerId === "payment-buttons") {
    state.selectedPayment = (state.selectedPayment === method) ? null : method;
    renderPaymentButtons(state.selectedPayment, "payment-buttons");
  } else {
    state.editPayment = (state.editPayment === method) ? null : method;
    renderPaymentButtons(state.editPayment, "edit-payment-buttons");
  }
}

async function autoClassify() {
  if (state.isReceipt) return;
  if (state.isIncome)  return;
  const merchant = document.getElementById("f-merchant").value.trim();
  if (!merchant) return;
  try {
    const r    = await fetch("/api/classify", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ name: merchant, ...getCentroids() }),
    });
    const data = await r.json();
    if (data.error || !data.prediction) return;
    selectCategory(data.prediction);
    state.originalCategory = data.prediction;
    const confEl = document.getElementById("cat-confidence");
    const pct    = Math.round(data.confidence * 100);
    confEl.textContent = `Auto: ${pct}% confidence`;
    confEl.className   = `text-xs hidden ${data.confidence >= 0.6 ? "text-emerald-500" : "text-amber-500"}`;
    confEl.classList.remove("hidden");
  } catch (e) { /* silent */ }
}

// ── Receipt scanning ──────────────────────────────────────────────────────────
let _scanAbort = null;   // AbortController for the in-flight scan request

function triggerCamera()     { document.getElementById("receipt-file-camera").click(); }
function triggerFileSelect() { document.getElementById("receipt-file-gallery").click(); }

function onFileSelected(event) {
  const file = event.target.files[0];
  if (file) handleScanFile(file);
}

function handleScanDrop(event) {
  event.preventDefault();
  document.getElementById("scan-drop-hint").classList.add("hidden");
  const file = event.dataTransfer.files[0];
  if (file && (file.type.startsWith("image/") || file.type === "application/pdf")) handleScanFile(file);
}

function handleScanFile(file) {
  state.receiptFile = file;
  const isPdf = file.type === "application/pdf";
  const imgEl = document.getElementById("preview-img");
  const pdfEl = document.getElementById("preview-pdf");
  const pdfNameEl = document.getElementById("preview-pdf-name");

  const showPreview = () => {
    document.getElementById("scan-upload-area").classList.add("hidden");
    document.getElementById("scan-preview-area").classList.remove("hidden");
    document.getElementById("scan-confirm-area").classList.remove("hidden");
    document.getElementById("scan-analyzing-area").classList.add("hidden");
  };

  if (isPdf) {
    imgEl.classList.add("hidden");
    pdfEl.classList.remove("hidden");
    if (pdfNameEl) pdfNameEl.textContent = file.name;
    showPreview();
  } else {
    pdfEl.classList.add("hidden");
    imgEl.classList.remove("hidden");
    const reader = new FileReader();
    reader.onload = (e) => { imgEl.src = e.target.result; showPreview(); };
    reader.readAsDataURL(file);
  }
}

async function confirmAndAnalyze() {
  if (!state.receiptFile) return;
  const file = state.receiptFile;
  await queueBackgroundScan(file);
  clearScanView();
  showView('home');
  showToast('Analyzing receipt in background…');
}

// Cancel scan view — go back to method picker
function cancelScanView() {
  clearScanView();
  showView("add-method");
}

// Reset scan view UI to initial upload state
function clearScanView() {
  // Abort any in-flight scan so a late API response is ignored.
  _scanAbort?.abort();
  _scanAbort = null;
  state.receiptFile  = null;
  state.isReceipt    = false;
  state.receiptItems = [];
  ["receipt-file-camera", "receipt-file-gallery"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  const img = document.getElementById("preview-img");
  if (img) { img.src = ""; img.classList.remove("hidden"); }
  const pdfEl = document.getElementById("preview-pdf");
  if (pdfEl) pdfEl.classList.add("hidden");
  document.getElementById("scan-upload-area")?.classList.remove("hidden");
  document.getElementById("scan-preview-area")?.classList.add("hidden");
  document.getElementById("scan-confirm-area")?.classList.remove("hidden");
  document.getElementById("scan-analyzing-area")?.classList.add("hidden");
  document.querySelector("#scan-preview-area button.scan-retry")?.remove();
}

// Called after saving or when resetting form state
function clearScan() {
  state.isVoice = false;
  clearScanView();
  document.getElementById("items-section").classList.add("hidden");
  document.getElementById("items-list").innerHTML = "";
  document.getElementById("save-label").textContent = "Add Expense";
  document.getElementById("cat-confidence").classList.add("hidden");
  resetForm();
}

// ── Background receipt scanning queue ─────────────────────────────────────────

async function _makeThumbnail(file) {
  if (file.type === 'application/pdf') return null;
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const MAX = 120;
        const scale = Math.min(1, MAX / img.width, MAX / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = () => resolve(null);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function queueBackgroundScan(file) {
  const id        = generateId();
  const thumbnail = await _makeThumbnail(file);

  _pendingScansFiles[id]  = file;
  _pendingScansAborts[id] = new AbortController();

  const scans = getPendingScans();
  scans.push({
    id,
    status:           'processing',
    fileName:         file.name || 'receipt',
    isPdf:            file.type === 'application/pdf',
    thumbnailDataUrl: thumbnail,
    extractedData:    null,
    errorMessage:     null,
    createdAt:        new Date().toISOString(),
  });
  savePendingScans(scans);
  _runBackgroundScan(id, file, _pendingScansAborts[id]);
}

async function _runBackgroundScan(id, file, abort) {
  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('payment_methods', getPaymentMethods().join(','));

    const resp = await postWithOverloadRetry('/api/scan_receipt', formData, { signal: abort.signal });
    if (abort.signal.aborted) return;

    const scans = getPendingScans();
    const scan  = scans.find(s => s.id === id);
    if (scan) { scan.status = 'ready'; scan.extractedData = resp.data; savePendingScans(scans); }
    delete _pendingScansAborts[id];

    _refreshHomePendingScans();
    showToast('Receipt ready — tap to review!');
  } catch (e) {
    if (e.name === 'AbortError' || abort.signal.aborted) return;

    const scans = getPendingScans();
    const scan  = scans.find(s => s.id === id);
    if (scan) { scan.status = 'error'; scan.errorMessage = e.message || 'Analysis failed'; savePendingScans(scans); }
    delete _pendingScansAborts[id];

    _refreshHomePendingScans();
    showToast('Scan failed: ' + (e.message || 'unknown error'), true);
  }
}

function _refreshHomePendingScans() {
  if (document.getElementById('home-pending-scans')) renderPendingScans();
}

function renderPendingScans() {
  const section = document.getElementById('home-pending-scans');
  const list    = document.getElementById('pending-scans-list');
  if (!section || !list) return;
  const scans = getPendingScans();
  if (scans.length === 0) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  list.innerHTML = scans.map(pendingScanCard).join('');
}

function pendingScanCard(scan) {
  const thumb = scan.thumbnailDataUrl
    ? `<img src="${scan.thumbnailDataUrl}" class="w-10 h-10 object-cover rounded-xl flex-shrink-0" />`
    : `<div class="w-10 h-10 rounded-xl bg-[#f0fdf9] flex items-center justify-center flex-shrink-0 text-xl">${scan.isPdf ? '📄' : '🧾'}</div>`;
  const closeBtn = `<button onclick="event.stopPropagation();dismissPendingScan('${scan.id}')"
    class="w-7 h-7 flex items-center justify-center text-[#44474a] hover:text-red-500 flex-shrink-0 transition-colors ml-1">
    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
  </button>`;

  if (scan.status === 'processing') {
    return `<div class="flex items-center gap-3 py-0.5">${thumb}
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-[#191c1d] truncate">${esc(scan.fileName || 'Receipt')}</div>
        <div class="text-xs text-[#44474a]">Analyzing with AI…</div>
      </div>
      <span class="loader flex-shrink-0 ml-1" style="width:18px;height:18px;border-width:2px;border-color:rgba(0,107,85,0.25);border-top-color:#006b55;"></span>
      ${closeBtn}</div>`;
  }
  if (scan.status === 'ready') {
    const merchant = scan.extractedData?.merchant || scan.fileName || 'Receipt';
    const total    = scan.extractedData?.total != null
      ? ' · ' + fmtAmount(scan.extractedData.total, scan.extractedData.currency || (localStorage.getItem('defaultCurrency') || 'EUR'))
      : '';
    return `<div onclick="resumePendingScan('${scan.id}')"
      class="flex items-center gap-3 cursor-pointer active:opacity-70 py-0.5 rounded-xl transition-opacity">${thumb}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5">
          <span class="text-sm font-semibold text-[#191c1d] truncate">${esc(merchant)}</span>
          <span class="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0"></span>
        </div>
        <div class="text-xs font-medium text-emerald-600">Tap to review${total}</div>
      </div>${closeBtn}</div>`;
  }
  if (scan.status === 'error') {
    return `<div class="flex items-center gap-3 py-0.5">${thumb}
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-[#191c1d] truncate">${esc(scan.fileName || 'Receipt')}</div>
        <div class="text-xs text-red-500 truncate">${esc(scan.errorMessage || 'Analysis failed')}</div>
      </div>
      <button onclick="retryPendingScan('${scan.id}')"
        class="text-xs font-bold text-[#006b55] px-2 py-1 rounded-xl border border-[#006b55] flex-shrink-0 whitespace-nowrap">Retry</button>
      ${closeBtn}</div>`;
  }
  return '';
}

function resumePendingScan(id) {
  const scan = getPendingScans().find(s => s.id === id);
  if (!scan || scan.status !== 'ready' || !scan.extractedData) return;
  state.currentPendingScanId = id;
  state.receiptFile          = _pendingScansFiles[id] || null;
  showVerifyView(scan.extractedData);
}

function dismissPendingScan(id) {
  _pendingScansAborts[id]?.abort();
  delete _pendingScansAborts[id];
  delete _pendingScansFiles[id];
  savePendingScans(getPendingScans().filter(s => s.id !== id));
  renderPendingScans();
}

async function retryPendingScan(id) {
  const file = _pendingScansFiles[id];
  if (!file) { showToast('Original file no longer available — please re-upload', true); dismissPendingScan(id); return; }
  const scans = getPendingScans();
  const scan  = scans.find(s => s.id === id);
  if (!scan) return;
  scan.status = 'processing'; scan.errorMessage = null;
  savePendingScans(scans);
  renderPendingScans();
  const abort = new AbortController();
  _pendingScansAborts[id] = abort;
  _runBackgroundScan(id, file, abort);
}

async function analyzeScanReceipt() {
  if (!state.receiptFile) return;
  const statusEl  = document.getElementById("scan-status");
  const spinnerEl = document.getElementById("scan-spinner-el");
  if (statusEl)  statusEl.textContent = "Analyzing with AI…";
  if (spinnerEl) spinnerEl.classList.remove("hidden");
  // Remove any previous retry button
  document.querySelector("#scan-preview-area .scan-retry")?.remove();

  // Abort any prior in-flight scan, then track this one so a cancel can stop it.
  _scanAbort?.abort();
  const abort = new AbortController();
  _scanAbort  = abort;

  try {
    const formData = new FormData();
    formData.append("file", state.receiptFile);
    formData.append("payment_methods", getPaymentMethods().join(","));
    const resp = await postWithOverloadRetry("/api/scan_receipt", formData, {
      signal: abort.signal,
      onRetry: (n, total) => {
        const msg = `The model is in high demand. Please wait… (retry ${n}/${total})`;
        if (statusEl) statusEl.textContent = msg;
        showToast(msg, true);
      },
    });
    // User cancelled while the request was in flight — ignore the late response.
    if (abort.signal.aborted) return;
    showVerifyView(resp.data);
  } catch (e) {
    // Cancelled request — silently ignore, the user has already moved on.
    if (e.name === "AbortError" || abort.signal.aborted) return;
    showToast(e.retryable ? e.message : "Failed: " + e.message, true);
    if (statusEl)  statusEl.textContent = "Analysis failed";
    if (spinnerEl) spinnerEl.classList.add("hidden");
    // Offer retry inline
    const area = document.getElementById("scan-preview-area");
    if (area) {
      const btn = document.createElement("button");
      btn.textContent = "Retry Analysis";
      btn.className   = "scan-retry mt-1 px-5 py-2.5 bg-[#006b55] text-white rounded-2xl text-sm font-bold";
      btn.onclick     = () => { btn.remove(); analyzeScanReceipt(); };
      area.appendChild(btn);
    }
  }
}

let _receiptRefBlobUrl = null;

function showReceiptRef(file) {
  const strip = document.getElementById("receipt-ref-strip");
  if (!strip) return;
  if (_receiptRefBlobUrl) { URL.revokeObjectURL(_receiptRefBlobUrl); _receiptRefBlobUrl = null; }
  const isPdf = file.type === "application/pdf";
  const imgEl = document.getElementById("receipt-ref-img");
  const pdfEl = document.getElementById("receipt-ref-pdf");
  const pdfName = document.getElementById("receipt-ref-pdf-name");
  if (isPdf) {
    imgEl.classList.add("hidden");
    pdfEl.classList.remove("hidden");
    if (pdfName) pdfName.textContent = file.name;
  } else {
    _receiptRefBlobUrl = URL.createObjectURL(file);
    imgEl.src = _receiptRefBlobUrl;
    imgEl.classList.remove("hidden");
    pdfEl.classList.add("hidden");
  }
  document.getElementById("receipt-ref-panel").classList.add("hidden");
  document.getElementById("receipt-ref-chevron").style.transform = "";
  strip.classList.remove("hidden");
}

function hideReceiptRef() {
  const strip = document.getElementById("receipt-ref-strip");
  if (strip) strip.classList.add("hidden");
  if (_receiptRefBlobUrl) { URL.revokeObjectURL(_receiptRefBlobUrl); _receiptRefBlobUrl = null; }
  const imgEl = document.getElementById("receipt-ref-img");
  if (imgEl) imgEl.src = "";
}

function toggleReceiptRef() {
  const panel = document.getElementById("receipt-ref-panel");
  const chevron = document.getElementById("receipt-ref-chevron");
  const open = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", open);
  chevron.style.transform = open ? "" : "rotate(180deg)";
}

function resetForm() {
  hideReceiptRef();
  const defaultCurrency = localStorage.getItem("defaultCurrency") || "EUR";
  document.getElementById("f-merchant").value      = "";
  document.getElementById("f-amount").value        = "";
  populateCurrencySelect("f-currency", defaultCurrency);
  document.getElementById("f-cur-sym").textContent = curSym(defaultCurrency);
  document.getElementById("f-date").value          = new Date().toISOString().split("T")[0];
  document.getElementById("f-notes").value         = "";
  document.getElementById("f-location").value      = "";
  document.getElementById("f-nearby-results").classList.add("hidden");
  const rateRow = document.getElementById("f-rate-row");
  if (rateRow) rateRow.style.display = "none";
  state.isIncome         = false;
  state.selectedCategory = null;
  state.originalCategory = null;
  state.selectedPayment  = null;
  renderCatButtons(null);
  renderPaymentButtons(null, "payment-buttons");
}

// ── Receipt verify view ───────────────────────────────────────────────────────
let _verifyBlobUrl = null;
let _verifyZoomed  = false;

function showVerifyView(data) {
  state.pendingReceiptData = JSON.parse(JSON.stringify(data));
  state.pendingReceiptData.items = mergeItems(state.pendingReceiptData.items || []);

  const imgEl  = document.getElementById("verify-img");
  const pdfEl  = document.getElementById("verify-pdf");
  const zoomBtn = document.getElementById("verify-zoom-btn");

  const panel = document.getElementById("verify-img-panel");

  if (state.receiptFile) {
    if (_verifyBlobUrl) { URL.revokeObjectURL(_verifyBlobUrl); }
    _verifyBlobUrl = URL.createObjectURL(state.receiptFile);

    if (state.receiptFile.type === "application/pdf") {
      imgEl.classList.add("hidden");
      pdfEl.classList.remove("hidden");
      if (zoomBtn) zoomBtn.classList.add("hidden");
      panel.style.height = "55%";
      renderPdfPages(state.receiptFile);
    } else {
      imgEl.src = _verifyBlobUrl;
      imgEl.classList.remove("hidden");
      pdfEl.classList.add("hidden");
      if (zoomBtn) zoomBtn.classList.remove("hidden");
      panel.style.height = "42%";
    }
  }

  _verifyZoomed = false;
  imgEl.style.width = "100%";
  document.getElementById("verify-zoom-icon-in").classList.remove("hidden");
  document.getElementById("verify-zoom-icon-out").classList.add("hidden");
  panel.scrollTop = 0;
  panel.scrollLeft = 0;

  document.getElementById("v-merchant").value = data.merchant || "";
  if (data.total != null) document.getElementById("v-total").value = Number(data.total).toFixed(2);
  else document.getElementById("v-total").value = "";
  const code = data.currency ? data.currency.toUpperCase() : (localStorage.getItem("defaultCurrency") || "EUR");
  populateCurrencySelect("v-currency", code);
  document.getElementById("v-date").value = data.date || new Date().toISOString().split("T")[0];

  renderVerifyItems();
  showView("verify");
}

function renderVerifyItems() {
  const items = state.pendingReceiptData?.items || [];
  const countEl = document.getElementById("v-items-count");
  if (countEl) countEl.textContent = items.length > 0 ? `(${items.length})` : "";
  document.getElementById("v-items-list").innerHTML = items.map((item, i) => `
    <div class="flex items-center gap-2">
      <input type="text" value="${esc(item.name || "")}" placeholder="Item name"
             oninput="state.pendingReceiptData.items[${i}].name = this.value"
             class="flex-1 min-w-0 px-3 py-2 border border-[#c5c6ca] rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white" />
      <input type="number" value="${item.quantity != null ? item.quantity : 1}" placeholder="1" min="1" step="1"
             oninput="state.pendingReceiptData.items[${i}].quantity = this.value === '' ? 1 : parseInt(this.value)"
             class="w-12 px-2 py-2 border border-[#c5c6ca] rounded-xl text-xs text-center focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white" />
      <input type="number" value="${item.price != null ? item.price : ""}" placeholder="0.00" step="0.01"
             oninput="state.pendingReceiptData.items[${i}].price = this.value === '' ? null : parseFloat(this.value)"
             class="w-20 px-2 py-2 border border-[#c5c6ca] rounded-xl text-xs text-right focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white" />
      <button type="button" onclick="removeVerifyItem(${i})"
              class="w-7 h-7 flex items-center justify-center text-[#44474a] hover:text-red-500 transition-colors flex-shrink-0">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>`).join("");
}

function addVerifyItem() {
  if (!state.pendingReceiptData) return;
  state.pendingReceiptData.items = state.pendingReceiptData.items || [];
  state.pendingReceiptData.items.push({ name: "", price: null, quantity: 1 });
  renderVerifyItems();
  const rows = document.querySelectorAll("#v-items-list > div");
  if (rows.length) rows[rows.length - 1].querySelector("input[type=text]")?.focus();
}

function removeVerifyItem(idx) {
  if (!state.pendingReceiptData?.items) return;
  state.pendingReceiptData.items.splice(idx, 1);
  renderVerifyItems();
}

function renderAddFormItems() {
  const el = document.getElementById("items-list");
  if (!el) return;
  if (!state.receiptItems || state.receiptItems.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = state.receiptItems.map((item, i) => `
    <div class="flex items-center gap-2">
      <input type="text" value="${esc(item.name || "")}" placeholder="Item name"
             oninput="state.receiptItems[${i}].name = this.value"
             class="flex-1 min-w-0 px-3 py-2 border border-[#c5c6ca] rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white" />
      <input type="number" value="${item.quantity != null ? item.quantity : 1}" placeholder="1" min="1" step="1"
             oninput="state.receiptItems[${i}].quantity = this.value === '' ? 1 : parseInt(this.value)"
             class="w-12 px-2 py-2 border border-[#c5c6ca] rounded-xl text-xs text-center focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white" />
      <input type="number" value="${item.price != null ? item.price : ""}" placeholder="0.00" step="0.01"
             oninput="state.receiptItems[${i}].price = this.value === '' ? null : parseFloat(this.value)"
             class="w-20 px-2 py-2 border border-[#c5c6ca] rounded-xl text-xs text-right focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white" />
      <button type="button" onclick="removeFormItem(${i})"
              class="w-7 h-7 flex items-center justify-center text-[#44474a] hover:text-red-500 transition-colors flex-shrink-0">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>`).join("");
}

function addFormItem() {
  state.receiptItems = state.receiptItems || [];
  state.receiptItems.push({ name: "", price: null, quantity: 1 });
  renderAddFormItems();
  const rows = document.querySelectorAll("#items-list > div");
  if (rows.length) rows[rows.length - 1].querySelector("input[type=text]")?.focus();
}

function removeFormItem(idx) {
  state.receiptItems.splice(idx, 1);
  renderAddFormItems();
}

function toggleVerifyZoom() {
  _verifyZoomed = !_verifyZoomed;
  const imgEl = document.getElementById("verify-img");
  if (imgEl) imgEl.style.width = _verifyZoomed ? "200%" : "100%";
  const panel = document.getElementById("verify-img-panel");
  if (!_verifyZoomed && panel) { panel.scrollLeft = 0; }
  document.getElementById("verify-zoom-icon-in").classList.toggle("hidden", _verifyZoomed);
  document.getElementById("verify-zoom-icon-out").classList.toggle("hidden", !_verifyZoomed);
}

async function renderPdfPages(file) {
  const wrap = document.getElementById("verify-pdf-canvas-wrap");
  if (!wrap) return;
  wrap.innerHTML = '<p class="text-xs text-center text-[#44474a] py-4">Loading PDF…</p>';
  try {
    if (typeof pdfjsLib === "undefined") throw new Error("PDF.js not loaded");
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    wrap.innerHTML = "";
    const panelWidth = document.getElementById("verify-img-panel").clientWidth;
    const dpr = window.devicePixelRatio || 1;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page        = await pdf.getPage(p);
      const baseScale   = panelWidth / page.getViewport({ scale: 1 }).width;
      const viewport    = page.getViewport({ scale: baseScale * dpr });
      const canvas      = document.createElement("canvas");
      canvas.width      = viewport.width;
      canvas.height     = viewport.height;
      canvas.style.width   = "100%";
      canvas.style.display = "block";
      wrap.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    }
  } catch (e) {
    wrap.innerHTML = `<p class="text-xs text-center text-red-500 py-4">Could not render PDF: ${e.message}</p>`;
  }
}

function clearVerifyView() {
  if (_verifyBlobUrl) { URL.revokeObjectURL(_verifyBlobUrl); _verifyBlobUrl = null; }
  const imgEl = document.getElementById("verify-img");
  if (imgEl) imgEl.src = "";
  const wrap = document.getElementById("verify-pdf-canvas-wrap");
  if (wrap) wrap.innerHTML = "";
  state.pendingReceiptData = null;
}

function cancelVerifyView() {
  const fromBackground = !!state.currentPendingScanId;
  state.currentPendingScanId = null;
  clearVerifyView();
  showView(fromBackground ? 'home' : 'scan');
}

function confirmVerify() {
  if (!state.pendingReceiptData) return;
  const data = { ...state.pendingReceiptData };
  data.merchant = document.getElementById("v-merchant").value.trim();
  const tv = document.getElementById("v-total").value;
  data.total    = tv !== "" ? parseFloat(tv) : null;
  data.currency = document.getElementById("v-currency").value;
  data.date     = document.getElementById("v-date").value;
  if (_verifyBlobUrl) { URL.revokeObjectURL(_verifyBlobUrl); _verifyBlobUrl = null; }
  const wrap = document.getElementById("verify-pdf-canvas-wrap");
  if (wrap) wrap.innerHTML = "";
  populateFormFromReceipt(data);
  showToast("Receipt verified successfully!");
}

function populateFormFromReceipt(data) {
  // Navigate to add view first (runs prepareAddForm for fresh state)
  showView("add");

  state.isReceipt    = true;
  state.receiptItems = mergeItems(data.items || []);

  if (state.receiptFile) showReceiptRef(state.receiptFile);

  document.getElementById("f-merchant").value = data.merchant || "";
  if (data.total != null) document.getElementById("f-amount").value = Number(data.total).toFixed(2);
  if (data.currency) {
    const code   = data.currency.toUpperCase();
    const defCur = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
    const sel    = document.getElementById("f-currency");
    if ([...sel.options].some(o => o.value === code)) sel.value = code;
    document.getElementById("f-cur-sym").textContent = curSym(code);
    updateRateRow("f", code, defCur, null);
  }
  if (data.date)     document.getElementById("f-date").value     = data.date;
  if (data.location) document.getElementById("f-location").value = data.location;

  const pm = data.payment_method && getPaymentMethods().includes(data.payment_method) ? data.payment_method : null;
  state.selectedPayment = pm;
  renderPaymentButtons(pm, "payment-buttons");

  const cat = data.predicted_category || "Others";
  selectCategory(cat);
  state.originalCategory = cat;

  const confEl = document.getElementById("cat-confidence");
  const pct    = Math.round((data.confidence || 0) * 100);
  confEl.textContent = `Detected: ${pct}% confidence`;
  confEl.className   = `text-xs ${(data.confidence||0) >= 0.6 ? "text-emerald-500" : "text-amber-500"}`;
  confEl.classList.remove("hidden");

  if (state.receiptItems.length > 0) {
    document.getElementById("items-section").classList.remove("hidden");
    renderAddFormItems();
  }
  document.getElementById("save-label").textContent = "Confirm & Save";
}

// ── Voice input ───────────────────────────────────────────────────────────────
let _voiceStream       = null;    // mic MediaStream (held so we can stop its tracks)
let _isRecording       = false;
let _liveWS            = null;
let _audioCtx          = null;
let _audioProcessor    = null;
let _liveTranscript    = '';
let _interimTranscript = '';
let _voiceFinalized    = false;   // guards finalizeVoiceTranscript() against double-run
let _voiceOriginal     = '';      // raw transcript from Gemini Live
let _voiceSummary      = '';      // clean summary of the spoken note
let _voiceCancelled    = false;   // set true by cancelVoiceView() to abort server call
let _voiceAbort        = null;    // AbortController for the in-flight extraction request

// ── Voice view UI helpers ─────────────────────────────────────────────────────
function _vvSetState(state) {
  // state: 'idle' | 'recording' | 'processing'
  const btn      = document.getElementById('voice-btn');
  const micIcon  = document.getElementById('vv-mic-icon');
  const stopIcon = document.getElementById('vv-stop-icon');
  const ringOut  = document.getElementById('vv-ring-outer');
  const ringIn   = document.getElementById('vv-ring-inner');
  const label    = document.getElementById('voice-label');
  const status   = document.getElementById('voice-status');

  // The transcript-confirmation card is its own display (shown via
  // showVoiceConfirm); the idle/recording/processing states never use it.
  document.getElementById('voice-confirm')?.classList.add('hidden');
  document.getElementById('vv-mic-wrap')?.classList.remove('hidden');
  if (label) label.classList.remove('hidden');

  if (state === 'recording') {
    btn?.classList.add('voice-recording');
    btn?.classList.remove('voice-idle');
    micIcon?.classList.add('hidden');
    stopIcon?.classList.remove('hidden');
    ringOut?.classList.remove('hidden');
    ringIn?.classList.remove('hidden');
    if (label)  label.textContent  = 'Tap to stop';
    if (status) status.textContent = 'Listening…';
  } else if (state === 'processing') {
    btn?.classList.remove('voice-recording');
    btn?.classList.add('voice-idle');
    micIcon?.classList.remove('hidden');
    stopIcon?.classList.add('hidden');
    ringOut?.classList.add('hidden');
    ringIn?.classList.add('hidden');
    if (label)  label.textContent  = 'Processing…';
    if (status) status.textContent = 'Analyzing with AI…';
  } else { // idle
    btn?.classList.remove('voice-recording');
    btn?.classList.add('voice-idle');
    micIcon?.classList.remove('hidden');
    stopIcon?.classList.add('hidden');
    ringOut?.classList.add('hidden');
    ringIn?.classList.add('hidden');
    if (label)  label.textContent  = 'Tap to start';
    if (status) status.textContent = 'Tap the mic to start recording';
    const sub = document.getElementById('voice-subtitle');
    if (sub) sub.classList.add('hidden');
    const fin = document.getElementById('voice-subtitle-final');
    if (fin) fin.textContent = '';
    const itr = document.getElementById('voice-subtitle-interim');
    if (itr) itr.textContent = '';
  }
}

// ── Tear down mic + live-transcription capture ────────────────────────────────
function teardownVoiceCapture() {
  if (_audioProcessor) { _audioProcessor.disconnect(); _audioProcessor = null; }
  if (_audioCtx)       { try { _audioCtx.close(); } catch {} _audioCtx = null; }
  if (_liveWS && _liveWS.readyState === WebSocket.OPEN) {
    try { _liveWS.send(JSON.stringify({ type: 'stop' })); } catch {}
    try { _liveWS.close(); } catch {}
  }
  _liveWS = null;
  if (_voiceStream) { _voiceStream.getTracks().forEach(t => t.stop()); _voiceStream = null; }
}

// ── Cancel / back from voice view ─────────────────────────────────────────────
function cancelVoiceView() {
  // Cancel a request already sent to the server (processing phase) and stop any
  // pending finalize from firing after the user has navigated away.
  _voiceCancelled = true;
  _voiceFinalized = true;
  _voiceAbort?.abort();
  _voiceAbort = null;
  _isRecording = false;
  teardownVoiceCapture();
  resetVoiceBtn();
  showView('add-method');
}

async function toggleVoiceRecording() {
  if (_isRecording) {
    stopVoiceRecording();
  } else {
    await startVoiceRecording();
  }
}

async function startVoiceRecording() {
  try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    _voiceStream       = stream;
    _voiceCancelled    = false;
    _voiceFinalized    = false;
    _isRecording       = true;
    _liveTranscript    = '';
    _interimTranscript = '';

    // AudioContext for Gemini Live PCM stream (live subtitles).
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    if (_audioCtx.state === 'suspended') await _audioCtx.resume();
    const actualRate = _audioCtx.sampleRate;

    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    _liveWS = new WebSocket(`${wsProto}//${location.host}/ws/voice_live`);

    _liveWS.onopen = () => {
      _liveWS.send(JSON.stringify({ sample_rate: actualRate }));
      const source = _audioCtx.createMediaStreamSource(stream);
      _audioProcessor = _audioCtx.createScriptProcessor(4096, 1, 1);
      source.connect(_audioProcessor);
      _audioProcessor.connect(_audioCtx.destination);
      _audioProcessor.onaudioprocess = ev => {
        if (!_liveWS || _liveWS.readyState !== WebSocket.OPEN) return;
        const f32  = ev.inputBuffer.getChannelData(0);
        const i16  = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++)
          i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
        const bytes = new Uint8Array(i16.buffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        _liveWS.send(JSON.stringify({ type: 'audio', data: btoa(bin) }));
      };
    };

    _liveWS.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.transcript !== undefined) {
          _liveTranscript = msg.transcript;
          const sub = document.getElementById('voice-subtitle');
          const fin = document.getElementById('voice-subtitle-final');
          const itr = document.getElementById('voice-subtitle-interim');
          if (fin) fin.textContent = _liveTranscript;
          if (itr) itr.textContent = '';
          if (sub) { sub.classList.remove('hidden'); sub.scrollTop = sub.scrollHeight; }
        } else if (msg.error) {
          console.warn('[Live] Gemini error:', msg.error);
          showToast('Live transcription error: ' + msg.error, true);
        }
      } catch {}
    };

    _liveWS.onerror = ev => console.warn('[Live] WS error:', ev);
    _liveWS.onclose = () => {
      if (_audioProcessor) { _audioProcessor.disconnect(); _audioProcessor = null; }
      // Socket closed after the user tapped stop → the transcript is final.
      if (!_isRecording) finalizeVoiceTranscript();
    };

    _vvSetState('recording');
  } catch (e) {
    showToast('Microphone access denied: ' + e.message, true);
  }
}

function stopVoiceRecording() {
  if (!_isRecording) return;
  _isRecording = false;

  // Stop capturing, but keep the live socket open briefly so Gemini can flush
  // any trailing transcription before we read the final transcript.
  if (_audioProcessor) { _audioProcessor.disconnect(); _audioProcessor = null; }
  if (_audioCtx)       { try { _audioCtx.close(); } catch {} _audioCtx = null; }
  if (_voiceStream)    { _voiceStream.getTracks().forEach(t => t.stop()); _voiceStream = null; }
  _vvSetState('processing');

  if (_liveWS && _liveWS.readyState === WebSocket.OPEN) {
    try { _liveWS.send(JSON.stringify({ type: 'stop' })); } catch {}
    // onclose finalizes when the flush completes; this is a fallback in case
    // the socket lingers.
    setTimeout(() => finalizeVoiceTranscript(), 1500);
  } else {
    finalizeVoiceTranscript();
  }
}

// Read the final live transcript and show the confirmation step. Guarded so it
// runs at most once per recording. The summary is fetched asynchronously and
// fills the box when ready (loadVoiceSummary).
async function finalizeVoiceTranscript() {
  if (_voiceFinalized) return;
  _voiceFinalized = true;
  teardownVoiceCapture();

  if (_voiceCancelled) { _voiceCancelled = false; return; }

  const original = (_liveTranscript || '').trim();
  if (!original) {
    showToast('No speech detected. Please try again.', true);
    _vvSetState('idle');
    return;
  }

  _voiceOriginal = original;
  _voiceSummary  = original;

  // Hide mic UI and show a loading state while waiting for the summary API call.
  document.getElementById('voice-subtitle')?.classList.add('hidden');
  document.getElementById('vv-mic-wrap')?.classList.add('hidden');
  document.getElementById('voice-label')?.classList.add('hidden');
  const status = document.getElementById('voice-status');
  if (status) status.textContent = 'Summarizing what you said…';

  await loadVoiceSummary();
}

// Fetch (or re-fetch) the summary for the current transcript and fill the box.
// Honest on failure: shows the raw transcript and says so, rather than passing
// it off as a summary. Also bound to the "Regenerate" button.
async function loadVoiceSummary() {
  const original = _voiceOriginal;
  if (!original) return;

  const box     = document.getElementById('vc-summary');
  const origWrap = document.getElementById('vc-original-wrap');
  const regen   = document.getElementById('vc-regen');
  const status  = document.getElementById('voice-status');

  box.value       = '';
  box.placeholder = '';
  origWrap.classList.add('hidden');
  if (regen)  regen.disabled = true;
  if (status) status.textContent = 'Summarizing what you said…';

  const formData = new FormData();
  formData.append('transcript', original);

  try {
    const resp = await postWithOverloadRetry('/api/voice_summary', formData, {
      onRetry: (n, total) => {
        if (status) status.textContent = `Model busy — retrying (${n}/${total})…`;
      },
    });
    const summary = (resp.summary || original).trim() || original;
    _voiceSummary = summary;
    box.value     = summary;
    const same = summary === original;
    document.getElementById('vc-original').textContent = original;
    origWrap.classList.toggle('hidden', same);
    document.getElementById('voice-confirm')?.classList.remove('hidden');
    if (status) status.textContent = same
      ? 'Does this look right? Edit it if needed.'
      : 'Here\'s a summary — edit it, or keep what was heard.';
  } catch (e) {
    // Couldn't summarise (e.g. model overloaded) — show the raw transcript and
    // be clear that it isn't a summary, with Regenerate available.
    _voiceSummary = original;
    box.value     = original;
    origWrap.classList.add('hidden');
    document.getElementById('vc-original').textContent = original;
    document.getElementById('voice-confirm')?.classList.remove('hidden');
    if (status) status.textContent =
      'Couldn\'t summarize (model busy). Showing what you said — edit it, or tap Regenerate.';
  } finally {
    if (regen) regen.disabled = false;
  }
}

// Restore the editable field back to the raw transcript Gemini Live heard.
function revertVoiceCorrection() {
  document.getElementById('vc-summary').value = _voiceOriginal;
}

// User picked which text to use → extract the expense from it.
// useSummary=true uses the (possibly edited) summary in the box; false uses the
// raw transcript as heard.
async function confirmVoiceTranscript(useSummary) {
  const transcript = (useSummary
    ? document.getElementById('vc-summary').value
    : _voiceOriginal).trim();
  if (!transcript) { showToast('Transcript is empty — please edit it first.', true); return; }

  document.getElementById('voice-confirm')?.classList.add('hidden');
  _vvSetState('processing');

  const formData = new FormData();
  formData.append('transcript', transcript);

  const btn = document.getElementById('voice-btn');
  if (btn) btn.disabled = true;

  const abort = new AbortController();
  _voiceAbort = abort;

  try {
    const resp = await postWithOverloadRetry('/api/voice_extract', formData, {
      signal: abort.signal,
      onRetry: (n, total) =>
        showToast(`The model is in high demand. Please wait… (retry ${n}/${total})`, true),
    });
    if (abort.signal.aborted) return;
    populateFormFromVoice(resp.data);
    showToast('Voice input captured!');
  } catch (e) {
    if (e.name === 'AbortError' || abort.signal.aborted) return;
    showToast(e.retryable ? e.message : 'Voice failed: ' + e.message, true);
    resetVoiceBtn();
  } finally {
    if (_voiceAbort === abort) _voiceAbort = null;
    if (btn) btn.disabled = false;
  }
}

function resetVoiceBtn() {
  _isRecording       = false;
  _liveTranscript    = '';
  _interimTranscript = '';
  _liveWS            = null;
  _audioCtx          = null;
  _audioProcessor    = null;
  _voiceStream       = null;
  _vvSetState('idle');
}

function populateFormFromVoice(data) {
  // Navigate to add view first (runs prepareAddForm for fresh form state)
  showView('add');

  const isIncome = data.transaction_type === 'income';
  if (isIncome) setFormType('income');

  state.isVoice      = true;
  state.isReceipt    = false;
  state.receiptItems = mergeItems(data.items || []);
  state.receiptFile  = null;

  document.getElementById("f-merchant").value = data.merchant || "";
  if (data.total != null) document.getElementById("f-amount").value = Number(data.total).toFixed(2);

  if (data.currency) {
    const code   = data.currency.toUpperCase();
    const defCur = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
    const sel    = document.getElementById("f-currency");
    if ([...sel.options].some(o => o.value === code)) sel.value = code;
    document.getElementById("f-cur-sym").textContent = curSym(code);
    updateRateRow("f", code, defCur, null);
  }
  if (data.date)     document.getElementById("f-date").value     = data.date;
  if (data.location && !isIncome) document.getElementById("f-location").value = data.location;

  const pm = data.payment_method && getPaymentMethods().includes(data.payment_method) ? data.payment_method : null;
  state.selectedPayment = pm;
  renderPaymentButtons(pm, "payment-buttons");

  const cat = data.predicted_category || (isIncome ? "Other Income" : "Others");
  if (isIncome) {
    renderIncomeCatButtons(cat);
  } else {
    selectCategory(cat);
    state.originalCategory = cat;

    const confEl = document.getElementById("cat-confidence");
    const pct    = Math.round((data.confidence || 0) * 100);
    confEl.textContent = `Voice: ${pct}% confidence`;
    confEl.className   = `text-xs ${(data.confidence || 0) >= 0.6 ? "text-emerald-500" : "text-amber-500"}`;
    confEl.classList.remove("hidden");
  }

  if (!isIncome && state.receiptItems.length > 0) {
    document.getElementById("items-section").classList.remove("hidden");
    renderAddFormItems();
  }

  document.getElementById("save-label").textContent = "Confirm & Save";
  resetVoiceBtn();
}

function clearVoice() {
  state.isVoice = false;
  document.getElementById("cat-confidence").classList.add("hidden");
  document.getElementById("save-label").textContent = "Add Expense";
  resetVoiceBtn();
  resetForm();
  showView('voice');
}

// ── Save expense ──────────────────────────────────────────────────────────────
async function saveExpense() {
  const merchant       = document.getElementById("f-merchant").value.trim();
  const amount         = document.getElementById("f-amount").value;
  const currency       = document.getElementById("f-currency").value || "EUR";
  const date_val       = document.getElementById("f-date").value;
  const notes          = document.getElementById("f-notes").value.trim();
  const location       = document.getElementById("f-location").value.trim();
  let   category       = state.selectedCategory;
  const payment_method = state.selectedPayment || "";
  const defCur         = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  const rateRaw        = parseFloat(document.getElementById("f-rate")?.value);
  const storedRate     = currency.toUpperCase() !== defCur && !isNaN(rateRaw) && rateRaw > 0 ? rateRaw : null;

  if (!merchant) { showToast(state.isIncome ? "Please enter a source" : "Please enter a merchant name", true); return; }
  if (!amount || isNaN(parseFloat(amount))) { showToast("Please enter a valid amount", true); return; }

  const btn     = document.getElementById("save-btn");
  const label   = document.getElementById("save-label");
  const spinner = document.getElementById("save-spinner");
  btn.disabled      = true;
  spinner.classList.remove("hidden");
  label.textContent = "Saving…";

  try {
    let confidence = 1.0;
    if (!category && !state.isIncome) {
      const r    = await fetch("/api/classify", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ name: merchant, ...getCentroids() }),
      });
      const data = await r.json();
      category   = data.prediction || "Others";
      confidence = data.confidence || 0;
    } else if (!category && state.isIncome) {
      category = "Other Income";
    }

    if (!state.isIncome) {
      fetch("/api/learn", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          merchant,
          category,
          original_category: state.originalCategory || "",
          ...getCentroids(),
        }),
      }).then(r => r.json()).then(d => { if (d.centroids) saveCentroids(d.centroids); }).catch(() => {});
    }

    const expense = {
      id:             generateId(),
      date:           date_val,
      merchant,
      amount:         Math.round(parseFloat(amount) * 100) / 100,
      currency,
      rate:           storedRate,
      category,
      confidence,
      payment_method,
      notes,
      location,
      items:          (state.isReceipt || state.isVoice) ? state.receiptItems : [],
      source:         state.isReceipt ? "receipt" : state.isVoice ? "voice" : "manual",
      type:           state.isIncome ? "income" : "expense",
      created_at:     new Date().toISOString(),
    };

    const expenses = getExpenses();
    expenses.push(expense);
    saveExpenses(expenses);
    state.expenseMap[expense.id] = expense;

    showToast(state.isIncome ? "Income saved!" : "Expense saved!");
    btn.disabled = false;
    spinner.classList.add("hidden");
    if (state.currentPendingScanId) {
      savePendingScans(getPendingScans().filter(s => s.id !== state.currentPendingScanId));
      delete _pendingScansFiles[state.currentPendingScanId];
      delete _pendingScansAborts[state.currentPendingScanId];
      state.currentPendingScanId = null;
    }
    clearScan();
    resetForm();
    showView("home");
  } catch (e) {
    showToast("Error: " + e.message, true);
    label.textContent = state.isReceipt ? "Confirm & Save" : state.isIncome ? "Add Income" : "Add Expense";
    btn.disabled      = false;
    spinner.classList.add("hidden");
  }
}

// ── History ───────────────────────────────────────────────────────────────────
let _historySorted      = [];
let _historySelCats     = new Set();
let _historySelPayments = new Set();
let _historySelTime     = null;
let _historySelType     = null;
let _histViewMode       = 'list';
let _calYear            = new Date().getFullYear();
let _calMonth           = new Date().getMonth();

const HISTORY_TIME_OPTS = [
  { key: 'today',      label: 'Today' },
  { key: 'week',       label: 'This week' },
  { key: 'month',      label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: '3months',    label: 'Last 3 months' },
  { key: 'year',       label: 'This year' },
];

async function loadHistory() {
  await loadRates();
  const expenses = getExpenses();
  expenses.forEach(e => { state.expenseMap[e.id] = e; });
  _historySorted = expenses.slice().sort((a, b) => {
    const ka = (a.date || '') + (a.created_at || '');
    const kb = (b.date || '') + (b.created_at || '');
    return kb > ka ? 1 : -1;
  });
  updateHistoryFilterBadge();
  filterHistory();
}

function openHistoryFilters() {
  renderHistoryFilterSheet();
  document.getElementById('history-filter-overlay').classList.remove('hidden');
}

function closeHistoryFilters() {
  document.getElementById('history-filter-overlay').classList.add('hidden');
}

function clearHistoryFilters() {
  _historySelCats.clear();
  _historySelPayments.clear();
  _historySelTime = null;
  _historySelType = null;
  renderHistoryFilterSheet();
  updateHistoryFilterBadge();
  filterHistory();
}

function renderHistoryFilterSheet() {
  _renderHFChips('hf-cat',
    ['All', ...[...new Set(_historySorted.map(e => e.category).filter(Boolean))].sort()],
    cat => cat === 'All' ? _historySelCats.size === 0 : _historySelCats.has(cat),
    cat => cat === 'All' ? '#006b55' : catColor(cat),
    cat => `selectHistoryCat('${esc(cat)}')`,
    cat => cat === 'All' ? 'All' : catEmoji(cat) + ' ' + esc(cat)
  );

  const methods = [...new Set(_historySorted.map(e => e.payment_method).filter(Boolean))].sort();
  const pmSection = document.getElementById('hf-payment')?.closest('div.mb-4');
  if (pmSection) pmSection.style.display = methods.length ? '' : 'none';
  _renderHFChips('hf-payment',
    ['All', ...methods],
    m => m === 'All' ? _historySelPayments.size === 0 : _historySelPayments.has(m),
    () => '#006b55',
    m => `selectHistoryPayment('${esc(m)}')`,
    m => m === 'All' ? 'All' : paymentIcon(m) + ' ' + esc(m)
  );

  _renderHFChips('hf-time',
    ['All', ...HISTORY_TIME_OPTS.map(o => o.key)],
    k => k === 'All' ? !_historySelTime : _historySelTime === k,
    () => '#006b55',
    k => `selectHistoryTime('${k}')`,
    k => k === 'All' ? 'All' : HISTORY_TIME_OPTS.find(o => o.key === k)?.label || k
  );

  _renderHFChips('hf-type',
    ['All', 'expense', 'income'],
    k => k === 'All' ? !_historySelType : _historySelType === k,
    k => k === 'income' ? '#16a34a' : '#006b55',
    k => `selectHistoryType('${k}')`,
    k => k === 'All' ? 'All' : k === 'income' ? '📥 Income' : '📤 Expenses'
  );
}

function _renderHFChips(elId, items, isActiveFn, colorFn, onclickFn, labelFn) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = items.map(item => {
    const isActive = isActiveFn(item);
    const col      = colorFn(item);
    const bg       = isActive ? col : (isDark() ? '#1e1e1e' : '#f8f9fa');
    const text     = isActive ? 'white' : (isDark() ? '#b0b0b0' : '#44474a');
    const border   = isActive ? col : (isDark() ? '#333333' : '#e8e9ea');
    return `<button type="button" onclick="${onclickFn(item)}"
      class="px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all"
      style="background:${bg};color:${text};border-color:${border}">
      ${labelFn(item)}
    </button>`;
  }).join('');
}

function updateHistoryFilterBadge() {
  const count = _historySelCats.size + _historySelPayments.size + (_historySelTime ? 1 : 0) + (_historySelType ? 1 : 0);
  const badge = document.getElementById('history-filter-badge');
  const btn   = document.getElementById('history-filter-btn');
  if (!badge || !btn) return;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
    btn.style.borderColor = '#006b55';
  } else {
    badge.classList.add('hidden');
    btn.style.borderColor = '';
  }
}

function selectHistoryCat(cat) {
  if (cat === 'All') {
    _historySelCats.clear();
  } else if (_historySelCats.has(cat)) {
    _historySelCats.delete(cat);
  } else {
    _historySelCats.add(cat);
  }
  renderHistoryFilterSheet();
  updateHistoryFilterBadge();
  filterHistory();
}

function selectHistoryPayment(method) {
  if (method === 'All') {
    _historySelPayments.clear();
  } else if (_historySelPayments.has(method)) {
    _historySelPayments.delete(method);
  } else {
    _historySelPayments.add(method);
  }
  renderHistoryFilterSheet();
  updateHistoryFilterBadge();
  filterHistory();
}

function selectHistoryTime(key) {
  _historySelTime = (key === 'All' || _historySelTime === key) ? null : key;
  renderHistoryFilterSheet();
  updateHistoryFilterBadge();
  filterHistory();
}

function selectHistoryType(key) {
  _historySelType = (key === 'All' || _historySelType === key) ? null : key;
  renderHistoryFilterSheet();
  updateHistoryFilterBadge();
  filterHistory();
}

function renderHistoryCatFilters() {}   // kept so any stale references don't throw
function renderHistoryPaymentFilters() {}

function filterHistory() {
  const query = (document.getElementById('history-search')?.value || '').trim().toLowerCase();

  let filtered = _historySorted;
  if (_historySelCats.size > 0) {
    filtered = filtered.filter(e => _historySelCats.has(e.category));
  }
  if (_historySelPayments.size > 0) {
    filtered = filtered.filter(e => _historySelPayments.has(e.payment_method));
  }
  if (_historySelTime) {
    const today      = new Date().toISOString().split('T')[0];
    const todayDate  = new Date(today);
    const dow        = todayDate.getDay();
    const monOffset  = dow === 0 ? 6 : dow - 1;
    const weekStart  = new Date(todayDate - monOffset * 86400000).toISOString().split('T')[0];
    const monthStart = today.slice(0, 7) + '-01';
    const lmDate     = new Date(todayDate); lmDate.setDate(1); lmDate.setMonth(lmDate.getMonth() - 1);
    const lmStart    = lmDate.toISOString().slice(0, 7) + '-01';
    const lmEnd      = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0).toISOString().split('T')[0];
    const m3Date     = new Date(todayDate); m3Date.setMonth(m3Date.getMonth() - 3);
    const m3Start    = m3Date.toISOString().split('T')[0];
    const yearStart  = today.slice(0, 4) + '-01-01';

    filtered = filtered.filter(e => {
      const d = e.date || '';
      if (_historySelTime === 'today')      return d === today;
      if (_historySelTime === 'week')       return d >= weekStart && d <= today;
      if (_historySelTime === 'month')      return d >= monthStart && d <= today;
      if (_historySelTime === 'last_month') return d >= lmStart && d <= lmEnd;
      if (_historySelTime === '3months')    return d >= m3Start && d <= today;
      if (_historySelTime === 'year')       return d >= yearStart && d <= today;
      return true;
    });
  }
  if (_historySelType) {
    if (_historySelType === 'income') {
      filtered = filtered.filter(e => isIncomeEntry(e));
    } else {
      filtered = filtered.filter(e => isExpenseEntry(e));
    }
  }
  if (query) {
    filtered = filtered.filter(e =>
      (e.merchant || '').toLowerCase().includes(query) ||
      (e.notes    || '').toLowerCase().includes(query) ||
      (e.items || []).some(i => (i.name || '').toLowerCase().includes(query))
    );
  }
  renderHistory(filtered);
}

function renderHistory(exps) {
  const listEl = document.getElementById("history-list");

  if (!exps || exps.length === 0) {
    listEl.innerHTML = `<div class="text-center text-gray-300 py-8">No transactions yet</div>`;
    return;
  }

  const defCur  = localStorage.getItem("defaultCurrency") || "EUR";
  const grouped = {};
  for (const exp of exps) {
    const d = exp.date || "Unknown";
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(exp);
  }
  const dates = Object.keys(grouped).sort().reverse();

  listEl.innerHTML = dates.map(d => {
    const dayExpenses = grouped[d].filter(isExpenseEntry).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
    const dayIncomes  = grouped[d].filter(isIncomeEntry).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
    const dayLabel    = dayIncomes > 0 && dayExpenses > 0
      ? `↑${fmtAmount(dayIncomes, defCur)} ↓${fmtAmount(dayExpenses, defCur)}`
      : dayIncomes > 0 ? `+${fmtAmount(dayIncomes, defCur)}` : fmtAmount(dayExpenses, defCur);
    const cards = grouped[d].map(exp => historyExpenseCard(exp)).join("");
    return `
      <div>
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-bold text-gray-600">${fmtDateLabel(d)}</span>
          <span class="text-sm font-semibold text-gray-400">${dayLabel}</span>
        </div>
        <div class="space-y-2">${cards}</div>
      </div>`;
  }).join("");
}

function historyExpenseCard(exp) {
  const income = isIncomeEntry(exp);
  const col    = txnColor(exp);
  const em     = txnEmoji(exp);
  const badge  = income
    ? `<span class="text-[9px] px-1 py-0.5 rounded font-bold ml-1 bg-green-100 text-green-700">+ income</span>`
    : exp.source === "receipt"
    ? `<span class="text-[9px] px-1 py-0.5 rounded font-bold ml-1" style="background:${isDark()?"#1e1e1e":"#f0fdf9"};color:${isDark()?"#6dfad2":"#006b55"}">📷</span>`
    : exp.source === "voice"
    ? `<span class="text-[9px] bg-rose-100 text-rose-500 px-1 py-0.5 rounded font-bold ml-1">🎤</span>`
    : "";
  const notes  = exp.notes
    ? `<span class="text-gray-400 text-xs truncate ml-1">· ${esc(exp.notes)}</span>` : "";
  const defCur = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  const isDiff = state.rates && exp.currency && exp.currency.toUpperCase() !== defCur;
  const cvt    = isDiff
    ? `<div class="text-[9px] text-gray-400">≈ ${fmtAmount(convertToDefault(exp.amount, exp.currency, exp.rate), defCur)}</div>` : "";
  const amtColor = income ? (isDark() ? "#4ade80" : "#16a34a") : (isDark() ? "#f5f5f5" : "#111827");
  const amtPrefix = income ? "+" : "";
  return `
    <div onclick="showExpenseDetail('${exp.id}')"
         class="bg-white rounded-xl p-3 flex items-center gap-3 shadow-sm border ${income ? "border-green-100" : "border-gray-100"} cursor-pointer active:opacity-75 transition-opacity">
      <div class="w-10 h-10 rounded-xl flex items-center justify-center text-base flex-shrink-0"
           style="background:${catBg(col)}">${em}</div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center">
          <span class="font-semibold text-gray-900 text-sm truncate">${esc(exp.merchant)}</span>${badge}
        </div>
        <div class="flex items-center mt-0.5">
          <span class="text-[10px] px-1.5 py-0.5 rounded-full text-white font-semibold" style="background:${col}">${esc(exp.category)}</span>${notes}
        </div>
      </div>
      <div class="text-right flex-shrink-0">
        <div class="font-bold text-sm" style="color:${amtColor}">${amtPrefix}${fmtAmount(exp.amount, exp.currency)}</div>
        ${cvt}
        <button onclick="event.stopPropagation(); deleteExpense('${exp.id}')"
                class="text-[10px] text-red-400 hover:text-red-600 mt-0.5 font-medium">Delete</button>
      </div>
    </div>`;
}

function deleteExpense(id) {
  if (!confirm("Delete this expense?")) return;
  const expenses = getExpenses().filter(e => e.id !== id);
  saveExpenses(expenses);
  delete state.expenseMap[id];
  showToast("Expense deleted");
  loadHistory();
  loadHome();
}

// ── History Calendar View ────────────────────────────────────────────────────
function _resetHistToListMode() {
  _histViewMode = 'list';
  document.getElementById('history-list-controls')?.classList.remove('hidden');
  document.getElementById('history-cal-controls')?.classList.add('hidden');
  document.getElementById('history-list')?.classList.remove('hidden');
  document.getElementById('history-calendar')?.classList.add('hidden');
  document.getElementById('hist-cal-icon')?.classList.remove('hidden');
  document.getElementById('hist-list-icon')?.classList.add('hidden');
}

function toggleHistViewMode() {
  _histViewMode = _histViewMode === 'list' ? 'calendar' : 'list';
  const isCal = _histViewMode === 'calendar';

  document.getElementById('history-list-controls').classList.toggle('hidden', isCal);
  document.getElementById('history-cal-controls').classList.toggle('hidden', !isCal);
  document.getElementById('history-list').classList.toggle('hidden', isCal);
  document.getElementById('history-calendar').classList.toggle('hidden', !isCal);
  document.getElementById('hist-cal-icon').classList.toggle('hidden', isCal);
  document.getElementById('hist-list-icon').classList.toggle('hidden', !isCal);

  if (isCal) {
    const now = new Date();
    _calYear  = now.getFullYear();
    _calMonth = now.getMonth();
    renderCalendar();
  }
}

function calNavMonth(delta) {
  _calMonth += delta;
  if (_calMonth > 11) { _calMonth = 0; _calYear++; }
  if (_calMonth < 0)  { _calMonth = 11; _calYear--; }
  document.getElementById('history-day-detail').innerHTML = '';
  renderCalendar();
}

function renderCalendar() {
  const defCur   = (localStorage.getItem('defaultCurrency') || 'EUR').toUpperCase();
  const monthStr = `${_calYear}-${String(_calMonth + 1).padStart(2, '0')}`;
  const today    = new Date().toISOString().split('T')[0];

  document.getElementById('cal-month-label').textContent =
    new Date(_calYear, _calMonth, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Aggregate daily totals for this month
  const dayTotals = {};
  for (const e of _historySorted) {
    if (!(e.date || '').startsWith(monthStr)) continue;
    if (!dayTotals[e.date]) dayTotals[e.date] = { expense: 0, income: 0 };
    const amt = convertToDefault(e.amount, e.currency, e.rate);
    if (isIncomeEntry(e)) dayTotals[e.date].income += amt;
    else                  dayTotals[e.date].expense += amt;
  }

  const daysInMonth = new Date(_calYear, _calMonth + 1, 0).getDate();
  // Monday-first offset: JS getDay() 0=Sun..6=Sat → Mon=0 offset = (getDay()+6)%7
  const startOffset = (new Date(_calYear, _calMonth, 1).getDay() + 6) % 7;

  const weekdays = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  let html = `<div class="grid grid-cols-7 gap-1 text-center mb-1.5">
    ${weekdays.map(w => `<div class="text-[10px] font-bold text-[#44474a] py-0.5">${w}</div>`).join('')}
  </div>
  <div class="grid grid-cols-7 gap-1">`;

  for (let i = 0; i < startOffset; i++) html += '<div></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${monthStr}-${String(day).padStart(2, '0')}`;
    const isToday = dateStr === today;
    const totals  = dayTotals[dateStr];
    const hasData = !!totals;

    const base = 'rounded-xl p-1 text-center cursor-pointer flex flex-col items-center justify-start pt-1.5 transition-colors';
    let bg, dayNumCls;
    if (isToday) {
      bg = 'bg-[#006b55]';
      dayNumCls = 'text-white';
    } else if (hasData) {
      bg = 'bg-white border border-[#e8e9ea] active:border-[#006b55]';
      dayNumCls = 'text-[#191c1d]';
    } else {
      bg = 'bg-[#f8f9fa]';
      dayNumCls = 'text-[#c5c6ca]';
    }

    let amtHtml = '';
    if (totals?.expense > 0) {
      const cls = isToday ? 'text-white opacity-80' : 'text-[#191c1d]';
      amtHtml += `<div class="text-[8px] font-bold ${cls} leading-tight mt-0.5">${fmtAmount(totals.expense, defCur)}</div>`;
    }
    if (totals?.income > 0) {
      const cls = isToday ? 'text-green-200' : 'text-green-600';
      amtHtml += `<div class="text-[8px] font-bold ${cls} leading-tight mt-0.5">+${fmtAmount(totals.income, defCur)}</div>`;
    }

    html += `<div class="${base} ${bg}" style="min-height:52px" onclick="calSelectDay('${dateStr}')">
      <div class="text-xs font-bold ${dayNumCls}">${day}</div>
      ${amtHtml}
    </div>`;
  }

  html += '</div>';
  document.getElementById('cal-grid').innerHTML = html;
}

function calSelectDay(dateStr) {
  const detailEl  = document.getElementById('history-day-detail');
  const dayEntries = _historySorted.filter(e => e.date === dateStr);

  if (!dayEntries.length) {
    detailEl.innerHTML = `<div class="text-center text-[#c5c6ca] py-4 text-sm mt-4 border-t border-[#e8e9ea] pt-4">No transactions on this day</div>`;
    return;
  }

  const label = new Date(dateStr + 'T12:00:00')
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  detailEl.innerHTML = `
    <div class="mt-4 border-t border-[#e8e9ea] pt-4">
      <div class="text-sm font-bold text-[#191c1d] mb-3">${label}</div>
      <div class="space-y-2">${dayEntries.map(e => historyExpenseCard(e)).join('')}</div>
    </div>`;
}

// ── Expense Detail Sheet ──────────────────────────────────────────────────────
function showExpenseDetail(id) {
  state.currentEditId = id;
  const exp = state.expenseMap[id];
  if (!exp) return;
  _renderDetailView(exp);
  document.getElementById("det-view-mode").classList.remove("hidden");
  document.getElementById("det-edit-mode").classList.add("hidden");
  document.getElementById("detail-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function _renderDetailView(exp) {
  const income = isIncomeEntry(exp);
  const col    = txnColor(exp);
  const em     = txnEmoji(exp);

  document.getElementById("det-badge").textContent      = `${em} ${exp.category}`;
  document.getElementById("det-badge").style.background = col;
  document.getElementById("det-merchant").textContent   = exp.merchant;
  const amtEl = document.getElementById("det-amount");
  amtEl.textContent  = (income ? "+" : "") + fmtAmount(exp.amount, exp.currency);
  amtEl.style.color  = income ? "#16a34a" : "";
  document.getElementById("det-date").textContent       = fmtDateLabel(exp.date);

  const paymentRow = document.getElementById("det-payment-row");
  if (exp.payment_method) {
    paymentRow.classList.remove("hidden");
    document.getElementById("det-payment-icon").textContent = paymentIcon(exp.payment_method);
    document.getElementById("det-payment").textContent      = exp.payment_method;
  } else {
    paymentRow.classList.add("hidden");
  }

  const notesRow = document.getElementById("det-notes-row");
  if (exp.notes) {
    notesRow.classList.remove("hidden");
    document.getElementById("det-notes").textContent = exp.notes;
  } else {
    notesRow.classList.add("hidden");
  }

  const locationRow = document.getElementById("det-location-row");
  if (exp.location) {
    locationRow.classList.remove("hidden");
    document.getElementById("det-location").textContent = exp.location;
  } else {
    locationRow.classList.add("hidden");
  }

  const isReceipt = exp.source === "receipt";
  document.getElementById("det-source-icon").textContent = isReceipt ? "📷" : "💳";
  document.getElementById("det-source").textContent      = isReceipt ? "Scanned receipt" : "Manual entry";

  const itemsSect = document.getElementById("det-items-section");
  if (exp.items && exp.items.length > 0) {
    itemsSect.classList.remove("hidden");
    document.getElementById("det-items-list").innerHTML = exp.items.map(item => {
      const qty   = (item.quantity ?? 1) > 1 ? `<span class="text-[#44474a] mr-1">×${item.quantity}</span>` : "";
      const price = item.price != null
        ? `<span class="font-semibold">${fmtAmount(item.price, exp.currency)}</span>` : "";
      return `<div class="flex items-center justify-between py-0.5 border-b border-gray-100 last:border-0">
        <span class="truncate mr-2">${qty}${esc(item.name || "")}</span>${price}</div>`;
    }).join("");
  } else {
    itemsSect.classList.add("hidden");
  }

  document.getElementById("det-delete-btn").onclick = () => {
    closeDetail();
    deleteExpense(exp.id);
  };
}

function closeDetail() {
  document.getElementById("detail-overlay").classList.add("hidden");
  document.body.style.overflow = "";
}

// ── Edit mode ─────────────────────────────────────────────────────────────────
function openEdit() {
  const exp = state.expenseMap[state.currentEditId];
  if (!exp) return;

  const cur    = exp.currency || "EUR";
  const defCur = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  document.getElementById("edit-merchant").value       = exp.merchant || "";
  document.getElementById("edit-amount").value         = exp.amount != null ? Number(exp.amount).toFixed(2) : "";
  populateCurrencySelect("edit-currency", cur);
  document.getElementById("edit-cur-sym").textContent  = curSym(cur);
  document.getElementById("edit-date").value           = exp.date || "";
  document.getElementById("edit-notes").value          = exp.notes || "";
  document.getElementById("edit-location").value       = exp.location || "";
  updateRateRow("edit", cur, defCur, exp.rate ?? null);

  const editIncome = isIncomeEntry(exp);
  const titleEl    = document.getElementById("edit-mode-title");
  const mLabelEl   = document.getElementById("edit-merchant-label");
  const locWrapEl  = document.getElementById("edit-location-wrap");
  if (titleEl)   titleEl.textContent  = editIncome ? "Edit Income"  : "Edit Expense";
  if (mLabelEl)  mLabelEl.textContent = editIncome ? "Source"       : "Merchant";
  if (locWrapEl) locWrapEl.classList.toggle("hidden", editIncome);

  state.editCategory = exp.category || null;
  if (editIncome) {
    renderEditIncomeCatButtons(state.editCategory);
  } else {
    renderEditCatButtons(state.editCategory);
  }

  state.editPayment = exp.payment_method || null;
  renderPaymentButtons(state.editPayment, "edit-payment-buttons");

  state.editItems = (exp.items || []).map(i => ({ name: i.name || "", price: i.price ?? null, quantity: i.quantity ?? 1 }));
  renderEditItems();

  document.getElementById("det-view-mode").classList.add("hidden");
  document.getElementById("det-edit-mode").classList.remove("hidden");
  document.getElementById("detail-sheet").scrollTop = 0;
}

function updateEditCurrencyRate(fromCode) {
  const defCur = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  document.getElementById("edit-cur-sym").textContent = curSym(fromCode);
  updateRateRow("edit", fromCode, defCur, null);
}

function cancelEdit() {
  document.getElementById("det-edit-mode").classList.add("hidden");
  document.getElementById("det-view-mode").classList.remove("hidden");
  document.getElementById("detail-sheet").scrollTop = 0;
}

function renderEditCatButtons(selected) {
  const el = document.getElementById("edit-cat-buttons");
  el.innerHTML = state.categories.map(cat => {
    const col      = catColor(cat);
    const isChosen = cat === selected;
    return `
      <button type="button" onclick="selectEditCategory('${esc(cat)}')"
              class="cat-chip px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white transition-all ${isChosen ? "selected" : "opacity-60"}"
              style="background:${col}">
        ${catEmoji(cat)} ${esc(cat)}
      </button>`;
  }).join("");
  state.editCategory = selected;
}

function selectEditCategory(cat) { renderEditCatButtons(cat); }

function renderEditIncomeCatButtons(selected) {
  const el = document.getElementById("edit-cat-buttons");
  if (!el) return;
  el.innerHTML = getAllIncomeCategories().map(cat => {
    const col = incomeCatColor(cat);
    const isChosen = cat === selected;
    return `<button type="button" onclick="selectEditIncomeCategory('${esc(cat)}')"
              class="cat-chip px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white transition-all ${isChosen ? 'selected' : 'opacity-60'}"
              style="background:${col}">
        ${incomeCatEmoji(cat)} ${esc(cat)}
      </button>`;
  }).join('');
  state.editCategory = selected;
}

function selectEditIncomeCategory(cat) { renderEditIncomeCatButtons(cat); }

function renderEditItems() {
  const el = document.getElementById("edit-items-list");
  if (!state.editItems || state.editItems.length === 0) {
    el.innerHTML = `<div class="text-xs text-gray-400 text-center py-2 border border-dashed border-gray-200 rounded-xl">No items — tap "+ Add item" to add one</div>`;
    return;
  }
  el.innerHTML = state.editItems.map((item, idx) => `
    <div class="flex items-center gap-2">
      <input type="text" value="${esc(item.name)}" placeholder="Item name"
             oninput="state.editItems[${idx}].name = this.value"
             class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white min-w-0" />
      <input type="number" value="${item.quantity != null ? item.quantity : 1}" placeholder="1" min="1" step="1"
             oninput="state.editItems[${idx}].quantity = this.value === '' ? 1 : parseInt(this.value)"
             class="w-12 px-2 py-2 border border-gray-200 rounded-lg text-xs text-center focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white flex-shrink-0" />
      <input type="number" value="${item.price ?? ""}" placeholder="0.00" step="0.01"
             oninput="state.editItems[${idx}].price = this.value === '' ? null : parseFloat(this.value)"
             class="w-20 px-2 py-2 border border-gray-200 rounded-lg text-xs text-center focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white flex-shrink-0" />
      <button type="button" onclick="removeEditItem(${idx})"
              class="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 text-gray-400 hover:bg-red-100 hover:text-red-500 flex-shrink-0 transition-colors text-sm">✕</button>
    </div>`).join("");
}

function addEditItem() {
  state.editItems.push({ name: "", price: null, quantity: 1 });
  renderEditItems();
  setTimeout(() => {
    const inputs = document.querySelectorAll("#edit-items-list input[type=text]");
    if (inputs.length) inputs[inputs.length - 1].focus();
  }, 50);
}

function removeEditItem(idx) {
  state.editItems.splice(idx, 1);
  renderEditItems();
}

async function saveEdit() {
  const id = state.currentEditId;
  if (!id) return;

  const merchant       = document.getElementById("edit-merchant").value.trim();
  const amount         = document.getElementById("edit-amount").value;
  const currency       = document.getElementById("edit-currency").value.trim().toUpperCase() || "EUR";
  const date_val       = document.getElementById("edit-date").value;
  const notes          = document.getElementById("edit-notes").value.trim();
  const location       = document.getElementById("edit-location").value.trim();
  const category       = state.editCategory;
  const payment_method = state.editPayment || "";
  const defCurE        = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  const rateRawE       = parseFloat(document.getElementById("edit-rate")?.value);
  const storedRateE    = currency !== defCurE && !isNaN(rateRawE) && rateRawE > 0 ? rateRawE : null;

  if (!merchant)                            { showToast("Merchant name is required", true); return; }
  if (!amount || isNaN(parseFloat(amount))) { showToast("Please enter a valid amount", true); return; }

  const label   = document.getElementById("edit-save-label");
  const spinner = document.getElementById("edit-save-spinner");
  label.textContent = "Saving…";
  spinner.classList.remove("hidden");

  const items = state.editItems
    .filter(i => i.name.trim() !== "")
    .map(i => ({ name: i.name.trim(), price: i.price, quantity: i.quantity ?? 1 }));

  try {
    const oldExp     = state.expenseMap[id];
    const oldCat     = oldExp ? oldExp.category : "";
    const editIncome = isIncomeEntry(oldExp);

    if (!editIncome && category && category !== oldCat) {
      fetch("/api/learn", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ merchant, category, original_category: oldCat, ...getCentroids() }),
      }).then(r => r.json()).then(d => { if (d.centroids) saveCentroids(d.centroids); }).catch(() => {});
    }

    const updatedExp = {
      ...(oldExp || {}),
      merchant,
      amount:         Math.round(parseFloat(amount) * 100) / 100,
      currency,
      rate:           storedRateE,
      date:           date_val,
      category:       category || oldCat,
      notes,
      location,
      payment_method,
      items,
      type:           oldExp?.type || 'expense',
      updated_at:     new Date().toISOString(),
    };

    const expenses = getExpenses().map(e => e.id === id ? updatedExp : e);
    saveExpenses(expenses);
    state.expenseMap[id] = updatedExp;

    cancelEdit();
    _renderDetailView(updatedExp);
    showToast("Changes saved!");
    loadHistory();
    loadHome();
  } catch (e) {
    showToast("Error: " + e.message, true);
  } finally {
    label.textContent = "Save Changes";
    spinner.classList.add("hidden");
  }
}

// ── Summary vector helpers ────────────────────────────────────────────────────
function _categoryList() {
  const centroids = getCentroids();
  return centroids ? Object.keys(centroids) : [];
}

function _makeNumericalVector(spending) {
  const cats   = _categoryList();
  const vec    = cats.map(cat => spending[cat] || 0);
  const norm   = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vec : vec.map(v => v / norm);
}

function _projectToFullMonth(spending, daysElapsed, daysInMonth) {
  const scale = daysInMonth / daysElapsed;
  return Object.fromEntries(Object.entries(spending).map(([cat, amt]) => [cat, amt * scale]));
}

function retrieveSimilarSummaries(spending, daysElapsed, daysInMonth, nResults = 2) {
  const summaries = getSummaries();
  if (!summaries.length) return [];

  const projected  = _projectToFullMonth(spending, daysElapsed, daysInMonth);
  const queryVec   = _makeNumericalVector(projected);

  const scored = summaries.map(s => {
    const storedVec = _makeNumericalVector(s.spending);
    const dot       = queryVec.reduce((sum, v, i) => sum + v * storedVec[i], 0);
    return { ...s, score: dot };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, nResults)
    .map(({ period, text }) => ({ period, text }));
}

// ── Summary (charts) ──────────────────────────────────────────────────────────
async function loadSummary() {
  await loadRates();
  const data   = computeSummary();
  const defCur = localStorage.getItem("defaultCurrency") || "EUR";
  document.getElementById("sum-month").textContent = fmtAmount(data.month_total, defCur);
  document.getElementById("sum-today").textContent = fmtAmount(data.today_total, defCur);
  renderPieChart(data.category_breakdown, defCur);
  renderBarChart(data.daily_chart, defCur);
  loadAiOverview(data.category_breakdown, defCur);
}

async function loadAiOverview(breakdown, defCur) {
  const el = document.getElementById("ai-overview-text");
  if (!el) return;

  let envKeySet = false;
  try {
    const s = await (await fetch("/api/settings")).json();
    envKeySet = !!s.env_key_set;
  } catch { /* ignore — treated as no server key */ }

  if (!envKeySet) {
    el.textContent = "AI insights require Vertex AI to be configured on the server.";
    document.getElementById("ai-overview-card").classList.remove("hidden");
    return;
  }
  if (!Object.keys(breakdown).length) {
    el.textContent = "Start adding your expenses for the month to get an overview"
    return;
  }

  document.getElementById("ai-overview-card").classList.remove("hidden");
  el.innerHTML = `<span class="text-gray-400 animate-pulse">Generating insight…</span>`;

  const today         = new Date();
  const daysElapsed   = today.getDate();
  const daysInMonth   = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const spendingJson  = JSON.stringify(breakdown);

  try {
    const retrieved = retrieveSimilarSummaries(breakdown, daysElapsed, daysInMonth);

    const params = new URLSearchParams({
      spending_json:  spendingJson,
      days_elapsed:   daysElapsed,
      days_in_month:  daysInMonth,
      retrieved_json: JSON.stringify(retrieved),
    });

    const r = await fetch(`/api/summary/overview?${params}`);
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || "Unknown error");

    el.textContent = data.overview;

    // Show which months it compared against, if any
    const basedOnEl = document.getElementById("ai-overview-based-on");
    if (basedOnEl) {
      basedOnEl.textContent = retrieved.length
        ? `Compared to: ${retrieved.map(s => s.period).join(", ")}`
        : "No historical data yet — keep tracking to unlock comparisons!";
    }
  } catch (e) {
    el.textContent = "Couldn't load insight: " + e.message;
  }
}

async function archiveCurrentMonth() {
  const data    = computeSummary();
  const defCur  = localStorage.getItem("defaultCurrency") || "EUR";
  const now     = new Date();
  const period  = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  if (!Object.keys(data.category_breakdown).length) {
    showToast("No spending data to archive.", true);
    return;
  }

  // Build the plain-text summary the vector store will hold
  const items      = Object.entries(data.category_breakdown)
    .map(([cat, amt]) => `${cat} ${fmtAmount(amt, defCur)}`).join(", ");
  const summaryText = `${period}: ${items}. Total ${fmtAmount(data.month_total, defCur)}.`;

  showConfirm({
    title:   `Archive ${period}?`,
    message: `This saves your spending summary so future months can be compared against it.\n\n"${summaryText}"`,
    okLabel: "Archive",
    okColor: "bg-indigo-600 hover:bg-indigo-700",
    onOk: () => {
      try {
        upsertSummary(period, summaryText, data.category_breakdown);
        showToast(`${period} archived!`);
      } catch (e) {
        showToast("Archive failed: " + e.message, true);
      }
    },
  });
}

function renderPieChart(breakdown, defCur = "EUR") {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const wrap    = document.getElementById("pie-wrap");

  if (pieChartInst) { pieChartInst.destroy(); pieChartInst = null; }

  if (entries.length === 0) {
    wrap.innerHTML = `<div class="text-sm text-gray-300 text-center py-8">No spending this month</div>`;
    return;
  }
  if (!wrap.querySelector("canvas")) {
    wrap.innerHTML = `<canvas id="pie-chart"></canvas>`;
  }

  const dark = isDark();
  const ctx  = document.getElementById("pie-chart").getContext("2d");
  const total = entries.reduce((s, [, v]) => s + v, 0);

  pieChartInst = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels:   entries.map(([cat]) => `${catEmoji(cat)} ${cat}`),
      datasets: [{
        data:            entries.map(([, amt]) => amt),
        backgroundColor: entries.map(([cat]) => catColor(cat)),
        borderWidth:     2,
        borderColor:     dark ? "#141414" : "#ffffff",
        hoverOffset:     6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            font:            { size: 11 },
            color:           dark ? "#b0b0b0" : "#44474a",
            padding:         10,
            usePointStyle:   true,
            pointStyleWidth: 10,
          },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${fmtAmount(ctx.raw, defCur)} (${Math.round(ctx.raw / total * 100)}%)`,
          },
        },
      },
      cutout: "58%",
    },
  });
}

function renderBarChart(dailyData, defCur = "EUR") {
  if (lineChartInst) { lineChartInst.destroy(); lineChartInst = null; }

  const canvas = document.getElementById("line-chart");
  const ctx    = canvas.getContext("2d");
  const today  = new Date().toISOString().split("T")[0];
  const dark   = isDark();

  lineChartInst = new Chart(ctx, {
    type: "bar",
    data: {
      labels: dailyData.map(d => {
        const dt = new Date(d.date + "T12:00:00");
        return dt.toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
      }),
      datasets: [{
        label:           "Spending",
        data:            dailyData.map(d => d.total),
        backgroundColor: dailyData.map(d =>
          d.date === today ? "#006b55" : (dark ? "#6dfad235" : "#6dfad2")),
        borderRadius:    6,
        borderSkipped:   false,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => ` ${fmtAmount(ctx.raw)}` },
        },
      },
      scales: {
        x: {
          grid:  { display: false },
          ticks: { color: dark ? "#686868" : "#44474a", font: { size: 10 } },
        },
        y: {
          grid:  { color: dark ? "#222222" : "#edeeef" },
          ticks: {
            color:    dark ? "#686868" : "#44474a",
            font:     { size: 10 },
            callback: v => curSym(defCur) + v,
          },
          beginAtZero: true,
        },
      },
    },
  });
}

// ── Fetch with auto-retry on model overload ─────────────────────────────────────
// POSTs to a Gemini-backed endpoint and, if the model reports it is overloaded
// (HTTP 503 with { retryable: true }), shows a "high demand" message and resends
// the request automatically with exponential backoff. Returns the parsed JSON on
// success; throws on a non-retryable error or once retries are exhausted.
async function postWithOverloadRetry(url, body, { onRetry, maxRetries = 3, signal } = {}) {
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    const r    = await fetch(url, { method: "POST", body, signal });
    const resp = await r.json();
    if (r.ok && !resp.error) return resp;

    if (resp.retryable && attempt < maxRetries) {
      onRetry?.(attempt + 1, maxRetries);
      // Abortable sleep — bail out immediately if the request was cancelled.
      await new Promise((res, rej) => {
        const t = setTimeout(res, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
      delay *= 2;
      continue;
    }
    const err = new Error(resp.error || "Unknown error");
    err.retryable = resp.retryable;
    throw err;
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className   = `fixed top-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl shadow-xl text-sm font-semibold text-white text-center max-w-xs slide-up pointer-events-none ${isError ? "bg-red-600" : "bg-gray-900"}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "hidden"; }, 2800);
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettingsView() {
  let data = {};
  try {
    const r = await fetch("/api/settings");
    data = await r.json();
  } catch (e) { console.error("loadSettings:", e); }

  const storedCurrency = localStorage.getItem("defaultCurrency") || "EUR";
  populateCurrencySelect("s-currency", storedCurrency);
  renderCustomCurrenciesSettings();
  _refreshBudgetStatus();

  const rateEl  = document.getElementById("s-rates-date");
  const cached  = localStorage.getItem("flo_rates_" + storedCurrency);
  if (rateEl && cached) {
    try {
      const { data } = JSON.parse(cached);
      rateEl.textContent = `Exchange rates as of ${data.date} (ECB via frankfurter.app)`;
    } catch {}
  } else if (rateEl) {
    rateEl.textContent = "Exchange rates loaded on first view.";
  }
}

function showConfirm({ title, message, okLabel = "Confirm", okColor = "bg-red-600 hover:bg-red-700", onOk }) {
  document.getElementById("confirm-title").textContent   = title;
  document.getElementById("confirm-message").textContent = message;
  const okBtn = document.getElementById("confirm-ok");
  okBtn.textContent = okLabel;
  okBtn.className   = `py-2.5 rounded-xl text-sm font-semibold text-white transition-colors ${okColor}`;
  okBtn.onclick     = () => { confirmCancel(); onOk(); };
  document.getElementById("confirm-overlay").classList.remove("hidden");
}

function confirmCancel() {
  document.getElementById("confirm-overlay").classList.add("hidden");
}

async function resetCentroids() {
  showConfirm({
    title:   "Reset category model?",
    message: "This will replace your personalised model in this browser with the server's base model. This cannot be undone.",
    okLabel: "Reset",
    onOk: async () => {
      try {
        const r = await fetch("/api/base_centroids");
        if (!r.ok) throw new Error("Base model not available");
        saveCentroids(await r.json());
        showToast("Category model reset to base.");
      } catch (e) {
        showToast("Reset failed: " + e.message, true);
      }
    },
  });
}

function saveCurrency() {
  const currency = document.getElementById("s-currency").value;
  if (!currency) return;
  localStorage.setItem("defaultCurrency", currency);
  showToast("Currency saved.");
}

function saveBudgetLimit() {
  const val = parseFloat(document.getElementById("s-budget").value);
  if (!val || val <= 0) { showToast("Enter a valid budget amount", true); return; }
  saveBudget(val);
  document.getElementById("s-budget").value = "";
  _refreshBudgetStatus();
  showToast("Budget saved!");
  loadHome();
}

function clearBudgetLimit() {
  showConfirm({
    title:   "Clear monthly budget?",
    message: "The budget progress bar will be hidden from the home screen.",
    okLabel: "Clear",
    okColor: "bg-[#006b55] hover:bg-[#004d3f]",
    onOk: () => {
      clearBudget();
      _refreshBudgetStatus();
      loadHome();
      showToast("Budget cleared.");
    },
  });
}

function _refreshBudgetStatus() {
  const budget    = getBudget();
  const statusEl  = document.getElementById("s-budget-status");
  const clearBtn  = document.getElementById("s-budget-clear");
  const symEl     = document.getElementById("s-budget-sym");
  const defCur    = localStorage.getItem("defaultCurrency") || "EUR";
  if (symEl) symEl.textContent = curSym(defCur);
  if (budget && budget > 0) {
    if (statusEl) {
      statusEl.textContent = `Current budget: ${fmtAmount(budget, defCur)} / month`;
      statusEl.className   = "text-xs text-emerald-600 mt-1.5 font-medium";
    }
    clearBtn?.classList.remove("hidden");
  } else {
    if (statusEl) {
      statusEl.textContent = "No budget set — progress bar will be hidden.";
      statusEl.className   = "text-xs text-[#44474a] mt-1.5";
    }
    clearBtn?.classList.add("hidden");
  }
}

function loadOverrides() {
  const data    = getCentroids();
  const ovrs    = data?.overrides || {};
  const allCats = getAllCategories();
  const entries = Object.entries(ovrs).sort((a, b) => a[0].localeCompare(b[0]));

  const list = document.getElementById("overrides-list");
  list.innerHTML = entries.length
    ? entries.map(([merchant, cat]) => `
        <div class="flex items-center gap-3 px-4 py-3">
          <span class="flex-1 min-w-0 text-sm text-gray-700 font-medium truncate">${merchant}</span>
          <select onchange="updateOverride('${merchant.replace(/'/g, "\\'")}', this.value)"
                  class="px-2 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-[#006b55]">
            ${allCats.map(c => `<option value="${c}"${c === cat ? " selected" : ""}>${c}</option>`).join("")}
          </select>
          <button onclick="deleteOverride('${merchant.replace(/'/g, "\\'")}')"
                  class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm">✕</button>
        </div>`).join("")
    : `<div class="px-4 py-6 text-sm text-gray-400 text-center">No overrides yet.</div>`;

  const catSel = document.getElementById("new-override-category");
  catSel.innerHTML = allCats.map(c => `<option value="${c}">${c}</option>`).join("");
}

function loadCategoriesView() {
  const data    = getCentroids();
  const model   = new Set(Object.keys(data?.categories || {}));
  const custom  = new Set(data?.custom_categories || []);
  const all     = [...new Set([...model, ...custom])].sort();

  const list = document.getElementById("categories-list");
  list.innerHTML = all.length
    ? all.map(cat => {
        const isCustom = custom.has(cat) && !model.has(cat);
        const emoji    = catEmoji(cat);
        const tag     = isCustom
          ? `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style="color:${isDark()?"#6dfad2":"#006b55"};background:${isDark()?"#1e1e1e":"#f0fdf9"}">custom</span>`
          : `<span class="text-[10px] text-[#c5c6ca]">built-in</span>`;
        const emojiEl = `<input type="text" value="${esc(emoji)}"
                    title="Tap to change emoji"
                    class="w-9 h-9 text-center text-xl border border-transparent hover:border-[#c5c6ca] focus:border-[#006b55] rounded-xl p-0.5 bg-transparent focus:outline-none focus:bg-white cursor-pointer flex-shrink-0"
                    onchange="updateCategoryEmoji('${cat.replace(/'/g, "\\'")}', this.value)" />`;
        return `
          <div class="flex items-center gap-3 px-4 py-3">
            ${emojiEl}
            <span class="flex-1 min-w-0 text-sm text-gray-700 font-medium truncate">${esc(cat)}</span>
            ${tag}
            <button onclick="deleteCategory('${cat.replace(/'/g, "\\'")}')"
                    class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm">✕</button>
          </div>`;
      }).join("")
    : `<div class="px-4 py-6 text-sm text-gray-400 text-center">No categories yet.</div>`;
}

function updateCategoryEmoji(cat, newEmoji) {
  const emoji = (newEmoji || "").trim() || "📦";
  const data  = getCentroids();
  if (!data) return;
  data.custom_category_emojis      = data.custom_category_emojis || {};
  data.custom_category_emojis[cat] = emoji;
  saveCentroids(data);
  loadCategoriesIntoButtons();
  showToast("Emoji updated!");
}

function addCustomCategory() {
  const nameInput  = document.getElementById("new-category-name");
  const emojiInput = document.getElementById("new-category-emoji");
  const name  = nameInput.value.trim();
  const emoji = (emojiInput?.value || "").trim() || "📦";
  if (!name) return;
  const data = getCentroids();
  if (!data) { showToast("No model loaded yet.", true); return; }
  const existing = getAllCategories();
  if (existing.includes(name)) { showToast("Category already exists.", true); return; }
  data.custom_categories = data.custom_categories || [];
  data.custom_categories.push(name);
  data.custom_category_emojis = data.custom_category_emojis || {};
  data.custom_category_emojis[name] = emoji;
  saveCentroids(data);
  nameInput.value = "";
  if (emojiInput) emojiInput.value = "";
  loadCategoriesView();
  loadCategoriesIntoButtons();
  showToast(`"${emoji} ${name}" added.`);
}

function deleteCategory(name) {
  showConfirm({
    title:   `Delete "${name}"?`,
    message: "This removes the category and its trained data from your model. Expenses already tagged with it are not affected.",
    okLabel: "Delete",
    onOk: () => {
      const data = getCentroids();
      if (!data) return;
      data.custom_categories = (data.custom_categories || []).filter(c => c !== name);
      if (data.categories?.[name])             delete data.categories[name];
      if (data.custom_category_emojis?.[name]) delete data.custom_category_emojis[name];
      saveCentroids(data);
      loadCategoriesView();
      loadCategoriesIntoButtons();
    },
  });
}

function loadIncomeCategoriesSection() {
  const builtins = new Set(INCOME_CATEGORIES);
  const custom   = new Set(getCustomIncomeCategories());
  const all      = getAllIncomeCategories();

  const list = document.getElementById("income-categories-list");
  if (!list) return;
  list.innerHTML = all.length
    ? all.map(cat => {
        const isCustom = custom.has(cat) && !builtins.has(cat);
        const emoji    = incomeCatEmoji(cat);
        const tag      = isCustom
          ? `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style="color:${isDark()?"#6dfad2":"#006b55"};background:${isDark()?"#1e1e1e":"#f0fdf9"}">custom</span>`
          : `<span class="text-[10px] text-[#c5c6ca]">built-in</span>`;
        const emojiEl = `<input type="text" value="${esc(emoji)}"
                    title="Tap to change emoji"
                    class="w-9 h-9 text-center text-xl border border-transparent hover:border-[#c5c6ca] focus:border-[#006b55] rounded-xl p-0.5 bg-transparent focus:outline-none focus:bg-white cursor-pointer flex-shrink-0"
                    onchange="updateIncomeCategoryEmoji('${cat.replace(/'/g, "\\'")}', this.value)" />`;
        const delBtn = isCustom
          ? `<button onclick="deleteIncomeCategory('${cat.replace(/'/g, "\\'")}')"
                     class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm">✕</button>`
          : `<div class="w-7 h-7 flex-shrink-0"></div>`;
        return `
          <div class="flex items-center gap-3 px-4 py-3">
            ${emojiEl}
            <span class="flex-1 min-w-0 text-sm text-gray-700 font-medium truncate">${esc(cat)}</span>
            ${tag}
            ${delBtn}
          </div>`;
      }).join("")
    : `<div class="px-4 py-6 text-sm text-gray-400 text-center">No income categories.</div>`;
}

function updateIncomeCategoryEmoji(cat, newEmoji) {
  const emoji = (newEmoji || "").trim() || "💰";
  const map   = getIncomeEmojis();
  map[cat]    = emoji;
  saveIncomeEmojis(map);
  loadIncomeCategoriesSection();
  showToast("Emoji updated!");
}

function addCustomIncomeCategory() {
  const nameInput  = document.getElementById("new-income-category-name");
  const emojiInput = document.getElementById("new-income-category-emoji");
  const name  = nameInput.value.trim();
  const emoji = (emojiInput?.value || "").trim() || "💰";
  if (!name) return;
  const existing = getAllIncomeCategories();
  if (existing.map(c => c.toLowerCase()).includes(name.toLowerCase())) {
    showToast("Income category already exists.", true); return;
  }
  const list = getCustomIncomeCategories();
  list.push(name);
  saveCustomIncomeCategories(list);
  const map = getIncomeEmojis();
  map[name] = emoji;
  saveIncomeEmojis(map);
  nameInput.value = "";
  if (emojiInput) emojiInput.value = "";
  loadIncomeCategoriesSection();
  showToast(`"${emoji} ${name}" added.`);
}

function deleteIncomeCategory(name) {
  showConfirm({
    title:   `Delete "${name}"?`,
    message: "This removes the income category. Transactions already tagged with it are not affected.",
    okLabel: "Delete",
    onOk: () => {
      saveCustomIncomeCategories(getCustomIncomeCategories().filter(c => c !== name));
      const map = getIncomeEmojis();
      delete map[name];
      saveIncomeEmojis(map);
      loadIncomeCategoriesSection();
    },
  });
}

function updateOverride(merchant, category) {
  const data = getCentroids();
  if (!data) return;
  data.overrides[merchant] = category;
  saveCentroids(data);
  showToast("Override updated.");
}

function deleteOverride(merchant) {
  const data = getCentroids();
  if (!data) return;
  delete data.overrides[merchant];
  saveCentroids(data);
  loadOverrides();
}

function loadPaymentMethodsView() {
  const methods  = getPaymentMethods();
  const builtins = new Set(Object.keys(PAYMENT_ICONS));
  const list     = document.getElementById("payment-methods-list");
  list.innerHTML = methods.length
    ? methods.map(m => {
        const isCustom = !builtins.has(m);
        const emoji    = paymentIcon(m);
        const tag     = isCustom
          ? `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style="color:${isDark()?"#6dfad2":"#006b55"};background:${isDark()?"#1e1e1e":"#f0fdf9"}">custom</span>`
          : `<span class="text-[10px] text-[#c5c6ca]">built-in</span>`;
        const emojiEl = `<input type="text" value="${esc(emoji)}"
                    title="Tap to change emoji"
                    class="w-9 h-9 text-center text-xl border border-transparent hover:border-[#c5c6ca] focus:border-[#006b55] rounded-xl p-0.5 bg-transparent focus:outline-none focus:bg-white cursor-pointer flex-shrink-0"
                    onchange="updatePaymentMethodEmoji('${m.replace(/'/g, "\\'")}', this.value)" />`;
        return `
          <div class="flex items-center gap-3 px-4 py-3">
            ${emojiEl}
            <span class="flex-1 min-w-0 text-sm text-gray-700 font-medium truncate">${esc(m)}</span>
            ${tag}
            <button onclick="deletePaymentMethod('${m.replace(/'/g, "\\'")}')"
                    class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm">✕</button>
          </div>`;
      }).join("")
    : `<div class="px-4 py-6 text-sm text-gray-400 text-center">No payment methods.</div>`;
}

function updatePaymentMethodEmoji(method, newEmoji) {
  const emoji  = (newEmoji || "").trim() || "💳";
  const emojis = getPaymentEmojis();
  emojis[method] = emoji;
  savePaymentEmojis(emojis);
  renderPaymentButtons(state.selectedPayment, "payment-buttons");
  if (state.editPayment !== undefined) renderPaymentButtons(state.editPayment, "edit-payment-buttons");
  showToast("Emoji updated!");
}

function addCustomPaymentMethod() {
  const nameInput  = document.getElementById("new-payment-method");
  const emojiInput = document.getElementById("new-payment-emoji");
  const name  = (nameInput.value || "").trim();
  const emoji = (emojiInput?.value || "").trim() || "💳";
  if (!name) return;
  const methods = getPaymentMethods();
  if (methods.includes(name)) { showToast("Method already exists.", true); return; }
  methods.push(name);
  savePaymentMethods(methods);
  const emojis = getPaymentEmojis();
  emojis[name] = emoji;
  savePaymentEmojis(emojis);
  nameInput.value = "";
  if (emojiInput) emojiInput.value = "";
  loadPaymentMethodsView();
  showToast(`"${emoji} ${name}" added.`);
}

function deletePaymentMethod(method) {
  showConfirm({
    title:   `Remove "${method}"?`,
    message: "This removes the payment method from your list. Existing expenses are not affected.",
    okLabel: "Remove",
    onOk: () => {
      const methods = getPaymentMethods().filter(m => m !== method);
      savePaymentMethods(methods);
      const emojis = getPaymentEmojis();
      delete emojis[method];
      savePaymentEmojis(emojis);
      loadPaymentMethodsView();
    },
  });
}

function addOverride() {
  const merchant = document.getElementById("new-override-merchant").value.trim().toLowerCase();
  const category = document.getElementById("new-override-category").value;
  if (!merchant) return;
  const data = getCentroids();
  if (!data) { showToast("No model loaded yet.", true); return; }
  data.overrides[merchant] = category;
  saveCentroids(data);
  document.getElementById("new-override-merchant").value = "";
  loadOverrides();
  showToast("Override added.");
}

// ── Export / Import ───────────────────────────────────────────────────────────
function exportJSON() {
  const expenses = getExpenses();
  if (!expenses.length) { showToast("No expenses to export", true); return; }
  const blob = new Blob([JSON.stringify(expenses, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `flo-expenses-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCSV() {
  const expenses = getExpenses();
  if (!expenses.length) { showToast("No expenses to export", true); return; }
  const headers = ["date", "merchant", "amount", "currency", "category", "payment_method", "notes", "location", "source", "type", "created_at"];
  const escape  = v => {
    const s = String(v ?? "").replace(/"/g, '""');
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s}"` : s;
  };
  const rows = expenses.map(e => headers.map(h => escape(e[h])).join(","));
  const csv  = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `flo-expenses-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function triggerImport() {
  document.getElementById("import-file").click();
}

function onImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!Array.isArray(imported)) throw new Error("Expected a JSON array of expenses");
      const existing    = getExpenses();
      const existingIds = new Set(existing.map(e => e.id));
      const newOnes     = imported.filter(e => e.id && e.merchant && !existingIds.has(e.id));

      // Auto-add expense categories missing from settings
      const knownExpCats = new Set(getAllCategories());
      const newExpCats   = [...new Set(
        newOnes.filter(e => !isIncomeEntry(e) && e.category && !knownExpCats.has(e.category))
               .map(e => e.category)
      )];
      if (newExpCats.length) {
        const data = getCentroids() || { categories: {}, custom_categories: [], overrides: {} };
        data.custom_categories = data.custom_categories || [];
        for (const cat of newExpCats) {
          if (!data.custom_categories.includes(cat) && !Object.keys(data.categories || {}).includes(cat)) {
            data.custom_categories.push(cat);
          }
        }
        saveCentroids(data);
        loadCategoriesIntoButtons();
      }

      // Auto-add income categories missing from settings
      const knownIncCats = new Set(getAllIncomeCategories().map(c => c.toLowerCase()));
      const newIncCats   = [...new Set(
        newOnes.filter(e => isIncomeEntry(e) && e.category && !knownIncCats.has(e.category.toLowerCase()))
               .map(e => e.category)
      )];
      if (newIncCats.length) {
        const list = getCustomIncomeCategories();
        for (const cat of newIncCats) {
          if (!list.map(c => c.toLowerCase()).includes(cat.toLowerCase())) list.push(cat);
        }
        saveCustomIncomeCategories(list);
      }

      saveExpenses([...existing, ...newOnes]);
      document.getElementById("import-file").value = "";

      const addedParts = [];
      if (newExpCats.length) addedParts.push(`${newExpCats.length} expense categor${newExpCats.length !== 1 ? "ies" : "y"}`);
      if (newIncCats.length) addedParts.push(`${newIncCats.length} income categor${newIncCats.length !== 1 ? "ies" : "y"}`);
      let msg = `Imported ${newOnes.length} expense${newOnes.length !== 1 ? "s" : ""}`;
      if (addedParts.length) msg += `. Added ${addedParts.join(" and ")}`;
      showToast(msg);
      loadHome();
    } catch (err) {
      showToast("Import failed: " + err.message, true);
    }
  };
  reader.readAsText(file);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function hydrateCentroids() {
  if (getCentroids()) return;
  try {
    const r = await fetch("/api/base_centroids");
    if (r.ok) saveCentroids(await r.json());
  } catch (e) { console.warn("base centroid fetch failed:", e); }
}

function init() {
  const now = new Date();
  document.getElementById("header-date").textContent = now.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric"
  });
  document.getElementById("f-date").value = now.toISOString().split("T")[0];
  syncDarkToggle();
  hydrateCentroids();

  // Mark interrupted in-flight scans as errors (page was refreshed mid-scan)
  const _staleScans = getPendingScans();
  let _staleChanged = false;
  for (const s of _staleScans) {
    if (s.status === 'processing') { s.status = 'error'; s.errorMessage = 'Interrupted — tap Retry'; _staleChanged = true; }
  }
  if (_staleChanged) savePendingScans(_staleScans);

  loadHome();

  // Close nearby-results dropdowns when clicking outside their wrapper
  document.addEventListener('click', e => {
    for (const [wrapId, resultsId] of [
      ['f-location-wrap', 'f-nearby-results'],
      ['edit-location-wrap', 'edit-nearby-results'],
    ]) {
      const wrap = document.getElementById(wrapId);
      const res  = document.getElementById(resultsId);
      if (res && !res.classList.contains('hidden') && !wrap?.contains(e.target)) {
        res.classList.add('hidden');
      }
    }
  });
  loadCategoriesIntoButtons();
  const defaultCurrency = localStorage.getItem("defaultCurrency") || "EUR";
  populateCurrencySelect("f-currency", defaultCurrency);
  document.getElementById("f-cur-sym").textContent = curSym(defaultCurrency);
  renderPaymentButtons(null, "payment-buttons");
}

init();
