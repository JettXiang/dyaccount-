const MONITOR_MODE = false;

const DEFAULT_SETTINGS = {
  collecting: false,
  autoBrowse: false,
  intervalMs: 4000,
  requireMix: true,
  requireAi: true,
  autoSwitchChannel: false,
  autoSwitchSearch: false,
  collapsed: false,
  viewNewOnly: false,
  switchSearchMinMs: 300000
};

const MSG_HOOK = "dyaccount-hook";
const MSG_CTL = "dyaccount-ctl";
const PANEL_ID = "dyaccount-panel";
const AUTO_CHANNELS = ["全部", "二次元", "小剧场"];
const SWITCH_AFTER_SCROLLS = 40;
const SEARCH_CATEGORY = ["AI漫剧", "AI短剧", "AIGC漫剧", "AIGC短剧", "AI动画", "AIGC动画"];
// v1.1.4：题材词按 3517 位已采作者语料的实际命中率重排
// 删除零命中的死词（赘婿/甜宠/女婿/打脸），补入数据反推的高产词
const SEARCH_TOPIC = [
  "逆袭", "重生", "穿越", "系统", "校花", "修仙", "末世", "都市",
  "玄幻", "悬疑", "王妃", "战神", "豪门", "复仇", "神医", "龙王",
  "末日", "山海", "西游", "宇宙", "古代", "志怪", "神话", "大明",
  "传奇", "赛博", "聊斋", "斗罗", "开局", "异世界"
];
const SEARCH_TOOLS = ["即梦", "可灵", "Vidu", "海螺", "Runway", "Pika", "剪映AI", "Sora"];
const SEARCH_WORDS = (function () {
  const out = [];
  for (let i = 0; i < SEARCH_CATEGORY.length; i++) {
    for (let j = 0; j < SEARCH_TOPIC.length; j++) {
      out.push(SEARCH_CATEGORY[i] + " " + SEARCH_TOPIC[j]);
    }
  }
  const forms = ["短剧", "漫剧", "动画"];
  for (let i = 0; i < SEARCH_TOOLS.length; i++) {
    for (let j = 0; j < forms.length; j++) {
      out.push(SEARCH_TOOLS[i] + " " + forms[j]);
    }
  }
  return out;
})();
const SWITCH_SEARCH_AFTER = 30;
const SWITCH_SEARCH_MIN_MS = 300000;
const CAPTCHA_TEXTS = ["请选择所有符合", "拖拽到", "请完成验证", "拖动滑块", "向右滑动", "安全验证"];
const LOGOUT_TEXTS = ["登录已过期", "请重新登录", "扫码登录", "验证码登录", "账号已退出"];
const IDLE_PROMPT_MS = 5 * 60 * 1000;
const NO_RESPONSE_MS = 90 * 1000;
const SWITCH_GRACE_MS = 30 * 1000;

// ----- v1.1.2：导出时「有效」过滤 -----
const VALID_FILTER_ENABLED = false;  // v1.1.3：导出全量，有效性判定挪到后台分级标记 + LLM/人工复核
const VALID_MIN_VIDEO = 2;           // 视频数阈值：该作者被扫到的视频条数 ≥ 该值才算有效
const TYPE_WHITELIST = ["漫剧", "短剧", "AIGC", "动漫", "动画", "次元", "穿越", "重生", "逆袭", "赘婿", "战神", "系统", "王妃", "豪门", "漫画", "番剧", "小剧场", "剧场", "剧集", "末世", "自制动画"];
const TYPE_BLACKLIST = ["汪汪队", "立大功", "民间故事", "寓言", "动物世界", "怀旧", "童年", "军旅", "科普", "双语", "跟读", "后室", "未解之谜", "领养", "咕嘎", "人生副本", "阅读", "育儿", "儿童", "宝宝", "儿歌", "纪录片", "解说", "混剪", "搬运", "影视解说"];

let settings = { ...DEFAULT_SETTINGS };
let authors = {};
let stats = { scanned: 0, matched: 0, lastUrl: "", lastHint: "" };
let recent = [];
let autoTimer = null;
let scannedAweme = new Set();
let matchedAweme = new Set();
let persistTimer = null;
let cachedScrollRoot = null;
let stuckTicks = 0;
let reloading = false;
let lastSwitchAt = 0;
let captchaHandled = false;
let fatal = false;
let lastNewAuthorAt = Date.now();
let lastDataAt = Date.now();
let lastNavAt = Date.now();
let sessionStartAt = Date.now();
let searchOrder = [];
let searchOrderPos = 0;

function $(sel, root) {
  return (root || document).querySelector(sel);
}

function sendHookCollecting() {
  window.postMessage({ source: MSG_CTL, collecting: !!settings.collecting }, "*");
}

function currentAwemeId() {
  try {
    const u = new URL(location.href);
    return (
      u.searchParams.get("modal_id") ||
      (location.pathname.match(/\/video\/(\d+)/) || [])[1] ||
      ""
    );
  } catch (e) {
    return "";
  }
}

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["settings", "authors", "stats"], (data) => {
      settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
      if (!settings.intervalMs || Number(settings.intervalMs) < 4000) settings.intervalMs = 4000;
      authors = data.authors || {};
      stats = { scanned: 0, matched: 0, lastUrl: "", lastHint: "", ...(data.stats || {}) };
      stats.matched = Object.keys(authors).length;
      resolve();
    });
  });
}

function isExtAlive() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

function schedulePersist() {
  if (!isExtAlive()) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 250);
}

function persist() {
  if (!isExtAlive()) return;
  stats.matched = Object.keys(authors).length;
  chrome.storage.local.set({ settings, authors, stats });
  try {
    chrome.runtime.sendMessage({ type: "badge", count: stats.matched });
  } catch (e) {}
}

function upsertAuthor(record) {
  const secUid = record.author && record.author.secUid;
  if (!secUid) return false;
  const now = Date.now();
  const prev = authors[secUid];
  if (!prev) {
    authors[secUid] = {
      secUid,
      uid: record.author.uid || "",
      nickname: record.author.nickname || "",
      uniqueId: record.author.uniqueId || "",
      avatar: record.author.avatar || "",
      mixId: (record.mix && record.mix.mixId) || "",
      mixName: (record.mix && record.mix.mixName) || "",
      sampleAwemeId: record.awemeId || "",
      sampleUrl: record.url || "",
      sampleDesc: record.desc || "",
      aigcReason: (record.aigc && record.aigc.reason) || "",
      videoCount: 1,
      firstSeen: now,
      lastSeen: now
    };
    return true;
  }
  prev.lastSeen = now;
  prev.videoCount = (prev.videoCount || 1) + 1;
  if (!prev.nickname && record.author.nickname) prev.nickname = record.author.nickname;
  if (!prev.mixName && record.mix && record.mix.mixName) {
    prev.mixName = record.mix.mixName;
    prev.mixId = record.mix.mixId;
  }
  if (!prev.avatar && record.author.avatar) prev.avatar = record.author.avatar;
  return false;
}

function handleRecords(records, source) {
  if (!settings.collecting || !records || !records.length) return;
  lastDataAt = Date.now();
  let added = 0;
  const addedNames = [];
  for (const rec of records) {
    const id = rec.awemeId || "";
    if (id && matchedAweme.has(id)) continue;
    if (id && !scannedAweme.has(id)) {
      scannedAweme.add(id);
      stats.scanned += 1;
    } else if (!id) {
      stats.scanned += 1;
    }
    if (!DyAccountParse.matchFilters(rec, settings.requireMix, settings.requireAi)) {
      pushRecent(rec, false, source);
      continue;
    }
    if (id) matchedAweme.add(id);
    const isNew = upsertAuthor(rec);
    if (isNew) {
      added += 1;
      lastNewAuthorAt = Date.now();
      if (rec.author && rec.author.nickname) addedNames.push(rec.author.nickname);
    }
    pushRecent(rec, true, source);
  }
  if (records.length) {
    stats.lastUrl = location.href;
    schedulePersist();
    renderPanel();
    if (added) flashMatch(added, addedNames);
  }
}

function pushRecent(rec, matched, source) {
  recent.unshift({
    awemeId: rec.awemeId,
    nickname: rec.author && rec.author.nickname,
    hasMix: rec.hasMix,
    hasAiDeclare: rec.hasAiDeclare,
    mixName: rec.mix && rec.mix.mixName,
    matched,
    source
  });
  if (recent.length > 8) recent.length = 8;
}

function flashMatch(n, names) {
  const el = document.getElementById(PANEL_ID);
  if (!el) return;
  el.classList.add("dyaccount-hit");
  setTimeout(() => el.classList.remove("dyaccount-hit"), 600);
  let hint = "新命中 " + n + " 位作者";
  if (MONITOR_MODE && names && names.length) {
    hint += "：" + names.slice(0, 10).join("、");
  }
  stats.lastHint = hint;
}

function ingestJson(text, source) {
  try {
    let records = DyAccountParse.parsePayload(text);
    if (!records.length && text && text.indexOf("\n") !== -1) {
      const lines = String(text).split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || (line.charAt(0) !== "{" && line.charAt(0) !== "[")) continue;
        records = records.concat(DyAccountParse.parsePayload(line));
      }
    }
    handleRecords(records, source);
  } catch (e) {
    stats.lastHint = "解析失败: " + (e && e.message);
  }
}

function scanRenderData() {
  const el = document.getElementById("RENDER_DATA") || document.getElementById("__NEXT_DATA__");
  if (el && el.textContent) {
    const records = DyAccountParse.parseRenderDataText(el.textContent);
    handleRecords(records, "render");
  }
  try {
    if (window.webkit && window.webkit.messageHandlers) return;
  } catch (e) {}
}

function visibleTextHas(str) {
  const root = document.getElementById("sliderVideo") || document.querySelector("#douyin-right-container") || document.body;
  if (!root) return false;
  const t = root.innerText || "";
  return t.indexOf(str) !== -1;
}

function findSecUidFromDom() {
  const links = document.querySelectorAll('a[href*="/user/"]');
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    const m = href.match(DyAccountParse.SEC_UID_RE);
    if (m) {
      const nick =
        a.getAttribute("aria-label") ||
        a.innerText ||
        (a.querySelector("img") && a.querySelector("img").alt) ||
        "";
      return { secUid: m[0], nickname: String(nick).trim().slice(0, 40), href };
    }
  }
  return null;
}

function scanCurrentPlayerDom() {
  if (!settings.collecting) return;
  if (!isPlayerMode()) return;
  const hasAi = DyAccountParse.AI_DECLARE_TEXTS.some((t) => visibleTextHas(t));
  const hasMix =
    visibleTextHas("合集") ||
    !!document.querySelector('a[href*="/collection/"], a[href*="/mix/"]');
  if (!hasAi || (settings.requireMix && !hasMix)) return;
  const author = findSecUidFromDom();
  if (!author) return;
  const rec = DyAccountParse.fromDomHints({
    awemeId: currentAwemeId(),
    secUid: author.secUid,
    nickname: author.nickname,
    hasMix,
    mixName: hasMix ? "合集" : "",
    desc: ""
  });
  if (rec) handleRecords([rec], "dom");
}

function ensurePanel() {
  if (document.getElementById(PANEL_ID)) return;
  if (!document.documentElement) return;
  const wrap = document.createElement("div");
  wrap.id = PANEL_ID;
  wrap.innerHTML = panelHtml();
  (document.body || document.documentElement).appendChild(wrap);
  bindPanel(wrap);
}

function panelHtml() {
  return `
    <div class="dyaccount-head">
      <div class="dyaccount-title">
        <span class="dyaccount-dot"></span>
        AI合集作者采集
      </div>
      <button class="dyaccount-iconbtn" data-act="collapse" title="折叠">–</button>
    </div>
    <div class="dyaccount-body">
      <div class="dyaccount-row">
        <button class="dyaccount-btn primary" data-act="toggle">开始采集</button>
        <button class="dyaccount-btn" data-act="auto">自动下滑</button>
      </div>
      <div class="dyaccount-stats">
        <div><b data-k="matched">0</b><span>作者</span></div>
        <div><b data-k="scanned">0</b><span>已扫视频</span></div>
      </div>
      <label class="dyaccount-check"><input type="checkbox" data-k="requireMix" checked> 必须挂载合集</label>
      <label class="dyaccount-check"><input type="checkbox" data-k="requireAi" checked> 必须「内容由AI生成」</label>
      <label class="dyaccount-check"><input type="checkbox" data-k="autoSwitchChannel"> 自动换栏目</label>
      <label class="dyaccount-check"><input type="checkbox" data-k="autoSwitchSearch"> 自动换搜索词</label>
      <div class="dyaccount-hint" data-k="hint">精选或搜索页登录后，点开始采集，再开自动下滑。</div>
      <div class="dyaccount-prompt" data-k="prompt" hidden>
        <div class="dyaccount-prompt-text">已 5 分钟无新作者，是否取消「必须挂载合集」以放宽采集？</div>
        <div class="dyaccount-prompt-actions">
          <button class="dyaccount-btn" data-act="relaxMix">取消合集条件</button>
          <button class="dyaccount-btn" data-act="keepMix">保持</button>
        </div>
      </div>
      ${MONITOR_MODE ? `
      <div class="dyaccount-viewbar">
        <button class="dyaccount-btn dyaccount-btn-sm" data-act="viewToggle">仅看新增</button>
      </div>` : ""}
      <div class="dyaccount-list" data-k="list"></div>
      <div class="dyaccount-actions">
        <button class="dyaccount-btn" data-act="inspect">检测当前</button>
        <button class="dyaccount-btn" data-act="copy">复制 ID</button>
        <button class="dyaccount-btn" data-act="export">导出 JSON</button>
        ${MONITOR_MODE ? `
        <button class="dyaccount-btn" data-act="exportCsv">导出 CSV</button>
        <button class="dyaccount-btn" data-act="openDashboard">后台</button>` : ""}
        <button class="dyaccount-btn danger" data-act="clear">清空</button>
      </div>
    </div>
  `;
}

function bindPanel(root) {
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    if (act === "collapse") {
      settings.collapsed = !settings.collapsed;
      persist();
      renderPanel();
    } else if (act === "toggle") {
      settings.collecting = !settings.collecting;
      if (settings.collecting) {
        resetCaptchaFlag();
        sendHookCollecting();
        scanRenderData();
        scanCurrentPlayerDom();
      } else {
        settings.autoBrowse = false;
        stopAuto();
        sendHookCollecting();
      }
      persist();
      renderPanel();
    } else if (act === "auto") {
      if (!settings.collecting) {
        settings.collecting = true;
        sendHookCollecting();
      }
      settings.autoBrowse = !settings.autoBrowse;
      if (settings.autoBrowse) resetCaptchaFlag();
      cachedScrollRoot = null;
      stuckTicks = 0;
      persist();
      syncAuto();
      renderPanel();
    } else if (act === "inspect") {
      inspectCurrent();
    } else if (act === "copy") {
      copyIds();
    } else if (act === "export") {
      exportJson();
    } else if (act === "relaxMix") {
      settings.requireMix = false;
      hideIdlePrompt();
      stats.lastHint = "已放宽：取消「必须挂载合集」";
      persist();
      renderPanel();
    } else if (act === "keepMix") {
      hideIdlePrompt();
      lastNewAuthorAt = Date.now();
      stats.lastHint = "保持当前条件";
      persist();
      renderPanel();
    } else if (act === "viewToggle") {
      settings.viewNewOnly = !settings.viewNewOnly;
      persist();
      renderPanel();
    } else if (act === "exportCsv") {
      exportCsv();
    } else if (act === "openDashboard") {
      openDashboard();
    } else if (act === "clear") {
      if (confirm("清空已采集的作者列表？")) {
        authors = {};
        stats.matched = 0;
        recent = [];
        persist();
        renderPanel();
      }
    }
  });
  root.addEventListener("change", (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    const key = input.getAttribute("data-k");
    if (key === "requireMix" || key === "requireAi" || key === "autoSwitchChannel" || key === "autoSwitchSearch") {
      settings[key] = input.checked;
      persist();
    }
  });
}

function authorList() {
  return Object.keys(authors)
    .map((k) => authors[k])
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

function renderPanel() {
  ensurePanel();
  const root = document.getElementById(PANEL_ID);
  if (!root) return;
  root.classList.toggle("is-collapsed", !!settings.collapsed);
  root.classList.toggle("is-on", !!settings.collecting);
  root.classList.toggle("dyaccount-error", !!fatal);
  const toggle = root.querySelector('[data-act="toggle"]');
  const auto = root.querySelector('[data-act="auto"]');
  if (toggle) toggle.textContent = settings.collecting ? "停止采集" : "开始采集";
  if (auto) {
    auto.textContent = settings.autoBrowse ? "停止下滑" : "自动下滑";
    auto.classList.toggle("on", !!settings.autoBrowse);
  }
  const viewBtn = root.querySelector('[data-act="viewToggle"]');
  if (viewBtn) {
    viewBtn.textContent = settings.viewNewOnly ? "显示全部" : "仅看新增";
    viewBtn.classList.toggle("on", !!settings.viewNewOnly);
  }
  const matched = root.querySelector('[data-k="matched"]');
  const scanned = root.querySelector('[data-k="scanned"]');
  if (matched) matched.textContent = String(Object.keys(authors).length);
  if (scanned) scanned.textContent = String(stats.scanned || 0);
  const mix = root.querySelector('[data-k="requireMix"]');
  const ai = root.querySelector('[data-k="requireAi"]');
  const asw = root.querySelector('[data-k="autoSwitchChannel"]');
  const asw2 = root.querySelector('[data-k="autoSwitchSearch"]');
  if (mix) mix.checked = settings.requireMix !== false;
  if (ai) ai.checked = settings.requireAi !== false;
  if (asw) asw.checked = !!settings.autoSwitchChannel;
  if (asw2) asw2.checked = !!settings.autoSwitchSearch;
  const hint = root.querySelector('[data-k="hint"]');
  if (hint) {
    hint.textContent = settings.collecting
      ? stats.lastHint || pageModeHint(true)
      : pageModeHint(false);
    hint.classList.toggle("dyaccount-hint-error", !!fatal);
  }
  const list = root.querySelector('[data-k="list"]');
  if (list) {
    let rows = authorList();
    if (MONITOR_MODE && settings.viewNewOnly) {
      rows = rows.filter((a) => (a.firstSeen || 0) >= sessionStartAt);
    }
    rows = rows.slice(0, 12);
    list.innerHTML = rows.length
      ? rows
          .map((a) => {
            const name = escapeHtml(a.nickname || "(无昵称)");
            const mixName = escapeHtml(a.mixName || "合集");
            const isNew = MONITOR_MODE && (a.firstSeen || 0) >= sessionStartAt;
            const badge = isNew ? `<span class="dyaccount-item-new">新</span>` : "";
            return `<div class="dyaccount-item" title="${escapeHtml(a.secUid)}">
              <div class="dyaccount-item-name">${badge}${name}</div>
              <div class="dyaccount-item-meta">${mixName}</div>
            </div>`;
          })
          .join("")
      : `<div class="dyaccount-empty">还没有命中。目标：挂载合集 + 作者声明「内容由AI生成」</div>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function copyIds() {
  const ids = authorList().map((a) => a.secUid).join("\n");
  if (!ids) {
    stats.lastHint = "列表为空";
    renderPanel();
    return;
  }
  navigator.clipboard.writeText(ids).then(
    () => {
      stats.lastHint = "已复制 " + authorList().length + " 个 sec_uid";
      renderPanel();
    },
    () => {
      stats.lastHint = "复制失败，请用弹窗导出";
      renderPanel();
    }
  );
}

function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    count: authorList().length,
    authors: authorList()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "douyin-ai-mix-authors.json";
  a.click();
  URL.revokeObjectURL(url);
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function normTypeText(s) {
  return String(s == null ? "" : s).replace(/\s+/g, "").toUpperCase();
}

function isTargetType(mixName, nickname) {
  const text = normTypeText(mixName) + normTypeText(nickname);
  if (!text) return false;
  if (TYPE_BLACKLIST.some((k) => text.indexOf(k) !== -1)) return false;
  return TYPE_WHITELIST.some((k) => text.indexOf(k) !== -1);
}

function effectiveAuthors() {
  const rows = authorList();
  if (!VALID_FILTER_ENABLED) return rows;
  return rows.filter((a) => isTargetType(a.mixName, a.nickname) && (a.videoCount || 0) >= VALID_MIN_VIDEO);
}

function exportCsv() {
  const rows = effectiveAuthors();
  if (!rows.length) {
    stats.lastHint = VALID_FILTER_ENABLED ? "没有符合条件的有效作者，暂不导出" : "暂无采集数据，暂不导出";
    renderPanel();
    return;
  }
  const header = ["昵称", "sec_uid", "合集名", "首次发现时间", "最近发现时间", "视频数"];
  const esc = (v) => {
    const s = String(v == null ? "" : v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [header.join(",")];
  for (const a of rows) {
    lines.push(
      [
        a.nickname || "",
        a.secUid || "",
        a.mixName || "",
        fmtTime(a.firstSeen),
        fmtTime(a.lastSeen),
        a.videoCount || 0
      ]
        .map(esc)
        .join(",")
    );
  }
  const csv = String.fromCharCode(0xfeff) + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "douyin-ai-authors.csv";
  a.click();
  URL.revokeObjectURL(url);
  stats.lastHint =
    (VALID_FILTER_ENABLED ? "已导出有效 " : "已导出全量 ") +
    rows.length + " 位（共 " + authorList().length + " 位）作者 CSV";
  renderPanel();
}

function openDashboard() {
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  } catch (e) {
    stats.lastHint = "无法打开后台页";
    renderPanel();
  }
}

function inspectCurrent() {
  const id = currentAwemeId();
  const hasAi = DyAccountParse.AI_DECLARE_TEXTS.some((t) => visibleTextHas(t));
  const hasMixText = visibleTextHas("合集");
  const author = findSecUidFromDom();
  stats.lastHint =
    "当前 " +
    (id || "无modal_id") +
    " | 页面AI声明:" +
    (hasAi ? "有" : "无") +
    " | 合集:" +
    (hasMixText ? "有" : "无") +
    " | 作者:" +
    (author ? author.nickname || author.secUid.slice(0, 12) : "未找到");
  scanRenderData();
  scanCurrentPlayerDom();
  scanSearchDom();
  persist();
  renderPanel();
}

function isPlayerMode() {
  return /modal_id=/.test(location.href) || /\/video\//.test(location.pathname);
}

function isSearchPage() {
  return /\/search\//.test(location.pathname);
}

function pageModeHint(running) {
  if (isSearchPage()) {
    return running
      ? settings.autoBrowse
        ? "搜索页自动下滑中，正在拦截搜索结果…"
        : "采集中，请在搜索结果里下滑加载更多"
      : "当前是搜索页。点开始采集，再开自动下滑。";
  }
  if (isPlayerMode()) {
    return running
      ? settings.autoBrowse
        ? "播放页自动切下一条…"
        : "采集中，请切下一条或开自动下滑"
      : "打开精选/搜索后开始采集。播放中可自动切下一条。";
  }
  return running
    ? settings.autoBrowse
      ? "自动下滑中，正在拦截推荐接口…"
      : "采集中，请下滑或开自动下滑"
    : "精选或搜索页登录后，点开始采集，再开自动下滑。";
}

function isOurPanel(el) {
  return !!(el && (el.id === PANEL_ID || (el.closest && el.closest("#" + PANEL_ID))));
}

function isScrollableBox(el) {
  if (!el || isOurPanel(el)) return false;
  if (el === document.documentElement || el === document.body || el === document.scrollingElement) {
    const se = document.scrollingElement || document.documentElement;
    return se.scrollHeight > se.clientHeight + 60;
  }
  let style;
  try {
    style = window.getComputedStyle(el);
  } catch (e) {
    return false;
  }
  const oy = style.overflowY || style.overflow;
  const canScroll = oy === "auto" || oy === "scroll" || oy === "overlay";
  return canScroll && el.scrollHeight > el.clientHeight + 60;
}

function findScrollRoot() {
  if (cachedScrollRoot && document.contains(cachedScrollRoot) && isScrollableBox(cachedScrollRoot)) {
    return cachedScrollRoot;
  }
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const x = Math.floor(vw * 0.38);
  const y = Math.floor(vh * 0.58);
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.documentElement) {
    if (isScrollableBox(el)) {
      cachedScrollRoot = el;
      return el;
    }
    el = el.parentElement;
  }
  const hints = [
    '[id*="search-result"]',
    '[class*="search-result"]',
    '[class*="SearchResult"]',
    '[class*="waterfall"]',
    "#douyin-right-container",
    "main",
    "#root"
  ];
  for (let i = 0; i < hints.length; i++) {
    const nodes = document.querySelectorAll(hints[i]);
    for (let j = 0; j < nodes.length; j++) {
      if (isScrollableBox(nodes[j])) {
        cachedScrollRoot = nodes[j];
        return nodes[j];
      }
    }
  }
  const fallback = document.scrollingElement || document.documentElement;
  cachedScrollRoot = fallback;
  return fallback;
}

function fireWheel(target, delta) {
  if (!target) return;
  const opts = {
    deltaY: delta,
    deltaMode: 0,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window
  };
  try {
    target.dispatchEvent(new WheelEvent("wheel", opts));
  } catch (e) {}
}

function clickLoadMore() {
  const texts = ["加载更多", "查看更多", "点击加载"];
  const nodes = document.querySelectorAll("button, div, span, p");
  for (let i = 0; i < nodes.length && i < 400; i++) {
    const el = nodes[i];
    if (isOurPanel(el) || el.childElementCount > 2) continue;
    const t = (el.innerText || el.textContent || "").trim();
    if (t.length > 8) continue;
    if (texts.indexOf(t) !== -1) {
      el.click();
      return true;
    }
  }
  return false;
}

function goNextPlayer() {
  const selectors = [
    '[data-e2e="video-switch-next"]',
    '[class*="xgplayer-playswitch-next"]',
    '[class*="slide-next"]',
    '[class*="swiper-button-next"]',
    '[class*="arrowDown"]',
    '[class*="arrow-down"]',
    'button[aria-label*="下一个"]',
    'div[aria-label*="下一个"]',
    'div[aria-label*="下一条"]'
  ];
  for (let i = 0; i < selectors.length; i++) {
    const el = document.querySelector(selectors[i]);
    if (el && !isOurPanel(el)) {
      el.click();
      return;
    }
  }
  const video = document.querySelector("video");
  let node = video && video.parentElement;
  while (node && node !== document.body) {
    if (node.scrollHeight > node.clientHeight + 40) {
      node.scrollTop += node.clientHeight;
      fireWheel(node, node.clientHeight);
      return;
    }
    node = node.parentElement;
  }
  const evInit = {
    key: "ArrowDown",
    code: "ArrowDown",
    keyCode: 40,
    which: 40,
    bubbles: true,
    cancelable: true
  };
  document.dispatchEvent(new KeyboardEvent("keydown", evInit));
  fireWheel(video || document.elementFromPoint(window.innerWidth * 0.4, window.innerHeight * 0.5), 900);
}

function autoScrollDown() {
  const root = findScrollRoot();
  const step = Math.max(520, Math.floor((root.clientHeight || window.innerHeight) * 0.8));
  const beforeTop = root.scrollTop;
  const beforeH = root.scrollHeight;
  const nearBottom = beforeTop + (root.clientHeight || 0) >= beforeH - 120;

  root.scrollTop = nearBottom ? beforeH : beforeTop + step;
  try {
    root.scrollBy(0, step);
  } catch (e) {}

  const mid = document.elementFromPoint(window.innerWidth * 0.38, window.innerHeight * 0.55);
  fireWheel(root, step);
  if (mid && mid !== root) fireWheel(mid, step);
  window.scrollBy(0, step);

  const moved = root.scrollTop !== beforeTop || root.scrollHeight !== beforeH;
  if (!moved) {
    stuckTicks += 1;
    cachedScrollRoot = null;
    if (stuckTicks >= 2) clickLoadMore();
    if (stuckTicks >= 3) {
      const se = document.scrollingElement || document.documentElement;
      se.scrollTop += step;
      fireWheel(document.body, step);
    }
  } else {
    stuckTicks = 0;
  }
}

function goNext() {
  if (!isPlayerMode() && !isSearchPage()) maybeSwitchChannel();
  if (isSearchPage()) maybeSwitchSearchWord();
  if (isPlayerMode()) goNextPlayer();
  else autoScrollDown();
  if (isSearchPage()) scanSearchDom();
}

function scanSearchDom() {
  if (!settings.collecting || !isSearchPage()) return;
  const links = document.querySelectorAll('a[href*="/user/"]');
  const seen = new Set();
  for (let i = 0; i < links.length; i++) {
    const a = links[i];
    const href = a.getAttribute("href") || "";
    const m = href.match(DyAccountParse.SEC_UID_RE);
    if (!m) continue;
    const card =
      a.closest("li") ||
      a.closest("article") ||
      a.closest('[class*="card"]') ||
      a.closest('[class*="Card"]') ||
      a.closest('[class*="item"]') ||
      a.parentElement;
    if (!card || seen.has(card) || isOurPanel(card)) continue;
    seen.add(card);
    const text = card.innerText || "";
    if (!text || text.length > 5000) continue;
    if (!DyAccountParse.blobHasDeclare(text)) continue;
    const hasMix = text.indexOf("合集") !== -1;
    if (settings.requireMix && !hasMix) continue;
    const videoA = card.querySelector('a[href*="/video/"]');
    const videoUrl = videoA ? videoA.getAttribute("href") || "" : "";
    const awemeId = (videoUrl.match(/\/video\/(\d+)/) || [])[1] || currentAwemeId();
    const rec = DyAccountParse.fromDomHints({
      awemeId: awemeId,
      secUid: m[0],
      nickname: String(a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 40),
      hasMix: hasMix,
      mixName: hasMix ? "合集" : ""
    });
    if (rec) handleRecords([rec], "search-dom");
  }
}

function stopAuto() {
  if (autoTimer) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
}

function jitterDelay() {
  const base = Math.max(1000, Number(settings.intervalMs) || 4000);
  if (Math.random() < 0.15) return base * 3 + Math.random() * base * 3;
  return base * 0.6 + Math.random() * base * 0.8;
}

function scheduleNext() {
  if (!isExtAlive()) return;
  if (autoTimer) clearTimeout(autoTimer);
  if (settings.collecting && settings.autoBrowse) {
    autoTimer = setTimeout(function () {
      if (!isExtAlive()) return;
      goNext();
      scheduleNext();
    }, jitterDelay());
  }
}

function syncAuto() {
  stopAuto();
  if (settings.collecting && settings.autoBrowse) {
    goNext();
    scheduleNext();
  }
}

function detectServiceError() {
  if (!settings.collecting || reloading) return;
  if (!visibleTextHas("服务异常")) return;
  reloading = true;
  settings.autoBrowse = false;
  stopAuto();
  stats.lastHint = "检测到服务异常，已停止下滑，即将刷新…";
  persist();
  renderPanel();
  setTimeout(function () {
    location.reload();
  }, 1500);
}

function detectSearchLimit() {
  if (!settings.collecting || reloading) return;
  if (!visibleTextHas("搜索过于频繁")) return;
  fatal = true;
  settings.collecting = false;
  settings.autoBrowse = false;
  settings.autoSwitchSearch = false;
  settings.autoSwitchChannel = false;
  stopAuto();
  stats.lastHint = "检测到搜索过于频繁，已停止采集与换词，请稍后重试";
  persist();
  renderPanel();
  notifySystem("搜索被限流", "检测到「搜索过于频繁」，已停止采集和自动换词，请等待一段时间后重试。");
}

function detectLogout() {
  if (!settings.collecting || fatal || reloading) return;
  if (!LOGOUT_TEXTS.some((t) => visibleTextHas(t))) return;
  fatal = true;
  settings.collecting = false;
  settings.autoBrowse = false;
  settings.autoSwitchSearch = false;
  settings.autoSwitchChannel = false;
  stopAuto();
  stats.lastHint = "检测到账号被登出，已停止采集，请重新登录后刷新页面再开始";
  persist();
  renderPanel();
  notifySystem("账号已登出", "检测到需要重新登录，采集已自动停止。请重新登录后刷新页面再开始。");
}

function resetCaptchaFlag() {
  captchaHandled = false;
  fatal = false;
  lastNewAuthorAt = Date.now();
  lastDataAt = Date.now();
  lastNavAt = Date.now();
  sessionStartAt = Date.now();
  stuckTicks = 0;
}

function detectCaptcha() {
  if (!settings.collecting || captchaHandled || reloading) return;
  const hit = CAPTCHA_TEXTS.some((t) => visibleTextHas(t));
  if (!hit) return;
  captchaHandled = true;
  fatal = true;
  settings.autoBrowse = false;
  settings.autoSwitchChannel = false;
  settings.autoSwitchSearch = false;
  stopAuto();
  stats.lastHint = "检测到人机验证，已暂停，请手动验证后点「自动下滑」恢复";
  persist();
  renderPanel();
  notifySystem("检测到人机验证", "采集已自动暂停，请手动完成页面验证后点「自动下滑」恢复。");
}

function notifySystem(title, message) {
  try {
    chrome.runtime.sendMessage({ type: "notify", title, message });
  } catch (e) {}
}

function detectNonCollectChannel() {
  if (!settings.collecting || reloading || captchaHandled || fatal) return;
  if (isSearchPage() || isPlayerMode()) return;
  const t = currentChannelTab();
  if (!t) return;
  if (AUTO_CHANNELS.some((c) => tabMatches(t, c))) return;
  fatal = true;
  settings.collecting = false;
  settings.autoBrowse = false;
  stopAuto();
  stats.lastHint = "非采集栏目「" + t + "」，已停止，请切换到 全部/二次元/小剧场";
  persist();
  renderPanel();
  notifySystem("非采集栏目", "当前栏目「" + t + "」不在采集范围，已自动停止。请切换到 全部/二次元/小剧场 后重新开始。");
}

function showIdlePrompt() {
  const el = document.getElementById(PANEL_ID);
  if (!el) return;
  const p = el.querySelector('[data-k="prompt"]');
  if (p) p.hidden = false;
}

function hideIdlePrompt() {
  const el = document.getElementById(PANEL_ID);
  if (!el) return;
  const p = el.querySelector('[data-k="prompt"]');
  if (p) p.hidden = true;
}

function detectIdlePrompt() {
  if (!settings.collecting || !settings.autoBrowse) return;
  if (captchaHandled || reloading || fatal) return;
  if (!settings.requireMix) return;
  if (Date.now() - lastNewAuthorAt < IDLE_PROMPT_MS) return;
  lastNewAuthorAt = Date.now();
  showIdlePrompt();
  stats.lastHint = "已 5 分钟无新作者，可在下方选择是否放宽条件";
  persist();
  renderPanel();
}

function detectNoResponse() {
  if (!settings.collecting || !settings.autoBrowse) return;
  if (captchaHandled || reloading || fatal) return;
  if (Date.now() - lastNavAt < SWITCH_GRACE_MS) return;
  if (Date.now() - lastDataAt < NO_RESPONSE_MS) return;
  fatal = true;
  settings.collecting = false;
  settings.autoBrowse = false;
  stopAuto();
  stats.lastHint = "连续无响应，已自动停止，请检查网络或页面状态";
  persist();
  renderPanel();
  notifySystem("采集已自动停止", "连续无响应，请检查网络或页面状态后重新开始。");
}

function channelState() {
  try {
    const idxRaw = sessionStorage.getItem("dyaccount_ci");
    const cntRaw = sessionStorage.getItem("dyaccount_cc");
    return {
      index: idxRaw === null ? -1 : (parseInt(idxRaw, 10) || 0),
      count: cntRaw === null ? 0 : (parseInt(cntRaw, 10) || 0)
    };
  } catch (e) {
    return { index: -1, count: 0 };
  }
}

function saveChannelState(idx, cnt) {
  try {
    sessionStorage.setItem("dyaccount_ci", String(idx));
    sessionStorage.setItem("dyaccount_cc", String(cnt));
  } catch (e) {}
}

function searchState() {
  try {
    const idxRaw = sessionStorage.getItem("dyaccount_si");
    const cntRaw = sessionStorage.getItem("dyaccount_sc");
    return {
      index: idxRaw === null ? -1 : (parseInt(idxRaw, 10) || 0),
      count: cntRaw === null ? 0 : (parseInt(cntRaw, 10) || 0)
    };
  } catch (e) {
    return { index: -1, count: 0 };
  }
}

function saveSearchState(idx, cnt) {
  try {
    sessionStorage.setItem("dyaccount_si", String(idx));
    sessionStorage.setItem("dyaccount_sc", String(cnt));
  } catch (e) {}
}

function loadSwitchLock() {
  return new Promise((resolve) => {
    chrome.storage.local.get("lastSwitchSearchAt", (data) => {
      lastSwitchAt = Number(data.lastSwitchSearchAt) || 0;
      resolve();
    });
  });
}

function setSwitchLock() {
  lastSwitchAt = Date.now();
  try {
    chrome.storage.local.set({ lastSwitchSearchAt: lastSwitchAt });
  } catch (e) {}
}

function makeSearchOrder(currentIdx) {
  const idx = [];
  for (let i = 0; i < SEARCH_WORDS.length; i++) idx.push(i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = idx[i];
    idx[i] = idx[j];
    idx[j] = t;
  }
  if (idx.length > 1 && idx[0] === currentIdx) {
    const j = 1 + Math.floor(Math.random() * (idx.length - 1));
    const t = idx[0];
    idx[0] = idx[j];
    idx[j] = t;
  }
  searchOrder = idx;
  searchOrderPos = 0;
}

function nextSearchWordIndex(currentIdx) {
  if (!searchOrder.length || searchOrderPos >= searchOrder.length) {
    makeSearchOrder(currentIdx);
  }
  let idx = searchOrder[searchOrderPos++];
  if (idx === currentIdx && searchOrderPos < searchOrder.length) {
    idx = searchOrder[searchOrderPos++];
  }
  return idx;
}

function switchSearchWord() {
  const now = Date.now();
  if (now - lastSwitchAt < (settings.switchSearchMinMs || SWITCH_SEARCH_MIN_MS)) return;
  setSwitchLock();
  const st = searchState();
  const currentIdx = st.index >= 0 ? st.index : 0;
  const next = nextSearchWordIndex(currentIdx);
  const word = SEARCH_WORDS[next];
  saveSearchState(next, 0);
  cachedScrollRoot = null;
  stuckTicks = 0;
  stats.lastHint = "换搜索词 → " + word;
  persist();
  renderPanel();
  lastNavAt = Date.now();
  setTimeout(function () {
    location.href = "https://www.douyin.com/search/" + encodeURIComponent(word);
  }, 500);
}

function maybeSwitchSearchWord() {
  if (!settings.autoSwitchSearch) return;
  const st = searchState();
  st.count += 1;
  saveSearchState(st.index, st.count);
  if (st.count >= SWITCH_SEARCH_AFTER || stuckTicks >= 3) {
    switchSearchWord();
  }
}

function normTab(t) {
  return String(t || "").replace(/\s+/g, "");
}

function tabMatches(t, name) {
  const a = normTab(t);
  const b = normTab(name);
  return a === b || (b !== "" && a.indexOf(b) === 0);
}

function findChannelTablist() {
  const lists = document.querySelectorAll('[role="tablist"], [class*="semi-tabs-tab-list"], [class*="semi-tabs-bar"]');
  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    if (isOurPanel(list)) continue;
    const tabs = list.querySelectorAll('[role="tab"], [class*="semi-tabs-tab"]');
    for (let j = 0; j < tabs.length; j++) {
      if (tabMatches((tabs[j].innerText || tabs[j].textContent || ""), "全部")) return list;
    }
  }
  return null;
}

function currentChannelTab() {
  const list = findChannelTablist();
  if (!list) return null;
  const tabs = list.querySelectorAll('[role="tab"], [class*="semi-tabs-tab"]');
  for (let i = 0; i < tabs.length; i++) {
    const el = tabs[i];
    if (isOurPanel(el)) continue;
    const t = (el.innerText || el.textContent || "").trim();
    if (!t) continue;
    const sel = el.getAttribute("aria-selected");
    const cls = el.className || "";
    if (sel === "true" || /(active|selected)/i.test(cls)) return normTab(t);
  }
  return null;
}

function findChannelTab(name) {
  const precise = document.querySelectorAll('[role="tab"], [class*="semi-tabs-tab"]');
  for (let i = 0; i < precise.length; i++) {
    const el = precise[i];
    if (isOurPanel(el)) continue;
    const t = (el.innerText || el.textContent || "").trim();
    if (tabMatches(t, name)) return el;
  }
  const nodes = document.querySelectorAll("span,div,li,button");
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (isOurPanel(el)) continue;
    const t = (el.innerText || el.textContent || "").trim();
    if (tabMatches(t, name) && el.childElementCount <= 1) {
      const c = el.closest('[role="tab"], [class*="tab"]');
      if (c && !isOurPanel(c)) return c;
    }
  }
  return null;
}

function switchChannel() {
  const st = channelState();
  const next = (st.index + 1) % AUTO_CHANNELS.length;
  const name = AUTO_CHANNELS[next];
  saveChannelState(next, 0);
  const tab = findChannelTab(name);
  if (!tab) {
    stats.lastHint = "自动换栏目：未找到「" + name + "」，保持当前";
    renderPanel();
    return;
  }
  tab.click();
  lastNavAt = Date.now();
  cachedScrollRoot = null;
  stuckTicks = 0;
  stats.lastHint = "自动换栏目 → " + name;
  renderPanel();
}

function maybeSwitchChannel() {
  if (!settings.autoSwitchChannel) return;
  const st = channelState();
  st.count += 1;
  saveChannelState(st.index, st.count);
  if (st.count >= SWITCH_AFTER_SCROLLS || stuckTicks >= 3) {
    switchChannel();
  }
}

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.source !== MSG_HOOK) return;
  const payload = data.payload;
  if (!payload) return;
  if (payload.type === "ready") {
    sendHookCollecting();
    return;
  }
  if (payload.type === "api" && payload.body) {
    ingestJson(payload.body, "api");
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "getState") {
    sendResponse({ settings, authors: authorList(), stats });
    return;
  }
  if (msg.type === "setSettings") {
    settings = { ...settings, ...msg.settings };
    if (msg.settings && (msg.settings.collecting || msg.settings.autoBrowse)) resetCaptchaFlag();
    sendHookCollecting();
    syncAuto();
    persist();
    renderPanel();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "clear") {
    authors = {};
    stats.matched = 0;
    recent = [];
    persist();
    renderPanel();
    sendResponse({ ok: true });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.authors) {
    authors = changes.authors.newValue || {};
    renderPanel();
  }
  if (changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    sendHookCollecting();
    syncAuto();
    renderPanel();
  }
});

let lastHref = location.href;
const spaTimer = setInterval(() => {
  if (!isExtAlive()) {
    clearInterval(spaTimer);
    return;
  }
  if (location.href === lastHref) return;
  lastHref = location.href;
  cachedScrollRoot = null;
  stuckTicks = 0;
  if (!document.getElementById(PANEL_ID)) ensurePanel();
  if (settings.collecting) {
    scanRenderData();
    scanCurrentPlayerDom();
    scanSearchDom();
  }
}, 800);

function boot() {
  loadState().then(() => loadSwitchLock()).then(() => {
    const mount = () => {
      ensurePanel();
      renderPanel();
      sendHookCollecting();
      syncAuto();
      if (settings.collecting) {
        scanRenderData();
        scanCurrentPlayerDom();
        scanSearchDom();
      }
    };
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
    const patrolTimer = setInterval(() => {
      if (!isExtAlive()) {
        clearInterval(patrolTimer);
        return;
      }
      if (!settings.collecting) return;
      scanCurrentPlayerDom();
      scanSearchDom();
      detectServiceError();
      detectSearchLimit();
      detectCaptcha();
      detectLogout();
      detectNonCollectChannel();
      detectIdlePrompt();
      detectNoResponse();
    }, 2500);
  });
}

boot();
