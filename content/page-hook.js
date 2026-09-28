/**
 * Runs in the page MAIN world. Hooks fetch/XHR so we can read Douyin feed JSON
 * using the user's already-authenticated browser session.
 */
(function () {
  "use strict";
  if (window.__dyAccountHooked) return;
  window.__dyAccountHooked = true;

  var collecting = false;
  var SOURCE = "dyaccount-hook";
  var CONTROL = "dyaccount-ctl";

  var IGNORE =
    /\/(comment|danmaku|im\/|report|log\/|hotsoon|webcast|live\/|poi\/|city\/|abtest|web\/page)/i;
  var INTEREST =
    /\/(aweme|module\/feed|tab\/feed|mix\/|aweme\/detail|aweme\/post|general\/search|search\/item|search\/single|search\/stream|recommend|jingxuan|web\/module|web\/search|discover\/search)/i;

  function interestingUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (url.indexOf("douyin.com") === -1 && url.indexOf("iesdouyin.com") === -1) return false;
    if (IGNORE.test(url)) return false;
    return INTEREST.test(url) || /feed/.test(url) || /\/search\//.test(url);
  }

  function emit(payload) {
    try {
      window.postMessage({ source: SOURCE, payload: payload }, "*");
    } catch (e) {}
  }

  function handleBody(url, text) {
    if (!collecting) return;
    if (!text || text.length < 20 || text.length > 8000000) return;
    var trimmed = text.charAt(0);
    if (trimmed !== "{" && trimmed !== "[") return;
    emit({ type: "api", url: String(url || "").slice(0, 500), body: text });
  }

  function hookFetch() {
    if (!window.fetch) return;
    var orig = window.fetch;
    window.fetch = function () {
      var args = arguments;
      var input = args[0];
      var url = "";
      try {
        url = typeof input === "string" ? input : input && input.url ? input.url : "";
      } catch (e) {}
      return orig.apply(this, args).then(function (res) {
        try {
          if (interestingUrl(url || (res && res.url))) {
            res
              .clone()
              .text()
              .then(function (text) {
                handleBody(url || res.url, text);
              })
              .catch(function () {});
          }
        } catch (e) {}
        return res;
      });
    };
  }

  function hookXhr() {
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__dyUrl = url;
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener("load", function () {
        try {
          var url = xhr.__dyUrl || "";
          if (!interestingUrl(url)) return;
          var text = xhr.responseText;
          handleBody(url, text);
        } catch (e) {}
      });
      return send.apply(this, arguments);
    };
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var data = ev.data;
    if (!data || data.source !== CONTROL) return;
    if (data.collecting === true || data.collecting === false) collecting = data.collecting;
  });

  hookFetch();
  hookXhr();
  emit({ type: "ready" });
})();
