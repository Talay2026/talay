// Booking page background with sea animals (design by Lars, 28 Oct 2026).
// The water gets deeper as you scroll, soft light at the top, a depth meter on the right
// and silhouettes that swim past behind the content, left to right only.
// Images: public/img/zee/. Everything is built by ZEE_JS after the page has loaded.

export const ZEE_CSS = `
body.zee{background:#1F4B5A}
body.zee::before,body.zee::after{display:none}
body.zee .wrap{position:relative;z-index:1}
/* Boxes a bit more solid on the moving background, fields and calendar clearly fillable (Jonas, 28 Oct) */
body.zee .center{background:rgba(9,38,47,.66);border-color:rgba(247,243,234,.16)}
body.zee .item{background:rgba(12,44,54,.62);border-color:rgba(247,243,234,.24)}
body.zee .policy{background:rgba(12,44,54,.58);border-color:rgba(247,243,234,.22)}
body.zee .grp,body.zee .act{background:rgba(247,243,234,.1);border-color:rgba(247,243,234,.4)}
body.zee .grp:hover,body.zee .act:hover{background:rgba(247,243,234,.16)}
body.zee .grp.on{background:#DCA44A;border-color:#DCA44A}
body.zee .act.on{background:rgba(247,243,234,.14);border-color:#DCA44A}
body.zee .stepper,body.zee textarea{background:rgba(6,28,35,.55);border-color:rgba(247,243,234,.45)}
body.zee .cal{background:rgba(6,28,35,.82);border-color:rgba(247,243,234,.3)}
.zee .day:enabled{background:rgba(247,243,234,.09)}
body.zee .day:hover:not(:disabled){background:rgba(247,243,234,.22)}
body.zee .day.off{color:rgba(247,243,234,.3);background:repeating-linear-gradient(135deg,transparent 0 5px,rgba(247,243,234,.07) 5px 6px)}
body.zee .day.sel,body.zee .day.sel:hover:not(:disabled){background:#DCA44A;color:#09262F}
body.zee .day.in,body.zee .day.in:hover:not(:disabled){background:rgba(220,164,74,.45);color:#F7F3EA}
body.zee .slots button{background:rgba(6,28,35,.55);border-color:rgba(247,243,234,.45)}
body.zee .slots button.on{background:#DCA44A;border-color:#DCA44A}
.zsky,.zlight,.zwave,.zmeter,.zfish{pointer-events:none}
.zsky{position:fixed;inset:0;z-index:-2;background:linear-gradient(180deg,#3E7486,#326676)}
.zlight{position:fixed;inset:0;z-index:-1;overflow:hidden}
.zrays{position:absolute;inset:0;background:linear-gradient(112deg,rgba(255,255,255,0) 0%,rgba(255,255,255,0) 18%,rgba(255,255,255,.07) 22%,rgba(255,255,255,0) 30%,rgba(255,255,255,0) 44%,rgba(255,255,255,.06) 49%,rgba(255,255,255,0) 57%,rgba(255,255,255,0) 70%,rgba(255,255,255,.05) 74%,rgba(255,255,255,0) 82%);animation:zRays 9s ease-in-out infinite}
.zcaus{position:absolute;left:-60px;right:-60px;top:-40px;height:420px;-webkit-mask-image:linear-gradient(180deg,#000 0%,#000 35%,transparent 100%);mask-image:linear-gradient(180deg,#000 0%,#000 35%,transparent 100%)}
.zcaus i{position:absolute;inset:0}
.zca{background-image:radial-gradient(ellipse 46px 22px at 30% 40%,rgba(230,250,248,.55),transparent 70%),radial-gradient(ellipse 60px 26px at 70% 22%,rgba(230,250,248,.45),transparent 70%),radial-gradient(ellipse 38px 18px at 55% 70%,rgba(230,250,248,.5),transparent 70%),radial-gradient(ellipse 52px 20px at 12% 78%,rgba(230,250,248,.4),transparent 70%),radial-gradient(ellipse 44px 24px at 88% 62%,rgba(230,250,248,.45),transparent 70%);background-size:180px 140px;animation:zCausA 14s ease-in-out infinite}
.zcb{background-image:radial-gradient(ellipse 40px 16px at 20% 25%,rgba(212,166,90,.35),transparent 70%),radial-gradient(ellipse 56px 22px at 62% 55%,rgba(230,250,248,.35),transparent 70%),radial-gradient(ellipse 34px 14px at 84% 18%,rgba(230,250,248,.4),transparent 70%);background-size:150px 120px;animation:zCausB 19s ease-in-out infinite}
.zwave{position:fixed;left:0;right:0;top:0;height:18px;z-index:-1;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='390' height='18'%3E%3Cpath d='M0 9 C30 3 60 15 97 9 C134 3 160 15 195 9 C230 3 260 15 292 9 C325 3 355 15 390 9' fill='none' stroke='rgba(235,248,248,.55)' stroke-width='1.5'/%3E%3C/svg%3E") repeat-x}
.zmeter{position:fixed;right:10px;top:120px;bottom:120px;width:26px;z-index:2;display:flex;flex-direction:column;align-items:center}
.zmeter .zm{position:relative;flex:1 1 auto;width:26px}
.zmeter .zm i{position:absolute;left:12px;top:0;width:2px;border-radius:1px}
.zmeter .zm .zt{bottom:0;background:rgba(243,238,228,.16)}
.zmeter .zm .zf{background:#D4A65A}
.zmeter .zm .zk{left:8px;width:10px;height:1px;background:rgba(243,238,228,.35)}
.zmeter .zm .zd{left:7px;width:12px;height:12px;margin-top:-6px;border-radius:50%;background:#D4A65A;box-shadow:0 0 0 4px rgba(212,166,90,.22)}
.zmeter b{margin-top:8px;font-size:11px;font-weight:600;color:#E9C98F;white-space:nowrap}
.zfish{position:absolute;inset:0;z-index:0;overflow:hidden;opacity:.3}
.zfish .zl{position:absolute;left:0;width:100%;height:0;transform:translateX(-100%)}
.zfish .zi{position:absolute;left:0;top:0}
.zfish .zi img{display:block;width:100%;height:auto;left:0;top:0}
.zfish .zg{position:absolute}
.zfish .zg>span,.zfish .zg>span>span{display:block;width:100%;height:100%}
.zfish .zg>span>span{background-repeat:no-repeat}
.zcoral{position:absolute;bottom:0;height:auto;transform-origin:50% 100%;animation:zSway 6.5s ease-in-out infinite alternate}
@keyframes zRays{0%,100%{opacity:.75}50%{opacity:1}}
@keyframes zCausA{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-30px,18px) scale(1.06)}}
@keyframes zCausB{0%,100%{transform:translate(0,0) scale(1.04)}50%{transform:translate(26px,-14px) scale(1)}}
@keyframes zSwing{from{transform:rotate(var(--a))}to{transform:rotate(var(--b))}}
@keyframes zPulse{0%{transform:scale(1,1)}14%{transform:scale(.84,1.1)}32%{transform:scale(1.04,.97)}46%,100%{transform:scale(1,1)}}
@keyframes zTent{0%,20%{transform:skewX(-4deg) scaleY(1)}45%{transform:skewX(5deg) scaleY(1.05)}100%{transform:skewX(-4deg) scaleY(1)}}
@keyframes zSway{from{transform:skewX(-1.6deg)}to{transform:skewX(1.6deg)}}
@keyframes zRay{0%,100%{transform:scaleY(1) skewX(0deg)}25%{transform:scaleY(.9) skewX(-5deg)}50%{transform:scaleY(1.04) skewX(0deg)}75%{transform:scaleY(.93) skewX(4deg)}}
@keyframes zDrift{from{transform:translateX(0)}to{transform:translateX(var(--dx))}}
@keyframes zWig{from{transform:skewY(-2deg)}to{transform:skewY(2deg)}}
.z-tail-fast{--a:-11deg;--b:11deg;animation:zSwing .7s ease-in-out infinite alternate}
.z-rear-fast{--a:-3deg;--b:3deg;animation:zSwing .7s ease-in-out infinite alternate}
.z-tail-slow{--a:-8deg;--b:8deg;animation:zSwing 1.9s ease-in-out infinite alternate}
.z-rear-slow{--a:-2.5deg;--b:2.5deg;animation:zSwing 1.9s ease-in-out infinite alternate}
.z-pec{--a:-5deg;--b:9deg;animation:zSwing 2.6s ease-in-out infinite alternate}
.z-fishtail{--a:-18deg;--b:18deg;animation:zSwing .28s ease-in-out infinite alternate}
.z-wingL{--a:-16deg;--b:12deg;animation:zSwing 2.2s ease-in-out infinite alternate}
.z-wingR{--a:16deg;--b:-12deg;animation:zSwing 2.2s ease-in-out infinite alternate}
.z-finTop{--a:-12deg;--b:22deg;animation:zSwing 2.2s ease-in-out infinite alternate}
.z-finFront{--a:-20deg;--b:12deg;animation:zSwing 2.2s ease-in-out infinite alternate}
.z-finRear{--a:-9deg;--b:7deg;animation:zSwing 2.2s ease-in-out infinite alternate}
.z-head{--a:-4deg;--b:4deg;animation:zSwing 2.2s ease-in-out infinite alternate}
.z-bell{animation:zPulse 3.4s ease-in-out infinite}
.z-tent{animation:zTent 3.4s ease-in-out infinite}
.z-ray{transform-origin:45% 50%;animation:zRay 2.4s ease-in-out infinite}
.z-drift{animation:zDrift ease-in-out infinite alternate}
.z-wig{transform-origin:70% 50%;animation:zWig ease-in-out infinite alternate}
@media (max-width:560px){.zmeter{display:none}} /* too present on a phone (Jonas, 28 Oct); stays on wider screens next to the content */
@media (prefers-reduced-motion:reduce){.zrays,.zca,.zcb,.zcoral,.zfish *{animation:none!important}.zfish .zl{display:none}}
`;

// Lanes from Lars's prototype: [cycle s, start delay s, swimmers]. A swimmer is
// [animal, top % of the page, crossing starts at %, crossing ends at % of the cycle].
// Within a lane only one animal crosses at a time; the lanes have different lengths
// so they never line up the same way twice.
const LANES = [
  [126.9, -108, [["f1", 25.1, 0, 7.959], ["school_top", 13.1, 9.929, 21.277], ["f2", 5.6, 23.01, 32.467], ["tangpair", 16.8, 34.594, 45.942],
    ["f1", 16.4, 47.675, 55.634], ["angelfish", 23.9, 57.289, 69.976], ["school_top", 19.1, 72.183, 84.476], ["tang", 16.7, 86.525, 98.582]]],
  [117.1, -11, [["f2", 21.2, 0, 9.991], ["angelfish", 25.5, 12.041, 24.936], ["f1", 28.4, 26.729, 37.66], ["school_top", 13.6, 40.051, 52.775],
    ["tangpair", 18.8, 55.252, 67.72], ["f2", 23.2, 69.513, 80.273], ["angelfish", 9.3, 82.494, 97.694]]],
  [123, -117.5, [["jelly", 54.6, 0, 27.154], ["school_top", 37.1, 29.35, 40.894], ["school_big", 61.1, 42.846, 56.748], ["tang", 51.6, 58.211, 71.057],
    ["angelfish", 38.2, 73.496, 87.073], ["f2", 39.3, 88.455, 97.805]]],
  [110.3, -81, [["turtle", 62.7, 0, 20.218], ["f2", 60.5, 22.665, 32.185], ["school_top", 60, 34.723, 47.688], ["tangpair", 45.8, 49.955, 62.919],
    ["school_big", 55.6, 64.733, 79.238], ["angelfish", 50, 81.868, 98.096]]],
  [131.4, -34.2, [["reef", 83.7, 0, 11.339], ["barracuda", 91.8, 13.546, 25.495], ["ray", 77.2, 27.702, 41.248], ["manta", 77.7, 43.455, 59.589],
    ["barracuda", 73.6, 61.568, 73.668], ["wshark", 73.4, 75.723, 97.869]]],
];

// Animals cut into parts: [width px, rotation to swim level, class on the whole animal, parts].
// A part is [image, class, pivot x %, pivot y %, z, extra delay s]; the first part
// with z 1 and no position is the body that gives the animal its height.
const RIGS = {
  f1: [34, 0, "", [["single1_body", "", 50, 50, 1, 0, 1], ["single1_tail", "z-fishtail", 29, 50, 2]]],
  f2: [30, 0, "", [["single2_body", "", 50, 50, 1, 0, 1], ["single2_tail", "z-fishtail", 29, 50, 2]]],
  jelly: [56, 0, "", [["jelly_body", "z-tent", 66, 24, 1, 0, 1], ["jelly_bell", "z-bell", 70, 10, 2]]],
  turtle: [90, 18, "", [["turtle_finTop", "z-finTop", 62, 22, 0], ["turtle_finRear1", "z-finRear", 28, 64, 0, 1.1], ["turtle_finRear2", "z-finRear", 40, 79, 0],
    ["turtle_body", "", 50, 50, 1, 0, 1], ["turtle_head", "z-head", 79, 26, 2], ["turtle_finFront", "z-finFront", 76, 40, 2, 2.2]]],
  ray: [150, 7, "z-ray", [["stingray", "", 50, 50, 1, 0, 1]]],
  reef: [156, 8, "", [["reefshark_body", "", 50, 50, 1, 0, 1], ["reefshark_rear", "z-rear-fast", 48, 46, 1], ["reefshark_tail", "z-tail-fast", 24, 52, 1, 0.18],
    ["reefshark_pec", "z-pec", 70, 64, 2]]],
  manta: [176, -4, "", [["manta_wingL", "z-wingL", 22, 46, 0], ["manta_body", "", 50, 50, 1, 0, 1], ["manta_wingR", "z-wingR", 72, 48, 2]]],
  wshark: [240, 10, "", [["wshark_body", "", 50, 50, 1, 0, 1], ["wshark_rear", "z-rear-slow", 52, 45, 1], ["wshark_tail", "z-tail-slow", 27, 58, 1, 0.45],
    ["wshark_pec", "z-pec", 62, 60, 2]]],
};

// Schools and small groups: one sprite per group, every fish drawn on its own so it can
// drift and wag separately. [sprite width, height, fish], fish =
// [left, top, width, height, rotation, drift px, drift s, drift delay, wag s, wag delay].
const GROUPS = {"school_top":[130,60.6,[[77.5,-0.3,22.8,10.4,-13.4,8,3.51,-1.42,0.33,-0.41],[59.9,2.6,36.8,19.2,-19.2,5,2.46,-0.21,0.44,-0.02],[32.6,8.5,23.8,10.4,-12,10,2.55,-0.87,0.45,-0.03],[6.8,9.4,23.8,10.4,-12.7,12,2.02,-0.8,0.46,-0.47],[106.5,10.1,24.1,9.4,-5.9,12,2.85,-0.18,0.37,-0.28],[50.5,16.9,31.6,16,-16.8,6,2.32,-0.52,0.35,-0.15],[5.9,21.8,18.9,9.4,-15.9,6,1.99,-2.06,0.36,-0.05],[29.3,22.2,35.5,18.9,-20.9,5,2.82,-2.23,0.43,-0.27],[91.2,24.1,18.9,9.1,-15.5,8,2.64,-3.32,0.4,-0.12],[21.8,35.2,23.8,12.7,-19.9,6,3.06,-0.88,0.45,-0.26],[54.7,44.3,24.8,13.4,-20.2,8,3.11,-1.04,0.55,-0.06],[0,45.9,28.7,15,4.7,10,2.1,-1.23,0.53,-0.21]]],"tangpair":[58,55.7,[[17.9,-0.4,40.4,23.7,0,5,3.18,-2.06,0.52,-0.16],[-0.8,36.6,32.8,19.5,0,8,2.87,-2.09,0.42,-0.42],[32.8,45.8,14.5,9.2,0,8,2.65,-2.39,0.33,-0.35]]],"angelfish":[68,57.3,[[20.4,-0.3,33.1,33.5,0,12,3.59,-2.96,0.39,-0.19],[-0.3,20.7,29.7,34.5,0,8,1.84,-1.66,0.36,-0.06],[39.4,28,29,29.7,0,5,2.19,-1.03,0.49,-0.2]]],"tang":[96,44.5,[[61.2,-0.3,35.1,24,0,10,1.95,-1.62,0.45,-0.44],[16.3,12.9,29.2,19.5,0,10,3.36,-1,0.42,-0.18],[45.6,22.3,25.4,17.7,0,10,3.52,-0.54,0.36,-0.12],[-0.3,31.7,18.8,12.5,0,6,1.82,-2.99,0.36,-0.14],[30.3,33.7,17.4,11.1,0,6,2.55,-1.33,0.45,-0.48]]],"school_big":[160,62.1,[[131.7,-0.3,16.3,7.5,10.2,12,3.51,-2.36,0.49,-0.23],[145,3.6,15.3,8.8,19.3,12,2.51,-1.44,0.34,-0.32],[82.9,8.8,60.8,22.8,20.3,5,2.14,-3.54,0.42,-0.05],[117.7,11.7,36.1,21.5,30.9,12,1.89,0,0.35,-0.05],[146.7,15,12,10.4,39.4,8,2.9,-0.25,0.37,-0.19],[102.1,15.6,15.6,6.2,1.7,8,3.52,-2.17,0.43,-0.06],[81,17.6,17.2,6.8,-1.5,10,3.59,-1.68,0.43,-0.04],[15.6,21.8,20.2,9.8,-10.2,5,3.15,-2.67,0.43,-0.35],[128.1,24.4,15.6,13.3,36.4,12,1.84,-3.42,0.44,-0.07],[60.2,24.7,58.2,24.1,-9.4,12,3.45,-2.73,0.39,-0.32],[137.6,27.3,11.1,10.7,40,5,3.05,-0.94,0.4,-0.08],[-0.3,27.6,19.5,8.5,-10.3,6,2.76,-2.8,0.4,-0.11],[32.2,30.9,42.3,10.7,-7.8,6,3.25,-2.95,0.49,-0.11],[108.9,33.8,17.9,12.7,29.1,12,2.69,-2.63,0.55,-0.4],[124.2,35.8,12.4,10.7,39.6,10,2.27,-2.49,0.54,-0.22],[33.8,37.1,24.4,9.1,-2.6,8,3.52,-1.31,0.37,-0.11],[11.1,38.7,21.1,10.1,-11.8,6,2.41,-1.74,0.55,-0.31],[133,39.7,13,12,40,5,2.66,-2.35,0.5,-0.04],[109.9,43.6,12,8.1,28.2,5,3.44,-2.82,0.49,-0.24],[62.8,43.9,14,5.2,-0.6,6,2.58,-2.29,0.34,-0.47],[71.5,46.2,38.4,15.6,20.1,10,2.63,-2.68,0.34,-0.08],[48.8,47.8,16.6,6.2,-3.1,6,1.85,-2.13,0.43,-0.33],[110.6,48.1,13.3,11.4,38.7,12,3.29,-3.53,0.47,-0.18],[93.3,53.3,14.6,9.4,27.1,12,2.79,-0.08,0.5,-0.36]]],"barracuda":[140,50.6,[[-0.7,-0.4,114.5,38.8,16.2,5,2.75,-3.36,0.42,-0.44],[8.3,14,132.1,37.3,12.2,6,1.85,-0.77,0.44,-0.38]]]};
const WAG = { tang: 1, angelfish: 1, tangpair: 1 };

export const ZEE_JS = String.raw`
(function () {
  var d = document, b = d.body, P = "/img/zee/";
  var LANES = ${JSON.stringify(LANES)}, RIGS = ${JSON.stringify(RIGS)}, GROUPS = ${JSON.stringify(GROUPS)}, WAG = ${JSON.stringify(WAG)};
  var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function el(cls, html) { var e = d.createElement("div"); e.className = cls; e.setAttribute("aria-hidden", "true"); if (html) e.innerHTML = html; return e; }

  // Fixed layers: water colour, light at the top, wave line and depth meter.
  var sky = el("zsky"), light = el("zlight", '<div class="zrays"></div><div class="zcaus"><i class="zca"></i><i class="zcb"></i></div>');
  var wave = el("zwave"), MAX = 30, ticks = "";
  [5, 10, Math.round(MAX * 0.75), MAX].forEach(function (m) { ticks += '<i class="zk" style="top:' + (m / MAX * 100).toFixed(1) + '%"></i>'; });
  var meter = el("zmeter", '<div class="zm"><i class="zt"></i><i class="zf"></i>' + ticks + '<i class="zd"></i></div><b>0 m</b>');
  b.insertBefore(meter, b.firstChild); b.insertBefore(wave, b.firstChild); b.insertBefore(light, b.firstChild); b.insertBefore(sky, b.firstChild);
  var rays = light.firstChild, caus = light.lastChild, fill = meter.querySelector(".zf"), dot = meter.querySelector(".zd"), label = meter.querySelector("b");

  var STOPS = [[[0x3E, 0x74, 0x86], 0], [[0x32, 0x66, 0x76], 0.45], [[0x28, 0x5A, 0x6A], 0.8], [[0x1F, 0x4B, 0x5A], 1]];
  function colorAt(t) {
    for (var i = 0; i < STOPS.length - 1; i++) {
      var a = STOPS[i], c = STOPS[i + 1];
      if (t <= c[1]) { var u = (t - a[1]) / (c[1] - a[1]); return "rgb(" + a[0].map(function (v, j) { return Math.round(v + (c[0][j] - v) * u); }).join(",") + ")"; }
    }
    return "rgb(31,75,90)";
  }
  function clamp(v) { return Math.max(0, Math.min(1, v)); }
  var busy = false;
  function paint() {
    busy = false;
    var max = d.documentElement.scrollHeight - innerHeight, f = max > 0 ? clamp(scrollY / max) : 0;
    sky.style.background = "linear-gradient(180deg," + colorAt(f * 0.7) + " 0%," + colorAt(Math.min(1, f * 0.7 + 0.3)) + " 100%)";
    rays.style.opacity = clamp((1 - f * 0.9) * 0.9).toFixed(2);
    caus.style.opacity = clamp((1 - f * 1.4) * 0.22).toFixed(2);
    wave.style.opacity = clamp(1 - f * 3).toFixed(2);
    var pct = (f * 100).toFixed(1) + "%";
    fill.style.height = pct; dot.style.top = pct; label.textContent = Math.round(f * MAX) + " m";
  }
  function ask() { if (!busy) { busy = true; requestAnimationFrame(paint); } }
  addEventListener("scroll", ask, { passive: true });
  addEventListener("resize", ask);
  if (window.ResizeObserver) new ResizeObserver(ask).observe(b);
  paint();

  // The animals: added once the page itself has loaded, so they never slow down booking.
  function rig(k, phase) {
    var r = RIGS[k], h = '<div style="transform:rotate(' + r[1] + 'deg)"><div class="' + r[2] + '" style="position:relative;width:' + r[0] + 'px;animation-delay:' + phase.toFixed(2) + 's">';
    r[3].forEach(function (p) {
      h += '<img src="' + P + p[0] + '.png" alt="" decoding="async" class="' + p[1] + '" style="position:' + (p[6] ? "relative" : "absolute") + ';z-index:' + p[4] +
        ';transform-origin:' + p[2] + '% ' + p[3] + '%;animation-delay:' + (phase + (p[5] || 0)).toFixed(2) + 's">';
    });
    return h + "</div></div>";
  }
  function group(k) {
    var g = GROUPS[k], h = '<div style="position:relative;width:' + g[0] + 'px;height:' + g[1] + 'px">';
    g[2].forEach(function (f) {
      h += '<span class="zg z-drift" style="left:' + f[0] + 'px;top:' + f[1] + 'px;width:' + f[2] + 'px;height:' + f[3] + 'px;--dx:' + f[5] + 'px;animation-duration:' + f[6] + 's;animation-delay:' + f[7] + 's">' +
        '<span style="transform:rotate(' + f[4] + 'deg)"><span class="' + (WAG[k] ? "z-wig" : "") + '" style="background-image:url(' + P + k + '.png);background-size:' + g[0] + 'px auto;background-position:' +
        (-f[0]) + 'px ' + (-f[1]) + 'px;animation-duration:' + f[8] + 's;animation-delay:' + f[9] + 's"></span></span></span>';
    });
    return h + "</div>";
  }
  function swim() {
    var layer = el("zfish"), n = 0;
    // Crossing times are Lars's, measured on a phone; on wider screens everything slows
    // down with the width so the animals keep the same calm speed.
    var k = Math.max(1, Math.min(3, (b.clientWidth || 390) / 420)) * 1000;
    LANES.forEach(function (lane) {
      lane[2].forEach(function (s) {
        var phase = -((n++ * 0.73) % 2.5);
        var outer = d.createElement("div"), inner = d.createElement("div");
        outer.className = "zl"; outer.style.top = s[1] + "%"; inner.className = "zi";
        inner.innerHTML = GROUPS[s[0]] ? group(s[0]) : rig(s[0], phase);
        outer.appendChild(inner); layer.appendChild(outer);
        if (still || !outer.animate) return;
        // The outer box moves one page width, the animal inside moves its own width
        // (plus a little room for the tilted ones): together it starts just out of view
        // on the left and ends just out of view on the right.
        var a = s[2] / 100, z = s[3] / 100, o = [], i = [];
        function at(t, x, ease) { o.push({ offset: t, transform: "translateX(" + x * 100 + "%)", easing: ease || "linear" }); i.push({ offset: t, transform: "translateX(calc(" + (x - 1) * 100 + "% - " + (1 - x) * 30 + "px))", easing: ease || "linear" }); }
        at(0, 0);
        if (s[0] === "f1" && a === 0) {
          // The one little fish that sprints once per crossing and then glides on.
          at(0.03582, 0.4009, "cubic-bezier(.1,.85,.3,1)"); at(0.04139, 0.6013);
        } else if (a > 0) at(a, 0);
        at(z, 1); at(1, 1);
        var t = { duration: lane[0] * k, delay: lane[1] * k, iterations: Infinity };
        outer.animate(o, t); inner.animate(i, t);
      });
    });
    layer.insertAdjacentHTML("beforeend", '<img class="zcoral" src="' + P + 'coralL.png" alt="" style="left:-12px;width:150px"><img class="zcoral" src="' + P + 'coralR.png" alt="" style="right:-14px;width:210px;animation-delay:-3s">');
    b.insertBefore(layer, b.firstChild);
  }
  if (d.readyState === "complete") swim(); else addEventListener("load", swim);
})();
`;
