// Talay language menu.
// Turns every <select data-langmenu> into a small pill button with a light menu in Talay style,
// instead of the grey system list (macOS) that cannot be styled.
// The <select> stays in the page (hidden): choosing a language sets its value and fires "change",
// so each page keeps its own handler (homepage, /next, booking page). Without JavaScript the plain select still works.
(function () {
  var NAMES = { en: "English", es: "Español", fr: "Français", de: "Deutsch", nl: "Nederlands", th: "ไทย", zh: "中文", ru: "Русский", it: "Italiano", ko: "한국어" };

  var css =
    ".lm{position:relative;display:inline-block}" +
    ".lm-btn{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;-webkit-appearance:none;appearance:none;cursor:pointer;transition:border-color .15s,background-color .15s}" +
    ".lm-btn svg{flex:none;opacity:.85}" +
    ".lm-btn:hover,.lm-btn[aria-expanded=true]{background-image:linear-gradient(rgba(255,255,255,.1),rgba(255,255,255,.1))}" +
    ".lm-btn:focus-visible{outline:3px solid #E0A84A;outline-offset:3px}" +
    ".lm-menu{position:fixed;z-index:1000;max-height:calc(100vh - 24px);overflow-y:auto;box-sizing:border-box;min-width:190px;margin:0;padding:6px;list-style:none;background:#FBF8F1;color:#09262F;border:1px solid #E2DACB;border-radius:14px;box-shadow:0 14px 40px rgba(9,38,47,.28);font:500 15px/1.4 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;text-align:left;text-transform:none;letter-spacing:normal}" +
    ".lm-menu[hidden]{display:none}" +
    ".lm-menu li{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:9px;cursor:pointer;white-space:nowrap;outline:none}" +
    ".lm-menu li.on{background:#F4F0E6}" +
    ".lm-menu li .c{margin-left:auto;font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#7A8A90}" +
    ".lm-menu li[aria-selected=true]{font-weight:700}" +
    ".lm-menu li[aria-selected=true] .c{color:#09262F}" +
    ".lm-menu li[aria-selected=true]::before{content:\"\";width:8px;height:8px;margin-left:-2px;border-radius:50%;background:#E0A84A;order:3}" +
    ".lm-menu li:not([aria-selected=true])::before{content:\"\";width:8px;order:3}";

  // What the button copies from the select, so it keeps each page's own look (also a centre's own colours).
  var LOOK = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "color", "backgroundColor", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius", "paddingTop", "paddingBottom", "paddingLeft", "minHeight", "letterSpacing", "textTransform"];
  var PLACE = ["marginTop", "marginRight", "marginBottom", "marginLeft", "alignSelf", "flexGrow", "flexShrink", "order", "verticalAlign"];

  var CHEV = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function enhance(sel) {
    if (sel.dataset.lmDone) return;
    sel.dataset.lmDone = "1";
    var cs = getComputedStyle(sel);
    var wrap = document.createElement("span");
    wrap.className = "lm";
    PLACE.forEach(function (p) { wrap.style[p] = cs[p]; });
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lm-btn";
    LOOK.forEach(function (p) { btn.style[p] = cs[p]; });
    btn.style.paddingRight = Math.max(10, parseFloat(cs.paddingLeft) || 10) + "px";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    var menu = document.createElement("ul");
    menu.className = "lm-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    menu.id = (sel.id || "lang") + "-lm";
    btn.setAttribute("aria-controls", menu.id);
    var label = sel.getAttribute("aria-label") || (sel.closest("label") && sel.closest("label").textContent.trim()) || "Language";
    menu.setAttribute("aria-label", label);

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    wrap.appendChild(sel);
    sel.style.display = "none";
    sel.tabIndex = -1;

    var opts = [].slice.call(sel.options);
    menu.innerHTML = opts.map(function (o) {
      var v = o.value, name = NAMES[v] || o.textContent;
      return '<li role="option" tabindex="-1" lang="' + esc(v) + '" data-v="' + esc(v) + '" aria-selected="' + (o.selected) + '"><span>' + esc(name) + '</span><span class="c">' + esc(v) + "</span></li>";
    }).join("");
    var cur = opts[sel.selectedIndex] || opts[0];
    btn.innerHTML = "<span>" + esc(cur ? cur.textContent.trim() : "") + "</span>" + CHEV;
    btn.setAttribute("aria-label", label + ": " + (cur ? NAMES[cur.value] || cur.textContent : ""));

    var items = [].slice.call(menu.children), at = 0;
    function mark(i, focus) {
      at = (i + items.length) % items.length;
      items.forEach(function (li, k) { li.classList.toggle("on", k === at); });
      if (focus) items[at].focus();
    }
    // Fixed position under the button, so a card with overflow:hidden (booking page header) cannot cut the menu off.
    function place() {
      var r = btn.getBoundingClientRect();
      menu.style.top = Math.round(r.bottom + 8) + "px";
      menu.style.right = Math.max(8, Math.round(document.documentElement.clientWidth - r.right)) + "px";
      menu.style.maxHeight = Math.max(160, window.innerHeight - r.bottom - 20) + "px";
    }
    window.addEventListener("resize", function () { if (!menu.hidden) place(); });
    window.addEventListener("scroll", function () { if (!menu.hidden) place(); }, true);
    function open() {
      place();
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      mark(Math.max(0, sel.selectedIndex), true);
    }
    function close(back) {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      if (back) btn.focus();
    }
    function pick(v) {
      close();
      if (v === sel.value) return;
      sel.value = v;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    btn.addEventListener("click", function () { if (menu.hidden) open(); else close(); });
    btn.addEventListener("keydown", function (e) { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); } });
    menu.addEventListener("click", function (e) { var li = e.target.closest("li"); if (li) pick(li.dataset.v); });
    menu.addEventListener("mousemove", function (e) { var li = e.target.closest("li"); if (li) mark(items.indexOf(li), false); });
    menu.addEventListener("keydown", function (e) {
      var k = e.key;
      if (k === "ArrowDown") { e.preventDefault(); mark(at + 1, true); }
      else if (k === "ArrowUp") { e.preventDefault(); mark(at - 1, true); }
      else if (k === "Home") { e.preventDefault(); mark(0, true); }
      else if (k === "End") { e.preventDefault(); mark(items.length - 1, true); }
      else if (k === "Enter" || k === " ") { e.preventDefault(); pick(items[at].dataset.v); }
      else if (k === "Escape") { e.preventDefault(); close(true); }
      else if (k === "Tab") close();
    });
    document.addEventListener("click", function (e) { if (!menu.hidden && !wrap.contains(e.target)) close(); });
  }

  function run() {
    var sels = document.querySelectorAll("select[data-langmenu]");
    if (!sels.length) return;
    if (!document.getElementById("lm-css")) {
      var st = document.createElement("style");
      st.id = "lm-css";
      st.textContent = css;
      document.head.appendChild(st);
    }
    [].forEach.call(sels, enhance);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
