(function () {
  "use strict";

  // ---------- 状态 ----------
  var rows = [];            // 当前 CSV 解析后的作者数组
  var pool = loadPool();    // 本地累计的 sec_uid 集合（数组形式存 localStorage）
  var filter = "all";
  var aiResult = loadAi(); // AI 复核结果缓存 sec_uid -> {ok, reason}

  var DEFAULT_WL = "漫剧,短剧,AIGC,动漫,动画,次元,穿越,重生,逆袭,赘婿,战神,系统,王妃,豪门,漫画,番剧,小剧场,剧场,剧集,末世,自制动画";
  var DEFAULT_BL = "汪汪队,立大功,民间故事,寓言,动物世界,怀旧,童年,军旅,科普,双语,跟读,后室,未解之谜,领养,咕嘎,人生副本,阅读,育儿,儿童,宝宝,儿歌,纪录片,解说,混剪,搬运,影视解说";

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, "").toUpperCase(); }
  function kv(words) {
    return words.split(/[,，\n]/).map(function (w) { return norm(w); }).filter(Boolean);
  }

  function loadPool() {
    try {
      var raw = localStorage.getItem("dyaccount_plus_pool");
      if (!raw) return {};
      var d = JSON.parse(raw);
      if (Array.isArray(d)) {
        // v1.1.4 迁移：旧格式（sec_uid 数组）→ 频次对象
        var o = {};
        d.forEach(function (s) {
          if (s) o[s] = { count: 1, first: 0, last: 0, nickname: "", mixName: "", videoCount: 0 };
        });
        return o;
      }
      return d && typeof d === "object" ? d : {};
    } catch (e) { return {}; }
  }
  function savePool() {
    try { localStorage.setItem("dyaccount_plus_pool", JSON.stringify(pool)); } catch (e) {}
  }

  function loadAi() {
    try { return JSON.parse(localStorage.getItem("dyaccount_plus_ai") || "{}"); } catch (e) { return {}; }
  }
  function saveAi() {
    try { localStorage.setItem("dyaccount_plus_ai", JSON.stringify(aiResult)); } catch (e) {}
  }

  // ---------- CSV 解析 ----------
  function parseCsv(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    var lines = text.split(/\r\n|\r|\n/).filter(function (l) { return l.trim(); });
    if (!lines.length) return [];
    var header = splitLine(lines[0]).map(function (h) { return String(h).trim(); });
    var idx = {
      nickname: header.indexOf("昵称"),
      secUid: Math.max(header.indexOf("sec_uid"), header.indexOf("secUid"), header.indexOf("sec_id")),
      mixName: header.indexOf("合集名"),
      searchWord: header.indexOf("搜索词"),
      videoCount: Math.max(header.indexOf("视频数"), header.indexOf("videoCount"))
    };
    var out = [];
    for (var i = 1; i < lines.length; i++) {
      var c = splitLine(lines[i]);
      out.push({
        nickname: c[idx.nickname] || "",
        secUid: c[idx.secUid] || "",
        mixName: c[idx.mixName] || "",
        searchWord: idx.searchWord >= 0 ? (c[idx.searchWord] || "") : "",
        videoCount: parseInt(c[idx.videoCount], 10) || 0
      });
    }
    return out;
  }

  function splitLine(line) {
    var out = [], cur = "", inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { out.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  // ---------- 判定 ----------
  function getWl() { return kv($("whitelist").value || DEFAULT_WL); }
  function getBl() { return kv($("blacklist").value || DEFAULT_BL); }
  function getVMin() { return parseInt($("videoMin").value, 10) || 2; }
  function getHighMin() { return parseInt(($("highMin") || {}).value, 10) || 2; }

  function poolSize() { return Object.keys(pool).length; }
  function inPool(secUid) { return !!(secUid && pool[secUid]); }

  // v1.1.4 高置信：出现频次 ≥ 阈值 且 规则通过；若已有 LLM 判定，判否则剔除
  function poolCount(secUid) {
    var e = pool[secUid];
    return e ? (e.count || 1) : 0;
  }
  // 入池/累积频次（保存汇报时调用）；同一作者 count +1，并回填昵称/合集/视频数
  function poolAdd(secUid, row) {
    if (!secUid) return;
    var e = pool[secUid];
    if (e) {
      e.count = (e.count || 1) + 1;
      e.last = Date.now();
      if (row) {
        if (!e.nickname && row.nickname) e.nickname = row.nickname;
        if (!e.mixName && row.mixName) e.mixName = row.mixName;
        if (!e.videoCount && row.videoCount) e.videoCount = row.videoCount;
      }
    } else {
      pool[secUid] = { count: 1, first: Date.now(), last: Date.now(), nickname: row ? row.nickname : "", mixName: row ? row.mixName : "", videoCount: row ? row.videoCount : 0 };
    }
  }
  function isHighConf(r) {
    if (poolCount(r.secUid) < getHighMin()) return false;
    if (!r._target) return false;
    var a = aiResult[r.secUid];
    if (a && !a.ok) return false;
    return true;
  }

  function isTarget(row, wl, bl, vmin) {
    var text = norm(row.mixName) + norm(row.nickname);
    if (!text) return false;
    for (var i = 0; i < bl.length; i++) if (text.indexOf(bl[i]) !== -1) return false;
    var hit = false;
    for (var j = 0; j < wl.length; j++) if (text.indexOf(wl[j]) !== -1) { hit = true; break; }
    if (!hit) return false;
    return (row.videoCount || 0) >= vmin;
  }

  function targetRows() {
    var wl = getWl(), bl = getBl(), vmin = getVMin();
    return rows.filter(function (r) { return isTarget(r, wl, bl, vmin); });
  }

  // ---------- exe 结果解析 ----------
  function parseExe(text) {
    var t = text || "";
    function pick(patterns, def) {
      for (var i = 0; i < patterns.length; i++) {
        var m = t.match(patterns[i]);
        if (m) return parseInt(m[1], 10);
      }
      return def;
    }
    return {
      fileValid: pick([/文件有效数量[：:]\s*(\d+)/, /读取完成[，,]共\s*(\d+)\s*个去重/, /共\s*(\d+)\s*个去重后/], null),
      newCount: pick([/本次新增数量[：:]\s*(\d+)/, /本次新增[：:]\s*(\d+)/], null),
      total: pick([/Redis\s*集合总数[：:]\s*(\d+)/, /集合总数[：:]\s*(\d+)/], null)
    };
  }

  // ---------- 渲染 ----------
  function analyze() {
    var wl = getWl(), bl = getBl(), vmin = getVMin();
    rows.forEach(function (r) {
      r._target = isTarget(r, wl, bl, vmin);
      r._high = isHighConf(r);
    });
    var yes = rows.filter(function (r) { return r._target; });
    var high = rows.filter(function (r) { return r._high; });
    $("tagTarget").textContent = "重点 " + yes.length;
    $("tagOther").textContent = "非重点 " + (rows.length - yes.length);
    $("tagHigh").textContent = "高置信 " + high.length;
    $("tagTotal").textContent = "共 " + rows.length + " 条";
    renderTable();
    updateReport();
  }

  function renderTable() {
    var tbody = $("resultTable").querySelector("tbody");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">尚未导入数据</td></tr>';
      return;
    }
    var list = rows.filter(function (r) {
      if (filter === "yes") return r._target;
      if (filter === "no") return !r._target;
      if (filter === "high") return r._high;
      return true;
    });
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var pc = poolCount(r.secUid);
      var style = r._high ? ' style="background:rgba(76,141,255,.07)"' : '';
      html += '<tr' + style + '><td>' + esc(r.nickname) + '</td><td>' + esc(r.mixName) + '</td><td>' + r.videoCount + '</td><td class="muted">' + esc(r.searchWord || "—") + '</td><td>' +
        (pc ? pc + " 次" : '<span class="muted">0</span>') + '</td><td>' +
        (r._target ? '<span class="tag ok">重点</span>' : '<span class="tag no">非重点</span>') + '</td><td>' +
        aiCell(r.secUid) + '</td></tr>';
    }
    tbody.innerHTML = html || '<tr><td colspan="7" class="muted">（该筛选下无数据）</td></tr>';
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function aiCell(secUid) {
    var a = aiResult[secUid];
    if (!a) return '<span class="muted">—</span>';
    var t = a.reason ? esc(a.reason) : "";
    return a.ok
      ? '<span class="tag ok" title="' + t + '">✓</span>'
      : '<span class="tag no" title="' + t + '">✗</span>';
  }

  function updateReport() {
    var exe = {
      fileValid: parseInt($("exeFileValid").value, 10),
      newCount: parseInt($("exeNew").value, 10),
      total: parseInt($("exeTotal").value, 10)
    };
    var uniq = uniqCount(rows.map(function (r) { return r.secUid; }));   // 文件有效数 = CSV 去重数
    var fileValid = Number.isFinite(exe.fileValid) ? exe.fileValid : uniq;
    var newCount = Number.isFinite(exe.newCount) ? exe.newCount : 0;
    var total = Number.isFinite(exe.total) ? exe.total : 0;
    var rate = fileValid > 0 ? (newCount / fileValid) * 100 : 0;
    var targetNum = targetRows().length;
    var highNum = rows.filter(function (r) { return r._high; }).length;

    // 本地累计池（对象：sec_uid -> {count, first, last, ...}）
    var addedThisTime = 0;
    if (rows.length) {
      var added = {};
      rows.forEach(function (r) {
        if (r.secUid && !inPool(r.secUid) && !added[r.secUid]) { added[r.secUid] = 1; addedThisTime++; }
      });
    }
    var totalPool = poolSize() + addedThisTime;   // 本次导入后的池大小近似

    $("r1").textContent = total ? total : "—";
    $("r2").textContent = newCount;
    $("r3").textContent = (isFinite(rate) ? rate.toFixed(2) : "0.00") + "%";
    $("r4").textContent = fileValid;
    $("r5").textContent = totalPool;
    $("r6").textContent = rows.length ? addedThisTime : "—";
    $("r7").textContent = targetNum;
    $("r7h").textContent = highNum;
    var reviewValid = parseInt($("r8Input").value, 10) || 0;
    var realRate = targetNum > 0 ? (reviewValid / targetNum) * 100 : 0;
    $("r9").textContent = (isFinite(realRate) ? realRate.toFixed(2) : "0.00") + "%";

    var line = "采集总量（redis总量）：" + (total || 0) +
      "\n本次新增：" + newCount +
      "\n转化率：" + (isFinite(rate) ? rate.toFixed(2) : "0.00") + "%" +
      "\n文件有效数：" + fileValid +
      "\n总计（包含前面采集到的）：" + totalPool +
      "\n新增作者：" + (rows.length ? addedThisTime : 0) + "名" +
      "\n重点关注（符合判断条件的）：" + targetNum + "个" +
      "\n高置信作者数：" + highNum + "个" +
      "\n人工复核后真实有效数：" + reviewValid + "个" +
      "\n实际有效转化率：" + (isFinite(realRate) ? realRate.toFixed(2) : "0.00") + "%";
    $("reportText").textContent = line;
  }

  function uniqCount(arr) {
    var s = {};
    arr.forEach(function (x) { if (x) s[x] = 1; });
    return Object.keys(s).length;
  }

  // ---------- 事件 ----------
  function readFile(file, cb) {
    var fr = new FileReader();
    fr.onload = function () { cb(fr.result); };
    fr.readAsText(file, "utf-8");
  }

  function handleFile(file) {
    if (!file) return;
    readFile(file, function (text) {
      rows = parseCsv(text);
      $("csvInfo").textContent = "已导入 " + rows.length + " 行（去重 " + uniqCount(rows.map(function (r) { return r.secUid; })) + " 个 sec_uid）";
      analyze();
    });
  }

  var drop = $("drop");
  drop.addEventListener("click", function () { $("fileInput").click(); });
  $("fileInput").addEventListener("change", function (e) { handleFile(e.target.files[0]); });
  drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
  drop.addEventListener("drop", function (e) {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  $("exeText").addEventListener("input", function () {
    var exe = parseExe(this.value);
    if (exe.fileValid != null) $("exeFileValid").value = exe.fileValid;
    if (exe.newCount != null) $("exeNew").value = exe.newCount;
    if (exe.total != null) $("exeTotal").value = exe.total;
    updateReport();
  });
  ["exeFileValid", "exeNew", "exeTotal", "videoMin", "r8Input"].forEach(function (id) {
    $(id).addEventListener("input", updateReport);
  });
  $("highMin").addEventListener("input", analyze);   // 改阈值要重判高置信

  $("btnAnalyze").addEventListener("click", function () { analyze(); });

  document.querySelectorAll("[data-filter]").forEach(function (b) {
    b.addEventListener("click", function () {
      filter = b.getAttribute("data-filter");
      renderTable();
    });
  });

  $("btnCopy").addEventListener("click", function () {
    var text = $("reportText").textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("已复制"); }, function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  });

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("已复制"); } catch (e) { toast("复制失败，请手动选择复制"); }
    document.body.removeChild(ta);
  }

  $("btnSave").addEventListener("click", function () {
    var text = $("reportText").textContent;
    if (!text || text.indexOf("采集总量") === -1) { toast("请先生成汇报"); return; }
    // 提交本地累计池（把本次新增作者入池）
    commitPool();
    var hist = loadHist();
    hist.unshift({ time: new Date().toLocaleString("zh-CN"), text: text });
    try { localStorage.setItem("dyaccount_plus_hist", JSON.stringify(hist.slice(0, 100))); } catch (e) {}
    renderHistory();
    toast("已保存到历史");
  });

  // 保存汇报时把本次作者入池：新作者 count=1，老作者 count+1
  // 注意：只刷新表格（出现次数/高置信），不重算汇报文案，保证「本次新增」口径不被清零
  function commitPool() {
    rows.forEach(function (r) { poolAdd(r.secUid, r); });
    savePool();
    rows.forEach(function (r) { r._high = isHighConf(r); });
    renderTable();
  }

  function loadHist() {
    try { return JSON.parse(localStorage.getItem("dyaccount_plus_hist") || "[]"); } catch (e) { return []; }
  }
  function renderHistory() {
    var hist = loadHist();
    var el = $("history");
    if (!hist.length) { el.innerHTML = '<div class="muted">暂无记录</div>'; return; }
    el.innerHTML = hist.map(function (h) {
      return '<div class="hist-item"><div class="t">' + esc(h.time) + '</div><div class="rpt">' + esc(h.text) + '</div></div>';
    }).join("");
  }

  $("btnResetPool").addEventListener("click", function () {
    if (!confirm("确定清空本地累计池吗？（不影响已导入数据）")) return;
    pool = {}; savePool(); analyze(); toast("已清空累计池");
  });

  // 导出名单 CSV（重点 / 高置信共用）
  function exportList(list, prefix) {
    if (!list.length) { toast("没有可导出的名单"); return; }
    var head = "昵称,sec_uid,合集名,视频数,搜索词,出现次数,判定";
    var lines = [head];
    list.forEach(function (r) {
      lines.push([
        r.nickname, r.secUid, r.mixName, r.videoCount,
        r.searchWord || "", poolCount(r.secUid), r._target ? "重点" : "非重点"
      ].map(csvCell).join(","));
    });
    var blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = prefix + "_" + stamp() + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  $("btnExportCsv").addEventListener("click", function () { exportList(targetRows(), "重点名单"); });
  $("btnExportHigh").addEventListener("click", function () {
    exportList(rows.filter(function (r) { return r._high; }), "高置信名单");
  });

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
  }

  // AI 复核（DeepSeek 离线粘贴式）
  $("btnGenPrompt").addEventListener("click", function () {
    var list = targetRows();
    if (!list.length) { toast("没有重点名单可复核"); return; }
    var data = list.map(function (r) { return { sid: r.secUid, 昵称: r.nickname, 合集: r.mixName, 视频数: r.videoCount }; });
    var sys = "你是抖音AI短剧/漫剧内容审核员。判断下面作者是否属于「AI生成的短剧/漫剧/动画」作者（重点看合集名与昵称是否吻合AI漫剧/短剧/动画题材，排除真人短剧、民间故事、科普、搬运解说、动物儿童等）。\n只输出一个JSON数组，不要任何多余文字，格式：[{\"sid\":\"...\",\"ok\":true,\"reason\":\"3-6字理由\"}]";
    var prompt = sys + "\n作者列表（共" + data.length + "条）：\n" + JSON.stringify(data);
    copyText(prompt);
    $("aiInfo").textContent = "已复制 " + data.length + " 条重点名单，去 DeepSeek 粘贴后把结果粘回下面";
  });

  $("btnApplyAi").addEventListener("click", function () {
    var txt = $("aiResult").value.trim();
    if (!txt) { toast("请先粘贴 AI 返回结果"); return; }
    var arr = extractJson(txt);
    if (!arr) { toast("没解析出 JSON 数组，请确认是 [{...}] 格式"); return; }
    var okCount = 0, n = 0;
    arr.forEach(function (it) {
      if (it && it.sid) {
        aiResult[it.sid] = { ok: !!it.ok, reason: it.reason || "" };
        if (it.ok) okCount++;
        n++;
      }
    });
    saveAi();
    renderTable();
    $("aiInfo").textContent = "已应用 " + n + " 条，AI 判定有效 " + okCount + " 条";
    toast("已应用 " + n + " 条");
  });

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { toast("已复制"); }, function () { fallbackCopy(t); });
    } else fallbackCopy(t);
  }

  function extractJson(txt) {
    var s = txt.indexOf("["), e = txt.lastIndexOf("]");
    if (s === -1 || e === -1 || e <= s) return null;
    try { var v = JSON.parse(txt.slice(s, e + 1)); return Array.isArray(v) ? v : null; }
    catch (err) { return null; }
  }

  function toast(msg) {
    var el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#2fd07a;color:#0f1420;padding:9px 18px;border-radius:20px;font-weight:600;z-index:999;box-shadow:0 4px 16px rgba(0,0,0,.3)";
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 1600);
  }

  // ---------- 初始化 ----------
  renderHistory();
  updateReport();
})();
