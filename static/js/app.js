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
function getCustomCurrencies() {
  const s = localStorage.getItem('flo_custom_currencies');
  return s ? JSON.parse(s) : [];
}
function saveCustomCurrencies(c) { localStorage.setItem('flo_custom_currencies', JSON.stringify(c)); }

function generateId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}

function computeSummary() {
  const expenses  = getExpenses();
  const today     = new Date().toISOString().split('T')[0];
  const thisMonth = today.slice(0, 7);

  const todayTotal = expenses.filter(e => e.date === today).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
  const monthTotal = expenses.filter(e => (e.date || '').startsWith(thisMonth)).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);

  const catBreakdown = {};
  expenses.filter(e => (e.date || '').startsWith(thisMonth)).forEach(e => {
    const cat = e.category || 'Others';
    catBreakdown[cat] = (catBreakdown[cat] || 0) + convertToDefault(e.amount, e.currency, e.rate);
  });

  const daysData = [];
  for (let i = 6; i >= 0; i--) {
    const d     = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
    const total = expenses.filter(e => e.date === d).reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
    daysData.push({ date: d, total: Math.round(total * 100) / 100 });
  }

  const recent = expenses
    .filter(e => (e.date || '').startsWith(thisMonth))
    .sort((a, b) => {
      const ka = (a.date || '') + (a.created_at || '');
      const kb = (b.date || '') + (b.created_at || '');
      return kb > ka ? 1 : -1;
    })
    .slice(0, 5);

  return {
    today_total:        Math.round(todayTotal * 100) / 100,
    month_total:        Math.round(monthTotal * 100) / 100,
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
  isReceipt:        false,
  isVoice:          false,
  receiptFile:      null,
  receiptItems:     [],
  expenseMap:       {},   // id → full expense object
  currentEditId:    null,
  editCategory:     null,
  editPayment:      null,
  editItems:        [],
  rates:            null, // { base, rates: {USD:…}, date }
};

let pieChartInst = null;
let lineChartInst = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function catColor(cat)      { return CAT_COLOR[cat]  || "#64748b"; }
function catEmoji(cat)      { return CAT_EMOJI[cat]  || "💳"; }
function curSym(code)       { return CUR_SYM[(code||"EUR").toUpperCase()] || code || "€"; }
function paymentIcon(m)     { return PAYMENT_ICONS[m] || "💳"; }
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
  const navBtn = document.getElementById("nav-" + name);
  if (navBtn) navBtn.classList.add("active");
  document.getElementById("main-scroll").scrollTop = 0;

  if (name === "home")     loadHome();
  if (name === "history")  loadHistory();
  if (name === "summary")  loadSummary();
  if (name === "add")      prepareAddForm();
  if (name === "settings")        { loadSettingsView(); syncDarkToggle(); }
  if (name === "overrides")        loadOverrides();
  if (name === "categories")       loadCategoriesView();
  if (name === "payment-methods")  loadPaymentMethodsView();
}

// ── Home ──────────────────────────────────────────────────────────────────────
async function loadHome() {
  await loadRates();
  const data   = computeSummary();
  const defCur = localStorage.getItem("defaultCurrency") || "EUR";
  document.getElementById("home-today").textContent = fmtAmount(data.today_total, defCur);
  document.getElementById("home-month").textContent = fmtAmount(data.month_total, defCur);
  data.recent.forEach(e => { state.expenseMap[e.id] = e; });
  renderDailyChart(data.daily_chart);
  renderCategoryBreakdown(data.category_breakdown, data.month_total, defCur);
  renderRecentExpenses(data.recent);
}

function renderDailyChart(data) {
  const maxVal   = Math.max(...data.map(d => d.total), 0.01);
  const today    = new Date().toISOString().split("T")[0];
  const barsEl   = document.getElementById("chart-bars");
  const labelsEl = document.getElementById("chart-labels");

  barsEl.innerHTML = data.map(d => {
    const pct     = Math.max(Math.round((d.total / maxVal) * 100), d.total > 0 ? 4 : 0);
    const isToday = d.date === today;
    return `<div class="flex-1 flex flex-col justify-end h-full">
        <div class="w-full rounded-t-md bar-fill ${isToday ? "bg-indigo-500" : "bg-indigo-200"}"
             style="height:0%" data-h="${pct}%"></div>
      </div>`;
  }).join("");

  labelsEl.innerHTML = data.map(d => {
    const isToday = d.date === today;
    const day = new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" }).slice(0,2);
    return `<div class="flex-1 text-center text-[10px] font-semibold ${isToday ? "text-indigo-600" : "text-gray-400"}">${day}</div>`;
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
            <div class="h-full rounded-full bar-fill" style="width:0%;background:${col}" data-w="${pct}%"></div>
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
  const col    = catColor(exp.category);
  const em     = catEmoji(exp.category);
  const badge  = exp.source === "receipt"
    ? `<span class="text-[9px] bg-blue-100 text-blue-500 px-1 py-0.5 rounded font-semibold ml-1">📷</span>` : "";
  const defCur = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  const isDiff = state.rates && exp.currency && exp.currency.toUpperCase() !== defCur;
  const cvt    = isDiff
    ? `<div class="text-[9px] text-gray-400">≈ ${fmtAmount(convertToDefault(exp.amount, exp.currency, exp.rate), defCur)}</div>` : "";
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
        <div class="text-sm font-bold text-gray-800">${fmtAmount(exp.amount, exp.currency)}</div>
        ${cvt}
      </div>
    </div>`;
}

// ── Add form ──────────────────────────────────────────────────────────────────
function prepareAddForm() {
  document.getElementById("f-date").value = new Date().toISOString().split("T")[0];
  const defaultCurrency = localStorage.getItem("defaultCurrency") || "EUR";
  populateCurrencySelect("f-currency", defaultCurrency);
  document.getElementById("f-cur-sym").textContent = curSym(defaultCurrency);
  loadCategoriesIntoButtons();
  renderPaymentButtons(state.selectedPayment, "payment-buttons");
}

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
      class="cat-chip px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all border ${isChosen
        ? 'bg-indigo-600 text-white border-indigo-600 selected'
        : 'bg-white text-gray-600 border-gray-200 opacity-60'}"
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
function triggerFileSelect() { document.getElementById("receipt-file").click(); }

function onFileSelected(event) {
  const file = event.target.files[0];
  if (file) handleFile(file);
}

function handleDrop(event) {
  event.preventDefault();
  document.getElementById("drop-zone").classList.remove("drag-over");
  const file = event.dataTransfer.files[0];
  if (file && file.type.startsWith("image/")) handleFile(file);
}

function handleFile(file) {
  state.receiptFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById("preview-img").src = e.target.result;
    document.getElementById("upload-zone").classList.add("hidden");
    document.getElementById("preview-zone").classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

function clearScan() {
  state.receiptFile  = null;
  state.isReceipt    = false;
  state.isVoice      = false;
  state.receiptItems = [];
  document.getElementById("receipt-file").value = "";
  document.getElementById("preview-img").src    = "";
  document.getElementById("upload-zone").classList.remove("hidden");
  document.getElementById("preview-zone").classList.add("hidden");
  document.getElementById("receipt-banner").classList.add("hidden");
  document.getElementById("voice-banner").classList.add("hidden");
  document.getElementById("items-section").classList.add("hidden");
  document.getElementById("save-label").textContent = "Add Expense";
  document.getElementById("cat-confidence").classList.add("hidden");
  resetForm();
}

function resetForm() {
  const defaultCurrency = localStorage.getItem("defaultCurrency") || "EUR";
  document.getElementById("f-merchant").value      = "";
  document.getElementById("f-amount").value        = "";
  populateCurrencySelect("f-currency", defaultCurrency);
  document.getElementById("f-cur-sym").textContent = curSym(defaultCurrency);
  document.getElementById("f-date").value          = new Date().toISOString().split("T")[0];
  document.getElementById("f-notes").value         = "";
  const rateRow = document.getElementById("f-rate-row");
  if (rateRow) rateRow.style.display = "none";
  state.selectedCategory = null;
  state.originalCategory = null;
  state.selectedPayment  = null;
  renderCatButtons(null);
  renderPaymentButtons(null, "payment-buttons");
}

async function analyzeReceipt() {
  if (!state.receiptFile) return;
  const btn     = document.getElementById("analyze-btn");
  const label   = document.getElementById("analyze-label");
  const spinner = document.getElementById("analyze-spinner");
  btn.disabled      = true;
  label.textContent = "Analyzing…";
  spinner.classList.remove("hidden");
  try {
    const formData = new FormData();
    formData.append("image", state.receiptFile);
    formData.append("api_key", localStorage.getItem("googleApiKey") || "");
    const r    = await fetch("/api/scan_receipt", { method: "POST", body: formData });
    const resp = await r.json();
    if (!r.ok || resp.error) throw new Error(resp.error || "Unknown error");
    populateFormFromReceipt(resp.data);
    showToast("Receipt analyzed successfully!");
  } catch (e) {
    showToast("Failed: " + e.message, true);
    label.textContent = "Retry Analysis";
    btn.disabled      = false;
    spinner.classList.add("hidden");
    return;
  }
  btn.disabled      = true;
  label.textContent = "Receipt Analyzed ✓";
  spinner.classList.add("hidden");
}

function populateFormFromReceipt(data) {
  state.isReceipt    = true;
  state.receiptItems = data.items || [];
  document.getElementById("f-merchant").value = data.merchant || "";
  if (data.total != null)  document.getElementById("f-amount").value   = Number(data.total).toFixed(2);
  if (data.currency) {
    const code   = data.currency.toUpperCase();
    const defCur = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
    const sel    = document.getElementById("f-currency");
    if ([...sel.options].some(o => o.value === code)) sel.value = code;
    document.getElementById("f-cur-sym").textContent = curSym(code);
    updateRateRow("f", code, defCur, null);
  }
  if (data.date)  document.getElementById("f-date").value  = data.date;
  if (data.notes) document.getElementById("f-notes").value = data.notes;

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
    document.getElementById("items-list").innerHTML = state.receiptItems.map(item => {
      const price = item.price != null
        ? `<span class="font-semibold">${fmtAmount(item.price, document.getElementById("f-currency").value)}</span>` : "";
      return `<div class="flex items-center justify-between py-0.5 border-b border-gray-100 last:border-0">
        <span class="truncate mr-2">${esc(item.name || "")}</span>${price}</div>`;
    }).join("");
  }
  document.getElementById("receipt-banner").classList.remove("hidden");
  document.getElementById("save-label").textContent = "Confirm & Save";
}

// ── Voice input ───────────────────────────────────────────────────────────────
let _mediaRecorder = null;
let _audioChunks   = [];
let _isRecording   = false;

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
    _audioChunks   = [];
    _mediaRecorder = new MediaRecorder(stream);
    _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _audioChunks.push(e.data); };
    _mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      sendVoiceToServer();
    };
    _mediaRecorder.start();
    _isRecording = true;

    const btn = document.getElementById("voice-btn");
    btn.classList.add("voice-recording");
    btn.classList.remove("voice-idle");
    document.getElementById("voice-icon").textContent  = "⏹";
    document.getElementById("voice-label").textContent = "Tap to stop";
    const status = document.getElementById("voice-status");
    status.textContent = "Listening…";
    status.classList.remove("hidden");
  } catch (e) {
    showToast("Microphone access denied: " + e.message, true);
  }
}

function stopVoiceRecording() {
  if (_mediaRecorder && _isRecording) {
    _mediaRecorder.stop();
    _isRecording = false;
    document.getElementById("voice-icon").textContent  = "🎤";
    document.getElementById("voice-label").textContent = "Processing…";
    document.getElementById("voice-status").textContent = "Analyzing with AI…";
  }
}

async function sendVoiceToServer() {
  const blob     = new Blob(_audioChunks, { type: "audio/webm" });
  const formData = new FormData();
  formData.append("audio", blob, "voice.webm");
  formData.append("api_key", localStorage.getItem("googleApiKey") || "");

  const btn = document.getElementById("voice-btn");
  btn.disabled = true;

  try {
    const r    = await fetch("/api/voice_input", { method: "POST", body: formData });
    const resp = await r.json();
    if (!r.ok || resp.error) throw new Error(resp.error || "Unknown error");
    populateFormFromVoice(resp.data);
    showToast("Voice input captured!");
  } catch (e) {
    showToast("Voice failed: " + e.message, true);
    resetVoiceBtn();
  } finally {
    btn.disabled = false;
  }
}

function resetVoiceBtn() {
  _isRecording = false;
  const btn = document.getElementById("voice-btn");
  btn.classList.remove("voice-recording");
  btn.classList.add("voice-idle");
  document.getElementById("voice-icon").textContent  = "🎤";
  document.getElementById("voice-label").textContent = "Voice Input";
  const status = document.getElementById("voice-status");
  status.classList.add("hidden");
  status.textContent = "";
}

function populateFormFromVoice(data) {
  state.isVoice      = true;
  state.isReceipt    = false;
  state.receiptItems = data.items || [];
  document.getElementById("receipt-banner").classList.add("hidden");

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
  if (data.date)  document.getElementById("f-date").value  = data.date;
  if (data.notes) document.getElementById("f-notes").value = data.notes;

  const pm = data.payment_method && getPaymentMethods().includes(data.payment_method) ? data.payment_method : null;
  state.selectedPayment = pm;
  renderPaymentButtons(pm, "payment-buttons");

  const cat = data.predicted_category || "Others";
  selectCategory(cat);
  state.originalCategory = cat;

  const confEl = document.getElementById("cat-confidence");
  const pct    = Math.round((data.confidence || 0) * 100);
  confEl.textContent = `Voice: ${pct}% confidence`;
  confEl.className   = `text-xs ${(data.confidence || 0) >= 0.6 ? "text-emerald-500" : "text-amber-500"}`;
  confEl.classList.remove("hidden");

  if (state.receiptItems.length > 0) {
    document.getElementById("items-section").classList.remove("hidden");
    document.getElementById("items-list").innerHTML = state.receiptItems.map(item => {
      const price = item.price != null
        ? `<span class="font-semibold">${fmtAmount(item.price, document.getElementById("f-currency").value)}</span>` : "";
      return `<div class="flex items-center justify-between py-0.5 border-b border-gray-100 last:border-0">
        <span class="truncate mr-2">${esc(item.name || "")}</span>${price}</div>`;
    }).join("");
  }

  document.getElementById("voice-banner").classList.remove("hidden");
  document.getElementById("save-label").textContent = "Confirm & Save";
  resetVoiceBtn();
}

function clearVoice() {
  state.isVoice = false;
  document.getElementById("voice-banner").classList.add("hidden");
  document.getElementById("cat-confidence").classList.add("hidden");
  document.getElementById("save-label").textContent = "Add Expense";
  resetVoiceBtn();
  resetForm();
}

// ── Save expense ──────────────────────────────────────────────────────────────
async function saveExpense() {
  const merchant       = document.getElementById("f-merchant").value.trim();
  const amount         = document.getElementById("f-amount").value;
  const currency       = document.getElementById("f-currency").value || "EUR";
  const date_val       = document.getElementById("f-date").value;
  const notes          = document.getElementById("f-notes").value.trim();
  let   category       = state.selectedCategory;
  const payment_method = state.selectedPayment || "";
  const defCur         = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  const rateRaw        = parseFloat(document.getElementById("f-rate")?.value);
  const storedRate     = currency.toUpperCase() !== defCur && !isNaN(rateRaw) && rateRaw > 0 ? rateRaw : null;

  if (!merchant) { showToast("Please enter a merchant name", true); return; }
  if (!amount || isNaN(parseFloat(amount))) { showToast("Please enter a valid amount", true); return; }

  const btn     = document.getElementById("save-btn");
  const label   = document.getElementById("save-label");
  const spinner = document.getElementById("save-spinner");
  btn.disabled      = true;
  spinner.classList.remove("hidden");
  label.textContent = "Saving…";

  try {
    let confidence = 1.0;
    if (!category) {
      const r    = await fetch("/api/classify", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ name: merchant, ...getCentroids() }),
      });
      const data = await r.json();
      category   = data.prediction || "Others";
      confidence = data.confidence || 0;
    }

    fetch("/api/learn", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        merchant,
        category,
        original_category: state.originalCategory || "",
        ...getCentroids(),
      }),
    }).then(r => r.json()).then(d => { if (d.centroids) saveCentroids(d.centroids); }).catch(() => {});

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
      items:          (state.isReceipt || state.isVoice) ? state.receiptItems : [],
      source:         state.isReceipt ? "receipt" : state.isVoice ? "voice" : "manual",
      created_at:     new Date().toISOString(),
    };

    const expenses = getExpenses();
    expenses.push(expense);
    saveExpenses(expenses);
    state.expenseMap[expense.id] = expense;

    showToast("Expense saved!");
    btn.disabled = false;
    spinner.classList.add("hidden");
    clearScan();
    resetForm();
    showView("home");
  } catch (e) {
    showToast("Error: " + e.message, true);
    label.textContent = state.isReceipt ? "Confirm & Save" : "Add Expense";
    btn.disabled      = false;
    spinner.classList.add("hidden");
  }
}

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  await loadRates();
  const expenses = getExpenses();
  expenses.forEach(e => { state.expenseMap[e.id] = e; });
  const sorted = expenses.slice().sort((a, b) => {
    const ka = (a.date || '') + (a.created_at || '');
    const kb = (b.date || '') + (b.created_at || '');
    return kb > ka ? 1 : -1;
  });
  renderHistory(sorted);
}

function renderHistory(exps) {
  const listEl  = document.getElementById("history-list");
  const totalEl = document.getElementById("history-total");

  if (!exps || exps.length === 0) {
    listEl.innerHTML    = `<div class="text-center text-gray-300 py-8">No expenses yet</div>`;
    totalEl.textContent = "";
    return;
  }

  const defCur     = localStorage.getItem("defaultCurrency") || "EUR";
  const grandTotal = exps.reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
  totalEl.textContent = `Total: ${fmtAmount(grandTotal, defCur)} · ${exps.length} items`;

  const grouped = {};
  for (const exp of exps) {
    const d = exp.date || "Unknown";
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(exp);
  }
  const dates = Object.keys(grouped).sort().reverse();

  listEl.innerHTML = dates.map(d => {
    const dayTotal = grouped[d].reduce((s, e) => s + convertToDefault(e.amount, e.currency, e.rate), 0);
    const cards    = grouped[d].map(exp => historyExpenseCard(exp)).join("");
    return `
      <div>
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-bold text-gray-600">${fmtDateLabel(d)}</span>
          <span class="text-sm font-semibold text-gray-400">${fmtAmount(dayTotal, defCur)}</span>
        </div>
        <div class="space-y-2">${cards}</div>
      </div>`;
  }).join("");
}

function historyExpenseCard(exp) {
  const col    = catColor(exp.category);
  const em     = catEmoji(exp.category);
  const badge  = exp.source === "receipt"
    ? `<span class="text-[9px] bg-blue-100 text-blue-500 px-1 py-0.5 rounded font-bold ml-1">📷</span>`
    : exp.source === "voice"
    ? `<span class="text-[9px] bg-rose-100 text-rose-500 px-1 py-0.5 rounded font-bold ml-1">🎤</span>`
    : "";
  const notes  = exp.notes
    ? `<span class="text-gray-400 text-xs truncate ml-1">· ${esc(exp.notes)}</span>` : "";
  const defCur = (localStorage.getItem("defaultCurrency") || "EUR").toUpperCase();
  const isDiff = state.rates && exp.currency && exp.currency.toUpperCase() !== defCur;
  const cvt    = isDiff
    ? `<div class="text-[9px] text-gray-400">≈ ${fmtAmount(convertToDefault(exp.amount, exp.currency, exp.rate), defCur)}</div>` : "";
  return `
    <div onclick="showExpenseDetail('${exp.id}')"
         class="bg-white rounded-xl p-3 flex items-center gap-3 shadow-sm border border-gray-100 cursor-pointer active:opacity-75 transition-opacity">
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
        <div class="font-bold text-gray-900 text-sm">${fmtAmount(exp.amount, exp.currency)}</div>
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
  const col = catColor(exp.category);
  const em  = catEmoji(exp.category);

  document.getElementById("det-badge").textContent      = `${em} ${exp.category}`;
  document.getElementById("det-badge").style.background = col;
  document.getElementById("det-merchant").textContent   = exp.merchant;
  document.getElementById("det-amount").textContent     = fmtAmount(exp.amount, exp.currency);
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

  const isReceipt = exp.source === "receipt";
  document.getElementById("det-source-icon").textContent = isReceipt ? "📷" : "💳";
  document.getElementById("det-source").textContent      = isReceipt ? "Scanned receipt" : "Manual entry";

  const itemsSect = document.getElementById("det-items-section");
  if (exp.items && exp.items.length > 0) {
    itemsSect.classList.remove("hidden");
    document.getElementById("det-items-list").innerHTML = exp.items.map(item => {
      const price = item.price != null
        ? `<span class="font-semibold">${fmtAmount(item.price, exp.currency)}</span>` : "";
      return `<div class="flex items-center justify-between py-0.5 border-b border-gray-100 last:border-0">
        <span class="truncate mr-2">${esc(item.name || "")}</span>${price}</div>`;
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
  updateRateRow("edit", cur, defCur, exp.rate ?? null);

  state.editCategory = exp.category || null;
  renderEditCatButtons(state.editCategory);

  state.editPayment = exp.payment_method || null;
  renderPaymentButtons(state.editPayment, "edit-payment-buttons");

  state.editItems = (exp.items || []).map(i => ({ name: i.name || "", price: i.price ?? null }));
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
             class="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white min-w-0" />
      <input type="number" value="${item.price ?? ""}" placeholder="0.00" min="0" step="0.01"
             oninput="state.editItems[${idx}].price = this.value === '' ? null : parseFloat(this.value)"
             class="w-20 px-2 py-2 border border-gray-200 rounded-lg text-xs text-center focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white flex-shrink-0" />
      <button type="button" onclick="removeEditItem(${idx})"
              class="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 text-gray-400 hover:bg-red-100 hover:text-red-500 flex-shrink-0 transition-colors text-sm">✕</button>
    </div>`).join("");
}

function addEditItem() {
  state.editItems.push({ name: "", price: null });
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
    .map(i => ({ name: i.name.trim(), price: i.price }));

  try {
    const oldExp = state.expenseMap[id];
    const oldCat = oldExp ? oldExp.category : "";

    if (category && category !== oldCat) {
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
      payment_method,
      items,
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

// ── Summary (charts) ──────────────────────────────────────────────────────────
async function loadSummary() {
  await loadRates();
  const data   = computeSummary();
  const defCur = localStorage.getItem("defaultCurrency") || "EUR";
  document.getElementById("sum-month").textContent = fmtAmount(data.month_total, defCur);
  document.getElementById("sum-today").textContent = fmtAmount(data.today_total, defCur);
  renderPieChart(data.category_breakdown, defCur);
  renderBarChart(data.daily_chart, defCur);
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
        borderColor:     dark ? "#1e293b" : "#ffffff",
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
            color:           dark ? "#cbd5e1" : "#374151",
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
          d.date === today ? "#4f46e5" : (dark ? "#4338ca88" : "#a5b4fc")),
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
          ticks: { color: dark ? "#64748b" : "#9ca3af", font: { size: 10 } },
        },
        y: {
          grid:  { color: dark ? "#334155" : "#f3f4f6" },
          ticks: {
            color:    dark ? "#64748b" : "#9ca3af",
            font:     { size: 10 },
            callback: v => curSym(defCur) + v,
          },
          beginAtZero: true,
        },
      },
    },
  });
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
  try {
    const r    = await fetch("/api/settings");
    const data = await r.json();
    if (data.env_key_set) {
      document.getElementById("s-env-notice").classList.remove("hidden");
    }

    const storedKey = localStorage.getItem("googleApiKey") || "";
    const statusEl  = document.getElementById("s-key-status");
    if (storedKey) {
      const preview = storedKey.length > 10
        ? storedKey.slice(0, 6) + "…" + storedKey.slice(-4)
        : "***";
      statusEl.textContent = `Saved key: ${preview}`;
      statusEl.className   = "text-xs text-emerald-600 mt-1.5 font-medium";
    } else if (!data.env_key_set) {
      statusEl.textContent = "No API key saved — receipt scanning will be unavailable.";
      statusEl.className   = "text-xs text-amber-500 mt-1.5";
    } else {
      statusEl.textContent = "";
    }
  } catch (e) { console.error("loadSettings:", e); }

  const storedCurrency = localStorage.getItem("defaultCurrency") || "EUR";
  populateCurrencySelect("s-currency", storedCurrency);
  renderCustomCurrenciesSettings();

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

function saveApiKey() {
  const key = document.getElementById("s-api-key").value.trim();
  if (!key) return;
  localStorage.setItem("googleApiKey", key);
  document.getElementById("s-api-key").value = "";
  showToast("API key saved.");
  loadSettingsView();
}

function saveCurrency() {
  const currency = document.getElementById("s-currency").value;
  if (!currency) return;
  localStorage.setItem("defaultCurrency", currency);
  showToast("Currency saved.");
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
                  class="px-2 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
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
        const tag      = isCustom
          ? `<span class="text-[10px] font-semibold text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded-full">custom</span>`
          : ``;
        return `
          <div class="flex items-center gap-3 px-4 py-3">
            <span class="text-base">${catEmoji(cat)}</span>
            <span class="flex-1 min-w-0 text-sm text-gray-700 font-medium truncate">${cat}</span>
            ${tag}
            <button onclick="deleteCategory('${cat.replace(/'/g, "\\'")}')"
                    class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm">✕</button>
          </div>`;
      }).join("")
    : `<div class="px-4 py-6 text-sm text-gray-400 text-center">No categories yet.</div>`;
}

function addCustomCategory() {
  const name = document.getElementById("new-category-name").value.trim();
  if (!name) return;
  const data = getCentroids();
  if (!data) { showToast("No model loaded yet.", true); return; }
  const existing = getAllCategories();
  if (existing.includes(name)) { showToast("Category already exists.", true); return; }
  data.custom_categories = data.custom_categories || [];
  data.custom_categories.push(name);
  saveCentroids(data);
  document.getElementById("new-category-name").value = "";
  loadCategoriesView();
  loadCategoriesIntoButtons();
  showToast(`"${name}" added.`);
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
      if (data.categories?.[name]) delete data.categories[name];
      saveCentroids(data);
      loadCategoriesView();
      loadCategoriesIntoButtons();
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
  const methods = getPaymentMethods();
  const list    = document.getElementById("payment-methods-list");
  list.innerHTML = methods.length
    ? methods.map(m => `
        <div class="flex items-center gap-3 px-4 py-3">
          <span class="text-base">${paymentIcon(m)}</span>
          <span class="flex-1 min-w-0 text-sm text-gray-700 font-medium truncate">${esc(m)}</span>
          <button onclick="deletePaymentMethod('${m.replace(/'/g, "\\'")}')"
                  class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm">✕</button>
        </div>`).join("")
    : `<div class="px-4 py-6 text-sm text-gray-400 text-center">No payment methods.</div>`;
}

function addCustomPaymentMethod() {
  const input  = document.getElementById("new-payment-method");
  const name   = (input.value || "").trim();
  if (!name) return;
  const methods = getPaymentMethods();
  if (methods.includes(name)) { showToast("Method already exists.", true); return; }
  methods.push(name);
  savePaymentMethods(methods);
  input.value = "";
  loadPaymentMethodsView();
  showToast(`"${name}" added.`);
}

function deletePaymentMethod(method) {
  showConfirm({
    title:   `Remove "${method}"?`,
    message: "This removes the payment method from your list. Existing expenses are not affected.",
    okLabel: "Remove",
    onOk: () => {
      const methods = getPaymentMethods().filter(m => m !== method);
      savePaymentMethods(methods);
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

function toggleApiVis() {
  const input   = document.getElementById("s-api-key");
  const showEye = document.getElementById("eye-show");
  const hideEye = document.getElementById("eye-hide");
  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  showEye.classList.toggle("hidden", isHidden);
  hideEye.classList.toggle("hidden", !isHidden);
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
  const headers = ["date", "merchant", "amount", "currency", "category", "payment_method", "notes", "source", "created_at"];
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
      saveExpenses([...existing, ...newOnes]);
      document.getElementById("import-file").value = "";
      showToast(`Imported ${newOnes.length} expense${newOnes.length !== 1 ? "s" : ""}`);
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
  loadHome();
  loadCategoriesIntoButtons();
  const defaultCurrency = localStorage.getItem("defaultCurrency") || "EUR";
  populateCurrencySelect("f-currency", defaultCurrency);
  document.getElementById("f-cur-sym").textContent = curSym(defaultCurrency);
  renderPaymentButtons(null, "payment-buttons");
}

init();
