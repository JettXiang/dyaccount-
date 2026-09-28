const DEFAULT_SETTINGS = {
  collecting: false,
  autoBrowse: false,
  intervalMs: 4000,
  requireMix: true,
  requireAi: true,
  autoSwitchChannel: false,
  autoSwitchSearch: false,
  collapsed: false
};

function authorList(map) {
  return Object.keys(map || {})
    .map((k) => map[k])
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

async function load() {
  const data = await chrome.storage.local.get(["settings", "authors", "stats"]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    authors: authorList(data.authors || {}),
    stats: data.stats || { scanned: 0, matched: 0 }
  };
}

function render(state) {
  document.getElementById("count").textContent = String(state.authors.length);
  document.getElementById("scanned").textContent = String(state.stats.scanned || 0);
  document.getElementById("collecting").textContent = state.settings.collecting ? "采集中" : "未开始";
  document.getElementById("toggle").textContent = state.settings.collecting ? "停止采集" : "开始采集";
  document.getElementById("auto").textContent = state.settings.autoBrowse ? "停止自动下滑" : "自动下滑";
  document.getElementById("requireMix").checked = state.settings.requireMix !== false;
  document.getElementById("requireAi").checked = state.settings.requireAi !== false;
  document.getElementById("intervalMs").value = String(state.settings.intervalMs || 4000);
  document.getElementById("autoSwitchChannel").checked = !!state.settings.autoSwitchChannel;
  document.getElementById("autoSwitchSearch").checked = !!state.settings.autoSwitchSearch;

  const list = document.getElementById("list");
  if (!state.authors.length) {
    list.innerHTML = '<div class="empty">还没有作者。打开精选或搜索页后开始采集。</div>';
    return;
  }
  list.innerHTML = state.authors
    .map((a) => {
      const name = escapeHtml(a.nickname || "(无昵称)");
      const mix = escapeHtml(a.mixName || "合集");
      const id = escapeHtml(a.secUid);
      const href = "https://www.douyin.com/user/" + encodeURIComponent(a.secUid);
      return `<div class="item">
        <div class="name">${name}</div>
        <div class="meta">${mix} · ${a.videoCount || 1} 条</div>
        <a class="id" href="${href}" target="_blank" rel="noreferrer">${id}</a>
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function patchSettings(partial) {
  const data = await chrome.storage.local.get("settings");
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}), ...partial };
  await chrome.storage.local.set({ settings });
  await pingTabs({ type: "setSettings", settings });
}

async function pingTabs(message) {
  const tabs = await chrome.tabs.query({ url: ["*://*.douyin.com/*"] });
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs.sendMessage(tab.id, message).catch(() => null)
    )
  );
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsv(authors) {
  const header = ["昵称", "sec_uid", "unique_id", "uid", "合集名", "mix_id", "sample_url", "视频数"];
  const lines = [header.join(",")];
  for (const a of authors) {
    const row = [
      a.nickname,
      a.secUid,
      a.uniqueId,
      a.uid,
      a.mixName,
      a.mixId,
      a.sampleUrl,
      a.videoCount || 1
    ].map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`);
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.getAttribute("data-act");
  const state = await load();
  if (act === "toggle") {
    await patchSettings({ collecting: !state.settings.collecting, autoBrowse: state.settings.collecting ? false : state.settings.autoBrowse });
  } else if (act === "auto") {
    const next = !state.settings.autoBrowse;
    await patchSettings({ autoBrowse: next, collecting: next ? true : state.settings.collecting });
  } else if (act === "open") {
    await chrome.tabs.create({ url: "https://www.douyin.com/jingxuan" });
  } else if (act === "backend") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("dyaccount_v1.1.4.html") });
  } else if (act === "copy") {
    const ids = state.authors.map((a) => a.secUid).join("\n");
    if (ids) await navigator.clipboard.writeText(ids);
  } else if (act === "json") {
    download(
      "douyin-ai-mix-authors.json",
      JSON.stringify({ exportedAt: new Date().toISOString(), count: state.authors.length, authors: state.authors }, null, 2),
      "application/json"
    );
  } else if (act === "csv") {
    download("douyin-ai-mix-authors.csv", toCsv(state.authors), "text/csv");
  } else if (act === "txt") {
    download("douyin-ai-mix-authors.txt", state.authors.map((a) => a.secUid).join("\n"), "text/plain");
  } else if (act === "clear") {
    if (!confirm("清空已采集作者？")) return;
    await chrome.storage.local.set({ authors: {}, stats: { scanned: state.stats.scanned || 0, matched: 0 } });
    await pingTabs({ type: "clear" });
  }
  render(await load());
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.id === "requireMix") await patchSettings({ requireMix: el.checked });
  if (el.id === "requireAi") await patchSettings({ requireAi: el.checked });
  if (el.id === "intervalMs") await patchSettings({ intervalMs: Number(el.value) || 4000 });
  if (el.id === "autoSwitchChannel") await patchSettings({ autoSwitchChannel: el.checked });
  if (el.id === "autoSwitchSearch") await patchSettings({ autoSwitchSearch: el.checked });
  render(await load());
});

chrome.storage.onChanged.addListener(async () => {
  render(await load());
});

load().then(render);
