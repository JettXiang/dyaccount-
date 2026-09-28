function setBadge(count) {
  const text = count > 0 ? String(count > 999 ? "999+" : count) : "";
  chrome.action.setBadgeBackgroundColor({ color: "#fe2c55" });
  chrome.action.setBadgeText({ text });
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["settings", "authors", "stats"]);
  if (!data.settings) {
    await chrome.storage.local.set({
      settings: {
        collecting: false,
        autoBrowse: false,
        intervalMs: 2800,
        requireMix: true,
        requireAi: true,
        collapsed: false
      }
    });
  }
  if (!data.authors) await chrome.storage.local.set({ authors: {} });
  if (!data.stats) await chrome.storage.local.set({ stats: { scanned: 0, matched: 0 } });
  const n = Object.keys((data.authors || {})).length;
  setBadge(n);
});

chrome.runtime.onStartup.addListener(async () => {
  const data = await chrome.storage.local.get("authors");
  setBadge(Object.keys(data.authors || {}).length);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "badge") {
    setBadge(Number(msg.count) || 0);
  } else if (msg.type === "notify") {
    try {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: String(msg.title || "抖音AI合集作者采集"),
        message: String(msg.message || ""),
        priority: 2
      });
    } catch (e) {}
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.authors) return;
  setBadge(Object.keys(changes.authors.newValue || {}).length);
});
