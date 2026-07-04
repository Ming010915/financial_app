// ── localStorage helpers ──────────────────────────────────────────────────────
function getExpenses() {
  return JSON.parse(kvGet('flo_expenses') || '[]');
}
function saveExpenses(exps) {
  kvSet('flo_expenses', JSON.stringify(exps));
  kvDelete('flo_ai_overview_cache');
}
function getCentroids() {
  const raw = kvGet('flo_centroids');
  return raw ? JSON.parse(raw) : null;
}
function saveCentroids(data) {
  kvSet('flo_centroids', JSON.stringify(data));
}
function getPaymentMethods() {
  const s = kvGet('flo_payment_methods');
  return s ? JSON.parse(s) : ["Cash","Debit Card","Credit Card","Mobile Pay","Bank Transfer"];
}
function savePaymentMethods(m) { kvSet('flo_payment_methods', JSON.stringify(m)); }
function getPaymentEmojis() {
  const s = kvGet('flo_payment_emojis');
  return s ? JSON.parse(s) : {};
}
function savePaymentEmojis(e) { kvSet('flo_payment_emojis', JSON.stringify(e)); }
function getCustomCurrencies() {
  const s = kvGet('flo_custom_currencies');
  return s ? JSON.parse(s) : [];
}
function saveCustomCurrencies(c) { kvSet('flo_custom_currencies', JSON.stringify(c)); }
function getBudget() {
  const v = kvGet('flo_budget');
  return v ? parseFloat(v) : null;
}
function saveBudget(amount) { kvSet('flo_budget', String(amount)); }
function clearBudget()      { kvDelete('flo_budget'); }
function getCustomBudgets() {
  const s = kvGet('flo_custom_budgets');
  return s ? JSON.parse(s) : [];
}
function saveCustomBudgets(b) { kvSet('flo_custom_budgets', JSON.stringify(b)); }
function getPendingScans()  { return JSON.parse(kvGet('flo_pending_scans') || '[]'); }
function savePendingScans(s){ kvSet('flo_pending_scans', JSON.stringify(s)); }
function getCustomIncomeCategories() {
  const s = kvGet('flo_income_categories');
  return s ? JSON.parse(s) : [];
}
function saveCustomIncomeCategories(list) { kvSet('flo_income_categories', JSON.stringify(list)); }
function getIncomeEmojis() {
  const s = kvGet('flo_income_emojis');
  return s ? JSON.parse(s) : {};
}
function saveIncomeEmojis(map) { kvSet('flo_income_emojis', JSON.stringify(map)); }
function getRemovedIncomeCategories() {
  const s = kvGet('flo_income_removed');
  return s ? JSON.parse(s) : [];
}
function saveRemovedIncomeCategories(list) { kvSet('flo_income_removed', JSON.stringify(list)); }
function getRecurring() {
  const s = kvGet('flo_recurring');
  return s ? JSON.parse(s) : [];
}
function saveRecurring(list) { kvSet('flo_recurring', JSON.stringify(list)); }

// ── IndexedDB (all persistent app storage) ──────────────────────────────────────
// Three object stores in one DB:
//  - `pending_files`    full-res receipt Files/Blobs for in-flight background
//                        scans, keyed by scan id (localStorage only ever got a
//                        small downscaled thumbnail, see _makeThumbnail).
//  - `expense_receipts` the same full-res receipt, kept permanently once an
//                        expense is saved, keyed by expense id — lets History
//                        show the original image later.
//  - `kv_store`          everything that used to live in localStorage (expenses,
//                        budgets, preferences, caches, …).
// IndexedDB has no synchronous API, so `kv_store` is mirrored into the in-memory
// `_kvCache` (hydrated once at boot, see hydrateKvCache) and all reads go through
// that cache — kvGet/kvSet/kvDelete below are synchronous, IndexedDB writes
// happen in the background. The two file stores are accessed directly (async)
// since they're only ever touched from already-async flows.
const IDB_NAME    = 'flo_files';
const IDB_VERSION = 3;
const IDB_STORE         = 'pending_files';
const IDB_RECEIPT_STORE = 'expense_receipts';
const IDB_KV_STORE      = 'kv_store';
let _idbPromise = null;

function _openIdb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB unsupported')); return; }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of [IDB_STORE, IDB_RECEIPT_STORE, IDB_KV_STORE]) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _idbPromise;
}

async function _idbPut(store, key, value) {
  try {
    const db = await _openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  } catch (e) { console.warn(`idbPut(${store}) failed:`, e); }
}

async function _idbGet(store, key) {
  try {
    const db = await _openIdb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  } catch (e) { console.warn(`idbGet(${store}) failed:`, e); return null; }
}

async function _idbDelete(store, key) {
  try {
    const db = await _openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  } catch (e) { console.warn(`idbDelete(${store}) failed:`, e); }
}

const idbPutFile      = (id, file) => _idbPut(IDB_STORE, id, file);
const idbGetFile      = id         => _idbGet(IDB_STORE, id);
const idbDeleteFile   = id         => _idbDelete(IDB_STORE, id);

const idbPutReceipt    = (id, file) => _idbPut(IDB_RECEIPT_STORE, id, file);
const idbGetReceipt    = id         => _idbGet(IDB_RECEIPT_STORE, id);
const idbDeleteReceipt = id         => _idbDelete(IDB_RECEIPT_STORE, id);

async function idbGetAllKeys() {
  try {
    const db = await _openIdb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  } catch (e) { console.warn('idbGetAllKeys failed:', e); return []; }
}

async function idbKvSet(key, value) {
  try {
    const db = await _openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_KV_STORE, 'readwrite');
      tx.objectStore(IDB_KV_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  } catch (e) { console.warn('idbKvSet failed:', e); }
}

async function idbKvDelete(key) {
  try {
    const db = await _openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_KV_STORE, 'readwrite');
      tx.objectStore(IDB_KV_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  } catch (e) { console.warn('idbKvDelete failed:', e); }
}

// Reads every entry back as a plain { key: value } object, used once at boot.
async function idbKvGetAll() {
  try {
    const db = await _openIdb();
    return await new Promise((resolve, reject) => {
      const store  = db.transaction(IDB_KV_STORE, 'readonly').objectStore(IDB_KV_STORE);
      const out    = {};
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) { out[cursor.key] = cursor.value; cursor.continue(); }
        else resolve(out);
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  } catch (e) { console.warn('idbKvGetAll failed:', e); return {}; }
}

// In-memory mirror of IDB_KV_STORE — every kvGet/kvSet/kvDelete call site in this
// file used to be a direct localStorage.getItem/setItem/removeItem call. Reads
// stay synchronous because IndexedDB has no sync API on the main thread; writes
// land in the cache immediately and persist to IndexedDB in the background.
const _kvCache = {};
function kvGet(key)          { return key in _kvCache ? _kvCache[key] : null; }
function kvSet(key, value)   { _kvCache[key] = value; idbKvSet(key, value); }
function kvDelete(key)       { delete _kvCache[key]; idbKvDelete(key); }

// One-time migration from the old localStorage keys into IndexedDB, then hydrate
// _kvCache from IndexedDB. Must resolve before init() reads any kv-backed data.
async function hydrateKvCache() {
  Object.assign(_kvCache, await idbKvGetAll());

  const legacyKeys = [
    'flo_expenses', 'flo_centroids', 'flo_payment_methods', 'flo_payment_emojis',
    'flo_custom_currencies', 'flo_budget', 'flo_custom_budgets', 'flo_pending_scans',
    'flo_income_categories', 'flo_income_emojis', 'flo_recurring', 'flo_home_layout',
    'flo_summaries', 'flo_ai_overview_cache', 'defaultCurrency', 'darkMode',
  ];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('flo_rates_')) legacyKeys.push(key);
  }

  const migrated = [];
  for (const key of legacyKeys) {
    if (!(key in _kvCache)) {
      const raw = localStorage.getItem(key);
      if (raw !== null) { _kvCache[key] = raw; idbKvSet(key, raw); migrated.push(key); }
    }
  }
  migrated.forEach(key => localStorage.removeItem(key));
}

// ── Home widget layout ─────────────────────────────────────────────────────────
const HOME_WIDGET_DEFS = [
  { id: 'total',      label: 'Monthly Total',   icon: '💰' },
  { id: 'budget',     label: 'Budget & Stats',  icon: '📊' },
  { id: 'income',     label: 'Monthly Balance', icon: '📈' },
  { id: 'chart',      label: '7-Day Chart',     icon: '📉' },
  { id: 'categories', label: 'Categories',      icon: '🏷' },
  { id: 'recent',         label: 'Recent',          icon: '🕐' },
  { id: 'custom_budgets', label: 'Custom Budgets',  icon: '🎯' },
];

function getHomeLayout() {
  const s = kvGet('flo_home_layout');
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
  kvSet('flo_home_layout', JSON.stringify(layout));
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
  const s = kvGet('flo_summaries');
  return s ? JSON.parse(s) : [];
}
function saveSummaries(summaries) { kvSet('flo_summaries', JSON.stringify(summaries)); }
function upsertSummary(period, text, spending) {
  const summaries = getSummaries().filter(s => s.period !== period);
  summaries.push({ period, text, spending });
  saveSummaries(summaries);
}

function rebuildSummariesFromExpenses(expenses) {
  const defCur   = kvGet("defaultCurrency") || "EUR";
  const thisMonth = new Date().toISOString().slice(0, 7);

  // Group past-month expenses by YYYY-MM
  const byMonth = {};
  for (const e of expenses) {
    if (!e.date || isIncomeEntry(e)) continue;
    const ym = e.date.slice(0, 7);
    if (ym >= thisMonth) continue; // skip current month
    if (!byMonth[ym]) byMonth[ym] = [];
    byMonth[ym].push(e);
  }

  for (const [ym, entries] of Object.entries(byMonth)) {
    const catBreakdown = {};
    for (const e of entries) {
      const cat = e.category || "Others";
      catBreakdown[cat] = (catBreakdown[cat] || 0) + convertToDefault(e.amount, e.currency, e.rate);
    }
    const [year, month] = ym.split("-").map(Number);
    const period = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    const total  = Object.values(catBreakdown).reduce((s, v) => s + v, 0);
    const items  = Object.entries(catBreakdown)
      .map(([cat, amt]) => `${cat} ${fmtAmount(amt, defCur)}`).join(", ");
    const text = `${period}: ${items}. Total ${fmtAmount(total, defCur)}.`;
    upsertSummary(period, text, catBreakdown);
  }
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
    const name = (item.name || "").trim().toLowerCase();
    const key = name ? `${name}|${item.price ?? ""}` : "";
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
  const monthTotal = expenses.filter(e => isExpenseEntry(e) && (e.date || '').startsWith(thisMonth) && (e.date || '') <= today).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);

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
  expenses.filter(e => isExpenseEntry(e) && (e.date || '').startsWith(thisMonth) && (e.date || '') <= today).forEach(e => {
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
const _PALETTE = [
  "#f43f5e","#f97316","#eab308","#84cc16","#22c55e","#10b981",
  "#06b6d4","#3b82f6","#6366f1","#8b5cf6","#ec4899","#14b8a6",
  "#f59e0b","#ef4444","#a855f7","#0ea5e9","#d946ef","#78716c",
];
function _hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return _PALETTE[Math.abs(h) % _PALETTE.length];
}

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
  isRecurring:      false,
  recurringEditId:  null,
  recurringConfirmMode: false,
  recurringScope:   'once',
  isReceipt:        false,
  isVoice:          false,
  receiptFile:         null,
  receiptItems:        [],
  formItemsCurrency:   null, // currency state.receiptItems' prices are currently expressed in
  pendingReceiptData:  null,
  expenseMap:       {},   // id → full expense object
  currentEditId:    null,
  editCategory:     null,
  editPayment:      null,
  editItems:        [],
  editItemsCurrency: null, // currency state.editItems' prices are currently expressed in
  rates:            null, // { base, rates: {USD:…}, date }
  currentPendingScanId: null,
};

let pieChartInst = null;
let lineChartInst = null;
const _pendingScansFiles  = {};  // id → File (in-memory cache; also mirrored to IndexedDB, see idbPutFile)
const _pendingScansAborts = {};  // id → AbortController
const _pendingVoiceAborts = {};  // id → AbortController (voice background jobs)

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
    body:    JSON.stringify(payload),
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
  } catch (err) {
    setBtn(origLabel, false);
    resultsEl.innerHTML = `<div class="px-3 py-3 text-xs text-red-500 text-center">Nearby search failed: ${err.message}</div>`;
  }
}

function selectNearbyPlace(inputId, resultsId, el) {
  document.getElementById(inputId).value = el.dataset.val;
  document.getElementById(resultsId).classList.add('hidden');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function catColor(cat)      { return CAT_COLOR[cat]  || _hashColor(cat || ""); }
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
  const custom  = getCustomIncomeCategories();
  const removed = new Set(getRemovedIncomeCategories());
  return [...new Set([...INCOME_CATEGORIES, ...custom])].filter(c => !removed.has(c));
}
function incomeCatColor(cat){ return INCOME_CAT_COLOR[cat] || _hashColor(cat || ""); }
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

function timeAgo(dateStr) {
  const min = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (min < 1)  return 'Just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function sanitizeCategoryName(s) {
  return String(s).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

function setAmountSymbol(sym) {
  const span = document.getElementById("f-cur-sym");
  const input = document.getElementById("f-amount");
  if (!span) return;
  span.textContent = sym;
  if (input) input.style.paddingLeft = (span.offsetWidth + 10) + "px";
}

function updateCurrencySymbol() {
  const code   = (document.getElementById("f-currency").value || "EUR").toUpperCase();
  const defCur = (kvGet("defaultCurrency") || "EUR").toUpperCase();
  setAmountSymbol(curSym(code));
  updateRateRow("f", code, defCur, null);
  const converted = convertItemPrices(state.receiptItems, state.formItemsCurrency, code);
  renderAddFormItems();
  if (converted) syncItemsTotal();
  state.formItemsCurrency = code;
  updateAmountConvertedHint();
}

// Refreshes the "≈ <default currency>" hint under the Amount field.
function updateAmountConvertedHint() {
  const hint = document.getElementById("f-amount-converted");
  if (!hint) return;
  const amount = parseFloat(document.getElementById("f-amount")?.value);
  const code   = document.getElementById("f-currency")?.value;
  const rate   = parseFloat(document.getElementById("f-rate")?.value);
  const text   = convertedHint(amount, code, isNaN(rate) ? null : rate);
  hint.textContent = text;
  hint.classList.toggle("hidden", !text);
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
  const defaultCurrency = kvGet("defaultCurrency") || "EUR";
  populateCurrencySelect("s-currency", defaultCurrency);
  const fCur = document.getElementById("f-currency");
  if (fCur) populateCurrencySelect("f-currency", fCur.value || defaultCurrency);
  const editCur = document.getElementById("edit-currency");
  if (editCur) populateCurrencySelect("edit-currency", editCur.value || defaultCurrency);
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
  const base = (kvGet("defaultCurrency") || "EUR").toUpperCase();
  const key  = "flo_rates_" + base;
  const hit  = kvGet(key);
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
      kvSet(key, JSON.stringify({ data, ts: Date.now() }));
    }
  } catch (e) { console.warn("Exchange rates unavailable:", e); }
}

function convertToDefault(amount, fromCurrency, storedRate) {
  const base = (kvGet("defaultCurrency") || "EUR").toUpperCase();
  const from = (fromCurrency || base).toUpperCase();
  if (from === base) return amount;
  if (storedRate != null && storedRate > 0) return amount * storedRate;
  if (!state.rates?.rates) return amount;
  const rate = state.rates.rates[from];
  return rate ? amount / rate : amount;
}

// Converts between two arbitrary currencies by pivoting through state.rates'
// base (the default currency). Returns null if a required rate isn't loaded.
function convertAmount(amount, fromCode, toCode) {
  const from = (fromCode || "").toUpperCase();
  const to   = (toCode   || "").toUpperCase();
  if (!from || !to || from === to) return amount;
  const base  = (kvGet("defaultCurrency") || "EUR").toUpperCase();
  const rates = state.rates?.rates;
  if (!rates) return null;
  const inBase = from === base ? amount : (rates[from] ? amount / rates[from] : null);
  if (inBase == null) return null;
  return to === base ? inBase : (rates[to] ? inBase * rates[to] : null);
}

// Converts every item's price from one currency to another in place, so item
// prices stay consistent with the form's total when the user switches currency
// (otherwise the items-vs-total sum check would compare mismatched currencies).
// Returns true if any price was changed.
function convertItemPrices(items, fromCode, toCode) {
  const from = (fromCode || toCode || "EUR").toUpperCase();
  const to   = (toCode   || from   || "EUR").toUpperCase();
  if (!items || items.length === 0 || from === to) return false;
  let changed = false;
  items.forEach(it => {
    const price = parseFloat(it.price);
    if (isNaN(price)) return;
    const converted = convertAmount(price, from, to);
    if (converted != null) { it.price = Math.round(converted * 100) / 100; changed = true; }
  });
  return changed;
}

// "≈ <default-currency amount>" for display next to a native-currency value,
// or "" when the amount is already in the default currency or no rate is
// available. Mirrors convertToDefault's precedence (stored rate, then live rate).
function convertedHint(amount, fromCode, rate) {
  if (amount == null || isNaN(amount)) return "";
  const defCur = (kvGet("defaultCurrency") || "EUR").toUpperCase();
  const from   = (fromCode || defCur).toUpperCase();
  if (from === defCur) return "";
  const converted = (rate != null && rate > 0) ? amount * rate : convertAmount(amount, from, defCur);
  if (converted == null) return "";
  return `≈ ${fmtAmount(converted, defCur)}`;
}

function getLiveRate(fromCurrency) {
  const base = (kvGet("defaultCurrency") || "EUR").toUpperCase();
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
  kvSet("darkMode", next ? "1" : "0");
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
  document.getElementById('history-scroll-top')?.classList.add('hidden');
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
    _historySort = 'date_desc';
    _historyCustomFrom = '';
    _historyCustomTo = '';
    _historyShownDays = 5;
    if (_histViewMode === 'calendar') _resetHistToListMode();
    loadHistory();
  }
  if (name === "summary")  loadSummary();
  if (name === "add")      prepareAddForm();
  if (name === "settings")        { loadSettingsView(); syncDarkToggle(); }
  if (name === "preferences")     loadSettingsView();
  if (name === "budgets")         loadBudgetsView();
  if (name === "categories")       { loadCategoriesView(); loadIncomeCategoriesSection(); loadOverrides(); }
  if (name === "payment-methods")  loadPaymentMethodsView();
  if (name === "recurring") loadRecurringView();
}

// ── Add method shortcuts ──────────────────────────────────────────────────────
function addByReceipt() {
  clearScanView();
  resetForm();
  showView("scan");
}

function addByVoice() {
  resetVoiceBtn();
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
// ── Custom Budgets ─────────────────────────────────────────────────────────────
const CB_COLORS = ["#006b55","#3b82f6","#8b5cf6","#f97316","#ec4899","#06b6d4","#eab308","#ef4444"];
let _cbSelectedColor = CB_COLORS[0];
let _cbType = 'event';
let _cbEditId = null;
let _cbEditType = 'event';
let _cbEditSelectedColor = CB_COLORS[0];

function computeCustomBudgetSpent(budget) {
  const expenses = getExpenses();
  if (budget.type === 'event') {
    // No dates: count all tagged expenses ever (one-time total budget)
    // With dates: count only tagged expenses within the date range
    return expenses
      .filter(e => {
        if (!isExpenseEntry(e) || e.budgetId !== budget.id) return false;
        if (budget.startDate && (e.date || '') < budget.startDate) return false;
        if (budget.endDate   && (e.date || '') > budget.endDate)   return false;
        return true;
      })
      .reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
  } else {
    // Category budget: always resets to current month
    const thisMonth = new Date().toISOString().slice(0, 7);
    const today     = new Date().toISOString().slice(0, 10);
    return expenses
      .filter(e => isExpenseEntry(e) && e.category === budget.category
        && (e.date || '').startsWith(thisMonth) && (e.date || '') <= today)
      .reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
  }
}

function isBudgetArchived(budget) {
  if (budget.type !== 'event' || !budget.endDate) return false;
  return new Date().toISOString().slice(0, 10) > budget.endDate;
}

function _budgetRowHtml(b, archived = false) {
  const defCur    = kvGet('defaultCurrency') || 'EUR';
  const spent     = computeCustomBudgetSpent(b);
  const pct       = Math.round((spent / b.amount) * 100);
  const remaining = b.amount - spent;
  const barColor  = archived ? '#94a3b8'
                  : pct >= 100 ? '#ef4444' : pct >= 90 ? '#ef4444' : pct >= 75 ? '#f97316' : (b.color || '#006b55');
  const leftColor = archived ? '#94a3b8' : (pct >= 90 ? '#ef4444' : (b.color || '#006b55'));
  let subtitle = '';
  if (b.type === 'category') {
    subtitle = `${b.category} · This month`;
  } else if (b.startDate || b.endDate) {
    const fmt = d => d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '?';
    subtitle = (b.startDate && b.endDate) ? `${fmt(b.startDate)} – ${fmt(b.endDate)}`
             : b.startDate ? `From ${fmt(b.startDate)}` : `Until ${fmt(b.endDate)}`;
  }
  return `
    <div class="${archived ? 'opacity-60' : ''}">
      <div class="flex items-center justify-between mb-1">
        <div>
          <span class="text-sm font-semibold text-[#191c1d]">${esc(b.name)}</span>
          ${subtitle ? `<div class="text-[10px] text-[#44474a]">${esc(subtitle)}</div>` : ''}
        </div>
        <span class="text-sm font-bold" style="color:${barColor}">${pct}%</span>
      </div>
      <div class="h-2 bg-[#edeeef] rounded-full overflow-hidden mb-1.5">
        <div class="h-full rounded-full" style="width:${Math.min(pct,100)}%;background:${barColor};transition:width 0.7s cubic-bezier(0.4,0,0.2,1)"></div>
      </div>
      <div class="flex justify-between text-xs">
        <span class="text-[#44474a]">${fmtAmount(spent, defCur)} of ${fmtAmount(b.amount, defCur)}</span>
        <span class="font-bold" style="color:${leftColor}">${archived ? 'Ended' : (remaining < 0 ? fmtAmount(Math.abs(remaining), defCur) + ' over' : fmtAmount(remaining, defCur) + ' left')}</span>
      </div>
    </div>`;
}

function renderCustomBudgetsHome() {
  const budgets  = getCustomBudgets();
  const card     = document.getElementById('home-custom-budgets-card');
  const list     = document.getElementById('home-custom-budgets-list');
  if (!card || !list) return;
  card.classList.remove('hidden');
  if (budgets.length === 0) {
    list.innerHTML = `<button onclick="showView('budgets')" class="w-full py-2.5 border-2 border-dashed border-[#c5c6ca] rounded-2xl text-sm text-[#006b55] font-bold hover:border-[#006b55] hover:bg-[#f0fdf9] transition-colors">+ Set a custom budget</button>`;
    return;
  }

  const active   = budgets.filter(b => !isBudgetArchived(b));
  const archived = budgets.filter(b =>  isBudgetArchived(b));
  const sep      = '<div class="border-t border-[#edeeef] my-2"></div>';

  let html = active.map((b, i) => (i > 0 ? sep : '') + _budgetRowHtml(b)).join('');

  if (archived.length > 0) {
    if (active.length > 0) html += sep;
    html += `
      <button onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('span').textContent=this.nextElementSibling.classList.contains('hidden')?'Show':'Hide'"
              class="flex items-center gap-1.5 text-[10px] font-bold text-[#44474a] uppercase tracking-wider w-full">
        <span>Show</span> ${archived.length} archived
        <svg class="w-3 h-3 ml-auto" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
      </button>
      <div class="hidden space-y-0 mt-2">
        ${archived.map((b, i) => (i > 0 ? sep : '') + _budgetRowHtml(b, true)).join('')}
      </div>`;
  }

  list.innerHTML = html;
}

function loadCustomBudgetSelect(selectId, currentBudgetId) {
  const sel     = document.getElementById(selectId);
  const wrap    = selectId === 'f-budget-tag' ? document.getElementById('f-budget-wrap')
                                              : document.getElementById('edit-budget-wrap');
  const budgets = getCustomBudgets().filter(b => b.type === 'event' && !isBudgetArchived(b));
  if (!sel) return;
  if (wrap) wrap.classList.remove('hidden');
  sel.innerHTML = '<option value="">— No event budget —</option>'
    + budgets.map(b => `<option value="${b.id}"${b.id === currentBudgetId ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
}

function toggleInlineEventBudget(ctx = 'add') {
  const formId = ctx === 'edit' ? 'edit-inline-event-budget-form' : 'inline-event-budget-form';
  const form = document.getElementById(formId);
  if (!form) return;
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    const defCur = kvGet('defaultCurrency') || 'EUR';
    const sym = document.getElementById(ctx === 'edit' ? 'edit-ief-sym' : 'ief-sym');
    if (sym) sym.textContent = curSym(defCur);
    document.getElementById(ctx === 'edit' ? 'edit-ief-name' : 'ief-name')?.focus();
  }
}

function saveInlineEventBudget(ctx = 'add') {
  const p      = ctx === 'edit' ? 'edit-ief-' : 'ief-';
  const name   = document.getElementById(`${p}name`)?.value.trim();
  const amount = parseFloat(document.getElementById(`${p}amount`)?.value);
  if (!name)                  { showToast('Enter a budget name', true); return; }
  if (!amount || amount <= 0) { showToast('Enter a valid amount', true); return; }

  const budget = {
    id:        generateId(),
    name,
    type:      'event',
    category:  null,
    amount,
    startDate: document.getElementById(`${p}start`)?.value || null,
    endDate:   document.getElementById(`${p}end`)?.value   || null,
    color:     '#006b55',
    createdAt: new Date().toISOString(),
  };

  const budgets = getCustomBudgets();
  budgets.push(budget);
  saveCustomBudgets(budgets);

  loadCustomBudgetSelect(ctx === 'edit' ? 'edit-budget-tag' : 'f-budget-tag', budget.id);
  renderCustomBudgetsHome();

  document.getElementById(`${p}name`).value   = '';
  document.getElementById(`${p}amount`).value = '';
  if (document.getElementById(`${p}start`)) document.getElementById(`${p}start`).value = '';
  if (document.getElementById(`${p}end`))   document.getElementById(`${p}end`).value   = '';
  document.getElementById(ctx === 'edit' ? 'edit-inline-event-budget-form' : 'inline-event-budget-form')?.classList.add('hidden');

  showToast('Event budget created!');
}

function toggleInlineAddCategory(ctx = 'add') {
  const formId = ctx === 'edit' ? 'edit-inline-add-category-form' : 'inline-add-category-form';
  const form = document.getElementById(formId);
  if (!form) return;
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) document.getElementById(ctx === 'edit' ? 'edit-iac-name' : 'iac-name')?.focus();
}

function saveInlineCategory(ctx = 'add') {
  const p     = ctx === 'edit' ? 'edit-iac-' : 'iac-';
  const name  = sanitizeCategoryName(document.getElementById(`${p}name`)?.value || '');
  const emoji = (document.getElementById(`${p}emoji`)?.value || '').trim() || '📦';
  if (!name) { showToast('Enter a category name', true); return; }

  const isIncomeCtx = ctx === 'edit' ? !!state.editIsIncome : !!state.isIncome;

  if (isIncomeCtx) {
    if (getAllIncomeCategories().includes(name)) { showToast('Category already exists.', true); return; }
    const list = getCustomIncomeCategories();
    list.push(name);
    saveCustomIncomeCategories(list);
    const emojis = getIncomeEmojis();
    emojis[name] = emoji;
    saveIncomeEmojis(emojis);
    if (ctx === 'edit') renderEditIncomeCatButtons(name); else renderIncomeCatButtons(name);
  } else {
    const data = getCentroids();
    if (!data) { showToast('No model loaded yet.', true); return; }
    if (getAllCategories().includes(name)) { showToast('Category already exists.', true); return; }
    data.custom_categories = data.custom_categories || [];
    data.custom_categories.push(name);
    data.custom_category_emojis = data.custom_category_emojis || {};
    data.custom_category_emojis[name] = emoji;
    saveCentroids(data);
    state.categories = getAllCategories();
    if (ctx === 'edit') renderEditCatButtons(name); else renderCatButtons(name);
  }

  document.getElementById(`${p}name`).value  = '';
  document.getElementById(`${p}emoji`).value = '';
  document.getElementById(ctx === 'edit' ? 'edit-inline-add-category-form' : 'inline-add-category-form')?.classList.add('hidden');
  showToast(`"${emoji} ${name}" added.`);
}

function toggleInlineAddPayment(ctx = 'add') {
  const formId = ctx === 'edit' ? 'edit-inline-add-payment-form' : 'inline-add-payment-form';
  const form = document.getElementById(formId);
  if (!form) return;
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) document.getElementById(ctx === 'edit' ? 'edit-iap-name' : 'iap-name')?.focus();
}

function saveInlinePayment(ctx = 'add') {
  const p     = ctx === 'edit' ? 'edit-iap-' : 'iap-';
  const name  = (document.getElementById(`${p}name`)?.value || '').trim();
  const emoji = (document.getElementById(`${p}emoji`)?.value || '').trim() || '💳';
  if (!name) { showToast('Enter a payment method name', true); return; }
  const methods = getPaymentMethods();
  if (methods.includes(name)) { showToast('Method already exists.', true); return; }
  methods.push(name);
  savePaymentMethods(methods);
  const emojis = getPaymentEmojis();
  emojis[name] = emoji;
  savePaymentEmojis(emojis);
  document.getElementById(`${p}name`).value  = '';
  document.getElementById(`${p}emoji`).value = '';
  document.getElementById(ctx === 'edit' ? 'edit-inline-add-payment-form' : 'inline-add-payment-form')?.classList.add('hidden');
  selectPayment(name, ctx === 'edit' ? 'edit-payment-buttons' : 'payment-buttons');
  showToast(`"${emoji} ${name}" added.`);
}

function toggleInlineAddCurrency(ctx = 'add') {
  const wrapId = ctx === 'edit' ? 'edit-inline-add-currency-wrap' : 'inline-add-currency-wrap';
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap.classList.toggle('hidden');
  if (!wrap.classList.contains('hidden')) document.getElementById(ctx === 'edit' ? 'edit-icu-code' : 'icu-code')?.focus();
}

function saveInlineCurrency(ctx = 'add') {
  const codeId = ctx === 'edit' ? 'edit-icu-code' : 'icu-code';
  const code = (document.getElementById(codeId)?.value || '').trim().toUpperCase();
  if (!code) { showToast('Enter a currency code', true); return; }
  const builtinCodes = BUILTIN_CURRENCIES.map(c => c.code);
  const customs = getCustomCurrencies();
  if (builtinCodes.includes(code) || customs.includes(code)) { showToast('Currency already exists.', true); return; }
  customs.push(code);
  saveCustomCurrencies(customs);
  document.getElementById(codeId).value = '';
  document.getElementById(ctx === 'edit' ? 'edit-inline-add-currency-wrap' : 'inline-add-currency-wrap')?.classList.add('hidden');
  refreshAllCurrencySelects();
  if (ctx === 'edit') {
    const sel = document.getElementById('edit-currency');
    if (sel) { sel.value = code; updateEditCurrencyRate(code); }
  } else {
    const sel = document.getElementById('f-currency');
    if (sel) { sel.value = code; updateCurrencySymbol(); }
  }
  showToast(`${code} added.`);
}

async function loadHome() {
  applyHomeLayout();
  await loadRates();
  const data   = computeSummary();
  const defCur = kvGet("defaultCurrency") || "EUR";

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
    const pct       = Math.round((spent / budget) * 100);
    const overBudget = spent > budget;
    const remaining = budget - spent;

    document.getElementById("home-budget-pct").textContent      = `${pct}% used`;
    document.getElementById("home-budget-limit").textContent     = `Limit: ${fmtAmount(budget, defCur)}`;
    document.getElementById("home-budget-remaining").textContent = overBudget
      ? `${fmtAmount(Math.abs(remaining), defCur)} over budget`
      : `${fmtAmount(remaining, defCur)} remaining`;
    homeLeftEl.textContent = overBudget
      ? `-${fmtAmount(Math.abs(remaining), defCur)}`
      : fmtAmount(remaining, defCur);

    // Bar colour: green → orange → red as budget fills up; cap bar at 100% width
    const barEl = document.getElementById("home-budget-bar");
    const barColour = pct >= 100 ? "#ef4444" : pct >= 90 ? "#ef4444" : pct >= 75 ? "#f97316" : "#006b55";
    barEl.style.background = barColour;
    const accentCol = isDark() ? "#6dfad2" : "#006b55";
    document.getElementById("home-budget-remaining").style.color = pct >= 90 ? "#ef4444" : accentCol;
    homeLeftEl.style.color = pct >= 90 ? "#ef4444" : accentCol;
    setTimeout(() => { barEl.style.width = Math.min(pct, 100) + "%"; }, 80);
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
  renderCustomBudgetsHome();
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
    ? `<span class="text-[9px] px-1 py-0.5 rounded font-semibold ml-1" style="background:${isDark()?"#1e1e1e":"#f0fdf9"};color:${isDark()?"#6dfad2":"#006b55"}">📷</span>`
    : exp.source === "recurring"
    ? `<span class="text-[9px] px-1 py-0.5 rounded font-semibold ml-1" style="background:${isDark()?"#1e2020":"#f0fdf9"};color:${isDark()?"#6dfad2":"#006b55"}">🔁</span>` : "";
  const defCur = (kvGet("defaultCurrency") || "EUR").toUpperCase();
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
  resetForm();
  setFormType('expense');
}

function setRecurringMode(item, confirmMode = false) {
  state.isRecurring          = true;
  state.recurringEditId      = item ? item.id : null;
  state.recurringConfirmMode = confirmMode;

  const dateWrap = document.getElementById('f-date-wrap');
  if (dateWrap) dateWrap.classList.add('hidden');
  const recurDayWrap = document.getElementById('f-recur-day-wrap');
  if (recurDayWrap) recurDayWrap.classList.remove('hidden');
  document.getElementById('f-location-wrap').classList.add('hidden');
  document.getElementById('items-wrapper')?.classList.add('hidden');
  const rateRow = document.getElementById('f-rate-row');
  if (rateRow) rateRow.style.display = 'none';

  document.getElementById('add-form-title').textContent  = confirmMode ? 'Confirm Recurring Expense' : (item ? 'Edit Recurring Expense' : 'Add Recurring Expense');
  const backBtn = document.getElementById('add-back-btn');
  if (backBtn) backBtn.setAttribute('onclick', "showView('recurring')");

  const scopeWrap = document.getElementById('recur-scope-toggle-wrap');
  if (confirmMode) {
    scopeWrap?.classList.remove('hidden');
    setRecurringScope('once'); // default to the safer, narrower choice
  } else {
    scopeWrap?.classList.add('hidden');
    document.getElementById('save-label').textContent = item ? 'Save Changes' : 'Add Recurring Expense';
  }

  const dayInput = document.getElementById('f-recur-day');
  if (dayInput) dayInput.value = item && item.day_of_month ? item.day_of_month : '';

  if (item) {
    document.getElementById('f-merchant').value          = item.merchant;
    document.getElementById('f-amount').value            = item.amount;
    document.getElementById('f-notes').value             = item.notes || '';
    populateCurrencySelect('f-currency', item.currency);
    document.getElementById('f-cur-sym').textContent     = curSym(item.currency);
    renderCatButtons(item.category);
    renderPaymentButtons(item.payment_method || null, 'payment-buttons');
  }
}

function setRecurringScope(scope) {
  state.recurringScope = scope;
  const onceBtn = document.getElementById('recur-scope-btn-once');
  const allBtn  = document.getElementById('recur-scope-btn-all');
  if (onceBtn && allBtn) {
    const activeCls   = 'flex-1 py-2 rounded-xl text-sm font-bold bg-white dark:bg-[#141414] text-[#006b55] dark:text-[#6dfad2] shadow-sm transition-all';
    const inactiveCls = 'flex-1 py-2 rounded-xl text-sm font-bold text-[#44474a] dark:text-[#aaa] transition-all';
    onceBtn.className = scope === 'once' ? activeCls : inactiveCls;
    allBtn.className  = scope === 'all'  ? activeCls : inactiveCls;
  }
  const saveLabel = document.getElementById('save-label');
  if (saveLabel) saveLabel.textContent = scope === 'once' ? 'Confirm — this time only' : 'Confirm — this & future';
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
  const locWrap    = document.getElementById('f-location-wrap');
  const itemsWrap  = document.getElementById('items-wrapper');
  if (titleEl)   titleEl.textContent   = state.isIncome ? 'Add Income'              : 'Add Expense';
  if (saveLabel) saveLabel.textContent  = state.isIncome ? 'Add Income'              : 'Add Expense';
  if (labelEl)   labelEl.textContent   = state.isIncome ? 'Source *'                : 'Merchant *';
  if (inputEl)   inputEl.placeholder   = state.isIncome ? 'e.g. Employer, Client'   : "e.g. Lidl, McDonald's";
  if (locWrap)   locWrap.classList.toggle('hidden', state.isIncome);
  if (itemsWrap) itemsWrap.classList.toggle('hidden', !!state.isIncome);
  document.getElementById('f-budget-wrap')?.classList.toggle('hidden', state.isIncome);
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
      <button type="button" data-cat="${esc(cat)}"
              class="cat-chip px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white transition-all ${isChosen ? "selected" : "opacity-60"}"
              style="background:${col}">
        ${catEmoji(cat)} ${esc(cat)}
      </button>`;
  }).join("");
  state.selectedCategory = selected;
  el.onclick = (e) => {
    const btn = e.target.closest("[data-cat]");
    if (btn) selectCategory(btn.dataset.cat);
  };
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

// ── Pinch-to-zoom/pan for receipt image previews ─────────────────────────────
// Shared by the scan preview, the verify screen, and the add-expense reference
// image. Uses touch-action:none on the container so JS has sole control of the
// gesture from the first touch (relying on native scroll + preventDefault mid-
// gesture is unreliable on iOS Safari once it has committed to a default
// action).
function _makeImageZoom(imgId) {
  const z = { s: 1, tx: 0, ty: 0, px: 0, py: 0, d0: 0, lastTap: 0 };

  function apply() {
    const img = document.getElementById(imgId);
    if (img) img.style.transform = `translate(${z.tx}px,${z.ty}px) scale(${z.s})`;
  }

  function reset() {
    z.s = 1; z.tx = 0; z.ty = 0;
    apply();
  }

  // Toggles between 1x and targetScale (for a tap-to-zoom button). Returns
  // whether the image is now zoomed in.
  function toggle(targetScale) {
    if (z.s > 1) { reset(); return false; }
    z.s = targetScale; z.tx = 0; z.ty = 0;
    apply();
    return true;
  }

  function attach(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.addEventListener('touchstart', event => {
      if (event.target.closest('button')) return;
      if (event.touches.length === 2) {
        z.d0 = Math.hypot(
          event.touches[0].clientX - event.touches[1].clientX,
          event.touches[0].clientY - event.touches[1].clientY
        );
      } else {
        z.px = event.touches[0].clientX;
        z.py = event.touches[0].clientY;
        const now = Date.now();
        if (now - z.lastTap < 280) reset();
        z.lastTap = now;
      }
    }, { passive: true });

    container.addEventListener('touchmove', event => {
      if (event.target.closest('button')) return;
      event.preventDefault();
      if (event.touches.length === 2) {
        const d = Math.hypot(
          event.touches[0].clientX - event.touches[1].clientX,
          event.touches[0].clientY - event.touches[1].clientY
        );
        z.s = Math.min(5, Math.max(1, z.s * d / z.d0));
        z.d0 = d;
      } else if (event.touches.length === 1 && z.s > 1) {
        z.tx += event.touches[0].clientX - z.px;
        z.ty += event.touches[0].clientY - z.py;
        z.px = event.touches[0].clientX;
        z.py = event.touches[0].clientY;
      }
      apply();
    }, { passive: false });

    container.addEventListener('touchend', () => {
      if (z.s < 1.05) reset();
    }, { passive: true });
  }

  return { apply, reset, toggle, attach };
}

const _scanZoom      = _makeImageZoom('preview-img');
const _verifyZoom    = _makeImageZoom('verify-img');
const _refZoom       = _makeImageZoom('receipt-ref-img');
const _detReceiptZoom = _makeImageZoom('det-receipt-img');

function _initReceiptZoom() { _scanZoom.attach('receipt-zoom-container'); }
function _initDetReceiptZoom() { _detReceiptZoom.attach('det-receipt-panel'); }
function _initVerifyZoom()  { _verifyZoom.attach('verify-img-panel'); }
function _initRefZoom()     { _refZoom.attach('receipt-ref-panel'); }

function _verifyZoomFullReset() {
  _verifyZoom.reset();
  document.getElementById('verify-zoom-icon-in')?.classList.remove('hidden');
  document.getElementById('verify-zoom-icon-out')?.classList.add('hidden');
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
  _scanZoom.reset();
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
  renderAddFormItems();
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
  idbPutFile(id, file); // survive a refresh mid-scan; cleaned up on dismiss/save

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
  updateNotificationBadge();
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

    updateNotificationBadge();
    showToast('Receipt ready — tap to review!');
  } catch (e) {
    if (e.name === 'AbortError' || abort.signal.aborted) return;

    const scans = getPendingScans();
    const scan  = scans.find(s => s.id === id);
    if (scan) {
      if (e.errorCode === 'not_a_receipt') {
        scan.status       = 'not_receipt';
        scan.errorMessage = e.message;
      } else {
        scan.status       = 'error';
        scan.errorMessage = e.message || 'Analysis failed';
      }
      savePendingScans(scans);
    }
    delete _pendingScansAborts[id];

    updateNotificationBadge();
    if (e.errorCode === 'not_a_receipt') {
      showToast('Not a receipt — tap to view', true);
    } else {
      showToast('Scan failed: ' + (e.message || 'unknown error'), true);
    }
  }
}

function resumePendingScan(id) {
  const scan = getPendingScans().find(s => s.id === id);
  if (!scan) return;
  if (scan.type === 'voice') {
    if (scan.status === 'ready' && scan.extractedData) {
      dismissPendingScan(id);
      populateFormFromVoice(scan.extractedData);
    }
    return;
  }
  if (scan.status === 'ready' && scan.extractedData) {
    state.currentPendingScanId = id;
    state.receiptFile          = _pendingScansFiles[id] || null;
    showVerifyView(scan.extractedData);
  } else if (scan.status === 'not_receipt') {
    showVerifyErrorView(scan);
  }
}

function showVerifyErrorView(scan) {
  state.currentPendingScanId = scan.id;
  state.receiptFile          = _pendingScansFiles[scan.id] || null;

  const imgEl  = document.getElementById("verify-img");
  const pdfEl  = document.getElementById("verify-pdf");
  const zoomBtn = document.getElementById("verify-zoom-btn");
  const panel  = document.getElementById("verify-img-panel");

  if (state.receiptFile) {
    if (_verifyBlobUrl) { URL.revokeObjectURL(_verifyBlobUrl); }
    _verifyBlobUrl = URL.createObjectURL(state.receiptFile);
    if (state.receiptFile.type === "application/pdf") {
      imgEl.classList.add("hidden");
      pdfEl.classList.remove("hidden");
      if (zoomBtn) zoomBtn.classList.add("hidden");
      document.getElementById("verify-zoom-hint")?.classList.add("hidden");
      panel.style.height = "55%";
      renderPdfPages(state.receiptFile);
    } else {
      imgEl.src = _verifyBlobUrl;
      imgEl.classList.remove("hidden");
      pdfEl.classList.add("hidden");
      if (zoomBtn) zoomBtn.classList.remove("hidden");
      document.getElementById("verify-zoom-hint")?.classList.remove("hidden");
      panel.style.height = "42%";
    }
  }

  _verifyZoomFullReset();
  panel.scrollTop = 0;
  panel.scrollLeft = 0;

  const msgEl = document.getElementById("verify-error-msg");
  if (msgEl) msgEl.textContent = scan.errorMessage || "This file doesn't appear to be a receipt.";

  document.getElementById("verify-divider")?.classList.add("hidden");
  document.getElementById("verify-fields")?.classList.add("hidden");
  document.getElementById("verify-confirm-row")?.classList.add("hidden");
  document.getElementById("verify-error-panel")?.classList.remove("hidden");
  document.getElementById("verify-error-action-row")?.classList.remove("hidden");

  showView("verify");
}

function dismissAndScanNew() {
  const id = state.currentPendingScanId;
  state.currentPendingScanId = null;
  clearVerifyView();
  if (id) dismissPendingScan(id);
  showView('scan');
}

function dismissPendingScan(id) {
  _pendingScansAborts[id]?.abort();
  delete _pendingScansAborts[id];
  delete _pendingScansFiles[id];
  idbDeleteFile(id);
  _pendingVoiceAborts[id]?.abort();
  delete _pendingVoiceAborts[id];
  savePendingScans(getPendingScans().filter(s => s.id !== id));
  updateNotificationBadge();
}

async function retryPendingScan(id) {
  const scans = getPendingScans();
  const scan  = scans.find(s => s.id === id);
  if (!scan) return;

  if (scan.type === 'voice') {
    scan.status = 'processing'; scan.errorMessage = null;
    savePendingScans(scans);
    updateNotificationBadge();
    const abort = new AbortController();
    _pendingVoiceAborts[id] = abort;
    _runBackgroundVoice(id, scan.transcript, abort);
    return;
  }

  let file = _pendingScansFiles[id];
  if (!file) file = _pendingScansFiles[id] = await idbGetFile(id); // e.g. after a page refresh
  if (!file) { showToast('Original file no longer available — please re-upload', true); dismissPendingScan(id); return; }
  scan.status = 'processing'; scan.errorMessage = null;
  savePendingScans(scans);
  updateNotificationBadge();
  const abort = new AbortController();
  _pendingScansAborts[id] = abort;
  _runBackgroundScan(id, file, abort);
}

// ── Notifications ─────────────────────────────────────────────────────────────

const NOTIF_BELL_HIGHLIGHT_CLASSES = ['bg-[#f0fdf9]', 'text-[#006b55]'];

function updateNotificationBadge() {
  const badge    = document.getElementById('notif-badge');
  const spinner  = document.getElementById('notif-processing-spinner');
  const bellBtn  = document.getElementById('notif-bell-btn');
  const bellIcon = document.getElementById('notif-bell-icon');
  if (!badge) return;
  const scans          = getPendingScans();
  const readyCount     = scans.filter(s => s.status === 'ready').length;
  const processingCount = scans.filter(s => s.status === 'processing').length;
  const dueCount       = getDueRecurring().length;
  const total          = readyCount + dueCount;
  if (total > 0) {
    badge.textContent = total > 9 ? '9+' : String(total);
    badge.classList.remove('hidden');
    bellIcon?.classList.add('bell-shake');
    bellBtn?.classList.add(...NOTIF_BELL_HIGHLIGHT_CLASSES);
  } else {
    badge.classList.add('hidden');
    bellIcon?.classList.remove('bell-shake');
    bellBtn?.classList.remove(...NOTIF_BELL_HIGHLIGHT_CLASSES);
  }
  spinner?.classList.toggle('hidden', processingCount === 0);

  if (!document.getElementById('notifications-overlay')?.classList.contains('hidden')) {
    renderNotifications();
  }
}

function openNotifications() {
  renderNotifications();
  document.getElementById('notifications-overlay').classList.remove('hidden');
}

function closeNotifications() {
  document.getElementById('notifications-overlay').classList.add('hidden');
}

function renderNotifications() {
  const scans        = getPendingScans();
  const dueRecurring = getDueRecurring();
  const content = document.getElementById('notifications-content');
  const clearBtn = document.getElementById('notif-clear-btn');
  if (!content) return;

  if (scans.length === 0 && dueRecurring.length === 0) {
    clearBtn.classList.add('hidden');
    content.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <div class="w-16 h-16 rounded-full bg-[#f0fdf9] flex items-center justify-center text-3xl">🔔</div>
        <div class="text-sm font-semibold text-[#191c1d]">No notifications</div>
        <div class="text-xs text-[#44474a]">Completed receipt scans and due recurring bills will appear here</div>
      </div>`;
    return;
  }

  clearBtn.classList.toggle('hidden', scans.length === 0);

  const ready      = scans.filter(s => s.status === 'ready');
  const processing = scans.filter(s => s.status === 'processing');
  const error      = scans.filter(s => s.status === 'error');

  let html = '';

  if (dueRecurring.length) {
    html += `<div>
      <div class="text-[10px] font-bold text-[#44474a] uppercase tracking-wider mb-2">Recurring Due</div>
      <div class="space-y-2">${dueRecurring.map(recurringNotifCard).join('')}</div>
    </div>`;
  }
  if (ready.length) {
    html += `<div>
      <div class="text-[10px] font-bold text-[#44474a] uppercase tracking-wider mb-2">Ready to Review</div>
      <div class="space-y-2">${ready.map(notifCard).join('')}</div>
    </div>`;
  }
  if (processing.length) {
    html += `<div>
      <div class="text-[10px] font-bold text-[#44474a] uppercase tracking-wider mb-2">Processing</div>
      <div class="space-y-2">${processing.map(notifCard).join('')}</div>
    </div>`;
  }
  if (error.length) {
    html += `<div>
      <div class="text-[10px] font-bold text-[#44474a] uppercase tracking-wider mb-2">Failed</div>
      <div class="space-y-2">${error.map(notifCard).join('')}</div>
    </div>`;
  }

  content.innerHTML = html;
}

function notifCard(scan) {
  const isVoice = scan.type === 'voice';
  const thumb = isVoice
    ? `<div class="w-11 h-11 rounded-2xl bg-[#f0fdf9] flex items-center justify-center flex-shrink-0 text-2xl">🎤</div>`
    : scan.thumbnailDataUrl
      ? `<img src="${scan.thumbnailDataUrl}" class="w-11 h-11 object-cover rounded-2xl flex-shrink-0" />`
      : `<div class="w-11 h-11 rounded-2xl bg-[#f0fdf9] flex items-center justify-center flex-shrink-0 text-2xl">${scan.isPdf ? '📄' : '🧾'}</div>`;

  const dismissBtn = `<button onclick="event.stopPropagation();notifDismiss('${scan.id}')"
    class="w-7 h-7 flex items-center justify-center text-[#44474a] hover:text-red-500 transition-colors flex-shrink-0">
    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
  </button>`;

  if (scan.status === 'ready') {
    const merchant = isVoice
      ? (scan.extractedData?.merchant || 'Voice input')
      : (scan.extractedData?.merchant || scan.fileName || 'Receipt');
    const currency = scan.extractedData?.currency || (kvGet('defaultCurrency') || 'EUR');
    const total    = scan.extractedData?.total != null ? fmtAmount(scan.extractedData.total, currency) : null;
    return `<div onclick="notifOpenScan('${scan.id}')"
      class="flex items-center gap-3 p-3 bg-[#f0fdf9] border border-[#6dfad2] rounded-2xl cursor-pointer active:opacity-70 transition-opacity">
      ${thumb}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5 mb-0.5">
          <span class="text-sm font-bold text-[#191c1d] truncate">${esc(merchant)}</span>
          <span class="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0"></span>
        </div>
        ${total ? `<div class="text-base font-bold text-[#006b55]">${total}</div>` : ''}
        <div class="text-xs text-emerald-600 font-medium mt-0.5">${isVoice ? 'Tap to add' : 'Tap to review &amp; add'} · ${timeAgo(scan.createdAt)}</div>
      </div>${dismissBtn}
    </div>`;
  }

  if (scan.status === 'processing') {
    const title = isVoice
      ? (scan.transcript ? `"${esc(scan.transcript.slice(0, 40))}${scan.transcript.length > 40 ? '…' : ''}"` : 'Voice input')
      : esc(scan.fileName || 'Receipt');
    return `<div class="flex items-center gap-3 p-3 bg-[#f8f9fa] rounded-2xl">
      ${thumb}
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-[#191c1d] truncate mb-0.5">${title}</div>
        <div class="text-xs text-[#44474a]">${isVoice ? 'Extracting with AI…' : 'Analyzing with AI…'} · ${timeAgo(scan.createdAt)}</div>
      </div>
      <span class="loader flex-shrink-0" style="width:18px;height:18px;border-width:2px;border-color:rgba(0,107,85,0.25);border-top-color:#006b55;"></span>
      ${dismissBtn}
    </div>`;
  }

  if (scan.status === 'error') {
    const title = isVoice
      ? (scan.transcript ? `"${esc(scan.transcript.slice(0, 40))}${scan.transcript.length > 40 ? '…' : ''}"` : 'Voice input')
      : esc(scan.fileName || 'Receipt');
    return `<div class="flex items-center gap-3 p-3 bg-[#fff5f5] border border-red-100 rounded-2xl">
      ${thumb}
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-[#191c1d] truncate mb-0.5">${title}</div>
        <div class="text-xs text-red-500 truncate">${esc(scan.errorMessage || 'Extraction failed')}</div>
        <div class="text-[10px] text-[#8a8d91] mt-0.5">${timeAgo(scan.createdAt)}</div>
      </div>
      <button onclick="event.stopPropagation();notifRetry('${scan.id}')"
        class="text-xs font-bold text-[#006b55] px-2.5 py-1 rounded-xl border border-[#006b55] flex-shrink-0 whitespace-nowrap mr-1">Retry</button>
      ${dismissBtn}
    </div>`;
  }
  return '';
}

function recurringNotifCard(r) {
  const col    = catColor(r.category);
  const defCur = kvGet('defaultCurrency') || 'EUR';
  return `<div class="flex items-center gap-3 p-3 bg-[#f0fdf9] border border-[#6dfad2] rounded-2xl">
    <div class="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 text-xl" style="background:${catBg(col)}">🔁</div>
    <div class="flex-1 min-w-0">
      <div class="text-sm font-bold text-[#191c1d] truncate">${esc(r.merchant)}</div>
      <div class="text-xs text-[#44474a]">${fmtAmount(r.amount, r.currency)}${r.currency !== defCur ? ' · ' + r.currency : ''} · ${esc(r.category)}</div>
      <div class="flex items-center gap-1.5 mt-2">
        <button onclick="event.stopPropagation();notifConfirmRecurring('${r.id}')"
          class="text-xs font-bold text-white bg-[#006b55] hover:bg-[#004d3f] px-2.5 py-1 rounded-xl flex-shrink-0 whitespace-nowrap transition-colors">Confirm</button>
        <button onclick="event.stopPropagation();notifModifyRecurring('${r.id}')"
          class="text-xs font-bold text-[#006b55] px-2.5 py-1 rounded-xl border border-[#006b55] flex-shrink-0 whitespace-nowrap">Modify</button>
        <button onclick="event.stopPropagation();notifSnoozeRecurring('${r.id}')"
          class="text-xs font-semibold text-[#44474a] px-2.5 py-1 rounded-xl border border-[#c5c6ca] flex-shrink-0 whitespace-nowrap">Remind later</button>
      </div>
    </div>
  </div>`;
}

function notifConfirmRecurring(id) {
  const list = getRecurring();
  const r = list.find(x => x.id === id);
  if (!r) return;
  showConfirm({
    title:   'Add this expense?',
    message: `Add ${fmtAmount(r.amount, r.currency)} for ${r.merchant} to this month's expenses?`,
    okLabel: 'Add',
    okColor: 'bg-[#006b55] hover:bg-[#004d3f]',
    onOk: () => {
      _recordRecurringExpense(r);
      saveRecurring(list);
      showToast(`${r.merchant} added to this month's expenses`);
      renderNotifications();
      updateNotificationBadge();
      if (document.getElementById('view-recurring')?.classList.contains('active')) loadRecurringView();
      if (document.getElementById('view-home')?.classList.contains('active'))      loadHome();
      if (document.getElementById('view-history')?.classList.contains('active'))  loadHistory();
    },
  });
}

function notifModifyRecurring(id) {
  closeNotifications();
  openRecurringForm(id, true);
}

let _snoozeTargetId = null;

function notifSnoozeRecurring(id) {
  _snoozeTargetId = id;
  const customInput = document.getElementById('snooze-custom-days');
  if (customInput) customInput.value = '';
  document.getElementById('snooze-overlay').classList.remove('hidden');
}

function snoozeCancel() {
  document.getElementById('snooze-overlay').classList.add('hidden');
  _snoozeTargetId = null;
}

function snoozeConfirm(days) {
  _applySnooze(_snoozeTargetId, days);
  snoozeCancel();
}

function snoozeConfirmCustom() {
  const raw  = document.getElementById('snooze-custom-days')?.value;
  const days = Math.max(1, Math.min(90, parseInt(raw, 10) || 0));
  if (!days) { showToast('Enter a valid number of days', true); return; }
  _applySnooze(_snoozeTargetId, days);
  snoozeCancel();
}

function _applySnooze(id, days) {
  const list = getRecurring();
  const r = list.find(x => x.id === id);
  if (!r) return;
  const until = new Date();
  until.setDate(until.getDate() + days);
  r.snoozed_until = until.toISOString().split('T')[0];
  saveRecurring(list);
  showToast(`Reminder snoozed for ${days} day${days > 1 ? 's' : ''}`);
  renderNotifications();
  updateNotificationBadge();
}

function notifOpenScan(id) {
  closeNotifications();
  resumePendingScan(id);
}

function notifDismiss(id) {
  showConfirm({
    title:   'Dismiss this notification?',
    message: 'This removes the pending scan. This cannot be undone.',
    okLabel: 'Dismiss',
    onOk: () => {
      dismissPendingScan(id);
      renderNotifications();
      updateNotificationBadge();
    },
  });
}

function notifRetry(id) {
  showConfirm({
    title:   'Retry this scan?',
    message: 'This will re-run AI extraction on this receipt.',
    okLabel: 'Retry',
    okColor: 'bg-[#006b55] hover:bg-[#004d3f]',
    onOk: async () => {
      await retryPendingScan(id);
      renderNotifications();
    },
  });
}

function clearAllNotifications() {
  showConfirm({
    title:   'Clear all notifications?',
    message: 'This removes all pending scans. This cannot be undone.',
    okLabel: 'Clear all',
    onOk: () => {
      getPendingScans().forEach(s => {
        _pendingScansAborts[s.id]?.abort();
        delete _pendingScansAborts[s.id];
        delete _pendingScansFiles[s.id];
        idbDeleteFile(s.id);
        _pendingVoiceAborts[s.id]?.abort();
        delete _pendingVoiceAborts[s.id];
      });
      savePendingScans([]);
      updateNotificationBadge();
      renderNotifications();
    },
  });
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
  const hintEl = document.getElementById("receipt-ref-hint");
  if (isPdf) {
    imgEl.classList.add("hidden");
    pdfEl.classList.remove("hidden");
    if (pdfName) pdfName.textContent = file.name;
    if (hintEl) hintEl.classList.add("hidden");
  } else {
    _receiptRefBlobUrl = URL.createObjectURL(file);
    imgEl.src = _receiptRefBlobUrl;
    imgEl.classList.remove("hidden");
    pdfEl.classList.add("hidden");
    if (hintEl) hintEl.classList.remove("hidden");
  }
  document.getElementById("receipt-ref-panel").classList.add("hidden");
  document.getElementById("receipt-ref-chevron").style.transform = "";
  strip.classList.remove("hidden");
  _refZoom.reset();
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

// ── History detail: view the original receipt image ─────────────────────────
let _detReceiptBlobUrl = null;

// Looks up the permanently-stored receipt for this expense (see idbPutReceipt
// in the save handler) and shows the strip if one exists; hides it otherwise.
async function loadDetReceiptRef(expenseId) {
  const file = await idbGetReceipt(expenseId);
  const strip = document.getElementById("det-receipt-strip");
  if (!strip) return;
  if (!file) { hideDetReceiptRef(); return; }

  if (_detReceiptBlobUrl) { URL.revokeObjectURL(_detReceiptBlobUrl); _detReceiptBlobUrl = null; }
  const isPdf = file.type === "application/pdf";
  const imgEl = document.getElementById("det-receipt-img");
  const pdfEl = document.getElementById("det-receipt-pdf");
  const pdfName = document.getElementById("det-receipt-pdf-name");
  const hintEl = document.getElementById("det-receipt-hint");
  if (isPdf) {
    imgEl.classList.add("hidden");
    pdfEl.classList.remove("hidden");
    if (pdfName) pdfName.textContent = file.name || "Receipt.pdf";
    if (hintEl) hintEl.classList.add("hidden");
  } else {
    _detReceiptBlobUrl = URL.createObjectURL(file);
    imgEl.src = _detReceiptBlobUrl;
    imgEl.classList.remove("hidden");
    pdfEl.classList.add("hidden");
    if (hintEl) hintEl.classList.remove("hidden");
  }
  document.getElementById("det-receipt-panel").classList.add("hidden");
  document.getElementById("det-receipt-chevron").style.transform = "";
  strip.classList.remove("hidden");
  _detReceiptZoom.reset();
}

function hideDetReceiptRef() {
  document.getElementById("det-receipt-strip")?.classList.add("hidden");
  if (_detReceiptBlobUrl) { URL.revokeObjectURL(_detReceiptBlobUrl); _detReceiptBlobUrl = null; }
  const imgEl = document.getElementById("det-receipt-img");
  if (imgEl) imgEl.src = "";
}

function toggleDetReceipt() {
  const panel = document.getElementById("det-receipt-panel");
  const chevron = document.getElementById("det-receipt-chevron");
  const open = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", open);
  chevron.style.transform = open ? "" : "rotate(180deg)";
}

function resetForm() {
  hideReceiptRef();
  const defaultCurrency = kvGet("defaultCurrency") || "EUR";
  document.getElementById("f-merchant").value      = "";
  document.getElementById("f-amount").value        = "";
  populateCurrencySelect("f-currency", defaultCurrency);
  setAmountSymbol(curSym(defaultCurrency));
  state.formItemsCurrency = defaultCurrency.toUpperCase();
  document.getElementById("f-date").value          = new Date().toISOString().split("T")[0];
  document.getElementById("f-notes").value         = "";
  document.getElementById("f-location").value      = "";
  document.getElementById("f-nearby-results").classList.add("hidden");
  const rateRow = document.getElementById("f-rate-row");
  if (rateRow) rateRow.style.display = "none";
  state.isIncome         = false;
  state.isRecurring      = false;
  state.recurringEditId  = null;
  state.recurringConfirmMode = false;
  state.recurringScope   = 'once';
  state.selectedCategory = null;
  state.originalCategory = null;
  state.selectedPayment  = null;
  state.receiptItems     = [];
  renderCatButtons(null);
  renderPaymentButtons(null, "payment-buttons");
  loadCustomBudgetSelect('f-budget-tag', null);
  document.querySelector('#f-budget-wrap .voice-budget-hint')?.remove();
  renderAddFormItems();
  checkAmountMismatch();
  updateAmountConvertedHint();

  const dateWrap = document.getElementById('f-date-wrap');
  if (dateWrap) dateWrap.classList.remove('hidden');
  const recurDayWrap = document.getElementById('f-recur-day-wrap');
  if (recurDayWrap) recurDayWrap.classList.add('hidden');
  const dayInput = document.getElementById('f-recur-day');
  if (dayInput) dayInput.value = '';
  document.getElementById('recur-scope-toggle-wrap')?.classList.add('hidden');
  document.getElementById('f-location-wrap').classList.remove('hidden');
  ['inline-add-currency-wrap', 'inline-add-category-form', 'inline-add-payment-form', 'inline-event-budget-form']
    .forEach(id => document.getElementById(id)?.classList.add('hidden'));
  const backBtn = document.getElementById('add-back-btn');
  if (backBtn) backBtn.setAttribute('onclick', "showView('add-method')");
}

// ── Receipt verify view ───────────────────────────────────────────────────────
let _verifyBlobUrl = null;

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
      document.getElementById("verify-zoom-hint")?.classList.add("hidden");
      panel.style.height = "55%";
      renderPdfPages(state.receiptFile);
    } else {
      imgEl.src = _verifyBlobUrl;
      imgEl.classList.remove("hidden");
      pdfEl.classList.add("hidden");
      if (zoomBtn) zoomBtn.classList.remove("hidden");
      document.getElementById("verify-zoom-hint")?.classList.remove("hidden");
      panel.style.height = "42%";
    }
  }

  _verifyZoomFullReset();
  panel.scrollTop = 0;
  panel.scrollLeft = 0;

  document.getElementById("v-merchant").value = data.merchant || "";
  if (data.total != null) document.getElementById("v-total").value = Number(data.total).toFixed(2);
  else document.getElementById("v-total").value = "";
  const code = data.currency ? data.currency.toUpperCase() : (kvGet("defaultCurrency") || "EUR");
  populateCurrencySelect("v-currency", code);
  document.getElementById("v-date").value = data.date || new Date().toISOString().split("T")[0];

  renderVerifyItems();
  updateVerifyTotalHint();
  showView("verify");
}

function renderVerifyItems() {
  const items = state.pendingReceiptData?.items || [];
  const countEl = document.getElementById("v-items-count");
  if (countEl) countEl.textContent = items.length > 0 ? `(${items.length})` : "";
  const code = document.getElementById("v-currency")?.value || "EUR";
  document.getElementById("v-items-list").innerHTML = items.map((item, i) => {
    const hint = convertedHint(parseFloat(item.price), code, null);
    return `
    <div class="space-y-0.5">
      <div class="flex items-center gap-2">
        <input type="text" value="${esc(item.name || "")}" placeholder="Item name"
               oninput="state.pendingReceiptData.items[${i}].name = this.value"
               class="flex-1 min-w-0 px-3 py-2 border border-[#c5c6ca] rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white" />
        <input type="number" value="${item.quantity != null ? item.quantity : 1}" placeholder="1" min="1" step="1"
               oninput="state.pendingReceiptData.items[${i}].quantity = this.value === '' ? 1 : parseInt(this.value)"
               class="w-12 px-2 py-2 border border-[#c5c6ca] rounded-xl text-xs text-center focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white" />
        <div class="flex items-center w-24 border border-[#c5c6ca] rounded-xl bg-white focus-within:ring-2 focus-within:ring-[#006b55]">
          <span class="pl-1.5 text-[10px] text-[#44474a] flex-shrink-0">${esc(curSym(code))}</span>
          <input type="number" value="${item.price != null ? item.price : ""}" placeholder="0.00" step="0.01"
                 oninput="state.pendingReceiptData.items[${i}].price = this.value === '' ? null : parseFloat(this.value); updateVerifyItemHint(${i})"
                 class="w-full min-w-0 pl-0.5 pr-1.5 py-2 text-xs text-right focus:outline-none bg-transparent border-0" />
        </div>
        <button type="button" onclick="removeVerifyItem(${i})"
                class="w-7 h-7 flex items-center justify-center text-[#44474a] hover:text-red-500 transition-colors flex-shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div id="v-item-hint-${i}" class="${hint ? "text-[9px] text-gray-400 text-right pr-9" : "hidden"}">${hint}</div>
    </div>`;
  }).join("");
}

function updateVerifyItemHint(i) {
  const el   = document.getElementById(`v-item-hint-${i}`);
  const item = state.pendingReceiptData?.items?.[i];
  if (!el || !item) return;
  const code = document.getElementById("v-currency")?.value || "EUR";
  const text = convertedHint(parseFloat(item.price), code, null);
  el.textContent = text;
  el.className   = text ? "text-[9px] text-gray-400 text-right pr-9" : "hidden";
}

function updateVerifyTotalHint() {
  const hint = document.getElementById("v-total-converted");
  if (!hint) return;
  const amount = parseFloat(document.getElementById("v-total")?.value);
  const code   = document.getElementById("v-currency")?.value;
  const text   = convertedHint(amount, code, null);
  hint.textContent = text;
  hint.classList.toggle("hidden", !text);
}

// The Verify screen's currency select only corrects a misread currency label
// (the raw numbers stay as extracted) — unlike the Add form, it does not
// convert values. Just refresh the unit labels and converted-amount hints.
function onVerifyCurrencyChange() {
  renderVerifyItems();
  updateVerifyTotalHint();
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

function syncItemsTotal() {
  const total = (state.receiptItems || []).reduce((sum, it) => {
    const price = parseFloat(it.price);
    return sum + (isNaN(price) ? 0 : price);
  }, 0);
  const amountEl = document.getElementById("f-amount");
  if (amountEl) amountEl.value = total > 0 ? (Math.round(total * 100) / 100).toFixed(2) : "";
  checkAmountMismatch();
}

function checkAmountMismatch() {
  const warn  = document.getElementById("amount-mismatch-warn");
  const valEl = document.getElementById("amount-mismatch-val");
  if (!warn) return;
  const items = state.receiptItems || [];
  if (items.length === 0) { warn.classList.add("hidden"); return; }
  const itemsTotal = Math.round(items.reduce((sum, it) => {
    const price = parseFloat(it.price);
    return sum + (isNaN(price) ? 0 : price);
  }, 0) * 100) / 100;
  const amountEl = document.getElementById("f-amount");
  const entered  = Math.round(parseFloat(amountEl?.value || "0") * 100) / 100;
  if (isNaN(entered) || Math.abs(itemsTotal - entered) <= 0.01) {
    warn.classList.add("hidden");
  } else {
    const cur = document.getElementById("f-currency")?.value || (kvGet("defaultCurrency") || "EUR");
    if (valEl) valEl.textContent = fmtAmount(itemsTotal, cur);
    warn.classList.remove("hidden");
  }
}

function renderAddFormItems() {
  const el = document.getElementById("items-list");
  if (!el) return;
  if (!state.receiptItems || state.receiptItems.length === 0) {
    el.innerHTML = `<div class="text-xs text-gray-400 text-center py-2 border border-dashed border-gray-200 rounded-xl">No items — tap "+ Add item" to add one</div>`;
    return;
  }
  const code = document.getElementById("f-currency")?.value || "EUR";
  const rate = parseFloat(document.getElementById("f-rate")?.value);
  el.innerHTML = state.receiptItems.map((item, i) => {
    const hint = convertedHint(parseFloat(item.price), code, isNaN(rate) ? null : rate);
    return `
    <div class="space-y-0.5">
      <div class="flex items-center gap-2">
        <input type="text" value="${esc(item.name || "")}" placeholder="Item name"
               oninput="state.receiptItems[${i}].name = this.value"
               class="flex-1 min-w-0 px-3 py-2 border border-[#c5c6ca] rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white" />
        <input type="text" inputmode="numeric" value="${item.quantity != null ? item.quantity : 1}" placeholder="1"
               oninput="const _q=this.value.replace(/[^0-9]/g,''); if(_q!==this.value)this.value=_q; state.receiptItems[${i}].quantity = _q === '' ? 1 : parseInt(_q); syncItemsTotal()"
               class="w-12 px-2 py-2 border border-[#c5c6ca] rounded-xl text-xs text-center focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white" />
        <div class="flex items-center w-24 border border-[#c5c6ca] rounded-xl bg-white focus-within:ring-2 focus-within:ring-[#006b55]">
          <span class="pl-1.5 text-[10px] text-[#44474a] flex-shrink-0">${esc(curSym(code))}</span>
          <input type="number" step="0.01" min="0" value="${item.price != null ? item.price : ""}" placeholder="0.00"
                 oninput="state.receiptItems[${i}].price = this.value === '' ? null : parseFloat(this.value); syncItemsTotal(); updateFormItemHint(${i})"
                 class="w-full min-w-0 pl-0.5 pr-1.5 py-2 text-xs text-right focus:outline-none bg-transparent border-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
        </div>
        <button type="button" onclick="removeFormItem(${i})"
                class="w-7 h-7 flex items-center justify-center text-[#44474a] hover:text-red-500 transition-colors flex-shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div id="f-item-hint-${i}" class="${hint ? "text-[9px] text-gray-400 text-right pr-9" : "hidden"}">${hint}</div>
    </div>`;
  }).join("");
}

// Refreshes a single item's "≈ <default currency>" hint without re-rendering
// the whole list, so typing in the price field doesn't lose focus.
function updateFormItemHint(i) {
  const el = document.getElementById(`f-item-hint-${i}`);
  const item = state.receiptItems?.[i];
  if (!el || !item) return;
  const code = document.getElementById("f-currency")?.value || "EUR";
  const rate = parseFloat(document.getElementById("f-rate")?.value);
  const text = convertedHint(parseFloat(item.price), code, isNaN(rate) ? null : rate);
  el.textContent = text;
  el.className   = text ? "text-[9px] text-gray-400 text-right pr-9" : "hidden";
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
  syncItemsTotal();
}

function toggleVerifyZoom() {
  const zoomedIn = _verifyZoom.toggle(2.5);
  document.getElementById("verify-zoom-icon-in").classList.toggle("hidden", zoomedIn);
  document.getElementById("verify-zoom-icon-out").classList.toggle("hidden", !zoomedIn);
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
  // Reset error-mode: restore normal panels, hide error panels
  document.getElementById("verify-divider")?.classList.remove("hidden");
  document.getElementById("verify-fields")?.classList.remove("hidden");
  document.getElementById("verify-confirm-row")?.classList.remove("hidden");
  document.getElementById("verify-error-panel")?.classList.add("hidden");
  document.getElementById("verify-error-action-row")?.classList.add("hidden");
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
    const defCur = (kvGet("defaultCurrency") || "EUR").toUpperCase();
    const sel    = document.getElementById("f-currency");
    if ([...sel.options].some(o => o.value === code)) sel.value = code;
    setAmountSymbol(curSym(code));
    updateRateRow("f", code, defCur, null);
    // Items were extracted in this same currency — track it so a later manual
    // currency switch (updateCurrencySymbol) converts items in lockstep instead
    // of leaving them stale in the old currency (which broke the sum check).
    state.formItemsCurrency = code;
  }
  if (data.date)     document.getElementById("f-date").value     = data.date;
  if (data.location) document.getElementById("f-location").value = data.location;
  if (data.notes)    document.getElementById("f-notes").value    = data.notes;

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

  renderAddFormItems();
  checkAmountMismatch();
  updateAmountConvertedHint();
  document.getElementById("save-label").textContent = "Confirm & Save";
}

// ── Voice input ───────────────────────────────────────────────────────────────
let _voiceStream       = null;
let _isRecording       = false;
let _liveWS            = null;
let _audioCtx          = null;
let _audioProcessor    = null;
let _liveTranscript    = '';
let _interimTranscript = '';
let _voiceFinalized    = false;
let _voiceOriginal     = '';
let _voiceCancelled    = false;
let _voiceAbort        = null;

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
  } else if (state === 'paused') {
    document.getElementById('vv-mic-wrap')?.classList.add('hidden');
    if (label) label.classList.add('hidden');
    document.getElementById('voice-subtitle')?.classList.add('hidden');
    document.getElementById('voice-confirm')?.classList.remove('hidden');
    if (status) status.textContent = 'Edit if needed, then continue or log.';
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

// ── Tear down mic + STT stream ────────────────────────────────────────────────
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
          const sub = document.getElementById('voice-subtitle');
          const fin = document.getElementById('voice-subtitle-final');
          const itr = document.getElementById('voice-subtitle-interim');
          if (msg.is_final) {
            _liveTranscript    += (_liveTranscript ? ' ' : '') + msg.transcript;
            _interimTranscript  = '';
            if (fin) fin.textContent = _liveTranscript;
            if (itr) itr.textContent = '';
          } else {
            _interimTranscript = msg.transcript;
            if (fin) fin.textContent = _liveTranscript;
            if (itr) itr.textContent = (_liveTranscript ? ' ' : '') + _interimTranscript;
          }
          if (sub) { sub.classList.remove('hidden'); sub.scrollTop = sub.scrollHeight; }
        } else if (msg.error) {
          console.warn('[STT] error:', msg.error);
          showToast('Transcription error: ' + msg.error, true);
        }
      } catch {}
    };

    _liveWS.onerror = ev => console.warn('[STT] WS error:', ev);
    _liveWS.onclose = () => {
      if (_audioProcessor) { _audioProcessor.disconnect(); _audioProcessor = null; }
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

  if (_audioProcessor) { _audioProcessor.disconnect(); _audioProcessor = null; }
  if (_audioCtx)       { try { _audioCtx.close(); } catch {} _audioCtx = null; }
  if (_voiceStream)    { _voiceStream.getTracks().forEach(t => t.stop()); _voiceStream = null; }

  // Fold any in-flight interim result into the final transcript before closing.
  if (_interimTranscript) {
    _liveTranscript   += (_liveTranscript ? ' ' : '') + _interimTranscript;
    _interimTranscript = '';
  }

  _vvSetState('processing');

  if (_liveWS && _liveWS.readyState === WebSocket.OPEN) {
    try { _liveWS.send(JSON.stringify({ type: 'stop' })); } catch {}
    // Give STT stream a moment to flush any remaining final results.
    setTimeout(() => finalizeVoiceTranscript(), 1500);
  } else {
    finalizeVoiceTranscript();
  }
}

// Read the final live transcript and show the editable confirmation panel.
// Guarded so it runs at most once per recording.
function finalizeVoiceTranscript() {
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

  const box = document.getElementById('vc-transcript');
  if (box) box.value = original;

  _vvSetState('paused');
}

// Resume recording — capture any edits from the textarea first, then re-open mic.
async function resumeVoiceRecording() {
  const edited = (document.getElementById('vc-transcript')?.value || '').trim();
  _liveTranscript    = edited;
  _interimTranscript = '';
  _voiceFinalized    = false;

  document.getElementById('voice-confirm')?.classList.add('hidden');

  const sub = document.getElementById('voice-subtitle');
  const fin = document.getElementById('voice-subtitle-final');
  const itr = document.getElementById('voice-subtitle-interim');
  if (fin) fin.textContent = _liveTranscript;
  if (itr) itr.textContent = '';
  if (sub && _liveTranscript) sub.classList.remove('hidden');

  document.getElementById('vv-mic-wrap')?.classList.remove('hidden');
  document.getElementById('voice-label')?.classList.remove('hidden');

  await startVoiceRecording();
}

// Send the (possibly edited) transcript to AI for expense extraction — runs in background.
function submitVoiceTranscript() {
  const transcript = (document.getElementById('vc-transcript')?.value || '').trim();
  if (!transcript) { showToast('Transcript is empty — please record something first.', true); return; }

  queueBackgroundVoice(transcript);
  resetVoiceBtn();
  showView('home');
  showToast('Extracting details in background…');
}

function queueBackgroundVoice(transcript) {
  const id = generateId();
  _pendingVoiceAborts[id] = new AbortController();

  const scans = getPendingScans();
  scans.push({
    id,
    type:          'voice',
    status:        'processing',
    transcript,
    extractedData: null,
    errorMessage:  null,
    createdAt:     new Date().toISOString(),
  });
  savePendingScans(scans);
  updateNotificationBadge();
  _runBackgroundVoice(id, transcript, _pendingVoiceAborts[id]);
}

async function _runBackgroundVoice(id, transcript, abort) {
  try {
    const formData = new FormData();
    formData.append('transcript', transcript);
    const eventBudgetNames = getCustomBudgets().filter(b => b.type === 'event' && !isBudgetArchived(b)).map(b => b.name);
    if (eventBudgetNames.length > 0) formData.append('event_budgets', JSON.stringify(eventBudgetNames));

    const resp = await postWithOverloadRetry('/api/voice_extract', formData, { signal: abort.signal });
    if (abort.signal.aborted) return;

    const scans = getPendingScans();
    const item  = scans.find(s => s.id === id);
    if (item) { item.status = 'ready'; item.extractedData = resp.data; savePendingScans(scans); }
    delete _pendingVoiceAborts[id];

    updateNotificationBadge();
    showToast('Voice ready — tap to add!');
  } catch (e) {
    if (e.name === 'AbortError' || abort.signal.aborted) return;

    const scans = getPendingScans();
    const item  = scans.find(s => s.id === id);
    if (item) { item.status = 'error'; item.errorMessage = e.message || 'Extraction failed'; savePendingScans(scans); }
    delete _pendingVoiceAborts[id];

    updateNotificationBadge();
    showToast('Voice extraction failed: ' + (e.message || 'unknown error'), true);
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
    const defCur = (kvGet("defaultCurrency") || "EUR").toUpperCase();
    const sel    = document.getElementById("f-currency");
    if ([...sel.options].some(o => o.value === code)) sel.value = code;
    setAmountSymbol(curSym(code));
    updateRateRow("f", code, defCur, null);
    state.formItemsCurrency = code;
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

  if (!isIncome) renderAddFormItems();
  updateAmountConvertedHint();

  // Auto-select event budget when Gemini matched one by name
  if (!isIncome && data.event_hint) {
    const budgets = getCustomBudgets().filter(b => b.type === 'event' && !isBudgetArchived(b));
    // Gemini returns the exact budget name when the list was sent; fall back to
    // case-insensitive substring match for the no-budget-list path.
    const match = budgets.find(b => b.name.toLowerCase() === data.event_hint.toLowerCase())
                ?? budgets.find(b => b.name.toLowerCase().includes(data.event_hint.toLowerCase())
                                  || data.event_hint.toLowerCase().includes(b.name.toLowerCase()));
    if (match) {
      const sel  = document.getElementById('f-budget-tag');
      const wrap = document.getElementById('f-budget-wrap');
      if (sel && [...sel.options].some(o => o.value === match.id)) {
        sel.value = match.id;
        if (wrap) {
          wrap.classList.remove('hidden');
          if (!wrap.querySelector('.voice-budget-hint')) {
            const lbl = document.createElement('div');
            lbl.className = 'voice-budget-hint text-[10px] text-emerald-600 font-semibold mt-1';
            lbl.textContent = `Suggested from voice: "${match.name}"`;
            wrap.appendChild(lbl);
          }
        }
      }
    }
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
  const defCur         = (kvGet("defaultCurrency") || "EUR").toUpperCase();
  const rateRaw        = parseFloat(document.getElementById("f-rate")?.value);
  const storedRate     = currency.toUpperCase() !== defCur && !isNaN(rateRaw) && rateRaw > 0 ? rateRaw : null;

  if (!merchant) { showToast(state.isIncome ? "Please enter a source" : "Please enter a merchant name", true); return; }
  if (!amount || isNaN(parseFloat(amount))) { showToast("Please enter a valid amount", true); return; }
  if ((state.receiptItems || []).some(it => it.price === null || it.price === undefined || it.price === "")) {
    showToast("Please enter a price for every item", true); return;
  }
  if ((state.receiptItems || []).length > 0) {
    const itemsTotal = (state.receiptItems).reduce((sum, it) => {
      const price = parseFloat(it.price);
      return sum + (isNaN(price) ? 0 : price);
    }, 0);
    const enteredAmount = Math.round(parseFloat(amount) * 100) / 100;
    if (Math.abs(Math.round(itemsTotal * 100) / 100 - enteredAmount) > 0.01) {
      showToast(`Total amount (${enteredAmount.toFixed(2)}) must match sum of items (${(Math.round(itemsTotal * 100) / 100).toFixed(2)})`, true);
      return;
    }
  }

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

    if (state.isRecurring) {
      const dayRaw = document.getElementById('f-recur-day')?.value;
      const dayVal = dayRaw ? Math.min(31, Math.max(1, parseInt(dayRaw, 10) || 1)) : null;
      const fields = { merchant, amount: Math.round(parseFloat(amount) * 100) / 100, currency, category, payment_method, notes, day_of_month: dayVal };

      btn.disabled = false;
      spinner.classList.add('hidden');
      label.textContent = 'Add Recurring Expense';

      if (state.recurringConfirmMode && state.recurringEditId) {
        // Scope (just this time vs. this & future) was already picked via
        // the toggle at the top of the form — no extra prompt needed here.
        _finishRecurringSave(fields, state.recurringScope === 'all' ? 'all' : 'once');
      } else {
        _finishRecurringSave(fields, state.recurringEditId ? 'all' : 'create');
      }
      return;
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
      }).then(r => r.json()).then(d => { if (d.centroids) saveCentroids({ ...getCentroids(), ...d.centroids }); }).catch(() => {});
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
      items:          state.receiptItems?.length ? state.receiptItems : [],
      source:         state.isReceipt ? "receipt" : state.isVoice ? "voice" : "manual",
      type:           state.isIncome ? "income" : "expense",
      budgetId:       (!state.isIncome && document.getElementById('f-budget-tag')?.value) || null,
      created_at:     new Date().toISOString(),
    };

    const expenses = getExpenses();
    expenses.push(expense);
    saveExpenses(expenses);
    state.expenseMap[expense.id] = expense;

    if (state.isReceipt && state.receiptFile) idbPutReceipt(expense.id, state.receiptFile);

    showToast(state.isIncome ? "Income saved!" : "Expense saved!");
    btn.disabled = false;
    spinner.classList.add("hidden");
    if (state.currentPendingScanId) {
      savePendingScans(getPendingScans().filter(s => s.id !== state.currentPendingScanId));
      delete _pendingScansFiles[state.currentPendingScanId];
      idbDeleteFile(state.currentPendingScanId);
      delete _pendingScansAborts[state.currentPendingScanId];
      state.currentPendingScanId = null;
      updateNotificationBadge();
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
let _historySelBudgets  = new Set();
let _historySelTime     = null;
let _historySelType     = null;
let _historySort        = 'date_desc';
let _historyCustomFrom  = '';
let _historyCustomTo    = '';
let _historyShowArchivedCats  = false;
let _historyShowArchivedPmts  = false;
let _histViewMode       = 'list';
let _historyFiltered    = [];
let _historyShownDays   = 5;
let _calYear            = new Date().getFullYear();
let _calMonth           = new Date().getMonth();

const HISTORY_TIME_OPTS = [
  { key: 'today',      label: 'Today' },
  { key: 'week',       label: 'This week' },
  { key: 'month',      label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: '3months',    label: 'Last 3 months' },
  { key: 'year',       label: 'This year' },
  { key: 'custom',     label: 'Custom range' },
];

const HISTORY_SORT_OPTS = [
  { key: 'date_desc',    label: 'Newest first' },
  { key: 'date_asc',     label: 'Oldest first' },
  { key: 'amount_desc',  label: 'Highest amount' },
  { key: 'amount_asc',   label: 'Lowest amount' },
  { key: 'merchant_asc', label: 'Name (A–Z)' },
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
  _historySelBudgets.clear();
  _historySelTime = null;
  _historySelType = null;
  _historySort = 'date_desc';
  _historyCustomFrom = '';
  _historyCustomTo = '';
  _historyShownDays = 5;
  _historyShowArchivedCats = false;
  _historyShowArchivedPmts = false;
  renderHistoryFilterSheet();
  updateHistoryFilterBadge();
  filterHistory();
}

function renderHistoryFilterSheet() {
  _renderHFChips('hf-sort',
    HISTORY_SORT_OPTS.map(o => o.key),
    k => _historySort === k,
    () => '#006b55',
    k => () => selectHistorySort(k),
    k => HISTORY_SORT_OPTS.find(o => o.key === k)?.label || k
  );

  const activeCatSet  = new Set(getAllCategories());
  const usedCats      = [...new Set(_historySorted.map(e => e.category).filter(Boolean))];
  const activeCats    = usedCats.filter(c => activeCatSet.has(c)).sort();
  const archivedCats  = usedCats.filter(c => !activeCatSet.has(c)).sort();

  _renderHFChips('hf-cat',
    ['All', ...activeCats, ...(archivedCats.length ? ['Archived'] : [])],
    cat => cat === 'Archived' ? _historyShowArchivedCats : (cat === 'All' ? _historySelCats.size === 0 : _historySelCats.has(cat)),
    cat => cat === 'All' || cat === 'Archived' ? '#006b55' : catColor(cat),
    cat => () => cat === 'Archived' ? toggleArchivedCats() : selectHistoryCat(cat),
    cat => cat === 'All' ? 'All' : cat === 'Archived' ? '🗄️ Archived' : catEmoji(cat) + ' ' + esc(cat)
  );

  const archivedCatEl = document.getElementById('hf-cat-archived');
  if (archivedCatEl) {
    archivedCatEl.classList.toggle('hidden', !_historyShowArchivedCats || !archivedCats.length);
    if (_historyShowArchivedCats) {
      _renderHFChips('hf-cat-archived',
        archivedCats,
        cat => _historySelCats.has(cat),
        cat => catColor(cat),
        cat => () => selectHistoryCat(cat),
        cat => '🗑️ ' + esc(cat)
      );
    }
  }

  const methods = [...new Set(_historySorted.map(e => e.payment_method).filter(Boolean))];
  const activePmtSet   = new Set(getPaymentMethods());
  const activeMethods  = methods.filter(m => activePmtSet.has(m)).sort();
  const archivedMethods = methods.filter(m => !activePmtSet.has(m)).sort();
  const pmSection = document.getElementById('hf-payment')?.closest('div.mb-4');
  if (pmSection) pmSection.style.display = methods.length ? '' : 'none';
  _renderHFChips('hf-payment',
    ['All', ...activeMethods, ...(archivedMethods.length ? ['Archived'] : [])],
    m => m === 'Archived' ? _historyShowArchivedPmts : (m === 'All' ? _historySelPayments.size === 0 : _historySelPayments.has(m)),
    () => '#006b55',
    m => () => m === 'Archived' ? toggleArchivedPmts() : selectHistoryPayment(m),
    m => m === 'All' ? 'All' : m === 'Archived' ? '🗄️ Archived' : paymentIcon(m) + ' ' + esc(m)
  );

  const archivedPmtEl = document.getElementById('hf-payment-archived');
  if (archivedPmtEl) {
    archivedPmtEl.classList.toggle('hidden', !_historyShowArchivedPmts || !archivedMethods.length);
    if (_historyShowArchivedPmts) {
      _renderHFChips('hf-payment-archived',
        archivedMethods,
        m => _historySelPayments.has(m),
        () => '#8a8d91',
        m => () => selectHistoryPayment(m),
        m => '🗑️ ' + esc(m)
      );
    }
  }

  _renderHFChips('hf-time',
    ['All', ...HISTORY_TIME_OPTS.map(o => o.key)],
    k => k === 'All' ? !_historySelTime : _historySelTime === k,
    () => '#006b55',
    k => () => selectHistoryTime(k),
    k => k === 'All' ? 'All' : HISTORY_TIME_OPTS.find(o => o.key === k)?.label || k
  );

  const customRange = document.getElementById('hf-custom-range');
  if (customRange) {
    customRange.classList.toggle('hidden', _historySelTime !== 'custom');
    const fromEl = document.getElementById('hf-custom-from');
    const toEl   = document.getElementById('hf-custom-to');
    if (fromEl) fromEl.value = _historyCustomFrom;
    if (toEl)   toEl.value   = _historyCustomTo;
  }

  _renderHFChips('hf-type',
    ['All', 'expense', 'income'],
    k => k === 'All' ? !_historySelType : _historySelType === k,
    k => k === 'income' ? '#16a34a' : '#006b55',
    k => () => selectHistoryType(k),
    k => k === 'All' ? 'All' : k === 'income' ? '📥 Income' : '📤 Expenses'
  );

  const budgetMap = Object.fromEntries(getCustomBudgets().map(b => [b.id, b]));
  const budgetIds = [...new Set(_historySorted.map(e => e.budgetId).filter(Boolean))];
  const budgetSection = document.getElementById('hf-budget')?.closest('div.mb-4');
  if (budgetSection) budgetSection.style.display = budgetIds.length ? '' : 'none';
  if (budgetIds.length) {
    _renderHFChips('hf-budget',
      ['All', ...budgetIds],
      id => id === 'All' ? _historySelBudgets.size === 0 : _historySelBudgets.has(id),
      id => id === 'All' ? '#006b55' : (budgetMap[id]?.color || '#006b55'),
      id => () => selectHistoryBudget(id),
      id => id === 'All' ? 'All' : esc(budgetMap[id]?.name || id)
    );
  }
}

function _renderHFChips(elId, items, isActiveFn, colorFn, onclickFn, labelFn) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  items.forEach(item => {
    const isActive = isActiveFn(item);
    const col      = colorFn(item);
    const bg       = isActive ? col : (isDark() ? '#1e1e1e' : '#f8f9fa');
    const text     = isActive ? 'white' : (isDark() ? '#b0b0b0' : '#44474a');
    const border   = isActive ? col : (isDark() ? '#333333' : '#e8e9ea');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all';
    btn.style.background = bg;
    btn.style.color = text;
    btn.style.borderColor = border;
    btn.innerHTML = labelFn(item);
    btn.addEventListener('click', onclickFn(item));
    el.appendChild(btn);
  });
}

function updateHistoryFilterBadge() {
  const count = _historySelCats.size + _historySelPayments.size + _historySelBudgets.size + (_historySelTime ? 1 : 0) + (_historySelType ? 1 : 0) + (_historySort !== 'date_desc' ? 1 : 0);
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

function toggleArchivedCats() {
  _historyShowArchivedCats = !_historyShowArchivedCats;
  renderHistoryFilterSheet();
}

function toggleArchivedPmts() {
  _historyShowArchivedPmts = !_historyShowArchivedPmts;
  renderHistoryFilterSheet();
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

function selectHistorySort(key) {
  _historySort = key;
  renderHistoryFilterSheet();
  updateHistoryFilterBadge();
  filterHistory();
}

function selectHistoryBudget(id) {
  if (id === 'All') {
    _historySelBudgets.clear();
  } else if (_historySelBudgets.has(id)) {
    _historySelBudgets.delete(id);
  } else {
    _historySelBudgets.add(id);
  }
  renderHistoryFilterSheet();
  updateHistoryFilterBadge();
  filterHistory();
}

function onCustomDateChange() {
  _historyCustomFrom = document.getElementById('hf-custom-from')?.value || '';
  _historyCustomTo   = document.getElementById('hf-custom-to')?.value   || '';
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
  if (_historySelBudgets.size > 0) {
    filtered = filtered.filter(e => e.budgetId && _historySelBudgets.has(e.budgetId));
  }
  if (_historySelTime) {
    if (_historySelTime === 'custom') {
      if (_historyCustomFrom || _historyCustomTo) {
        filtered = filtered.filter(e => {
          const d = e.date || '';
          if (_historyCustomFrom && d < _historyCustomFrom) return false;
          if (_historyCustomTo   && d > _historyCustomTo)   return false;
          return true;
        });
      }
    } else {
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
  _historyShownDays = 5;
  _historyFiltered = filtered;
  renderHistory(filtered);
}

function showMoreHistory() {
  _historyShownDays += 5;
  renderHistory(_historyFiltered);
}

function renderHistory(exps) {
  const listEl = document.getElementById("history-list");

  if (!exps || exps.length === 0) {
    listEl.innerHTML = `<div class="text-center text-gray-300 py-8">No transactions yet</div>`;
    return;
  }

  const defCur    = kvGet("defaultCurrency") || "EUR";
  const budgetMap = Object.fromEntries(getCustomBudgets().map(b => [b.id, b]));
  const grouped   = {};
  for (const exp of exps) {
    const d = exp.date || "Unknown";
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(exp);
  }
  const dates = Object.keys(grouped).sort();
  if (_historySort !== 'date_asc') dates.reverse();

  for (const d of dates) {
    if (_historySort === 'amount_desc') {
      grouped[d].sort((a, b) => convertToDefault(b.amount, b.currency, b.rate) - convertToDefault(a.amount, a.currency, a.rate));
    } else if (_historySort === 'amount_asc') {
      grouped[d].sort((a, b) => convertToDefault(a.amount, a.currency, a.rate) - convertToDefault(b.amount, b.currency, b.rate));
    } else if (_historySort === 'merchant_asc') {
      grouped[d].sort((a, b) => (a.merchant || '').localeCompare(b.merchant || ''));
    }
  }

  const visibleDates = dates.slice(0, _historyShownDays);
  const hasMore      = dates.length > visibleDates.length;

  const hasActiveFilter = _historySelCats.size > 0 || _historySelPayments.size > 0 ||
    _historySelBudgets.size > 0 || _historySelTime || _historySelType ||
    (document.getElementById('history-search')?.value || '').trim().length > 0;

  let totalHeader = '';
  if (hasActiveFilter) {
    const totalExp = exps.filter(isExpenseEntry).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
    const totalInc = exps.filter(isIncomeEntry).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
    const totalLabel = totalInc > 0 && totalExp > 0
      ? `↑${fmtAmount(totalInc, defCur)} ↓${fmtAmount(totalExp, defCur)}`
      : totalInc > 0 ? `+${fmtAmount(totalInc, defCur)}` : fmtAmount(totalExp, defCur);
    totalHeader = `<div class="flex items-center justify-between px-1 pb-2 mb-1 border-b border-[#e8e9ea]">
      <span class="text-xs text-[#44474a]">${exps.length} transaction${exps.length !== 1 ? 's' : ''}</span>
      <span class="text-sm font-bold text-[#191c1d]">${totalLabel}</span>
    </div>`;
  }

  let lastMonth = null;
  const listHtml = visibleDates.map(d => {
    const month = d.length >= 7 ? d.slice(0, 7) : null;
    let monthDivider = '';
    if (month && month !== lastMonth) {
      const label = new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      monthDivider = `<div class="flex items-center gap-2 pt-1 pb-0.5">
        <span class="text-[11px] font-bold text-[#44474a] uppercase tracking-wider">${label}</span>
        <div class="flex-1 h-px bg-[#e8e9ea]"></div>
      </div>`;
      lastMonth = month;
    }
    const dayExpenses = grouped[d].filter(isExpenseEntry).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
    const dayIncomes  = grouped[d].filter(isIncomeEntry).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
    const dayLabel    = dayIncomes > 0 && dayExpenses > 0
      ? `↑${fmtAmount(dayIncomes, defCur)} ↓${fmtAmount(dayExpenses, defCur)}`
      : dayIncomes > 0 ? `+${fmtAmount(dayIncomes, defCur)}` : fmtAmount(dayExpenses, defCur);
    const cards = grouped[d].map(exp => historyExpenseCard(exp, budgetMap)).join("");
    return `${monthDivider}
      <div>
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-bold text-gray-600">${fmtDateLabel(d)}</span>
          <span class="text-sm font-semibold text-gray-400">${dayLabel}</span>
        </div>
        <div class="space-y-2">${cards}</div>
      </div>`;
  }).join("");

  const showMoreBtn = hasMore
    ? `<button onclick="showMoreHistory()" class="w-full py-3 text-sm font-bold text-[#006b55] border border-[#e8e9ea] rounded-2xl bg-white hover:bg-[#f0fdf9] transition-colors">Show more</button>`
    : '';

  listEl.innerHTML = totalHeader + listHtml + showMoreBtn;
}

function historyExpenseCard(exp, budgetMap = {}) {
  const income = isIncomeEntry(exp);
  const col    = txnColor(exp);
  const em     = txnEmoji(exp);
  const badge  = income
    ? `<span class="text-[9px] px-1 py-0.5 rounded font-bold ml-1 bg-green-100 text-green-700">+ income</span>`
    : exp.source === "receipt"
    ? `<span class="text-[9px] px-1 py-0.5 rounded font-bold ml-1" style="background:${isDark()?"#1e1e1e":"#f0fdf9"};color:${isDark()?"#6dfad2":"#006b55"}">📷</span>`
    : exp.source === "voice"
    ? `<span class="text-[9px] bg-rose-100 text-rose-500 px-1 py-0.5 rounded font-bold ml-1">🎤</span>`
    : exp.source === "recurring"
    ? `<span class="text-[9px] px-1 py-0.5 rounded font-bold ml-1" style="background:${isDark()?"#1e2020":"#f0fdf9"};color:${isDark()?"#6dfad2":"#006b55"}">🔁</span>`
    : "";
  const notes  = exp.notes
    ? `<span class="text-gray-400 text-xs truncate ml-1">· ${esc(exp.notes)}</span>` : "";
  const budget = exp.budgetId ? budgetMap[exp.budgetId] : null;
  const budgetPill = budget
    ? `<span class="text-[9px] px-1.5 py-0.5 rounded-full font-semibold ml-1 text-white" style="background:${budget.color || '#006b55'}">${esc(budget.name)}</span>`
    : "";
  const defCur = (kvGet("defaultCurrency") || "EUR").toUpperCase();
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
        <div class="flex items-center flex-wrap mt-0.5 gap-x-1">
          <span class="text-[10px] px-1.5 py-0.5 rounded-full text-white font-semibold" style="background:${col}">${esc(exp.category)}</span>${budgetPill}${notes}
        </div>
      </div>
      <div class="text-right flex-shrink-0">
        <div class="font-bold text-sm" style="color:${amtColor}">${amtPrefix}${fmtAmount(exp.amount, exp.currency)}</div>
        ${cvt}
      </div>
    </div>`;
}

function deleteExpense(id) {
  if (!confirm("Delete this expense?")) return;
  const expenses = getExpenses().filter(e => e.id !== id);
  saveExpenses(expenses);
  delete state.expenseMap[id];
  idbDeleteReceipt(id);
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
  const defCur   = (kvGet('defaultCurrency') || 'EUR').toUpperCase();
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
  if (exp.source === "receipt") loadDetReceiptRef(exp.id); else hideDetReceiptRef();
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
  const amtHint = document.getElementById("det-amount-converted");
  const amtHintText = convertedHint(exp.amount, exp.currency, exp.rate ?? null);
  amtHint.textContent = amtHintText;
  amtHint.classList.toggle("hidden", !amtHintText);
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

  const isReceipt   = exp.source === "receipt";
  const isRecurring = exp.source === "recurring";
  const isVoiceSrc  = exp.source === "voice";
  document.getElementById("det-source-icon").textContent = isReceipt ? "📷" : isRecurring ? "🔁" : isVoiceSrc ? "🎙" : "💳";
  document.getElementById("det-source").textContent      = isReceipt ? "Scanned receipt" : isRecurring ? "Recurring expense" : isVoiceSrc ? "Voice entry" : "Manual entry";

  const itemsSect = document.getElementById("det-items-section");
  if (exp.items && exp.items.length > 0) {
    itemsSect.classList.remove("hidden");
    document.getElementById("det-items-list").innerHTML = exp.items.map(item => {
      const qty  = (item.quantity ?? 1) > 1 ? `<span class="text-[#44474a] mr-1">×${item.quantity}</span>` : "";
      const hint = item.price != null ? convertedHint(item.price, exp.currency, exp.rate ?? null) : "";
      const price = item.price != null
        ? `<div class="text-right flex-shrink-0">
             <span class="font-semibold">${fmtAmount(item.price, exp.currency)}</span>
             ${hint ? `<div class="text-[9px] text-gray-400">${hint}</div>` : ""}
           </div>` : "";
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
  hideDetReceiptRef();
}

// ── Edit mode ─────────────────────────────────────────────────────────────────
function openEdit() {
  const exp = state.expenseMap[state.currentEditId];
  if (!exp) return;

  const cur    = exp.currency || "EUR";
  const defCur = (kvGet("defaultCurrency") || "EUR").toUpperCase();
  document.getElementById("edit-merchant").value       = exp.merchant || "";
  document.getElementById("edit-amount").value         = exp.amount != null ? Number(exp.amount).toFixed(2) : "";
  populateCurrencySelect("edit-currency", cur);
  document.getElementById("edit-cur-sym").textContent  = curSym(cur);
  document.getElementById("edit-date").value           = exp.date || "";
  document.getElementById("edit-notes").value          = exp.notes || "";
  document.getElementById("edit-location").value       = exp.location || "";
  updateRateRow("edit", cur, defCur, exp.rate ?? null);

  const editIncome = isIncomeEntry(exp);
  state.editIsIncome = editIncome;
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

  const editBudgetWrap = document.getElementById('edit-budget-wrap');
  if (editBudgetWrap) editBudgetWrap.classList.toggle('hidden', editIncome);
  if (!editIncome) loadCustomBudgetSelect('edit-budget-tag', exp.budgetId || null);

  state.editItems         = (exp.items || []).map(i => ({ name: i.name || "", price: i.price ?? null, quantity: i.quantity ?? 1 }));
  state.editItemsCurrency = cur.toUpperCase();
  renderEditItems();
  updateEditAmountHint();

  ['edit-inline-add-currency-wrap', 'edit-inline-add-category-form', 'edit-inline-add-payment-form', 'edit-inline-event-budget-form']
    .forEach(id => document.getElementById(id)?.classList.add('hidden'));

  document.getElementById("det-view-mode").classList.add("hidden");
  document.getElementById("det-edit-mode").classList.remove("hidden");
  document.getElementById("detail-sheet").scrollTop = 0;
}

function updateEditCurrencyRate(fromCode) {
  const code   = (fromCode || "EUR").toUpperCase();
  const defCur = (kvGet("defaultCurrency") || "EUR").toUpperCase();
  document.getElementById("edit-cur-sym").textContent = curSym(code);
  updateRateRow("edit", code, defCur, null);
  convertItemPrices(state.editItems, state.editItemsCurrency, code);
  renderEditItems();
  state.editItemsCurrency = code;
  updateEditAmountHint();
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
  const code = document.getElementById("edit-currency")?.value || "EUR";
  const rate = parseFloat(document.getElementById("edit-rate")?.value);
  el.innerHTML = state.editItems.map((item, idx) => {
    const hint = convertedHint(parseFloat(item.price), code, isNaN(rate) ? null : rate);
    return `
    <div class="space-y-0.5">
      <div class="flex items-center gap-2">
        <input type="text" value="${esc(item.name)}" placeholder="Item name"
               oninput="state.editItems[${idx}].name = this.value"
               class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white min-w-0" />
        <input type="number" value="${item.quantity != null ? item.quantity : 1}" placeholder="1" min="1" step="1"
               oninput="state.editItems[${idx}].quantity = this.value === '' ? 1 : parseInt(this.value)"
               class="w-12 px-2 py-2 border border-gray-200 rounded-lg text-xs text-center focus:outline-none focus:ring-2 focus:ring-[#006b55] bg-white flex-shrink-0" />
        <div class="flex items-center w-24 border border-gray-200 rounded-lg bg-white focus-within:ring-2 focus-within:ring-[#006b55] flex-shrink-0">
          <span class="pl-1.5 text-[10px] text-gray-400 flex-shrink-0">${esc(curSym(code))}</span>
          <input type="number" value="${item.price ?? ""}" placeholder="0.00" step="0.01"
                 oninput="state.editItems[${idx}].price = this.value === '' ? null : parseFloat(this.value); updateEditItemHint(${idx})"
                 class="w-full min-w-0 pl-0.5 pr-1.5 py-2 text-xs text-right focus:outline-none bg-transparent border-0" />
        </div>
        <button type="button" onclick="removeEditItem(${idx})"
                class="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 text-gray-400 hover:bg-red-100 hover:text-red-500 flex-shrink-0 transition-colors text-sm">✕</button>
      </div>
      <div id="edit-item-hint-${idx}" class="${hint ? "text-[9px] text-gray-400 text-right pr-9" : "hidden"}">${hint}</div>
    </div>`;
  }).join("");
}

function updateEditItemHint(idx) {
  const el   = document.getElementById(`edit-item-hint-${idx}`);
  const item = state.editItems?.[idx];
  if (!el || !item) return;
  const code = document.getElementById("edit-currency")?.value || "EUR";
  const rate = parseFloat(document.getElementById("edit-rate")?.value);
  const text = convertedHint(parseFloat(item.price), code, isNaN(rate) ? null : rate);
  el.textContent = text;
  el.className   = text ? "text-[9px] text-gray-400 text-right pr-9" : "hidden";
}

function updateEditAmountHint() {
  const hint = document.getElementById("edit-amount-converted");
  if (!hint) return;
  const amount = parseFloat(document.getElementById("edit-amount")?.value);
  const code   = document.getElementById("edit-currency")?.value;
  const rate   = parseFloat(document.getElementById("edit-rate")?.value);
  const text   = convertedHint(amount, code, isNaN(rate) ? null : rate);
  hint.textContent = text;
  hint.classList.toggle("hidden", !text);
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
  const defCurE        = (kvGet("defaultCurrency") || "EUR").toUpperCase();
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
      }).then(r => r.json()).then(d => { if (d.centroids) saveCentroids({ ...getCentroids(), ...d.centroids }); }).catch(() => {});
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
      budgetId:       !isIncomeEntry(oldExp) ? (document.getElementById('edit-budget-tag')?.value || null) : null,
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
  const defCur = kvGet("defaultCurrency") || "EUR";
  document.getElementById("sum-month").textContent = fmtAmount(data.month_total, defCur);
  document.getElementById("sum-today").textContent = fmtAmount(data.today_total, defCur);
  renderPieChart(data.category_breakdown, defCur);
  renderBarChart(data.daily_chart, defCur);
  loadAiOverview(data.category_breakdown, defCur);
}

async function loadAiOverview(breakdown, defCur) {
  const el = document.getElementById("ai-overview-text");
  if (!el) return;

  const cached = JSON.parse(kvGet('flo_ai_overview_cache') || 'null');
  if (cached) {
    document.getElementById("ai-overview-card").classList.remove("hidden");
    el.textContent = cached.overview;
    const basedOnEl = document.getElementById("ai-overview-based-on");
    if (basedOnEl) basedOnEl.textContent = cached.basedOnText;
    return;
  }

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
    const basedOnText = retrieved.length
      ? `Compared to: ${retrieved.map(s => s.period).join(", ")}`
      : "No historical data yet — keep tracking to unlock comparisons!";
    const basedOnEl = document.getElementById("ai-overview-based-on");
    if (basedOnEl) basedOnEl.textContent = basedOnText;

    kvSet('flo_ai_overview_cache', JSON.stringify({ overview: data.overview, basedOnText }));
  } catch (e) {
    el.textContent = "Couldn't load insight: " + e.message;
  }
}

async function archiveCurrentMonth() {
  const data    = computeSummary();
  const defCur  = kvGet("defaultCurrency") || "EUR";
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
        borderWidth:     entries.length > 1 ? 2 : 0,
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
    err.retryable  = resp.retryable;
    err.errorCode  = resp.error_code || null;
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

  const storedCurrency = kvGet("defaultCurrency") || "EUR";
  populateCurrencySelect("s-currency", storedCurrency);
  renderCustomCurrenciesSettings();

  const rateEl  = document.getElementById("s-rates-date");
  const cached  = kvGet("flo_rates_" + storedCurrency);
  if (rateEl && cached) {
    try {
      const { data } = JSON.parse(cached);
      rateEl.textContent = `Exchange rates as of ${data.date} (ECB via frankfurter.app)`;
    } catch {}
  } else if (rateEl) {
    rateEl.textContent = "Exchange rates loaded on first view.";
  }
}

function loadBudgetsView() {
  _refreshBudgetStatus();
  loadCustomBudgetsPrefs();
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

// ── Reset Everything ──────────────────────────────────────────────────────────
const RESET_EVERYTHING_PHRASE = "RESET";

function confirmResetEverything() {
  showConfirm({
    title:   "Reset everything?",
    message: "This will permanently delete all expenses, budgets, categories, receipts and preferences stored in this browser. This cannot be undone.",
    okLabel: "Continue",
    onOk:    openResetEverythingDialog,
  });
}

function openResetEverythingDialog() {
  const input = document.getElementById("reset-everything-input");
  input.value = "";
  onResetEverythingInput();
  document.getElementById("reset-everything-overlay").classList.remove("hidden");
  input.focus();
}

function cancelResetEverything() {
  document.getElementById("reset-everything-overlay").classList.add("hidden");
}

function onResetEverythingInput() {
  const input  = document.getElementById("reset-everything-input");
  const okBtn  = document.getElementById("reset-everything-ok");
  const match  = input.value === RESET_EVERYTHING_PHRASE;
  okBtn.disabled  = !match;
  okBtn.className = `py-2.5 rounded-2xl text-sm font-semibold text-white transition-colors ${match ? "bg-red-600 hover:bg-red-700" : "bg-red-300 cursor-not-allowed"}`;
}

async function executeResetEverything() {
  const input = document.getElementById("reset-everything-input");
  if (input.value !== RESET_EVERYTHING_PHRASE) return;

  cancelResetEverything();
  try {
    // Close our own connection first so deleteDatabase isn't blocked by it.
    try { (await _openIdb()).close(); } catch {}
    // Wipe all IndexedDB-backed app data (kv_store, pending scans, receipts).
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(IDB_NAME);
      req.onsuccess   = resolve;
      req.onerror     = () => reject(req.error);
      req.onblocked   = resolve; // other tabs holding it open shouldn't block the reset
    });
    // Wipe any leftover data from older versions that stored directly in localStorage.
    localStorage.clear();
  } catch (e) {
    console.warn("resetEverything failed:", e);
  }
  location.reload();
}

function saveCurrency() {
  const currency = document.getElementById("s-currency").value;
  if (!currency) return;
  kvSet("defaultCurrency", currency);
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
  const defCur    = kvGet("defaultCurrency") || "EUR";
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

function setCbType(type) {
  _cbType = type;
  const activeClass  = 'flex-1 py-2 rounded-xl text-sm font-bold bg-[#006b55] text-white transition-colors';
  const inactiveClass = 'flex-1 py-2 rounded-xl text-sm font-bold border border-[#c5c6ca] text-[#44474a] hover:bg-[#f8f9fa] transition-colors';
  const evtBtn = document.getElementById('cb-type-event');
  const catBtn = document.getElementById('cb-type-category');
  if (evtBtn) evtBtn.className = type === 'event' ? activeClass : inactiveClass;
  if (catBtn) catBtn.className = type === 'category' ? activeClass : inactiveClass;
  document.getElementById('cb-event-fields')?.classList.toggle('hidden', type !== 'event');
  document.getElementById('cb-category-field')?.classList.toggle('hidden', type !== 'category');
  const nameLabel = document.querySelector('#cb-name')?.previousElementSibling;
  if (nameLabel) nameLabel.textContent = type === 'category' ? 'Budget Name (optional)' : 'Budget Name';
  const nameInput = document.getElementById('cb-name');
  if (nameInput) nameInput.placeholder = type === 'category' ? 'Defaults to category name' : 'e.g. Trip to Thailand';
}

function _renderCbSwatches() {
  const el = document.getElementById('cb-color-swatches');
  if (!el) return;
  el.innerHTML = CB_COLORS.map(c => `
    <button type="button" onclick="_cbSelectedColor='${c}';_renderCbSwatches()"
            class="w-7 h-7 rounded-full border-2 transition-all ${c === _cbSelectedColor ? 'border-[#191c1d] scale-110' : 'border-transparent'}"
            style="background:${c}"></button>`).join('');
}

function _renderCbList() {
  const listEl = document.getElementById('cb-list');
  if (!listEl) return;
  const budgets  = getCustomBudgets();
  const defCur   = kvGet('defaultCurrency') || 'EUR';
  if (budgets.length === 0) {
    listEl.innerHTML = '<div class="text-xs text-[#c5c6ca] text-center py-2">No custom budgets yet.</div>';
    return;
  }
  const active   = budgets.filter(b => !isBudgetArchived(b));
  const archived = budgets.filter(b =>  isBudgetArchived(b));

  const rowHtml = (b, isArchived) => {
    const spent     = computeCustomBudgetSpent(b);
    const pct       = Math.round((spent / b.amount) * 100);
    const typeLabel = b.type === 'category' ? `Category · ${b.category}` : (isArchived ? 'Event · Archived' : 'Event');
    return `
      <div class="flex items-center gap-3 py-2.5 border-t border-[#edeeef] ${isArchived ? 'opacity-60' : ''}">
        <div class="w-3 h-3 rounded-full flex-shrink-0" style="background:${isArchived ? '#94a3b8' : (b.color || '#006b55')}"></div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold text-[#191c1d] truncate">${esc(b.name)}</div>
          <div class="text-[10px] text-[#44474a]">${typeLabel} · ${fmtAmount(spent, defCur)} / ${fmtAmount(b.amount, defCur)} (${pct}%)</div>
        </div>
        <div class="flex gap-1 flex-shrink-0">
          <button onclick="editCustomBudget('${b.id}')"
                  class="text-[#006b55] text-xs font-bold px-2 py-1 rounded-lg hover:bg-[#f0fdf9] transition-colors">Edit</button>
          <button onclick="deleteCustomBudget('${b.id}')"
                  class="text-[#ef4444] text-xs font-bold px-2 py-1 rounded-lg hover:bg-red-50 transition-colors">Delete</button>
        </div>
      </div>`;
  };

  let html = active.map(b => rowHtml(b, false)).join('');

  if (archived.length > 0) {
    html += `<div class="text-[10px] font-bold text-[#44474a] uppercase tracking-wider pt-3 pb-1 border-t border-[#edeeef] mt-1">Archived</div>`;
    html += archived.map(b => rowHtml(b, true)).join('');
  }

  listEl.innerHTML = html || '<div class="text-xs text-[#c5c6ca] text-center py-2">No custom budgets yet.</div>';
}

function loadCustomBudgetsPrefs() {
  const defCur = kvGet('defaultCurrency') || 'EUR';
  const symEl  = document.getElementById('cb-budget-sym');
  if (symEl) symEl.textContent = curSym(defCur);
  const catSel = document.getElementById('cb-category');
  if (catSel) catSel.innerHTML = getAllCategories().map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  _renderCbSwatches();
  _renderCbList();
}

function saveCustomBudgetFromForm() {
  const amount = parseFloat(document.getElementById('cb-amount')?.value);
  if (!amount || amount <= 0) { showToast('Enter a valid amount', true); return; }

  let name      = document.getElementById('cb-name')?.value.trim();
  let category  = null;
  let startDate = null;
  let endDate   = null;
  if (_cbType === 'category') {
    category = document.getElementById('cb-category')?.value;
    if (!category) { showToast('Select a category', true); return; }
    if (!name) name = category;  // default name to category when left blank
  } else {
    if (!name) { showToast('Enter a budget name', true); return; }
    startDate = document.getElementById('cb-start')?.value || null;
    endDate   = document.getElementById('cb-end')?.value || null;
  }

  const budgets = getCustomBudgets();
  budgets.push({
    id:        generateId(),
    name,
    type:      _cbType,
    category,
    amount,
    startDate,
    endDate,
    color:     _cbSelectedColor,
    createdAt: new Date().toISOString(),
  });
  saveCustomBudgets(budgets);

  document.getElementById('cb-name').value   = '';
  document.getElementById('cb-amount').value = '';
  if (document.getElementById('cb-start')) document.getElementById('cb-start').value = '';
  if (document.getElementById('cb-end'))   document.getElementById('cb-end').value   = '';

  loadCustomBudgetsPrefs();
  renderCustomBudgetsHome();
  showToast('Budget created!');
}

function deleteCustomBudget(id) {
  showConfirm({
    title:   'Delete custom budget?',
    message: 'Expenses tagged to this budget will remain but lose the tag.',
    okLabel: 'Delete',
    okColor: 'bg-red-600 hover:bg-red-700',
    onOk: () => {
      saveCustomBudgets(getCustomBudgets().filter(b => b.id !== id));
      _renderCbList();
      renderCustomBudgetsHome();
      showToast('Budget deleted.');
    },
  });
}

function editCustomBudget(id) {
  const budget = getCustomBudgets().find(b => b.id === id);
  if (!budget) return;

  _cbEditId            = id;
  _cbEditType          = budget.type || 'event';
  _cbEditSelectedColor = budget.color || CB_COLORS[0];

  const defCur = kvGet('defaultCurrency') || 'EUR';
  const symEl  = document.getElementById('ecb-budget-sym');
  if (symEl) symEl.textContent = curSym(defCur);

  const catSel = document.getElementById('ecb-category');
  if (catSel) catSel.innerHTML = getAllCategories().map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  document.getElementById('ecb-name').value   = budget.name || '';
  document.getElementById('ecb-amount').value = budget.amount || '';
  if (document.getElementById('ecb-start')) document.getElementById('ecb-start').value = budget.startDate || '';
  if (document.getElementById('ecb-end'))   document.getElementById('ecb-end').value   = budget.endDate   || '';
  if (catSel && budget.category) catSel.value = budget.category;

  const isCategory = _cbEditType === 'category';
  document.getElementById('ecb-type-label').textContent = isCategory ? 'Category Budget' : 'Event Budget';
  document.getElementById('ecb-event-fields')?.classList.toggle('hidden', isCategory);
  document.getElementById('ecb-category-field')?.classList.toggle('hidden', !isCategory);
  const nameInput = document.getElementById('ecb-name');
  if (nameInput) nameInput.placeholder = isCategory ? 'Defaults to category name' : 'e.g. Trip to Thailand';

  _renderCbEditSwatches();
  document.getElementById('edit-custom-budget-overlay').classList.remove('hidden');
}

function closeEditCustomBudget() {
  document.getElementById('edit-custom-budget-overlay').classList.add('hidden');
  _cbEditId = null;
}

function _renderCbEditSwatches() {
  const el = document.getElementById('ecb-color-swatches');
  if (!el) return;
  el.innerHTML = CB_COLORS.map(c => `
    <button type="button" onclick="_cbEditSelectedColor='${c}';_renderCbEditSwatches()"
            class="w-7 h-7 rounded-full border-2 transition-all ${c === _cbEditSelectedColor ? 'border-[#191c1d] scale-110' : 'border-transparent'}"
            style="background:${c}"></button>`).join('');
}

function saveCustomBudgetEdit() {
  if (!_cbEditId) return;
  const amount = parseFloat(document.getElementById('ecb-amount')?.value);
  if (!amount || amount <= 0) { showToast('Enter a valid amount', true); return; }

  let name      = document.getElementById('ecb-name')?.value.trim();
  let category  = null;
  let startDate = null;
  let endDate   = null;

  if (_cbEditType === 'category') {
    category = document.getElementById('ecb-category')?.value;
    if (!category) { showToast('Select a category', true); return; }
    if (!name) name = category;
  } else {
    if (!name) { showToast('Enter a budget name', true); return; }
    startDate = document.getElementById('ecb-start')?.value || null;
    endDate   = document.getElementById('ecb-end')?.value   || null;
  }

  const budgets = getCustomBudgets().map(b => {
    if (b.id !== _cbEditId) return b;
    return { ...b, name, type: _cbEditType, category, amount, startDate, endDate, color: _cbEditSelectedColor };
  });
  saveCustomBudgets(budgets);

  closeEditCustomBudget();
  _renderCbList();
  renderCustomBudgetsHome();
  showToast('Budget updated!');
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
          <span class="flex-1 min-w-0 text-sm text-gray-700 font-medium truncate">${esc(merchant)}</span>
          <select data-merchant="${esc(merchant)}" data-role="override"
                  class="px-2 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-[#006b55]">
            ${allCats.map(c => `<option value="${esc(c)}"${c === cat ? " selected" : ""}>${esc(c)}</option>`).join("")}
          </select>
          <button data-merchant="${esc(merchant)}" data-role="delete-override"
                  class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm">✕</button>
        </div>`).join("")
    : `<div class="px-4 py-6 text-sm text-gray-400 text-center">No overrides yet.</div>`;

  const catSel = document.getElementById("new-override-category");
  catSel.innerHTML = allCats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");

  list.onchange = (e) => {
    const sel = e.target.closest('[data-role="override"]');
    if (sel) updateOverride(sel.dataset.merchant, sel.value);
  };
  list.onclick = (e) => {
    const btn = e.target.closest('[data-role="delete-override"]');
    if (btn) deleteOverride(btn.dataset.merchant);
  };
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
        const isProtected = cat === "Others";
        const emojiEl = `<input type="text" value="${esc(emoji)}" data-cat="${esc(cat)}" data-role="emoji"
                    title="Tap to change emoji"
                    class="w-9 h-9 text-center text-xl border border-transparent hover:border-[#c5c6ca] focus:border-[#006b55] rounded-xl p-0.5 bg-transparent focus:outline-none focus:bg-white cursor-pointer flex-shrink-0" />`;
        const nameEl = `<input type="text" value="${esc(cat)}" data-cat="${esc(cat)}" data-role="name"
                    title="${isProtected ? "The Others category can't be renamed" : "Tap to rename"}" ${isProtected ? "readonly" : ""}
                    class="flex-1 min-w-0 px-1 py-0.5 text-sm font-medium border border-transparent rounded-lg bg-transparent focus:outline-none ${isProtected ? "text-gray-400 cursor-default" : "text-gray-700 hover:border-[#c5c6ca] focus:border-[#006b55] focus:bg-white cursor-pointer"}" />`;
        return `
          <div class="flex items-center gap-3 px-4 py-3">
            ${emojiEl}
            ${nameEl}
            ${tag}
            <button data-cat="${esc(cat)}" data-role="delete"
                    class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm">✕</button>
          </div>`;
      }).join("")
    : `<div class="px-4 py-6 text-sm text-gray-400 text-center">No categories yet.</div>`;

  list.onchange = (e) => {
    const emojiInput = e.target.closest('[data-role="emoji"]');
    if (emojiInput) { updateCategoryEmoji(emojiInput.dataset.cat, emojiInput.value); return; }
    const nameInput = e.target.closest('[data-role="name"]');
    if (nameInput) renameCategory(nameInput.dataset.cat, nameInput.value);
  };
  list.onclick = (e) => {
    const btn = e.target.closest('[data-role="delete"]');
    if (btn) deleteCategory(btn.dataset.cat);
  };
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

function renameCategory(oldName, newInput) {
  if (oldName === "Others") { loadCategoriesView(); return; }
  const name = sanitizeCategoryName(newInput);
  if (!name || name === oldName) { loadCategoriesView(); return; }
  const dup = getAllCategories().some(c => c !== oldName && c.toLowerCase() === name.toLowerCase());
  if (dup) { showToast("Category already exists.", true); loadCategoriesView(); return; }

  const emoji = catEmoji(oldName);
  const data  = getCentroids() || { categories: {}, custom_categories: [], custom_category_emojis: {}, overrides: {} };

  if (data.categories?.[oldName]) {
    data.categories[name] = data.categories[oldName];
    delete data.categories[oldName];
  }
  data.custom_categories = (data.custom_categories || []).filter(c => c !== oldName);
  data.custom_categories.push(name);

  data.custom_category_emojis = data.custom_category_emojis || {};
  delete data.custom_category_emojis[oldName];
  data.custom_category_emojis[name] = emoji;

  data.overrides = data.overrides || {};
  Object.keys(data.overrides).forEach(m => {
    if (data.overrides[m] === oldName) data.overrides[m] = name;
  });
  saveCentroids(data);

  const expenses = getExpenses();
  let changed = false;
  expenses.forEach(e => {
    if (isExpenseEntry(e) && e.category === oldName) { e.category = name; changed = true; }
  });
  if (changed) saveExpenses(expenses);

  const budgets = getCustomBudgets();
  let budgetsChanged = false;
  budgets.forEach(b => {
    if (b.type === "category" && b.category === oldName) {
      if (b.name === oldName) b.name = name;
      b.category = name;
      budgetsChanged = true;
    }
  });
  if (budgetsChanged) saveCustomBudgets(budgets);

  const recurring = getRecurring();
  let recurringChanged = false;
  recurring.forEach(r => {
    if (r.category === oldName) { r.category = name; recurringChanged = true; }
  });
  if (recurringChanged) saveRecurring(recurring);

  loadCategoriesView();
  loadCategoriesIntoButtons();
  loadOverrides();
  showToast(`Renamed to "${name}".`);
}

function addCustomCategory() {
  const nameInput  = document.getElementById("new-category-name");
  const emojiInput = document.getElementById("new-category-emoji");
  const name  = sanitizeCategoryName(nameInput.value);
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
        const isProtected = cat === "Other Income";
        const safeCat  = cat.replace(/'/g, "\\'");
        const emojiEl = `<input type="text" value="${esc(emoji)}"
                    title="Tap to change emoji"
                    class="w-9 h-9 text-center text-xl border border-transparent hover:border-[#c5c6ca] focus:border-[#006b55] rounded-xl p-0.5 bg-transparent focus:outline-none focus:bg-white cursor-pointer flex-shrink-0"
                    onchange="updateIncomeCategoryEmoji('${safeCat}', this.value)" />`;
        const nameEl = `<input type="text" value="${esc(cat)}"
                    title="${isProtected ? "The Other Income category can't be renamed" : "Tap to rename"}" ${isProtected ? "readonly" : ""}
                    class="flex-1 min-w-0 px-1 py-0.5 text-sm font-medium border border-transparent rounded-lg bg-transparent focus:outline-none ${isProtected ? "text-gray-400 cursor-default" : "text-gray-700 hover:border-[#c5c6ca] focus:border-[#006b55] focus:bg-white cursor-pointer"}"
                    onchange="renameIncomeCategory('${safeCat}', this.value)" />`;
        const delBtn = isCustom
          ? `<button onclick="deleteIncomeCategory('${safeCat}')"
                     class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm">✕</button>`
          : `<div class="w-7 h-7 flex-shrink-0"></div>`;
        return `
          <div class="flex items-center gap-3 px-4 py-3">
            ${emojiEl}
            ${nameEl}
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

function renameIncomeCategory(oldName, newInput) {
  if (oldName === "Other Income") { loadIncomeCategoriesSection(); return; }
  const name = sanitizeCategoryName(newInput);
  if (!name || name === oldName) { loadIncomeCategoriesSection(); return; }
  const dup = getAllIncomeCategories().some(c => c !== oldName && c.toLowerCase() === name.toLowerCase());
  if (dup) { showToast("Income category already exists.", true); loadIncomeCategoriesSection(); return; }

  const emoji = incomeCatEmoji(oldName);

  if (INCOME_CATEGORIES.includes(oldName)) {
    const removed = getRemovedIncomeCategories();
    removed.push(oldName);
    saveRemovedIncomeCategories(removed);
  } else {
    saveCustomIncomeCategories(getCustomIncomeCategories().filter(c => c !== oldName));
  }
  const custom = getCustomIncomeCategories();
  custom.push(name);
  saveCustomIncomeCategories(custom);

  const emojiMap = getIncomeEmojis();
  delete emojiMap[oldName];
  emojiMap[name] = emoji;
  saveIncomeEmojis(emojiMap);

  const expenses = getExpenses();
  let changed = false;
  expenses.forEach(e => {
    if (isIncomeEntry(e) && e.category === oldName) { e.category = name; changed = true; }
  });
  if (changed) saveExpenses(expenses);

  loadIncomeCategoriesSection();
  showToast(`Renamed to "${name}".`);
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
        const emojiEl = `<input type="text" value="${esc(emoji)}" data-method="${esc(m)}" data-role="emoji"
                    title="Tap to change emoji"
                    class="w-9 h-9 text-center text-xl border border-transparent hover:border-[#c5c6ca] focus:border-[#006b55] rounded-xl p-0.5 bg-transparent focus:outline-none focus:bg-white cursor-pointer flex-shrink-0" />`;
        const nameEl = `<input type="text" value="${esc(m)}" data-method="${esc(m)}" data-role="name"
                    title="Tap to rename"
                    class="flex-1 min-w-0 px-1 py-0.5 text-sm font-medium border border-transparent rounded-lg bg-transparent focus:outline-none text-gray-700 hover:border-[#c5c6ca] focus:border-[#006b55] focus:bg-white cursor-pointer" />`;
        return `
          <div class="flex items-center gap-3 px-4 py-3">
            ${emojiEl}
            ${nameEl}
            ${tag}
            <button data-method="${esc(m)}" data-role="delete"
                    class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm">✕</button>
          </div>`;
      }).join("")
    : `<div class="px-4 py-6 text-sm text-gray-400 text-center">No payment methods.</div>`;

  list.onchange = (e) => {
    const emojiInput = e.target.closest('[data-role="emoji"]');
    if (emojiInput) { updatePaymentMethodEmoji(emojiInput.dataset.method, emojiInput.value); return; }
    const nameInput = e.target.closest('[data-role="name"]');
    if (nameInput) renamePaymentMethod(nameInput.dataset.method, nameInput.value);
  };
  list.onclick = (e) => {
    const btn = e.target.closest('[data-role="delete"]');
    if (btn) deletePaymentMethod(btn.dataset.method);
  };
}

function updatePaymentMethodEmoji(method, newEmoji) {
  const emoji  = (newEmoji || "").trim() || "💳";
  const emojis = getPaymentEmojis();
  emojis[method] = emoji;
  savePaymentEmojis(emojis);
  loadPaymentMethodsView();
  renderPaymentButtons(state.selectedPayment, "payment-buttons");
  if (state.editPayment !== undefined) renderPaymentButtons(state.editPayment, "edit-payment-buttons");
  showToast("Emoji updated!");
}

function renamePaymentMethod(oldName, newInput) {
  const name = sanitizeCategoryName(newInput);
  if (!name || name === oldName) { loadPaymentMethodsView(); return; }
  const dup = getPaymentMethods().some(m => m !== oldName && m.toLowerCase() === name.toLowerCase());
  if (dup) { showToast("Payment method already exists.", true); loadPaymentMethodsView(); return; }

  const emoji = paymentIcon(oldName);
  const methods = getPaymentMethods().map(m => m === oldName ? name : m);
  savePaymentMethods(methods);

  const emojis = getPaymentEmojis();
  delete emojis[oldName];
  emojis[name] = emoji;
  savePaymentEmojis(emojis);

  const expenses = getExpenses();
  let changed = false;
  expenses.forEach(e => {
    if (e.payment_method === oldName) { e.payment_method = name; changed = true; }
  });
  if (changed) saveExpenses(expenses);

  const recurring = getRecurring();
  let recurringChanged = false;
  recurring.forEach(r => {
    if (r.payment_method === oldName) { r.payment_method = name; recurringChanged = true; }
  });
  if (recurringChanged) saveRecurring(recurring);

  loadPaymentMethodsView();
  renderPaymentButtons(state.selectedPayment, "payment-buttons");
  if (state.editPayment !== undefined) renderPaymentButtons(state.editPayment, "edit-payment-buttons");
  showToast(`Renamed to "${name}".`);
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
      newOnes.forEach(e => { if (e.category) e.category = sanitizeCategoryName(e.category); });

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

      // Auto-add payment methods missing from settings
      const knownMethods = new Set(getPaymentMethods().map(m => m.toLowerCase()));
      const newMethods   = [...new Set(
        newOnes.filter(e => e.payment_method && !knownMethods.has(e.payment_method.toLowerCase()))
               .map(e => e.payment_method)
      )];
      if (newMethods.length) {
        const methods = getPaymentMethods();
        for (const m of newMethods) {
          if (!methods.map(x => x.toLowerCase()).includes(m.toLowerCase())) methods.push(m);
        }
        savePaymentMethods(methods);
      }

      const allExpenses = [...existing, ...newOnes];
      saveExpenses(allExpenses);
      rebuildSummariesFromExpenses(allExpenses);
      document.getElementById("import-file").value = "";

      const addedParts = [];
      if (newExpCats.length) addedParts.push(`${newExpCats.length} expense categor${newExpCats.length !== 1 ? "ies" : "y"}`);
      if (newIncCats.length) addedParts.push(`${newIncCats.length} income categor${newIncCats.length !== 1 ? "ies" : "y"}`);
      if (newMethods.length) addedParts.push(`${newMethods.length} payment method${newMethods.length !== 1 ? "s" : ""}`);
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

// ── Recurring Expenses ────────────────────────────────────────────────────────
function clampDayOfMonth(yearMonth, day) {
  const d = parseInt(day, 10);
  const [y, m] = yearMonth.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  if (!d || isNaN(d) || d < 1) return 1;
  return Math.min(d, daysInMonth);
}

// Recurring items awaiting user confirmation this month (due, not yet recorded, not snoozed).
function getDueRecurring() {
  const now         = new Date();
  const yearMonth    = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const todayStr     = now.toISOString().split('T')[0];
  const todayDay     = now.getDate();
  return getRecurring().filter(r => {
    if (r.enabled === false) return false;
    if (r.last_generated === yearMonth) return false;
    if (r.snoozed_until && r.snoozed_until > todayStr) return false;
    return todayDay >= clampDayOfMonth(yearMonth, r.day_of_month);
  });
}

// Records this month's expense from a recurring template (or a one-off
// `overrideFields` set, for a "just this time" edit) and marks the template
// generated for this month. Does NOT persist `r` itself — caller saves it.
function _recordRecurringExpense(r, overrideFields = null) {
  const fields    = overrideFields || r;
  const now       = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const day       = clampDayOfMonth(yearMonth, fields.day_of_month);
  const dateStr   = `${yearMonth}-${String(day).padStart(2, '0')}`;

  const expenses = getExpenses();
  expenses.push({
    id:             generateId(),
    date:           dateStr,
    merchant:       fields.merchant,
    amount:         fields.amount,
    currency:       fields.currency,
    rate:           null,
    category:       fields.category,
    confidence:     1.0,
    payment_method: fields.payment_method || '',
    notes:          fields.notes || '',
    location:       '',
    items:          [],
    source:         'recurring',
    type:           'expense',
    created_at:     new Date().toISOString(),
  });
  saveExpenses(expenses);
  r.last_generated = yearMonth;
  delete r.snoozed_until;
}

// Due recurring expenses no longer auto-insert — they surface in the
// notifications panel and only become real expenses once the user confirms.
function checkRecurringExpenses() {
  updateNotificationBadge();
}

// Persists a recurring-form submission. `mode` is 'create' (new template),
// 'all' (update template, and — in confirm mode — record this month using
// the updated template), or 'once' (record this month with `fields` but
// leave the stored template untouched).
function _finishRecurringSave(fields, mode) {
  const list = getRecurring();
  let item, toastMsg;

  if (mode === 'create') {
    item = { id: generateId(), ...fields, enabled: true, last_generated: '' };
    list.push(item);
    toastMsg = 'Recurring expense added';
  } else {
    item = list.find(r => r.id === state.recurringEditId);
    if (!item) { resetForm(); showView('recurring'); return; }

    if (mode === 'once') {
      _recordRecurringExpense(item, fields);
      toastMsg = `${fields.merchant} added to this month's expenses (this time only)`;
    } else {
      Object.assign(item, fields);
      if (state.recurringConfirmMode) {
        _recordRecurringExpense(item);
        toastMsg = `${item.merchant} added to this month's expenses`;
      } else {
        toastMsg = 'Recurring expense updated';
      }
    }
  }

  saveRecurring(list);
  updateNotificationBadge();
  showToast(toastMsg);
  resetForm();
  showView('recurring');
}

function loadRecurringView() {
  const list      = getRecurring();
  const container = document.getElementById('recurring-list');
  if (!list.length) {
    container.innerHTML = `<div class="text-sm text-[#44474a] text-center py-6">No recurring expenses yet.</div>`;
    return;
  }

  const defCur = kvGet('defaultCurrency') || 'EUR';
  container.innerHTML = list.map(r => {
    const col = catColor(r.category);
    return `
      <div class="bg-white rounded-3xl border border-[#e8e9ea] shadow-sm overflow-hidden">
        <div class="flex items-center gap-3 px-4 py-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-0.5">
              <span class="text-sm font-semibold text-[#191c1d] truncate">${esc(r.merchant)}</span>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold text-white flex-shrink-0"
                    style="background:${col}">${catEmoji(r.category)} ${esc(r.category)}</span>
            </div>
            <div class="text-xs text-[#44474a]">${fmtAmount(r.amount, r.currency)}${r.currency !== defCur ? ' · ' + r.currency : ''} · Day ${r.day_of_month || 1}${r.payment_method ? ' · ' + esc(r.payment_method) : ''}${r.notes ? ' · ' + esc(r.notes) : ''}</div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <button onclick="openRecurringForm('${r.id}')"
                    class="w-7 h-7 rounded-xl bg-[#f8f9fa] flex items-center justify-center text-[#44474a] hover:bg-[#e8e9ea] transition-colors text-xs">✏️</button>
            <button onclick="deleteRecurringItem('${r.id}')"
                    class="w-7 h-7 rounded-xl bg-[#fff0f0] flex items-center justify-center text-red-400 hover:bg-red-100 transition-colors text-xs">✕</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function deleteRecurringItem(id) {
  showConfirm({
    title:   'Delete recurring expense?',
    message: 'This will stop future reminders. Past expenses are kept.',
    okLabel: 'Delete',
    okColor: 'bg-red-500 hover:bg-red-600',
    onOk:    () => { saveRecurring(getRecurring().filter(r => r.id !== id)); loadRecurringView(); },
  });
}


function openRecurringForm(id, confirmMode = false) {
  const item = id ? getRecurring().find(r => r.id === id) : null;
  showView('add');
  setRecurringMode(item, confirmMode);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function hydrateCentroids() {
  const cached = getCentroids();
  try {
    const r = await fetch("/api/base_centroids");
    if (!r.ok) return;
    const base = await r.json();
    // Cached centroids were built with a different embedding model or
    // encoding version (e.g. after a server-side model swap or a
    // preprocessing fix) — their vectors are incompatible with fresh
    // embeddings, so drop them and start over from the base model.
    if (!cached || cached.model !== base.model || cached.embedding_version !== base.embedding_version) {
      saveCentroids(base);
    }
  } catch (e) { console.warn("base centroid fetch failed:", e); }
}

async function init() {
  await hydrateKvCache(); // must resolve before anything below reads kv-backed data

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

  // Restore full-res receipt files from IndexedDB so a refreshed page can still
  // retry/verify pending scans instead of demanding a re-upload; also drop any
  // orphaned entries left behind by scans that no longer exist.
  (async () => {
    const liveIds = new Set(_staleScans.filter(s => s.type !== 'voice').map(s => s.id));
    for (const id of liveIds) {
      if (!_pendingScansFiles[id]) {
        const file = await idbGetFile(id);
        if (file) _pendingScansFiles[id] = file;
      }
    }
    for (const key of await idbGetAllKeys()) {
      if (!liveIds.has(key)) idbDeleteFile(key);
    }
  })();

  checkRecurringExpenses();
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
  document.getElementById('main-scroll')?.addEventListener('scroll', () => {
    const btn = document.getElementById('history-scroll-top');
    if (!btn) return;
    const scroller = document.getElementById('main-scroll');
    const onScrollable = document.getElementById('view-history')?.classList.contains('active') ||
                         document.getElementById('view-home')?.classList.contains('active');
    btn.classList.toggle('hidden', !onScrollable || scroller.scrollTop < 200);
  });
  _initReceiptZoom();
  _initVerifyZoom();
  _initRefZoom();
  _initDetReceiptZoom();
  loadCategoriesIntoButtons();
  const defaultCurrency = kvGet("defaultCurrency") || "EUR";
  populateCurrencySelect("f-currency", defaultCurrency);
  setAmountSymbol(curSym(defaultCurrency));
  renderPaymentButtons(null, "payment-buttons");
}

init();
