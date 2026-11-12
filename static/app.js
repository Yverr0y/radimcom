"use strict";

const $ = (id) => document.getElementById(id);

// ---------- page scale (responsive layout) ----------
// The page is drawn in a "virtual window" of at least STAGE_W × STAGE_H px and is scaled as a whole
// to the browser window (CSS .stage). Browser zoom changes innerWidth/innerHeight, so it is
// cancelled out: the content depends only on the window size. With a different aspect ratio the virtual
// window gets longer (wider / taller) and the layout stretches.
const STAGE_W = 1920, STAGE_H = 820;
let uiScale = 1;
// Lower part hidden (VIEW key): the stage is only as high as the head + the bottom strip with the screws
// (26 px) + the .rig padding (2 × 6 px), so the window can be made as low as the head and then it scales down
// as a whole (same aspect ratio), like the full panel does under STAGE_H.
const BODY_STRIP_H = 26 + 12;
const keysWrap = () => {   // the key row overflowed into a second line
  const g = document.querySelectorAll(".r-keys > .kgroup");
  return g.length > 1 && g[g.length - 1].offsetTop !== g[0].offsetTop;
};
// Stage width the key row needs on one line. The system font differs (SF Pro on macOS is wider than Segoe UI
// on Windows), so it is measured: the sum of the groups, their gaps and the margins of the row.
const keysNeedW = (vw) => {
  const keys = document.querySelector(".r-keys"), cs = getComputedStyle(keys);
  const g = [...keys.querySelectorAll(":scope > .kgroup")];
  const row = g.reduce((s, e) => s + e.getBoundingClientRect().width / uiScale, 0)
    + (parseFloat(cs.columnGap) || 0) * (g.length - 1) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  return Math.ceil(vw - keys.clientWidth + row) + 12;   // a little reserve for rounding of another font
};
function fitStage() {
  const w = window.innerWidth, h = window.innerHeight, root = document.documentElement;
  const head = document.getElementById("radioHead");
  const headOnly = root.classList.contains("body-off") && head;
  let baseW = STAGE_W;   // design width of the panel; wider if the keys do not fit on one line in it
  const apply = (k) => {
    uiScale = k || 1;
    // hidden lower part: the panel keeps its width (baseW), a low window shrinks it whole and centres it;
    // the full panel stretches over the whole window width as before
    const vw = headOnly ? baseW : w / uiScale;
    root.style.setProperty("--stage-x", headOnly ? `${Math.max(0, (w - vw * uiScale) / 2)}px` : "0px");
    root.style.setProperty("--k", uiScale);
    root.style.setProperty("--vw", `${vw}px`);
    root.style.setProperty("--vh", `${h / uiScale}px`);
    // compact keys in a narrow stage, and also in a wider one where the full-size keys do not fit on one line
    root.classList.remove("compact");
    if (vw <= 2100 || keysWrap()) root.classList.add("compact");
  };
  // the keys wrap even compact (a wider system font): the stage gets as wide as they need, so the whole
  // panel is drawn a little smaller instead of a second row of keys
  const widen = () => {
    if (!head || !keysWrap()) return false;
    baseW = Math.max(baseW, keysNeedW(parseFloat(root.style.getPropertyValue("--vw"))));
    return true;
  };
  if (!headOnly) {
    const k = Math.min(w / STAGE_W, h / STAGE_H);
    apply(k);
    if (widen()) apply(Math.min(k, w / baseW));
    return;
  }
  // the head height depends on the stage width (compact keys): fit, measure again, fit once more
  let stageH = 0;
  for (let i = 0; i < 4; i++) {
    const hh = head.offsetHeight + BODY_STRIP_H;
    if (hh === stageH && !widen()) break;
    stageH = hh;
    apply(Math.min(w / baseW, h / stageH));
  }
}
fitStage();
window.addEventListener("resize", fitStage);   // before the other resize handlers (redraw)

const BANDWIDTHS = {
  AM: [4000, 6000, 8000, 10000],
  FM: [500, 3000, 6000, 12000, 25000, 50000],
  WFM: [50000, 75000, 150000, 200000],
  LSB: [1800, 2400, 2700, 3000],
  USB: [1800, 2400, 2700, 3000],
  CW: [300, 500, 800, 1200],
  DSD: [12500],      // fixed channel width of the digital voice decoder
};
// STEP keys: the same four steps in every mode; WFM remembers its own chosen step, the other modes share one
const STEPS = [10, 100, 1000, 10000];
// MODE keys: the demodulator modes and DAB (not a demodulator: DAB on with the DAB tab; lit while DAB runs)
const MODE_KEYS = ["AM", "FM", "WFM", "LSB", "USB", "CW", "DAB", "DSD"];
const stepSet = (mode) => (mode === "WFM" ? "wfm" : "narrow");
const STEP_SETS = { narrow: STEPS, wfm: STEPS };
const STEP_KEYS = { narrow: "step", wfm: "stepWfm" };   // browser storage
const stepMem = { narrow: 1000, wfm: 1000 };
let mems = [];   // memories (list in the panel and tags in the spectrum)
// Band button groups: [title, [[label, frequency Hz, mode], …]].
// HF goes through the upconverter, VHF/UHF (above 30 MHz) straight into the dongle.
const BAND_GROUPS = [
  ["HF HAM", [
    ["160 m", 1840000, "LSB"], ["80 m", 3650000, "LSB"], ["60 m", 5357000, "USB"], ["40 m", 7100000, "LSB"],
    ["30 m", 10130000, "USB"], ["20 m", 14200000, "USB"], ["17 m", 18130000, "USB"], ["15 m", 21250000, "USB"],
    ["12 m", 24940000, "USB"], ["10 m", 28500000, "USB"]]],
  ["HF BROADCAST", [
    ["MW", 1000000, "AM"], ["75 m", 3950000, "AM"], ["49 m", 6000000, "AM"], ["41 m", 7300000, "AM"],
    ["31 m", 9600000, "AM"], ["25 m", 11800000, "AM"], ["22 m", 13700000, "AM"], ["19 m", 15300000, "AM"],
    ["16 m", 17700000, "AM"], ["13 m", 21600000, "AM"]]],
  ["VHF / UHF HAM", [
    ["6 m", 50150000, "USB"], ["4 m", 70200000, "USB"], ["2 m SSB", 144300000, "USB"], ["2 m FM", 145500000, "FM"],
    ["2 m RPT", 145600000, "FM"], ["APRS", 144800000, "FM"], ["70 cm SSB", 432200000, "USB"], ["70 cm FM", 433500000, "FM"],
    ["70 cm RPT", 439000000, "FM"], ["23 cm", 1296200000, "USB"]]],
  ["OTHER", [
    ["FM BCAST", 0, "WFM"], ["CB", 27185000, "FM"], ["Airband", 127500000, "AM"], ["Marine ch16", 156800000, "FM"], ["PMR446", 446006250, "FM"]]],
];

let st = null; // last state from the server
let view = null; // {c, span} of the waterfall section shown right now
let pendingSet = {};
let setTimer = null;
let localChangeAt = 0;
let stepHz = 1000;
let vbase = ""; // receiver address of the active VFO ("" = server of this page, mode without VFOs)
let vfos = []; // [{name, port, serial, note, base, st, rows, online}]
let active = null; // active VFO

// "?map=packet|hfdl|ais|adsb|acars&vfo=A": this tab shows only that map (opened by the □ key of the map) – no audio,
// no spectrum, and it saves nothing to the browser, so the settings of the main window stay as they are
const MAP_ONLY = (() => {
  const m = new URLSearchParams(location.search).get("map");
  return ["packet", "hfdl", "ais", "adsb", "acars"].includes(m) ? m : null;
})();

function store(key, value) { if (MAP_ONLY) return; try { localStorage.setItem(key, value); } catch (e) { /* no storage */ } }
function recall(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

// ---------- helpers ----------

const LOCALE = "en-US";

function fmtKHz(hz, decimals = 2) {
  return (hz / 1000).toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false });
}

function fmtMHz(hz, decimals = 3) {
  return (hz / 1e6).toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false });
}

function fmtBw(hz) {
  return hz >= 1000 ? `${(hz / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} kHz` : `${hz} Hz`;
}

/** "7100" -> kHz, "7.1" -> MHz (numbers below 100 are taken as MHz), "145.5" or "433.5" -> MHz
 *  (decimal number up to 2000), "7.1M", "7100k", "7100000Hz". */
function parseFreq(text) {
  const t = text.trim().toLowerCase().replace(/\s/g, "").replace(",", ".");
  const m = t.match(/^([0-9]*\.?[0-9]+)(hz|khz|k|mhz|m)?$/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = m[2] || (v < 100 || (m[1].includes(".") && v < 2000) ? "m" : v < 100000 ? "k" : "hz");
  return unit.startsWith("m") ? v * 1e6 : unit.startsWith("k") ? v * 1e3 : v;
}

function send(changes) {
  localChangeAt = Date.now();
  Object.assign(pendingSet, changes);
  clearTimeout(setTimer);
  setTimer = setTimeout(flushSend, 40);
}

/** Sends the pending changes to the receiver of the active VFO (the address is taken now, before a VFO switch). */
async function flushSend() {
  clearTimeout(setTimer);
  setTimer = null;
  const body = pendingSet;
  pendingSet = {};
  if (!Object.keys(body).length) return;
  const res = await fetch(vbase + "/api/set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) adError((await res.json().catch(() => ({}))).error || "Error");
}

/** Status field under the clock: only a standalone receiver without VFOs shows its state here (with VFOs the state
 *  is in the VFO windows). Error messages go to the additional display (adError). */
function renderStatusPill() {
  const pill = $("status");
  let txt = null, cls = "bad";
  if (active && !active.name) {
    const s = st;
    txt = !active.online && s ? "connection to server lost…" : !s ? "waiting for receiver…"
      : s.error ? `error: ${s.error}` : `receiver ${s.status}`;
    cls = s && !s.error && s.status === "running" ? "ok" : s && !s.error ? "" : "bad";
  }
  pill.hidden = !txt;
  if (!txt) return;
  $("statusText").textContent = txt;
  pill.querySelector(".dot").className = "dot " + cls;
}

function passband() {
  const f = st.tune_hz, bw = st.bandwidth[st.mode] || 3000;
  if (st.mode === "USB") return [f + 300, f + bw];
  if (st.mode === "LSB") return [f - bw, f - 300];
  return [f - bw / 2, f + bw / 2];
}

function segButtons(el, items, active, label, disabled = false) {
  // Redraw only on a change: replacing the button under the mouse causes flicker and lost clicks.
  const html = items.map((v) => `<button data-v="${v}" class="${String(v) === String(active) ? "active" : ""}"${disabled ? " disabled" : ""}>${label(v)}</button>`).join("");
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}

// ---------- ladenie ----------

function tune(hz, snap = false) {
  if (!st) return;
  if (snap) hz = Math.round(hz / stepHz) * stepHz;
  hz = Math.max(0, Math.round(hz));
  st.tune_hz = hz;
  renderTuner();
  drawOverlays();
  send({ tune_hz: hz });
}

// ATU (autotune.py): a click tunes to the point without the step grid and asks the server to find the carrier;
// the result comes back as a new tune_hz in the state, the passband label shows what it did for a few seconds.
const ATU_MODES = ["AM", "USB", "LSB"];
let atuShownId = null, atuNoteUntil = 0;   // null: the result already there when the page loads is not shown
function autotuneAt(hz) {
  clearTimeout(atuTimer);
  atuTimer = null;
  tune(Math.round(hz / 10) * 10);
  send({ autotune_go: true });
  if (st.autotune_info) st.autotune_info = { ...st.autotune_info, state: "listen", id: -1 };
  renderRds();
}
/** Wheel, arrow keys, dragging or the VFO display digits: autotune once the tuning has rested for ATU_REST_MS.
 *  prevHz = the frequency before this step. A move under ATU_MIN_MOVE_HZ from where the gesture began is fine tuning
 *  by ear and is left alone. */
const ATU_REST_MS = 700, ATU_MIN_MOVE_HZ = 150;
let atuTimer = null, atuFrom = null;
function atuSoon(prevHz) {
  if (atuTimer === null) atuFrom = prevHz;   // a new gesture
  clearTimeout(atuTimer);
  atuTimer = null;
  if (!st || !st.autotune || !ATU_MODES.includes(st.mode)) return;
  atuTimer = setTimeout(() => {
    atuTimer = null;
    if (!st || !st.autotune || !ATU_MODES.includes(st.mode) || drag) return;
    if (Math.abs(st.tune_hz - atuFrom) < ATU_MIN_MOVE_HZ) return;
    send({ tune_hz: st.tune_hz, autotune_go: true });
    if (st.autotune_info) st.autotune_info = { ...st.autotune_info, state: "listen", id: -1 };
    renderRds();
  }, ATU_REST_MS);
}
/** Text for the passband label: "ATU…" while listening, then the shift (or "no signal") for 4 s. */
function atuNote() {
  const i = st.autotune_info;
  if (!st.autotune || !i || !i.state) return "";
  if (i.state === "listen") return "ATU…";
  if (atuShownId === null) { atuShownId = i.id; return ""; }
  if (i.id !== atuShownId) { atuShownId = i.id; atuNoteUntil = Date.now() + 4000; setTimeout(drawOverlays, 4100); }
  if (Date.now() > atuNoteUntil) return "";
  return i.state === "done" ? `ATU ${i.shift_hz >= 0 ? "+" : ""}${i.shift_hz} Hz` : "ATU: no signal";
}

function renderControls() {
  if (!st) return;
  segButtons($("modes"), MODE_KEYS, st.dab ? "DAB" : st.mode, (m) => m);
  // The buttons stay fixed; a width set by dragging the edge in the spectrum has no button (none is lit).
  const bw = st.bandwidth[st.mode];
  // DAB: the ensemble has a fixed width – the keys stay in place, unlit and disabled
  segButtons($("bandwidths"), BANDWIDTHS[st.mode] || BANDWIDTHS.WFM, st.dab ? null : bw, fmtBw, !!st.dab);
  const set = stepSet(st.mode);
  stepHz = stepMem[set];
  segButtons($("steps"), STEP_SETS[set], stepHz, fmtBw);
  renderZoomBar();
  renderSqlBadge();
  renderRds();
}

// ---------- 7-segment display ----------

const SEG7 = (() => {
  const t = 9;
  const h = (y, x1, x2) => `${x1},${y} ${x1 + t / 2},${y - t / 2} ${x2 - t / 2},${y - t / 2} ${x2},${y} ${x2 - t / 2},${y + t / 2} ${x1 + t / 2},${y + t / 2}`;
  const v = (x, y1, y2) => `${x},${y1} ${x + t / 2},${y1 + t / 2} ${x + t / 2},${y2 - t / 2} ${x},${y2} ${x - t / 2},${y2 - t / 2} ${x - t / 2},${y1 + t / 2}`;
  return {
    a: h(5, 7, 43), b: v(45, 7, 48), c: v(45, 52, 93), d: h(95, 7, 43),
    e: v(5, 52, 93), f: v(5, 7, 48), g: h(50, 7, 43),
  };
})();
const DIGIT_SEGS = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg"];

/** Text like " 7_066.29" -> SVG digits; space = unlit digit, a (decimal) dot belongs
 *  to the previous digit, underscore = small gap between thousands groups, colon for the clock. */
function seg7(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ".") continue;
    if (ch === "_") { out += `<span class="gap"></span>`; continue; }
    if (ch === ":") {
      out += `<svg class="colon" viewBox="0 0 30 100" aria-hidden="true"><circle cx="13" cy="32" r="6" class="on"/>` +
        `<circle cx="9" cy="70" r="6" class="on"/></svg>`;
      continue;
    }
    const lit = ch === " " ? "" : DIGIT_SEGS[Number(ch)];
    const dp = text[i + 1] === ".";
    let s = "";
    for (const k of "abcdefg") s += `<polygon points="${SEG7[k]}"${lit.includes(k) ? ' class="on"' : ""}/>`;
    s += `<circle cx="55" cy="92" r="6"${dp ? ' class="on"' : ""}/>`;
    // xMidYMax: the digit sits at the bottom of its box, so the smaller digits (Hz) share the bottom of the big ones
    out += `<svg viewBox="-4 0 66 100" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><g transform="skewX(-6) translate(8 0)">${s}</g></svg>`;
  }
  return out;
}

/** Like on a transceiver, 1 Hz resolution, the last three digits (Hz) smaller. HF in kHz (the first dot
 *  separates thousands: "   7.016.500" kHz), from 30 MHz in MHz (the first dot is decimal: " 439.475.000" MHz). */
function freqDigits(hz) {
  const n = Math.round(hz);
  const mhz = String(Math.floor(n / 1e6)).padStart(4, " ");
  const rest = String(n % 1e6).padStart(6, "0");
  return { txt: `${mhz}.${rest.slice(0, 3)}.${rest.slice(3)}`, unit: n >= 30e6 ? "MHz" : "kHz" };
}

function renderTuner() {
  if (!st) return;
  renderVfoDisplays();
  renderConv();
  rememberFm();
}

$("modes").addEventListener("click", (e) => {
  const b = e.target.closest("[data-v]");
  if (!b || !st) return;
  if (b.dataset.v === "DAB") {   // DAB: on with its tab (again on DAB: only the tab is shown)
    if (st.dab) setBodyTab("dab"); else dabOn();
    return;
  }
  if (st.dab) dabOff();   // another mode ends DAB (the previous sample rate comes back)
  st.mode = b.dataset.v;
  renderControls();
  drawOverlays();
  send({ mode: st.mode });
});
$("bandwidths").addEventListener("click", (e) => {
  const b = e.target.closest("[data-v]");
  if (!b) return;
  st.bandwidth[st.mode] = Number(b.dataset.v);
  renderControls();
  drawOverlays();
  send({ bandwidth: Number(b.dataset.v) });
});
$("steps").addEventListener("click", (e) => {
  const b = e.target.closest("[data-v]");
  if (!b) return;
  stepHz = Number(b.dataset.v);
  const set = stepSet(st && st.mode);
  stepMem[set] = stepHz;
  store(STEP_KEYS[set], stepHz);
  renderControls();
});
function setZoom(z) {
  st.zoom = z;
  renderControls();
  send({ zoom: z });
}
// Wheel direction of an event, +1 up, -1 down, 0 = no step yet. A mouse wheel notch is one step. A touchpad sends many
// small deltas (also after the fingers are lifted), so they add up and one step is taken per wheelPx of scrolling.
// SET: touchpad wheel speed 1-10 (this browser), one step per 600 / speed px.
const WHEEL_SPEED_DEFAULT = 4;   // 150 px
let wheelPx = 0;
function setWheelSpeed(speed) {
  wheelPx = 600 / speed;
  $("wheelSpeed").value = speed;
  $("wheelSpeedText").textContent = speed;
}
{
  const saved = Number(recall("wheelSpeed"));
  setWheelSpeed(saved >= 1 && saved <= 10 ? saved : WHEEL_SPEED_DEFAULT);
}
$("wheelSpeed").addEventListener("input", (e) => {
  setWheelSpeed(Number(e.target.value));
  store("wheelSpeed", e.target.value);
});
const wheelSum = { target: null, px: 0, at: 0 };
function wheelStep(e) {
  const lines = e.deltaMode !== 0;   // read first: Firefox then keeps its own units for a mouse wheel
  const dy = e.deltaY;
  if (!dy) return 0;
  const notch = e.wheelDeltaY && e.wheelDeltaY % 120 === 0;
  if (lines || notch) { wheelSum.px = 0; return dy < 0 ? 1 : -1; }
  const fresh = wheelSum.target !== e.currentTarget || e.timeStamp - wheelSum.at > 400 || wheelSum.px * dy < 0;
  wheelSum.target = e.currentTarget;
  wheelSum.at = e.timeStamp;
  wheelSum.px = (fresh ? 0 : wheelSum.px) + dy;
  if (Math.abs(wheelSum.px) < wheelPx) return 0;
  const dir = wheelSum.px < 0 ? 1 : -1;
  wheelSum.px %= wheelPx;
  return dir;
}
// Zoom bar in the scale: one cell per zoom value above 1×, lit up to the current one; − / + step, a cell sets it.
function renderZoomBar() {
  const i = st.zooms.indexOf(st.zoom);
  const cells = $("zoomCells");
  if (cells.children.length !== st.zooms.length - 1) {
    cells.innerHTML = st.zooms.slice(1).map((z) => `<i data-z="${z}" title="${z}×"></i>`).join("");
  }
  [...cells.children].forEach((c, k) => c.classList.toggle("on", k < i));
  $("zoomVal").textContent = `${st.zoom}×`;
  const [minus, plus] = $("zoomBar").querySelectorAll(".zb-btn");
  minus.disabled = i <= 0;
  plus.disabled = i >= st.zooms.length - 1;
}
$("zoomBar").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!st) return;
  const cell = e.target.closest("[data-z]");
  if (cell) {
    const z = Number(cell.dataset.z);
    setZoom(z === st.zoom ? st.zooms[st.zooms.indexOf(z) - 1] : z);   // a click on the last lit cell steps back one
    return;
  }
  const b = e.target.closest("[data-d]");
  if (!b) return;
  const z = st.zooms[st.zooms.indexOf(st.zoom) + Number(b.dataset.d)];
  if (z) setZoom(z);
});
$("zoomBar").addEventListener("mousedown", (e) => e.stopPropagation());
$("zoomBar").addEventListener("wheel", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const dir = wheelStep(e);
  if (!st || !dir) return;
  const z = st.zooms[st.zooms.indexOf(st.zoom) + dir];
  if (z) setZoom(z);
}, { passive: false });
document.addEventListener("keydown", (e) => {
  if (!st || e.target.closest("input, select, textarea")) return;
  const prev = st.tune_hz;
  if (e.key === "ArrowLeft") { tune(st.tune_hz - stepHz, true); atuSoon(prev); e.preventDefault(); }
  if (e.key === "ArrowRight") { tune(st.tune_hz + stepHz, true); atuSoon(prev); e.preventDefault(); }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") { memStep(e.key === "ArrowUp" ? 1 : -1); e.preventDefault(); }
});

/** ↑ / ↓: recall the nearest memory above / below the tuned frequency, among those in the visible spectrum (not DAB). */
function memStep(dir) {
  const v = viewNow();
  const f0 = v.c - v.span / 2, f1 = v.c + v.span / 2, hz = st.tune_hz;
  let best = null;
  for (const m of mems) {
    if (m.dab_channel || m.freq_hz < f0 || m.freq_hz > f1) continue;
    const d = (m.freq_hz - hz) * dir;
    if (d < 50) continue;   // the memory we stand on (same tolerance as memAt) or the other direction
    if (!best || d < (best.freq_hz - hz) * dir) best = m;
  }
  if (best) recallMem(best);
}

// A click on the display of the active VFO opens frequency entry, a click on an inactive VFO (display
// or the A/B/C button) switches to it.
// The wheel over a display digit tunes by its place value (digits MHz.kHz.Hz = 10^9 … 1 Hz), also on an inactive
// VFO – that one is retuned without switching.
$("vfoList").addEventListener("wheel", (e) => {
  const digit = e.target.closest(".freq svg");
  const row = e.target.closest(".vfo-row:not(.spare)");
  if (!digit || !row) return;
  e.preventDefault();
  const dir = wheelStep(e);
  if (!dir) return;
  const v = vfos.find((x) => String(x.name) === row.dataset.vfo);
  const s = v === active ? st : v.st;
  if (!s) return;
  const digits = [...digit.parentElement.querySelectorAll("svg")];
  const place = 10 ** (digits.length - 1 - digits.indexOf(digit));
  let hz = s.tune_hz + dir * place;
  // a chained VFO may leave the owner's band (it then shows OOR), so it is not clamped to it
  const [lo, hi] = s.chain_owner ? [0, Infinity] : s.range || [0, Infinity];
  hz = Math.min(hi, Math.max(lo, hz));
  if (hz === s.tune_hz) return;
  if (v === active) { const prev = st.tune_hz; tune(hz); atuSoon(prev); return; }
  v.localTune = hz;
  v.localAt = Date.now();
  v.st.tune_hz = hz;
  renderVfoDisplays();
  clearTimeout(v.tuneTimer);
  v.tuneTimer = setTimeout(() => {
    fetch(v.base + "/api/set", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tune_hz: v.localTune }) });
  }, 60);
}, { passive: false });

// Mouse wheel over the RF / SQL bar of a VFO window: one step of the bar (the same as dragging it).
$("vfoList").addEventListener("wheel", (e) => {
  const inp = e.target.closest(".vfo-row:not(.spare) .vfo-foot")?.querySelector("input[type=range]");
  if (!inp) return;
  e.preventDefault();
  const dir = wheelStep(e);
  if (!dir || inp.disabled) return;
  const v = Math.min(Number(inp.max), Math.max(Number(inp.min), Number(inp.value) + dir));
  if (v === Number(inp.value)) return;
  inp.value = v;
  inp.dispatchEvent(new Event("input", { bubbles: true }));
}, { passive: false });

// RF GAIN slider under the display: sets the gain of that VFO without switching (same as the slider in SET).
$("vfoList").addEventListener("input", (e) => {
  if (!e.target.matches(".vfo-row:not(.spare) .vfo-rf:not(.vfo-sq) input")) return;
  const v = vfos.find((x) => String(x.name) === e.target.closest(".vfo-row").dataset.vfo);
  const s = v === active ? st : v.st;
  if (!s || !s.gains) return;
  const g = s.gains[Number(e.target.value)];
  if (v === active) {
    st.gain = g;
    renderGain();
    renderVfoDisplays();
    send({ gain: g });
    return;
  }
  v.localGain = g;
  v.localGainAt = Date.now();
  v.st.gain = g;
  renderVfoDisplays();
  clearTimeout(v.gainTimer);
  v.gainTimer = setTimeout(() => {
    fetch(v.base + "/api/set", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gain: v.localGain }) });
  }, 60);
});

// SQUELCH slider under RF GAIN: squelch level for the current mode of that VFO (same as the slider in SET).
$("vfoList").addEventListener("input", (e) => {
  if (!e.target.matches(".vfo-row:not(.spare) .vfo-sq input")) return;
  const v = vfos.find((x) => String(x.name) === e.target.closest(".vfo-row").dataset.vfo);
  const s = v === active ? st : v.st;
  if (!s || !s.squelch_levels || !(s.mode in s.squelch_levels)) return;
  const lvl = Number(e.target.value);
  if (v === active) {
    st.squelch_levels = { ...st.squelch_levels, [st.mode]: lvl };
    renderSquelch();
    renderVfoDisplays();
    send({ squelch: lvl, squelch_mode: st.mode });
    return;
  }
  v.localSql = { ...s.squelch_levels, [s.mode]: lvl };
  v.localSqlAt = Date.now();
  v.st.squelch_levels = v.localSql;
  renderVfoDisplays();
  clearTimeout(v.sqlTimer);
  v.sqlTimer = setTimeout(() => {
    fetch(v.base + "/api/set", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ squelch: lvl, squelch_mode: s.mode }) });
  }, 60);
});

$("vfoList").addEventListener("click", (e) => {
  const row = e.target.closest(".vfo-row:not(.spare)");   // a free window without an SDR does not react
  if (!row) return;
  const v = vfos.find((x) => String(x.name) === row.dataset.vfo);
  if (e.target.closest(".vfo-cue")) { setCue(v, !v.cue); return; }   // CUE does not switch the VFO
  if (e.target.closest(".vfo-rf")) return;                             // neither does RF GAIN
  if (v !== active) { selectVfo(v); return; }
  if (!st || !e.target.closest(".freq")) return;
  const fr = row.querySelector(".freq");
  fr.hidden = true;
  const inp = $("freqInput");
  fr.after(inp);
  inp.hidden = false;
  inp.value = st.tune_hz >= 30e6 ? `${fmtMHz(st.tune_hz, 5)}M`.replace(/\s/g, "") : fmtKHz(st.tune_hz).replace(/\s/g, "");
  inp.focus();
  inp.select();
});
$("freqInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const hz = parseFreq($("freqInput").value);
    if (hz !== null) tune(hz);
    closeFreqInput();
  } else if (e.key === "Escape") {
    closeFreqInput();
  }
});
$("freqInput").addEventListener("blur", closeFreqInput);
function closeFreqInput() {
  $("freqInput").hidden = true;
  for (const f of $("vfoList").querySelectorAll(".freq")) f.hidden = false;
}

// FM BCAST (frequency 0 in BAND_GROUPS) tunes the last FM station listened to.
const FM_BCAST = [87.5e6, 108e6];
const fmLast = () => Number(recall("fmLast")) || 88e6;
function rememberFm() {
  if (st.mode === "WFM" && st.tune_hz >= FM_BCAST[0] && st.tune_hz <= FM_BCAST[1] && String(st.tune_hz) !== recall("fmLast")) {
    store("fmLast", st.tune_hz);
  }
}
const fmtBand = (f) => (f >= 30e6 ? `${fmtMHz(f, 4)} MHz` : `${fmtKHz(f, 0)} kHz`);
$("bandGroups").innerHTML = BAND_GROUPS.map(([title, list]) =>
  `<div class="bgroup"><span class="klabel">${title}</span><div class="bands">` +
  list.map((b) => `<button data-f="${b[1]}" data-m="${b[2]}" title="${(b[1] ? fmtBand(b[1]) : "last FM station") + " · " + b[2]}">${b[0]}</button>`).join("") +
  `</div></div>`).join("");
// BAND key (MENU): shows / hides the row of band keys with a slide; the spectrum takes / gives back the space
function showBands(on, animate = true) {
  const row = $("bandGroups");
  $("bandKey").classList.toggle("active", on);
  $("bandKey").setAttribute("aria-pressed", on ? "true" : "false");
  store("bandsShown", on ? "1" : "0");
  if (!animate) {
    row.classList.toggle("bands-off", !on);
    row.style.height = on ? "" : "0px";
    return;
  }
  if (on) {
    row.style.transition = "none";           // measure the open row without the transition
    row.classList.remove("bands-off");
    row.style.height = "auto";
    const h = row.offsetHeight;
    row.classList.add("bands-off");
    row.style.height = "0px";
    row.offsetHeight;                        // closed state applied
    row.style.transition = "";
    row.classList.remove("bands-off");
    row.style.height = `${h}px`;
    row.addEventListener("transitionend", function done(e) {
      if (e.propertyName !== "height") return;
      row.removeEventListener("transitionend", done);
      if (!row.classList.contains("bands-off")) row.style.height = "";   // auto again: wrapping on a resize
    });
  } else {
    row.style.height = `${row.offsetHeight}px`;
    row.offsetHeight;
    row.classList.add("bands-off");
    row.style.height = "0px";
  }
}
showBands(recall("bandsShown") !== "0", false);
$("bandKey").addEventListener("click", () => showBands($("bandGroups").classList.contains("bands-off")));
// VIEW key (far left): hides / shows the whole lower part with the tabs; the slide is in CSS (html.body-off).
// Lit while hidden. A key that opens a tab (DECODE, MEM, SCAN …) shows the lower part again.
let bodyAnimTimer = 0;
function showBody(on, animate = true) {
  const root = document.documentElement;
  // the slide runs only now (html.body-anim): a window resize must change the height of the lower part at once
  if (animate) {
    root.classList.add("body-anim");
    clearTimeout(bodyAnimTimer);
    bodyAnimTimer = setTimeout(() => {
      root.classList.remove("body-anim");
      if (!bodyHidden()) window.dispatchEvent(new Event("resize"));   // open again: sizes may have changed while hidden
    }, 340);
  }
  root.classList.toggle("body-off", !on);
  $("bodyKey").classList.toggle("on", !on);
  $("bodyKey").setAttribute("aria-pressed", on ? "false" : "true");
  store("bodyShown", on ? "1" : "0");
  // the page scale depends on it (fitStage); when shown, the rest is resized after the slide (timer above)
  if (on || !animate) fitStage(); else window.dispatchEvent(new Event("resize"));
}
const bodyHidden = () => document.documentElement.classList.contains("body-off");
if (!MAP_ONLY) showBody(recall("bodyShown") !== "0", false);
$("bodyKey").addEventListener("click", () => showBody(bodyHidden()));
document.querySelector(".r-keys").addEventListener("click", (e) => {
  const k = e.target.closest("[aria-controls]");
  if (k && bodyHidden() && !["bodyKey", "bandKey"].includes(k.id)) showBody(true);
});
$("bandGroups").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-f]");
  if (!b || !st) return;
  if (st.dab) dabOff();   // another band: DAB off (previous sample rate back)
  if (st.ism) ismOff();   // ISM too
  const f = Number(b.dataset.f) || fmLast();
  await ensureVfoFor(f);   // e.g. an HF band on a VFO without upconverter -> VFO A
  if (!st) return;
  for (const x of $("bandGroups").querySelectorAll("button")) x.classList.toggle("active", x === b);
  st.mode = b.dataset.m;
  renderControls();
  tune(f);
  send({ mode: b.dataset.m });
});

// ---------- S-meter: layouts chosen in SET ----------

// All layouts share the scale: S0..S9 up to S9_POS, then up to +60 dB.
const S9_POS = 0.6;
const METER_LABELS = ["1", "3", "5", "7", "9", "20", "40", "60"].map((t, i) => [t, (2 * i + 1) / 15]);
const METER_WHITE = "#e8edf2", METER_GREEN = "#3cf07c", METER_RED = "#ff3b30";
const LED_ON = (i, n) => (i < n * S9_POS ? METER_GREEN : METER_RED);
const LED_OFF = (i, n) => (i < n * S9_POS ? "#12291b" : "#33110e");
let s9Dbfs = -40;
let meterTarget = -120;
let meterNow = -120;

/** dBFS -> position 0..1 on the scale: S0..S9 in 6 dB steps, above S9 up to +60 dB. */
function meterPos(dbfs) {
  const over = dbfs - s9Dbfs;
  if (over <= 0) return Math.max(0, (over + 54) / 54) * S9_POS;
  return S9_POS + Math.min(over, 60) / 60 * (1 - S9_POS);
}

const fx = (v) => v.toFixed(2);

/** Flat wide arc like on a transceiver display; the pivot is below the bottom edge. */
function meterArc(cx, cy, a) {
  const pt = (p, r) => {
    const rad = (-a + p * 2 * a) * Math.PI / 180;
    return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
  };
  const path = (p0, p1, r) => {
    const [x0, y0] = pt(p0, r), [x1, y1] = pt(p1, r);
    return `M${fx(x0)},${fx(y0)} A${r},${r} 0 0 1 ${fx(x1)},${fx(y1)}`;
  };
  return { cx, cy, a, pt, path };
}

function sqlLine(color = "#ffd84a") {
  return `<line class="sql-mark" stroke="${color}" stroke-width="3" stroke-linecap="round" style="display:none"><title>Squelch</title></line>`;
}

/** Fills the SVG: background, clipped content and the frame. id keeps the defs of several meters apart. */
function meterFace(svg, id, background, inner, defs = "") {
  svg.innerHTML = `<defs>
    <clipPath id="${id}clip"><rect x="0" y="0" width="260" height="100" rx="1"/></clipPath>${defs}
  </defs>
  <g clip-path="url(#${id}clip)">
  <rect x="0" y="0" width="260" height="100" fill="${background}"/>${inner}
  </g>
  <rect x=".5" y=".5" width="259" height="99" rx="1" fill="none" stroke="#000"/>`;
}

/** Straight row of n segments (class seg). */
function segmentRow(n, x0, x1, y, h, off, gap = 0.2) {
  const w = (x1 - x0) / n;
  let s = "";
  for (let i = 0; i < n; i++) {
    s += `<rect class="seg" x="${fx(x0 + i * w)}" y="${y}" width="${fx(w * (1 - gap))}" height="${h}" rx=".5" fill="${off(i, n)}"/>`;
  }
  return s;
}

/** Returns a function that lights the segments up to a scale position; touches only those that changed. */
function segmentLighter(svg, on, off, glow = false) {
  const segs = [...svg.querySelectorAll(".seg")];
  const n = segs.length;
  let lit = 0;
  return (pos) => {
    const want = Math.min(n, Math.floor(pos * n + 0.5));
    for (let i = lit; i < want; i++) {
      segs[i].setAttribute("fill", on(i, n));
      if (glow) segs[i].style.filter = `drop-shadow(0 0 2px ${on(i, n)})`;
    }
    for (let i = want; i < lit; i++) {
      segs[i].setAttribute("fill", off(i, n));
      if (glow) segs[i].style.filter = "";
    }
    lit = want;
  };
}

/** Numbers on a straight scale; tick(x, p) can add a mark to each. */
function straightLabels(x0, x1, y, under, over, tick) {
  return METER_LABELS.map(([t, p]) => {
    const x = x0 + p * (x1 - x0);
    return `<text x="${fx(x)}" y="${y}" fill="${p <= S9_POS ? under : over}">${t}</text>${tick ? tick(x, p) : ""}`;
  }).join("");
}

const straightSql = (x0, x1, y0, y1) => (p) => {
  const x = x0 + p * (x1 - x0);
  return [x, y0, x, y1];
};

const NEEDLE_ARC = meterArc(130, 290, 25);
const NEEDLE_R = 252;
const BAR_ARC = meterArc(130, 366, 18.5);
const BAR_R = 320, BAR_WIDTH = 10, BAR_SEGMENTS = 30;
const AMBER_ARC = meterArc(130, 300, 24);
const AMBER_R = 250;
const SEVEN_SEG = { 0: "abcdef", 1: "bc", 2: "abged", 3: "abgcd", 4: "fgbc", 5: "afgcd", 6: "afgedc", 7: "abc", 8: "abcdefg", 9: "abcdfg" };

// draw(svg, id) builds the meter and returns update(position, dB above S9); sql(position) = squelch mark line.
const METER_STYLES = {
  needle: {
    name: "Needle",
    draw(svg, id) {
      // Meter look taken from a transceiver display: black background, white numbers and ticks,
      // green band S1–S9, red above S9, thin red needle.
      const { pt, path, cx, cy, a } = NEEDLE_ARC;
      const r = NEEDLE_R, RED = "#ff3b30";
      let s = `<path d="${path(0, S9_POS, r - 3)}" stroke="${METER_GREEN}" stroke-width="4" fill="none"/>
        <path d="${path(S9_POS, 1, r - 3)}" stroke="${RED}" stroke-width="4" fill="none"/>
        <path d="${path(0, 1, r + 1)}" stroke="${METER_WHITE}" stroke-width="1" fill="none" opacity=".75"/>`;
      // ticks every S unit and every 10 dB, numbers on odd S units and on +20/+40/+60
      for (let u = 0; u <= 9; u++) {
        const p = (u / 9) * S9_POS, major = u % 2 === 1;
        const [x0, y0] = pt(p, r + (major ? 7 : 4)), [x1, y1] = pt(p, r + 1);
        s += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${METER_WHITE}" stroke-width="${major ? 1.6 : 1}"/>`;
        if (major) {
          const [tx, ty] = pt(p, r + 16);
          s += `<text x="${tx}" y="${ty}" fill="${METER_WHITE}">${u}</text>`;
        }
      }
      for (const db of [10, 20, 30, 40, 50, 60]) {
        const p = S9_POS + db / 60 * (1 - S9_POS), major = db % 20 === 0;
        const [x0, y0] = pt(p, r + (major ? 7 : 4)), [x1, y1] = pt(p, r + 1);
        s += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${RED}" stroke-width="${major ? 1.6 : 1}"/>`;
        if (major) {
          const [tx, ty] = pt(p, r + 16);
          s += `<text x="${tx}" y="${ty}" fill="${RED}">+${db}</text>`;
        }
      }
      const [sx, sy] = pt(0, r + 4);
      s += `<text x="${sx - 2}" y="${sy + 14}" class="big" fill="${METER_WHITE}">S</text>
        <text x="236" y="90" fill="${RED}">dB</text>
        <text x="130" y="88" class="title" fill="#7d8896">SIGNAL</text>
        ${sqlLine()}
        <g class="needle"><line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r - 8}" stroke="${RED}" stroke-width="1.8" stroke-linecap="round"/></g>`;
      meterFace(svg, id, `url(#${id}face)`, s, `<linearGradient id="${id}face" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0b0f14"/><stop offset="1" stop-color="#020304"/></linearGradient>`);
      const needle = svg.querySelector(".needle");
      return (pos) => needle.setAttribute("transform", `rotate(${fx(-a + pos * 2 * a)} ${cx} ${cy})`);
    },
    sql: (p) => [...NEEDLE_ARC.pt(p, NEEDLE_R - 9), ...NEEDLE_ARC.pt(p, NEEDLE_R + 1)],
  },
  bar: {
    name: "Bar graph",
    draw(svg, id) {
      // Numbers and dashes above a curved row of segments.
      const { pt, path } = BAR_ARC;
      const r = BAR_R, ri = r - BAR_WIDTH, labelR = r + 13, GREEN = "#a4e08c", RED = "#f0402c";
      const on = (i, n) => (i < n * S9_POS ? GREEN : RED), off = (i, n) => (i < n * S9_POS ? "#1c3020" : "#3a1712");
      let s = "", prev = 0;
      for (const [t, p] of METER_LABELS) {
        const color = p <= S9_POS ? GREEN : RED, pad = t.length > 1 ? 0.04 : 0.024;
        const [tx, ty] = pt(p, labelR);
        s += `<path d="${path(prev, p - pad, labelR)}" stroke="${color}" stroke-width="1.4" fill="none"/>
          <text x="${fx(tx)}" y="${fx(ty)}" fill="${color}">${t}</text>`;
        prev = p + pad;
      }
      const gap = 0.11 / BAR_SEGMENTS;
      for (let i = 0; i < BAR_SEGMENTS; i++) {
        const p0 = i / BAR_SEGMENTS + gap, p1 = (i + 1) / BAR_SEGMENTS - gap;
        const [ax, ay] = pt(p0, r), [bx, by] = pt(p1, r), [cx, cy] = pt(p1, ri), [dx, dy] = pt(p0, ri);
        s += `<path class="seg" d="M${fx(ax)},${fx(ay)} A${r},${r} 0 0 1 ${fx(bx)},${fx(by)} L${fx(cx)},${fx(cy)} A${ri},${ri} 0 0 0 ${fx(dx)},${fx(dy)} Z" fill="${off(i, BAR_SEGMENTS)}"/>`;
      }
      const [sx, sy] = pt(0, labelR), [ex, ey] = pt(1, labelR);
      s += `<text x="${fx(sx - 8)}" y="${fx(sy)}" class="big" fill="${GREEN}">S</text>
        <text x="${fx(ex + 16)}" y="${fx(ey)}" class="unit" fill="${RED}">dB</text>${sqlLine()}`;
      meterFace(svg, id, "#050706", s);
      return segmentLighter(svg, on, off);
    },
    sql: (p) => [...BAR_ARC.pt(p, 307), ...BAR_ARC.pt(p, 323)],
  },
  led: {
    name: "LED bar",
    draw(svg, id) {
      const x0 = 24, x1 = 232;
      meterFace(svg, id, "#07090c",
        straightLabels(x0, x1, 34, METER_WHITE, METER_RED, (x, p) => `<line x1="${fx(x)}" x2="${fx(x)}" y1="43" y2="49" stroke="${p <= S9_POS ? METER_WHITE : METER_RED}" stroke-width="1.4"/>`) +
        segmentRow(BAR_SEGMENTS, x0, x1, 53, 22, LED_OFF) +
        `<text x="12" y="64" class="big" fill="${METER_WHITE}">S</text><text x="248" y="34" class="unit" fill="${METER_RED}">dB</text>${sqlLine()}`);
      return segmentLighter(svg, LED_ON, LED_OFF);
    },
    sql: straightSql(24, 232, 50, 78),
  },
  vfd: {
    name: "VFD display",
    draw(svg, id) {
      const x0 = 24, x1 = 232, s9 = x0 + S9_POS * (x1 - x0), CYAN = "#62f6e6", ORANGE = "#ffae66";
      const on = (i, n) => (i < n * S9_POS ? CYAN : ORANGE), off = (i, n) => (i < n * S9_POS ? "#0b2a2d" : "#2b1c10");
      meterFace(svg, id, `url(#${id}bg)`,
        straightLabels(x0, x1, 26, CYAN, ORANGE) +
        `<line x1="${x0}" x2="${fx(s9)}" y1="36" y2="36" stroke="${CYAN}" stroke-width="1.2"/><line x1="${fx(s9)}" x2="${x1}" y1="36" y2="36" stroke="${ORANGE}" stroke-width="1.2"/>` +
        segmentRow(45, x0, x1, 44, 30, off, 0.42) +
        `<text x="12" y="59" class="big" fill="${CYAN}">S</text><text x="248" y="26" class="unit" fill="${ORANGE}">dB</text>${sqlLine()}`,
        `<linearGradient id="${id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#03181b"/><stop offset="1" stop-color="#020c0e"/></linearGradient>`);
      return segmentLighter(svg, on, off, true);
    },
    sql: straightSql(24, 232, 40, 77),
  },
  amber: {
    name: "Amber needle",
    draw(svg, id) {
      const { pt, path, cx, cy, a } = AMBER_ARC;
      const r = AMBER_R, INK = "#1d1204", DARK_RED = "#8e1408";
      let s = `<path d="${path(0, S9_POS, r)}" stroke="${INK}" stroke-width="2.4" fill="none"/>
        <path d="${path(S9_POS, 1, r + 1)}" stroke="#a81c10" stroke-width="5" fill="none"/>`;
      for (let u = 0; u <= 9; u++) {
        const p = (u / 9) * S9_POS, major = u % 2 === 1;
        const [x0, y0] = pt(p, r + (major ? 8 : 5)), [x1, y1] = pt(p, r);
        s += `<line x1="${fx(x0)}" y1="${fx(y0)}" x2="${fx(x1)}" y2="${fx(y1)}" stroke="${INK}" stroke-width="${major ? 1.6 : 1}"/>`;
      }
      for (const [t, p] of METER_LABELS) {
        const [tx, ty] = pt(p, r + 17);
        s += `<text x="${fx(tx)}" y="${fx(ty)}" fill="${p <= S9_POS ? INK : DARK_RED}">${p > S9_POS ? "+" + t : t}</text>`;
      }
      // the yellow squelch mark would disappear on the amber face: it is dark blue here
      s += `<text x="18" y="46" class="big" fill="${INK}">S</text>${sqlLine("#123a9c")}
        <g class="needle"><line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r - 7}" stroke="#120a02" stroke-width="1.8"/></g>
        <rect x="0" y="84" width="260" height="16" fill="#23170a"/><text x="130" y="92" class="hood" fill="#e6a540">SIGNAL</text>`;
      meterFace(svg, id, `url(#${id}face)`, s, `<radialGradient id="${id}face" cx=".5" cy=".55" r=".75">
        <stop offset="0" stop-color="#ffd27a"/><stop offset=".65" stop-color="#eba53c"/><stop offset="1" stop-color="#a8660f"/></radialGradient>`);
      const needle = svg.querySelector(".needle");
      return (pos) => needle.setAttribute("transform", `rotate(${fx(-a + pos * 2 * a)} ${cx} ${cy})`);
    },
    sql: (p) => [...AMBER_ARC.pt(p, AMBER_R - 9), ...AMBER_ARC.pt(p, AMBER_R + 3)],
  },
  digital: {
    name: "7-segment",
    draw(svg, id) {
      // Reading in 7-segment digits (the S looks like a 5, as on a real display) with a thin bar below it.
      const ON = "#ffb547", OFF = "#241a08", W = 26, H = 44, T = 5, Y = 9;
      const bars = (x) => ({
        a: [x + T, Y, W - 2 * T, T], g: [x + T, Y + (H - T) / 2, W - 2 * T, T], d: [x + T, Y + H - T, W - 2 * T, T],
        f: [x, Y + T, T, (H - 3 * T) / 2], b: [x + W - T, Y + T, T, (H - 3 * T) / 2],
        e: [x, Y + (H + T) / 2, T, (H - 3 * T) / 2], c: [x + W - T, Y + (H + T) / 2, T, (H - 3 * T) / 2],
      });
      let s = "";
      [46, 80, 114, 148, 182].forEach((x, slot) => {
        if (slot === 2) {   // plus sign
          s += `<rect class="plus" x="${x + 4}" y="${Y + H / 2 - 2.5}" width="18" height="5" fill="${OFF}"/><rect class="plus" x="${x + 10.5}" y="${Y + H / 2 - 9}" width="5" height="18" fill="${OFF}"/>`;
          return;
        }
        const b = bars(x);
        for (const n of "abcdefg") s += `<rect class="d7" data-slot="${slot}" data-bar="${n}" x="${b[n][0]}" y="${b[n][1]}" width="${b[n][2]}" height="${b[n][3]}" fill="${OFF}"/>`;
      });
      meterFace(svg, id, "#07090c", s + segmentRow(BAR_SEGMENTS, 24, 232, 62, 9, LED_OFF, 0.25) +
        straightLabels(24, 232, 84, METER_WHITE, METER_RED) + sqlLine());
      const light = segmentLighter(svg, LED_ON, LED_OFF);
      const digits = [...svg.querySelectorAll(".d7")], plus = [...svg.querySelectorAll(".plus")];
      let last = "";
      return (pos, over) => {
        light(pos);
        const up = over > 0 ? Math.min(99, Math.round(over)) : -1;
        const unit = up >= 0 ? 9 : Math.max(0, Math.round(9 + over / 6));
        const key = `${unit}/${up}`;
        if (key === last) return;
        last = key;
        const show = { 0: 5, 1: unit, 3: up >= 10 ? Math.floor(up / 10) : "", 4: up >= 0 ? up % 10 : "" };
        for (const d of digits) d.setAttribute("fill", (SEVEN_SEG[show[d.dataset.slot]] || "").includes(d.dataset.bar) ? ON : OFF);
        for (const d of plus) d.setAttribute("fill", up >= 0 ? ON : OFF);
      };
    },
    sql: straightSql(24, 232, 59, 74),
  },
  peak: {
    name: "Peak bar",
    draw(svg, id) {
      // Continuous bar; the white mark holds the last peak for about a second, then falls slowly.
      const x0 = 24, x1 = 232, w = x1 - x0;
      meterFace(svg, id, "#07090c",
        straightLabels(x0, x1, 32, METER_WHITE, METER_RED, (x, p) => `<line x1="${fx(x)}" x2="${fx(x)}" y1="42" y2="48" stroke="${p <= S9_POS ? METER_WHITE : METER_RED}" stroke-width="1.2"/>`) +
        `<rect x="${x0}" y="52" width="${w}" height="20" rx="4" fill="#14181e"/><rect class="fill" x="${x0}" y="52" width="0" height="20" rx="4" fill="url(#${id}bar)"/>
        <rect class="peak" x="${x0}" y="49" width="2.4" height="26" fill="#ffffff"/>
        <text x="12" y="62" class="big" fill="${METER_WHITE}">S</text><text x="248" y="32" class="unit" fill="${METER_RED}">dB</text>${sqlLine()}`,
        `<linearGradient id="${id}bar" gradientUnits="userSpaceOnUse" x1="${x0}" x2="${x1}" y1="0" y2="0"><stop offset="0" stop-color="#1fb45c"/><stop offset=".5" stop-color="#7be04d"/><stop offset=".62" stop-color="#ffd84a"/><stop offset=".78" stop-color="#ff8c1a"/><stop offset="1" stop-color="#ff3b30"/></linearGradient>`);
      const fill = svg.querySelector(".fill"), mark = svg.querySelector(".peak");
      let peak = 0, hold = 0;
      return (pos) => {
        if (pos >= peak) { peak = pos; hold = 60; }
        else if (hold > 0) hold--;
        else peak = Math.max(pos, peak - 0.004);
        fill.setAttribute("width", fx(pos * w));
        mark.setAttribute("x", fx(x0 + peak * w - 1.2));
      };
    },
    sql: straightSql(24, 232, 47, 77),
  },
};

let meterStyle = METER_STYLES[recall("meterStyle")] ? recall("meterStyle") : "amber";
let meterUpdate = () => {};

function buildMeter() {
  meterUpdate = METER_STYLES[meterStyle].draw($("smeter"), "m");
  placeSqlMark();
}

/** SET: one small sample of each layout, shown at S9+20 dB; a click selects it. */
function buildMeterPicker() {
  const box = $("meterStyles");
  for (const [key, style] of Object.entries(METER_STYLES)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "meter-pick";
    b.dataset.style = key;
    b.innerHTML = `<svg class="meter-face" viewBox="0 0 260 100" aria-hidden="true"></svg><span>${style.name}</span>`;
    box.appendChild(b);
    style.draw(b.querySelector("svg"), `p${key}`)(S9_POS + 20 / 60 * (1 - S9_POS), 20);
  }
  const mark = () => {
    for (const b of box.children) {
      b.classList.toggle("on", b.dataset.style === meterStyle);
      b.setAttribute("aria-pressed", b.dataset.style === meterStyle);
    }
  };
  box.addEventListener("click", (e) => {
    const b = e.target.closest(".meter-pick");
    if (!b) return;
    meterStyle = b.dataset.style;
    store("meterStyle", meterStyle);
    buildMeter();
    mark();
  });
  mark();
}

function animateMeter() {
  // Ballistics like an analogue meter: fast attack, slower return.
  const k = meterTarget > meterNow ? 0.6 : 0.07;
  meterNow += (meterTarget - meterNow) * k;
  meterUpdate(meterPos(meterNow), meterNow - s9Dbfs);
  requestAnimationFrame(animateMeter);
}

function sReading(dbfs) {
  const over = dbfs - s9Dbfs;
  if (over > 0) return `S9+${Math.round(over)} dB`;
  return `S${Math.max(0, Math.round(9 + over / 6))}`;
}

function renderS9() { $("s9Text").textContent = `${s9Dbfs} dBFS`; placeSqlMark(); }
const savedS9 = Number(recall("s9"));
if (savedS9) { s9Dbfs = savedS9; $("s9").value = savedS9; }
$("s9").addEventListener("input", () => { s9Dbfs = Number($("s9").value); store("s9", s9Dbfs); renderS9(); });
renderS9();
buildMeter();
buildMeterPicker();

// ---------- SET → SKINS: finish of the chassis (style.css, html[data-skin]); remembered in this browser ----------
const SKINS = { "alu-dark": "Dark brushed aluminium", "alu-black": "Black brushed aluminium", "alu-light": "Light brushed aluminium", mahogany: "Mahogany", paint: "Paint (RAL)" };
// RAL Classic: screen approximations (sRGB) of the common shades
const RAL = [
  ["1013", "Oyster white", "#e3d9c6"], ["1015", "Light ivory", "#e6d2b5"], ["1021", "Colza yellow", "#f6b600"],
  ["1023", "Traffic yellow", "#f7b500"], ["2004", "Pure orange", "#e25303"], ["2008", "Bright red orange", "#ed6b21"],
  ["3000", "Flame red", "#a72920"], ["3003", "Ruby red", "#861a22"], ["3005", "Wine red", "#5e2028"],
  ["3020", "Traffic red", "#bb1e10"], ["4006", "Traffic purple", "#903373"], ["4005", "Blue lilac", "#76689a"],
  ["5002", "Ultramarine blue", "#00387b"], ["5003", "Sapphire blue", "#1f3855"], ["5010", "Gentian blue", "#004f7c"],
  ["5012", "Light blue", "#0089b6"], ["5015", "Sky blue", "#007cb0"], ["5017", "Traffic blue", "#005b8c"],
  ["5024", "Pastel blue", "#6093ac"], ["6005", "Moss green", "#0f4336"], ["6009", "Fir green", "#27352a"],
  ["6011", "Reseda green", "#587f40"], ["6018", "Yellow green", "#48a43f"], ["6029", "Mint green", "#006f3d"],
  ["7001", "Silver grey", "#8c969d"], ["7012", "Basalt grey", "#575d5e"], ["7016", "Anthracite grey", "#383e42"],
  ["7021", "Black grey", "#2f3234"], ["7024", "Graphite grey", "#474a50"], ["7035", "Light grey", "#cbd0cc"],
  ["7040", "Window grey", "#9da3a6"], ["8011", "Nut brown", "#5a3826"], ["8017", "Chocolate brown", "#44322d"],
  ["9005", "Jet black", "#0a0a0d"], ["9006", "White aluminium", "#a5a8a6"], ["9010", "Pure white", "#f1ece1"],
];
/** "dark" when print on this colour has to be dark (relative luminance of a light paint). */
function inkFor(hex) {
  const lin = (i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5) > 0.3 ? "dark" : "light";
}
let skin = SKINS[recall("skin")] ? recall("skin") : "alu-dark";
let skinPaint = /^#[0-9a-f]{6}$/i.test(recall("skinPaint") || "") ? recall("skinPaint") : "#383e42";

function applySkin() {
  const d = document.documentElement;
  d.dataset.skin = skin;
  d.style.setProperty("--paint", skinPaint);
  if (skin === "paint") d.dataset.ink = inkFor(skinPaint); else delete d.dataset.ink;
  store("skin", skin);
  store("skinPaint", skinPaint);
  store("skinInk", d.dataset.ink || "");
  for (const b of $("skinPicks").children) {
    b.classList.toggle("on", b.dataset.skin === skin);
    b.setAttribute("aria-pressed", b.dataset.skin === skin);
  }
  const ral = RAL.find((r) => r[2] === skinPaint.toLowerCase());
  for (const b of $("ralGrid").children) b.classList.toggle("on", skin === "paint" && b.dataset.hex === skinPaint.toLowerCase());
  $("ralText").textContent = skin !== "paint" ? "" : ral ? `RAL ${ral[0]} ${ral[1]}` : skinPaint;
  $("ralCustom").value = skinPaint;
}

function buildSkinPicker() {
  const box = $("skinPicks");
  for (const [key, name] of Object.entries(SKINS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "skin-pick";
    b.dataset.skin = key;   // the sample takes the finish's own variables from style.css
    if (key === "paint") b.style.setProperty("--paint", skinPaint);
    b.innerHTML = `<i></i><span>${name}</span>`;
    box.appendChild(b);
  }
  box.addEventListener("click", (e) => {
    const b = e.target.closest(".skin-pick");
    if (!b) return;
    skin = b.dataset.skin;
    applySkin();
  });
  const grid = $("ralGrid");
  for (const [code, name, hex] of RAL) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ral";
    b.dataset.hex = hex;
    b.title = `RAL ${code} ${name}`;
    b.style.background = hex;
    b.style.color = inkFor(hex) === "dark" ? "#1a1a1a" : "#f2f2f2";
    b.innerHTML = `${code}<small>${name}</small>`;
    grid.appendChild(b);
  }
  const paint = (hex) => {
    skin = "paint";
    skinPaint = hex.toLowerCase();
    box.querySelector('[data-skin="paint"]').style.setProperty("--paint", skinPaint);
    applySkin();
  };
  grid.addEventListener("click", (e) => { const b = e.target.closest(".ral"); if (b) paint(b.dataset.hex); });
  $("ralCustom").addEventListener("input", (e) => paint(e.target.value));
  applySkin();
}
buildSkinPicker();
requestAnimationFrame(animateMeter);

// ---------- spectrum and waterfall ----------

// Waterfall rows = height of the waterfall window in CSS pixels (recalculated when the window changes).
let WF_ROWS = wfRowsWanted();
function wfRowsWanted() {
  return Math.max(120, Math.min(1400, Math.round(document.querySelector(".waterfall-wrap").clientHeight || 320)));
}
const wfCanvas = $("waterfall");
const wfCtx = wfCanvas.getContext("2d");
let wfRow = null;
let floor = null;
let spec = null;
let imgC = 0; // centre that the waterfall image matches exactly (it moves by whole points)
let viewLocalAt = 0; // when the section was last moved by dragging
let drag = null;

// Colour schemes of the waterfall (and of its background): stops [position 0–1, r, g, b]. Picked in the waterfall
// settings (gear in the top right corner of the waterfall), kept in the browser. Only new rows take the new colours.
const WF_SCHEMES = {
  classic: { name: "Classic", bg: "#020828",   // noise almost black to dark blue, signals sharply yellow and red
    stops: [[0, 0, 0, 10], [0.16, 4, 14, 70], [0.32, 18, 60, 190], [0.46, 40, 175, 240],
      [0.6, 250, 235, 60], [0.78, 255, 100, 20], [1, 255, 255, 255]] },
  inferno: { name: "Inferno", bg: "#000004",   // black – purple – orange – pale yellow (perceptually uniform)
    stops: [[0, 0, 0, 4], [0.15, 31, 12, 72], [0.3, 85, 15, 109], [0.45, 136, 34, 106], [0.6, 186, 54, 85],
      [0.72, 227, 89, 51], [0.85, 249, 140, 10], [0.93, 249, 201, 50], [1, 252, 255, 164]] },
  viridis: { name: "Viridis", bg: "#0c0018",   // dark violet – blue – green – yellow (colour-blind friendly)
    stops: [[0, 12, 0, 24], [0.12, 68, 1, 84], [0.25, 65, 58, 130], [0.4, 46, 105, 142], [0.55, 33, 145, 140],
      [0.7, 53, 183, 121], [0.85, 144, 215, 67], [1, 253, 231, 37]] },
  turbo: { name: "Turbo", bg: "#12081e",       // rainbow with smooth steps: dark blue – cyan – green – yellow – red
    stops: [[0, 18, 8, 30], [0.1, 60, 60, 160], [0.2, 70, 117, 237], [0.3, 57, 162, 252], [0.4, 27, 207, 212],
      [0.5, 36, 236, 166], [0.6, 97, 252, 108], [0.7, 164, 252, 59], [0.8, 229, 209, 57], [0.88, 254, 155, 45],
      [0.95, 234, 79, 13], [1, 180, 25, 1]] },
  ice: { name: "Ice", bg: "#000000",           // black – deep blue – cyan – white (calm, signals stand out as light)
    stops: [[0, 0, 0, 0], [0.25, 0, 20, 45], [0.45, 0, 80, 130], [0.62, 0, 170, 210], [0.8, 120, 230, 255],
      [1, 255, 255, 255]] },
};
let wfScheme = WF_SCHEMES[recall("wfScheme")] ? recall("wfScheme") : "classic";
const wfBg = () => WF_SCHEMES[wfScheme].bg;

function buildLut(stops) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k], [t1, r1, g1, b1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    lut[i * 3] = r0 + (r1 - r0) * f; lut[i * 3 + 1] = g0 + (g1 - g0) * f; lut[i * 3 + 2] = b0 + (b1 - b0) * f;
  }
  return lut;
}
let LUT = buildLut(WF_SCHEMES[wfScheme].stops);

function clearWaterfall(bins) {
  wfCanvas.width = bins;
  wfCanvas.height = WF_ROWS;
  wfCtx.fillStyle = wfBg();
  wfCtx.fillRect(0, 0, bins, WF_ROWS);
  wfRow = new ImageData(bins, 1);
  wfAcc = null;
  spec = null;
}

// Waterfall speed / vertical zoom (bar in the top right corner of the waterfall, same style as the frequency zoom):
// below 1× several rows from the receiver are averaged into one line (slower, longer history), above 1× every row
// is drawn as several lines (faster, more detail in time). Kept in the browser.
const WF_SPEEDS = [0.125, 0.25, 0.5, 1, 2, 4];
const wfSpeedText = (v) => (v < 1 ? `1/${Math.round(1 / v)}` : `${v}×`);
let wfSpeed = WF_SPEEDS.includes(Number(recall("wfSpeed"))) ? Number(recall("wfSpeed")) : 1;
let wfAcc = null;   // rows waiting to be averaged (speed below 1×): sums per point and their count

function renderWfZoomBar() {
  const i = WF_SPEEDS.indexOf(wfSpeed), cells = $("wfZoomCells");
  if (cells.children.length !== WF_SPEEDS.length - 1) {
    cells.innerHTML = WF_SPEEDS.slice(1).map((v) => `<i data-v="${v}" title="${wfSpeedText(v)}"></i>`).join("");
  }
  [...cells.children].forEach((c, k) => c.classList.toggle("on", k < i));
  $("wfZoomVal").textContent = wfSpeedText(wfSpeed);
  const [minus, plus] = $("wfZoomBar").querySelectorAll(".zb-btn");
  minus.disabled = i <= 0;
  plus.disabled = i >= WF_SPEEDS.length - 1;
}
function setWfSpeed(v) {
  if (!WF_SPEEDS.includes(v) || v === wfSpeed) return;
  wfSpeed = v;
  wfAcc = null;
  store("wfSpeed", v);
  renderWfZoomBar();
}
$("wfZoomBar").addEventListener("click", (e) => {
  e.stopPropagation();
  const cell = e.target.closest("[data-v]");
  if (cell) {
    const v = Number(cell.dataset.v);
    setWfSpeed(v === wfSpeed ? WF_SPEEDS[WF_SPEEDS.indexOf(v) - 1] : v);   // a click on the last lit cell steps back one
    return;
  }
  const b = e.target.closest("[data-d]");
  if (b) setWfSpeed(WF_SPEEDS[WF_SPEEDS.indexOf(wfSpeed) + Number(b.dataset.d)]);
});
$("wfZoomBar").addEventListener("pointerdown", (e) => e.stopPropagation());
$("wfZoomBar").addEventListener("wheel", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const dir = wheelStep(e);
  if (dir) setWfSpeed(WF_SPEEDS[WF_SPEEDS.indexOf(wfSpeed) + dir]);
}, { passive: false });
renderWfZoomBar();

// Waterfall settings (gear above the speed bar): the window opens while the mouse is over the gear or the window and
// stays open while a slider is dragged out of it. Clicks, drags and the wheel in it do not tune.
function renderWfSchemes() {
  $("wfSchemes").innerHTML = Object.entries(WF_SCHEMES).map(([k, v]) =>
    `<button type="button" data-scheme="${k}" class="${k === wfScheme ? "on" : ""}" title="${v.name}">` +
    `<i style="background:linear-gradient(90deg,${v.stops.map(([t, r, g, b]) => `rgb(${r},${g},${b}) ${t * 100}%`).join(",")})"></i>` +
    `<span>${v.name}</span></button>`).join("");
}
$("wfSchemes").addEventListener("click", (e) => {
  const b = e.target.closest("[data-scheme]");
  if (!b || b.dataset.scheme === wfScheme) return;
  wfScheme = b.dataset.scheme;
  LUT = buildLut(WF_SCHEMES[wfScheme].stops);
  store("wfScheme", wfScheme);
  renderWfSchemes();
});
for (const ev of ["click", "pointerdown", "wheel", "dblclick", "contextmenu"]) {
  $("wfCfg").addEventListener(ev, (e) => e.stopPropagation());
}
$("wfCfg").addEventListener("pointerdown", () => {
  $("wfCfg").classList.add("hold");
  document.addEventListener("pointerup", () => $("wfCfg").classList.remove("hold"), { once: true });
});
renderWfSchemes();

function colorRange() {
  const stepDb = st.wf.db_step;
  const lo = floor + (Number($("wfShift").value) - 3) / stepDb;
  return [lo, Number($("wfRange").value) / stepDb];
}

const b64Bytes = (b64) => {
  const bin = atob(b64), vals = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) vals[i] = bin.charCodeAt(i);
  return vals;
};

// History of the whole band (hidden canvas, scrolls together with the waterfall): when zooming out or moving the
// section, the parts that were hidden are drawn from it (coarser, the whole band has the same number of points).
let wfFull = null;   // { cv, ctx, c, span, n, row: ImageData, acc: { sum, cnt } }

function wfFullAdd(vals, c, span, flush, h, lo, rng) {
  const n = vals.length;
  let F = wfFull;
  if (!F || F.n !== n || Math.abs(F.span - span) > 1) {
    const cv = document.createElement("canvas");
    cv.width = n; cv.height = WF_ROWS;
    F = wfFull = { cv, ctx: cv.getContext("2d"), c, span, n, row: new ImageData(n, 1), acc: null };
    F.ctx.fillStyle = wfBg();
    F.ctx.fillRect(0, 0, n, WF_ROWS);
  }
  if (F.cv.height !== WF_ROWS) {   // window height changed: keep the newest rows at the top
    const old = F.ctx.getImageData(0, 0, n, Math.min(F.cv.height, WF_ROWS));
    F.cv.height = WF_ROWS;
    F.ctx.fillStyle = wfBg();
    F.ctx.fillRect(0, 0, n, WF_ROWS);
    F.ctx.putImageData(old, 0, 0);
  }
  const dx = Math.round(((c - F.c) / span) * n);
  if (dx) {   // band centre moved: move the history with it
    const img = F.ctx.getImageData(0, 0, n, WF_ROWS);
    F.ctx.fillStyle = wfBg();
    F.ctx.fillRect(0, 0, n, WF_ROWS);
    F.ctx.putImageData(img, -dx, 0);
    F.c += (dx * span) / n;
    F.acc = null;
  }
  const off = Math.round(((c - F.c) / span) * n);
  if (!F.acc) F.acc = { sum: new Float32Array(n), cnt: new Uint16Array(n) };
  for (let j = 0; j < n; j++) {
    const i = j - off;
    if (i >= 0 && i < n) { F.acc.sum[j] += vals[i]; F.acc.cnt[j]++; }
  }
  if (!flush) return;
  const d = F.row.data;
  for (let j = 0; j < n; j++) {
    let k = 0;
    if (F.acc.cnt[j]) k = Math.max(0, Math.min(255, Math.round(((F.acc.sum[j] / F.acc.cnt[j] - lo) / rng) * 255))) * 3;
    d[j * 4] = LUT[k]; d[j * 4 + 1] = LUT[k + 1]; d[j * 4 + 2] = LUT[k + 2]; d[j * 4 + 3] = 255;
  }
  F.acc = null;
  F.ctx.drawImage(F.cv, 0, 0, n, WF_ROWS - h, 0, h, n, WF_ROWS - h);
  for (let y = 0; y < h; y++) F.ctx.putImageData(F.row, 0, y);
}

const wfFullOf = (ev) => (ev.full ? { c: ev.fc, span: ev.fspan, row: ev.full } : null);

/** Draws waterfall columns [x0, x1) from the whole-band history (where the history covers them). */
function paintFromFull(x0, x1) {
  const F = wfFull;
  if (!F || !view || x1 <= x0) return;
  const n = wfCanvas.width, left = imgC - view.span / 2, fLeft = F.c - F.span / 2;
  const src = (x) => ((left + (x * view.span) / n - fLeft) / F.span) * F.n;   // waterfall column → history column
  const dst = (s) => ((fLeft + (s * F.span) / F.n - left) / view.span) * n;
  const s0 = Math.max(0, src(x0)), s1 = Math.min(F.n, src(x1));
  if (s1 <= s0) return;
  const d0 = dst(s0), d1 = dst(s1), rows = Math.min(WF_ROWS, F.cv.height);
  wfCtx.drawImage(F.cv, s0, 0, s1 - s0, rows, d0, 0, d1 - d0, rows);
}

function onRow(center, span, b64, replay = false, full = null) {
  if (!st) return;
  const vals = b64Bytes(b64);
  const n = vals.length;

  if (!wfRow || wfRow.width !== n || !view || Math.abs(view.span - span) > 1) {
    // zoom changed: keep the shown picture, it is sharper than the whole-band history
    let prev = null;
    if (wfRow && view && wfCanvas.width === n) {
      const cv = document.createElement("canvas");
      cv.width = n; cv.height = wfCanvas.height;
      cv.getContext("2d").drawImage(wfCanvas, 0, 0);
      prev = { cv, c: imgC, span: view.span };
    }
    clearWaterfall(n);
    view = { c: center, span };
    imgC = center;
    paintFromFull(0, n);   // the history of the newly shown section (coarse) ...
    if (prev) {            // ... and over it the previous picture, scaled to where it belongs
      const x = (f) => ((f - (imgC - span / 2)) / span) * n;
      const d0 = x(prev.c - prev.span / 2), d1 = x(prev.c + prev.span / 2), rows = Math.min(WF_ROWS, prev.cv.height);
      wfCtx.drawImage(prev.cv, 0, 0, n, rows, d0, 0, d1 - d0, rows);
    }
    drawOverlays();
  } else if (center !== view.c && !drag && Date.now() - viewLocalAt > 1500) {
    // The server moved the section (tuning near the edge, band change): move the image with it.
    setView(center);
  }

  const sorted = Array.from(vals).sort((a, b) => a - b);
  const p20 = sorted[Math.floor(n * 0.2)];
  floor = floor === null ? p20 : floor * 0.95 + p20 * 0.05;
  const [lo, rng] = colorRange();
  // Draw the row where it belongs in the shown section; while dragging the server may still lag behind.
  const off = Math.round(((center - imgC) / span) * n);
  // speed below 1×: sum the rows (in screen points, so a moved section stays in place) and draw their average
  const every = wfSpeed < 1 ? Math.round(1 / wfSpeed) : 1;
  if (!wfAcc || wfAcc.sum.length !== n) wfAcc = { sum: new Float32Array(n), cnt: new Uint16Array(n), rows: 0 };
  for (let j = 0; j < n; j++) {
    const i = j - off;
    if (i >= 0 && i < n) { wfAcc.sum[j] += vals[i]; wfAcc.cnt[j]++; }
  }
  const flush = ++wfAcc.rows >= every;
  const h = Math.min(wfSpeed > 1 ? wfSpeed : 1, WF_ROWS);   // speed above 1×: the row is drawn as several lines
  if (flush) {
    const d = wfRow.data;
    for (let j = 0; j < n; j++) {
      let c = 0;
      if (wfAcc.cnt[j]) c = Math.max(0, Math.min(255, Math.round(((wfAcc.sum[j] / wfAcc.cnt[j] - lo) / rng) * 255))) * 3;
      d[j * 4] = LUT[c]; d[j * 4 + 1] = LUT[c + 1]; d[j * 4 + 2] = LUT[c + 2]; d[j * 4 + 3] = 255;
    }
    wfAcc = null;
    wfCtx.drawImage(wfCanvas, 0, 0, n, WF_ROWS - h, 0, h, n, WF_ROWS - h);
    for (let y = 0; y < h; y++) wfCtx.putImageData(wfRow, 0, y);
  }
  // whole band: from the server when zoomed in, at 1× the row itself
  if (full) wfFullAdd(b64Bytes(full.row), full.c, full.span, flush, h, lo, rng);
  else wfFullAdd(vals, center, span, flush, h, lo, rng);

  if (!spec || spec.length !== n) spec = Float32Array.from(vals);
  for (let j = 0; j < n; j++) {
    const i = j - off;
    if (i >= 0 && i < n) spec[j] = spec[j] * 0.6 + vals[i] * 0.4;
  }
  if (!replay) drawSpectrum();
}

/** Moves the shown section to centre c: the waterfall and spectrum images move by whole points. */
function setView(c) {
  const n = wfCanvas.width;
  const dx = Math.round(((c - imgC) / view.span) * n);
  if (dx) {
    const img = wfCtx.getImageData(0, 0, n, WF_ROWS);
    wfCtx.fillStyle = wfBg();
    wfCtx.fillRect(0, 0, n, WF_ROWS);
    wfCtx.putImageData(img, -dx, 0);
    imgC += (dx * view.span) / n;
    if (dx > 0) paintFromFull(n - dx, n); else paintFromFull(0, -dx);   // the uncovered strip from the history
    if (spec) {
      const s = new Float32Array(n).fill(floor ?? 0);
      for (let j = 0; j < n; j++) { const i = j + dx; if (i >= 0 && i < n) s[j] = spec[i]; }
      spec = s;
    }
  }
  view.c = c;
  drawOverlays();
  drawSpectrum();
}

function fitCanvas(cv) {
  const dpr = (window.devicePixelRatio || 1) * uiScale;   // sharp also on an enlarged page
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, cv.clientWidth, cv.clientHeight];
}

function drawSpectrum() {
  const [ctx, w, h] = fitCanvas($("spectrum"));
  // Black-grey panorama display (grey at the top, black at the bottom).
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#3a3d42"); g.addColorStop(0.6, "#1a1c1f"); g.addColorStop(1, "#050506");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // vertical grid following the frequency axis
  if (st) {
    const v = viewNow();
    const s = niceStep(v.span);
    ctx.strokeStyle = "rgba(255,255,255,.10)";
    for (let f = Math.ceil((v.c - v.span / 2) / s) * s; f <= v.c + v.span / 2; f += s) {
      const x = Math.round(freqToX(f, w)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }
  if (!spec || !st) return;
  const stepDb = st.wf.db_step;
  // The spectrum has its own fixed scale (55 dB), the waterfall colour range does not change it.
  const lo = colorRange()[0] - 3 / stepDb;
  const top = lo + 55 / stepDb;
  const y = (v) => h - ((v - lo) / (top - lo)) * h;
  ctx.font = "10px ui-monospace, Consolas, monospace";
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.fillStyle = "rgba(225,225,225,.55)";
  const dbLo = st.wf.db_min + lo * stepDb, dbHi = st.wf.db_min + top * stepDb;
  for (let db = Math.ceil(dbLo / 10) * 10; db < dbHi; db += 10) {
    const yy = Math.round(y((db - st.wf.db_min) / stepDb)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
    ctx.fillText(`${db} dB`, 6, yy - 3);
  }
  const n = spec.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const xx = (i / (n - 1)) * w, yy = y(spec[i]);
    if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
  }
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, "rgba(255,255,255,.35)"); fill.addColorStop(1, "rgba(255,255,255,.03)");
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.3;
  ctx.shadowColor = "rgba(255,255,255,.55)";
  ctx.shadowBlur = 4;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

let passLabelBox = null;   // passband label in the spectrum (layout px); hover opens the audio spectrum
function viewNow() { return view || { c: st.center_hz, span: st.sample_rate }; }
function freqToX(f, w) { const v = viewNow(); return ((f - v.c) / v.span + 0.5) * w; }
function xToFreq(x, w) { const v = viewNow(); return v.c + (x / w - 0.5) * v.span; }

function drawOverlays() {
  if (!st) return;
  const [a, b] = passband();
  const bw = st.bandwidth[st.mode];
  for (const id of ["specOverlay", "wfOverlay"]) {
    const [ctx, w, h] = fitCanvas($(id));
    ctx.clearRect(0, 0, w, h);
    let x0 = freqToX(a, w), x1 = freqToX(b, w);
    const xt = Math.round(freqToX(st.tune_hz, w)) + 0.5;
    // The passband must be visible even at a small zoom: at least 6 px.
    if (x1 - x0 < 6) { const m = (x0 + x1) / 2; x0 = m - 3; x1 = m + 3; }
    const spectrum = id === "specOverlay";
    ctx.fillStyle = spectrum ? "rgba(255,181,71,.16)" : "rgba(255,181,71,.10)";
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.strokeStyle = "rgba(255,181,71,.9)";
    ctx.lineWidth = 1;
    ctx.setLineDash(spectrum ? [] : [4, 4]);
    for (const x of [Math.round(x0) + 0.5, Math.round(x1) - 0.5]) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = "#ff5d5d";
    ctx.beginPath(); ctx.moveTo(xt, 0); ctx.lineTo(xt, h); ctx.stroke();
    if (spectrum) drawScanMarks(ctx, w, h);
    if (spectrum) {
      // Label above the passband: tuned frequency, then demodulator and bandwidth.
      const { txt: fTxt, unit } = freqDigits(st.tune_hz);
      const atu = atuNote();
      const lines = [`${fTxt.trim()} ${unit}`, `${st.mode} · ${fmtBw(bw)}${atu ? ` · ${atu}` : ""}`];
      ctx.font = "600 11px system-ui, sans-serif";
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
      const tx = Math.min(Math.max((x0 + x1) / 2 - tw / 2, 4), w - tw - 4);
      ctx.fillStyle = "rgba(10,13,18,.85)";
      ctx.strokeStyle = "rgba(255,181,71,.7)";
      ctx.beginPath(); ctx.roundRect(tx, 6, tw, 32, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#ffb547";
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      lines.forEach((l, i) => ctx.fillText(l, tx + tw / 2, 15 + i * 14));
      ctx.textAlign = "left";
      passLabelBox = { x0: tx, x1: tx + tw, y0: 6, y1: 38 };
      drawMemTags(ctx, w, [tx - 4, tx + tw + 4]);
    }
  }
  drawAxis();
}

/** SCAN in the spectrum: the range scanned (blue strip at the bottom edge) and the channels locked out (grey ✕). */
function drawScanMarks(ctx, w, h) {
  const sc = st && st.scan;
  if (!sc || !sc.on) return;
  ctx.save();
  if (sc.range) {
    const x0 = Math.max(0, freqToX(sc.range[0], w)), x1 = Math.min(w, freqToX(sc.range[1], w));
    if (x1 > x0) {
      ctx.fillStyle = "rgba(111,183,255,.10)";
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.fillStyle = "rgba(111,183,255,.75)";
      ctx.fillRect(x0, h - 3, x1 - x0, 3);
    }
  }
  ctx.strokeStyle = "rgba(170,180,192,.85)";
  ctx.lineWidth = 1.5;
  for (const f of sc.locked_f || []) {
    const x = freqToX(f, w);
    if (x < 0 || x > w) continue;
    ctx.beginPath(); ctx.moveTo(x - 4, h - 14); ctx.lineTo(x + 4, h - 6); ctx.moveTo(x + 4, h - 14); ctx.lineTo(x - 4, h - 6); ctx.stroke();
  }
  ctx.restore();
}

// Memories in the spectrum: at the top edge (under the band name strip) a ▲ mark on the memory frequency
// and a name tag under it. Tags are placed in rows so that they do not overlap (nor the bandwidth
// label); what does not fit gets only the mark. memTagBoxes is used for click / tooltip.
const MEM_TAG_ROWS = 3, MEM_TAG_H = 15, MEM_TAG_TOP = 7, MEM_TAG_GAP = 3, MEM_NAME_MAX = 22;
const MEM_COLOR = "#7ee0a8";
let memTagBoxes = [];
function drawMemTags(ctx, w, modeLabel) {
  memTagBoxes = [];
  if (!mems.length) return;
  const v = viewNow();
  const f0 = v.c - v.span / 2, f1 = v.c + v.span / 2;
  const list = mems.filter((m) => m.tag !== false && m.freq_hz >= f0 && m.freq_hz <= f1)
    .sort((a, b) => (b.fav - a.fav) || a.freq_hz - b.freq_hz);   // favourites get a place first
  if (!list.length) return;
  ctx.font = "600 10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const rowY = (r) => MEM_TAG_TOP + r * (MEM_TAG_H + MEM_TAG_GAP);
  // occupied intervals in each row; the bandwidth label (y 6–38) reaches into the first two
  const used = Array.from({ length: MEM_TAG_ROWS }, () => []);
  for (let r = 0; r < MEM_TAG_ROWS; r++) if (rowY(r) < 39) used[r].push(modeLabel);
  for (const m of list) {
    const x = Math.round(freqToX(m.freq_hz, w)) + 0.5;
    const name = m.name.length > MEM_NAME_MAX ? m.name.slice(0, MEM_NAME_MAX - 1) + "…" : m.name;
    const rec = m.record && m.record !== "off";   // a red ● before the name: recalling it starts a recording
    const tw = ctx.measureText(name).width + 10 + (rec ? 9 : 0);
    const bx = Math.min(Math.max(x - tw / 2, 2), w - tw - 2);
    let row = -1;
    for (let r = 0; r < MEM_TAG_ROWS && row < 0; r++) {
      if (used[r].every(([a, b]) => bx + tw + 2 < a || bx - 2 > b)) row = r;
    }
    const color = m.color || MEM_COLOR;
    // the ▲ mark at the top edge points at the frequency
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 4, 6); ctx.lineTo(x + 4, 6); ctx.closePath(); ctx.fill();
    if (row < 0) { memTagBoxes.push({ m, x0: x - 5, x1: x + 5, y0: 0, y1: 7 }); continue; }
    used[row].push([bx, bx + tw]);
    const y0 = rowY(row);
    ctx.strokeStyle = color + "8c";   // 55 % opacity
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, y0); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(8,12,14,.88)";
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.roundRect(bx, y0, tw, MEM_TAG_H, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    if (rec) {
      ctx.fillStyle = "#ff3b3b";
      ctx.beginPath(); ctx.arc(bx + 8, y0 + MEM_TAG_H / 2, 3, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = color;
    }
    ctx.fillText(name, bx + 5 + (rec ? 9 : 0), y0 + MEM_TAG_H / 2 + 0.5);
    memTagBoxes.push({ m, x0: bx, x1: bx + tw, y0: 0, y1: y0 + MEM_TAG_H });
  }
}
function memTagAt(x, y) {
  return memTagBoxes.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1)?.m || null;
}

function niceStep(span) {
  const raw = span / 8;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

// Bands on the frequency axis: local table BANDPLAN / BANDPLAN_STYLES in static/bandplan.js
// (sorted widest first, so narrower bands are drawn on top).
const AXIS_STRIP = 13; // px, strip with the band name at the bottom edge of the axis

function drawAxis() {
  const [ctx, w, h] = fitCanvas($("axis"));
  ctx.clearRect(0, 0, w, h);
  const v = viewNow();
  const f0 = v.c - v.span / 2, f1 = v.c + v.span / 2;
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [a, b, label, kind] of BANDPLAN) {
    if (b < f0 || a > f1) continue;
    const [bg, strip, ink] = BANDPLAN_STYLES[kind];
    const x0 = Math.max(0, freqToX(a, w)), x1 = Math.min(w, freqToX(b, w));
    ctx.fillStyle = bg;
    ctx.fillRect(x0, 0, x1 - x0, h - AXIS_STRIP);
    ctx.fillStyle = strip;
    ctx.fillRect(x0, h - AXIS_STRIP, x1 - x0, AXIS_STRIP);
    // Name in the middle of the visible part of the band, if it fits there.
    if (x1 - x0 > ctx.measureText(label).width + 8) {
      ctx.fillStyle = ink;
      ctx.fillText(label, (x0 + x1) / 2, h - AXIS_STRIP / 2 + 0.5);
    }
  }
  const s = niceStep(f1 - f0);
  ctx.font = "13px ui-monospace, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(255,255,255,.4)";
  ctx.fillStyle = "#d6d8dc";
  const decimals = s >= 1e5 ? 1 : s >= 1e4 ? 2 : s >= 1e3 ? 3 : 4;
  // The axis is above the spectrum: the ticks point down to the spectrum.
  for (let f = Math.ceil(f0 / s) * s; f <= f1; f += s) {
    const x = Math.round(freqToX(f, w)) + 0.5;
    const top = h - AXIS_STRIP;
    ctx.beginPath(); ctx.moveTo(x, top - 5); ctx.lineTo(x, top); ctx.stroke();
    if (x > 24 && x < w - 24) ctx.fillText(fmtMHz(f, decimals), x, top / 2);
  }
}

/** Bands of the band plan on a frequency, narrowest first. */
function bandsAt(f) {
  return BANDPLAN.filter(([a, b]) => f >= a && f <= b).reverse();
}

// Tooltip above the axis: description of all bands under the cursor (narrowest first).
$("axis").addEventListener("mousemove", (e) => {
  const cv = $("axis");
  const f = xToFreq(e.offsetX, cv.clientWidth);
  const hits = bandsAt(f);
  const tip = hits.map(([, , label, , desc]) => `${label}: ${desc}`).join("\n");
  if (cv.title !== tip) cv.title = tip;
});

// Filter width: the passband edge line in the spectrum can be grabbed and dragged. In SSB only the outer edge
// (the inner one is fixed 300 Hz from the carrier), in the other modes the passband changes symmetrically.
const BW_GRAB_PX = 5;
const BW_LIMITS = { WFM: [50000, 250000, 1000], FM: [500, 50000, 50], other: [100, 18000, 50] }; // min, max, rounding

/** Passband on the screen, at least 6 px wide as it is drawn. */
function passX(w) {
  const [a, b] = passband();
  let x0 = freqToX(a, w), x1 = freqToX(b, w);
  if (x1 - x0 < 6) { const m = (x0 + x1) / 2; x0 = m - 3; x1 = m + 3; }
  return [x0, x1];
}

function bwEdgeAt(x, w) {
  if (st.mode === "DSD") return null;      // fixed width
  const [x0, x1] = passX(w);
  const d0 = st.mode === "USB" ? Infinity : Math.abs(x - x0);
  const d1 = st.mode === "LSB" ? Infinity : Math.abs(x - x1);
  if (Math.min(d0, d1) > BW_GRAB_PX) return null;
  return d0 < d1 ? "lo" : "hi";
}

/** The pointer is on the passband in the spectrum or on its label (x, y from the overlay's corner, w its width). */
function inPassband(x, y, w) {
  const [x0, x1] = passX(w);
  return (x >= x0 && x <= x1) || inPassLabel({ x: x / uiScale, y: y / uiScale });
}

function bwFromX(x, w) {
  const f = xToFreq(x, w), t = st.tune_hz;
  const raw = st.mode === "USB" ? f - t : st.mode === "LSB" ? t - f : 2 * Math.abs(f - t);
  const [lo, hi, q] = BW_LIMITS[st.mode] || BW_LIMITS.other;
  return Math.min(hi, Math.max(lo, Math.round(raw / q) * q));
}

// Frequency under the mouse: after 1 s without movement (moves up to 2 px do not count) it is shown for 5 s.
const HOVER_DELAY_MS = 1000, HOVER_SHOW_MS = 5000;
let hover = null;
function hoverHide() {
  if (hover) { clearTimeout(hover.timer); hover = null; }
  $("hoverFreq").hidden = true;
}
function hoverMove(e, cv) {
  if (drag || !st || audioBubblePos) { hoverHide(); return; }
  if (hover && Math.abs(e.clientX - hover.x) <= 2 && Math.abs(e.clientY - hover.y) <= 2) return;
  hoverHide();
  hover = { x: e.clientX, y: e.clientY };
  hover.timer = setTimeout(() => {
    const r = cv.getBoundingClientRect(), box = $("hoverFreq"), scope = box.parentElement.getBoundingClientRect();
    const f = xToFreq(hover.x - r.left, r.width);
    box.textContent = f >= 30e6 ? `${fmtMHz(f, 4)} MHz` : `${fmtKHz(f, 2)} kHz`;
    box.hidden = false;
    // next to the cursor; near the right edge to its left (window coordinates → layout px: / uiScale)
    const x = (hover.x - scope.left) / uiScale, y = (hover.y - scope.top) / uiScale;
    box.style.left = `${x + 14 + box.offsetWidth > scope.width / uiScale ? x - 14 - box.offsetWidth : x + 14}px`;
    box.style.top = `${Math.max(0, y - box.offsetHeight - 10)}px`;
    hover.timer = setTimeout(() => { box.hidden = true; }, HOVER_SHOW_MS);
  }, HOVER_DELAY_MS);
}

// Audio spectrum bubble: open while the mouse is over the passband label. It shows the audio of the active VFO
// before the volume and MUTE, from 0 Hz to the top of the audio band of the current mode. WFM audio ends at 15 kHz
// without the pilot, so WFM shows the MPX signal from the demodulator instead (to 20 kHz, with the 19 kHz pilot).
const AB_DB_MIN = -100, AB_DB_MAX = -10, AB_AXIS_H = 14, CW_PITCH_HZ = 700;   // CW_PITCH in sdr.py
let audioBubblePos = null, audioBubbleRaf = 0, audioBubbleBuf = null;
let mpxSpec = null, mpxBusy = false, mpxAt = 0, mpxFailed = false;   // last MPX spectrum from /api/mpx (smoothed)
const bubbleIsMpx = () => st.mode === "WFM" && !st.dab;
function pollMpx() {
  if (mpxBusy || Date.now() - mpxAt < 100) return;
  mpxBusy = true;
  mpxAt = Date.now();
  fetch(`${vbase}/api/mpx`).then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then((d) => {
    mpxFailed = false;
    if (!d.db.length) { mpxSpec = null; return; }
    const old = mpxSpec && mpxSpec.db.length === d.db.length ? mpxSpec.db : d.db;
    mpxSpec = { binHz: d.hz_per_bin, db: Float32Array.from(d.db, (v, i) => 0.6 * old[i] + 0.4 * v) };
  }).catch(() => { mpxFailed = true; mpxSpec = null; }).finally(() => { mpxBusy = false; });
}
function inPassLabel(p) {
  const b = passLabelBox;
  return !!b && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
}
// CW in the bubble: in CW mode the text decoded while the bubble is open is shown under the spectrum and erased when it
// closes. With the CW decoder on its text is used; otherwise the server runs a peek decoder while we renew it.
const CW_PEEK_RENEW_MS = 2000, CW_BUBBLE_MAX = 200;
let cwBubble = null;   // { text, peek: renewed at (ms) or 0 } while the bubble shows CW text
const cwPeekPost = (on) => fetch(vbase + "/api/cw", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "peek", on }) }).catch(() => {});
function cwBubbleAdd(t) {
  if (!cwBubble) return;
  cwBubble.text = (cwBubble.text + t).slice(-CW_BUBBLE_MAX);
  $("audioBubbleCw").textContent = cwBubble.text;
}
function cwBubbleStop() {
  if (!cwBubble) return;
  if (cwBubble.peek) cwPeekPost(false);
  cwBubble = null;
  const el = $("audioBubbleCw");
  el.textContent = "";
  el.hidden = true;
}
/** Each frame of the bubble: CW text on in CW mode (peek decoder renewed when the CW decoder is off), off otherwise. */
function cwBubbleTick() {
  if (st.mode !== "CW") { cwBubbleStop(); return; }
  if (!cwBubble) { cwBubble = { text: "", peek: 0 }; $("audioBubbleCw").hidden = false; }
  if (st.cw) {
    if (cwBubble.peek) { cwPeekPost(false); cwBubble.peek = 0; }
  } else if (Date.now() - cwBubble.peek >= CW_PEEK_RENEW_MS) {
    cwBubble.peek = Date.now();
    cwPeekPost(true);
  }
}
function audioBubbleHide() {
  audioBubblePos = null;
  mpxSpec = null;
  cwBubbleStop();
  cancelAnimationFrame(audioBubbleRaf);
  $("audioBubble").hidden = true;
}
function audioBubbleMove(e, cv) {
  const r = cv.getBoundingClientRect();
  const p = { x: (e.clientX - r.left) / uiScale, y: (e.clientY - r.top) / uiScale };
  if (drag || !st || !inPassLabel(p)) { audioBubbleHide(); return; }
  const opening = !audioBubblePos;
  audioBubblePos = p;
  if (opening) { $("audioBubble").hidden = false; audioBubbleRaf = requestAnimationFrame(drawAudioBubble); }
}
function audioBubbleTop() {
  if (bubbleIsMpx()) return 20000;
  const nyq = actx ? actx.sampleRate / 2 : 24000;
  if (st.dab) return Math.min(16000, nyq);
  const bw = st.bandwidth[st.mode] || 3000;
  const top = st.mode === "CW" ? CW_PITCH_HZ + bw / 2 : bw;
  return Math.min(top, (st.audio_rate || 48000) / 2, nyq);
}
/** LPF / HPF in the audio spectrum bubble: what they cut off is darkened, with a line at the cutoff. */
function drawPassMarks(ctx, w, ph, top) {
  ctx.fillStyle = "rgba(0,0,0,.5)";
  ctx.strokeStyle = "#ffd84a";
  const mark = (hz, x0, x1) => {
    ctx.fillRect(x0, 0, x1 - x0, ph);
    const x = Math.round(hz / top * w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke();
  };
  if (st.hpf && passHz("hpf") < top) mark(passHz("hpf"), 0, passHz("hpf") / top * w);
  if (st.lpf && passHz("lpf") < top) mark(passHz("lpf"), passHz("lpf") / top * w, w);
}
function drawAudioBubble() {
  if (!audioBubblePos) return;
  // the label can move away from under a still mouse (wheel tuning) or a tab can cover it
  if (drag || !inPassLabel(audioBubblePos) || bodyTab !== "scope") { audioBubbleHide(); return; }
  cwBubbleTick();
  const box = $("audioBubble"), wrap = $("specOverlay").parentElement, lb = passLabelBox;
  const sw = box.parentElement.clientWidth, bw = box.offsetWidth;
  box.style.left = `${Math.max(2, Math.min((lb.x0 + lb.x1) / 2 - bw / 2, sw - bw - 2))}px`;
  box.style.top = `${wrap.offsetTop + lb.y1 + 4}px`;

  const [ctx, w, h] = fitCanvas($("audioBubbleCanvas"));
  const ph = h - AB_AXIS_H, top = audioBubbleTop();
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) { const x = Math.round(w * i / 4) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, ph); }
  ctx.stroke();
  ctx.font = "600 10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffb547";
  const labels = [["left", 1, "0"], ["center", w / 2, fmtBw(Math.round(top / 2))], ["right", w - 1, fmtBw(Math.round(top))]];
  for (const [align, x, txt] of labels) { ctx.textAlign = align; ctx.fillText(txt, x, ph + AB_AXIS_H / 2); }

  // the curve data: MPX from the server, or the audio from the analyser
  let buf = null, binHz = 0;
  if (bubbleIsMpx()) {
    pollMpx();
    if (mpxSpec) ({ db: buf, binHz } = mpxSpec);
  } else if (audioAnalyser && actx.state === "running") {
    const bins = audioAnalyser.frequencyBinCount;
    if (!audioBubbleBuf || audioBubbleBuf.length !== bins) audioBubbleBuf = new Float32Array(bins);
    buf = audioBubbleBuf;
    binHz = actx.sampleRate / audioAnalyser.fftSize;
    audioAnalyser.getFloatFrequencyData(buf);
  }
  const note = bubbleIsMpx() ? (mpxFailed ? "no MPX data from the server" : "") : buf ? "" : "click to start audio";
  if (note) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#8b95a3";
    ctx.fillText(note, w / 2, ph / 2);
  } else if (buf) {
    const n = buf.length, step = top / w / binHz;
    ctx.beginPath();
    ctx.moveTo(0, ph);
    for (let x = 0; x < w; x++) {
      const fb = x * step, i0 = Math.min(Math.floor(fb), n - 1);
      let v;
      if (step <= 1) v = buf[i0] + (buf[Math.min(i0 + 1, n - 1)] - buf[i0]) * (fb - i0);   // fewer bins than pixels
      else { v = -Infinity; for (let i = i0; i < fb + step && i < n; i++) v = Math.max(v, buf[i]); }
      const k = Number.isFinite(v) ? Math.min(1, Math.max(0, (v - AB_DB_MIN) / (AB_DB_MAX - AB_DB_MIN))) : 0;
      ctx.lineTo(x, ph * (1 - k));
    }
    ctx.lineTo(w, ph);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,181,71,.3)";
    ctx.fill();
    ctx.strokeStyle = "#ffb547";
    ctx.stroke();
  }
  if (!note && !bubbleIsMpx() && !st.dab) drawPassMarks(ctx, w, ph, top);   // WFM shows MPX, not the audio
  audioBubbleRaf = requestAnimationFrame(drawAudioBubble);
}

for (const id of ["specOverlay", "wfOverlay"]) {
  const cv = $(id);
  const spectrum = id === "specOverlay";
  // A click without movement tunes the point under the mouse. Dragging moves the whole waterfall: the passband stays in
  // place on the screen and the frequency changes under it. Dragging from the passband in the spectrum is the opposite:
  // the shown section stays in place and only the passband moves, up to the edge of the section.
  cv.addEventListener("pointerdown", (e) => {
    if (!st || e.button !== 0) return;
    cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect();
    if (spectrum && bwEdgeAt(e.clientX - r.left, r.width)) {
      drag = { bw: true, moved: true };
      return;
    }
    const v = viewNow();
    const band = spectrum && inPassband(e.clientX - r.left, e.clientY - r.top, r.width);
    drag = { x0: e.clientX, tune0: st.tune_hz, off: v.c - st.tune_hz, moved: false, band };
  });
  cv.addEventListener("pointermove", (e) => {
    const r = cv.getBoundingClientRect();
    if (spectrum && !drag && st) {
      const m = memTagAt((e.clientX - r.left) / uiScale, (e.clientY - r.top) / uiScale);
      const onBand = inPassband(e.clientX - r.left, e.clientY - r.top, r.width);
      cv.style.cursor = bwEdgeAt(e.clientX - r.left, r.width) ? "ew-resize" : m ? "pointer" : onBand ? "grab" : "";
      const tip = m ? `${m.name} · ${m.freq_hz >= 30e6 ? `${fmtMHz(m.freq_hz, 4)} MHz` : `${fmtKHz(m.freq_hz, 2)} kHz`} · ${m.mode} · ${memGroupsOf(m).join(", ")}${m.note ? ` · ${m.note}` : ""}` : "";
      if (cv.title !== tip) cv.title = tip;
    }
    if (!drag || !cv.hasPointerCapture(e.pointerId)) return;
    if (drag.bw) {
      const bw = bwFromX(e.clientX - r.left, r.width);
      if (bw === st.bandwidth[st.mode]) return;
      st.bandwidth[st.mode] = bw;
      renderControls();
      drawOverlays();
      send({ bandwidth: bw });
      return;
    }
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      cv.parentElement.classList.add("dragging");
      if (drag.band) cv.style.cursor = "grabbing";
    }
    const v = viewNow();
    let t = drag.tune0 + (drag.band ? dx : -dx) / r.width * v.span;
    t = Math.max(0, Math.round(t / stepHz) * stepHz);
    if (drag.band) {
      t = Math.max(t, Math.ceil((v.c - v.span / 2) / stepHz) * stepHz);
      t = Math.min(t, Math.floor((v.c + v.span / 2) / stepHz) * stepHz);
    }
    if (t === st.tune_hz) return;
    st.tune_hz = t;
    viewLocalAt = Date.now();
    if (drag.band) drawOverlays();
    else if (view) setView(t + drag.off);
    renderTuner();
    send({ tune_hz: t, view_hz: drag.band ? v.c : t + drag.off });
  });
  const end = (e) => {
    if (!drag) return;
    if (!drag.moved && e.type === "pointerup") {
      const r = cv.getBoundingClientRect();
      const m = spectrum ? memTagAt((e.clientX - r.left) / uiScale, (e.clientY - r.top) / uiScale) : null;
      if (m) recallMem(m);   // a click on a memory tag recalls it (frequency, mode, width)
      else if (st.autotune && ATU_MODES.includes(st.mode)) autotuneAt(xToFreq(e.clientX - r.left, r.width));
      else tune(xToFreq(e.clientX - r.left, r.width), true);
    }
    if (drag.moved && !drag.bw) { viewLocalAt = Date.now(); atuSoon(drag.tune0); }
    if (drag.band && drag.moved) cv.style.cursor = "grab";
    drag = null;
    if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
    cv.parentElement.classList.remove("dragging");
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  if (spectrum) {
    cv.addEventListener("pointermove", (e) => audioBubbleMove(e, cv));
    cv.addEventListener("pointerleave", audioBubbleHide);
    cv.addEventListener("pointerdown", audioBubbleHide);
  }
  cv.addEventListener("pointermove", (e) => hoverMove(e, cv));
  cv.addEventListener("pointerleave", hoverHide);
  cv.addEventListener("pointerdown", hoverHide);
  // wheel tuning: hide the tooltip and do not show it until the mouse moves again
  cv.addEventListener("wheel", (e) => { hoverHide(); hover = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const dir = wheelStep(e);
    if (dir) { const prev = st.tune_hz; tune(st.tune_hz + dir * stepHz, true); atuSoon(prev); }
  }, { passive: false });
}
window.addEventListener("resize", () => {
  resizeWaterfall();
  drawSpectrum();
  drawOverlays();
});
// Height of the fixed top part (changes with the window width and wrapping of the buttons): the bottom part with
// the spectrum and waterfall gets the rest of the window.
new ResizeObserver(([e]) => {
  const h = e.target.offsetHeight;   // layout px (getBoundingClientRect would already be scaled)
  if (document.documentElement.style.getPropertyValue("--head-h") === `${h}px`) return;
  document.documentElement.style.setProperty("--head-h", `${h}px`);
  window.dispatchEvent(new Event("resize"));
}).observe($("radioHead"));

/** Window height change: new number of rows, the existing image is kept (newest rows at the top). */
function resizeWaterfall() {
  if (document.documentElement.classList.contains("body-off")) return;   // hidden lower part: keep the image, resized when shown
  const rows = wfRowsWanted();
  if (rows === WF_ROWS || !wfRow) { WF_ROWS = rows; return; }
  const w = wfCanvas.width;
  const old = wfCtx.getImageData(0, 0, w, Math.min(rows, WF_ROWS));
  WF_ROWS = rows;
  wfCanvas.height = rows;
  wfCtx.fillStyle = wfBg();
  wfCtx.fillRect(0, 0, w, rows);
  wfCtx.putImageData(old, 0, 0);
}

// ---------- nastavenia ----------

const DEVICE_NAMES = { lime: "LimeSDR", airspy: "Airspy" };
/** VDL2, DAB and ISM need the sample rates and raw samples of an RTL dongle. */
const noRtlDongle = (s) => (s.driver || "rtl") !== "rtl";
/** The Airspy gain is a preset 0–21, not dB. */
const gainLabel = (s) => (s.driver === "airspy" ? `${Number(s.gain)} / 21` : `${Number(s.gain).toFixed(1)} dB`);

function renderGain() {
  const auto = st.gain === "auto", smart = !!st.smart_agc && !auto;
  $("gainAuto").checked = auto;
  $("agcKey").classList.toggle("on", auto);
  $("agcPlusKey").classList.toggle("on", smart);
  $("agcPlusKey").classList.toggle("clip", smart && !!st.adc_clip);
  // The browser hides a tooltip whose text changes (several times a second here): under the mouse it keeps
  // the values from the moment the mouse came, and they are refreshed when it comes again.
  const plusTip = "AGC+: tuner gain as high as possible without clipping the A/D converter (the R820T tuner AGC does not watch the A/D)" +
    (smart ? `\nnow ${gainLabel(st)}, A/D peak ${st.adc_peak} dBFS${st.adc_clip ? `, clipping ${st.adc_clip_ppm} ppm` : ""}` : "");
  if (!$("agcPlusKey").matches(":hover")) $("agcPlusKey").title = plusTip;
  $("rtlAgc").checked = !!st.rtl_agc;
  $("rtlAgc").disabled = smart;
  $("gainSlider").disabled = auto || smart;
  $("gainSlider").max = Math.max(st.gains.length - 1, 0);
  if (!auto) {
    let best = 0;
    st.gains.forEach((g, i) => { if (Math.abs(g - st.gain) < Math.abs(st.gains[best] - st.gain)) best = i; });
    $("gainSlider").value = best;
  }
  $("gainText").textContent = auto ? "auto" : smart ? `AGC+ ${gainLabel(st)}` : gainLabel(st);
  renderSagc();
  renderVfoDisplays();
}

const spurShiftText = (hz) => `${hz > 0 ? "+" : ""}${hz} Hz`;

/** LEARN changes this on the server at any time, so it is drawn with every status. */
function renderSpurInfo() {
  $("spurKey").classList.toggle("on", !!st.spur_on);
  $("spurKey").classList.toggle("learning", !!st.spur_on && !!st.spur_learning);   // SP key: blinks red while learning
  $("spurOn").checked = !!st.spur_on;
  $("spurHz").disabled = $("spurEdge").disabled = $("spurShift").disabled = $("spurDb").disabled = !st.spur_on;
  $("spurLearn").disabled = !!st.spur_learning;
  $("spurClear").disabled = !st.spur_count;
  $("spurInfo").textContent = st.spur_learning ? "learning…"
    : st.spur_found === 0 ? `none found · ${st.spur_count} stored` : `${st.spur_count} lines stored`;
}

function renderSettings() {
  loadDongleList();   // the VFO changed: other dongle highlighted
  renderGain();
  $("sampleRate").innerHTML = st.sample_rates.map((r) =>
    `<option value="${r}">${(r / 1e6).toLocaleString(LOCALE)} MHz</option>`).join("");
  $("sampleRate").value = String(st.sample_rate);
  $("ppm").value = st.ppm;
  $("dcRemove").checked = st.dc_remove !== false;
  $("dcHz").value = st.dc_hz || 0;
  $("dcHz").disabled = $("dcDb").disabled = st.dc_remove === false;
  $("spurHz").value = st.spur_hz;
  $("spurDb").value = st.spur_db;
  $("spurEdge").value = st.spur_edge;
  $("spurShift").value = st.spur_shift;
  $("spurShiftText").textContent = spurShiftText(st.spur_shift);
  $("spurHzText").textContent = `${st.spur_hz} Hz`;
  $("spurEdgeText").textContent = `${st.spur_edge} Hz`;
  $("spurDbText").textContent = `${st.spur_db} dB`;
  renderSpurInfo();
  $("dcDb").value = st.dc_db ?? 60;
  $("dcDbText").textContent = `${st.dc_db ?? 60} dB`;
  $("dcHzText").textContent = st.dc_hz ? `${st.dc_hz} Hz` : "peak only";
  $("lo").value = st.lo_offset_hz / 1e6;
  $("upconv").value = st.upconv;
  // The VFO has a fixed dongle (by serial number) and upconverter wiring: the dongle selection is hidden.
  $("deviceSetting").hidden = !!st.vfo;
  $("upconvSetting").hidden = !!st.vfo;
  $("vfoSetting").hidden = !st.vfo;
  if (st.vfo) {
    const dongle = `${DEVICE_NAMES[st.driver] || "dongle"} ${st.serial}`;
    $("vfoSettingText").textContent = (st.chain_owner
      ? `VFO ${st.vfo} · chained to the ${dongle} of VFO ${st.chain_owner}: tunes inside its band; ` +
        `gain, ppm and sample rate are shared with VFO ${st.chain_owner}`
      : `VFO ${st.vfo} · ${dongle}` + (st.chained_vfos ? ` · also serves ${st.chained_vfos} chained VFO(s)` : "")) +
      (active && active.note ? ` · ${active.note}` : "");
  } else {
    loadDevices();
  }
  // LimeSDR has no bias-tee; only the RTL dongle has the RTL2832 digital AGC.
  $("rtlAgcBox").hidden = st.has_rtl_agc === false;
  $("biasTeeSetting").hidden = st.has_bias_tee === false;
  $("biasTee").checked = st.bias_tee;
  // The block diagram and its numbers describe an RTL dongle (R820T tuner + RTL2832); LimeSDR and Airspy hide them.
  const rtl = !noRtlDongle(st);
  $("blkDiagram").hidden = !rtl;
  $("dongleBasic").classList.toggle("no-blk", !rtl);
  $("dongleAdv").classList.toggle("no-blk", !rtl);
  syncBlkDiagram();
  $("txSetting").hidden = !st.tx_capable;
  $("setTabTx").hidden = !st.tx_capable;
  if (!st.tx_capable && $("setTabTx").classList.contains("on")) showSetSub("vfo:dongle");
  $("txEnabled").checked = !!st.tx_enabled;
  renderSquelch();
  renderWfLabels();
}

const SQUELCH_OFF = -120;

// Squelch has its own level for AM, FM and WFM; the slider in SET sets the one for the current mode.
function squelchLevel() {
  if (st.auto_sql_on && st.squelch_levels && st.mode in st.squelch_levels) return st.auto_sql_level ?? SQUELCH_OFF;
  const v = st.squelch_levels ? st.squelch_levels[st.mode] : undefined;
  return v === undefined ? SQUELCH_OFF : v;
}

function renderSquelch() {
  const ok = st.squelch_levels && st.mode in st.squelch_levels;
  // the squelch level is set by the SQL bar of the VFO window; SETTINGS has only the ASQ margin
  if (st.auto_sql_db != null && document.activeElement !== $("asqDb")) $("asqDb").value = st.auto_sql_db;
  placeSqlMark();
}

/** Yellow squelch level mark on the S-meter scale. */
function placeSqlMark() {
  const mark = $("smeter").querySelector(".sql-mark");
  if (!mark || !st) return;
  const v = squelchLevel();
  mark.style.display = v > SQUELCH_OFF ? "" : "none";
  if (v <= SQUELCH_OFF) return;
  const p = meterPos(v);
  const [x0, y0, x1, y1] = METER_STYLES[meterStyle].sql(p);
  mark.setAttribute("x1", x0); mark.setAttribute("y1", y0);
  mark.setAttribute("x2", x1); mark.setAttribute("y2", y1);
}

// WFM: flags ST (stereo pilot) and RDS (synchronised blocks), PS and RadioText under the frequency.
function renderRds() {
  const wfm = st.mode === "WFM";
  const r = wfm ? st.rds : null;
  $("stereoKey").disabled = !wfm;
  $("stereoKey").classList.toggle("on", wfm && st.stereo_on !== false);
  const notchMode = ["AM", "LSB", "USB"].includes(st.mode);
  $("notchKey").disabled = !notchMode;
  $("notchKey").classList.toggle("on", notchMode && !!st.notch);
  const alcMode = ["AM", "LSB", "USB", "CW"].includes(st.mode);
  $("alcKey").disabled = !alcMode;
  $("alcKey").classList.toggle("on", alcMode && st.audio_agc !== false);
  const afiMode = st.mode !== "WFM" && st.mode !== "DSD";
  const atuMode = ATU_MODES.includes(st.mode);
  $("atuKey").disabled = !atuMode;
  $("atuKey").classList.toggle("on", atuMode && !!st.autotune);
  $("atuKey").classList.toggle("busy", atuMode && !!st.autotune && st.autotune_info?.state === "listen");
  $("afiKey").disabled = !afiMode;
  $("afiKey").classList.toggle("on", afiMode && !!st.afi);
  $("afiKey").title = `AFI: audio frequency inversion around ${st.afi_hz ?? 1750} Hz – voice inversion scrambler / descrambler (all modes except WFM); frequency in SETTINGS`;
  if (st.afi_hz != null && document.activeElement !== $("afiHz")) $("afiHz").value = st.afi_hz;
  const asqMode = ["AM", "FM", "WFM"].includes(st.mode);
  $("asqKey").disabled = !asqMode;
  $("asqKey").classList.toggle("on", asqMode && !!st.auto_sql_on);
  $("asqKey").title = (asqMode && st.auto_sql_on && !st.auto_sql ? "ASQ: on by AGC+ with the squelch set. " : "")
    + "ASQ: auto squelch in AM/FM/WFM – the level follows the noise floor (margin in SETTINGS › VFO › AUDIO). Also on by itself with AGC+ and the squelch set";
  renderTsqKeys();
  renderPassKeys();
  // The RDS frame is always in place (the waterfall does not move); without RDS it is empty and dark.
  const has = !!r && (r.ps || r.rt || r.pi);
  $("rds").classList.toggle("off", !has);
  renderAd();
  $("rdsPs").textContent = has ? r.ps || "········" : " ";
  $("rdsMeta").textContent = has ? [r.pi && `PI ${r.pi}`, r.pty, r.tp && (r.ta ? "TP TA" : "TP")].filter(Boolean).join(" · ") : "";
  $("rdsRt").textContent = has ? r.rt : "";
  $("rds").title = has ? [r.rt, r.ct && `Clock: ${r.ct}`].filter(Boolean).join("\n") : "RDS";
}

// ---------- AD = additional display under the S-meter: one thing at a time, by priority ----------
// 1. error messages (red, the frame blinks, OK accepts them), 2. rotor AZ / EL (MONITOR in SETTINGS › GENERAL › ROTOR),
// 3. DAB now on air (station, SNR, DLS text), 4. RDS.
const adErrors = [];       // messages not accepted yet, oldest first
let adRotInfo = null;      // the last rotor state of the active VFO while its MONITOR is on
let adDabInfo = null;      // the DAB station playing: { label, type, dls, snr } (pollDab), null = none

/** An error message to the AD; it stays until OK. The same text already waiting is not added again. */
function adError(msg) {
  msg = String(msg || "Error");
  if (!adErrors.includes(msg)) adErrors.push(msg);
  renderAd();
}

function renderAd() {
  const err = adErrors.length > 0, rot = !err && rotorMonOn() && !!adRotInfo;
  $("mfd").classList.toggle("alarm", err);
  $("adErr").hidden = !err;
  if (err) {
    $("adErrText").textContent = adErrors[0];
    $("adErrText").title = adErrors[0];
    $("adErrMore").textContent = adErrors.length > 1 ? `+${adErrors.length - 1}` : "";
    $("adErrMore").title = adErrors.length > 1 ? `${adErrors.length - 1} more message(s) after OK` : "";
  }
  $("adRot").hidden = !rot;
  if (rot) {
    const i = adRotInfo, ok = i.on && i.connected;
    const deg = (v) => (ok && v != null ? `${Math.round(v)}°` : "–");
    $("adRotAz").textContent = deg(i.azShow);
    $("adRotEl").textContent = deg(i.elShow);
    const bad = !i.on || !i.connected || !!i.fault;
    // the requested direction only while the rotor is on its way; once there it goes out
    $("adRotTgt").textContent = !i.on ? "LINK OFF" : !i.connected ? "NOT CONNECTED" : i.fault ? "FAULT"
      : rotorMoving(i) ? `→ ${Math.round(i.target[0])}° / ${Math.round(i.target[1])}°` : "";
    $("adRotTgt").classList.toggle("bad", bad);
  }
  const dab = !err && !rot && !!adDabInfo;
  $("adDab").hidden = !dab;
  if (dab) {
    const d = adDabInfo, snr = d.snr == null ? null : Number(d.snr);
    $("adDabTag").textContent = d.type || "DAB";
    $("adDabPs").textContent = d.label;
    $("adDabSnr").textContent = snr == null ? "" : `SNR ${snr.toFixed(1)} dB`;
    $("adDabSnr").style.setProperty("--q", dabQuality(snr)[1]);
    const box = $("adDabDls"), text = $("adDabDlsText");
    if (text.textContent !== d.dls) text.textContent = d.dls;
    box.title = d.dls;
    // running text only when it does not fit; set again only on another text or width (the animation is not restarted)
    const over = Math.max(0, text.offsetWidth - box.clientWidth);
    if (box._over !== over) {
      box._over = over;
      box.classList.toggle("run", over > 0);
      box.style.setProperty("--shift", `${-over}px`);
      box.style.setProperty("--t", `${(4 + over / 25).toFixed(1)}s`);
    }
  }
  $("rds").hidden = err || rot || dab;
}

$("adErrOk").addEventListener("click", () => { adErrors.shift(); renderAd(); });

// Squelch changed: the slider in SET and the SQL indicator in the VFO window.
function renderSqlBadge() {
  renderSquelch();
  renderVfoDisplays();
}

function renderWfLabels() {
  $("wfRangeText").textContent = `${$("wfRange").value} dB`;
  const s = Number($("wfShift").value);
  $("wfShiftText").textContent = `${s > 0 ? "+" : ""}${s} dB`;
}

function setAgc(on) {
  st.gain = on ? "auto" : st.gains[Number($("gainSlider").value)] ?? 0;
  st.smart_agc = false;                  // the server ends AGC+ on any gain it gets
  renderGain();
  send({ gain: st.gain });
}
$("gainAuto").addEventListener("change", () => setAgc($("gainAuto").checked));
$("agcKey").addEventListener("click", () => { if (st) setAgc(st.gain !== "auto" || st.smart_agc); });
// AGC+ settings in SET: one slider per parameter, sent shortly after moving (as one "sagc" object)
const SAGC_UI = [
  ["clip_ppm", "Clipping above", 0, 1000, 5, "ppm"],
  ["down_db", "Down by", 0.5, 10, 0.5, "dB"],
  ["heavy_ppm", "Heavy clipping above", 50, 10000, 50, "ppm"],
  ["heavy_db", "Heavy: down by", 1, 20, 0.5, "dB"],
  ["low_dbfs", "Up below", -30, -2, 1, "dBFS"],
  ["target_dbfs", "Target", -25, -1, 1, "dBFS"],
  ["hold_s", "Hold before up", 0.2, 10, 0.1, "s"],
  ["up_db", "Up at most", 0.5, 15, 0.5, "dB"],
  ["settle", "Settle", 0, 10, 1, "blocks"],
  ["allow_ppm", "Bold: up while clipping ≤", 0, 200, 1, "ppm"],
];
// AGC+ presets, careful to bold. MODERATE = the defaults of the server (SAGC_PARAMS in sdr.py)
const SAGC_PRESETS = {
  careful: { clip_ppm: 20, heavy_ppm: 1000, down_db: 3, heavy_db: 6, low_dbfs: -8, target_dbfs: -5,
    hold_s: 0.2, up_db: 6, settle: 2, allow_ppm: 0 },
  moderate: { clip_ppm: 100, heavy_ppm: 2000, down_db: 2.5, heavy_db: 6, low_dbfs: -5, target_dbfs: -2,
    hold_s: 0.5, up_db: 6, settle: 2, allow_ppm: 0 },
  bold: { clip_ppm: 300, heavy_ppm: 5000, down_db: 2, heavy_db: 4, low_dbfs: -6, target_dbfs: -2,
    hold_s: 1, up_db: 6, settle: 2, allow_ppm: 20 },
};
$("sagcRows").innerHTML = SAGC_UI.map(([k, label, min, max, step]) =>
  `<div><div class="row"><span>${label}</span><span id="sagc_${k}_t" class="value"></span></div>` +
  `<input id="sagc_${k}" type="range" min="${min}" max="${max}" step="${step}"></div>`).join("");
let sagcTimer = null, sagcLocalAt = 0;
function renderSagc() {
  const p = st.sagc || {};
  for (const [k, , , , , unit] of SAGC_UI) {
    const el = $(`sagc_${k}`);
    if (p[k] == null) continue;
    if (document.activeElement !== el && Date.now() - sagcLocalAt > 1500) el.value = p[k];
    $(`sagc_${k}_t`).textContent = `${el.value} ${unit}`;
  }
  const smart = st.smart_agc && st.gain !== "auto";
  $("sagcNow").textContent = smart ? `${gainLabel(st)} · A/D ${st.adc_peak} dBFS${st.adc_clip ? ` · clip ${st.adc_clip_ppm} ppm` : ""}` : "off";
  for (const b of document.querySelectorAll("#sagcPresets [data-preset]")) {
    const pre = SAGC_PRESETS[b.dataset.preset];
    b.classList.toggle("on", Object.keys(pre).every((k) => Number(p[k]) === pre[k]));
  }
}
for (const [k, , , , , unit] of SAGC_UI) {
  $(`sagc_${k}`).addEventListener("input", (e) => {
    sagcLocalAt = Date.now();
    $(`sagc_${k}_t`).textContent = `${e.target.value} ${unit}`;
    st.sagc = { ...(st.sagc || {}), [k]: Number(e.target.value) };
    clearTimeout(sagcTimer);
    sagcTimer = setTimeout(() => send({ sagc: { [k]: Number(e.target.value) } }), 150);
  });
}
document.querySelectorAll("#sagcPresets [data-preset]").forEach((b) => b.addEventListener("click", () => {
  sagcLocalAt = 0;
  st.sagc = { ...SAGC_PRESETS[b.dataset.preset] };
  renderSagc();
  send({ sagc: SAGC_PRESETS[b.dataset.preset] });
}));

// AGC+: the server sets the tuner gain from the A/D level; off = the last gain stays as a manual one
$("agcPlusKey").addEventListener("click", () => {
  if (!st) return;
  st.smart_agc = !(st.smart_agc && st.gain !== "auto");
  if (st.smart_agc) st.rtl_agc = false;
  renderGain();
  send({ smart_agc: st.smart_agc });
});
$("stereoKey").addEventListener("click", () => {
  if (!st) return;
  st.stereo_on = st.stereo_on === false;
  renderRds();
  send({ stereo_on: st.stereo_on });
});
$("notchKey").addEventListener("click", () => {
  if (!st) return;
  st.notch = !st.notch;
  renderRds();
  send({ notch: st.notch });
});
$("alcKey").addEventListener("click", () => {
  if (!st) return;
  st.audio_agc = st.audio_agc === false;
  renderRds();
  send({ audio_agc: st.audio_agc });
});
$("atuKey").addEventListener("click", () => {
  if (!st) return;
  st.autotune = !st.autotune;
  renderRds();
  send({ autotune: st.autotune });
});
$("afiKey").addEventListener("click", () => {
  if (!st) return;
  st.afi = !st.afi;
  renderRds();
  renderVfoDisplays();
  send({ afi: st.afi });
});
$("asqKey").addEventListener("click", () => {
  if (!st) return;
  memRec.asq = false;   // by hand now: no longer switched off on leaving the recalled memory
  if (st.auto_sql_on && !st.auto_sql) {             // on by AGC+: off = squelch off
    st.squelch_levels = { ...st.squelch_levels, [st.mode]: SQUELCH_OFF };
    st.auto_sql_on = false;
    send({ squelch: SQUELCH_OFF, squelch_mode: st.mode });
  } else {
    st.auto_sql = !st.auto_sql;
    st.auto_sql_on = st.auto_sql;
    if (!st.auto_sql_on) st.auto_sql_level = null;
    send({ auto_sql: st.auto_sql });
  }
  renderRds();
  renderSqlBadge();
  renderVfoDisplays();
});
$("asqDb").addEventListener("change", () => {
  const v = Math.min(30, Math.max(2, Math.round(Number($("asqDb").value)) || 6));
  $("asqDb").value = v;
  send({ auto_sql_db: v });
});
// ---------- TSQ-C / TSQ-D: CTCSS / DCS tone squelch (FM), in addition to the SQL bar or ASQ ----------
const CTCSS_TONES = [67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9,
  114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3,
  179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1];
const DCS_CODES = ("023 025 026 031 032 036 043 047 051 053 054 065 071 072 073 074 114 115 116 122 125 131 132 134 " +
  "143 145 152 155 156 162 165 172 174 205 212 223 225 226 243 244 245 246 251 252 255 261 263 265 266 271 274 306 " +
  "311 315 325 331 332 343 346 351 356 364 365 371 411 412 413 423 431 432 445 446 452 454 455 462 464 465 466 503 " +
  "506 516 523 526 532 546 565 606 612 624 627 631 632 654 662 664 703 712 723 731 732 734 743 754").split(" ");
const ctcssHz = (s) => s.ctcss_hz ?? 88.5;
const dcsCode = (s) => s.dcs_code ?? "023N";
const ctcssText = (hz) => Number(hz).toFixed(1);
$("ctcssHz").innerHTML = CTCSS_TONES.map((t) => `<option value="${t}">${ctcssText(t)}</option>`).join("");
$("dcsCode").innerHTML = DCS_CODES.map((c) => `<option>${c}</option>`).join("");

function renderTsqKeys() {
  const fm = st.mode === "FM";
  const hz = ctcssHz(st), code = dcsCode(st);
  for (const [id, on, what] of [["tsqcKey", st.ctcss, `CTCSS ${ctcssText(hz)} Hz`], ["tsqdKey", st.dcs, `DCS ${code}`]]) {
    $(id).disabled = !fm;
    $(id).classList.toggle("on", fm && !!on);
    $(id).title = `${id === "tsqcKey" ? "TSQ-C" : "TSQ-D"}: ${what} tone squelch in FM, in addition to the SQL bar or ASQ` +
      `${fm && on ? (st.tone_match ? " – received now" : " – not received") : ""}. Click = on/off, mouse wheel = ` +
      `${id === "tsqcKey" ? "tone" : "code"} (also in SETTINGS › VFO › AUDIO)`;
  }
  if (document.activeElement !== $("ctcssHz")) $("ctcssHz").value = String(hz);
  if (document.activeElement !== $("dcsCode")) $("dcsCode").value = code.slice(0, 3);
  if (document.activeElement !== $("dcsPol")) $("dcsPol").value = code.slice(3);
}

/** Local change of the tone squelch (TSQ-C and TSQ-D are never on together), sent to the receiver. */
function setTsq(changes) {
  if (!st) return;
  if (changes.ctcss) changes.dcs = false;
  if (changes.dcs) changes.ctcss = false;
  Object.assign(st, changes);
  if ("ctcss" in changes || "dcs" in changes || "ctcss_hz" in changes || "dcs_code" in changes) st.tone_match = false;
  renderTsqKeys();
  renderVfoDisplays();
  send(changes);
}
$("tsqcKey").addEventListener("click", () => st && setTsq({ ctcss: !st.ctcss }));
$("tsqdKey").addEventListener("click", () => st && setTsq({ dcs: !st.dcs }));
$("tsqcKey").addEventListener("wheel", (e) => {
  e.preventDefault();
  const dir = wheelStep(e);
  if (!st || st.mode !== "FM" || !dir) return;
  const i = CTCSS_TONES.indexOf(ctcssHz(st));
  const j = Math.max(0, Math.min(CTCSS_TONES.length - 1, (i < 0 ? 8 : i) + dir));
  if (j !== i) setTsq({ ctcss_hz: CTCSS_TONES[j] });
}, { passive: false });
$("tsqdKey").addEventListener("wheel", (e) => {
  e.preventDefault();
  const dir = wheelStep(e);
  if (!st || st.mode !== "FM" || !dir) return;
  const code = dcsCode(st), i = DCS_CODES.indexOf(code.slice(0, 3));
  const j = Math.max(0, Math.min(DCS_CODES.length - 1, (i < 0 ? 0 : i) + dir));
  if (j !== i) setTsq({ dcs_code: DCS_CODES[j] + code.slice(3) });
}, { passive: false });
$("ctcssHz").addEventListener("change", () => setTsq({ ctcss_hz: Number($("ctcssHz").value) }));
for (const id of ["dcsCode", "dcsPol"]) {
  $(id).addEventListener("change", () => setTsq({ dcs_code: $("dcsCode").value + $("dcsPol").value }));
}

$("afiHz").addEventListener("change", () => {
  const v = Math.round(Number($("afiHz").value));
  if (!Number.isFinite(v)) return;
  const hz = Math.max(500, Math.min(4000, v));
  $("afiHz").value = hz;
  if (st) st.afi_hz = hz;
  send({ afi_hz: hz });
});

// LPF / HPF keys: click = on/off, mouse wheel over the key = cutoff; the same cutoffs can be typed in SET.
const PASS = {
  lpf: { min: 100, max: 15000, def: 3000, text: "LPF: audio low-pass, passes below" },
  hpf: { min: 20, max: 5000, def: 300, text: "HPF: audio high-pass, passes above" },
};
const PASS_GAP_HZ = 50;   // the smallest band left between HPF and LPF

const passHz = (kind) => st[kind + "_hz"] ?? PASS[kind].def;
const passText = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz % 100 && hz < 10000 ? 2 : 1)}k` : `${hz}`);

function renderPassKeys() {
  for (const kind of Object.keys(PASS)) {
    const hz = passHz(kind), key = $(kind + "Key"), input = $(kind + "Hz");
    key.disabled = !!st.dab;      // DAB audio comes from welle-cli, past the receiver's audio chain
    key.classList.toggle("on", !st.dab && !!st[kind]);
    key.title = `${PASS[kind].text} ${hz} Hz. Click = on/off, mouse wheel = frequency (also in SETTINGS)`;
    $(kind + "Val").textContent = passText(hz);
    if (document.activeElement !== input) input.value = hz;
  }
}

/** New cutoff. HPF stays below LPF even when one of them is off, so turning a key on can never silence the audio. */
function setPassHz(kind, value) {
  const { min, max } = PASS[kind];
  const hz = Math.max(min, Math.min(max, Math.round(value)));
  const other = kind === "lpf" ? "hpf" : "lpf";
  const changes = { [kind + "_hz"]: hz };
  const o = passHz(other);
  if (kind === "lpf" ? o > hz - PASS_GAP_HZ : o < hz + PASS_GAP_HZ) {
    changes[other + "_hz"] = kind === "lpf" ? hz - PASS_GAP_HZ : hz + PASS_GAP_HZ;
  }
  Object.assign(st, changes);
  renderPassKeys();
  send(changes);
}

/** The next wheel stop: 10 Hz under 100 Hz, 50 Hz under 1 kHz, then 100 Hz (a typed value snaps to the grid). */
function passWheelStep(hz, up) {
  const edge = up ? hz : hz - 1;
  const step = edge < 100 ? 10 : edge < 1000 ? 50 : 100;
  return up ? (Math.floor(hz / step) + 1) * step : (Math.ceil(hz / step) - 1) * step;
}

for (const kind of Object.keys(PASS)) {
  $(kind + "Key").addEventListener("click", () => {
    if (!st) return;
    st[kind] = !st[kind];
    renderPassKeys();
    send({ [kind]: st[kind] });
  });
  $(kind + "Key").addEventListener("wheel", (e) => {
    e.preventDefault();
    const dir = wheelStep(e);
    if (st && !st.dab && dir) setPassHz(kind, passWheelStep(passHz(kind), dir > 0));
  }, { passive: false });
  $(kind + "Hz").addEventListener("change", () => {
    const v = Number($(kind + "Hz").value);
    if (st && $(kind + "Hz").value !== "" && Number.isFinite(v)) setPassHz(kind, v);
    else if (st) renderPassKeys();
  });
}

$("dcRemove").addEventListener("change", () => {
  st.dc_remove = $("dcRemove").checked;
  $("dcHz").disabled = $("dcDb").disabled = !st.dc_remove;
  send({ dc_remove: st.dc_remove });
});
$("dcHz").addEventListener("input", () => {
  st.dc_hz = Number($("dcHz").value);
  $("dcHzText").textContent = st.dc_hz ? `${st.dc_hz} Hz` : "peak only";
  send({ dc_hz: st.dc_hz });
});
function setSpurOn(on) {
  st.spur_on = on;
  renderSpurInfo();
  send({ spur_on: on });
}
$("spurOn").addEventListener("change", () => setSpurOn($("spurOn").checked));
// SP key: off -> forget all stored lines, LEARN the band received now and switch the removal on (red blinking while
// learning, then steady yellow); on -> off. A click while learning is ignored. SET keeps CLEAR / LEARN / the switch.
$("spurKey").addEventListener("click", () => {
  if (!st || st.spur_learning) return;
  if (st.spur_on) { setSpurOn(false); return; }
  Object.assign(st, { spur_on: true, spur_learning: true, spur_count: 0, spur_found: null });
  renderSpurInfo();
  send({ spur_clear: true, spur_learn: true, spur_on: true });
});
$("spurHz").addEventListener("input", () => {
  st.spur_hz = Number($("spurHz").value);
  $("spurHzText").textContent = `${st.spur_hz} Hz`;
  send({ spur_hz: st.spur_hz });
});
$("spurEdge").addEventListener("input", () => {
  st.spur_edge = Number($("spurEdge").value);
  $("spurEdgeText").textContent = `${st.spur_edge} Hz`;
  send({ spur_edge: st.spur_edge });
});
$("spurShift").addEventListener("input", () => {
  st.spur_shift = Number($("spurShift").value);
  $("spurShiftText").textContent = spurShiftText(st.spur_shift);
  send({ spur_shift: st.spur_shift });
});
$("spurDb").addEventListener("input", () => {
  st.spur_db = Number($("spurDb").value);
  $("spurDbText").textContent = `${st.spur_db} dB`;
  send({ spur_db: st.spur_db });
});
$("spurLearn").addEventListener("click", () => {
  st.spur_learning = true;
  renderSpurInfo();
  send({ spur_learn: true });
});
$("spurClear").addEventListener("click", () => send({ spur_clear: true }));
$("dcDb").addEventListener("input", () => {
  st.dc_db = Number($("dcDb").value);
  $("dcDbText").textContent = `${st.dc_db} dB`;
  send({ dc_db: st.dc_db });
});
$("rtlAgc").addEventListener("change", () => {
  st.rtl_agc = $("rtlAgc").checked;
  send({ rtl_agc: st.rtl_agc });
});
$("gainSlider").addEventListener("input", () => {
  st.gain = st.gains[Number($("gainSlider").value)];
  renderGain();
  send({ gain: st.gain });
});
$("sampleRate").addEventListener("change", () => { floor = null; send({ sample_rate: Number($("sampleRate").value) }); });
$("ppm").addEventListener("change", () => send({ ppm: Number($("ppm").value) }));
$("lo").addEventListener("change", () => send({ lo_offset_hz: Number($("lo").value) * 1e6 }));
$("upconv").addEventListener("change", () => {
  st.upconv = $("upconv").value;
  renderTuner();
  send({ upconv: st.upconv });
});

async function loadDevices() {
  const sel = $("device");
  let list;
  try {
    list = await fetch(vbase + "/api/devices").then((r) => r.json());
  } catch (e) {
    list = { error: String(e) };
  }
  if (!Array.isArray(list)) {
    sel.innerHTML = `<option>${escHtml(list.error || "error")}</option>`;
    return;
  }
  const cur = st.device;
  const label = (d) => `#${d.index} · ${d.product || d.name || "RTL-SDR"}` +
    (d.serial ? ` · SN ${d.serial}` : "") + (d.index === cur ? " (active)" : "");
  // The active dongle must be in the list even if the list did not return it (e.g. unplugged).
  if (!list.some((d) => d.index === cur)) list.push({ index: cur, name: "not found" });
  sel.innerHTML = list.map((d) => `<option value="${d.index}">${escHtml(label(d))}</option>`).join("");
  sel.value = String(cur);
}
$("device").addEventListener("change", () => {
  floor = null;
  st.device = Number($("device").value);
  send({ device: st.device });
});
$("devRefresh").addEventListener("click", loadDevices);

// SETTINGS › SDR DONGLE › ADVANCED: the dongles, the VFOs they serve, the one being set highlighted.
async function loadDongleList() {
  if (!st) return;   // the highlight needs the state of the VFO
  const tbl = $("dongleList");
  let d;
  try {
    d = await fetch(vbase + "/api/dongles").then((r) => r.json());
  } catch (e) {
    d = { vfos: [], connected: [], error: String(e) };
  }
  const list = d.vfos || [], conn = d.connected || [];
  const curOwner = st.chain_owner || st.vfo;   // the VFO that holds the dongle these settings go to
  // State of the dongle from its VFO receiver (an open dongle does not report its serial over USB).
  const state = (name) => {
    const v = vfos.find((x) => x.name === name), s = v && v.st;
    if (!v || !v.online || !s) return ["–", "VFO receiver not reachable"];
    if (s.error) return ["error", s.error];
    if (s.status === "running") return ["✓", "running"];
    return ["…", s.status];
  };
  const rows = [];
  for (const v of list.filter((x) => !x.chain)) {
    const chained = list.filter((x) => x.chain === v.name).map((x) => x.name);
    const [ok, why] = state(v.name);
    rows.push({
      cur: v.name === curOwner,
      dongle: `${DEVICE_NAMES[v.driver] || "RTL-SDR"} · SN ${v.serial || "?"}`,
      vfos: [v.name, ...chained].map((n) => `VFO ${n}`).join(", ") + (chained.length ? " (chained)" : ""),
      ok, why, note: v.note || "",
    });
  }
  // connected RTL dongles no VFO uses (only those whose serial can be read, i.e. not open)
  const assigned = new Set(list.map((v) => v.serial));
  for (const c of conn.filter((c) => list.length ? c.serial && !assigned.has(c.serial) : true)) {
    rows.push({
      cur: !list.length && c.index === st.device,   // without vfos.json: the dongle selected on BASIC
      dongle: `#${c.index} · ${c.product || c.name || "RTL-SDR"}` + (c.serial ? ` · SN ${c.serial}` : ""),
      vfos: list.length ? "free" : "", ok: "USB", why: "connected, not open", note: c.vendor || "",
    });
  }
  tbl.innerHTML = "<tr><th>Dongle</th><th>VFO</th><th>State</th><th>Note</th></tr>" +
    rows.map((r) => `<tr${r.cur ? ' class="cur" title="These settings apply to this dongle"' : ""}>` +
      `<td>${escHtml(r.dongle)}</td><td>${escHtml(r.vfos)}</td><td title="${escHtml(r.why)}">${escHtml(r.ok)}</td>` +
      `<td>${escHtml(r.note)}</td></tr>`).join("") +
    `<tr><td colspan="4" class="sum">RTL dongles on USB: ${conn.length}</td></tr>` +
    (d.error ? `<tr><td colspan="4" class="warn">${escHtml(d.error)}</td></tr>` : "");
}
$("dongleListRefresh").addEventListener("click", loadDongleList);
$("biasTee").addEventListener("change", () => send({ bias_tee: $("biasTee").checked }));
const TX_ACK_TEXT =
  "IMPORTANT - TRANSMITTING DISCLAIMER\n\n" +
  "By enabling TX you confirm that:\n" +
  "- you hold a valid amateur radio licence (or another authorisation required in your country) and transmit only " +
  "within its privileges and the regulations (ITU, CEPT, FCC or your national authority);\n" +
  "- you use a suitable filter and antenna or a dummy load (the SDR is not a certified transmitter);\n" +
  "- you are fully and solely responsible for every transmission and its consequences; " +
  "the software is provided AS IS and the author accepts no liability.\n\n" +
  "TX is limited to ham 160-10 m, 6 m, 4 m, 2 m, 70 cm, 23 cm, CB 27 MHz and PMR446.\n\nEnable TX?";
$("txEnabled").addEventListener("change", () => {
  if ($("txEnabled").checked && !confirm(TX_ACK_TEXT)) {
    $("txEnabled").checked = false;
    return;
  }
  st.tx_enabled = $("txEnabled").checked;
  if (!st.tx_enabled) pttUp();
  send(st.tx_enabled ? { tx_enabled: true, tx_ack: true } : { tx_enabled: false });
});
$("resetBtn").addEventListener("click", () => { floor = null; send({ reset: true }); });
for (const id of ["wfRange", "wfShift"]) {
  $(id).addEventListener("input", () => { renderWfLabels(); drawSpectrum(); store(id, $(id).value); });
  const saved = recall(id);
  if (saved !== null) $(id).value = saved;
}
// a step saved by an older version (one set for all modes, or the old seven WFM steps) snaps to the nearest of the four
for (const set of ["narrow", "wfm"]) {
  const old = Number(recall("step")), saved = Number(recall(STEP_KEYS[set]) ?? (set === "wfm" ? old : NaN));
  const list = STEP_SETS[set];
  if (list.includes(saved)) stepMem[set] = saved;
  else if (saved > 0) stepMem[set] = list.reduce((a, b) => (Math.abs(Math.log(b / saved)) < Math.abs(Math.log(a / saved)) ? b : a));
}
stepHz = stepMem.narrow;

// ---------- FT8 ----------

const FT8_BANDS = { 1840000: "160", 3573000: "80", 5357000: "60", 7074000: "40", 10136000: "30", 14074000: "20",
  18100000: "17", 21074000: "15", 24915000: "12", 28074000: "10" };
const FT8_MAX_ROWS = 400;
let ft8Count = 0;
let ft8Cycle = null;

function renderFt8Bands(freqs) {
  $("ft8Bands").innerHTML = freqs.map((f) =>
    `<button data-f="${f}" title="${fmtKHz(f, 0)} kHz USB">${FT8_BANDS[f] || fmtMHz(f, 3)} m</button>`).join("");
}

function addFt8(d, fresh) {
  const tb = $("ft8Rows");
  $("ft8Empty").hidden = true;
  if (ft8Cycle !== d.time) {
    ft8Cycle = d.time;
    const sep = document.createElement("tr");
    sep.className = "cycle";
    sep.innerHTML = `<td colspan="6">── ${d.time} UTC</td>`;
    tb.prepend(sep);
  }
  const tr = document.createElement("tr");
  if (/^CQ\b/.test(d.msg)) tr.classList.add("cq");
  if (fresh) tr.classList.add("new");
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  tr.innerHTML = `<td>${d.time}</td><td class="num">${d.snr > 0 ? "+" : ""}${d.snr}</td>` +
    `<td class="num">${d.dt.toFixed(1)}</td><td class="num">${d.df}</td>` +
    `<td class="num">${fmtKHz(d.freq_hz, 1)}</td><td class="msg">${esc(d.msg)}</td>`;
  // New messages go to the top, right under the separator of their cycle.
  tb.insertBefore(tr, tb.firstChild.nextSibling);
  while (tb.rows.length > FT8_MAX_ROWS) tb.lastChild.remove();
  ft8Count++;
}

function renderFt8Info(text) {
  if (!st) return;
  $("ft8Card").hidden = !st.ft8;
  $("ft8Info").textContent = !st.ft8 ? "off" : st.ft8_error ? `error: ${st.ft8_error}` : text || $("ft8Info").textContent || "waiting for cycle…";
}

$("ft8On").addEventListener("change", () => {
  st.ft8 = $("ft8On").checked;
  renderFt8Info(st.ft8 ? "waiting for cycle…" : "");
  send({ ft8: st.ft8 });
});
$("ft8Bands").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-f]");
  if (!b || !st) return;
  await ensureVfoFor(Number(b.dataset.f));   // HF band -> VFO with upconverter
  if (!st) return;
  st.mode = "USB";
  renderControls();
  tune(Number(b.dataset.f));
  const changes = { mode: "USB" };
  if (!st.ft8) { st.ft8 = true; $("ft8On").checked = true; changes.ft8 = true; }
  send(changes);
});
$("ft8Clear").addEventListener("click", () => {
  $("ft8Rows").innerHTML = "";
  $("ft8Empty").hidden = false;
  ft8Cycle = null;
  ft8Count = 0;
});

// ---------- SPECTRUM / DECODERS / SATELLITES tabs ----------
// The decoders are not below the screen (scrolling to them was awkward) but in a tab that covers the spectrum and waterfall.

// the open tab is remembered for each VFO separately (bodyTab_A, bodyTab_B…)
const tabKey = () => (active ? `bodyTab_${active.name}` : "bodyTab");
let bodyTab = "scope";   // the saved tab is restored in init(), once the active VFO is known

// VFO without a saved tab: the first state from the server decides (a decoder is running → DECODERS)
let bodyTabGuess = false;

/** Tab saved for the active VFO, called after a VFO switch. */
function restoreBodyTab(keepTab) {
  $("decNew").hidden = true;
  decNewPages.clear();
  const page = recall(decPageKey());
  decPageSaved = DEC_PAGES.some((p) => p.key === page);
  decPage = decPageSaved ? page : "ft8";
  renderAmsatTab();
  const saved = MAP_ONLY ? "scope" : keepTab || recall(tabKey());
  // DAB / DSD (tabs of a mode): the first state decides, like for a VFO without a saved tab
  bodyTabGuess = !["dec", "scope", "sat", "set", "mem", "recs", "rot", "scan"].includes(saved);
  setBodyTab((saved === "dec" && decTabShown()) || (saved === "sat" && amsatTabShown()) || (saved === "set" && setTabShown()) || (saved === "mem" && memTabShown()) || (saved === "recs" && recsTabShown()) || (saved === "rot" && rotTabShown()) || (saved === "scan" && scanTabShown()) ? saved : "scope", !bodyTabGuess);
}

/** First state of a VFO without a saved tab: if a decoder runs on it, opens DECODERS. */
function guessBodyTab() {
  if (!bodyTabGuess) return;
  bodyTabGuess = false;
  if (st && st.dab) { setBodyTab("dab", false); return; }        // a mode with its own tab
  if (st && st.mode === "DSD") { setBodyTab("dsd", false); return; }
  const run = DEC_PAGES.find((p) => decRunning(p.key));
  if (run && !decPageSaved) setDecPage(run.key, false);
  setBodyTab(run ? "dec" : "scope");
}

function setBodyTab(tab, save = true) {
  bodyTab = tab;
  if (save) store(tabKey(), tab);
  if (tab === "sat" && save) store(satOnKey(), "1");   // the SATELLITES tab open → SAT on for this VFO
  if (tab === "dec" && save) store(decOnKey(), "1");   // the DECODERS tab open → DECODE on for this VFO
  if (tab === "set" && save) store("setOn", "1");       // the SETTINGS tab open → the gear key on
  if (tab === "mem" && save) store("memOn", "1");       // the MEMORIES tab open → the MEM key on
  if (tab === "recs" && save) store("recsOn", "1");     // the RECORDINGS tab open → the RECS key on
  if (tab === "rot" && save) store("rotOn", "1");       // the ROTOR CONTROL tab open → the RCTRL key on
  if (tab === "scan" && save) store("scanOn", "1");     // the SCAN tab open → the SCAN key on
  for (const b of $("bodyTabs").querySelectorAll("button")) b.classList.toggle("on", b.dataset.tab === tab);
  $("decPane").hidden = tab !== "dec";
  $("dabPane").hidden = tab !== "dab";
  $("dsdPane").hidden = tab !== "dsd";
  if (tab === "dsd") $("dsdTabDot").hidden = true;
  $("amsatPane").hidden = tab !== "sat";
  $("settingsCard").hidden = tab !== "set";
  $("memPane").hidden = tab !== "mem";
  $("recsPane").hidden = tab !== "recs";
  $("rotPane").hidden = tab !== "rot";
  $("scanPane").hidden = tab !== "scan";
  if (tab === "dec") { $("decNew").hidden = true; decNewPages.delete(decPage); }
  renderDecKey();
  renderDecTab();
  if (tab === "sat") renderSatTab();
  renderAmsatTab();
  renderSetKey();
  renderMemKey();
  renderRecsKey();
  renderRotKey();
  renderScanKey();
  if (tab === "scan") setTimeout(scanPaneOpened);  // declared further down
  if (tab === "mem") setTimeout(memPaneOpened);    // declared further down
  if (tab === "recs") setTimeout(loadRecordings);  // declared further down
  // the open settings page fills at once (ROTOR, LOCATION, the dongle list; declared further down)
  if (tab === "set") setTimeout(() => setSubOpened(openSetSub($("settingsCard").querySelector("[data-set-panel]:not([hidden])").dataset.setPanel)));
  if (tab === "rot") setTimeout(rctrlOpened);  // the map of ROTOR CONTROL (declared further down)
  hoverHide();
}

// ---------- DECODERS tab: a page for each decoder (like the pages of SATELLITES) ----------

// order of the page keys; "|" = a vertical separator between the groups (HF digital, aircraft, ships, ISM)
const DEC_LAYOUT = [
  { key: "cw", title: "CW" }, { key: "ft8", title: "FT8" }, { key: "packet", title: "PACKET" }, { key: "rtty", title: "RTTY" },
  { key: "sstv", title: "SSTV" }, { key: "wefax", title: "WEFAX" }, "|",
  { key: "acars", title: "ACARS" }, { key: "adsb", title: "ADS-B" }, { key: "hfdl", title: "HFDL" }, { key: "vdl2", title: "VDL2" }, "|",
  { key: "ais", title: "AIS" }, "|",
  { key: "ism", title: "ISM" },
];   // DAB and DSD are modes (MODE) with their own tabs
const DEC_PAGES = DEC_LAYOUT.filter((p) => p !== "|");
// the open page is remembered for each VFO separately (decPage_A, decPage_B…)
const decPageKey = () => (active ? `decPage_${active.name}` : "decPage");
let decPage = "ft8";
let decPageSaved = false;        // false: the first running decoder of the VFO decides (guessBodyTab)
const decNewPages = new Set();   // pages with a message not seen yet

$("decPages").replaceChildren(...DEC_LAYOUT.map((p) => {
  if (p === "|") { const d = document.createElement("span"); d.className = "dec-sep"; return d; }
  const b = document.createElement("button");
  b.className = "key small";
  b.dataset.page = p.key;
  b.textContent = p.title;
  return b;
}));

/** Is the decoder of the page on? By the checkboxes – valid right after the click, before the server confirms the state. */
function decRunning(key) {
  if (key === "ism") return !!(st && st.ism);
  return $(key + "On").checked;
}

function setDecPage(key, save = true) {
  decPage = key;
  decPageSaved = decPageSaved || save;
  if (save) store(decPageKey(), key);
  if (bodyTab === "dec") decNewPages.delete(key);
  renderDecTab();
}


/** Page keys (green ● = a new message not seen yet) and the card of the open page, shown also while
 *  its decoder is off (its ON key is in the top left corner). */
function renderDecTab() {
  const n = DEC_PAGES.filter((p) => decRunning(p.key)).length;
  $("decCount").textContent = n ? `(${n})` : "";
  for (const b of $("decPages").querySelectorAll("button[data-page]")) {
    const k = b.dataset.page, na = decUnavailable(k);
    b.classList.toggle("on", k === decPage);
    b.classList.toggle("new", decNewPages.has(k));
    b.classList.toggle("na", !!na);
    b.title = na ? "Unsupported on this dongle" : "";
  }
  for (const el of $("decPane").querySelectorAll("[data-dec-on]")) el.hidden = el.dataset.decOn !== decPage;
  // not on the receiver of this VFO: the reason instead of the card
  const na = decRunning(decPage) ? "" : decUnavailable(decPage);
  // ACARS and VDL2 share one card (on both pages): it shows the link that runs, with none the link of the page
  for (const c of $("decPane").querySelectorAll(".card[data-dec]")) c.classList.toggle("off-page", !!na || !c.dataset.dec.split(" ").includes(decPage));
  if (st) renderLinkBands();
  // the ACARS map was hidden (size 0); later: this also runs before the map variables are declared
  if (decPage === "acars" || decPage === "vdl2") setTimeout(() => { if (acarsMap) acarsMap.invalidateSize(); });
  $("decEmpty").hidden = !na;
  $("decEmpty").classList.toggle("dec-na", !!na);
  $("decEmpty").textContent = na;
}

/** Tabs of the modes DAB and DSD: there only while the mode is selected; an open one closes with its mode. */
function renderModeTabs() {
  if (!st) return;
  const dab = !!st.dab, dsd = st.mode === "DSD" && !dab;
  $("dabTab").hidden = !dab;
  $("dsdTab").hidden = !dsd;
  if ((bodyTab === "dab" && !dab) || (bodyTab === "dsd" && !dsd)) setBodyTab("scope");
}
// decoders that need the raw samples, sample rate and centre of their own RTL-SDR dongle
const DEC_RTL_ONLY = { vdl2: "VDL2", ism: "ISM" };

/** Why the decoder of the page cannot run on the receiver of the active VFO ("" = it can). */
function decUnavailable(key) {
  if ((key === "hfdl" || key === "ais" || key === "adsb") && st && st.chain_owner) return `${key === "adsb" ? "ADS-B" : key.toUpperCase()} needs its own dongle: ${active ? `VFO ${active.name}` : "this VFO"} shares the dongle of VFO ${st.chain_owner}.`;
  const name = DEC_RTL_ONLY[key];
  if (!name || !st) return "";
  const vfo = active ? `VFO ${active.name}` : "this VFO";
  if (st.chain_owner) return `${name} needs its own dongle: ${vfo} shares the dongle of VFO ${st.chain_owner}.`;
  if (noRtlDongle(st)) return `${name} is not supported on ${DEVICE_NAMES[st.driver] || st.driver} (${vfo}): RTL-SDR only.`;
  return "";
}

/** New decoder message: green dot on the tab and on the page key until you look at it. */
function decActivity(page) {
  if (bodyTab !== "dec") $("decNew").hidden = false;
  if (page && (bodyTab !== "dec" || page !== decPage) && !decNewPages.has(page)) { decNewPages.add(page); renderDecTab(); }
}

$("bodyTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) setBodyTab(b.dataset.tab);
});
$("decPages").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-page]");
  if (b) setDecPage(b.dataset.page);
});
/** DECODE key: switched on per VFO (decOn_A, decOn_B…); the DECODERS tab is there only while it is on (on by default).
 *  Off only hides the tab: running decoders keep running. */
function decOnKey() { return active ? `decOn_${active.name}` : "decOn"; }
function decTabShown() { return recall(decOnKey()) !== "0"; }
function setDecOn(on) {
  store(decOnKey(), on ? "1" : "0");
  if (on) setBodyTab("dec");
  else if (bodyTab === "dec") setBodyTab("scope");
  else renderDecKey();
}
function renderDecKey() {
  const on = decTabShown();
  $("decKey").classList.toggle("on", on);
  $("decTab").hidden = !on;
}
$("decKey").addEventListener("click", () => setDecOn(!decTabShown()));
/** Gear key (SET): the SETTINGS tab is there only while it is on; one switch for all VFOs. */
function setTabShown() { return recall("setOn") === "1"; }
function setSetOn(on) {
  store("setOn", on ? "1" : "0");
  if (on) setBodyTab("set");
  else if (bodyTab === "set") setBodyTab("scope");
  else renderSetKey();
}
function renderSetKey() {
  const on = setTabShown();
  $("setKey").classList.toggle("on", on);
  $("setTab").hidden = !on;
}
$("setKey").addEventListener("click", () => setSetOn(!setTabShown()));
/** MEM key: the MEMORIES tab (list of memories and the memory editor) is there only while it is on; one switch for all VFOs. */
function memTabShown() { return recall("memOn") === "1"; }
function setMemOn(on) {
  store("memOn", on ? "1" : "0");
  if (on) setBodyTab("mem");
  else if (bodyTab === "mem") setBodyTab("scope");
  else renderMemKey();
}
function renderMemKey() {
  const on = memTabShown();
  $("memKey").classList.toggle("on", on);
  $("memTab").hidden = !on;
}
$("memKey").addEventListener("click", () => setMemOn(!memTabShown()));
/** RECS key (AUDIO group): the RECORDINGS tab (the MP3 files of REC / REC SQ) is there only while it is on; one switch for all VFOs. */
function recsTabShown() { return recall("recsOn") === "1"; }
function setRecsOn(on) {
  store("recsOn", on ? "1" : "0");
  if (on) setBodyTab("recs");
  else if (bodyTab === "recs") setBodyTab("scope");
  else renderRecsKey();
}
function renderRecsKey() {
  const on = recsTabShown();
  $("recsKey").classList.toggle("on", on);
  $("recsTab").hidden = !on;
}
$("recsKey").addEventListener("click", () => setRecsOn(!recsTabShown()));
/** RCTRL key (TRACKING group): the ROTOR CONTROL tab (map to aim the rotor) is there only while it is on; one switch for all VFOs. */
function rotTabShown() { return recall("rotOn") === "1"; }
function setRotOn(on) {
  store("rotOn", on ? "1" : "0");
  if (on) setBodyTab("rot");
  else if (bodyTab === "rot") setBodyTab("scope");
  else renderRotKey();
}
function renderRotKey() {
  const on = rotTabShown();
  $("rctrlKey").classList.toggle("on", on);
  $("rotTab").hidden = !on;
}
$("rctrlKey").addEventListener("click", () => setRotOn(!rotTabShown()));
/** SCAN key (MENU group): the SCAN tab (memory scanner) is there only while it is on; one switch for all VFOs,
 *  the tab shows the scan of the active VFO. The key blinks while the active VFO scans. */
function scanTabShown() { return recall("scanOn") === "1"; }
function setScanOn(on) {
  store("scanOn", on ? "1" : "0");
  if (on) setBodyTab("scan");
  else if (bodyTab === "scan") setBodyTab("scope");
  else renderScanKey();
}
function renderScanKey() {
  const on = scanTabShown(), sc = st && st.scan;
  $("scanKey").classList.toggle("on", on);
  $("scanKey").classList.toggle("scanning", !!(sc && sc.on && !sc.paused));
  $("scanTab").hidden = !on;
  $("scanTabDot").hidden = !(sc && sc.on);
}
$("scanKey").addEventListener("click", () => setScanOn(!scanTabShown()));
for (const id of ["ft8On", "wefaxOn", "cwOn", "rttyOn", "sstvOn", "packetOn", "acarsOn", "vdl2On", "hfdlOn", "aisOn", "adsbOn"]) {
  $(id).addEventListener("change", () => renderDecTab());
}
setBodyTab(bodyTab, false);

// ---------- SATELLITES tab: the lists of amsat.org ----------

let amsatPages = null;   // from the server (satellites.py), loaded when the tab is first opened
let amsatPage = recall("amsatPage") || "passes";
let amsatBusy = false;

/** SAT key: switched on per VFO (satOn_A, satOn_B…); the SATELLITES tab is there only while it is on.
 *  Older setups without the key: on when the saved tab of the VFO is SATELLITES. */
function satOnKey() { return active ? `satOn_${active.name}` : "satOn"; }
function amsatTabShown() {
  const v = recall(satOnKey());
  return v === null ? recall(tabKey()) === "sat" : v === "1";
}
function setSatOn(on) {
  store(satOnKey(), on ? "1" : "0");
  if (on) setBodyTab("sat");
  else if (bodyTab === "sat") setBodyTab("scope");
  else renderAmsatTab();
}
function renderAmsatTab() {
  const on = amsatTabShown();
  $("satKey").classList.toggle("on", on);
  $("amsatTab").hidden = !on;
}

function amsatInfo(text, error = false) {
  $("amsatInfo").textContent = text;
  $("amsatInfo").classList.toggle("error", error);
}

/** Page keys: own pages first (PASSES, SETUP), then the AMSAT lists once they are loaded. */
function renderSatPageButtons() {
  const pages = [...SAT_LOCAL_PAGES, ...(amsatPages || [])];
  $("amsatPages").replaceChildren(...pages.map((p, i) => {
    const b = document.createElement("button");
    b.className = "key small" + (p.key === amsatPage ? " on" : "") + (i === SAT_LOCAL_PAGES.length ? " gap" : "");
    b.dataset.page = p.key;
    b.textContent = p.title;
    return b;
  }));
  $("amsatRefresh").title = amsatPage === "passes" ? "Calculate the passes again" : amsatPage === "map" ? "Calculate the tracks again" : amsatPage === "track" ? "Download the transmitters from SatNOGS again" : amsatPage === "setup"
    ? "Download the orbital elements from CelesTrak again" : "Download the lists from amsat.org again";
}

/** Shows the chosen page of the SATELLITES tab. */
function renderSatTab() {
  if (!amsatPages && !amsatBusy) amsatLoad();      // in the background, for the LINEAR… keys
  if (!satIsLocal(amsatPage) && !(amsatPages || []).some((p) => p.key === amsatPage) && amsatPages) amsatPage = "passes";
  renderSatPageButtons();
  if (amsatPage === "passes") renderSatPasses();
  else if (amsatPage === "map") renderSatMap();
  else if (amsatPage === "track") renderSatTrack();
  else if (amsatPage === "setup") renderSatSetup();
  else if (amsatPages) renderAmsat();
  else { $("amsatBody").classList.remove("satp-on"); $("amsatBody").textContent = ""; }
}

function renderAmsat() {
  const page = amsatPages.find((p) => p.key === amsatPage) || amsatPages[0];
  $("amsatBody").classList.remove("satp-on");
  const time = page.fetched ? new Date(page.fetched * 1000).toLocaleString() : "";
  if (page.error) amsatInfo(page.html ? `Download failed, this copy is from ${time}: ${page.error}` : `Download failed: ${page.error}`, true);
  else amsatInfo(`Downloaded ${time}`);
  // the content is cleaned by the server: only plain tags and links that open in a new tab
  $("amsatBody").innerHTML = page.html + '<p class="amsat-source"></p>';
  const src = $("amsatBody").lastElementChild, a = document.createElement("a");
  a.href = a.textContent = page.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  src.append("Source: AMSAT, ", a);
  $("amsatBody").scrollTop = 0;
}

async function amsatLoad(refresh = false) {
  if (amsatBusy) return;
  amsatBusy = true;
  const shown = () => !satIsLocal(amsatPage);
  if (shown()) { $("amsatRefresh").disabled = true; amsatInfo("Downloading from amsat.org…"); }
  try {
    const r = await fetch(vbase + "/api/satellites", refresh ? { method: "POST" } : {});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    amsatPages = (await r.json()).pages;
    if (shown()) renderSatTab(); else renderSatPageButtons();
  } catch (e) {
    if (shown()) amsatInfo(`The receiver did not answer: ${e.message}`, true);
  }
  amsatBusy = false;
  $("amsatRefresh").disabled = false;
}

$("amsatRefresh").addEventListener("click", async () => {
  if (amsatPage === "passes") { satData = null; satLoad(); }
  else if (amsatPage === "map") satMapLoad();
  else if (amsatPage === "track") { amsatInfo("Downloading the transmitters from SatNOGS…"); satTxLoad(true).then(() => satData && satInfoLine()); }
  else if (amsatPage === "setup") {
    amsatInfo("Downloading the orbital elements…");
    if (await satSetupLoad({ refresh_tle: true })) amsatInfo("Downloaded");
  } else amsatLoad(true);
});
$("amsatPages").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-page]");
  if (!b) return;
  amsatPage = b.dataset.page;
  satTrackPicked = false;     // back on TRACK: the satellite of a running Doppler or rotor again
  store("amsatPage", amsatPage);
  renderSatTab();
});

// ---------- SATELLITES tab: own pass prediction (sattrack.py), pages PASSES and SETUP ----------

const SAT_LOCAL_PAGES = [{ key: "passes", title: "PASSES" }, { key: "map", title: "MAP" }, { key: "track", title: "TRACK" }, { key: "setup", title: "SETUP" }];
const SAT_HOURS = [12, 24, 48];
let satHours = Number(recall("satHours")) || 24;
let satData = null;        // /api/sat/passes
let satSetupData = null;   // /api/sat/setup
let satGroup = recall("satGroup") || "amateur";     // tab of the satellite choice in SETUP
let satSel = null;         // chosen pass {norad, aos, los}
let satDetail = null;      // /api/sat/pass of the chosen pass
let satLoadedAt = 0;
let satBusy = false;

const satIsLocal = (key) => SAT_LOCAL_PAGES.some((p) => p.key === key);
const satTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const satDay = (t) => new Date(t * 1000).toLocaleDateString([], { weekday: "short", day: "numeric", month: "numeric" });
const satDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Short label of a satellite: the OSCAR-style name in brackets when there is one ("OSCAR 7 (AO-7)" -> AO-7). */
function satShort(name) {
  const m = /\(([A-Z]{2,4}-\d+[A-Z]?)\)/.exec(name);
  if (m) return m[1];
  return name.split(" (")[0].split(" & ")[0].trim();
}

/** Bar colour by the highest elevation: one hue, brighter = higher pass. */
function satElClass(el) {
  return el >= 45 ? "hi" : el >= 20 ? "mid" : "lo";
}

function satUntil(t) {
  const s = t - Date.now() / 1000;
  if (s <= 0) return "now";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `in ${h} h ${m} min` : `in ${m} min`;
}

/** base: another receiver than the active VFO (the rotor tracking goes to rotorBase()). */
async function satFetch(url, opts, base = vbase) {
  const r = await fetch(base + url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

async function satLoad() {
  if (satBusy) return;
  satBusy = true;
  amsatInfo("Calculating passes…");
  try {
    satData = await satFetch(`/api/sat/passes?hours=${satHours}`);
    satLoadedAt = Date.now();
    if (amsatPage === "passes" && bodyTab === "sat") {
      if ($("satTl") && Number($("satHours").querySelector(".on")?.dataset.hours) === satHours) {
        satInfoLine(); renderSatTimeline(); renderSatList();
      } else renderSatPasses();
    } else if (amsatPage === "track" && bodyTab === "sat") {
      if ($("satTrackSat")) satInfoLine(); else renderSatTrack();
    }
  } catch (e) {
    amsatInfo(`Passes: ${e.message}`, true);
  }
  satBusy = false;
}

function satInfoLine() {
  const d = satData, s = d.setup;
  const tle = d.tle.fetched ? `orbital elements from ${new Date(d.tle.fetched * 1000).toLocaleString()}` : "no orbital elements";
  amsatInfo(`${s.locator} · min. elevation ${s.min_el}° · ${tle}${d.tle.error ? ` (download failed: ${d.tle.error})` : ""}`, !d.tle.fetched || !!d.tle.error);
}

function renderSatPasses() {
  if (!satData) { satLoad(); return; }
  satInfoLine();
  const body = $("amsatBody");
  body.classList.add("satp-on");
  body.innerHTML = `<div class="satp">
    <div class="satp-hours"><span id="satHours">${SAT_HOURS.map((h) => `<button class="key small${h === satHours ? " on" : ""}" data-hours="${h}">${h} h</button>`).join(" ")}</span>
      <span class="satp-legend">Highest elevation: <span class="dot lo"></span>under 20° <span class="dot mid"></span>20–45° <span class="dot hi"></span>over 45°</span></div>
    <div class="satp-tl" id="satTl"></div>
    <div class="satp-lower">
      <div class="satp-list-wrap"><table class="satp-list" id="satList"></table></div>
      <div class="satp-detail" id="satDetail"><p class="muted">Click a pass in the timeline or in the list for its details.</p></div>
    </div></div>`;
  renderSatTimeline();
  renderSatList();
  if (satSel) satShowDetail(satSel, false);
}

function renderSatTimeline() {
  const box = $("satTl");
  if (!box) return;
  const d = satData, rows = d.sats.filter((s) => !s.missing);
  const W = Math.max(box.clientWidth - 2, 400), LABEL = 92, ROW = 22, TOP = 22, H = TOP + rows.length * ROW + 4;
  const t0 = d.now, t1 = d.now + d.hours * 3600, x = (t) => LABEL + ((t - t0) / (t1 - t0)) * (W - LABEL - 6);
  const step = d.hours <= 12 ? 1 : d.hours <= 24 ? 2 : 4;
  let svg = `<svg class="satp-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  // hour grid; a stronger line and the date at midnight
  const first = new Date(t0 * 1000); first.setMinutes(0, 0, 0);
  for (let t = first.getTime() / 1000 + 3600; t < t1; t += 3600) {
    const hr = new Date(t * 1000).getHours();
    if (hr % step) continue;
    const xx = x(t).toFixed(1), midnight = hr === 0;
    svg += `<line class="${midnight ? "tl-day" : "tl-grid"}" x1="${xx}" x2="${xx}" y1="${TOP - 4}" y2="${H}"/>`;
    svg += `<text class="tl-hour" x="${xx}" y="${TOP - 8}">${midnight ? satDay(t) : String(hr).padStart(2, "0") + ":00"}</text>`;
  }
  rows.forEach((s, i) => {
    const y = TOP + i * ROW;
    svg += `<text class="tl-name${s.tle_old ? " old" : ""}" x="4" y="${y + ROW / 2 + 4}">${escHtml(satShort(s.name))}${s.tle_old ? " !" : ""}<title>${escHtml(s.name)} · NORAD ${s.norad} · elements ${s.tle_age_days} days old${s.tle_old ? " (old: positions may be off)" : ""}</title></text>`;
    svg += `<line class="tl-row" x1="${LABEL}" x2="${W - 6}" y1="${y + ROW - 0.5}" y2="${y + ROW - 0.5}"/>`;
  });
  for (const p of d.passes) {
    const i = rows.findIndex((s) => s.norad === p.norad);
    if (i < 0) continue;
    const y = TOP + i * ROW + 5, x0 = x(Math.max(p.aos, t0)), w = Math.max(x(p.los) - x0, 3);     // a pass on now starts at "now"
    const sel = satSel && satSel.norad === p.norad && Math.abs(satSel.aos - p.aos) < 1;
    svg += `<rect class="tl-pass ${satElClass(p.max_el)}${sel ? " sel" : ""}" x="${x0.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="12" rx="3" data-norad="${p.norad}" data-aos="${p.aos}" data-los="${p.los}">`
      + `<title>${escHtml(satShort(p.name))}: ${satTime(p.aos)}–${satTime(p.los)}, max. ${p.max_el}° at ${Math.round(p.max_az)}°</title></rect>`;
  }
  svg += `<line class="tl-now" x1="${LABEL}" x2="${LABEL}" y1="${TOP - 4}" y2="${H}"/>`;
  svg += `<text class="tl-hour now" x="${LABEL + 2}" y="${TOP - 8}">now</text></svg>`;
  box.innerHTML = svg + (d.sats.some((s) => s.missing)
    ? `<p class="muted small">Not in the orbital elements: ${d.sats.filter((s) => s.missing).map((s) => s.norad).join(", ")}</p>` : "");
}

function renderSatList() {
  const list = $("satList");
  if (!list) return;
  const now = Date.now() / 1000;
  const rows = satData.passes.filter((p) => p.los > now).slice(0, 60);
  list.innerHTML = `<thead><tr><th>Satellite</th><th>AOS</th><th>LOS</th><th>Time</th><th>Max</th><th>Azimuth</th></tr></thead><tbody>`
    + rows.map((p) => {
      const sel = satSel && satSel.norad === p.norad && Math.abs(satSel.aos - p.aos) < 1;
      const on = p.aos <= now;
      return `<tr class="${sel ? "sel" : ""}${on ? " on" : ""}" data-norad="${p.norad}" data-aos="${p.aos}" data-los="${p.los}">`
        + `<td><span class="dot ${satElClass(p.max_el)}"></span>${escHtml(satShort(p.name))}</td>`
        + `<td>${satDay(p.aos)} ${satTime(p.aos)}<br><span class="muted">${on ? "in progress" : satUntil(p.aos)}</span></td>`
        + `<td>${satTime(p.los)}</td><td>${satDur(p.los - p.aos)}</td><td>${p.max_el}°</td>`
        + `<td>${Math.round(p.aos_az)}° → ${Math.round(p.los_az)}°</td></tr>`;
    }).join("") + "</tbody>";
  if (!rows.length) list.innerHTML = `<tbody><tr><td class="muted">No pass above ${satData.setup.min_el}° in the next ${satData.hours} hours.</td></tr></tbody>`;
}

async function satShowDetail(sel, fetchNew = true) {
  satSel = sel;
  const box = $("satDetail");
  if (!box) return;
  for (const el of document.querySelectorAll(".tl-pass.sel, .satp-list tr.sel")) el.classList.remove("sel");
  for (const el of document.querySelectorAll(`.tl-pass[data-norad="${sel.norad}"], .satp-list tr[data-norad="${sel.norad}"]`)) {
    if (Math.abs(Number(el.dataset.aos) - sel.aos) < 1) el.classList.add("sel");
  }
  if (fetchNew || !satDetail || satDetail.norad !== sel.norad || Math.abs(satDetail.samples[0].t - sel.aos) > 1) {
    box.innerHTML = '<p class="muted">Calculating…</p>';
    try {
      satDetail = await satFetch(`/api/sat/pass?norad=${sel.norad}&aos=${sel.aos}&los=${sel.los}`);
    } catch (e) {
      box.innerHTML = `<p class="error">${escHtml(e.message)}</p>`;
      return;
    }
  }
  renderSatDetail();
}

const satTxCache = {};      // norad -> promise of /api/sat/transmitters

function satTxGet(norad) {
  if (!satTxCache[norad]) {
    satTxCache[norad] = satFetch(`/api/sat/transmitters?norad=${norad}`).catch((e) => { delete satTxCache[norad]; throw e; });
  }
  return satTxCache[norad];
}

/** Short list of the transmitters of a satellite into the element with this id (transponders first). */
async function satTxFill(id, norad, max = 10) {
  const box = $(id);
  if (!box) return;
  box.innerHTML = '<p class="muted small">Loading transmitters…</p>';
  let d;
  try { d = await satTxGet(norad); } catch (e) { if ($(id) === box) box.innerHTML = `<p class="error small">Transmitters: ${escHtml(e.message)}</p>`; return; }
  if ($(id) !== box) return;
  const rows = d.transmitters;
  if (!rows.length) { box.innerHTML = '<p class="muted small">No active transmitter in SatNOGS DB.</p>'; return; }
  const mhz = (v) => (v / 1e6).toFixed(3);
  box.innerHTML = `<table class="satp-txs"><thead><tr><th>Downlink MHz</th><th>Mode</th><th>Description</th></tr></thead><tbody>`
    + rows.slice(0, max).map((t) => `<tr><td>${t.downlink_high && t.downlink_high !== t.downlink_low ? `${mhz(t.downlink_low)}–${mhz(t.downlink_high)}` : mhz(t.downlink_low)}</td>`
      + `<td>${escHtml(t.mode || "")}</td><td>${escHtml(t.description || "")}${t.type === "Transponder" ? ' <span class="muted">transponder</span>' : ""}</td></tr>`).join("")
    + `</tbody></table>${rows.length > max ? `<p class="muted small">and ${rows.length - max} more (all in TRACK)</p>` : ""}`;
}

/** Polar plot: centre = zenith, edge = horizon, north up, east right. */
function satPolarXY(az, el, R) {
  const r = R * (90 - Math.max(el, 0)) / 90, a = (az * Math.PI) / 180;
  return [r * Math.sin(a), -r * Math.cos(a)];
}

function renderSatDetail() {
  const box = $("satDetail"), d = satDetail;
  if (!box || !d) return;
  const s = d.samples, aos = s[0], los = s[s.length - 1];
  const top = s.reduce((a, b) => (b.el > a.el ? b : a));
  const near = s.reduce((a, b) => (b.range < a.range ? b : a));
  const dop = Math.max(...s.map((p) => Math.abs(p.doppler_hz_per_mhz)));
  const R = 100;
  const pts = s.map((p) => satPolarXY(p.az, p.el, R).map((v) => v.toFixed(1)).join(",")).join(" ");
  const [ax, ay] = satPolarXY(aos.az, aos.el, R), [lx, ly] = satPolarXY(los.az, los.el, R), [tx, ty] = satPolarXY(top.az, top.el, R);
  const polar = `<svg class="satp-polar" viewBox="-118 -118 236 236" role="img" aria-label="Pass on the sky, north up">
    <circle class="pg-ring" r="${R}"/><circle class="pg-ring" r="${(R * 2) / 3}"/><circle class="pg-ring" r="${R / 3}"/>
    <line class="pg-ring" x1="${-R}" x2="${R}"/><line class="pg-ring" y1="${-R}" y2="${R}"/>
    <text class="pg-lbl" y="${-R - 6}">N</text><text class="pg-lbl" x="${R + 8}" y="4">E</text><text class="pg-lbl" y="${R + 14}">S</text><text class="pg-lbl" x="${-R - 8}" y="4">W</text>
    <text class="pg-el" x="3" y="${-R / 3 * 2 + 10}">30°</text><text class="pg-el" x="3" y="${-R / 3 + 10}">60°</text>
    <polyline class="pg-track" points="${pts}"/>
    <circle class="pg-end" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="4"/><text class="pg-tag" x="${(ax * 0.86).toFixed(1)}" y="${(ay * 0.86 + 4).toFixed(1)}">AOS</text>
    <circle class="pg-end" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4"/><text class="pg-tag" x="${(lx * 0.86).toFixed(1)}" y="${(ly * 0.86 + 4).toFixed(1)}">LOS</text>
    <circle class="pg-top" cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="3"/>
    <circle class="pg-now" id="satNowDot" r="5" visibility="hidden"/>
    <g class="pg-rot" id="satRotX" visibility="hidden"><line x1="-6" y1="-6" x2="6" y2="6"/><line x1="-6" y1="6" x2="6" y2="-6"/></g>
    <g class="pg-aim" id="satAimX" visibility="hidden"><line x1="-6" y1="-6" x2="6" y2="6"/><line x1="-6" y1="6" x2="6" y2="-6"/></g>
    ${amsatPage === "track" ? `<circle class="pg-hit" id="satPolarHit" r="${R}"/>` : ""}</svg>`;
  const track = amsatPage === "track";
  const rows1 = `<tr><th>AOS</th><td>${satTime(aos.t)}</td><td>az ${Math.round(aos.az)}°</td></tr>
        <tr><th>Max</th><td>${satTime(top.t)}</td><td>el ${top.el.toFixed(1)}°, az ${Math.round(top.az)}°</td></tr>
        <tr><th>LOS</th><td>${satTime(los.t)}</td><td>az ${Math.round(los.az)}°</td></tr>
        <tr><th>Length</th><td colspan="2">${satDur(los.t - aos.t)}</td></tr>`;
  const rows2 = `<tr><th>Nearest</th><td colspan="2">${Math.round(near.range)} km</td></tr>
        <tr><th>Doppler</th><td colspan="2">±${(dop * 145.9 / 1000).toFixed(1)} kHz at 145.9 MHz, ±${(dop * 435 / 1000).toFixed(1)} kHz at 435 MHz</td></tr>
        <tr><th>Elements</th><td colspan="2">${((aos.t - d.tle_epoch) / 86400).toFixed(1)} days old at AOS</td></tr>
        <tr><th>Now</th><td colspan="2" id="satNowText">–</td></tr>`;
  // polar plot and elevation chart side by side, the facts in two columns below (no scrolling to the chart), on PASSES and TRACK alike
  box.innerHTML = `<div class="satp-dh"><b>${escHtml(d.name)}</b> <span class="muted">NORAD ${d.norad} · ${satDay(aos.t)}</span>
    ${track ? "" : `<button class="key small" id="satDetailTrack" data-norad="${d.norad}" title="Open this satellite on the TRACK page (Doppler, rotor)">TRACK</button>`}</div>
    <div class="satp-dbody satt-plots">${polar}<div class="satp-elchart" id="satElChart"></div></div>
    <div class="satt-facts"><table class="satp-facts">${rows1}</table><table class="satp-facts">${rows2}</table></div>
    ${track ? `<p class="muted small" id="satPolarNote">Red cross: the antenna now. A click on the polar plot turns the antenna there, a click on the elevation chart sets only the elevation (not while TRACK moves the rotor).</p>`
    : `<h4 class="satp-h">Transmitters</h4><div id="satDetailTx"></div>`}`;
  renderSatElChart();
  satTickNow();
  satPolarRotor();
  if (amsatPage !== "track") satTxFill("satDetailTx", d.norad);
}

/** Elevation over the pass, hover shows time, elevation and azimuth. */
function renderSatElChart() {
  const box = $("satElChart"), d = satDetail;
  if (!box || !d) return;
  const track = amsatPage === "track", TOP = track ? 180 : 90;     // TRACK: the rotor goes up to 180 (looking back)
  const s = d.samples, W = Math.max(box.clientWidth, 260), H = 220, L = 34, B = 18, T = 8;     // as high as the polar plot beside it
  const t0 = s[0].t, t1 = s[s.length - 1].t;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - 8), y = (el) => T + (1 - Math.min(Math.max(el, 0), TOP) / TOP) * (H - T - B);
  let svg = `<svg width="${W}" height="${H}" class="satp-elsvg">`;
  for (const g of track ? [0, 30, 60, 90, 120, 150, 180] : [0, 30, 60, 90]) svg += `<line class="${g ? "tl-grid" : "el-base"}" x1="${L}" x2="${W - 8}" y1="${y(g)}" y2="${y(g)}"/><text class="el-ax" x="${L - 4}" y="${y(g) + 4}">${g}°</text>`;
  const n = Math.min(6, Math.max(2, Math.floor((W - L) / 70)));
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    svg += `<text class="el-ax t" x="${x(t)}" y="${H - 4}">${satTime(t)}</text>`;
  }
  svg += `<polyline class="el-line" points="${s.map((p) => `${x(p.t).toFixed(1)},${y(p.el).toFixed(1)}`).join(" ")}"/>`;
  svg += `<line class="el-now" id="satElNow" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
  svg += `<line class="el-hover" id="satElHover" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
  if (track) svg += `<text class="el-rot" id="satElRotT" visibility="hidden"></text><g class="pg-rot" id="satElRotX" visibility="hidden"><line x1="-5" y1="-5" x2="5" y2="5"/><line x1="-5" y1="5" x2="5" y2="-5"/></g><g class="pg-aim" id="satElAimX" visibility="hidden"><line x1="-5" y1="-5" x2="5" y2="5"/><line x1="-5" y1="5" x2="5" y2="-5"/></g>`;
  svg += `<rect class="el-hit" x="${L}" y="0" width="${W - L - 8}" height="${H}"/></svg>`;
  box.innerHTML = svg + '<div class="satp-tip" id="satElTip" hidden></div>';
  box._x = x; box._t = (px) => t0 + ((px - L) / (W - L - 8)) * (t1 - t0);
  box._y = y; box._el = (py) => Math.round(Math.min(Math.max((1 - (py - T) / (H - T - B)) * TOP, 0), TOP));
  box._t0 = t0; box._t1 = t1;
  satPolarRotor();
}

$("amsatBody").addEventListener("mousemove", (e) => {
  const box = $("satElChart");
  if (!box || !satDetail || !e.target.classList.contains("el-hit")) return;
  const rect = box.getBoundingClientRect(), px = e.clientX - rect.left, t = box._t(px);
  const p = satDetail.samples.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const line = $("satElHover"), tip = $("satElTip");
  line.setAttribute("x1", box._x(p.t)); line.setAttribute("x2", box._x(p.t)); line.setAttribute("visibility", "visible");
  tip.hidden = false;
  tip.textContent = `${satTime(p.t)}  el ${p.el.toFixed(1)}°  az ${Math.round(p.az)}°  ${Math.round(p.range)} km`;
  tip.style.left = `${Math.min(Math.max(box._x(p.t) - 80, 0), rect.width - 200)}px`;
  const aim = $("satElAimX");
  if (aim) {     // TRACK: the elevation a click would set
    const py = e.clientY - rect.top, el = box._el(py), refusal = satDialRefusal(satInfo);
    aim.setAttribute("visibility", refusal ? "hidden" : "visible");
    aim.setAttribute("transform", `translate(${px.toFixed(1)},${box._y(el).toFixed(1)})`);
    tip.textContent += refusal ? `  ·  ${refusal}` : `  ·  click: antenna EL ${el}°`;
    e.target.style.cursor = refusal ? "not-allowed" : "crosshair";
  }
});
$("amsatBody").addEventListener("click", (e) => {
  const box = $("satElChart");
  if (!box || !$("satElAimX") || !e.target.classList.contains("el-hit")) return;
  const el = box._el(e.clientY - box.getBoundingClientRect().top), refusal = satDialRefusal(satInfo);
  if (refusal) { amsatInfo(refusal, true); return; }
  const az = satInfo.target ? satInfo.target[0] : satInfo.az;     // the azimuth stays, as before
  rotorPost({ goto: [Math.round(az), el] });
  amsatInfo(`Antenna to EL ${el}° (AZ stays ${Math.round(az)}°)`);
});
$("amsatBody").addEventListener("mouseout", (e) => {
  if (!e.target.classList || !e.target.classList.contains("el-hit")) return;
  const line = $("satElHover"), tip = $("satElTip");
  if (line) line.setAttribute("visibility", "hidden");
  if (tip) tip.hidden = true;
  if ($("satElAimX")) $("satElAimX").setAttribute("visibility", "hidden");
});

/** The antenna on the polar plot (red cross); above 90 degrees of elevation it looks back over the top. */
function satPolarRotor() {
  const x = $("satRotX"), info = satInfo;
  if (!x) return;
  if (!info || info.az == null || info.el == null) {
    x.setAttribute("visibility", "hidden");
    for (const id of ["satElRotX", "satElRotT"]) if ($(id)) $(id).setAttribute("visibility", "hidden");
    return;
  }
  const back = info.el > 90, [px, py] = satPolarXY(back ? (info.az + 180) % 360 : info.az, back ? 180 - info.el : info.el, 100);
  x.setAttribute("transform", `translate(${px.toFixed(1)},${py.toFixed(1)})`);
  x.setAttribute("visibility", "visible");
  const ex = $("satElRotX"), box = $("satElChart");
  if (ex && box && box._x) {     // the elevation the antenna looks at now (flipped: 180 − el, over the top), at the time now
    const lookEl = back ? 180 - info.el : info.el;
    const now = Math.min(Math.max(Date.now() / 1000, box._t0), box._t1), X = box._x(now), Y = box._y(lookEl);
    ex.setAttribute("transform", `translate(${X.toFixed(1)},${Y.toFixed(1)})`);
    ex.setAttribute("visibility", "visible");
    const t = $("satElRotT");      // the elevation it looks at; flipped: the real elevation of the rotor in brackets
    if (t) {
      t.textContent = back ? `EL ${Math.round(lookEl)}° (flipped ${Math.round(info.el)}°)` : `EL ${Math.round(info.el)}°`;
      t.setAttribute("x", (X + 9).toFixed(1)); t.setAttribute("y", (Y - 7).toFixed(1));
      t.setAttribute("visibility", "visible");
    }
  }
}

/** Polar plot point -> [az, el] in whole degrees, null outside the horizon. */
function satPolarAt(e) {
  const svg = e.target.ownerSVGElement;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  const r = Math.hypot(p.x, p.y);
  if (r > 100) return null;
  return [Math.round((Math.atan2(p.x, -p.y) * 180 / Math.PI + 360) % 360), Math.round(90 * (1 - r / 100))];
}

$("amsatBody").addEventListener("pointermove", (e) => {
  if (e.target.id !== "satPolarHit") return;
  const at = satPolarAt(e), x = $("satAimX"), refusal = satDialRefusal(satInfo);
  if (!at || refusal) { x.setAttribute("visibility", "hidden"); e.target.style.cursor = refusal ? "not-allowed" : ""; if (refusal) $("satPolarNote").textContent = refusal; return; }
  const [px, py] = satPolarXY(at[0], at[1], 100);
  x.setAttribute("transform", `translate(${px.toFixed(1)},${py.toFixed(1)})`);
  x.setAttribute("visibility", "visible");
  e.target.style.cursor = "crosshair";
  $("satPolarNote").textContent = `Click: turn the antenna to AZ ${at[0]}° EL ${at[1]}°.`;
});
$("amsatBody").addEventListener("pointerout", (e) => {
  if (e.target.id === "satPolarHit") $("satAimX").setAttribute("visibility", "hidden");
});
$("amsatBody").addEventListener("click", (e) => {
  if (e.target.id !== "satPolarHit") return;
  const at = satPolarAt(e), refusal = satDialRefusal(satInfo);
  if (!at) return;
  if (refusal) { amsatInfo(refusal, true); return; }
  rotorPost({ goto: at });
  amsatInfo(`Antenna to AZ ${at[0]}° EL ${at[1]}°`);
});

/** Position now, when the chosen pass is on: interpolated between the samples. */
/** Countdown for the big AOS / LOS line on the TRACK page: "2:45" under an hour, "1 h 05 min" above. */
function satCountdown(t) {
  const s = Math.max(0, Math.round(t - Date.now() / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m}:${String(sec).padStart(2, "0")}`;
}

function satTickNow() {
  const d = satDetail, dot = $("satNowDot");
  if (!d || !dot) return;
  const now = Date.now() / 1000, s = d.samples;
  const on = now >= s[0].t && now <= s[s.length - 1].t;
  const count = $("satCount");      // TRACK page: AOS in … / LOS in … in big letters beside the rotor keys
  if (count) {
    count.innerHTML = now < s[0].t ? `AOS in <b>${satCountdown(s[0].t)}</b>`
      : on ? `LOS in <b>${satCountdown(s[s.length - 1].t)}</b>` : "the pass is over";
    count.classList.toggle("live", on);
  }
  dot.setAttribute("visibility", on ? "visible" : "hidden");
  const line = $("satElNow"), box = $("satElChart");
  if (line) line.setAttribute("visibility", on ? "visible" : "hidden");
  if (!on) {
    $("satNowText").textContent = now < s[0].t ? `AOS ${satUntil(s[0].t)}` : "the pass is over";
    return;
  }
  const i = Math.min(s.findIndex((p) => p.t > now), s.length - 1), a = s[Math.max(i - 1, 0)], b = s[i];
  const f = b.t > a.t ? (now - a.t) / (b.t - a.t) : 0;
  const az = a.az + ((((b.az - a.az + 540) % 360) - 180) * f), el = a.el + (b.el - a.el) * f;
  const [x, y] = satPolarXY(((az % 360) + 360) % 360, el, 100);
  dot.setAttribute("cx", x.toFixed(1)); dot.setAttribute("cy", y.toFixed(1));
  if (line && box._x) { line.setAttribute("x1", box._x(now)); line.setAttribute("x2", box._x(now)); }
  const rate = a.rate + (b.rate - a.rate) * f;
  $("satNowText").textContent = `az ${Math.round(((az % 360) + 360) % 360)}°, el ${el.toFixed(1)}°, ${rate < 0 ? "approaching" : "going away"}, LOS ${satUntil(s[s.length - 1].t)}`;
}

setInterval(() => {
  if (bodyTab !== "sat" || amsatPage !== "passes" || document.hidden) return;
  satTickNow();
  if (satData && Date.now() - satLoadedAt > 60000) satLoad();     // the timeline starts at "now"
}, 1000);

// ---------- TRACK: Doppler correction of the receive frequency on this VFO ----------

let satTrackNorad = Number(recall("satTrackNorad")) || null;
let satTrackPicked = false;  // chosen by hand (list, MAP, PASSES): not replaced by the satellite of a running Doppler or rotor

/** MAP and PASSES: this satellite on the TRACK page; one that is not on the timeline is added to it (SETUP). */
async function satOpenTrack(norad) {
  satTrackNorad = norad;
  satTrackPicked = true;
  store("satTrackNorad", norad);
  if (satData && !satData.sats.some((s) => s.norad === norad)) {
    try {
      const sats = [...new Set([...satData.sats.map((s) => s.norad), norad])];
      await satFetch("/api/sat/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sats }) });
      if (satSetupData) satSetupData.setup.sats = sats;
      satData = null;     // the timeline is calculated again, with this satellite
      amsatInfo("Added to the timeline (SETUP)");
    } catch (err) { amsatInfo(err.message, true); }
  }
  amsatPage = "track";
  store("amsatPage", amsatPage);
  renderSatTab();
}
let satTx = null;            // /api/sat/transmitters of satTrackNorad
let satDop = null;           // /api/sat/doppler
let satDopBusy = false;

const satMHz = (hz, d = 4) => (hz == null ? "–" : (hz / 1e6).toFixed(d));
const satHz = (hz) => (hz == null ? "–" : `${hz > 0 ? "+" : hz < 0 ? "−" : ""}${Math.abs(Math.round(hz)).toLocaleString()} Hz`);

async function satTrackPoll() {
  if (satDopBusy) return;
  satDopBusy = true;
  try {
    satDop = await satFetch("/api/sat/doppler");
    renderSatTrackLive();
  } catch (e) {
    const box = $("satDopLive");
    if (box) box.innerHTML = `<p class="error">${escHtml(e.message)}</p>`;
  }
  satDopBusy = false;
}

/** The next (or current) pass of the tracked satellite, for the sky plot. */
function satTrackPass() {
  const now = Date.now() / 1000;
  return satData && satData.passes.find((p) => p.norad === satTrackNorad && p.los > now);
}

async function renderSatTrack() {
  if (!satData) { satLoad(); return; }      // renders this page when the passes are calculated
  satInfoLine();
  await Promise.all([satTrackPoll(), satRotPoll()]);      // also after a VFO switch: both work per VFO
  if (amsatPage !== "track") return;
  if (!satTrackPicked && satRot && satRot.on) satTrackNorad = satRot.norad;
  else if (!satTrackPicked && satDop && satDop.on) satTrackNorad = satDop.norad;
  const sats = satData.sats.filter((s) => !s.missing);
  if (!sats.some((s) => s.norad === satTrackNorad)) satTrackNorad = (satSel && satSel.norad) || (sats[0] && sats[0].norad) || null;
  const body = $("amsatBody");
  body.classList.add("satp-on");
  body.innerHTML = `<div class="satt">
    <div class="sats-row"><label>Satellite <select id="satTrackSat">${sats.map((s) => `<option value="${s.norad}"${s.norad === satTrackNorad ? " selected" : ""}>${escHtml(satShort(s.name))} · ${escHtml(s.name)}</option>`).join("")}</select></label>
      <span class="muted small">The satellites of the timeline (SETUP). Doppler and rotor work on this VFO and go on when the page is closed.</span></div>
    <div class="satp-lower">
      <div class="satt-left">
        <h4>Doppler (receive)</h4>
        <div class="satt-live" id="satDopLive"></div>
        <div class="satt-tx-wrap"><table class="satp-list satt-tx" id="satTxList"><tbody><tr><td class="muted">Loading transmitters…</td></tr></tbody></table></div>
        <p class="muted small">A click on a transmitter tunes this VFO to it, sets its mode and keeps it corrected for the Doppler shift; OFF stops the correction.
          Received = sent × (1 − range rate / c), calculated every 0.25 s; the VFO is retuned when it is off by more than 5 Hz (all modes), at most once a second.
          Tuning the VFO by hand moves the frequency within the transponder and the correction keeps it; tuning more than 50 kHz outside the transponder stops it.
          Transmitters: <a href="https://db.satnogs.org/" target="_blank" rel="noopener noreferrer">SatNOGS DB</a>, downloaded again after 7 days.</p>
      </div>
      <div class="satt-right">
        <div class="satt-rhead"><h4>Rotor</h4><span class="flag dim satt-flag" id="satRotFlag">NOT TRACKING</span>
          <button class="key small" id="satRotStart" title="On: plan the next pass of this satellite, turn the rotor to its start in time and follow it (turns the rotor link on). Off: tracking ends, the rotor stays">TRACK</button>
          <span id="satPanelSlot"></span><span class="satt-count" id="satCount"></span></div>
        <div class="satt-live satt-rot" id="satRotBox"></div>
        <div class="satp-detail" id="satDetail"><p class="muted">No pass of this satellite in the next ${satData.hours} hours.</p></div>
      </div>
    </div></div>`;
  renderSatTrackLive();
  renderSatRot();
  $("satPanelSlot").append(satPanel);
  satPanel.hidden = false;
  pollRotor();
  satTxLoad();
  const p = satTrackPass();
  if (p) satShowDetail({ norad: p.norad, aos: p.aos, los: p.los }, false);
}

async function satTxLoad(refresh = false) {
  const norad = satTrackNorad;
  if (!norad) return;
  if (!satTx || satTx.norad !== norad || refresh) {
    try {
      satTx = { norad, ...(await satFetch(`/api/sat/transmitters?norad=${norad}${refresh ? "&refresh=1" : ""}`)) };
    } catch (e) {
      const list = $("satTxList");
      if (list) list.innerHTML = `<tbody><tr><td class="error">${escHtml(e.message)}</td></tr></tbody>`;
      return;
    }
  }
  renderSatTxList();
}

function renderSatTxList() {
  const list = $("satTxList");
  if (!list || !satTx || satTx.norad !== satTrackNorad) return;
  const rows = satTx.transmitters;
  const pick = satDop && satDop.on && satDop.norad === satTrackNorad ? satDop.uuid : "";     // the one the correction follows
  const range = (t) => (t.downlink_high && t.downlink_high !== t.downlink_low
    ? `${satMHz(t.downlink_low, 3)}–${satMHz(t.downlink_high, 3)}` : satMHz(t.downlink_low, 4));
  list.innerHTML = `<thead><tr><th></th><th>Downlink MHz</th><th>Mode</th><th>Type</th><th>Description</th></tr></thead><tbody>
    <tr data-uuid=""${pick ? "" : ' class="sel"'}><td><input type="radio" name="satTx" value=""${pick ? "" : " checked"}></td><td colspan="4"><b>OFF</b> <span class="muted">no Doppler correction</span></td></tr>`
    + rows.map((t) => `<tr data-uuid="${escHtml(t.uuid)}"${t.uuid === pick ? ' class="sel"' : ""}>
      <td><input type="radio" name="satTx" value="${escHtml(t.uuid)}"${t.uuid === pick ? " checked" : ""}></td>
      <td>${range(t)}</td><td>${escHtml(t.mode || "")}${t.rx_mode !== t.mode ? ` <span class="muted">→ ${t.rx_mode}</span>` : ""}</td>
      <td>${escHtml(t.type || "")}${t.invert ? " <span class=\"muted\">inv.</span>" : ""}</td><td class="satt-desc">${escHtml(t.description || "")}</td></tr>`).join("")
    + "</tbody>";
  if (!rows.length) {
    list.innerHTML = `<tbody><tr><td class="muted">SatNOGS has no active transmitter of this satellite${satTx.error ? ` (download failed: ${escHtml(satTx.error)})` : ""}.</td></tr></tbody>`;
  }
  satTxShown = pick;
}
let satTxShown = "";     // the transmitter checked in the list, to redraw it only when the correction changes

function renderSatTrackLive() {
  const box = $("satDopLive");
  if (!box) return;
  const d = satDop;
  const pick = d && d.on && d.norad === satTrackNorad ? d.uuid : "";
  if (pick !== satTxShown && satTx && satTx.norad === satTrackNorad) renderSatTxList();
  if (!d) { box.innerHTML = '<p class="muted">Loading…</p>'; return; }
  if (!d.on) {
    box.innerHTML = `<p><b>Doppler correction is off.</b>${d.stopped ? ` <span class="${d.stopped === "stopped by hand" ? "muted" : "error"}">Stopped: ${escHtml(d.stopped)}</span>` : ""}</p>`;
    return;
  }
  const off = d.f_sat - d.f_nominal, up = d.el != null && d.el > 0;
  const lag = d.last_set != null && d.f_rx != null ? d.f_rx - d.last_set : null;
  box.innerHTML = `<table class="satp-facts">
    <tr><th>Tracking</th><td><b class="satt-sat">${escHtml(satShort(d.name))}</b> ${escHtml(d.label || "")}</td></tr>
    <tr><th>Satellite sends</th><td><b>${satMHz(d.f_sat, 6)} MHz</b>${Math.abs(off) >= 1 ? ` <span class="muted">(${satHz(off)} from ${satMHz(d.f_nominal, 6)}, tuned by hand)</span>` : ""}</td></tr>
    <tr><th>VFO tuned to</th><td><b>${satMHz(d.last_set, 6)} MHz</b> · Doppler ${satHz(d.shift)}</td></tr>
    <tr><th>Exact now</th><td>${satMHz(d.f_rx, 6)} MHz${lag != null ? ` <span class="muted">(${satHz(lag)} from the VFO; retuned beyond ±${d.step >= 1000 ? `${d.step / 1000} kHz` : `${d.step} Hz`})</span>` : ""}</td></tr>
    <tr><th>Now</th><td>${d.az != null ? `az ${Math.round(d.az)}°, el ${d.el.toFixed(1)}°` : "–"}${up ? "" : " <span class=\"muted\">(below the horizon)</span>"}
      · ${d.rate != null ? `${d.rate < 0 ? "approaching" : "going away"} ${Math.abs(d.rate).toFixed(2)} km/s` : ""}</td></tr>
    ${d.error ? `<tr><th>Error</th><td class="error">${escHtml(d.error)}</td></tr>` : ""}</table>`;
}

let satRot = null;           // /api/sat/rotor
let satRotBusy = false;
const SAT_ROT_MODES = {
  normal: "normal: azimuth within K3NG 0–360°",
  overlap: "overlap: azimuth through north past 360° (K3NG up to 450°)",
  flipped: "flipped: azimuth + 180°, elevation 180° − el, the antenna looks back over the top",
  "over top": "over the top: azimuth stands, elevation 0 → 180°",
};
const satClock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

async function satRotPoll() {
  if (satRotBusy) return;
  satRotBusy = true;
  try {
    satRot = await satFetch("/api/sat/rotor", undefined, rotorBase());
    renderSatRot();
  } catch (e) {
    const box = $("satRotBox");
    if (box) box.innerHTML = `<p class="error">${escHtml(e.message)}</p>`;
  }
  satRotBusy = false;
}

function renderSatRot() {
  const box = $("satRotBox"), d = satRot;
  if (!box) return;
  const other = !!(d && d.on && d.norad !== satTrackNorad);     // the rotor follows another satellite than the one shown
  const mine = !!(d && d.on) && !other;
  const linked = !(d && d.linked === false);     // RCTRL › CONNECTION: SAT TRACKER connected to the rotor
  const moving = mine && linked && !!(satInfo && satInfo.on && satInfo.control);     // the rotor link is on and takes the commands
  $("satRotStart").classList.toggle("on", mine);
  const flag = $("satRotFlag");
  const [text, cls, tip] = moving ? ["TRACKING", "", "The rotor follows this satellite"]
    : mine && !linked ? ["CALC ONLY", "warn", "TRACK only calculates: SAT TRACKER is disconnected from the rotor in RCTRL › CONNECTION"]
    : mine ? ["CALC ONLY", "warn", "TRACK only calculates: the rotor link is off or the rotor was stopped (STOP, a fault). TRACK off and on again moves it"]
    : ["NOT TRACKING", "dim", other ? "The rotor follows another satellite" : "TRACK is off"];
  if (flag.textContent !== text) flag.textContent = text;
  flag.className = `flag satt-flag ${cls}`;
  flag.title = tip;
  if (!d) { box.innerHTML = '<p class="muted">Loading…</p>'; return; }
  if (other) {
    const shown = satData && satData.sats.find((s) => s.norad === satTrackNorad);
    box.innerHTML = `<p><b>The rotor follows ${escHtml(satShort(d.name))}</b> (${escHtml(d.state)}).
      <span class="muted">TRACK switches it to ${escHtml(shown ? satShort(shown.name) : String(satTrackNorad))}.</span></p>`;
    return;
  }
  if (!d.on) {
    box.innerHTML = `<p><b>Tracking with the rotor is off.</b> <span class="muted">TRACK plans the next pass and moves the rotor${d.rotor_on ? "" : " (it turns the rotor link on, with the port chosen in SETTINGS › GENERAL › ROTOR)"}.</span>
      ${d.stopped ? `<span class="${d.stopped === "stopped by hand" ? "muted" : "error"}">Stopped: ${escHtml(d.stopped)}</span>` : ""}</p>`;
    return;
  }
  const p = d.pass, pl = d.plan, n = d.now || {};
  let html = `<table class="satp-facts"><tr><th>Tracking</th><td><b class="satt-sat">${escHtml(satShort(d.name))}</b> · ${escHtml(d.state)}${p ? `
    · ${satDay(p.aos)} ${satClock(p.aos)} – ${satClock(p.los)}, max. ${p.max_el}°` : ""}${d.state === "waiting for the pass" && d.prep_at ? ` · turns to the start at ${satClock(d.prep_at)}` : ""}</td></tr>`;
  if (p && pl) {
    const others = pl.options.filter((o, i, a) => o.mode !== pl.mode && a.findIndex((x) => x.mode === o.mode) === i);
    html += `<tr><th>Plan</th><td><span title="${escHtml(SAT_ROT_MODES[pl.mode] || pl.mode)}"><b>${escHtml(pl.mode)}</b></span>,
      K3NG ${Math.round(pl.raw0)}° → ${Math.round(pl.raw1)}° (${Math.round(pl.raw_min)}–${Math.round(pl.raw_max)}°), el up to ${Math.round(pl.el_max)}°,
      error up to ${pl.max_err}° (mean ${pl.mean_err}°)${others.length ? ` <span class="muted">· other ways: ${others.map((o) => `${o.mode} ${o.max_err}°`).join(", ")}</span>` : ""}</td></tr>`;
  }
  if (n.cmd_az != null) html += `<tr><th>Command</th><td>az ${Math.round(n.cmd_az)}° (K3NG ${Math.round(n.cmd_raw)}°), el ${Math.round(n.cmd_el)}°</td></tr>`;
  if (n.sat_az != null) html += `<tr><th>Satellite</th><td>az ${Math.round(n.sat_az)}°, el ${n.sat_el.toFixed(1)}°${n.err != null ? ` · the antenna is ${n.err}° off` : ""}</td></tr>`;
  if (d.note) html += `<tr><th>Rotor</th><td class="${d.control && d.rotor_on ? "error" : "muted"}">${escHtml(d.note)}</td></tr>`;
  box.innerHTML = html + "</table>";
}

async function satRotSend(body) {
  try {
    satRot = await satFetch("/api/sat/rotor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, rotorBase());
    amsatInfo(satRot.on ? `Rotor tracking: ${satShort(satRot.name)}` : "Rotor tracking off");
  } catch (e) {
    if (body.start && !body.start.force && /days old/.test(e.message) && confirm(`${e.message}\n\nTrack anyway?`)) {
      return satRotSend({ start: { ...body.start, force: true } });
    }
    amsatInfo(e.message, true);
    renderSatRot();
    return false;
  }
  renderSatRot();
  return true;
}

/** The one TRACK key: on = the tracker plans the passes and the rotor control is on (the link too),
 *  off = the tracker ends and the rotor stops. While the rotor follows another satellite, it switches to the shown one. */
async function satTrackToggle() {
  if (satRot && satRot.on && satRot.norad === satTrackNorad) {
    await satRotSend({ stop: true });
    await rotorPost({ stop: true });
  } else if (await satRotSend({ start: { norad: satTrackNorad } })) {
    if (!(satInfo && satInfo.on && satInfo.control)) await rotorPost({ start: true });
  }
  renderSatRot();
}

async function satDopSend(body) {
  try {
    satDop = await satFetch("/api/sat/doppler", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    amsatInfo(satDop.on ? `Doppler correction on: ${satShort(satDop.name)} ${satDop.label || ""}` : "Doppler correction off");
  } catch (e) {
    amsatInfo(e.message, true);
  }
  renderSatTrackLive();
}

$("amsatBody").addEventListener("change", (e) => {
  if (e.target.id === "satTrackSat") {
    satTrackNorad = Number(e.target.value);
    satTrackPicked = true;
    store("satTrackNorad", satTrackNorad);
    renderSatTrack();
  } else if (e.target.name === "satTx") {
    for (const tr of document.querySelectorAll(".satt-tx tr.sel")) tr.classList.remove("sel");
    const tr = e.target.closest("tr");
    if (tr) tr.classList.add("sel");
    satDopSend(e.target.value ? { start: { norad: satTrackNorad, uuid: e.target.value }, set_mode: true } : { stop: true });
  }
});

$("amsatBody").addEventListener("click", (e) => {
  const tr = e.target.closest(".satt-tx tr[data-uuid]");
  if (tr && e.target.type !== "radio") {
    const r = tr.querySelector('input[name="satTx"]');
    if (!r.checked) {
      r.checked = true;
      r.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  // on: off; off, or on with another satellite: tracks the shown one (the server ends the old tracking first)
  if (e.target.id === "satRotStart") satTrackToggle();
});

setInterval(() => {
  if (bodyTab !== "sat" || amsatPage !== "track" || document.hidden) return;
  satTrackPoll();
  satRotPoll();
  satTickNow();
  if (satData && Date.now() - satLoadedAt > 300000) satLoad();
}, 1000);

// ---------- SETUP ----------

async function satSetupLoad(body) {
  try {
    satSetupData = await satFetch("/api/sat/setup", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    satData = satMapData = null;      // passes and the map depend on the setup
    if (amsatPage === "setup") renderSatSetup();
    return true;
  } catch (e) {
    amsatInfo(e.message, true);
    return false;
  }
}

function renderSatSetup() {
  if (!satSetupData) { amsatInfo("Loading…"); satSetupLoad(); return; }
  const d = satSetupData, s = d.setup;
  amsatInfo(d.tle.fetched ? `${d.sats.length} satellites in the orbital elements from ${new Date(d.tle.fetched * 1000).toLocaleString()}` : "No orbital elements yet", !d.tle.fetched || !!d.tle.error);
  const body = $("amsatBody");
  body.classList.add("satp-on");
  const chosen = new Set(s.sats);
  body.innerHTML = `<div class="sats-setup">
    <section><h4>Station</h4>
      <div class="sats-row"><span>${escHtml(s.locator)} · ${s.lat.toFixed(4)}°, ${s.lon.toFixed(4)}° · ${Math.round(s.alt_m)} m</span>
        <span class="muted small">set in SETTINGS › GENERAL › LOCATION (shared with packet, HFDL and AIS)</span>
        <button class="key small" id="satLocGo" title="Open SETTINGS › GENERAL › LOCATION">LOCATION…</button></div>
      ${s.lat === 0 && s.lon === 0 ? `<p class="error small">The station location is not set yet (0.0 / 0.0): passes and Doppler are computed for that point.</p>` : ""}
      <div class="sats-row"><label>Passes from <input id="satMinEl" type="number" min="0" max="60" step="1" value="${s.min_el}">° of elevation</label>
        <button class="key small" id="satSaveQth">SAVE</button></div></section>
    <section><h4>Orbital elements</h4>
      <p>CelesTrak, ${(d.groups || []).length} groups (tabs below): ${d.sats.length} satellites${d.tle.fetched ? `, downloaded ${new Date(d.tle.fetched * 1000).toLocaleString()}` : ""}. Downloaded again after 24 hours.
        ${d.tle.error ? `<span class="error">Last download failed: ${escHtml(d.tle.error)}</span>` : ""}</p>
      <button class="key small" id="satTleNow">DOWNLOAD NOW</button></section>
    <section><h4>Satellites on the timeline <span class="muted small" id="satChosenCount">(${chosen.size} chosen)</span></h4>
      <div class="sats-row"><button class="key small" id="satSelActive" title="Tick the satellites of the AMSAT lists LINEAR, FM, IMAGE and MISC (matched by name; the others stay ticked)">SELECT ACTIVE</button>
        <button class="key small" id="satSelNone" title="Untick all satellites">CLEAR</button>
        <span class="muted small" id="satSelNote"></span></div>
      <div class="sats-tabs" id="satGroupTabs">${[{ key: "chosen", title: "Chosen" }, ...(d.groups || [])].map((g) => `<button class="key small${g.key === satGroup ? " on" : ""}" data-group="${g.key}">${escHtml(g.title)}
        <span class="muted">${g.key === "chosen" ? chosen.size : d.sats.filter((x) => (x.groups || ["amateur"]).includes(g.key)).length}</span></button>`).join("")}</div>
      <input id="satFilter" placeholder="Filter by name or NORAD number" size="30">
      <div class="sats-list" id="satChoice">${[...d.sats].sort((a, b) => (chosen.has(b.norad) - chosen.has(a.norad))
        || satShort(a.name).localeCompare(satShort(b.name), undefined, { numeric: true })).map((x) => `<label class="${x.tle_age_days > 7 ? "old" : ""}" data-groups="${(x.groups || ["amateur"]).join(" ")}"><input type="checkbox" value="${x.norad}"${chosen.has(x.norad) ? " checked" : ""}>
        <b>${escHtml(satShort(x.name))}</b> <span class="muted">${escHtml(x.name)} · ${x.norad} · ${x.tle_age_days} d</span></label>`).join("")}</div></section></div>`;
  satChoiceFilter();
}

/** Name -> keys for matching the AMSAT lists with the orbital elements: "AO-7 Mode A" and "OSCAR 7 (AO-7)" both give
 *  AO7, "AO-91 / (RadFxSat / Fox-1B)" gives AO91, RADFXSAT and FOX1B. Leading zeros go (AO-07 = AO-7). */
function satNameKeys(text) {
  const keys = new Set();
  for (const part of text.toUpperCase().replace(/\u2013/g, "-").split(/[()/,&]|\bAND\b|\bOR\b/)) {
    const k = part.replace(/\bMODE\b.*$/, "").replace(/([A-Z])-?0+(\d)/g, "$1$2").replace(/[^A-Z0-9]+/g, "");
    if (k.length >= 3) keys.add(k);
  }
  return keys;
}

/** The satellites of the AMSAT lists (first column of their tables), as names; "TEVEL2-1 thru TEVEL2-9" is expanded. */
function amsatActiveNames() {
  const names = new Set();
  for (const page of amsatPages || []) {
    const doc = new DOMParser().parseFromString(page.html || "", "text/html");
    for (const td of doc.querySelectorAll("tbody tr > td:first-child")) {
      for (const br of td.querySelectorAll("br")) br.replaceWith(" / ");
      const text = td.textContent.replace(/\s+/g, " ").trim();
      const thru = text.match(/^(.*?)(\d+)\s+thru\s+\1(\d+)$/i);
      if (thru) for (let i = Number(thru[2]); i <= Number(thru[3]); i++) names.add(thru[1] + i);
      else if (text) names.add(text);
    }
  }
  return [...names];
}

/** SELECT ACTIVE: ticks the satellites of the AMSAT lists that are in the orbital elements. */
async function satSelectActive() {
  if (!amsatPages) { $("satSelNote").textContent = "Loading the AMSAT lists…"; await amsatLoad(); }
  const names = amsatActiveNames();
  if (!names.length) { $("satSelNote").textContent = "The AMSAT lists are not available (LINEAR, FM, IMAGE, MISC need internet once)."; return; }
  const byKey = new Map();
  for (const x of satSetupData.sats) for (const k of satNameKeys(x.name)) byKey.set(k, [...(byKey.get(k) || []), x.norad]);
  const found = new Set(), missing = [];
  for (const n of names) {
    const hits = [...satNameKeys(n)].flatMap((k) => byKey.get(k) || []);
    if (hits.length) hits.forEach((h) => found.add(h)); else missing.push(n.split(" / ")[0]);
  }
  let added = 0;
  for (const i of document.querySelectorAll("#satChoice input")) {
    if (found.has(Number(i.value)) && !i.checked) { i.checked = true; added++; }
  }
  satChoiceSave();
  satChoiceFilter();
  $("satSelNote").textContent = `${found.size} active satellites found, ${added} newly ticked.`
    + (missing.length ? ` Not in the orbital elements: ${missing.join(", ")}.` : "");
}

/** Shows the satellites of the chosen tab that match the filter; the others stay in the list, hidden (their ticks count). */
function satChoiceFilter() {
  const q = ($("satFilter")?.value || "").trim().toLowerCase();
  for (const l of document.querySelectorAll("#satChoice label")) {
    const inTab = satGroup === "chosen" ? l.querySelector("input").checked : l.dataset.groups.split(" ").includes(satGroup);
    l.hidden = !inTab || (!!q && !l.textContent.toLowerCase().includes(q));
  }
}

$("amsatBody").addEventListener("click", async (e) => {
  const hb = e.target.closest("#satHours button[data-hours]");
  if (hb) {
    satHours = Number(hb.dataset.hours);
    store("satHours", satHours);
    satData = null;
    satLoad();
    return;
  }
  const pass = e.target.closest(".tl-pass, .satp-list tr[data-norad]");
  if (pass) {
    satShowDetail({ norad: Number(pass.dataset.norad), aos: Number(pass.dataset.aos), los: Number(pass.dataset.los) });
    return;
  }
  if (e.target.id === "satSaveQth") {
    if (await satSetupLoad({ min_el: Number($("satMinEl").value) })) amsatInfo("Saved");
    return;
  }
  if (e.target.id === "satLocGo") {
    openLocationSetup();
    return;
  }
  if (e.target.id === "satSelActive") { satSelectActive(); return; }
  if (e.target.id === "satSelNone") {
    for (const i of document.querySelectorAll("#satChoice input")) i.checked = false;
    $("satSelNote").textContent = "";
    satChoiceSave();
    satChoiceFilter();
    return;
  }
  if (e.target.id === "satTleNow") {
    amsatInfo("Downloading the orbital elements…");
    if (await satSetupLoad({ refresh_tle: true })) amsatInfo("Downloaded");
  }
});

$("amsatBody").addEventListener("change", (e) => {
  if (e.target.closest("#satChoice")) satChoiceSave();
});

/** Saves the ticked satellites of SETUP as the timeline. */
function satChoiceSave() {
  const sats = [...document.querySelectorAll("#satChoice input:checked")].map((i) => Number(i.value));
  satSetupData.setup.sats = sats;
  $("satChosenCount").textContent = `(${sats.length} chosen)`;
  const chosenTab = document.querySelector('#satGroupTabs [data-group="chosen"] .muted');
  if (chosenTab) chosenTab.textContent = sats.length;
  satFetch("/api/sat/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sats }) })
    .then(() => { satData = null; amsatInfo(`${sats.length} satellites on the timeline`); })
    .catch((err) => amsatInfo(err.message, true));
}

$("amsatBody").addEventListener("click", (e) => {
  const b = e.target.closest("#satGroupTabs button[data-group]");
  if (!b) return;
  satGroup = b.dataset.group;
  store("satGroup", satGroup);
  for (const x of document.querySelectorAll("#satGroupTabs button")) x.classList.toggle("on", x === b);
  satChoiceFilter();
});

$("amsatBody").addEventListener("input", (e) => {
  if (e.target.id !== "satFilter") return;
  satChoiceFilter();
});

window.addEventListener("resize", () => {
  if (bodyTab === "sat" && amsatPage === "passes" && satData) { renderSatTimeline(); renderSatElChart(); satTickNow(); }
  if (bodyTab === "sat" && amsatPage === "track" && satData) { renderSatElChart(); satTickNow(); }     // the chart fills the space beside the polar plot
});

// ---------- SATELLITES tab: MAP page (world map, footprints, ground track) and the station on an OpenStreetMap map ----------

let satMapData = null;       // /api/sat/map
let satMapAt = 0;
let satMapSel = Number(recall("satMapSel")) || null;   // NORAD of the satellite with the ground track and the info
let satMapBusy = false;
let satMapBase = null;       // land, borders and grid drawn once per size: {canvas, w, h}
const SAT_EARTH_KM = 6371;

/** Loads a script or stylesheet of static/ once (world map data, Leaflet). */
const satAssets = {};
function satAsset(url) {
  if (!satAssets[url]) {
    satAssets[url] = new Promise((ok, fail) => {
      const el = url.endsWith(".css") ? Object.assign(document.createElement("link"), { rel: "stylesheet", href: url })
        : Object.assign(document.createElement("script"), { src: url });
      el.onload = ok;
      el.onerror = () => { delete satAssets[url]; fail(new Error(`${url} did not load`)); };
      document.head.append(el);
    });
  }
  return satAssets[url];
}

function satLocator(lat, lon) {
  lon += 180; lat += 90;
  const A = (n) => String.fromCharCode(65 + n);
  return A(Math.floor(lon / 20)) + A(Math.floor(lat / 10)) + Math.floor((lon % 20) / 2) + Math.floor(lat % 10)
    + A(Math.floor((lon % 2) * 12)) + A(Math.floor((lat % 1) * 24));
}

async function satMapLoad() {
  if (satMapBusy) return;
  satMapBusy = true;
  try {
    const [data] = await Promise.all([satFetch("/api/sat/map"), satAsset("/static/world.js")]);
    satMapData = data;
    satMapAt = Date.now();
    if (!satMapData.sats.some((s) => s.norad === satMapSel)) satMapSel = satMapData.sats[0] ? satMapData.sats[0].norad : null;
    if (amsatPage === "map" && bodyTab === "sat") {
      if ($("satMapCanvas")) { renderSatMapChips(); satMapDraw(); } else renderSatMap();
    }
  } catch (e) {
    amsatInfo(`Map: ${e.message}`, true);
  }
  satMapBusy = false;
}

function renderSatMap() {
  if (!satMapData || typeof WORLD_LAND === "undefined") { amsatInfo("Loading the map…"); satMapLoad(); return; }
  const s = satMapData.setup;
  amsatInfo(`${s.locator} · ${satMapData.tle.fetched ? `orbital elements from ${new Date(satMapData.tle.fetched * 1000).toLocaleString()}` : "no orbital elements"}`, !satMapData.tle.fetched);
  const body = $("amsatBody");
  body.classList.add("satp-on");
  body.innerHTML = `<div class="satm">
      <div class="satm-chips" id="satMapChips"></div>
      <div class="satm-main">
        <div class="satm-wrap" id="satMapWrap"><canvas id="satMapCanvas"></canvas><div class="satp-tip" id="satMapTip" hidden></div></div>
        <div class="satm-side"><div class="satm-info" id="satMapInfo"></div><h4 class="satp-h">Transmitters</h4><div id="satMapTx"></div></div>
      </div>
      <p class="muted small">Footprint: where the satellite is above the horizon. Shaded: night. Ground track of the chosen satellite:
        dashed behind, solid ahead (one orbit). Map: Natural Earth.</p></div>`;
  satMapBase = null;
  if (!satData && !satBusy) {      // for the next pass of the chosen satellite, quietly
    satFetch(`/api/sat/passes?hours=${satHours}`).then((d) => { satData = d; satLoadedAt = Date.now(); }).catch(() => {});
  }
  renderSatMapChips();
  satMapDraw();
}

/** Keys of the satellites on the timeline: on = shown on the map; the name chooses the one with the ground track. */
function renderSatMapChips() {
  const box = $("satMapChips");
  if (!box || !satSetupLike()) return;
  const setup = satMapData.setup, on = new Set(setup.map_sats), names = satMapNames();
  const list = [...new Set([...setup.sats, ...setup.map_sats])];
  box.innerHTML = '<span class="muted small">On the map:</span>' + list.map((n) => {
    const name = names[n] || String(n);
    return `<button class="key small${on.has(n) ? " on" : ""}${n === satMapSel ? " sel" : ""}" data-map-norad="${n}" title="${escHtml(name)}: show or hide on the map; on: also shows its ground track">${escHtml(satShort(name))}</button>`;
  }).join("");
}

function satSetupLike() { return satMapData && satMapData.setup; }

/** NORAD -> name from what the page knows (map data, timeline, SETUP catalogue). */
function satMapNames() {
  const out = {};
  for (const src of [satSetupData && satSetupData.sats, satData && satData.sats, satMapData && satMapData.sats]) {
    for (const s of src || []) if (s.name) out[s.norad] = s.name;
  }
  return Object.assign(out, satMapData && satMapData.names);
}

/** Position of a satellite at time t, interpolated between the samples (longitude across the date line). */
function satMapAtTime(sat, t) {
  const s = sat.samples;
  if (!s.length || t < s[0][0] || t > s[s.length - 1][0]) return null;
  let i = 1;
  while (i < s.length - 1 && s[i][0] < t) i++;
  const a = s[i - 1], b = s[i], f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0, mix = (k) => a[k] + (b[k] - a[k]) * f;
  const dlon = ((b[2] - a[2] + 540) % 360) - 180, daz = ((b[4] - a[4] + 540) % 360) - 180;
  return { lat: mix(1), lon: ((a[2] + dlon * f + 540) % 360) - 180, alt: mix(3), az: (a[4] + daz * f + 360) % 360, el: mix(5), range: mix(6), rate: mix(7) };
}

/** Sun position (low precision, ~0.1 degree): the point below the sun, for the night shading. */
function satSubsolar(t) {
  const n = t / 86400 - 10957.5, rad = Math.PI / 180;
  const L = 280.46 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * rad;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, eps = (23.439 - 0.0000004 * n) * rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam)), ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  return { lat: dec / rad, lon: ((((ra / rad - gmst) % 360) + 540) % 360) - 180 };
}

/** Circle on the Earth around (lat, lon) with an angular radius -> [lon, lat] points, unwrapped in longitude.
 *  When it contains a pole, two more points close it along the map edge (filled, not outlined). */
function satCircle(lat, lon, radiusDeg, n = 90) {
  const rad = Math.PI / 180, la = lat * rad, d = radiusDeg * rad, pts = [];
  let prev = null, shift = 0;
  for (let i = 0; i <= n; i++) {
    const b = (i / n) * 2 * Math.PI;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    let lo2 = lon + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2)) / rad;
    if (prev !== null) {
      while (lo2 + shift - prev > 180) shift -= 360;
      while (lo2 + shift - prev < -180) shift += 360;
    }
    prev = lo2 + shift;
    pts.push([prev, la2 / rad]);
  }
  const span = pts[pts.length - 1][0] - pts[0][0];
  if (Math.abs(span) > 180) {        // around a pole: close along the map edge
    const pole = lat > 0 ? 90 : -90, last = pts[pts.length - 1][0];
    return { pts, fill: [...pts, [last, pole], [pts[0][0], pole]] };
  }
  return { pts, fill: pts };
}

function satMapSize() {
  const wrap = $("satMapWrap"), room = $("amsatBody").clientHeight - 110;     // the keys above and the note below stay visible
  const full = wrap.parentElement.clientWidth, side = full >= 900 ? 370 : 0;     // the details go beside the map when there is room
  const w = Math.max(Math.min(full - side, 2 * room), 320), h = Math.round(w / 2);
  wrap.style.width = `${w}px`;
  return { w, h, x: (lon) => ((lon + 180) / 360) * w, y: (lat) => ((90 - lat) / 180) * h };
}

/** Land, borders and the grid: drawn once per size. */
function satMapDrawBase(m) {
  const c = document.createElement("canvas"), dpr = window.devicePixelRatio || 1;
  c.width = m.w * dpr; c.height = m.h * dpr;
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  g.fillStyle = "#06101c"; g.fillRect(0, 0, m.w, m.h);
  g.fillStyle = "#1a2a1f"; g.strokeStyle = "#3b5a44"; g.lineWidth = 0.6;
  for (const ring of WORLD_LAND) {
    g.beginPath();
    for (let i = 0; i < ring.length; i += 2) {
      const X = m.x(ring[i] / 10), Y = m.y(ring[i + 1] / 10);
      if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
    }
    g.closePath(); g.fill(); g.stroke();
  }
  g.strokeStyle = "#2c4234"; g.lineWidth = 0.5;
  for (const line of WORLD_BORDERS) {
    g.beginPath();
    for (let i = 0; i < line.length; i += 2) {
      const X = m.x(line[i] / 10), Y = m.y(line[i + 1] / 10);
      if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
    }
    g.stroke();
  }
  g.strokeStyle = "rgba(141,151,165,0.18)"; g.lineWidth = 1;
  g.font = "10px system-ui, sans-serif"; g.fillStyle = "rgba(141,151,165,0.7)";
  for (let lon = -150; lon <= 150; lon += 30) { g.beginPath(); g.moveTo(m.x(lon), 0); g.lineTo(m.x(lon), m.h); g.stroke(); g.fillText(`${lon}°`, m.x(lon) + 2, m.h - 3); }
  for (let lat = -60; lat <= 60; lat += 30) { g.beginPath(); g.moveTo(0, m.y(lat)); g.lineTo(m.w, m.y(lat)); g.stroke(); g.fillText(`${lat}°`, 2, m.y(lat) - 2); }
  return { canvas: c, w: m.w, h: m.h };
}

/** Polygon (filled and outlined) or line in [lon, lat], drawn three times shifted by 360 degrees,
 *  so the parts across the date line show. */
function satMapPoly(g, m, pts, close = true) {
  for (const off of [-360, 0, 360]) {
    g.beginPath();
    pts.forEach(([lon, lat], i) => (i ? g.lineTo(m.x(lon + off), m.y(lat)) : g.moveTo(m.x(lon + off), m.y(lat))));
    if (close) { g.closePath(); g.fill(); }
    g.stroke();
  }
}

function satMapDraw() {
  const cv = $("satMapCanvas");
  if (!cv || !satMapData) return;
  const m = satMapSize(), dpr = window.devicePixelRatio || 1;
  if (!satMapBase || satMapBase.w !== m.w) satMapBase = satMapDrawBase(m);
  if (cv.width !== m.w * dpr) { cv.width = m.w * dpr; cv.height = m.h * dpr; cv.style.width = `${m.w}px`; cv.style.height = `${m.h}px`; }
  const g = cv.getContext("2d"), now = Date.now() / 1000;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.drawImage(satMapBase.canvas, 0, 0, m.w, m.h);
  g.save();
  g.beginPath(); g.rect(0, 0, m.w, m.h); g.clip();
  // night: the side away from the sun, bounded by the terminator
  const sun = satSubsolar(now), dec = Math.abs(sun.lat) < 0.01 ? 0.01 : sun.lat, rad = Math.PI / 180;
  const term = [];
  for (let lon = -180; lon <= 180; lon += 2) term.push([lon, Math.atan(-Math.cos((lon - sun.lon) * rad) / Math.tan(dec * rad)) / rad]);
  const pole = dec > 0 ? -90 : 90;
  g.fillStyle = "rgba(0,0,0,0.38)"; g.strokeStyle = "rgba(0,0,0,0)";
  satMapPoly(g, m, [...term, [180, pole], [-180, pole]]);
  // station
  const st = satMapData.setup;
  g.fillStyle = "#ffd84a"; g.strokeStyle = "#000"; g.lineWidth = 2;
  g.beginPath(); g.arc(m.x(st.lon), m.y(st.lat), 4, 0, 2 * Math.PI); g.stroke(); g.fill();
  // ground track of the chosen satellite
  const sel = satMapData.sats.find((s) => s.norad === satMapSel);
  if (sel) {
    const past = [], ahead = [];
    let shift = 0, prev = null;
    for (const p of sel.samples) {
      let lon = p[2] + shift;
      if (prev !== null) { while (lon - prev > 180) { shift -= 360; lon -= 360; } while (lon - prev < -180) { shift += 360; lon += 360; } }
      prev = lon;
      (p[0] <= now ? past : ahead).push([lon, p[1]]);
    }
    if (past.length && ahead.length) ahead.unshift(past[past.length - 1]);
    g.lineWidth = 1.5; g.strokeStyle = "rgba(184,216,255,0.55)"; g.setLineDash([4, 4]);
    satMapPoly(g, m, past, false);
    g.setLineDash([]); g.lineWidth = 2; g.strokeStyle = "#5d9bff";
    satMapPoly(g, m, ahead, false);
  }
  // footprints and the satellites
  g.font = "600 11px system-ui, sans-serif";
  const marks = [];
  for (const sat of satMapData.sats) {
    const p = satMapAtTime(sat, now);
    if (!p) continue;
    const radius = Math.acos(SAT_EARTH_KM / (SAT_EARTH_KM + Math.max(p.alt, 1))) / rad, chosen = sat.norad === satMapSel, seen = p.el > 0;
    g.lineWidth = chosen ? 2 : 1;
    g.strokeStyle = chosen ? "#b8d8ff" : seen ? "rgba(255,216,74,0.8)" : "rgba(141,151,165,0.65)";
    g.fillStyle = chosen ? "rgba(93,155,255,0.12)" : seen ? "rgba(255,216,74,0.08)" : "rgba(141,151,165,0.05)";
    const fp = satCircle(p.lat, p.lon, radius), line = g.strokeStyle;
    g.strokeStyle = "rgba(0,0,0,0)";
    satMapPoly(g, m, fp.fill);
    g.strokeStyle = line;
    satMapPoly(g, m, fp.pts, false);
    marks.push({ sat, p, chosen, seen });
  }
  for (const { sat, p, chosen, seen } of marks) {
    const X = m.x(p.lon), Y = m.y(p.lat), label = satShort(sat.name);
    g.fillStyle = chosen ? "#b8d8ff" : seen ? "#ffd84a" : "#e9edf2"; g.strokeStyle = "#000"; g.lineWidth = 2;
    g.beginPath(); g.arc(X, Y, chosen ? 5 : 4, 0, 2 * Math.PI); g.stroke(); g.fill();
    g.lineWidth = 3; g.strokeText(label, X + 7, Y + 4); g.fillText(label, X + 7, Y + 4);
    sat._xy = [X, Y];
  }
  g.restore();
  satMapInfo(sel, sel && satMapAtTime(sel, now), now);
}

function satMapInfo(sel, p, now) {
  const box = $("satMapInfo");
  if (!box) return;
  if (!sel) { box.innerHTML = '<span class="muted">No satellite on the map: switch one on above.</span>'; $("satMapTx").textContent = ""; box._norad = null; return; }
  if (box._norad !== sel.norad) { box._norad = sel.norad; satTxFill("satMapTx", sel.norad, 12); }
  if (!p) { box.innerHTML = `<b>${escHtml(sel.name)}</b> <span class="muted">no position now (orbital elements?)</span>`; return; }
  let event = "";
  if (p.el > 0) {
    const end = sel.samples.find((s) => s[0] > now && s[5] <= 0);
    event = `<span class="satm-up">above the horizon</span>${end ? `, LOS about ${satUntil(end[0])}` : ""}`;
  } else {
    const next = sel.samples.find((s) => s[0] > now && s[5] > 0);
    event = next ? `next AOS about ${satUntil(next[0])}` : "no AOS within the next orbit";
  }
  const dop = (-p.rate / 299792.458) * 1e6;
  const pass = satData && satData.passes.find((q) => q.norad === sel.norad && q.los > now);
  const next = pass ? `${satDay(pass.aos)} ${satTime(pass.aos)}–${satTime(pass.los)}, max. ${pass.max_el}° ${pass.aos <= now ? "(now)" : satUntil(pass.aos)}` : "";
  box.innerHTML = `<div class="satm-name"><b>${escHtml(sel.name)}</b></div>
    <table class="satp-facts satm-facts">
      <tr><th>NORAD</th><td>${sel.norad} · orbit ${Math.round(sel.period_min)} min · elements ${sel.tle_age_days} d</td></tr>
      <tr><th>Position</th><td>${Math.abs(p.lat).toFixed(2)}° ${p.lat >= 0 ? "N" : "S"}, ${Math.abs(p.lon).toFixed(2)}° ${p.lon >= 0 ? "E" : "W"}</td></tr>
      <tr><th>Locator</th><td>${satLocator(p.lat, p.lon)}</td></tr>
      <tr><th>Altitude</th><td>${Math.round(p.alt)} km</td></tr>
      <tr><th>From here</th><td>az ${Math.round(p.az)}°, el ${p.el.toFixed(1)}°</td></tr>
      <tr><th>Distance</th><td>${Math.round(p.range)} km</td></tr>
      <tr><th>Doppler</th><td>${(dop * 145.9 / 1000).toFixed(1)} kHz at 145.9 MHz, ${(dop * 435 / 1000).toFixed(1)} kHz at 435 MHz</td></tr>
      <tr><th>Now</th><td>${event}</td></tr>
      ${next ? `<tr><th>Next pass</th><td>${next}</td></tr>` : ""}
    </table>
    <button class="key small" id="satMapTrack" data-norad="${sel.norad}" title="Open this satellite on the TRACK page (Doppler, rotor)">TRACK</button>`;
}

$("amsatBody").addEventListener("mousemove", (e) => {
  if (e.target.id !== "satMapCanvas" || !satMapData) return;
  const r = e.target.getBoundingClientRect(), m = satMapSize(), x = e.clientX - r.left, y = e.clientY - r.top;
  const lon = (x / m.w) * 360 - 180, lat = 90 - (y / m.h) * 180, tip = $("satMapTip");
  const near = satMapData.sats.find((s) => s._xy && Math.hypot(s._xy[0] - x, s._xy[1] - y) < 9);
  tip.hidden = false;
  tip.textContent = near ? `${near.name} (click: ground track)` : `${lat.toFixed(1)}°, ${lon.toFixed(1)}° · ${satLocator(lat, lon).slice(0, 4)}`;
  tip.style.left = `${Math.min(x + 12, r.width - 220)}px`;
  tip.style.top = `${y + 14}px`;
  e.target.style.cursor = near ? "pointer" : "crosshair";
});
$("amsatBody").addEventListener("mouseout", (e) => {
  if (e.target.id === "satMapCanvas") $("satMapTip").hidden = true;
});

$("amsatBody").addEventListener("click", (e) => {
  if (e.target.id === "satMapTrack" || e.target.id === "satDetailTrack") {
    satOpenTrack(Number(e.target.dataset.norad));
    return;
  }
  if (e.target.id === "satMapCanvas" && satMapData) {
    const r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const near = satMapData.sats.find((s) => s._xy && Math.hypot(s._xy[0] - x, s._xy[1] - y) < 9);
    if (near) { satMapSel = near.norad; store("satMapSel", satMapSel); renderSatMapChips(); satMapDraw(); }
    return;
  }
  const chip = e.target.closest("button[data-map-norad]");
  if (!chip || !satMapData) return;
  const n = Number(chip.dataset.mapNorad), on = new Set(satMapData.setup.map_sats);
  if (on.has(n) && n !== satMapSel) { satMapSel = n; store("satMapSel", n); renderSatMapChips(); satMapDraw(); return; }   // on: first click chooses it
  if (on.has(n)) on.delete(n); else { on.add(n); satMapSel = n; store("satMapSel", n); }
  satMapData.setup.map_sats = [...on];
  renderSatMapChips();
  satFetch("/api/sat/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ map_sats: [...on] }) })
    .then(() => satMapLoad())
    .catch((err) => amsatInfo(err.message, true));
});

setInterval(() => {
  if (bodyTab !== "sat" || amsatPage !== "map" || document.hidden) return;
  satMapDraw();
  if (satMapData && Date.now() - satMapAt > 300000) satMapLoad();      // the tracks reach one orbit ahead
}, 1000);

window.addEventListener("resize", () => {
  if (bodyTab === "sat" && amsatPage === "map" && satMapData) satMapDraw();
});

// ---------- SETTINGS › GENERAL › LOCATION: station locator / latitude, longitude, altitude (location.py), shared by all VFOs ----------

let locPick = null;          // Leaflet map of CHOOSE ON MAP
let locMode = "latlon";      // which fields SAVE uses: "loc" after typing a locator, else latitude and longitude

function locMsg(text, err) {
  $("locMsg").textContent = text || "";
  $("locMsg").classList.toggle("error", !!err);
}

function locFill(s) {
  $("locLoc").value = s.locator;
  $("locLat").value = s.lat;
  $("locLon").value = s.lon;
  $("locAlt").value = s.alt_m;
  $("locNow").textContent = `${s.locator} · ${s.lat.toFixed(4)}°, ${s.lon.toFixed(4)}°`;
  locMode = "latlon";
}

async function locLoad(body) {
  try {
    const s = await satFetch("/api/location", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    locFill(s);
    if (body) satData = satMapData = satSetupData = null;    // passes, map and SETUP of the satellites depend on the place
    locMsg(s.lat === 0 && s.lon === 0 ? "Not set yet: enter your locator or choose the place on the map." : "", s.lat === 0 && s.lon === 0);
    return true;
  } catch (e) {
    locMsg(e.message, true);
    return false;
  }
}

/** Opens SETTINGS › GENERAL › LOCATION (from the SATELLITES › SETUP page). */
function openLocationSetup() {
  setBodyTab("set");
  openSetPage("location");
}

$("locSave").addEventListener("click", async () => {
  const loc = $("locLoc").value.trim().toUpperCase(), body = { alt_m: Number($("locAlt").value) };
  if (locMode === "loc" && loc) body.locator = loc;
  else { body.lat = Number($("locLat").value); body.lon = Number($("locLon").value); }
  if (await locLoad(body)) locMsg("Saved");
});
$("locPickBtn").addEventListener("click", () => locPickOpen());
$("locLoc").addEventListener("input", () => { locMode = "loc"; });
for (const id of ["locLat", "locLon"]) $(id).addEventListener("input", () => { locMode = "latlon"; });

async function locPickOpen() {
  const box = $("locPickMap");
  box.hidden = false;
  $("locPickNote").hidden = false;
  try {
    await Promise.all([satAsset("/static/leaflet/leaflet.css"), satAsset("/static/leaflet/leaflet.js")]);
  } catch (e) {
    $("locPickNote").textContent = e.message;
    return;
  }
  const lat = Number($("locLat").value) || 0, lon = Number($("locLon").value) || 0;
  if (locPick) locPick.remove();
  locPick = L.map(box, { worldCopyJump: true }).setView([lat, lon], lat === 0 && lon === 0 ? 2 : 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  }).addTo(locPick);
  const mark = L.circleMarker([lat, lon], { radius: 7, color: "#000", weight: 2, fillColor: "#ffd84a", fillOpacity: 1 }).addTo(locPick);
  locPick.on("click", (ev) => {
    const p = ev.latlng.wrap();
    mark.setLatLng(p);
    $("locLat").value = p.lat.toFixed(5);
    $("locLon").value = p.lng.toFixed(5);
    $("locLoc").value = satLocator(p.lat, p.lng);
    locMode = "latlon";
    locMsg(`Chosen ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} (${satLocator(p.lat, p.lng)}): SAVE keeps it`);
  });
}

// ---------- ACARS ----------

const ACARS_MAX_ROWS = 300;

let linkFreqs = { acars: [], vdl2Center: 0, vdl2Rate: 0, vdl2RegionFreqs: {} };
let linkShown = null;

/** Band buttons, title and notes of the ACARS and CPDLC cards by the active link:
 *  ACARS = the classic channels, VDL2 = one centre button (all channels of the region are received at once) and the region. */
function renderLinkBands() {
  const vdl2 = !!(st && (st.vdl2 || (!st.acars && decPage === "vdl2")));
  if (vdl2 === linkShown) return;
  linkShown = vdl2;
  const f = linkFreqs;
  const html = vdl2
    ? `<button data-vdl2="1">${fmtMHz(f.vdl2Center, 3)}</button>` +
      `<button data-region="eu">EU</button><button data-region="us">US</button>`
    : f.acars.map((x) => `<button data-f="${x}" title="${fmtMHz(x, 3)} MHz AM">${fmtMHz(x, 3)}</button>`).join("");
  $("acarsBands").innerHTML = html;
  renderVdl2Region();
  for (const el of document.querySelectorAll("#acarsCard [data-link]")) {
    el.hidden = el.dataset.link !== (vdl2 ? "vdl2" : "acars");
  }
  renderAcarsFilter();
}

/** EU / US buttons and the tooltips with the channels of the VDL2 regions. */
function renderVdl2Region() {
  if (!st) return;
  const mhz = (r) => (linkFreqs.vdl2RegionFreqs[r] || []).map((x) => fmtMHz(x, 3)).join(", ");
  for (const b of document.querySelectorAll("#acarsBands [data-region]")) {
    b.classList.toggle("active", st.vdl2_region === b.dataset.region);
    b.title = `Decode the ${b.dataset.region.toUpperCase()} channels: ${mhz(b.dataset.region)} MHz`;
  }
  const c = document.querySelector("#acarsBands [data-vdl2]");
  if (c) c.title = `VDL2 centre ${fmtMHz(linkFreqs.vdl2Center, 3)} MHz, 2.1 MS/s: receives ${mhz(st.vdl2_region)} MHz at once`;
}

/** Click on a band button in the ACARS card. */
async function onLinkBand(e) {
  const b = e.target.closest("[data-f], [data-vdl2], [data-region]");
  if (!b || !st) return;
  if (b.dataset.region) {                      // VDL2 channels of one region
    if (b.dataset.region === st.vdl2_region) return;
    st.vdl2_region = b.dataset.region;
    renderVdl2Region();
    send({ vdl2_region: st.vdl2_region });
    return;
  }
  if (b.dataset.vdl2) {                        // re-centre the VFO for VDL2
    const f = linkFreqs;
    st.mode = "AM";
    renderControls();
    send({ sample_rate: f.vdl2Rate, center_hz: f.vdl2Center, tune_hz: f.vdl2Center, mode: "AM" });
    return;
  }
  await ensureVfoFor(Number(b.dataset.f));   // VHF -> VFO without upconverter
  if (!st) return;
  st.mode = "AM";
  renderControls();
  tune(Number(b.dataset.f));
  const changes = { mode: "AM" };
  if (!st.acars) { st.acars = true; st.vdl2 = false; $("acarsOn").checked = true; $("vdl2On").checked = false; changes.acars = true; }
  send(changes);
}

/** Tooltip of the frequency cell: signal and noise of a VDL2 burst (the card title already names the link). */
function freqTitle(m) {
  const v = m.vdl2;
  return v && v.sig_db != null ? ` title="signal ${v.sig_db.toFixed(1)} dBFS, noise ${v.noise_db.toFixed(1)} dBFS"` : "";
}

/** Decoded CPDLC / ADS-C / ATN message: [kind ("cpdlc" | "adsc" | "atn"), HTML block, coloured tag for the first column]. */
function decodedBlock(c) {
  const kind = c.imi === "ATN" ? (/ADS-C/.test(c.imi_desc || "") ? "adsc" : "atn")   // ATN ADS-C = ADS-C (purple)
    : c.imi === "ADS" || c.imi === "DIS" ? "adsc" : "cpdlc";
  // ATN: the tag without "ATN" (CPDLC, CM); the row tooltip and the Description column still say ATN
  const name = kind === "atn" ? (c.imi_desc || "CPDLC").replace("context management", "CM").replace(/^ATN /, "").toUpperCase()
    : kind === "adsc" ? "ADS-C" : "CPDLC";
  const head = [c.gs ? `${c.dir === "up" ? "from" : "to"} ${escHtml(c.gs)}` : "",
    c.min != null ? `MIN ${c.min}` : "", c.mrn != null ? `MRN ${c.mrn}` : "", c.ts ? escHtml(c.ts) : "",
    kind === "cpdlc" && c.imi !== "AT1" ? escHtml(c.imi_desc) : ""].filter(Boolean).join(" · ");
  const els = (c.elements || []).length
    ? c.elements.map((e) => `<div class="cp-el"><span class="cp-id">${escHtml(e.id)}</span>${escHtml(e.text)}</div>`).join("")
    : `<div class="cp-el">${escHtml(c.text || c.imi_desc || "")}</div>`;
  const top = `${c.crc_ok ? "" : "✗ "}${head}`;
  return [kind, `<div class="dec d-${kind} ${c.dir === "up" ? "cp-up" : "cp-down"}">` +
    `${top ? `<div class="muted">${top}</div>` : ""}` +
    `${els}${c.error ? `<div class="muted">${escHtml(c.error)}</div>` : ""}</div>`,
    `<span class="type-tag t-${kind}">${name}</span>`];
}

// ---------- scroll pause: a click on a message holds the list still, the mouse wheel over the list resumes ----------

let acarsPausedRow = null;    // the marked row; null = list runs normally

const acarsBox = () => $("acarsRows").closest(".ft8-table");

/** Mark the row and hold the list still. New rows still come in above it (hidden from view). */
function acarsPause(tr) {
  acarsPausedRow?.classList.remove("picked");
  acarsPausedRow = tr;
  tr.classList.add("picked");
  acarsBox().classList.add("paused");
  $("acarsPaused").hidden = false;
}

/** Back to the running list: newest messages at the top, rows kept while paused trimmed to the normal limit. */
function acarsResume() {
  if (!acarsPausedRow) return;
  acarsPausedRow.classList.remove("picked");
  acarsPausedRow = null;
  const box = acarsBox();
  box.classList.remove("paused");
  $("acarsPaused").hidden = true;
  box.scrollTop = 0;
  const tb = $("acarsRows");
  if (tb.rows.length > ACARS_MAX_ROWS) {
    while (tb.rows.length > ACARS_MAX_ROWS) tb.lastChild.remove();
    renderAcarsFilter();
  }
}

/** Run a change of the table; while paused, the marked row stays at the same place on the screen. */
function acarsKeepView(change) {
  const tr = acarsPausedRow;
  if (!tr) { change(); return; }
  const y = tr.offsetTop;
  change();
  if (acarsPausedRow === tr) acarsBox().scrollTop += tr.offsetTop - y;
}

acarsBox().addEventListener("wheel", (e) => {
  if (!acarsPausedRow) return;
  e.preventDefault();     // this notch only resumes; the next ones scroll
  acarsResume();
}, { passive: false });

// A new message waits here until its row is complete: ADS-B answer, then the flag image.
const ACARS_HOLD_MS = 15000;   // no ADS-B answer by then (longer than the 2 x 6 s of the server): shown without it, and filled in if it still comes
const ACARS_FLAG_MS = 3000;    // the same for the flag image
const acarsHeld = new Map();   // message id -> { m, timer }

function acarsHex(m, ac) { return m.atn ? m.reg : ac && ac.found ? ac.hex : ""; }
function flagUrl(cc) { return `https://flagcdn.com/w40/${cc}.png`; }

function acarsReceive(m) {
  const h = { m, timer: null };
  acarsHeld.set(m.id, h);
  if (m.lookup && !m.ac) h.timer = setTimeout(() => acarsRelease(m.id), ACARS_HOLD_MS);
  else acarsRelease(m.id);
}

/** ADS-B done: load the flag, then show the row. Rows keep the order of the messages (see addAcars). */
function acarsRelease(id) {
  const h = acarsHeld.get(id);
  if (!h) return;
  clearTimeout(h.timer);
  const show = () => {
    if (acarsHeld.get(id) !== h) return;     // cleared, or already shown
    clearTimeout(h.timer);
    acarsHeld.delete(id);
    const tr = $("acarsRows").querySelector(`tr[data-id="${id}"]`);   // came with the history in the meantime
    if (tr) { tr._msg.ac = h.m.ac; acarsKeepView(() => renderAcarsAircraft(tr, h.m.ac)); } else addAcars(h.m, true);
  };
  const hex = acarsHex(h.m, h.m.ac);
  const cty = hex ? icaoCountry(hex) : null;
  if (!cty || !cty.cc) { show(); return; }
  h.timer = setTimeout(show, ACARS_FLAG_MS);
  h.img = new Image();                       // in the browser cache for the row, which then has it at once
  h.img.onload = h.img.onerror = show;
  h.img.src = flagUrl(cty.cc);
}

function acarsDropHeld() {
  for (const h of acarsHeld.values()) clearTimeout(h.timer);
  acarsHeld.clear();
}

/** One row of the ACARS card: an ACARS message (with decoded CPDLC / ADS-C inside) or an ATN message. */
function addAcars(m, fresh) {
  const tb = $("acarsRows");
  $("acarsEmpty").hidden = true;
  const tr = document.createElement("tr");
  if (!m.crc_ok) tr.classList.add("bad");
  if (fresh) tr.classList.add("new");
  const arrow = m.dir === "down" ? `<span class="arr-down">↓</span>` : `<span class="arr-up">↑</span>`;   // ↓ z lietadla, ↑ zo zeme
  tr.title = m.atn ? `${m.desc} · ICAO address ${m.reg}`
    : `mode ${m.mode} · block ${m.block}${m.msgno ? " · msg " + m.msgno : ""}${m.ack ? " · ack " + m.ack : ""}` +
      `${m.crc_ok ? "" : " · CRC error"}${m.more ? " · continues in the next block" : ""}`;
  tr.dataset.id = m.id;
  let dec = "", tag = `<span class="type-tag t-acars">ACARS</span>`;   // plain ACARS: nothing decoded inside
  if (m.cpdlc) {
    const [kind, html, t] = decodedBlock(m.cpdlc);
    tr.classList.add(`r-${kind}`);
    dec = html;
    tag = t;
  }
  const text = m.text ? `<div class="msg-text${m.cpdlc ? " raw" : ""}">${m.crc_ok ? "" : "✗ "}${escHtml(m.text)}</div>`
    : m.cpdlc ? "" : `<div class="msg-text"><span class='muted'>(no text)</span></div>`;
  if (!m.cpdlc) tr.classList.add("r-acars");
  const gs = m.vdl2?.gs ? ` title="Ground station ${escHtml(m.vdl2.gs)}${m.vdl2.gs_info ? `: ${escHtml(m.vdl2.gs_info)}` : ""}"` : "";
  tr.innerHTML = `<td class="tag">${tag}</td><td>${m.time}</td><td class="num"${freqTitle(m)}>${fmtMHz(m.freq_hz, 3)}</td>` +
    `<td class="cty"></td><td class="flt"></td><td class="reg"></td><td class="icao"></td><td class="sqk"></td><td class="act"></td><td class="model"></td>` +
    `<td class="fl num"></td><td class="spd num"></td><td>${arrow} ${escHtml(m.label || "")}</td>` +
    `<td class="desc">${escHtml(m.desc || "")}</td><td class="loc"${gs}>${escHtml(m.vdl2?.gs_loc || "-")}${m.vdl2?.gs_city ? `<div class="ac-sub">${escHtml(m.vdl2.gs_city)}</div>` : ""}</td><td class="msg">${dec}${text}` +
    `${m.atn && m.cpdlc.detail ? `<div class="atn-detail">${escHtml(m.cpdlc.detail)}</div>` : ""}</td>`;
  // long message (technical reports with tables): shortened to 3 lines, a click expands/collapses it
  if (m.text && (m.text.split("\n").length > 3 || m.text.length > 240)) tr.querySelector("td.msg").classList.add("long");
  // ATN: click shows the whole decoded frame (all fields) under the compact lines
  if (m.atn && m.cpdlc.detail) tr.querySelector("td.msg").classList.add("long", "has-detail");
  tr._msg = m;
  const kind = m.cpdlc ? decodedBlock(m.cpdlc)[0] : "acars";
  tr.dataset.kind = kind === "atn" ? "cpdlc" : kind;    // filter: CPDLC = FANS and ATN CPDLC
  tr.dataset.loc = m.vdl2?.gs_loc || "-";
  renderAcarsAircraft(tr, m.ac);
  acarsAcUpdate(m);
  acarsKeepView(() => {
    // newest on top by message number: a held row may come after a newer one that had nothing to wait for
    let next = tb.firstElementChild;
    while (next && Number(next.dataset.id) > m.id) next = next.nextElementSibling;
    tb.insertBefore(tr, next);
    // while paused the rows under the marked one stay in view: twice the limit, the rest is trimmed on resume
    const max = acarsPausedRow ? ACARS_MAX_ROWS * 2 : ACARS_MAX_ROWS;
    while (tb.rows.length > max) (tb.lastChild === acarsPausedRow ? acarsPausedRow.previousSibling : tb.lastChild).remove();
    renderAcarsFilter();
  });
}

// ---------- message filter (tags at the top of the card) ----------

const acarsFilter = new Set(JSON.parse(localStorage.getItem("acarsFilter") || "[]").map((k) => (k === "atn" ? "cpdlc" : k)));

let acarsLoc = localStorage.getItem("acarsLoc") || "";    // VDL2 location filter; "" = all

/** Ground Station list: the locations of the rows in the table, "-" last. The selected one stays even without rows.
 *  Rebuilt only when the list changes, so an open pull-down is not disturbed by new messages. */
function renderAcarsLocOptions() {
  const locs = new Set([...$("acarsRows").rows].map((tr) => tr.dataset.loc));
  if (acarsLoc) locs.add(acarsLoc);
  const list = [...locs].filter((l) => l !== "-").sort();
  if (locs.has("-")) list.push("-");
  const sel = $("acarsLoc");
  const key = list.join("|");
  if (sel._key !== key) {
    sel._key = key;
    sel.replaceChildren(new Option("All", ""), ...list.map((l) => new Option(l === "-" ? "- (not known)" : l, l)));
  }
  sel.value = acarsLoc;
}

/** Show only rows of the selected kinds and location (VDL2 only; classic ACARS has no locations);
 *  the header says the filter is on and how many rows are shown. */
function renderAcarsFilter() {
  const rows = $("acarsRows").rows;
  const loc = linkShown ? acarsLoc : "";
  let shown = 0;
  acarsKeepView(() => {
    for (const tr of rows) {
      tr.hidden = (acarsFilter.size > 0 && !acarsFilter.has(tr.dataset.kind)) || (loc !== "" && tr.dataset.loc !== loc);
      if (!tr.hidden) shown++;
    }
  });
  if (acarsPausedRow?.hidden) acarsResume();     // the marked message was filtered out
  renderAcarsLocOptions();
  const on = acarsFilter.size > 0 || loc !== "";
  $("acarsFilter").classList.toggle("on", acarsFilter.size > 0);
  for (const t of $("acarsFilter").querySelectorAll("[data-kind]")) t.classList.toggle("sel", acarsFilter.has(t.dataset.kind));
  const s = $("acarsFilterState");
  s.hidden = !on;
  s.innerHTML = on ? `FILTER ON · ${shown} of ${rows.length} shown <span class="tf-clear" title="Show all messages">✕</span>` : "";
}

$("acarsFilter").addEventListener("click", (e) => {
  const t = e.target.closest("[data-kind]");
  if (t) acarsFilter.has(t.dataset.kind) ? acarsFilter.delete(t.dataset.kind) : acarsFilter.add(t.dataset.kind);
  else if (e.target.closest(".tf-clear")) {
    acarsFilter.clear();
    acarsLoc = "";
    localStorage.removeItem("acarsLoc");
  } else return;
  localStorage.setItem("acarsFilter", JSON.stringify([...acarsFilter]));
  renderAcarsFilter();
});

$("acarsLoc").addEventListener("change", (e) => {
  acarsLoc = e.target.value;
  localStorage.setItem("acarsLoc", acarsLoc);
  renderAcarsFilter();
});

/** ATN message (European CPDLC over VDL2, no ACARS around it) as a row of the ACARS card. */
function addAtn(c, fresh) {
  const m = { id: c.id, time: c.time, date: c.date, freq_hz: c.freq_hz, link: c.link, vdl2: c.vdl2, reg: c.reg, flight: "", label: "",
    dir: c.dir, desc: c.imi_desc, text: "", crc_ok: true, cpdlc: c, ac: c.ac, atn: true, lookup: c.lookup };
  if (fresh) acarsReceive(m); else addAcars(m, false);
}

const SQUAWK_ALERT = new Set(["7500", "7600", "7700"]);   // these squawks get a red frame around the row

/** Registration and flight; from ADS-B (adsb.fi / adsb.lol) type, position and a map link in a new window:
 *  registration -> globe.adsb.fi, flight -> adsb.lol. */
function renderAcarsAircraft(tr, ac) {
  tr.classList.toggle("sqk-alert", !!(ac && ac.found && SQUAWK_ALERT.has(ac.squawk)));
  const m = tr._msg;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const link = (url, text, title) => `<a href="${url}" target="_blank" rel="noopener" title="${esc(title)}">${esc(text)}</a>`;
  // ATN messages (VDL2) carry only the 24-bit ICAO address: the registration comes from ADS-B
  const regText = m.atn && ac && ac.found && ac.reg ? ac.reg : m.reg;
  let reg = m.atn ? `<span title="24-bit ICAO address (ATN message)">${esc(m.reg)}</span>` : esc(m.reg), flt = esc(m.flight);
  let sqkH = "", actH = "", modelH = "", flH = "", spdH = "";
  if (ac && ac.found && ac.hex) {
    reg = link(`https://globe.adsb.fi/?icao=${encodeURIComponent(ac.hex)}`, regText, "Show on the map (adsb.fi)");
    if (m.flight || ac.callsign)
      flt = link(`https://adsb.lol/?icao=${encodeURIComponent(ac.hex)}`, m.flight || ac.callsign, "Show on the map (adsb.lol)");
    // aircraft type, flight level and ground speed from ADS-B in their own columns (blue = from ADS-B)
    const src = `from ADS-B (${ac.src || "adsb.fi"}) at the time of the message`;
    const cell = (text, title) => (text ? `<span class="ext" title="${esc(title)}">${esc(text)}</span>` : "");
    sqkH = cell(ac.squawk, `transponder squawk code · ${src}`);
    actH = cell(ac.type, src);
    modelH = cell(ac.desc, src);
    flH = cell(ac.ground ? "GND" : ac.alt_ft != null ? `FL${String(Math.round(ac.alt_ft / 100)).padStart(3, "0")}` : "",
      `${ac.ground ? "on ground" : ac.alt_ft != null ? ac.alt_ft + " ft" : ""} · ${src}`);
    spdH = cell(ac.gs_kt != null && !ac.ground ? `${Math.round(ac.gs_kt)} kt` : "", `ground speed · ${src}`);
    if (ac.callsign && m.flight && ac.callsign !== m.flight) flt += `<div class="ac-sub" ${src}>${esc(ac.callsign)}</div>`;
  } else if (ac && !ac.found) {
    reg += `<div class="ac-sub none">not seen on ADS-B now</div>`;
  }
  tr.querySelector("td.reg").innerHTML = reg;
  tr.querySelector("td.flt").innerHTML = flt;
  tr.querySelector("td.sqk").innerHTML = sqkH;
  tr.querySelector("td.act").innerHTML = actH;
  tr.querySelector("td.model").innerHTML = modelH;
  tr.querySelector("td.fl").innerHTML = flH;
  tr.querySelector("td.spd").innerHTML = spdH;
  // country of registration from the 24-bit ICAO address (ATN: in the message; ACARS: from the ADS-B lookup),
  // the same way the adsb.fi map shows it
  const hex = acarsHex(m, ac);
  tr.querySelector("td.icao").textContent = (hex || "").toUpperCase();
  const cty = hex ? icaoCountry(hex) : null;
  tr.querySelector("td.cty").innerHTML = !cty ? ""
    : cty.cc ? `<span class="cflag" title="${esc(cty.name)}"><img src="${flagUrl(cty.cc)}" alt="${cty.cc.toUpperCase()}"` +
      ` onerror="this.replaceWith(this.alt)"><span>${cty.cc.toUpperCase()}</span></span>`
    : `<span class="muted" title="${esc(cty.name)}">—</span>`;
}

function onAcarsInfo(d) {
  const held = acarsHeld.get(d.id);
  if (held) { held.m.ac = d.ac; acarsRelease(d.id); return; }
  // the same aircraft data for the ACARS row and the CPDLC row of the message
  for (const tb of ["acarsRows"]) {
    const tr = $(tb).querySelector(`tr[data-id="${d.id}"]`);
    if (!tr) continue;
    tr._msg.ac = d.ac;
    acarsKeepView(() => renderAcarsAircraft(tr, d.ac));
    acarsAcUpdate(tr._msg);
  }
}

function renderAcarsInfo(i) {
  if (!st) return;
  $("acarsCard").hidden = !(st.acars || st.vdl2);
  if (!i) return;
  $("acarsInfo").textContent = `${i.count} messages${i.crc_errors ? ` · ${i.crc_errors} CRC errors` : ""}`;
}

// ----- ACARS / VDL2 MAP: aircraft with a known position (ADS-B, ADS-C, VDL2 XID) and the VDL2 ground stations -----
// The aircraft records have the shape of the HFDL ones, so the icon, track and heading helpers of the HFDL map are shared.

const acarsAc = new Map();       // key -> aircraft {key, hex, reg, flight, ac, first, last, n, gs, ids, pts: [{lat, lon, t, src}]}
const acarsAcAlias = new Map();  // "hex:…" / "reg:…" / "flt:…" -> aircraft
const acarsGsPos = new Map();    // VDL2 ground station address -> {lat, lon, gs_loc, gs_city, t}
let acarsView = MAP_ONLY ? "map" : recall("acarsView") || "msgs";
let acarsMap = null, acarsMapLayers = null, acarsMapFitted = false, acarsSel = null, acarsViewTimer = null;

/** Time of a message (UTC date + time strings) in seconds. */
function acarsT(m) {
  const t = Date.parse(`${m.date}T${m.time}Z`);
  return Number.isFinite(t) ? t / 1000 : Date.now() / 1000;
}

/** 24-bit ICAO address of the aircraft: ATN message, VDL2 link address of the aircraft, else from ADS-B. */
function acarsAirHex(m) {
  if (m.atn) return m.reg || "";
  const a = m.vdl2 ? (m.dir === "down" ? m.vdl2.src : m.vdl2.dst) : "";
  return /^[0-9A-Fa-f]{6}$/.test(a || "") && !/^f{6}$/i.test(a) ? a : "";
}

/** Aircraft record for these identifiers; records found under different identifiers are joined into one. */
function acarsAcFind(ids) {
  const found = [...new Set(ids.map((k) => acarsAcAlias.get(k)).filter(Boolean))];
  let a = found[0];
  if (!a) {
    a = { key: ids[0], hex: "", reg: "", flight: "", ac: null, first: 0, last: 0, n: 0, gs: "", ids: new Set(), pts: [] };
    acarsAc.set(a.key, a);
  }
  for (const b of found.slice(1)) {           // the same aircraft seen first by another identifier
    for (const id of b.ids) if (!a.ids.has(id)) { a.ids.add(id); a.n++; }
    for (const p of b.pts) acarsAddPt(a, p.lat, p.lon, p.t, p.src);
    a.hex = a.hex || b.hex; a.reg = a.reg || b.reg; a.flight = a.flight || b.flight; a.ac = a.ac || b.ac;
    if (b.last > a.last) { a.last = b.last; a.gs = b.gs || a.gs; }
    for (const [k, x] of acarsAcAlias) if (x === b) acarsAcAlias.set(k, a);
    acarsAc.delete(b.key);
    if (acarsSel === b.key) acarsSel = a.key;
  }
  for (const k of ids) acarsAcAlias.set(k, a);
  return a;
}

function acarsAddPt(a, lat, lon, t, src) {
  if (lat == null || lon == null || a.pts.some((p) => p.lat === lat && p.lon === lon)) return;
  a.pts.push({ lat, lon, t, src });
  a.pts.sort((p, q) => p.t - q.t);
  if (a.pts.length > 200) a.pts.shift();
}

/** A message (or its ADS-B data that came later) -> aircraft record and its positions. */
function acarsAcUpdate(m) {
  const ac = m.ac && m.ac.found ? m.ac : null;
  const hex = (acarsAirHex(m) || (ac ? ac.hex : "") || "").toUpperCase();
  const reg = (!m.atn && m.reg) || (ac ? ac.reg : "") || "";
  const flight = m.flight || (ac ? ac.callsign : "") || "";
  const ids = [hex && `hex:${hex}`, reg && `reg:${reg}`, flight && `flt:${flight}`].filter(Boolean);
  if (!ids.length) return;
  const a = acarsAcFind(ids), t = acarsT(m);
  if (!a.ids.has(m.id)) { a.ids.add(m.id); a.n++; }
  a.hex = hex || a.hex; a.reg = reg || a.reg; a.flight = flight || a.flight;
  if (!a.first || t < a.first) a.first = t;
  if (t >= a.last) { a.last = t; a.gs = (m.vdl2 && m.vdl2.gs_loc !== "-" && m.vdl2.gs_loc) || a.gs; }
  if (ac) a.ac = ac;
  const pos = m.cpdlc && m.cpdlc.pos;
  if (pos) acarsAddPt(a, pos.lat, pos.lon, t, "ADS-C");
  if (ac) acarsAddPt(a, ac.lat, ac.lon, t, ac.src || "ADS-B");
  acarsViewLater();
}

/** Position from a VDL2 XID frame (server event "acarspos" or the history). */
function acarsPosUpdate(p) {
  if (p.kind === "gs") {
    acarsGsPos.set(p.addr, p);
  } else {
    const a = acarsAcFind([`hex:${p.addr}`]);
    a.hex = a.hex || p.addr;
    if (!a.first) a.first = p.t;
    if (p.t > a.last) { a.last = p.t; a.gs = (p.gs_loc !== "-" && p.gs_loc) || a.gs; }
    acarsAddPt(a, p.lat, p.lon, p.t, "VDL2 XID");
  }
  acarsViewLater();
}

function acarsViewLater() {
  if (acarsView === "msgs" || acarsViewTimer) return;
  acarsViewTimer = setTimeout(() => { acarsViewTimer = null; renderAcarsView(); }, 400);
}

function renderAcarsView() {
  if (acarsView === "aircraft") renderAcarsAcTable();
  else if (acarsView === "map") renderAcarsMap();
}

/** AIRCRAFT view: the newest data of each aircraft, newest first. */
function renderAcarsAcTable() {
  const list = [...acarsAc.values()].sort((a, b) => b.last - a.last);
  $("acarsAcRows").innerHTML = list.map((a) => {
    const ac = a.ac, p = hfdlPos(a), esc = escHtml;
    const cty = a.hex ? icaoCountry(a.hex) : null;
    const ext = (t) => (t ? `<span class="ext">${esc(t)}</span>` : "");
    return `<tr data-key="${esc(a.key)}"><td>${hfdlUtc(a.last)}</td>` +
      `<td>${cty && cty.cc ? `<span class="cflag" title="${esc(cty.name)}"><img src="${flagUrl(cty.cc)}" alt="${cty.cc.toUpperCase()}" onerror="this.replaceWith(this.alt)"><span>${cty.cc.toUpperCase()}</span></span>` : ""}</td>` +
      `<td class="flt">${esc(a.flight)}</td><td class="reg">${esc(a.reg)}</td><td class="icao">${esc(a.hex)}</td>` +
      `<td>${ext(ac && ac.type)}</td><td class="model">${ext(ac && ac.desc)}</td><td>${ext(hfdlFl(ac))}</td><td>${ext(hfdlSpd(ac))}</td><td>${ext(ac && ac.squawk)}</td>` +
      `<td>${p ? `<a href="#" class="acars-goto" title="Show on the MAP">${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</a>` : ""}</td>` +
      `<td>${p ? `${esc(p.src)} · ${hfdlAge(p.t)}` : ""}</td><td>${esc(a.gs || "")}</td><td class="num">${a.n}</td></tr>`;
  }).join("");
  $("acarsAcEmpty").hidden = list.length > 0;
}

function acarsPopup(a) {
  const ac = a.ac, p = hfdlPos(a), esc = escHtml, hex = a.hex.toLowerCase();
  const links = hex ? `<a href="https://globe.adsb.fi/?icao=${hex}" target="_blank" rel="noopener">adsb.fi</a> · <a href="https://adsb.lol/?icao=${hex}" target="_blank" rel="noopener">adsb.lol</a>` : "";
  return `<b>${esc(a.flight || a.reg || a.hex)}</b> ${esc([a.reg, a.hex].filter((x) => x && x !== a.flight).join(" · "))}` +
    (ac && ac.found ? `<br>${esc([ac.type, ac.desc].filter(Boolean).join(" · "))}<br>${esc([hfdlFl(ac), hfdlSpd(ac), ac.squawk && `squawk ${ac.squawk}`].filter(Boolean).join(" · "))}` : "") +
    (p ? `<br>position ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)} (${esc(p.src)}, ${hfdlAge(p.t)} ago)` : "") +
    `<br>last heard ${hfdlUtc(a.last)} UTC${a.gs ? ` via ${esc(a.gs)}` : ""} · ${a.n} msgs` + (links ? `<br>${links}` : "");
}

async function acarsMapOpen() {
  try {
    await Promise.all([satAsset("/static/leaflet/leaflet.css"), satAsset("/static/leaflet/leaflet.js")]);
  } catch (e) {
    $("acarsMapNote").textContent = e.message;
    return false;
  }
  if (!acarsMap) {
    acarsMap = L.map($("acarsMap"), { worldCopyJump: true, minZoom: 2 }).setView([48, 17], 6);
    // the same darkened OpenStreetMap tiles as the HFDL map
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 13, className: "hfdl-dark",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).addTo(acarsMap);
    mapPopout(acarsMap, "acars");
    acarsMapLayers = { gs: L.layerGroup().addTo(acarsMap), tracks: L.layerGroup().addTo(acarsMap), planes: L.layerGroup().addTo(acarsMap), marks: new Map() };
    try {
      const s = await satFetch("/api/location");
      if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
        L.circleMarker([s.lat, s.lon], { radius: 6, color: "#000", weight: 2, fillColor: "#ff5a3c", fillOpacity: 1 }).bindTooltip("QTH").addTo(acarsMap);
        if (!acarsMapLayers.marks.size) acarsMap.setView([s.lat, s.lon], 6);
      }
    } catch { /* server unreachable */ }
  }
  return true;
}

async function renderAcarsMap() {
  if (!(await acarsMapOpen())) return;
  acarsMap.invalidateSize();
  const lay = acarsMapLayers, esc = escHtml;
  lay.gs.clearLayers();
  for (const g of acarsGsPos.values()) {
    L.marker([g.lat, g.lon], { icon: L.divIcon({ className: "hfdl-gs-mark heard", html: "▲", iconSize: [14, 14], iconAnchor: [7, 7] }), zIndexOffset: -1000 })
      .bindTooltip(`VDL2 ground station ${esc(g.addr)}${g.gs_loc && g.gs_loc !== "-" ? ` · ${esc(g.gs_loc)}` : ""}${g.gs_city ? ` ${esc(g.gs_city)}` : ""}` +
        `<br>${fmtMHz(g.freq_hz, 3)} MHz · ${hfdlUtc(g.t)} UTC`, { direction: "top" }).addTo(lay.gs);
  }
  lay.tracks.clearLayers();
  const list = [...acarsAc.values()].filter((a) => a.pts.length).sort((a, b) => b.last - a.last);
  const keep = new Set();
  for (const a of list) {
    const p = hfdlPos(a), track = hfdlTrack(a);
    keep.add(a.key);
    if (track.length > 1) L.polyline(track.map((q) => [q.lat, q.lon]), { color: a.key === acarsSel ? "#ff4b3c" : "#fff", weight: a.key === acarsSel ? 2.5 : 1.5, opacity: 0.7 }).addTo(lay.tracks);
    let mk = lay.marks.get(a.key);
    const label = `${esc(a.flight || a.reg || a.hex)}${a.ac && a.ac.found && a.ac.type ? `<br>${esc(a.ac.type)}` : ""}`;
    if (!mk) {
      mk = L.marker([p.lat, p.lon]).bindPopup("").bindTooltip("", { permanent: true, direction: "bottom", offset: [0, 8], className: "hfdl-label" }).addTo(lay.planes);
      mk.on("click", () => acarsSelect(a.key, false));
      lay.marks.set(a.key, mk);
    }
    mk.setLatLng([p.lat, p.lon]);
    mk.setIcon(hfdlPlaneIcon(a, a.key === acarsSel));
    mk.setTooltipContent(label);
    mk.setPopupContent(acarsPopup(a));
  }
  for (const [k, mk] of lay.marks) if (!keep.has(k)) { mk.remove(); lay.marks.delete(k); }
  if (!acarsMapFitted && lay.marks.size) {
    acarsMapFitted = true;
    acarsMap.fitBounds(L.featureGroup([...lay.marks.values()]).getBounds().pad(0.3), { maxZoom: 7 });
  }
  $("acarsMapList").innerHTML = `<div class="hfdl-ml-head">Tracking ${list.length} aircraft${acarsAc.size > list.length ? ` (${acarsAc.size - list.length} without a position)` : ""}</div>` +
    list.map((a) => {
      const cty = a.hex ? icaoCountry(a.hex) : null, ac = a.ac && a.ac.found ? a.ac : null;
      return `<div class="hfdl-ml${a.key === acarsSel ? " sel" : ""}${Date.now() / 1000 - a.last > HFDL_OLD_S ? " old" : ""}" data-key="${esc(a.key)}">` +
        `${cty && cty.cc ? `<img src="${flagUrl(cty.cc)}" alt="" title="${esc(cty.name)}">` : "<span class=\"noflag\"></span>"}` +
        `<b>${esc(a.flight || "-")}</b><span>${esc(a.reg)}</span><span class="icao">${esc(a.hex)}</span>` +
        `<span class="ext">${esc(ac ? ac.type : "")}</span><span class="ext">${esc(hfdlFl(ac))}</span><span class="age">${hfdlAge(a.last)}</span></div>`;
    }).join("");
  $("acarsMapNote").textContent = `${list.length} aircraft with a position · positions from ADS-B (at the time of the message), ADS-C and VDL2 XID (approximate)` +
    ` · ▲ VDL2 ground stations · red = selected · grey = not heard for an hour · map © OpenStreetMap`;
}

/** Selects an aircraft (map list or a click on its icon): red, popup, centred. */
function acarsSelect(key, pan = true) {
  acarsSel = key;
  renderAcarsMap().then(() => {
    const mk = acarsMapLayers && acarsMapLayers.marks.get(key);
    if (!mk) return;
    if (pan) acarsMap.setView(mk.getLatLng(), Math.max(acarsMap.getZoom(), 7));
    mk.openPopup();
  });
}

function setAcarsView(v) {
  acarsView = v;
  store("acarsView", v);
  for (const b of $("acarsViews").children) b.classList.toggle("on", b.dataset.view === v);
  $("acarsMsgBox").hidden = v !== "msgs";
  $("acarsAcBox").hidden = v !== "aircraft";
  $("acarsMapBox").hidden = v !== "map";
  $("acarsFilter").hidden = v !== "msgs";
  if (v !== "msgs" && acarsPausedRow) acarsResume();
  renderAcarsView();
}
$("acarsViews").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setAcarsView(b.dataset.view); });
$("acarsMapList").addEventListener("click", (e) => { const r = e.target.closest("[data-key]"); if (r) acarsSelect(r.dataset.key); });
$("acarsAcRows").addEventListener("click", (e) => {
  if (!e.target.closest(".acars-goto")) return;
  e.preventDefault();
  const key = e.target.closest("tr").dataset.key;
  setAcarsView("map");
  acarsSelect(key);
});
setTimeout(() => setAcarsView(acarsView));   // after the declarations below

function acarsAcClear() {
  acarsAc.clear();
  acarsAcAlias.clear();
  acarsGsPos.clear();
  acarsSel = null;
  acarsMapFitted = false;
  if (acarsMapLayers) { acarsMapLayers.planes.clearLayers(); acarsMapLayers.tracks.clearLayers(); acarsMapLayers.gs.clearLayers(); acarsMapLayers.marks.clear(); }
  renderAcarsView();
}

$("acarsOn").addEventListener("change", () => {
  st.acars = $("acarsOn").checked;
  if (st.acars && st.vdl2) { st.vdl2 = false; $("vdl2On").checked = false; }   // one link at a time
  renderAcarsInfo();
  renderLinkBands();
  send({ acars: st.acars });
});

// ---------- VDL2 (VDL Mode 2 through dumpvdl2; messages go to the ACARS card) ----------

const VDL2_TITLE = $("vdl2On").parentElement.title;   // tooltip from index.html (replaced on a device without VDL2)
let vdl2Last = {};   // the status sends only on/off and the error; channels and counts come from vdl2state

function renderVdl2Info(d) {
  if (!d) return;
  const i = (vdl2Last = { ...vdl2Last, ...d });
  const el = $("vdl2Info");
  el.hidden = !i.enabled;
  el.classList.toggle("err", !!i.error);
  if (i.error) { el.textContent = `VDL2: ${i.error}`; return; }
  const n = (i.channels || []).length;
  el.title = n ? `Decoded channels: ${i.channels.map((f) => fmtMHz(f, 3)).join(", ")} MHz` : "";
  el.textContent = `VDL2${n ? ` ${n} channels` : ""}${i.frames ? ` · ${i.frames} frames` : ""}`;
}

$("vdl2On").addEventListener("change", () => {
  st.vdl2 = $("vdl2On").checked;
  if (st.vdl2) st.ism = false;
  if (st.vdl2 && st.acars) { st.acars = false; $("acarsOn").checked = false; }
  renderAcarsInfo();
  renderLinkBands();
  renderVdl2Info({ enabled: st.vdl2 });
  send({ vdl2: st.vdl2 });
});
// ---------- DAB / DAB+ (welle-cli; the VFO feeds it through rtl_tcp, audio is its MP3 stream) ----------

let dabSid = null;      // station playing (service ID, hex)
let dabTimer = null;    // polling of /api/dab while the card is shown
let dabMotTime = 0;     // slide time of the playing station (a new one -> reload the picture)
let dabEl = null;       // <audio> playing the MP3 stream, routed into MAIN (masterGain)
let dabLastInfo = {};
// stations whose slides are 16:9 pictures squeezed into 320x240 (a click on the slide toggles it, remembered per station)
const dabWide = new Set(JSON.parse(recall("dabWide") || "[]"));

const dabEsc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** DAB key in MODE: DAB on (the server tunes the VFO to the saved channel at 2.048 MS/s). */
function dabOn() {
  if (noRtlDongle(st) || st.chain_owner) {
    adError(st.chain_owner ? `DAB needs its own dongle (this VFO shares the dongle of VFO ${st.chain_owner})`
      : `DAB is not supported on ${DEVICE_NAMES[st.driver]} (RTL-SDR only)`);
    return;
  }
  if (!st.dab) {
    st.dab = true;
    if (st.acars || st.vdl2) { st.acars = st.vdl2 = false; $("acarsOn").checked = $("vdl2On").checked = false; }
    st.ism = false;
    send({ dab: true });
  }
  renderDab(st);
  setBodyTab("dab");
}

function renderDab(s) {
  const on = !!s.dab;
  renderControls();   // the DAB key of MODE
  renderModeTabs();
  if (on && s.dab_channel && $("dabChannel").value !== s.dab_channel) $("dabChannel").value = s.dab_channel;
  renderDabInfo({ enabled: on, error: s.dab_error });
  if (on && !dabTimer) { pollDab(); dabTimer = setInterval(pollDab, 1000); }
  if (!on && dabTimer) stopDab();
}

function renderDabInfo(d) {
  const i = (dabLastInfo = { ...dabLastInfo, ...d });
  const el = $("dabInfo");
  el.classList.toggle("err", !!i.error);
  if (i.error) { el.textContent = i.error; return; }
  const parts = [];
  if (i.freq_hz) parts.push(`${fmtMHz(i.freq_hz, 3)} MHz`);
  if (i.enabled && i.connected === false) parts.push("starting welle-cli…");
  else if (i.enabled && i.on_channel === false) parts.push("tuning…");
  el.textContent = parts.join(" · ");
}

const dabHue = (t) => [...String(t)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
/** Two letters for a station without a picture: "Radio Rock" -> RR, "Radio_FM" -> RF. */
const dabInitials = (t) => String(t).split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
const dabRow = (k, v) => (v === "" || v == null ? "" : `<div class="dab-row"><span>${k}</span><b>${dabEsc(v)}</b></div>`);
const dabRegion = new Intl.DisplayNames(["en"], { type: "region" });

function dabShowArt(label) {
  const el = $("dabArtMono");
  el.textContent = label ? dabInitials(label) : "";
  el.style.setProperty("--h", dabHue(label || ""));
}

/** Station of this channel to play: the last one selected (null = it was stopped by hand). */
function dabRemembered(channel) { return ((st && st.dab_sids) || {})[channel] || null; }

function dabRemember(sid) {
  const channel = dabLastInfo.channel || st.dab_channel;
  st.dab_sids = { ...(st.dab_sids || {}), [channel]: sid };
  send({ dab_sid: sid });
}

/** [word, colour] of the DAB signal by its SNR in dB (null = not known). */
const dabQuality = (snr) => (snr == null ? ["", ""] : snr >= 12 ? ["good", "var(--green)"] : snr >= 8 ? ["usable", "var(--accent)"] : ["weak", "#ff7b6b"]);

function renderDabSide(m, cur) {
  const snr = m.snr == null ? null : Number(m.snr);
  const quality = dabQuality(snr);
  $("dabSignal").innerHTML = (snr == null ? `<div class="dab-row"><span>No signal yet</span></div>`
    : `<div class="dab-snr" style="--q:${quality[1]}"><b>${snr.toFixed(1)}</b> dB SNR <span>${quality[0]}</span></div>` +
      `<div class="dab-gauge" style="--q:${quality[1]}"><i style="width:${Math.max(0, Math.min(100, snr * 4))}%"></i></div>`) +
    dabRow("Frequency", m.freq_hz ? `${fmtMHz(m.freq_hz, 3)} MHz` : "") +
    dabRow("Correction", m.freq_corr != null ? `${Math.round(m.freq_corr)} Hz` : "") +
    dabRow("FIC CRC errors", m.fic_errors);
  $("dabEnsInfo").innerHTML = dabRow("Name", m.ensemble) +
    dabRow("Country", m.country ? dabRegion.of(m.country.toUpperCase()) : "") +
    dabRow("ID", m.ensemble_id) +
    dabRow("Stations", m.services.length || "") +
    dabRow("Local time", m.local) +
    dabRow("UTC", m.utc);
  const used = m.services.reduce((a, x) => a + (x.cu || 0), 0);
  $("dabCapacity").parentElement.hidden = !used;
  $("dabCapacity").innerHTML = !used ? "" :
    `<div class="dab-cap-bar">` + m.services.filter((x) => x.cu).map((x) =>
      `<i class="${x.sid === dabSid ? "on" : ""}" style="flex:${x.cu} 0 0;--h:${dabHue(x.label || x.sid)}" title="${dabEsc(x.label || x.sid)}: ${x.bitrate} kbit/s, ${x.cu} CU"></i>`).join("") +
    `<span style="flex:${Math.max(0, m.capacity_cu - used)} 0 0"></span></div>` +
    dabRow("Used", `${Math.round(used / m.capacity_cu * 100)} % (${used} of ${m.capacity_cu} CU)`) +
    (cur ? dabRow("This station", `${Math.round((cur.cu || 0) / m.capacity_cu * 100)} %`) : "");
  const flag = $("dabFlag");
  if (flag.dataset.cc !== (m.country || "")) {
    flag.dataset.cc = m.country || "";
    flag.hidden = true;
    if (m.country) flag.src = flagUrl(m.country);
  }
}

function renderDabNow(cur) {
  const label = cur.label || cur.sid;
  $("dabNowLabel").textContent = label;
  dabShowArt(label);
  const chips = [cur.pty && `<span class="pty">${dabEsc(cur.pty)}</span>`, cur.type && `<span>${dabEsc(cur.type)}</span>`,
    cur.bitrate && `<span>${cur.bitrate} kbit/s</span>`, cur.language && `<span>${dabEsc(cur.language)}</span>`,
    cur.protection && `<span title="Error protection of the subchannel">${dabEsc(cur.protection)}</span>`];
  $("dabChips").innerHTML = chips.filter(Boolean).join("");
  $("dabNowMeta").textContent = cur.mode || "buffering…";
  $("dabDls").textContent = cur.dls || "";
  $("dabDlsBox").hidden = !cur.dls;
  const e = cur.errors || {};
  const errs = (e.frameerrors || 0) + (e.rserrors || 0) + (e.aacerrors || 0);
  $("dabHealth").innerHTML = (errs ? `<span class="bad">●</span> errors: frame ${e.frameerrors} · RS ${e.rserrors} · AAC ${e.aacerrors}` : `<span class="ok">●</span> no decoding errors`) +
    ` · SID ${dabEsc(cur.sid)}` + (cur.subch != null ? ` · subchannel ${cur.subch}` : "");
}

/** Stops polling and audio (DAB off, or another VFO selected). */
function stopDab() {
  clearInterval(dabTimer);
  dabTimer = null;
  dabPlay(null);
  dabLastInfo = {};
  $("dabServices")._key = null;
  $("dabServices").innerHTML = `<div class="ft8-empty">Searching the ensemble…</div>`;
  $("dabEnsemble").textContent = "";
  $("dabFlag").hidden = true;
  $("dabFlag").dataset.cc = "";
  for (const id of ["dabSignal", "dabEnsInfo", "dabCapacity"]) $(id).innerHTML = "";
}

async function pollDab() {
  const base = vbase;
  let m;
  try {
    m = await (await fetch(base + "/api/dab")).json();
  } catch (e) { return; }
  if (base !== vbase || !st || !st.dab) return;
  renderDabInfo(m);
  $("dabEnsemble").textContent = m.ensemble || "";
  const list = $("dabServices");
  const key = m.services.map((x) => [x.sid, x.label, x.audio, x.pty, x.type, x.bitrate, x.encrypted].join()).join("|") + "#" + !!m.ensemble;
  if (list._key !== key) {
    list._key = key;
    list.innerHTML = m.services.length
      ? m.services.map((x) => {
        const label = x.label || x.sid;
        return `<button class="dab-st" data-sid="${x.sid}" data-label="${dabEsc(label)}" ${x.audio && !x.encrypted ? "" : "disabled"} title="${dabEsc(label)} · SID ${x.sid}${x.encrypted ? " · encrypted" : ""}">` +
          `<i class="dab-mono" style="--h:${dabHue(label)}">${dabEsc(dabInitials(label))}</i>` +
          `<span class="dab-st-text"><b>${dabEsc(label)}</b><small>${dabEsc(x.pty || (x.audio ? "Radio" : "Data"))}</small></span>` +
          `<span class="dab-eq"><i></i><i></i><i></i></span>` +
          `<span class="dab-st-tag">${x.type ? `<em>${x.type}</em>` : ""}${x.bitrate ? `<small>${x.bitrate} kbit/s</small>` : ""}</span></button>`;
      }).join("")
      : `<div class="ft8-empty">${m.ensemble ? "No stations yet…" : "Searching the ensemble… (no DAB signal on this channel?)"}</div>`;
  }
  for (const b of list.querySelectorAll("button")) b.classList.toggle("on", b.dataset.sid === dabSid);
  // the last station of this channel comes back by itself (after a restart, another VFO, another channel)
  const wanted = !dabSid && m.channel === st.dab_channel && dabRemembered(m.channel);
  if (wanted && m.services.some((x) => x.sid === wanted && x.audio && !x.encrypted)) dabPlay(wanted);
  const cur = m.services.find((x) => x.sid === dabSid);
  adDabInfo = cur ? { label: cur.label || cur.sid, type: cur.type, dls: cur.dls || "", snr: m.snr } : null;
  renderAd();
  renderDabSide(m, cur);
  if (!cur) return;
  renderDabNow(cur);
  if (cur.mot_time && cur.mot_time !== dabMotTime) {
    dabMotTime = cur.mot_time;
    $("dabSlide").src = `${base}/api/dab/slide/${cur.sid}?t=${cur.mot_time}`;
  }
}

/** Plays station sid (null = stop). The MP3 stream goes through MAIN volume like the normal audio. */
function dabPlay(sid) {
  dabSid = sid;
  adDabInfo = null;                       // the AD window: filled again by the next pollDab
  renderAd();
  dabMotTime = 0;
  $("dabSlide").hidden = true;
  $("dabSlide").removeAttribute("src");
  $("dabGlow").style.backgroundImage = "";
  dabArtRatio();
  if (dabEl) { dabEl.pause(); dabEl.removeAttribute("src"); dabEl.load(); }
  for (const b of $("dabServices").querySelectorAll("button")) b.classList.toggle("on", b.dataset.sid === sid);
  if (!sid) {
    $("dabNowLabel").textContent = "Select a station";
    for (const id of ["dabNowMeta", "dabDls", "dabHealth", "dabChips"]) $(id).textContent = "";
    $("dabDlsBox").hidden = true;
    dabShowArt("");
    return;
  }
  const ctx = audioContext();
  if (!dabEl) {
    dabEl = new Audio();
    dabEl.crossOrigin = "anonymous";      // the receiver of the VFO is on another port (CORS * on the server)
    ctx.createMediaElementSource(dabEl).connect(audioTap);
  }
  dabEl.src = `${vbase}/api/dab/audio/${sid}`;
  dabEl.play().catch(() => {
    // the browser allows sound only after the first click or key on the page (a remembered station after a reload)
    const retry = () => { if (dabSid === sid) dabEl.play().catch(() => {}); };
    for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, retry, { capture: true, once: true });
  });
  ctx.resume();
  const b = $("dabServices").querySelector(`[data-sid="${sid}"]`);
  const label = b ? b.dataset.label : sid;
  $("dabNowLabel").textContent = label;
  dabShowArt(label);
  $("dabChips").textContent = "";
  $("dabNowMeta").textContent = "buffering…";
  $("dabDls").textContent = "";
  $("dabDlsBox").hidden = true;
}

/** Sets the ratio of the picture box: the slide's own, 16:9 for a station marked wide, 4:3 with no slide. */
function dabArtRatio() {
  const img = $("dabSlide");
  let r = "4 / 3";
  if (!img.hidden && img.naturalWidth && img.naturalHeight) r = dabWide.has(dabSid) ? "16 / 9" : `${img.naturalWidth} / ${img.naturalHeight}`;
  document.querySelector(".dab-art").style.aspectRatio = r;
}
$("dabSlide").addEventListener("click", () => {
  if (!dabSid) return;
  if (!dabWide.delete(dabSid)) dabWide.add(dabSid);
  store("dabWide", JSON.stringify([...dabWide]));
  dabArtRatio();
});
$("dabSlide").addEventListener("load", () => {
  $("dabSlide").hidden = false;
  dabArtRatio();
  $("dabGlow").style.backgroundImage = `url("${$("dabSlide").src}")`;
});
$("dabFlag").addEventListener("load", () => { $("dabFlag").hidden = false; });
$("dabFlag").addEventListener("error", () => { $("dabFlag").hidden = true; });
$("dabSlide").addEventListener("error", () => { $("dabSlide").hidden = true; dabArtRatio(); });
$("dabServices").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sid]");
  if (!b || b.disabled) return;
  const sid = b.dataset.sid === dabSid ? null : b.dataset.sid;
  dabPlay(sid);
  dabRemember(sid);
});
/** Goes to another DAB channel: the station of the old one stops, the last station of the new one comes back in pollDab. */
function dabSetChannel(ch) {
  if (st.dab && ch !== st.dab_channel) {
    dabPlay(null);
    $("dabServices")._key = null;
  }
  st.dab_channel = ch;
  send({ dab_channel: ch });
}
$("dabChannel").addEventListener("change", () => dabSetChannel($("dabChannel").value));
/** A DAB memory: DAB on, on its channel. Where DAB cannot run, dabOn says why. */
function dabRecall(ch) {
  if (!noRtlDongle(st) && !st.chain_owner) dabSetChannel(ch);
  dabOn();
}
/** DAB off (another mode in MODE, a band button or a memory): the previous sample rate comes back. */
function dabOff() {
  st.dab = false;
  send({ dab: false });
  renderDab(st);
}

$("acarsBands").addEventListener("click", onLinkBand);
$("acarsRows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr && !e.target.closest("a")) acarsPause(tr);     // links (callsign, flight) only open the map
  const td = e.target.closest("td.msg.long");
  if (!td || e.target.closest(".atn-detail") || String(getSelection())) return;   // selecting text in the detail
  td.classList.toggle("open");
});
$("acarsClear").addEventListener("click", () => {
  acarsDropHeld();
  acarsResume();
  for (const api of ["/api/acars", "/api/cpdlc"]) {
    fetch(vbase + api, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"clear"}' });
  }
  $("acarsRows").innerHTML = "";
  $("acarsEmpty").hidden = false;
  $("acarsInfo").textContent = "";
  renderAcarsFilter();
  acarsAcClear();
});

// ---------- WEFAX ----------

const WFX_BLOCK = 32; // rows per canvas; the image grows in blocks without copying
const WFX_STATES = { idle: "waiting for signal", free: "receiving (no start)", phasing: "phasing", rx: "receiving" };
let wfx = { id: null, width: 1810, rows: 0, blocks: [] };
let wfxSlant = 0;        // ppm, from the server
let wfxAlign = null;     // ALIGN: null = off, [] = waiting for the 1st point, [p] = for the 2nd

function wefaxReset(id, width) {
  for (const cv of $("wefaxWrap").querySelectorAll("canvas")) cv.remove();
  wfx = { id, width, rows: 0, blocks: [] };
  $("wefaxEmpty").hidden = false;
}

function wefaxBlock(b) {
  if (!wfx.blocks[b]) {
    const cv = document.createElement("canvas");
    cv.width = wfx.width;
    cv.height = WFX_BLOCK;
    cv.className = "wefax-block";
    $("wefaxWrap").insertBefore(cv, $("wefaxEmpty"));
    wfx.blocks[b] = cv.getContext("2d");
  }
  return wfx.blocks[b];
}

function wefaxAddRow(b64) {
  const wrap = $("wefaxWrap");
  const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 30;
  const bin = atob(b64);
  const img = new ImageData(bin.length, 1);
  for (let i = 0; i < bin.length; i++) {
    const g = bin.charCodeAt(i);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g;
    img.data[i * 4 + 3] = 255;
  }
  wefaxBlock(Math.floor(wfx.rows / WFX_BLOCK)).putImageData(img, 0, wfx.rows % WFX_BLOCK);
  wfx.rows++;
  $("wefaxEmpty").hidden = true;
  if (atBottom) wrap.scrollTop = wrap.scrollHeight;
}

function wefaxTrim(rows) {
  for (let r = rows; r < wfx.rows; r++) {
    const ctx = wfx.blocks[Math.floor(r / WFX_BLOCK)];
    if (ctx) ctx.clearRect(0, r % WFX_BLOCK, wfx.width, 1);
  }
  wfx.rows = rows;
}

async function wefaxLoad() {
  const info = await fetch(vbase + "/api/wefax").then((r) => r.json());
  $("wefaxBands").innerHTML = info.freqs.map(([f, label]) =>
    `<button data-f="${f}" title="${fmtKHz(f, 1)} kHz (USB ${fmtKHz(f - 1900, 1)})">${label}</button>`).join("");
  wefaxReset(info.image_id, info.width);
  if (info.rows) await wefaxLoadImage();
  renderWefaxInfo(info);
}

/** Draws the whole current image from the server (after a VFO switch, or after the slant correction). */
async function wefaxLoadImage() {
  const id = wfx.id;
  const img = new Image();
  img.crossOrigin = "anonymous";   // image from the VFO port; without this the canvas could not be saved
  img.src = `${vbase}/api/wefax/image.png?t=${Date.now()}`;
  try { await img.decode(); } catch { return; }   // no image (yet)
  if (wfx.id !== id) return;                       // a new image started meanwhile
  wfx.width = img.width;
  for (let b = 0; b * WFX_BLOCK < img.height; b++) {
    const ctx = wefaxBlock(b);
    ctx.clearRect(0, 0, img.width, WFX_BLOCK);
    ctx.drawImage(img, 0, b * WFX_BLOCK, img.width, WFX_BLOCK, 0, 0, img.width, WFX_BLOCK);
  }
  wfx.rows = img.height;
  $("wefaxEmpty").hidden = true;
}

let wefaxFiles = "";
function renderWefaxInfo(i) {
  const afc = (i.afc ? `centre ${i.center_hz} Hz ✓` : "searching for signal") +
    (i.afc_vfo && i.afc && i.afc_shift != null ? ` · VFO ${i.afc_shift > 0 ? "+" : ""}${i.afc_shift} Hz` : "");
  $("wefaxInfo").textContent = `${WFX_STATES[i.state] || i.state} · ${i.lpm} LPM · IOC ${i.ioc} · ${afc}` +
    (i.rows ? ` · ${i.rows} lines` : "") + (i.saved ? ` · saved ${i.saved}` : "");
  if (document.activeElement !== $("wefaxLpm")) $("wefaxLpm").value = i.lpm_mode;
  if (document.activeElement !== $("wefaxIoc")) $("wefaxIoc").value = i.ioc_mode;
  if (i.afc_vfo != null) $("wefaxAfc").checked = i.afc_vfo;
  if (i.slant_ppm != null) {
    wfxSlant = i.slant_ppm;
    if (document.activeElement !== $("wefaxSlant")) $("wefaxSlant").value = i.slant_ppm;
  }
  if (!i.files) return;
  const files = i.files.join("|");
  if (files !== wefaxFiles) {
    wefaxFiles = files;
    $("wefaxGallery").innerHTML = i.files.map((n) => {
      const u = `${vbase}/api/wefax/files/${encodeURIComponent(n)}`;
      return `<div class="sstv-item"><a href="${u}" target="_blank" title="${n}"><img src="${u}" loading="lazy" alt=""><span>${n.slice(6, 21).replace("_", " ")}</span></a>` +
        `<button class="sstv-del" data-del="${n}" title="Delete this image">×</button></div>`;
    }).join("");
  }
  $("wefaxDelAll").disabled = !i.files.length;
}
$("wefaxGallery").addEventListener("click", (e) => {
  const b = e.target.closest("[data-del]");
  if (!b) return;
  e.preventDefault();
  if (confirm(`Delete ${b.dataset.del}?`)) wefaxCmd({ delete: b.dataset.del });
});
$("wefaxDelAll").addEventListener("click", () => {
  if (confirm("Delete all saved WEFAX images in data\\wefax?")) wefaxCmd({ delete: "all" });
});

function wefaxAlignMode(on) {
  wfxAlign = on ? [] : null;
  $("wefaxAlign").classList.toggle("on", on);
  $("wefaxAlign").textContent = on ? "ALIGN 1/2" : "ALIGN";
  $("wefaxWrap").classList.toggle("aligning", on);
}

function wefaxCmd(body) {
  fetch(vbase + "/api/wefax", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json()).then((i) => { if (!i.error) renderWefaxInfo(i); });
}

$("wefaxOn").addEventListener("change", () => {
  st.wefax = $("wefaxOn").checked;
  $("wefaxCard").hidden = !st.wefax;
  send({ wefax: st.wefax });
});
$("wefaxBands").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-f]");
  if (!b || !st) return;
  await ensureVfoFor(Number(b.dataset.f) - 1900);
  if (!st) return;
  // Standard: USB tuning 1.9 kHz below the assigned frequency (AFC finds the exact centre anyway).
  st.mode = "USB";
  renderControls();
  tune(Number(b.dataset.f) - 1900);
  send({ mode: "USB" });
});
$("wefaxLpm").addEventListener("change", () => wefaxCmd({ lpm_mode: $("wefaxLpm").value }));
$("wefaxIoc").addEventListener("change", () => wefaxCmd({ ioc_mode: $("wefaxIoc").value }));
$("wefaxNew").addEventListener("click", () => wefaxCmd({ action: "new" }));
$("wefaxAfc").addEventListener("change", () => wefaxCmd({ afc_vfo: $("wefaxAfc").checked }));
$("wefaxSlant").addEventListener("change", () => {
  const v = Number($("wefaxSlant").value);
  if (Number.isFinite(v)) wefaxCmd({ slant_ppm: v });
});
$("wefaxAlign").addEventListener("click", () => wefaxAlignMode(wfxAlign === null));
$("wefaxWrap").addEventListener("click", (e) => {
  const cv = e.target.closest("canvas");
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  if (wfxAlign !== null) {
    // point in image pixels: x across the line, y = line number
    const blk = [...$("wefaxWrap").querySelectorAll("canvas")].indexOf(cv);
    const p = { x: (e.clientX - r.left) / r.width * wfx.width, y: blk * WFX_BLOCK + (e.clientY - r.top) / r.height * WFX_BLOCK };
    if (!wfxAlign.length) {
      wfxAlign.push(p);
      $("wefaxAlign").textContent = "ALIGN 2/2";
      return;
    }
    const a = wfxAlign[0];
    wefaxAlignMode(false);
    const dy = p.y - a.y;
    if (Math.abs(dy) < 8) return;          // too close: the drift could not be measured
    // A line leaning to the right going down = our line is too short -> the correction grows.
    let dx = p.x - a.x;
    if (dx > wfx.width / 2) dx -= wfx.width;
    if (dx < -wfx.width / 2) dx += wfx.width;
    const ppm = Math.round((wfxSlant + dx / dy / wfx.width * 1e6) * 10) / 10;
    wefaxCmd({ slant_ppm: Math.max(-3000, Math.min(3000, ppm)) });
    return;
  }
  wefaxCmd({ action: "phase", x: (e.clientX - r.left) / r.width });
});

// ---------- SSTV ----------

const SSTV_STATES = { idle: "waiting for signal", rx: "receiving", free: "receiving (no VIS)" };
let sstvImg = { id: null, ctx: null };

function sstvReset(id, w, h) {
  const cv = $("sstvCanvas");
  cv.width = w;
  cv.height = h;
  sstvImg = { id, ctx: cv.getContext("2d") };
  sstvImg.ctx.fillStyle = "#000";
  sstvImg.ctx.fillRect(0, 0, w, h);
  $("sstvEmpty").hidden = id == null;
}

function sstvAddRow(y, b64) {
  const bin = atob(b64);
  const w = bin.length / 3;
  const img = new ImageData(w, 1);
  for (let i = 0; i < w; i++) {
    img.data[i * 4] = bin.charCodeAt(i * 3);
    img.data[i * 4 + 1] = bin.charCodeAt(i * 3 + 1);
    img.data[i * 4 + 2] = bin.charCodeAt(i * 3 + 2);
    img.data[i * 4 + 3] = 255;
  }
  sstvImg.ctx.putImageData(img, 0, y);
  $("sstvEmpty").hidden = true;
}

// Whole image from the server (on a VFO switch and when finished, redrawn with slant correction).
async function sstvReload() {
  const id = sstvImg.id;
  const r = await fetch(`${vbase}/api/sstv/image.png?t=${Date.now()}`);
  if (r.status !== 200 || id !== sstvImg.id) return;
  const bmp = await createImageBitmap(await r.blob());
  sstvImg.ctx.drawImage(bmp, 0, 0);
  $("sstvEmpty").hidden = true;
}

async function sstvLoad() {
  const info = await fetch(vbase + "/api/sstv").then((r) => r.json());
  $("sstvBands").innerHTML = info.freqs.map(([f, label, mode]) =>
    `<button data-f="${f}" data-mode="${mode}" title="${fmtKHz(f, 1)} kHz ${mode}">${label}</button>`).join("");
  $("sstvMode").innerHTML = `<option value="auto">Auto (VIS)</option>` +
    info.modes.map((m) => `<option>${m}</option>`).join("");
  sstvReset(info.rows ? info.image_id : null, info.width, info.height);
  if (info.rows) await sstvReload();
  renderSstvInfo(info);
}

let sstvFiles = "";
function renderSstvInfo(i) {
  const parts = [SSTV_STATES[i.state] || i.state];
  if (i.mode) parts.push(i.mode + (i.vis != null ? ` (VIS ${i.vis})` : ""), `${i.rows}/${i.height} lines`);
  if (i.state !== "idle") parts.push(`AFC ${i.afc_hz > 0 ? "+" : ""}${i.afc_hz} Hz`, `slant ${i.slant_ppm} ppm`);
  if (i.saved) parts.push(`saved ${i.saved}`);
  $("sstvInfo").textContent = parts.join(" · ");
  if (document.activeElement !== $("sstvMode")) $("sstvMode").value = i.mode_sel;
  $("sstvStop").disabled = i.state === "idle";
  const files = (i.files || []).join("|");
  if (files !== sstvFiles) {
    sstvFiles = files;
    $("sstvGallery").innerHTML = (i.files || []).map((n) => {
      const u = `${vbase}/api/sstv/files/${encodeURIComponent(n)}`;
      return `<div class="sstv-item"><a href="${u}" target="_blank" title="${n}"><img src="${u}" loading="lazy" alt=""><span>${n.slice(5, 20).replace("_", " ")}</span></a>` +
        `<button class="sstv-del" data-del="${n}" title="Delete this image">×</button></div>`;
    }).join("");
  }
  $("sstvDelAll").disabled = !(i.files || []).length;
}

$("sstvGallery").addEventListener("click", (e) => {
  const b = e.target.closest("[data-del]");
  if (!b) return;
  e.preventDefault();
  if (confirm(`Delete ${b.dataset.del}?`)) sstvCmd({ delete: b.dataset.del });
});
$("sstvDelAll").addEventListener("click", () => {
  if (confirm("Delete all saved SSTV images in data\\sstv?")) sstvCmd({ delete: "all" });
});

function sstvCmd(body) {
  fetch(vbase + "/api/sstv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json()).then((i) => { if (!i.error) renderSstvInfo(i); });
}

$("sstvOn").addEventListener("change", () => {
  st.sstv = $("sstvOn").checked;
  $("sstvCard").hidden = !st.sstv;
  send({ sstv: st.sstv });
});
$("sstvBands").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-f]");
  if (!b || !st) return;
  await ensureVfoFor(Number(b.dataset.f));
  if (!st) return;
  st.mode = b.dataset.mode;
  renderControls();
  tune(Number(b.dataset.f));
  send({ mode: st.mode });
});
$("sstvMode").addEventListener("change", () => sstvCmd({ mode: $("sstvMode").value }));
$("sstvStop").addEventListener("click", () => sstvCmd({ action: "stop" }));
$("sstvSave").addEventListener("click", () => {
  if (sstvImg.id == null) return;
  $("sstvCanvas").toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sstv_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
});
// ---------- PACKET: AX.25 frames, APRS stations and their map (packet.py, aprs.py) ----------

const PKT_MAX_ROWS = 500;
let pktView = ["frames", "stations", "map"].includes(recall("packetView")) ? recall("packetView") : "frames";
const pktStations = new Map();   // callsign / object name -> newest state (from the server)
let pktMap = null;               // Leaflet map, made when MAP is first opened
const pktMarks = new Map();
let pktFitted = false;
let pktStTimer = null;

const pktTime = (t) => new Date(t * 1000).toISOString().slice(11, 19);
const pktFilterText = () => $("packetFilter").value.trim().toUpperCase();
const pktMatch = (text) => { const f = pktFilterText(); return !f || text.toUpperCase().includes(f); };

function pktDataHtml(m) {
  const kind = m.kind === "UI" || m.kind === "I" ? "" : `<${m.kind}> `;
  if (m.summary !== undefined) {
    const t = m.aprs.type === "position" ? "" : `${m.aprs.type}: `;
    return `<span class="ap">${escHtml(t + m.summary)}</span><span class="raw">${escHtml(m.info)}</span>`;
  }
  return escHtml(kind) + (m.text ? escHtml(m.info) : `<span class="hex">${escHtml(m.info)}</span>`);
}

function addPacket(m) {
  const tb = $("packetRows");
  const tr = document.createElement("tr");
  tr.dataset.search = m.tnc2 + " " + (m.summary || "");
  tr.innerHTML = `<td title="${escHtml(fmtMHz(m.freq_hz, 4))} MHz">${pktTime(m.time)}</td>` +
    `<td class="${m.baud === 9600 ? "b96" : ""}">${m.baud}</td>` +
    `<td class="call">${escHtml(m.src)}</td><td>${escHtml(m.dest)}</td>` +
    `<td class="via" title="${escHtml(m.path.join(","))}">${escHtml(m.path.join(","))}</td>` +
    `<td class="data" title="${escHtml(m.len + " bytes" + (m.afc_hz !== undefined ? ` · AFC ${m.afc_hz} Hz` : "") + " · " + m.tnc2)}">${pktDataHtml(m)}</td>`;
  tr.hidden = !pktMatch(tr.dataset.search);
  tb.prepend(tr);
  while (tb.rows.length > PKT_MAX_ROWS) tb.lastChild.remove();
  $("packetEmpty").hidden = true;
  if (m.station) pktStation(m.station);
}

function pktStation(s) {
  pktStations.set(s.call, s);
  if (pktView === "map") pktMark(s);
  // the table is rebuilt at most twice a second (a busy APRS channel sends several packets a second)
  if (pktView === "stations" && !pktStTimer) pktStTimer = setTimeout(() => { pktStTimer = null; renderPktStations(); }, 500);
}

function pktReport(s) {
  const parts = [];
  if (s.summary) parts.push(s.summary);
  if (s.status) parts.push(`status: ${s.status}`);
  if (s.owner) parts.push(`object of ${s.owner}`);
  return parts.join(" · ");
}

function renderPktStations() {
  const rows = [...pktStations.values()].sort((a, b) => b.last - a.last)
    .filter((s) => pktMatch(`${s.call} ${s.owner || ""} ${s.via.join(",")} ${pktReport(s)}`));
  $("packetStRows").innerHTML = rows.map((s) => {
    const km = s.km === undefined ? "" : `${s.km < 100 ? s.km.toFixed(1) : Math.round(s.km)} / ${s.brg}°`;
    return `<tr><td>${pktTime(s.last)}</td>` +
      `<td class="call${s.lat !== undefined ? " click" : ""}" data-call="${escHtml(s.call)}" title="${s.lat !== undefined ? "show on the map" : "no position"}">${escHtml(s.call)}</td>` +
      `<td class="num">${s.count}</td><td>${km}</td>` +
      `<td class="via" title="${escHtml(s.via.join(","))}">${escHtml(s.via.join(","))}</td>` +
      `<td class="data">${escHtml(pktReport(s))}</td></tr>`;
  }).join("");
  $("packetStEmpty").hidden = pktStations.size > 0;
}

function pktMark(s) {
  if (!pktMap || s.lat === undefined) return;
  let mk = pktMarks.get(s.call);
  const tip = `${s.call}${s.km !== undefined ? ` · ${s.km} km ${s.brg}°` : ""}<br>${escHtml(pktReport(s))}<br>${pktTime(s.last)} UTC`;
  if (!mk) {
    mk = L.circleMarker([s.lat, s.lon], { radius: 6, color: "#000", weight: 1, fillColor: s.type === "weather" ? "#6cb8ff" : "#ffd84a", fillOpacity: 1 })
      .bindTooltip(escHtml(s.call), { permanent: true, direction: "right", offset: [6, 0], className: "pkt-label" })
      .bindPopup("").addTo(pktMap);
    pktMarks.set(s.call, mk);
  }
  mk.setLatLng([s.lat, s.lon]);
  mk.setPopupContent(tip);
}

async function pktMapOpen() {
  try {
    await Promise.all([satAsset("/static/leaflet/leaflet.css"), satAsset("/static/leaflet/leaflet.js")]);
  } catch (e) {
    $("packetMapNote").textContent = e.message;
    return;
  }
  if (!pktMap) {
    let qth = [48.6, 17.9];   // until the station of SETTINGS › GENERAL › LOCATION is known
    try {
      const s = await satFetch("/api/location");
      if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) qth = [s.lat, s.lon];
    } catch { /* server unreachable */ }
    pktMap = L.map($("packetMap"), { worldCopyJump: true }).setView(qth, 8);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).addTo(pktMap);
    L.circleMarker(qth, { radius: 7, color: "#000", weight: 2, fillColor: "#ff5a3c", fillOpacity: 1 }).bindTooltip("QTH").addTo(pktMap);
    mapPopout(pktMap, "packet");
  }
  pktMap.invalidateSize();
  for (const s of pktStations.values()) pktMark(s);
  if (!pktFitted && pktMarks.size) {
    pktFitted = true;
    pktMap.fitBounds(L.featureGroup([...pktMarks.values()]).getBounds().pad(0.2), { maxZoom: 11 });
  }
  $("packetMapNote").textContent = `${pktMarks.size} stations with a position · map © OpenStreetMap`;
}

function setPktView(v, fill = true) {
  pktView = v;
  store("packetView", v);
  for (const b of $("packetViews").children) b.classList.toggle("on", b.dataset.view === v);
  $("packetFramesBox").hidden = v !== "frames";
  $("packetStationsBox").hidden = v !== "stations";
  $("packetMapBox").hidden = v !== "map";
  if (fill && v === "stations") renderPktStations();
  if (fill && v === "map") pktMapOpen();
}

function renderPacketInfo(i) {
  $("packetRate").value = i.opts.rate;
  $("packetScr").value = i.opts.scrambler;
  const el = $("packetInfo");
  el.classList.toggle("err", !!i.error);
  if (!i.enabled) { el.textContent = ""; el.title = ""; return; }
  const afc = i.afc_hz === null || i.afc_hz === undefined ? "" : `  AFC ${i.afc_hz > 0 ? "+" : ""}${(i.afc_hz / 1000).toFixed(2)} kHz`;
  el.textContent = i.error || `${i.ok} OK  ${i.bad} bad CRC${afc}`;
  el.title = (i.error ? `${i.ok} OK · ${i.bad} bad CRC · ` : "") + `running: ${i.rates.join(" + ")} Bd` +
    (i.last_rx ? ` · last frame ${pktTime(i.last_rx)} UTC` : "") +
    (afc ? " · AFC = tuning error of the last 9600 Bd frame (+ = the signal is above the tuned frequency)" : "");
}

function packetPost(body) {
  return fetch(vbase + "/api/packet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json());
}

function packetReset() {
  $("packetRows").innerHTML = "";
  $("packetEmpty").hidden = false;
  pktStations.clear();
  for (const mk of pktMarks.values()) mk.remove();
  pktMarks.clear();
  pktFitted = false;
  renderPktStations();
}

async function packetLoad() {
  const v = active;
  try {
    const d = await fetch(vbase + "/api/packet").then((r) => r.json());
    if (v !== active) return;
    packetReset();
    for (const m of d.frames) addPacket({ ...m, station: undefined });
    for (const s of d.stations.slice().reverse()) pktStation(s);
    renderPacketInfo(d);
    setPktView(pktView);
  } catch { /* an older receiver without PACKET */ }
}

$("packetOn").addEventListener("change", () => {
  st.packet = $("packetOn").checked;
  $("packetCard").hidden = !st.packet;
  send({ packet: st.packet });
});
$("packetRate").addEventListener("change", () => packetPost({ opts: { rate: $("packetRate").value } }).then(renderPacketInfo));
$("packetScr").addEventListener("change", () => packetPost({ opts: { scrambler: $("packetScr").value } }).then(renderPacketInfo));
$("packetClear").addEventListener("click", () => { packetPost({ action: "clear" }).then(renderPacketInfo); packetReset(); });
$("packetViews").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setPktView(b.dataset.view); });
$("packetFilter").addEventListener("input", () => {
  for (const tr of $("packetRows").rows) tr.hidden = !pktMatch(tr.dataset.search);
  if (pktView === "stations") renderPktStations();
});
$("packetStRows").addEventListener("click", (e) => {
  const td = e.target.closest("td.call.click");
  if (!td) return;
  const s = pktStations.get(td.dataset.call);
  setPktView("map");
  pktMapOpen().then(() => { if (pktMap && s) { pktMap.setView([s.lat, s.lon], 12); const mk = pktMarks.get(s.call); if (mk) mk.openPopup(); } });
});
setPktView(pktView, false);   // filled by packetLoad()

// graph right of the lists, SPECTRUM or EYE: the server sends its data only while the PACKET page asks for it
// (renewed every 2 s)
let pktGraph = recall("packetGraph") === "eye" ? "eye" : "spec";
let pktEyeRate = recall("packetEyeRate") === "1200" ? 1200 : 9600;
let pktEyeAt = 0;   // time of the last graph data
const pktEyeShown = () => !MAP_ONLY && bodyTab === "dec" && decPage === "packet" && !!(st && st.packet);

function pktEyeAsk() {
  if (!pktEyeShown()) return;
  packetPost(pktGraph === "eye" ? { action: "eye", rate: pktEyeRate } : { action: "spectrum" })
    .catch(() => { /* receiver restarting */ });
}

function pktEyeCanvas() {
  const cv = $("packetEye"), w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!w || !h) return null;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

// persistence display: the traces are summed into a 2D histogram that fades out (EYE_DECAY per event, 4 per second),
// the colour shows how often the signal passes through each point, so the noise does not hide the eye
const EYE_DECAY = 0.8;
const EYE_SPAN = 0.78;      // full scale of the data = this part of the half height (room above and below the eye)
const EYE_PEAK_DECAY = 0.97;   // the brightness reference falls slowly (half in ~6 s): the noise after a frame stays dim
let pktEyeHist = null, pktEyeKey = "", pktEyeOff = null, pktEyePeak = 0;

function pktEyeClear(note) {
  const c = pktEyeCanvas();
  if (c) { c.g.fillStyle = "#000"; c.g.fillRect(0, 0, c.w, c.h); }
  pktEyeKey = "";
  $("packetEyeInfo").textContent = note;
}

function drawPktEye(d) {
  if (pktGraph !== "eye" || d.rate !== pktEyeRate) return;
  const c = pktEyeCanvas();
  if (!c) return;
  pktEyeAt = Date.now();
  const { g } = c, w = Math.round(c.w), h = Math.round(c.h), n = d.n, raw = atob(d.data);
  const cnt = Math.floor(raw.length / n), mid = h / 2, span = mid * EYE_SPAN;
  const key = `${w}x${h}x${d.rate}`;
  if (key !== pktEyeKey || !pktEyeHist) {
    pktEyeKey = key;
    pktEyeHist = new Float32Array(w * h);
    pktEyeOff = document.createElement("canvas");
    pktEyeOff.width = w; pktEyeOff.height = h;
    pktEyePeak = 0;
  }
  const hist = pktEyeHist;
  for (let i = 0; i < hist.length; i++) hist[i] *= EYE_DECAY;
  const v = new Float32Array(n);
  for (let t = 0; t < cnt; t++) {
    for (let k = 0; k < n; k++) v[k] = ((raw.charCodeAt(t * n + k) << 24) >> 24) / 127;
    let prev = -1;
    for (let x = 0; x < w; x++) {
      const u = (x / (w - 1)) * (n - 1), k = Math.min(n - 2, Math.floor(u)), f = u - k;
      const row = Math.max(0, Math.min(h - 1, Math.round(mid - (v[k] + (v[k + 1] - v[k]) * f) * span)));
      const lo = prev < 0 ? row : Math.min(prev, row), hi = prev < 0 ? row : Math.max(prev, row);
      const wt = 1 / (hi - lo + 1);        // a steep edge spreads over its rows, so it is not brighter than a flat part
      for (let y = lo; y <= hi; y++) hist[y * w + x] += wt;
      prev = row;
    }
  }
  let top = 0;
  for (let i = 0; i < hist.length; i++) if (hist[i] > top) top = hist[i];
  // brightness against a slowly falling peak: a clean eye concentrates the traces into bright bands, noise
  // spreads them thin, so it is dim; gamma 0.6 keeps the rarer paths of the eye visible
  pktEyePeak = Math.max(top, pktEyePeak * EYE_PEAK_DECAY);
  const img = new ImageData(w, h), px = img.data, norm = pktEyePeak > 0 ? 1 / (0.7 * pktEyePeak) : 0;
  const col = d.rate === 9600 ? [70, 230, 120] : [255, 185, 60];
  for (let i = 0; i < hist.length; i++) {
    const a = Math.min(1, Math.pow(hist[i] * norm, 0.6));
    const b = Math.max(0, (a - 0.8) / 0.2);                          // the densest paths go to white
    px[i * 4] = col[0] * a + (255 - col[0]) * b;
    px[i * 4 + 1] = col[1] * a + (255 - col[1]) * b;
    px[i * 4 + 2] = col[2] * a + (255 - col[2]) * b;
    px[i * 4 + 3] = 255;
  }
  pktEyeOff.getContext("2d").putImageData(img, 0, 0);
  g.drawImage(pktEyeOff, 0, 0, c.w, c.h);
  // centre = sampling instant, horizontal = decision threshold; the edges are the neighbouring bits' instants;
  // the faint lines are the nominal levels (1200: mark +1 / space -1, 9600: ± the measured deviation)
  const lvl = d.rate === 9600 ? (d.dev_hz || 0) / d.full : 1 / d.full;
  g.lineWidth = 1;
  g.strokeStyle = "rgba(255, 255, 255, 0.28)";
  g.setLineDash([3, 4]);
  g.beginPath();
  g.moveTo(c.w / 2, 0); g.lineTo(c.w / 2, c.h);
  g.moveTo(0, mid); g.lineTo(c.w, mid);
  g.stroke();
  g.strokeStyle = "rgba(255, 255, 255, 0.14)";
  g.setLineDash([1, 5]);
  g.beginPath();
  g.moveTo(0, mid - lvl * span); g.lineTo(c.w, mid - lvl * span);
  g.moveTo(0, mid + lvl * span); g.lineTo(c.w, mid + lvl * span);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = "rgba(170, 180, 190, 0.85)";
  g.font = "10px ui-monospace, Consolas, monospace";
  const up = d.rate === 9600 ? `+${((d.dev_hz || 0) / 1000).toFixed(2)} kHz` : "mark +1";
  const dn = d.rate === 9600 ? `−${((d.dev_hz || 0) / 1000).toFixed(2)} kHz` : "space −1";
  g.fillText(up, 4, Math.max(11, mid - lvl * span - 4));
  g.fillText(dn, 4, Math.min(c.h - 4, mid + lvl * span + 12));
  const pct = (x) => (x === null || x === undefined ? "–" : `${x} %`);
  $("packetEyeInfo").innerHTML = `eye open now <b>${pct(d.open)}</b>  ·  last frame <b>${pct(d.open_frame)}</b>\n` +
    (d.rate === 9600 ? `deviation <b>±${(d.dev_hz / 1000).toFixed(2)} kHz</b>  ·  AFC (live) <b>${d.afc_live > 0 ? "+" : ""}${d.afc_live} Hz</b>` : "");
}

// ---- spectrum: averaged power around the tuned frequency (0 = tuned), max hold, 99 % bandwidth ----
const SPEC_AVG = 0.3;       // weight of a new spectrum (4 per second): about 1 s averaging
let pktSpecAvg = null, pktSpecMax = null, pktSpecK = -1, pktSpecHold = false;
let pktSpecHi = null, pktSpecLo = null, pktSpecHiN = 0, pktSpecLoN = 0;

function pktSpecReset() {
  pktSpecAvg = pktSpecMax = null;
  pktSpecK = -1;
  pktSpecHi = pktSpecLo = null;
}

// level range in 10 dB steps: it widens at once and narrows only after 3 s, so the picture does not jump
function pktSpecRange(hiT, loT) {
  if (pktSpecHi === null || hiT > pktSpecHi) { pktSpecHi = hiT; pktSpecHiN = 0; }
  else if (hiT < pktSpecHi) { if (++pktSpecHiN > 12) { pktSpecHi = hiT; pktSpecHiN = 0; } }
  else pktSpecHiN = 0;
  if (pktSpecLo === null || loT < pktSpecLo) { pktSpecLo = loT; pktSpecLoN = 0; }
  else if (loT > pktSpecLo) { if (++pktSpecLoN > 12) { pktSpecLo = loT; pktSpecLoN = 0; } }
  else pktSpecLoN = 0;
  return [pktSpecHi, Math.max(pktSpecHi - 70, Math.min(pktSpecLo, pktSpecHi - 40))];
}

function drawPktSpec(d) {
  if (pktGraph !== "spec") return;
  const c = pktEyeCanvas();
  if (!c) return;
  pktEyeAt = Date.now();
  const { g, w, h } = c, k = d.k, n = d.db.length;
  if (k !== pktSpecK || !pktSpecAvg || pktSpecAvg.length !== n) {
    pktSpecReset();
    pktSpecK = k;
    pktSpecAvg = Float64Array.from(d.db, (v) => 10 ** (v / 10));
  } else {
    for (let i = 0; i < n; i++) pktSpecAvg[i] += SPEC_AVG * (10 ** (d.db[i] / 10) - pktSpecAvg[i]);
  }
  const avg = Array.from(pktSpecAvg, (v) => 10 * Math.log10(v + 1e-12));
  if (pktSpecHold) pktSpecMax = pktSpecMax ? pktSpecMax.map((v, i) => Math.max(v, d.db[i])) : d.db.slice();
  const sorted = avg.slice().sort((a, b) => a - b), floor = sorted[Math.floor(n * 0.2)], peak = sorted[n - 1];
  const top = pktSpecHold && pktSpecMax ? Math.max(peak, ...pktSpecMax) : peak;
  const hiT = Math.ceil((top + 5) / 10) * 10;
  const [hi, lo] = pktSpecRange(hiT, Math.min(hiT - 40, Math.floor((floor - 6) / 10) * 10));
  const L = 30, B = 14, pw = w - L - 2, ph = h - B - 4;
  const X = (i) => L + (i / (n - 1)) * pw, Y = (db) => 4 + ((hi - Math.max(lo, Math.min(hi, db))) / (hi - lo)) * ph;
  const fx = (hz) => L + ((hz / d.df + k) / (n - 1)) * pw;
  const span = k * d.df;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  g.font = "10px ui-monospace, Consolas, monospace";
  g.lineWidth = 1;
  // grid: 10 dB, 2 kHz (labels every 4 kHz); the tuned frequency brighter, the 9600 Bd AFC dashed green
  g.strokeStyle = "rgba(255, 255, 255, 0.10)";
  g.fillStyle = "rgba(170, 180, 190, 0.8)";
  g.beginPath();
  for (let db = hi; db >= lo; db -= 10) {
    const y = Math.round(Y(db)) + 0.5;
    g.moveTo(L, y); g.lineTo(L + pw, y);
    if (y < 4 + ph - 6) g.fillText(String(db), 2, y + 3);
  }
  for (let f = -Math.floor(span / 2000) * 2000; f <= span; f += 2000) {
    const x = Math.round(fx(f)) + 0.5;
    g.moveTo(x, 4); g.lineTo(x, 4 + ph);
    if (f % 4000 === 0 && x > L + 8 && x < L + pw - 8) {
      const t = f === 0 ? "0" : `${f > 0 ? "+" : ""}${f / 1000}`;
      g.fillText(t, x - g.measureText(t).width / 2, h - 3);
    }
  }
  g.stroke();
  g.strokeStyle = "rgba(255, 255, 255, 0.35)";
  g.beginPath(); g.moveTo(Math.round(fx(0)) + 0.5, 4); g.lineTo(Math.round(fx(0)) + 0.5, 4 + ph); g.stroke();
  const afc = d.afc_live !== null && d.afc_live !== undefined ? d.afc_live : null;
  if (afc !== null && Math.abs(afc) < span) {
    const x = Math.round(fx(afc)) + 0.5;
    g.strokeStyle = "rgba(70, 230, 120, 0.7)";
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x, 4); g.lineTo(x, 4 + ph); g.stroke();
    g.setLineDash([]);
  }
  if (pktSpecHold && pktSpecMax) {
    g.strokeStyle = "rgba(110, 160, 255, 0.75)";
    g.beginPath();
    pktSpecMax.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
    g.stroke();
  }
  g.beginPath();
  avg.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
  g.strokeStyle = "rgba(255, 185, 60, 0.95)";
  g.stroke();
  g.lineTo(X(n - 1), 4 + ph); g.lineTo(X(0), 4 + ph); g.closePath();
  g.fillStyle = "rgba(255, 185, 60, 0.12)";
  g.fill();
  // occupied bandwidth: 99 % of the power above the noise floor (only with a signal at least 15 dB above it)
  let bw = null, centre = null;
  if (peak - floor >= 15) {
    const nf = 10 ** (floor / 10), p = Array.from(pktSpecAvg, (v) => Math.max(0, v - nf));
    const tot = p.reduce((a, b) => a + b, 0);
    let acc = 0, i0 = -1, i1 = -1;
    for (let i = 0; i < n; i++) {
      acc += p[i];
      if (i0 < 0 && acc >= 0.005 * tot) i0 = i;
      if (i1 < 0 && acc >= 0.995 * tot) i1 = i;
    }
    if (i0 >= 0 && i1 >= i0) { bw = (i1 - i0 + 1) * d.df; centre = ((i0 + i1) / 2 - k) * d.df; }
  }
  const sg = (v) => (v > 0 ? "+" : "") + v;
  $("packetEyeInfo").innerHTML = `span <b>±${(span / 1000).toFixed(1)} kHz</b>  ·  RBW ${Math.round(d.df)} Hz  ·  ` +
    `S/N <b>${Math.round(peak - floor)} dB</b>\n` +
    (bw ? `bandwidth (99 %) <b>${(bw / 1000).toFixed(1)} kHz</b>  ·  centre <b>${sg(Math.round(centre))} Hz</b>` : "no signal") +
    (afc !== null ? `\nAFC (live, 9600) <b>${sg(afc)} Hz</b> (green line)` : "");
}

function setPktGraph(v) {
  pktGraph = v;
  store("packetGraph", v);
  for (const b of $("packetGraphView").children) b.classList.toggle("on", b.dataset.view === v);
  $("packetEyeRate").hidden = v !== "eye";
  $("packetSpecOpts").hidden = v !== "spec";
  pktSpecReset();
  pktEyeClear("waiting for data…");
  pktEyeAsk();
}

$("packetGraphView").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setPktGraph(b.dataset.view); });
$("packetSpecMax").addEventListener("click", () => {
  pktSpecHold = !pktSpecHold;
  pktSpecMax = null;
  $("packetSpecMax").classList.toggle("on", pktSpecHold);
});

function setPktEyeRate(r) {
  pktEyeRate = r;
  store("packetEyeRate", String(r));
  for (const b of $("packetEyeRate").children) b.classList.toggle("on", Number(b.dataset.rate) === r);
  pktEyeClear("waiting for data…");
  pktEyeAsk();
}

$("packetEyeRate").addEventListener("click", (e) => { const b = e.target.closest("button[data-rate]"); if (b) setPktEyeRate(Number(b.dataset.rate)); });
for (const b of $("packetEyeRate").children) b.classList.toggle("on", Number(b.dataset.rate) === pktEyeRate);
for (const b of $("packetGraphView").children) b.classList.toggle("on", b.dataset.view === pktGraph);
$("packetEyeRate").hidden = pktGraph !== "eye";
$("packetSpecOpts").hidden = pktGraph !== "spec";
setInterval(() => {
  pktEyeAsk();
  if (pktEyeShown() && Date.now() - pktEyeAt > 3000) {
    const running = st && st.packet;
    pktEyeClear(!running ? "decoder off" : pktGraph === "spec" ? "no data"
      : `no ${pktEyeRate} Bd data (is ${pktEyeRate} Bd selected in BAUD?)`);
  }
}, 2000);

// ---------- CW ----------

/** Text output of a decoder (CW, RTTY): appends text, keeps scrolled to the end if the user was there. */
function textOut(boxId, emptyId, max) {
  const box = $(boxId), empty = $(emptyId), node = document.createTextNode("");
  box.append(node);
  return {
    add(t) {
      empty.hidden = true;
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
      // Drop old text so the page does not slow down during long listening.
      node.data = (node.data + t).slice(-max);
      if (stick) box.scrollTop = box.scrollHeight;
    },
    clear() { node.data = ""; empty.hidden = false; },
  };
}

let cwInfo = null;
const cwOut = textOut("cwText", "cwEmpty", 6000);
const cwAppend = (t) => cwOut.add(t);

function renderCwInfo(i) {
  cwInfo = i;
  // Short like on a station "WPM:25"; details in the tooltip.
  $("cwInfo").textContent = i.tone_hz == null ? "WPM:--" : `${i.present ? "●" : "○"} WPM:${i.wpm}  ${Math.round(i.snr_db)} dB`;
  $("cwInfo").title = i.tone_hz == null ? "searching for tone…"
    : `tone ${fmtKHz(i.freq_hz, 2)} kHz (${i.tone_hz > 0 ? "+" : ""}${i.tone_hz} Hz) · SNR ${i.snr_db} dB`;
  $("cwTune").disabled = i.tone_hz == null;
}

$("cwOn").addEventListener("change", () => {
  st.cw = $("cwOn").checked;
  $("cwCard").hidden = !st.cw;
  send({ cw: st.cw });
});
$("cwClear").addEventListener("click", () => {
  fetch(vbase + "/api/cw", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"clear"}' });
  cwOut.clear();
});
$("cwTune").addEventListener("click", () => {
  if (!cwInfo || cwInfo.freq_hz == null) return;
  const changes = {};
  if (st.mode !== "CW") { st.mode = "CW"; renderControls(); changes.mode = "CW"; }
  tune(cwInfo.freq_hz);
  if (changes.mode) send(changes);
});

// ---------- ISM: 433 / 868 MHz devices (rtl_433; the VFO feeds it through rtl_tcp) ----------

const ISM_MAX_ROWS = 300;
const ISM_TITLE = $("ismKey").title;   // tooltip from index.html (replaced on a device without ISM and a chained VFO)
let ismLast = {};   // the status sends only on/off and the error; the counts come from ismstate

function ismRow(tr, m) {
  const level = m.rssi == null ? "-" : `${Number(m.rssi).toFixed(1)} / ${Number(m.snr).toFixed(1)} dB`;
  tr.innerHTML = `<td>${new Date(m.time * 1000).toISOString().slice(11, 19)}</td><td>${fmtMHz(m.freq_hz, 3)}</td>` +
    `<td class="dev" title="${escHtml(m.model)}${m.protocol ? ` · rtl_433 protocol ${escHtml(m.protocol)}` : ""}">${escHtml(m.model)}</td>` +
    `<td class="id" title="${escHtml(m.dev_id)}">${escHtml(m.dev_id || "-")}</td><td>${escHtml(m.channel || "-")}</td>` +
    `<td title="${escHtml(m.mod)}">${level}</td>` +
    `<td class="data" title="${escHtml(m.mic ? `Check: ${m.mic}` : "")}">${escHtml(m.text)}` +
    `${m.n > 1 ? `<span class="rep" title="Same message received ${m.n} times in a row">×${m.n}</span>` : ""}</td>`;
}

function addIsm(m) {
  const tb = $("ismRows");
  let tr = tb.firstElementChild;
  if (!tr || Number(tr.dataset.id) !== m.id) {
    tr = document.createElement("tr");
    tr.dataset.id = m.id;
    tb.prepend(tr);
    while (tb.rows.length > ISM_MAX_ROWS) tb.lastChild.remove();
  }
  ismRow(tr, m);
  $("ismEmpty").hidden = true;
}

function ismReset() {
  ismLast = {};
  $("ismRows").innerHTML = "";
  $("ismEmpty").hidden = false;
}

async function ismLoad() {
  const v = active;
  try {
    const d = await fetch(vbase + "/api/ism").then((r) => r.json());
    if (v !== active) return;
    $("ismRows").innerHTML = "";
    for (const m of d.messages) addIsm(m);
    $("ismEmpty").hidden = d.messages.length > 0;
    renderIsmInfo(d);
  } catch { /* an older receiver without ISM */ }
}

function renderIsmInfo(d) {
  const i = (ismLast = { ...ismLast, ...d });
  const el = $("ismInfo");
  el.classList.toggle("err", !!i.error);
  if (i.error) { el.textContent = `ISM: ${i.error}`; return; }
  el.textContent = !i.enabled ? "" : i.running === false ? "starting rtl_433…"
    : `${i.count || 0} messages${i.dropped ? ` · ${i.dropped} blocks dropped` : ""}`;
}

function renderIsm(s) {
  const on = !!s.ism;
  $("ismCard").hidden = !on;
  $("ismKey").classList.toggle("on", on);
  const no = noRtlDongle(s) || !!s.chain_owner;   // needs the raw samples of its own RTL dongle
  $("ismKey").disabled = no;
  $("ismKey").title = s.chain_owner ? `ISM needs its own dongle (this VFO shares the dongle of VFO ${s.chain_owner})`
    : noRtlDongle(s) ? `ISM is not supported on ${DEVICE_NAMES[s.driver]} (RTL-SDR only)` : ISM_TITLE;
  for (const b of $("ismBands").children) b.classList.toggle("active", Number(b.dataset.f) === s.center_hz);
  renderIsmInfo({ enabled: on, error: s.ism_error });
}

function ismOn() {
  st.ism = true;
  if (st.acars || st.vdl2 || st.dab) { st.acars = st.vdl2 = st.dab = false; $("acarsOn").checked = $("vdl2On").checked = false; }
  send({ ism: true });
  renderIsm(st);
  setDecPage("ism");
  setBodyTab("dec");
  renderDecTab();
}

/** ISM off (ISM key again, another band button, or OFF in the card): the previous sample rate comes back. */
function ismOff() {
  st.ism = false;
  send({ ism: false });
  renderIsm(st);
  renderDecTab();
}

$("ismKey").addEventListener("click", () => { if (st) { if (st.ism) ismOff(); else ismOn(); } });
$("ismBands").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (b && st) send({ ism_hz: Number(b.dataset.f) });
});
$("ismClear").addEventListener("click", () => {
  fetch(vbase + "/api/ism", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"clear"}' });
  ismReset();
  renderIsmInfo({ count: 0 });
});

// ---------- HFDL: aircraft data link on HF (dumphfdl; all HFDL channels inside the received band) ----------

const HFDL_MAX_ROWS = 500;
const HFDL_TITLE = $("hfdlOn").parentElement.title;   // tooltip from index.html (replaced on a chained VFO)
let hfdlLast = {};       // the status sends only on/off and the error; the rest comes from hfdlstate
let hfdlBands = [];      // [{lo, hi, center, tune, n}] from /api/state
let hfdlStations = [];   // [{id, name, lat, lon, freqs_khz}] from the system table

const fmtKhz0 = (hz) => (hz / 1000).toFixed(0);

function hfdlKind(m) {
  if (m.kind === "ACARS") return "acars";
  if (/log ?on|log ?off/i.test(m.kind)) return "logon";
  return "";
}

function hfdlVisible(tr) {
  const show = $("hfdlShow").value, q = $("hfdlFilter").value.trim().toLowerCase();
  if (show === "acars" && tr.dataset.kind !== "acars") return false;
  if (show === "pos" && tr.dataset.pos !== "1") return false;
  if (show === "logon" && tr.dataset.kind !== "logon") return false;
  return !q || tr.dataset.search.includes(q);
}

function addHfdl(m) {
  const tb = $("hfdlRows");
  const tr = document.createElement("tr");
  const up = m.dir === "up";
  const pos = m.lat != null
    ? `<a href="https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lon}#map=5/${m.lat}/${m.lon}" target="_blank" rel="noopener">${m.lat.toFixed(2)}, ${m.lon.toFixed(2)}</a>` : "";
  const sig = m.sig == null ? "-" : `${m.sig.toFixed(0)} dB`;
  const text = m.text || "";
  tr.dataset.id = m.id;
  tr.dataset.kind = hfdlKind(m);
  tr.dataset.pos = m.lat != null ? "1" : "";
  tr._msg = m;
  if (!m.crc_ok) tr.classList.add("bad");
  tr.innerHTML = `<td>${new Date(m.time * 1000).toISOString().slice(11, 19)}</td><td>${fmtKhz0(m.freq_hz)}</td>` +
    `<td title="${m.noise != null ? `noise ${m.noise.toFixed(0)} dB` : ""}">${sig}${m.bitrate ? `<span class="sub">${m.bitrate} bit/s</span>` : ""}</td>` +
    `<td class="${up ? "up" : "down"}">${up ? "↑" : "↓"}</td>` +
    `<td class="gs" title="${escHtml(m.gs_id != null ? `${up ? "sent by" : "addressed to"} ground station ID ${m.gs_id} (HFDL frame header; name from the system table)` : "")}">${escHtml(m.gs || "-")}</td>` +
    `<td class="cty"></td><td class="flt"></td><td class="reg"></td><td class="icao"></td>` +
    `<td class="sqk"></td><td class="act"></td><td class="model"></td><td class="fl"></td><td class="spd"></td>` +
    `<td>${m.kind === "ACARS" ? '<span class="type-tag t-acars">ACARS</span>' : escHtml(m.kind)}</td>` +
    `<td title="${escHtml(m.desc || "")}">${escHtml(m.label || "")}</td><td>${pos}</td>` +
    `<td class="data">${m.desc ? `<span class="desc">${escHtml(m.desc)}</span>` : ""}<div class="msg-text">${escHtml(text)}</div>${m.crc_ok ? "" : ' <span class="bad">✗ CRC</span>'}</td>`;
  // long message: 3 lines and "▾ more", a click expands it (like ACARS / VDL2)
  if (text.split("\n").length > 3 || text.length > 240) tr.querySelector("td.data").classList.add("long");
  renderHfdlAircraft(tr, m.ac);
  hfdlKeepView(() => {
    tb.prepend(tr);
    // while paused the rows under the marked one stay: twice the limit, the rest is trimmed on resume
    const max = hfdlPausedRow ? HFDL_MAX_ROWS * 2 : HFDL_MAX_ROWS;
    while (tb.rows.length > max) (tb.lastChild === hfdlPausedRow ? hfdlPausedRow.previousSibling : tb.lastChild).remove();
  });
  $("hfdlEmpty").hidden = true;
  hfdlAcUpdate(m, m.time);
}

// scroll pause (like ACARS / VDL2): a click on a message marks it and holds the list still, the mouse wheel resumes
let hfdlPausedRow = null;

function hfdlPause(tr) {
  hfdlPausedRow?.classList.remove("picked");
  hfdlPausedRow = tr;
  tr.classList.add("picked");
  $("hfdlMsgBox").classList.add("paused");
  $("hfdlPaused").hidden = false;
}

function hfdlResume() {
  if (!hfdlPausedRow) return;
  hfdlPausedRow.classList.remove("picked");
  hfdlPausedRow = null;
  const box = $("hfdlMsgBox");
  box.classList.remove("paused");
  $("hfdlPaused").hidden = true;
  box.scrollTop = 0;
  const tb = $("hfdlRows");
  while (tb.rows.length > HFDL_MAX_ROWS) tb.lastChild.remove();
}

/** Run a change of the table; while paused, the marked row stays at the same place on the screen. */
function hfdlKeepView(change) {
  const tr = hfdlPausedRow;
  if (!tr) { change(); return; }
  const y = tr.offsetTop;
  change();
  if (hfdlPausedRow === tr) $("hfdlMsgBox").scrollTop += tr.offsetTop - y;
}

$("hfdlMsgBox").addEventListener("wheel", (e) => {
  if (!hfdlPausedRow) return;
  e.preventDefault();     // this notch only resumes; the next ones scroll
  hfdlResume();
}, { passive: false });
$("hfdlRows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr && !e.target.closest("a")) hfdlPause(tr);     // links (flight, registration, position) only open the map
  const td = e.target.closest("td.data.long");
  if (td && !String(getSelection())) td.classList.toggle("open");
});

/** Flight, registration and ICAO of an HFDL row; from ADS-B (adsb.fi / adsb.lol, like the ACARS card) country, squawk,
 *  type, model, flight level and speed. A click on the flight, registration or ICAO opens the map in a new tab:
 *  registration / ICAO -> globe.adsb.fi, flight -> adsb.lol. */
function renderHfdlAircraft(tr, ac) {
  const m = tr._msg;
  const found = !!(ac && ac.found);
  const hex = (m.icao || (found ? ac.hex : "") || "").toLowerCase();
  const reg = m.reg || (found ? ac.reg : "") || "";
  const flight = m.flight || (found ? ac.callsign : "") || "";
  const esc = escHtml;
  const seen = found ? "" : ac ? " (not seen on ADS-B now)" : m.lookup ? " (looking up on ADS-B…)" : "";
  const link = (url, text, title) => `<a href="${url}" target="_blank" rel="noopener" title="${esc(title + seen)}">${esc(text)}</a>`;
  const globe = hex ? `https://globe.adsb.fi/?icao=${encodeURIComponent(hex)}` : "";
  tr.classList.toggle("sqk-alert", found && SQUAWK_ALERT.has(ac.squawk));
  let regH = reg ? (globe ? link(globe, reg, "Show on the map (adsb.fi)") : esc(reg)) : "";
  let fltH = flight ? (hex ? link(`https://adsb.lol/?icao=${encodeURIComponent(hex)}`, flight, "Show on the map (adsb.lol)") : esc(flight)) : "";
  if (found && ac.callsign && m.flight && ac.callsign !== m.flight) fltH += `<div class="ac-sub">${esc(ac.callsign)}</div>`;
  if (found && !m.reg && ac.reg) regH = `<span class="ext">${regH}</span>`;
  if (ac && !found && (reg || hex)) regH += `<div class="ac-sub none">not seen on ADS-B now</div>`;
  const icaoT = m.ac_id != null ? `HFDL aircraft ID ${m.ac_id}` : "";
  const icaoH = hex ? link(globe, hex.toUpperCase(), `Show on the map (adsb.fi)${icaoT ? ` · ${icaoT}` : ""}`) : "";
  const src = found ? `from ADS-B (${ac.src || "adsb.fi"}) at the time of the message` : "";
  const cell = (text, title) => (text ? `<span class="ext" title="${esc(title)}">${esc(text)}</span>` : "");
  const q = (sel, html) => { tr.querySelector(sel).innerHTML = html; };
  q("td.flt", fltH);
  q("td.reg", regH);
  q("td.icao", icaoH);
  q("td.sqk", found ? cell(ac.squawk, `transponder squawk code · ${src}`) : "");
  q("td.act", found ? cell(ac.type, src) : "");
  q("td.model", found ? cell(ac.desc, src) : "");
  q("td.fl", found ? cell(ac.ground ? "GND" : ac.alt_ft != null ? `FL${String(Math.round(ac.alt_ft / 100)).padStart(3, "0")}` : "",
    `${ac.ground ? "on ground" : ac.alt_ft != null ? ac.alt_ft + " ft" : ""} · ${src}`) : "");
  q("td.spd", found ? cell(ac.gs_kt != null && !ac.ground ? `${Math.round(ac.gs_kt)} kt` : "", `ground speed · ${src}`) : "");
  const cty = hex ? icaoCountry(hex) : null;
  q("td.cty", !cty ? ""
    : cty.cc ? `<span class="cflag" title="${esc(cty.name)}"><img src="${flagUrl(cty.cc)}" alt="${cty.cc.toUpperCase()}"` +
      ` onerror="this.replaceWith(this.alt)"><span>${cty.cc.toUpperCase()}</span></span>`
    : `<span class="muted" title="${esc(cty.name)}">—</span>`);
  tr.dataset.search = [m.gs, flight, reg, hex, m.kind, m.label, m.desc, m.text,
    found ? [ac.type, ac.desc, ac.squawk, cty && cty.name].join(" ") : ""].join(" ").toLowerCase();
  tr.hidden = !hfdlVisible(tr);
}

/** ADS-B data of an HFDL message arrived (hfdl.py looks it up after the message). */
function onHfdlInfo(d) {
  const tr = $("hfdlRows").querySelector(`tr[data-id="${d.id}"]`);
  if (!tr) return;
  tr._msg.ac = d.ac;
  tr._msg.lookup = false;
  hfdlKeepView(() => renderHfdlAircraft(tr, d.ac));
  hfdlAcUpdate(tr._msg, Date.now() / 1000);   // the ADS-B position is from now
}

// ----- HFDL aircraft: the newest data of each aircraft (HFDL messages + ADS-B), the AIRCRAFT list and the MAP -----

const hfdlAc = new Map();       // key -> aircraft {hex, reg, flight, ac, first, last, n, gs, pts: [{lat, lon, t, src}]}
const hfdlAcAlias = new Map();  // "hex:…" / "reg:…" / "flt:…" -> aircraft (the same aircraft arrives with different identifiers)
let hfdlView = recall("hfdlView") || "msgs";
let hfdlMap = null, hfdlMapLayers = null, hfdlMapFitted = false, hfdlSel = null, hfdlViewTimer = null;
const HFDL_OLD_S = 3600;        // older positions: grey aircraft on the map

function hfdlAcUpdate(m, now) {
  const found = !!(m.ac && m.ac.found);
  const hex = (m.icao || (found ? m.ac.hex : "") || "").toUpperCase();
  const reg = m.reg || (found ? m.ac.reg : "") || "";
  const flight = m.flight || (found ? m.ac.callsign : "") || "";
  const ids = [hex && `hex:${hex}`, reg && `reg:${reg}`, flight && `flt:${flight}`].filter(Boolean);
  if (!ids.length) return;
  let a = ids.map((k) => hfdlAcAlias.get(k)).find(Boolean);
  if (!a) {
    a = { key: ids[0], hex: "", reg: "", flight: "", ac: null, first: m.time, last: 0, n: 0, gs: "", ids: new Set(), pts: [] };
    hfdlAc.set(a.key, a);
  }
  for (const k of ids) hfdlAcAlias.set(k, a);
  if (!a.ids.has(m.id)) { a.ids.add(m.id); a.n++; }
  a.hex = hex || a.hex;
  a.reg = reg || a.reg;
  a.flight = flight || a.flight;
  if (m.time >= a.last) { a.last = m.time; a.gs = m.gs || a.gs; }
  if (found) a.ac = m.ac;
  const add = (lat, lon, t, src) => {
    if (lat == null || lon == null || a.pts.some((p) => p.lat === lat && p.lon === lon)) return;
    a.pts.push({ lat, lon, t, src });
    a.pts.sort((p, q) => p.t - q.t);
    if (a.pts.length > 200) a.pts.shift();
  };
  add(m.lat, m.lon, m.time, "HFDL");
  if (found) add(m.ac.lat, m.ac.lon, now, m.ac.src || "ADS-B");
  hfdlViewLater();
}

/** Positions that make the track: those sent over HFDL; only when the aircraft has none, those from ADS-B. */
function hfdlTrack(a) {
  const hf = a.pts.filter((p) => p.src === "HFDL");
  return hf.length ? hf : a.pts;
}
/** Position of the aircraft: the newest one sent over HFDL, the ADS-B one only as a fallback. */
function hfdlPos(a) {
  const t = hfdlTrack(a);
  return t[t.length - 1];
}

/** Heading: from the last two positions of the track; the ADS-B track when there are not two (or the position is from ADS-B). */
function hfdlHeading(a) {
  const t = hfdlTrack(a), p = t[t.length - 1], q = t[t.length - 2];
  if (p && (p.src !== "HFDL" || !q) && a.ac && a.ac.found && a.ac.track != null) return a.ac.track;
  if (!p || !q) return null;
  const r = Math.PI / 180, dl = (p.lon - q.lon) * r;
  const y = Math.sin(dl) * Math.cos(p.lat * r);
  const x = Math.cos(q.lat * r) * Math.sin(p.lat * r) - Math.sin(q.lat * r) * Math.cos(p.lat * r) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}

const hfdlUtc = (t) => new Date(t * 1000).toISOString().slice(11, 19);
const hfdlAge = (t) => { const s = Date.now() / 1000 - t; return s < 90 ? `${Math.max(0, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; };
const hfdlFl = (ac) => (!ac || !ac.found ? "" : ac.ground ? "GND" : ac.alt_ft != null ? `FL${String(Math.round(ac.alt_ft / 100)).padStart(3, "0")}` : "");
const hfdlSpd = (ac) => (ac && ac.found && ac.gs_kt != null && !ac.ground ? `${Math.round(ac.gs_kt)} kt` : "");

function hfdlAcList() {
  const q = $("hfdlFilter").value.trim().toLowerCase();
  return [...hfdlAc.values()].sort((a, b) => b.last - a.last).filter((a) => !q ||
    [a.flight, a.reg, a.hex, a.gs, a.ac && a.ac.type, a.ac && a.ac.desc].join(" ").toLowerCase().includes(q));
}

function hfdlViewLater() {
  if (hfdlView === "msgs" || hfdlViewTimer) return;
  hfdlViewTimer = setTimeout(() => { hfdlViewTimer = null; renderHfdlView(); }, 400);
}

function renderHfdlView() {
  if (hfdlView === "aircraft") renderHfdlAcTable();
  else if (hfdlView === "map") renderHfdlMap();
}

function renderHfdlAcTable() {
  const list = hfdlAcList();
  $("hfdlAcRows").innerHTML = list.map((a) => {
    const ac = a.ac, p = hfdlPos(a), esc = escHtml;
    const cty = a.hex ? icaoCountry(a.hex) : null;
    const ext = (t) => (t ? `<span class="ext">${esc(t)}</span>` : "");
    return `<tr data-key="${esc(a.key)}"><td>${hfdlUtc(a.last)}</td>` +
      `<td>${cty && cty.cc ? `<span class="cflag" title="${esc(cty.name)}"><img src="${flagUrl(cty.cc)}" alt="${cty.cc.toUpperCase()}" onerror="this.replaceWith(this.alt)"><span>${cty.cc.toUpperCase()}</span></span>` : ""}</td>` +
      `<td class="flt">${esc(a.flight)}</td><td class="reg">${esc(a.reg)}</td><td class="icao">${esc(a.hex)}</td>` +
      `<td>${ext(ac && ac.type)}</td><td class="model">${ext(ac && ac.desc)}</td><td>${ext(hfdlFl(ac))}</td><td>${ext(hfdlSpd(ac))}</td><td>${ext(ac && ac.squawk)}</td>` +
      `<td>${p ? `<a href="#" class="hfdl-goto" title="Show on the MAP">${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</a>` : ""}</td>` +
      `<td>${p ? `${esc(p.src)} · ${hfdlAge(p.t)}` : ""}</td><td>${esc(a.gs || "")}</td><td class="num">${a.n}</td></tr>`;
  }).join("");
  $("hfdlAcEmpty").hidden = list.length > 0;
}

function hfdlPlaneIcon(a, sel) {
  const hdg = hfdlHeading(a), old = Date.now() / 1000 - a.last > HFDL_OLD_S;
  const cls = `hfdl-plane${sel ? " sel" : ""}${old ? " old" : ""}`;
  // always an aircraft; heading not known yet (one position, no ADS-B track): pointing north
  const svg = `<svg viewBox="0 0 24 24" style="transform: rotate(${Math.round(hdg ?? 0)}deg)"><path d="M12 2c.6 0 1 .9 1 2v5.2l8 4.6v2l-8-2.5v4.9l2.2 1.6V21L12 20.2 8.8 21v-1.2L11 18.2v-4.9l-8 2.5v-2l8-4.6V4c0-1.1.4-2 1-2z"/></svg>`;
  return L.divIcon({ className: cls, html: svg, iconSize: [22, 22], iconAnchor: [11, 11] });
}

function hfdlPopup(a) {
  const ac = a.ac, p = hfdlPos(a), esc = escHtml, hex = a.hex.toLowerCase();
  const links = hex ? `<a href="https://globe.adsb.fi/?icao=${hex}" target="_blank" rel="noopener">adsb.fi</a> · <a href="https://adsb.lol/?icao=${hex}" target="_blank" rel="noopener">adsb.lol</a>` : "";
  return `<b>${esc(a.flight || a.reg || a.hex)}</b> ${esc([a.reg, a.hex].filter((x) => x && x !== a.flight).join(" · "))}` +
    (ac && ac.found ? `<br>${esc([ac.type, ac.desc].filter(Boolean).join(" · "))}<br>${esc([hfdlFl(ac), hfdlSpd(ac), ac.squawk && `squawk ${ac.squawk}`].filter(Boolean).join(" · "))}` : "") +
    (p ? `<br>position ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)} (${esc(p.src)}, ${hfdlAge(p.t)} ago)` : "") +
    `<br>last message ${hfdlUtc(a.last)} UTC via ${esc(a.gs || "?")} · ${a.n} msgs` + (links ? `<br>${links}` : "");
}

async function hfdlMapOpen() {
  try {
    await Promise.all([satAsset("/static/leaflet/leaflet.css"), satAsset("/static/leaflet/leaflet.js")]);
  } catch (e) {
    $("hfdlMapNote").textContent = e.message;
    return false;
  }
  if (!hfdlMap) {
    hfdlMap = L.map($("hfdlMap"), { worldCopyJump: true, minZoom: 2 }).setView([45, 0], 3);
    // the same OpenStreetMap tiles as the PACKET map, darkened by CSS (.hfdl-dark) so the white aircraft stand out
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 12, className: "hfdl-dark",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).addTo(hfdlMap);
    mapPopout(hfdlMap, "hfdl");
    hfdlMapLayers = { gs: L.layerGroup().addTo(hfdlMap), tracks: L.layerGroup().addTo(hfdlMap), planes: L.layerGroup().addTo(hfdlMap), marks: new Map() };
    try {
      const s = await satFetch("/api/location");
      if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon))
        L.circleMarker([s.lat, s.lon], { radius: 6, color: "#000", weight: 2, fillColor: "#ff5a3c", fillOpacity: 1 }).bindTooltip("QTH").addTo(hfdlMap);
    } catch { /* server unreachable */ }
  }
  return true;
}

async function renderHfdlMap() {
  if (!(await hfdlMapOpen())) return;
  hfdlMap.invalidateSize();
  const lay = hfdlMapLayers;
  // ground stations: green = heard, grey = not heard
  const heard = new Set((hfdlLast.heard || []).map((h) => h.id));
  lay.gs.clearLayers();
  for (const s of hfdlStations) {
    if (s.lat == null || s.lon == null) continue;
    const h = heard.has(s.id);
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: `hfdl-gs-mark${h ? " heard" : ""}`, html: "▲", iconSize: [14, 14], iconAnchor: [7, 7] }), zIndexOffset: -1000 })
      .bindTooltip(`${escHtml(s.name)}${h ? " · heard" : ""}<br>${s.freqs_khz.map(Math.round).join(" ")} kHz`, { direction: "top" }).addTo(lay.gs);
  }
  // aircraft with a position: icon turned to the heading, label = flight + type, white track of the known positions
  lay.tracks.clearLayers();
  const list = hfdlAcList().filter((a) => a.pts.length);
  const keep = new Set();
  for (const a of list) {
    const p = hfdlPos(a), track = hfdlTrack(a);
    keep.add(a.key);
    if (track.length > 1) L.polyline(track.map((q) => [q.lat, q.lon]), { color: a.key === hfdlSel ? "#ff4b3c" : "#fff", weight: a.key === hfdlSel ? 2.5 : 1.5, opacity: 0.7 }).addTo(lay.tracks);
    let mk = lay.marks.get(a.key);
    const label = `${escHtml(a.flight || a.reg || a.hex)}${a.ac && a.ac.found && a.ac.type ? `<br>${escHtml(a.ac.type)}` : ""}`;
    if (!mk) {
      mk = L.marker([p.lat, p.lon]).bindPopup("").bindTooltip("", { permanent: true, direction: "bottom", offset: [0, 8], className: "hfdl-label" }).addTo(lay.planes);
      mk.on("click", () => hfdlSelect(a.key, false));
      lay.marks.set(a.key, mk);
    }
    mk.setLatLng([p.lat, p.lon]);
    mk.setIcon(hfdlPlaneIcon(a, a.key === hfdlSel));
    mk.setTooltipContent(label);
    mk.setPopupContent(hfdlPopup(a));
  }
  for (const [k, mk] of lay.marks) if (!keep.has(k)) { mk.remove(); lay.marks.delete(k); }
  if (!hfdlMapFitted && lay.marks.size) {
    hfdlMapFitted = true;
    hfdlMap.fitBounds(L.featureGroup([...lay.marks.values()]).getBounds().pad(0.3), { maxZoom: 5 });
  }
  // list next to the map
  $("hfdlMapList").innerHTML = `<div class="hfdl-ml-head">Tracking ${list.length} aircraft${hfdlAc.size > list.length ? ` (${hfdlAc.size - list.length} without a position)` : ""}</div>` +
    list.map((a) => {
      const cty = a.hex ? icaoCountry(a.hex) : null, ac = a.ac && a.ac.found ? a.ac : null;
      return `<div class="hfdl-ml${a.key === hfdlSel ? " sel" : ""}${Date.now() / 1000 - a.last > HFDL_OLD_S ? " old" : ""}" data-key="${escHtml(a.key)}">` +
        `${cty && cty.cc ? `<img src="${flagUrl(cty.cc)}" alt="" title="${escHtml(cty.name)}">` : "<span class=\"noflag\"></span>"}` +
        `<b>${escHtml(a.flight || "-")}</b><span>${escHtml(a.reg)}</span><span class="icao">${escHtml(a.hex)}</span>` +
        `<span class="ext">${escHtml(ac ? ac.type : "")}</span><span class="ext">${escHtml(hfdlFl(ac))}</span><span class="age">${hfdlAge(a.last)}</span></div>`;
    }).join("");
  $("hfdlMapNote").textContent = `${list.length} aircraft with a position · ▲ HFDL ground stations (green = heard) · white trail = positions sent over HFDL · red = selected · grey = no message for an hour · map © OpenStreetMap`;
}

/** Selects an aircraft (map list, AIRCRAFT position link, click on its icon): yellow, popup, centred. */
function hfdlSelect(key, pan = true) {
  hfdlSel = key;
  renderHfdlMap().then(() => {
    const mk = hfdlMapLayers && hfdlMapLayers.marks.get(key);
    if (!mk) return;
    if (pan) hfdlMap.setView(mk.getLatLng(), Math.max(hfdlMap.getZoom(), 4));
    mk.openPopup();
  });
}

function setHfdlView(v) {
  hfdlView = v;
  store("hfdlView", v);
  for (const b of $("hfdlViews").children) b.classList.toggle("on", b.dataset.view === v);
  $("hfdlMsgBox").hidden = v !== "msgs";
  $("hfdlAcBox").hidden = v !== "aircraft";
  $("hfdlMapBox").hidden = v !== "map";
  $("hfdlShow").parentElement.hidden = v !== "msgs";
  renderHfdlView();
}

/** INFO key: the description of the decoder, hidden by default so the table or map has the room; remembered in the browser. */
function setHfdlInfo(on) {
  store("hfdlInfo", on ? "1" : "0");
  $("hfdlInfoKey").classList.toggle("on", on);
  $("hfdlNote").hidden = !on;
  if (hfdlMap) setTimeout(() => hfdlMap.invalidateSize());
}
$("hfdlInfoKey").addEventListener("click", () => setHfdlInfo($("hfdlNote").hidden));
setHfdlInfo(recall("hfdlInfo") === "1");
$("hfdlViews").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setHfdlView(b.dataset.view); });
$("hfdlMapList").addEventListener("click", (e) => { const r = e.target.closest("[data-key]"); if (r) hfdlSelect(r.dataset.key); });
$("hfdlAcRows").addEventListener("click", (e) => {
  if (!e.target.closest(".hfdl-goto")) return;
  e.preventDefault();
  const key = e.target.closest("tr").dataset.key;
  setHfdlView("map");
  hfdlSelect(key);
});
setTimeout(() => setHfdlView(hfdlView));   // after the declarations below

function hfdlAcClear() {
  hfdlAc.clear();
  hfdlAcAlias.clear();
  hfdlSel = null;
  hfdlMapFitted = false;
  if (hfdlMapLayers) { hfdlMapLayers.planes.clearLayers(); hfdlMapLayers.tracks.clearLayers(); hfdlMapLayers.marks.clear(); }
  renderHfdlView();
}

function hfdlReset() {
  hfdlLast = {};
  $("hfdlRows").innerHTML = "";
  $("hfdlEmpty").hidden = false;
  $("hfdlChannels").textContent = "";
  $("hfdlHeard").innerHTML = "";
  hfdlResume();
  hfdlAcClear();
}

async function hfdlLoad() {
  const v = active;
  try {
    const d = await fetch(vbase + "/api/hfdl").then((r) => r.json());
    if (v !== active) return;
    $("hfdlRows").innerHTML = "";
    for (const m of d.messages) addHfdl(m);
    $("hfdlEmpty").hidden = d.messages.length > 0;
    renderHfdlInfo(d);
  } catch { /* an older receiver without HFDL */ }
}

/** Band buttons and the table of ground stations and their channels (from the system table of dumphfdl). */
function renderHfdlBands(bands, stations) {
  hfdlBands = bands;
  hfdlStations = stations;
  $("hfdlBands").innerHTML = bands.map((b, i) => {
    const range = b.lo === b.hi ? `${fmtKhz0(b.lo)} kHz` : `${fmtKhz0(b.lo)}–${fmtKhz0(b.hi)} kHz`;
    return `<button data-i="${i}" title="HFDL ${range}, ${b.n} channel${b.n === 1 ? "" : "s"}: centre the VFO on ${fmtMHz(b.center, 3)} MHz">${(b.lo / 1e6).toFixed(b.lo < 10e6 ? 1 : 0)}M</button>`;
  }).join("");
  renderHfdlStations();
}

function renderHfdlStations() {
  const ch = new Set((hfdlLast.enabled && hfdlLast.channels || []).map((f) => Math.round(f / 1000)));
  const heard = new Map((hfdlLast.heard || []).map((h) => [h.id, new Set(h.freqs.map(Math.round))]));
  const rows = hfdlStations.map((s) => {
    const fs = s.freqs_khz.map((f) => {
      const k = Math.round(f), cls = heard.get(s.id)?.has(k) ? "heard" : ch.has(k) ? "lis" : "";
      const tip = cls === "heard" ? "received from this station" : cls === "lis" ? "inside the received band: listened to, nothing received from this station yet" : "";
      return `<span class="${cls}"${tip ? ` title="${tip}"` : ""}>${k}</span>`;
    }).join(" ");
    const h = heard.has(s.id);
    return `<tr${h ? ' class="heard-row"' : ""}><td>${s.id}</td><td>${escHtml(s.name)}${h ? ' <span class="heard">✓</span>' : ""}</td><td class="fq">${fs}</td></tr>`;
  }).join("");
  $("hfdlStations").innerHTML = hfdlStations.length
    ? `<table class="hfdl-st"><thead><tr><th>ID</th><th>Ground station</th><th>Channels (kHz): <span class="lis">listening (in the band, not heard yet)</span> · <span class="heard">✓ heard</span></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<span class="muted">The system table (lib\\hfdl\\systable.conf) is missing.</span>';
}

function renderHfdlInfo(d) {
  const i = (hfdlLast = { ...hfdlLast, ...d });
  const el = $("hfdlInfo");
  el.classList.toggle("err", !!i.error);
  if (i.error) el.textContent = `HFDL: ${i.error}`;
  else el.textContent = !i.enabled ? "" : !i.running ? "waiting for the VFO…"
    : `${i.count || 0} messages · ${i.squitters || 0} squitters${i.dropped ? ` · ${i.dropped} blocks dropped` : ""}`;
  const chs = i.enabled && i.channels ? i.channels : [];
  $("hfdlChannels").textContent = chs.length
    ? `Listening on ${chs.length} channel${chs.length === 1 ? "" : "s"} inside the received band (kHz): ${chs.map(fmtKhz0).join(" ")}` : "";
  $("hfdlHeard").innerHTML = i.enabled && i.running && !(i.heard || []).length ? '<span class="muted">Heard: no ground station yet</span>'
    : (i.heard || []).length
    ? "Heard: " + i.heard.map((h) => `<span class="hfdl-gs" title="${escHtml(h.name)} (ID ${h.id}), last ${new Date(h.last * 1000).toISOString().slice(11, 19)} UTC${h.sig != null ? `, ${h.sig.toFixed(0)} dB` : ""}">` +
      `${escHtml(h.name.split(",")[0])} <small>${h.freqs.map(Math.round).join(", ")}</small></span>`).join("") : "";
  renderHfdlStations();
  if (hfdlView === "map" && d.heard) hfdlViewLater();
}

function renderHfdl(s) {
  const on = !!s.hfdl;
  $("hfdlOn").checked = on;
  $("hfdlCard").hidden = !on;
  const no = !!s.chain_owner;
  $("hfdlOn").disabled = no;
  $("hfdlOn").parentElement.classList.toggle("disabled", no);
  $("hfdlOn").parentElement.title = no ? `HFDL needs its own dongle (this VFO shares the dongle of VFO ${s.chain_owner})` : HFDL_TITLE;
  for (const b of $("hfdlBands").children) {
    const band = hfdlBands[Number(b.dataset.i)];
    b.classList.toggle("active", on && !!band && s.center_hz === band.center);
  }
  renderHfdlInfo({ enabled: on, error: s.hfdl_error });
}

$("hfdlOn").addEventListener("change", () => {
  st.hfdl = $("hfdlOn").checked;
  $("hfdlCard").hidden = !st.hfdl;
  send({ hfdl: st.hfdl });
  renderHfdlInfo({ enabled: st.hfdl });
});
$("hfdlBands").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-i]");
  if (!b || !st) return;
  const band = hfdlBands[Number(b.dataset.i)];
  if (!band) return;
  await ensureVfoFor(band.center);   // HF: e.g. to a VFO with an upconverter or a V4
  if (!st) return;
  if (st.acars || st.vdl2 || st.dab || st.ism) { st.acars = st.vdl2 = st.dab = st.ism = false; $("acarsOn").checked = $("vdl2On").checked = false; }
  st.hfdl = true;
  $("hfdlOn").checked = true;
  send({ hfdl_band: Number(b.dataset.i) });
  setDecPage("hfdl");
  renderDecTab();
});
$("hfdlShow").addEventListener("change", hfdlRefilter);
function hfdlRefilter() {
  for (const tr of $("hfdlRows").rows) tr.hidden = !hfdlVisible(tr);
  if (hfdlPausedRow?.hidden) hfdlResume();     // the marked message was filtered out
}
$("hfdlFilter").addEventListener("input", () => { hfdlRefilter(); renderHfdlView(); });
$("hfdlClear").addEventListener("click", () => {
  fetch(vbase + "/api/hfdl", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"clear"}' });
  hfdlResume();
  $("hfdlRows").innerHTML = "";
  $("hfdlEmpty").hidden = false;
  hfdlAcClear();
  renderHfdlInfo({ count: 0, squitters: 0, heard: [] });
});

// ---------- AIS: ships on 161.975 / 162.025 MHz (ais.py: both channels from the raw samples of the VFO) ----------

const AIS_MAX_ROWS = 500;
const AIS_TITLE = $("aisOn").parentElement.title;   // tooltip from index.html (replaced on a chained VFO)
let aisLast = {};        // the status sends only on/off and the error; the rest comes from aisstate
let aisCenter = 162000000;
let aisChannelList = [];

const AIS_STATIC = new Set([5, 19, 21, 24]);
const aisUtc = (t) => new Date(t * 1000).toISOString().slice(11, 19);
const aisAge = (t) => { const s = Date.now() / 1000 - t; return s < 90 ? `${Math.max(0, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; };
const aisMt = (mmsi) => `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${mmsi}`;
const aisVf = (mmsi) => `https://www.vesselfinder.com/?mmsi=${mmsi}`;
const aisDeg = (v) => (v == null ? "" : `${Math.round(v)}°`);
const aisKt = (v) => (v == null ? "" : `${v.toFixed(1)} kt`);

/** Kind of a message for SHOW: pos / static / base / other. */
function aisKind(m) {
  if (m.type === 4 || m.type === 11) return "base";
  if (AIS_STATIC.has(m.type) && m.lat == null) return "static";
  if (m.lat != null) return "pos";
  return "other";
}

/** Short tag of the message type: coloured for base stations, aids to navigation, SAR aircraft and static data. */
function aisTypeTag(m) {
  const t = m.type, name = escHtml(m.type_name || `Message ${t}`);
  const tip = `title="${name} (type ${t}, ${m.bits} bits)&#10;${escHtml(m.nmea || "")}"`;
  if (t === 4 || t === 11) return `<span class="type-tag t-base" ${tip}>BASE</span> ${t === 4 ? "report" : "UTC response"}`;
  if (t === 21) return `<span class="type-tag t-aton" ${tip}>AtoN</span> report`;
  if (t === 9) return `<span class="type-tag t-sar" ${tip}>SAR</span> aircraft position`;
  if (t === 5 || t === 24) return `<span class="type-tag t-static" ${tip}>STATIC</span> ${t === 5 ? "class A" : `class B${m.part ? ` part ${m.part}` : ""}`}`;
  if (t === 19) return `<span class="type-tag t-static" ${tip}>STATIC</span> + position (class B)`;
  if (t <= 3) return `<span ${tip}>Position class A${t === 2 ? " (assigned)" : t === 3 ? " (response)" : ""}</span>`;
  if (t === 18) return `<span ${tip}>Position class B</span>`;
  if (t === 27) return `<span ${tip}>Long-range position</span>`;
  return `<span ${tip}>${name}</span>`;
}

function aisFlag(m) {
  if (!m.cc) return m.country ? `<span class="muted" title="${escHtml(m.country)}">—</span>` : "";
  return `<span class="cflag" title="${escHtml(m.country)}"><img src="${flagUrl(m.cc)}" alt="${m.cc.toUpperCase()}" onerror="this.replaceWith(this.alt)"><span>${m.cc.toUpperCase()}</span></span>`;
}

function aisVisible(tr) {
  const show = $("aisShow").value, q = $("aisFilter").value.trim().toLowerCase();
  if (show !== "all" && tr.dataset.kind !== show) return false;
  return !q || tr.dataset.search.includes(q);
}

function addAis(m) {
  const tb = $("aisRows");
  const tr = document.createElement("tr");
  const ship = m.ship || {};
  const name = m.name || ship.name || "", call = m.callsign || ship.callsign || "", stype = m.shiptype || ship.shiptype || "";
  const dest = m.dest || ship.dest || "";
  const pos = m.lat != null
    ? `<a href="https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lon}#map=10/${m.lat}/${m.lon}" target="_blank" rel="noopener">${m.lat.toFixed(4)}, ${m.lon.toFixed(4)}</a>` : "";
  const ext = (own, v, what) => (v ? (own ? escHtml(v) : `<span class="ext" title="${what} from an earlier message of this station">${escHtml(v)}</span>`) : "");
  tr.dataset.id = m.id;
  tr.dataset.kind = aisKind(m);
  tr.dataset.search = [m.mmsi, name, call, stype, m.type_name, m.status, dest, m.country, m.station, m.text].join(" ").toLowerCase();
  tr._msg = m;
  tr.innerHTML = `<td>${aisUtc(m.time)}</td><td class="ch-${(m.channel || "a").toLowerCase()}" title="${fmtMHz(m.freq_hz, 3)} MHz">${escHtml(m.channel || "")}</td>` +
    `<td>${m.level == null ? "-" : `${m.level.toFixed(0)} dB`}</td><td class="cty">${aisFlag(m)}</td>` +
    `<td class="mmsi" title="${escHtml(m.station)}${m.country ? `, ${escHtml(m.country)}` : ""} · MarineTraffic"><a href="${aisMt(m.mmsi)}" target="_blank" rel="noopener">${m.mmsi}</a></td>` +
    `<td class="name">${name ? `<a href="${aisVf(m.mmsi)}" target="_blank" rel="noopener" title="VesselFinder">${ext(!!m.name, name, "name")}</a>` : `<span class="muted">${escHtml(m.station !== "ship" ? m.station : "")}</span>`}</td>` +
    `<td>${ext(!!m.callsign, call, "call sign")}</td><td>${ext(!!m.shiptype, stype, "type")}</td>` +
    `<td>${aisTypeTag(m)}</td><td>${escHtml(m.status || "")}</td><td>${pos}</td>` +
    `<td class="num">${aisKt(m.sog)}</td><td class="num">${aisDeg(m.cog)}</td><td class="num">${m.hdg == null ? "" : `${m.hdg}°`}</td>` +
    `<td class="dest">${ext(!!m.dest, dest, "destination")}</td><td class="data">${escHtml(m.text || "")}</td>`;
  tr.hidden = !aisVisible(tr);
  aisKeepView(() => {
    tb.prepend(tr);
    const max = aisPausedRow ? AIS_MAX_ROWS * 2 : AIS_MAX_ROWS;
    while (tb.rows.length > max) (tb.lastChild === aisPausedRow ? aisPausedRow.previousSibling : tb.lastChild).remove();
  });
  $("aisEmpty").hidden = true;
  aisShipUpdate(m);
}

// scroll pause (like HFDL / ACARS): a click on a message marks it and holds the list still, the mouse wheel resumes
let aisPausedRow = null;

function aisPause(tr) {
  aisPausedRow?.classList.remove("picked");
  aisPausedRow = tr;
  tr.classList.add("picked");
  $("aisMsgBox").classList.add("paused");
  $("aisPaused").hidden = false;
}

function aisResume() {
  if (!aisPausedRow) return;
  aisPausedRow.classList.remove("picked");
  aisPausedRow = null;
  const box = $("aisMsgBox");
  box.classList.remove("paused");
  $("aisPaused").hidden = true;
  box.scrollTop = 0;
  const tb = $("aisRows");
  while (tb.rows.length > AIS_MAX_ROWS) tb.lastChild.remove();
}

function aisKeepView(change) {
  const tr = aisPausedRow;
  if (!tr) { change(); return; }
  const y = tr.offsetTop;
  change();
  if (aisPausedRow === tr) $("aisMsgBox").scrollTop += tr.offsetTop - y;
}

$("aisMsgBox").addEventListener("wheel", (e) => {
  if (!aisPausedRow) return;
  e.preventDefault();
  aisResume();
}, { passive: false });
$("aisRows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr && !e.target.closest("a")) aisPause(tr);
});

// ----- AIS ships: the newest data of each station (from the server), their tracks, the SHIPS list and the MAP -----

const aisShips = new Map();     // mmsi -> {…ship from the server, pts: [{lat, lon, t}]}
let aisView = recall("aisView") || "msgs";
let aisMap = null, aisMapLayers = null, aisMapFitted = false, aisSel = null, aisViewTimer = null;
const AIS_OLD_S = 1800;         // no message for 30 min: grey on the map

function aisShipUpdate(m) {
  if (!m.ship) return;
  let s = aisShips.get(m.mmsi);
  if (!s) {
    s = { pts: [] };
    aisShips.set(m.mmsi, s);
  }
  Object.assign(s, m.ship);
  if (m.lat != null && !s.pts.some((p) => p.lat === m.lat && p.lon === m.lon)) {
    s.pts.push({ lat: m.lat, lon: m.lon, t: m.time });
    if (s.pts.length > 300) s.pts.shift();
  }
  aisViewLater();
}

function aisShipList() {
  const q = $("aisFilter").value.trim().toLowerCase();
  return [...aisShips.values()].sort((a, b) => b.last - a.last).filter((s) => !q ||
    [s.mmsi, s.name, s.callsign, s.shiptype, s.dest, s.country, s.station, s.status].join(" ").toLowerCase().includes(q));
}

function aisViewLater() {
  if (aisView === "msgs" || aisViewTimer) return;
  aisViewTimer = setTimeout(() => { aisViewTimer = null; renderAisView(); }, 400);
}

function renderAisView() {
  if (aisView === "ships") renderAisShipTable();
  else if (aisView === "map") renderAisMap();
}

const aisLabel = (s) => s.name || (s.station !== "ship" ? s.station : "") || String(s.mmsi);
const aisStopped = (s) => (s.sog != null && s.sog < 0.3) || /moored|at anchor|aground/.test(s.status || "");

function renderAisShipTable() {
  const list = aisShipList();
  $("aisShipRows").innerHTML = list.map((s) => {
    const esc = escHtml;
    return `<tr data-mmsi="${s.mmsi}"><td>${aisUtc(s.last)}</td><td class="cty">${aisFlag(s)}</td>` +
      `<td class="mmsi" title="${esc(s.station)}"><a href="${aisMt(s.mmsi)}" target="_blank" rel="noopener">${s.mmsi}</a></td>` +
      `<td class="name">${s.name ? `<a href="${aisVf(s.mmsi)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : `<span class="muted">${esc(s.station !== "ship" ? s.station : "")}</span>`}</td>` +
      `<td>${esc(s.callsign || "")}</td><td>${esc(s.shiptype || "")}</td><td>${esc(s.status || "")}</td>` +
      `<td>${s.lat != null ? `<a href="#" class="ais-goto" title="Show on the MAP">${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</a> <span class="muted">${aisAge(s.pos_time)}</span>` : ""}</td>` +
      `<td class="num">${aisKt(s.sog)}</td><td class="num">${aisDeg(s.cog)}</td><td class="num">${s.hdg == null ? "" : `${s.hdg}°`}</td>` +
      `<td class="dest">${esc(s.dest || "")}</td><td>${esc(s.eta || "")}</td>` +
      `<td>${esc([s.size, s.draught ? `draught ${s.draught} m` : ""].filter(Boolean).join(", "))}</td><td class="num">${s.n}</td></tr>`;
  }).join("");
  $("aisShipEmpty").hidden = list.length > 0;
}

/** Map icon: a ship turned to its heading (COG when the heading is unknown), a circle for a stopped ship,
 *  ▲ base station, ◆ aid to navigation, an aircraft for SAR. */
function aisIcon(s, sel) {
  const old = Date.now() / 1000 - s.last > AIS_OLD_S;
  let kind = "", svg;
  if (s.station === "base station") {
    kind = "base";
    svg = '<svg viewBox="0 0 24 24"><path d="M12 3l9 18H3z"/></svg>';
  } else if (s.station === "aid to navigation") {
    kind = "aton";
    svg = '<svg viewBox="0 0 24 24"><path d="M12 2l10 10-10 10L2 12z"/></svg>';
  } else if (s.station === "SAR aircraft") {
    kind = "sar";
    const hdg = s.cog ?? 0;
    svg = `<svg viewBox="0 0 24 24" style="transform: rotate(${Math.round(hdg)}deg)"><path d="M12 2c.6 0 1 .9 1 2v5.2l8 4.6v2l-8-2.5v4.9l2.2 1.6V21L12 20.2 8.8 21v-1.2L11 18.2v-4.9l-8 2.5v-2l8-4.6V4c0-1.1.4-2 1-2z"/></svg>`;
  } else if (aisStopped(s)) {
    kind = "stop";
    svg = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>';
  } else {
    const hdg = s.hdg ?? s.cog ?? 0;
    svg = `<svg viewBox="0 0 24 24" style="transform: rotate(${Math.round(hdg)}deg)"><path d="M12 2l7 18-7-4-7 4z"/></svg>`;
  }
  return L.divIcon({ className: `ais-ship ${kind}${sel ? " sel" : ""}${old ? " old" : ""}`, html: svg, iconSize: [20, 20], iconAnchor: [10, 10] });
}

function aisPopup(s) {
  const esc = escHtml;
  const lines = [`<b>${esc(aisLabel(s))}</b> ${esc([s.callsign, s.mmsi !== undefined ? `MMSI ${s.mmsi}` : ""].filter(Boolean).join(" · "))}`];
  const what = [s.country, s.station !== "ship" ? s.station : s.shiptype].filter(Boolean).join(" · ");
  if (what) lines.push(esc(what));
  const nav = [s.status, aisKt(s.sog), s.cog != null ? `COG ${aisDeg(s.cog)}` : "", s.hdg != null ? `HDG ${s.hdg}°` : ""].filter(Boolean).join(" · ");
  if (nav) lines.push(esc(nav));
  if (s.dest || s.eta) lines.push(esc(`to ${s.dest || "?"}${s.eta ? `, ETA ${s.eta}` : ""}`));
  if (s.size || s.draught || s.imo) lines.push(esc([s.imo ? `IMO ${s.imo}` : "", s.size, s.draught ? `draught ${s.draught} m` : ""].filter(Boolean).join(" · ")));
  if (s.lat != null) lines.push(`position ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)} (${aisAge(s.pos_time)} ago)`);
  lines.push(`last message ${aisUtc(s.last)} UTC · ${s.n} msgs · <a href="${aisMt(s.mmsi)}" target="_blank" rel="noopener">MarineTraffic</a> · <a href="${aisVf(s.mmsi)}" target="_blank" rel="noopener">VesselFinder</a>`);
  return lines.join("<br>");
}

async function aisMapOpen() {
  try {
    await Promise.all([satAsset("/static/leaflet/leaflet.css"), satAsset("/static/leaflet/leaflet.js")]);
  } catch (e) {
    $("aisMapNote").textContent = e.message;
    return false;
  }
  if (!aisMap) {
    aisMap = L.map($("aisMap"), { worldCopyJump: true, minZoom: 2 }).setView([50, 10], 5);
    // the same OpenStreetMap tiles as the HFDL map, darkened by CSS (.hfdl-dark) so the ships stand out
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 16, className: "hfdl-dark",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).addTo(aisMap);
    mapPopout(aisMap, "ais");
    aisMapLayers = { tracks: L.layerGroup().addTo(aisMap), ships: L.layerGroup().addTo(aisMap), marks: new Map() };
    try {
      const s = await satFetch("/api/location");
      if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
        L.circleMarker([s.lat, s.lon], { radius: 6, color: "#000", weight: 2, fillColor: "#ff5a3c", fillOpacity: 1 }).bindTooltip("QTH").addTo(aisMap);
        aisMap.setView([s.lat, s.lon], 8);
      }
    } catch { /* server unreachable */ }
  }
  return true;
}

async function renderAisMap() {
  if (!(await aisMapOpen())) return;
  aisMap.invalidateSize();
  const lay = aisMapLayers;
  lay.tracks.clearLayers();
  const list = aisShipList().filter((s) => s.lat != null);
  const keep = new Set();
  for (const s of list) {
    keep.add(s.mmsi);
    const sel = s.mmsi === aisSel;
    if (s.pts.length > 1) L.polyline(s.pts.map((q) => [q.lat, q.lon]), { color: sel ? "#ff4b3c" : "#fff", weight: sel ? 2.5 : 1.5, opacity: 0.7 }).addTo(lay.tracks);
    let mk = lay.marks.get(s.mmsi);
    const label = `${escHtml(aisLabel(s))}${s.sog != null && s.sog >= 0.3 ? `<br>${aisKt(s.sog)}` : ""}`;
    if (!mk) {
      mk = L.marker([s.lat, s.lon]).bindPopup("").bindTooltip("", { permanent: true, direction: "bottom", offset: [0, 8], className: "ais-label" }).addTo(lay.ships);
      mk.on("click", () => aisSelect(s.mmsi, false));
      lay.marks.set(s.mmsi, mk);
    }
    mk.setLatLng([s.lat, s.lon]);
    mk.setIcon(aisIcon(s, sel));
    mk.setTooltipContent(label);
    mk.setPopupContent(aisPopup(s));
  }
  for (const [k, mk] of lay.marks) if (!keep.has(k)) { mk.remove(); lay.marks.delete(k); }
  if (!aisMapFitted && lay.marks.size) {
    aisMapFitted = true;
    aisMap.fitBounds(L.featureGroup([...lay.marks.values()]).getBounds().pad(0.3), { maxZoom: 11 });
  }
  $("aisMapList").innerHTML = `<div class="ais-ml-head">${list.length} station${list.length === 1 ? "" : "s"} with a position${aisShips.size > list.length ? ` (${aisShips.size - list.length} without)` : ""}</div>` +
    list.map((s) =>
      `<div class="ais-ml${s.mmsi === aisSel ? " sel" : ""}${Date.now() / 1000 - s.last > AIS_OLD_S ? " old" : ""}" data-mmsi="${s.mmsi}">` +
      `${s.cc ? `<img src="${flagUrl(s.cc)}" alt="" title="${escHtml(s.country)}">` : "<span></span>"}` +
      `<b>${escHtml(aisLabel(s))}</b><span class="mmsi">${s.mmsi}</span><span class="stype">${escHtml(s.station !== "ship" ? s.station : s.shiptype || "")}</span>` +
      `<span>${aisKt(s.sog)}</span><span class="age">${aisAge(s.last)}</span></div>`).join("");
  $("aisMapNote").textContent = `${list.length} with a position · yellow = ship (circle = stopped) · ▲ base station · ◆ aid to navigation · red = selected · grey = no message for 30 min · white trail = reported positions · map © OpenStreetMap`;
}

function aisSelect(mmsi, pan = true) {
  aisSel = mmsi;
  renderAisMap().then(() => {
    const mk = aisMapLayers && aisMapLayers.marks.get(mmsi);
    if (!mk) return;
    if (pan) aisMap.setView(mk.getLatLng(), Math.max(aisMap.getZoom(), 9));
    mk.openPopup();
  });
}

function setAisView(v) {
  aisView = v;
  store("aisView", v);
  for (const b of $("aisViews").children) b.classList.toggle("on", b.dataset.view === v);
  $("aisMsgBox").hidden = v !== "msgs";
  $("aisShipBox").hidden = v !== "ships";
  $("aisMapBox").hidden = v !== "map";
  $("aisShow").parentElement.hidden = v !== "msgs";
  renderAisView();
}

function setAisInfo(on) {
  store("aisInfo", on ? "1" : "0");
  $("aisInfoKey").classList.toggle("on", on);
  $("aisNote").hidden = !on;
  if (aisMap) setTimeout(() => aisMap.invalidateSize());
}
$("aisInfoKey").addEventListener("click", () => setAisInfo($("aisNote").hidden));
setAisInfo(recall("aisInfo") === "1");
$("aisViews").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setAisView(b.dataset.view); });
$("aisMapList").addEventListener("click", (e) => { const r = e.target.closest("[data-mmsi]"); if (r) aisSelect(Number(r.dataset.mmsi)); });
$("aisShipRows").addEventListener("click", (e) => {
  if (!e.target.closest(".ais-goto")) return;
  e.preventDefault();
  const mmsi = Number(e.target.closest("tr").dataset.mmsi);
  setAisView("map");
  aisSelect(mmsi);
});
setTimeout(() => setAisView(aisView));   // after the declarations below

function aisShipsClear() {
  aisShips.clear();
  aisSel = null;
  aisMapFitted = false;
  if (aisMapLayers) { aisMapLayers.ships.clearLayers(); aisMapLayers.tracks.clearLayers(); aisMapLayers.marks.clear(); }
  renderAisView();
}

function aisReset() {
  aisLast = {};
  $("aisRows").innerHTML = "";
  $("aisEmpty").hidden = false;
  $("aisChannels").textContent = "";
  aisResume();
  aisShipsClear();
}

async function aisLoad() {
  const v = active;
  try {
    const d = await fetch(vbase + "/api/ais").then((r) => r.json());
    if (v !== active) return;
    $("aisRows").innerHTML = "";
    aisShips.clear();
    for (const s of d.ships || []) aisShips.set(s.mmsi, { ...s, pts: s.lat != null ? [{ lat: s.lat, lon: s.lon, t: s.pos_time }] : [] });
    for (const m of d.messages) {
      m.ship = null;              // the ship data came with the list above; only the track point is added
      addAis(m);
      const s = aisShips.get(m.mmsi);
      if (s && m.lat != null && !s.pts.some((p) => p.lat === m.lat && p.lon === m.lon)) s.pts.push({ lat: m.lat, lon: m.lon, t: m.time });
    }
    for (const s of aisShips.values()) s.pts.sort((p, q) => p.t - q.t);
    $("aisEmpty").hidden = d.messages.length > 0;
    renderAisInfo(d);
    renderAisView();
  } catch { /* an older receiver without AIS */ }
}

/** The 162.000 button: both channels at once. */
function renderAisBands(center, channels) {
  aisCenter = center || 162000000;
  aisChannelList = channels || [];
  $("aisBands").innerHTML = `<button data-f="${aisCenter}" title="Centre the VFO on ${fmtMHz(aisCenter, 3)} MHz (FM), between the AIS channels ${aisChannelList.map((f) => fmtMHz(f, 3)).join(" and ")} MHz: both are decoded">${fmtMHz(aisCenter, 3)}</button>`;
}

function renderAisInfo(d) {
  const i = (aisLast = { ...aisLast, ...d });
  const el = $("aisInfo");
  el.classList.toggle("err", !!i.error);
  if (i.error) el.textContent = `AIS: ${i.error}`;
  else el.textContent = !i.enabled ? "" : !i.running ? "waiting for the VFO…"
    : `${i.count || 0} messages · ${i.ships || 0} stations${i.bad ? ` · ${i.bad} bad CRC` : ""}${i.dropped ? ` · ${i.dropped} blocks dropped` : ""}`;
  const chs = i.enabled && i.channels ? i.channels : [];
  const lv = i.levels || {};
  $("aisChannels").textContent = chs.length
    ? `Listening on ${chs.map((f) => { const ch = f === 161975000 ? "A" : "B"; return `${ch} ${fmtMHz(f, 3)} MHz${lv[ch] != null ? ` (${lv[ch].toFixed(0)} dB)` : ""}`; }).join(" · ")}` : "";
}

function renderAis(s) {
  const on = !!s.ais;
  $("aisOn").checked = on;
  $("aisCard").hidden = !on;
  const no = !!s.chain_owner;
  $("aisOn").disabled = no;
  $("aisOn").parentElement.classList.toggle("disabled", no);
  $("aisOn").parentElement.title = no ? `AIS needs its own dongle (this VFO shares the dongle of VFO ${s.chain_owner})` : AIS_TITLE;
  for (const b of $("aisBands").children) b.classList.toggle("active", on && s.center_hz === Number(b.dataset.f));
  renderAisInfo({ enabled: on, error: s.ais_error });
}

$("aisOn").addEventListener("change", () => {
  st.ais = $("aisOn").checked;
  $("aisCard").hidden = !st.ais;
  send({ ais: st.ais });
  renderAisInfo({ enabled: st.ais });
});
$("aisBands").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-f]");
  if (!b || !st) return;
  await ensureVfoFor(Number(b.dataset.f));
  if (!st) return;
  if (st.acars || st.vdl2 || st.dab || st.ism || st.hfdl) { st.acars = st.vdl2 = st.dab = st.ism = st.hfdl = false; $("acarsOn").checked = $("vdl2On").checked = $("hfdlOn").checked = false; }
  st.ais = true;
  $("aisOn").checked = true;
  send({ ais_center: true });
  setDecPage("ais");
  renderDecTab();
});
$("aisShow").addEventListener("change", aisRefilter);
function aisRefilter() {
  for (const tr of $("aisRows").rows) tr.hidden = !aisVisible(tr);
  if (aisPausedRow?.hidden) aisResume();
}
$("aisFilter").addEventListener("input", () => { aisRefilter(); renderAisView(); });
$("aisClear").addEventListener("click", () => {
  fetch(vbase + "/api/ais", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"clear"}' });
  aisResume();
  $("aisRows").innerHTML = "";
  $("aisEmpty").hidden = false;
  aisShipsClear();
  renderAisInfo({ count: 0, ships: 0, bad: 0 });
});

// ---------- ADS-B: aircraft on 1090 MHz (adsb.py: Mode S / ADS-B from the raw samples of the VFO) ----------

const ADSB_MAX_MSGS = 300;
const ADSB_TITLE = $("adsbOn").parentElement.title;   // tooltip from index.html (replaced on a chained VFO)
const ADSB_OLD_S = 60;          // not heard for a minute: grey
const ADSB_GONE_S = 600;        // the server drops it after 10 min
let adsbLast = {};              // the status sends only on/off and the error; the rest comes from adsbstate / adsb
let adsbFreq = 1090000000;
const adsbAc = new Map();       // icao -> {…aircraft from the server, pts: [[lat, lon, t, alt]]}
let adsbView = recall("adsbView") || "ac";
let adsbMap = null, adsbMapLayers = null, adsbMapFitted = false, adsbSel = null, adsbViewTimer = null, adsbQth = null;

const adsbUtc = (t) => new Date(t * 1000).toISOString().slice(11, 19);
const adsbAge = (t) => { const s = Date.now() / 1000 - t; return s < 90 ? `${Math.max(0, Math.round(s))} s` : `${Math.round(s / 60)} min`; };
const adsbGlobe = (icao) => `https://globe.adsb.fi/?icao=${icao.toLowerCase()}`;
const adsbLol = (a) => `https://adsb.lol/?icao=${a.icao.toLowerCase()}`;
const adsbEmerg = (a) => !!a.emergency || ["7500", "7600", "7700"].includes(a.squawk);

function adsbFlag(icao) {
  const c = icaoCountry(icao);
  if (!c) return "";
  if (!c.cc) return `<span class="muted" title="${escHtml(c.name)}">—</span>`;
  return `<span class="cflag" title="${escHtml(c.name)}"><img src="${flagUrl(c.cc)}" alt="${c.cc.toUpperCase()}" onerror="this.replaceWith(this.alt)"><span>${c.cc.toUpperCase()}</span></span>`;
}

function adsbAlt(a) {
  if (a.ground) return "ground";
  const v = a.alt ?? a.alt_geo;
  if (v == null) return "";
  const arrow = a.vrate == null || Math.abs(a.vrate) < 256 ? "" : a.vrate > 0 ? " ▲" : " ▼";
  return `${v.toLocaleString("en-US")}${a.alt == null ? " G" : ""}${arrow}`;
}
const adsbSpd = (a) => (a.gs != null ? `${Math.round(a.gs)}` : a.tas != null ? `TAS ${a.tas}` : a.ias != null ? `IAS ${a.ias}` : "");
const adsbTrk = (a) => (a.track != null ? `${Math.round(a.track)}°` : a.hdg != null ? `hdg ${Math.round(a.hdg)}°` : "");
const adsbLabel = (a) => a.flight || (a.net && a.net.callsign) || a.icao;
/** Position to show: decoded here, else the one adsb.fi sees (net: true). */
function adsbPos(a) {
  if (a.lat != null) return { lat: a.lat, lon: a.lon, t: a.pos_time, dist: a.dist_km, az: a.az, net: false };
  const n = a.net;
  if (n && n.lat != null) return { lat: n.lat, lon: n.lon, t: n.time - (n.seen_pos || 0), dist: n.dist_km, az: n.az, net: true, src: n.src };
  return null;
}
const adsbRegType = (a) => (a.net && a.net.found ? [a.net.reg, a.net.type].filter(Boolean).join(" · ") : "");

function adsbSearch(a) {
  const c = icaoCountry(a.icao);
  const n = a.net || {};
  return [a.icao, a.flight, a.squawk, a.category, a.emergency, c && c.name, n.reg, n.type, n.desc, n.callsign].join(" ").toLowerCase();
}

function adsbList() {
  const q = $("adsbFilter").value.trim().toLowerCase();
  return [...adsbAc.values()].sort((x, y) => (adsbEmerg(y) - adsbEmerg(x)) || (y.last - x.last)).filter((a) => !q || adsbSearch(a).includes(q));
}

/** Aircraft from the server (adsb event, /api/adsb): newest data and the track point of a new position. */
function adsbAcUpdate(d) {
  let a = adsbAc.get(d.icao);
  if (!a) {
    a = { pts: [] };
    adsbAc.set(d.icao, a);
  }
  const trail = d.trail;
  delete d.trail;
  Object.assign(a, d);
  if (trail) a.pts = trail;
  else if (d.lat != null) {
    const p = a.pts[a.pts.length - 1];
    if (!p || p[0] !== d.lat || p[1] !== d.lon) {
      a.pts.push([d.lat, d.lon, d.pos_time, d.alt]);
      if (a.pts.length > 200) a.pts.shift();
    }
  }
}

function onAdsb(d) {
  for (const a of d.ac || []) adsbAcUpdate(a);
  for (const k of d.gone || []) adsbAc.delete(k);
  if (d.msgs && d.msgs.length) addAdsbMsgs(d.msgs);
  if (d.info) renderAdsbInfo(d.info);
  if ((d.ac && d.ac.length) || (d.gone && d.gone.length)) adsbViewLater();
}

// ----- MESSAGES: the newest decoded messages (a click holds the list still, like AIS) -----

let adsbPausedRow = null;

function adsbMsgVisible(tr) {
  const q = $("adsbFilter").value.trim().toLowerCase();
  return !q || tr.dataset.search.includes(q);
}

function addAdsbMsgs(msgs) {
  const tb = $("adsbMsgRows");
  const frag = document.createDocumentFragment();
  for (const m of msgs) {
    const tr = document.createElement("tr");
    const a = adsbAc.get(m.icao);
    tr.dataset.search = [m.icao, m.kind, m.text, m.hex, a && a.flight].join(" ").toLowerCase();
    tr.innerHTML = `<td>${adsbUtc(m.time)}</td><td class="num">${m.level == null ? "" : `${m.level.toFixed(0)} dB`}</td>` +
      `<td class="icao"><a href="${adsbGlobe(m.icao)}" target="_blank" rel="noopener" title="${escHtml((a && a.flight) || "")} · globe.adsb.fi">${m.icao}</a></td>` +
      `<td class="num">${m.df}</td><td>${escHtml(m.kind)}${m.fixed ? ' <span class="muted" title="Corrected with the CRC">(fixed)</span>' : ""}</td>` +
      `<td class="data">${escHtml(m.text)}</td><td class="hex">${m.hex}</td>`;
    tr.hidden = !adsbMsgVisible(tr);
    frag.prepend(tr);
  }
  adsbKeepView(() => {
    tb.prepend(frag);
    const max = adsbPausedRow ? ADSB_MAX_MSGS * 2 : ADSB_MAX_MSGS;
    while (tb.rows.length > max) (tb.lastChild === adsbPausedRow ? adsbPausedRow.previousSibling : tb.lastChild).remove();
  });
  $("adsbMsgEmpty").hidden = tb.rows.length > 0;
}

function adsbPause(tr) {
  adsbPausedRow?.classList.remove("picked");
  adsbPausedRow = tr;
  tr.classList.add("picked");
  $("adsbMsgBox").classList.add("paused");
  $("adsbPaused").hidden = false;
}

function adsbResume() {
  if (!adsbPausedRow) return;
  adsbPausedRow.classList.remove("picked");
  adsbPausedRow = null;
  const box = $("adsbMsgBox");
  box.classList.remove("paused");
  $("adsbPaused").hidden = true;
  box.scrollTop = 0;
  const tb = $("adsbMsgRows");
  while (tb.rows.length > ADSB_MAX_MSGS) tb.lastChild.remove();
}

function adsbKeepView(change) {
  const tr = adsbPausedRow;
  if (!tr) { change(); return; }
  const y = tr.offsetTop;
  change();
  if (adsbPausedRow === tr) $("adsbMsgBox").scrollTop += tr.offsetTop - y;
}

$("adsbMsgBox").addEventListener("wheel", (e) => {
  if (!adsbPausedRow) return;
  e.preventDefault();
  adsbResume();
}, { passive: false });
$("adsbMsgRows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr && !e.target.closest("a")) adsbPause(tr);
});

// ----- AIRCRAFT table and MAP -----

function adsbViewLater() {
  if (adsbView === "msgs" || adsbViewTimer) return;
  adsbViewTimer = setTimeout(() => { adsbViewTimer = null; renderAdsbView(); }, 500);
}

function renderAdsbView() {
  if (adsbView === "ac") renderAdsbAcTable();
  else if (adsbView === "map") renderAdsbMap();
}

function renderAdsbAcTable() {
  const list = adsbList(), esc = escHtml, now = Date.now() / 1000;
  $("adsbAcRows").innerHTML = list.map((a) => {
    const p = adsbPos(a);
    const cls = [adsbEmerg(a) ? "emerg" : "", now - a.last > ADSB_OLD_S ? "old" : "", a.icao === adsbSel ? "sel" : ""].filter(Boolean).join(" ");
    const sq = a.squawk ? `<span${adsbEmerg(a) ? ` class="sq-emerg" title="${esc(a.emergency || "emergency")}"` : ""}>${a.squawk}</span>` : (a.emergency ? `<span class="sq-emerg">${esc(a.emergency)}</span>` : "");
    return `<tr data-icao="${a.icao}" class="${cls}"><td class="cty">${adsbFlag(a.icao)}</td>` +
      `<td class="icao"><a href="${adsbGlobe(a.icao)}" target="_blank" rel="noopener" title="globe.adsb.fi${a.tisb ? " · TIS-B / ADS-R (relayed by the ground)" : ""}">${a.icao}</a>${a.tisb ? '<span class="muted"> T</span>' : ""}</td>` +
      `<td class="flt">${a.flight ? `<a href="${adsbLol(a)}" target="_blank" rel="noopener" title="adsb.lol">${esc(a.flight)}</a>` : (a.net && a.net.callsign ? `<span class="ext" title="Call sign from ${esc(a.net.src)}">${esc(a.net.callsign)}</span>` : "")}</td>` +
      `<td class="ext" title="${esc((a.net && a.net.desc) || "")}">${esc(adsbRegType(a))}</td>` +
      `<td>${sq}</td><td class="num">${adsbAlt(a)}</td><td class="num">${a.vrate == null ? "" : (a.vrate > 0 ? "+" : "") + a.vrate}</td>` +
      `<td class="num">${adsbSpd(a)}</td><td class="num">${adsbTrk(a)}</td>` +
      `<td>${p ? `<a href="#" class="adsb-goto${p.net ? " ext" : ""}" title="${p.net ? `From ${esc(p.src)}: not received here. ` : ""}Show on the MAP">${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}</a> <span class="muted">${adsbAge(p.t)}</span>` : ""}</td>` +
      `<td class="num${p && p.net ? " ext" : ""}">${!p || p.dist == null ? "" : `${Math.round(p.dist)} km`}</td><td class="num${p && p.net ? " ext" : ""}">${!p || p.az == null ? "" : `${p.az}°`}</td>` +
      `<td title="${esc(a.cat || "")}">${esc(a.category || "")}</td><td class="num">${a.level == null ? "" : `${a.level.toFixed(0)} dB`}</td>` +
      `<td class="num">${a.n}</td><td class="num">${adsbAge(a.last)}</td></tr>`;
  }).join("");
  $("adsbAcEmpty").hidden = list.length > 0;
}

function adsbIcon(a, sel, net) {
  const old = Date.now() / 1000 - a.last > ADSB_OLD_S;
  const cls = `hfdl-plane adsb-plane${sel ? " sel" : ""}${old ? " old" : ""}${adsbEmerg(a) ? " emerg" : ""}${a.ground ? " ground" : ""}${net ? " net" : ""}`;
  const trk = net ? a.track ?? a.net.track ?? a.hdg : a.track ?? a.hdg;
  const svg = `<svg viewBox="0 0 24 24" style="transform: rotate(${Math.round(trk ?? 0)}deg)"><path d="M12 2c.6 0 1 .9 1 2v5.2l8 4.6v2l-8-2.5v4.9l2.2 1.6V21L12 20.2 8.8 21v-1.2L11 18.2v-4.9l-8 2.5v-2l8-4.6V4c0-1.1.4-2 1-2z"/></svg>`;
  return L.divIcon({ className: cls, html: svg, iconSize: [22, 22], iconAnchor: [11, 11] });
}

function adsbPopup(a) {
  const esc = escHtml, c = icaoCountry(a.icao);
  const lines = [`<b>${esc(a.flight || a.icao)}</b> ICAO ${a.icao}${c ? ` · ${esc(c.name)}` : ""}`];
  if (adsbRegType(a) || a.category) lines.push(esc([adsbRegType(a), a.net && a.net.desc, a.category].filter(Boolean).join(" · ")));
  const nav = [a.squawk ? `squawk ${a.squawk}` : "", adsbAlt(a) ? `${adsbAlt(a)} ft` : "", a.vrate != null ? `${a.vrate > 0 ? "+" : ""}${a.vrate} ft/min` : "",
    adsbSpd(a) ? `${adsbSpd(a)} kt` : "", adsbTrk(a)].filter(Boolean).join(" · ");
  if (nav) lines.push(esc(nav));
  if (a.emergency) lines.push(`<span class="sq-emerg">${esc(a.emergency.toUpperCase())}</span>`);
  if (a.sel_alt != null || a.qnh != null) lines.push(esc([a.sel_alt != null ? `selected ${a.sel_alt} ft` : "", a.qnh != null ? `QNH ${a.qnh} hPa` : ""].filter(Boolean).join(" · ")));
  const p = adsbPos(a);
  if (p) lines.push(`${p.net ? `<span class="ext">position from ${esc(p.src)}</span>` : "position"} ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} (${adsbAge(p.t)} ago)${p.dist != null ? ` · ${Math.round(p.dist)} km, ${p.az}°` : ""}`);
  if (p && p.net && a.net.alt != null && a.alt == null) lines.push(`<span class="ext">${a.net.alt.toLocaleString("en-US")} ft · ${a.net.gs != null ? Math.round(a.net.gs) : "?"} kt (${esc(a.net.src)})</span>`);
  lines.push(`last message ${adsbUtc(a.last)} UTC · ${a.n} msgs · <a href="${adsbGlobe(a.icao)}" target="_blank" rel="noopener">globe.adsb.fi</a> · <a href="${adsbLol(a)}" target="_blank" rel="noopener">adsb.lol</a>`);
  return lines.join("<br>");
}

async function adsbMapOpen() {
  try {
    await Promise.all([satAsset("/static/leaflet/leaflet.css"), satAsset("/static/leaflet/leaflet.js")]);
  } catch (e) {
    $("adsbMapNote").textContent = e.message;
    return false;
  }
  if (!adsbMap) {
    adsbMap = L.map($("adsbMap"), { worldCopyJump: true, minZoom: 2 }).setView([49, 18], 6);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 16, className: "hfdl-dark",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).addTo(adsbMap);
    mapPopout(adsbMap, "adsb");
    adsbMapLayers = { range: L.layerGroup().addTo(adsbMap), rings: L.layerGroup().addTo(adsbMap), tracks: L.layerGroup().addTo(adsbMap), planes: L.layerGroup().addTo(adsbMap), marks: new Map() };
    try {
      const s = await satFetch("/api/location");
      if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && (s.lat || s.lon)) {
        adsbQth = s;
        for (const km of [50, 100, 200, 300]) {
          L.circle([s.lat, s.lon], { radius: km * 1000, color: "#6cb8ff", weight: 1, opacity: 0.35, fill: false, interactive: false }).addTo(adsbMapLayers.rings);
        }
        L.circleMarker([s.lat, s.lon], { radius: 6, color: "#000", weight: 2, fillColor: "#ff5a3c", fillOpacity: 1 }).bindTooltip("QTH · rings 50, 100, 200, 300 km").addTo(adsbMap);
        adsbMap.setView([s.lat, s.lon], 7);
      }
    } catch { /* server unreachable */ }
  }
  return true;
}

async function renderAdsbMap() {
  if (!(await adsbMapOpen())) return;
  adsbMap.invalidateSize();
  if (adsbRangeOn) await adsbRangeLoad(false);
  renderAdsbRange();
  const lay = adsbMapLayers;
  lay.tracks.clearLayers();
  const list = adsbList().filter((a) => adsbPos(a));
  const keep = new Set();
  for (const a of list) {
    keep.add(a.icao);
    const sel = a.icao === adsbSel, p = adsbPos(a);
    if (a.pts.length > 1) L.polyline(a.pts.map((p) => [p[0], p[1]]), { color: sel ? "#ff4b3c" : "#fff", weight: sel ? 2.5 : 1.5, opacity: sel ? 0.9 : 0.5, interactive: false }).addTo(lay.tracks);
    let mk = lay.marks.get(a.icao);
    const alt = adsbAlt(a) || (p.net && a.net.alt != null ? a.net.alt.toLocaleString("en-US") : "");
    const label = `${escHtml(adsbLabel(a))}${alt ? `<br>${alt}` : ""}`;
    if (!mk) {
      mk = L.marker([p.lat, p.lon]).bindPopup("").bindTooltip("", { permanent: true, direction: "bottom", offset: [0, 8], className: "ais-label" }).addTo(lay.planes);
      mk.on("click", () => adsbSelect(a.icao, false));
      lay.marks.set(a.icao, mk);
    }
    mk.setLatLng([p.lat, p.lon]);
    mk.setIcon(adsbIcon(a, sel, p.net));
    mk.setTooltipContent(label);
    mk.setPopupContent(adsbPopup(a));
  }
  for (const [k, mk] of lay.marks) if (!keep.has(k)) { mk.remove(); lay.marks.delete(k); }
  if (!adsbMapFitted && lay.marks.size && !adsbQth) {
    adsbMapFitted = true;
    adsbMap.fitBounds(L.featureGroup([...lay.marks.values()]).getBounds().pad(0.3), { maxZoom: 10 });
  }
  const nNet = list.filter((a) => adsbPos(a).net).length;
  $("adsbMapList").innerHTML = `<div class="ais-ml-head">${list.length} aircraft with a position${nNet ? `, <span class="ext">${nNet} from adsb.fi</span>` : ""}${adsbAc.size > list.length ? ` (${adsbAc.size - list.length} without)` : ""}</div>` +
    list.map((a) => {
      const c = icaoCountry(a.icao), p = adsbPos(a);
      return `<div class="ais-ml adsb-ml${a.icao === adsbSel ? " sel" : ""}${Date.now() / 1000 - a.last > ADSB_OLD_S ? " old" : ""}${adsbEmerg(a) ? " emerg" : ""}" data-icao="${a.icao}">` +
        `${c && c.cc ? `<img src="${flagUrl(c.cc)}" alt="" title="${escHtml(c.name)}">` : "<span></span>"}` +
        `<b>${escHtml(adsbLabel(a))}</b><span class="mmsi">${a.icao}</span><span class="stype">${adsbAlt(a)}</span>` +
        `<span${p.net ? ' class="ext"' : ""}>${p.dist == null ? "" : `${Math.round(p.dist)} km`}</span><span class="age">${adsbAge(a.last)}</span></div>`;
    }).join("");
  $("adsbMapNote").textContent = `${list.length} with a position · yellow = aircraft turned to its track · blue = position from adsb.fi (not received here) · red = selected · grey = not heard for 1 min · white trail = decoded positions${adsbQth ? " · blue rings 50 / 100 / 200 / 300 km" : ""}${adsbRangeNote()} · map © OpenStreetMap`;
}

// ----- RANGE: the farthest decoded position per 2° sector and altitude band (adsb.py RangeMap, data\adsb_range.json) -----

const ADSB_RANGE_BANDS = [["max", "any altitude", "#c79bff"], ["30000", "≤ 30000 ft", "#ff9a3c"], ["20000", "≤ 20000 ft", "#ffd84a"], ["10000", "≤ 10000 ft", "#6cff9c"]];
let adsbRangeOn = recall("adsbRange") !== "0", adsbRangeData = null, adsbRangeAt = 0;

async function adsbRangeLoad(force) {
  if (!force && Date.now() - adsbRangeAt < 30000) return;
  adsbRangeAt = Date.now();
  try { adsbRangeData = await fetch(vbase + "/api/adsb_range").then((r) => r.json()); } catch { adsbRangeData = null; }
}

function renderAdsbRange() {
  if (!adsbMapLayers) return;
  const lay = adsbMapLayers.range;
  lay.clearLayers();
  const d = adsbRangeData;
  if (!adsbRangeOn || !d || !d.bands) return;
  for (const [name, label, color] of ADSB_RANGE_BANDS) {
    const bins = d.bands[name] || {};
    const pts = Object.keys(bins).map(Number).sort((x, y) => x - y).map((k) => bins[k]);
    if (pts.length < 3) continue;
    L.polygon(pts.map((v) => [v[1], v[2]]), { color, weight: 1.5, opacity: 0.85, fillColor: color, fillOpacity: 0.05, interactive: false }).addTo(lay);
    const far = pts.reduce((x, y) => (y[0] > x[0] ? y : x));
    L.circleMarker([far[1], far[2]], { radius: 3, color, weight: 1, fillColor: color, fillOpacity: 1 })
      .bindTooltip(`${label}: farthest ${Math.round(far[0])} km${far[3] != null ? ` at ${far[3].toLocaleString("en-US")} ft` : ""} (${new Date(far[4] * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC${far[5] ? ", position from adsb.fi" : ""})`, { className: "ais-label" })
      .addTo(lay);
  }
}

function adsbRangeNote() {
  const d = adsbRangeData;
  if (!adsbRangeOn || !d || !d.max_km) return "";
  const mk = d.max_km;
  const parts = ADSB_RANGE_BANDS.slice().reverse().map(([name, label]) => (mk[name] != null ? `${label} ${Math.round(mk[name])} km` : "")).filter(Boolean);
  return parts.length ? ` · RANGE (green ≤ 10000, yellow ≤ 20000, orange ≤ 30000 ft, violet any) max: ${parts.join(", ")}${d.since ? ` since ${new Date(d.since * 1000).toISOString().slice(0, 10)}` : ""}` : " · RANGE: nothing collected yet";
}

$("adsbRange").checked = adsbRangeOn;
$("adsbRange").addEventListener("change", async () => {
  adsbRangeOn = $("adsbRange").checked;
  store("adsbRange", adsbRangeOn ? "1" : "0");
  if (adsbRangeOn) await adsbRangeLoad(true);
  renderAdsbMap();
});
let adsbRangeSure = null;
$("adsbRangeClr").addEventListener("click", async () => {
  const b = $("adsbRangeClr");
  if (!adsbRangeSure) {            // the first click only arms it: the collected range would be lost
    b.classList.add("sure");
    b.textContent = "SURE?";
    adsbRangeSure = setTimeout(() => { adsbRangeSure = null; b.classList.remove("sure"); b.textContent = "CLR RANGE"; }, 3000);
    return;
  }
  clearTimeout(adsbRangeSure);
  adsbRangeSure = null;
  b.classList.remove("sure");
  b.textContent = "CLR RANGE";
  await fetch(vbase + "/api/adsb", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"clear_range"}' });
  await adsbRangeLoad(true);
  renderAdsbMap();
});

function adsbSelect(icao, pan = true) {
  adsbSel = icao;
  renderAdsbMap().then(() => {
    const mk = adsbMapLayers && adsbMapLayers.marks.get(icao);
    if (!mk) return;
    if (pan) adsbMap.setView(mk.getLatLng(), Math.max(adsbMap.getZoom(), 8));
    mk.openPopup();
  });
}

function setAdsbView(v) {
  adsbView = v;
  store("adsbView", v);
  for (const b of $("adsbViews").children) b.classList.toggle("on", b.dataset.view === v);
  $("adsbAcBox").hidden = v !== "ac";
  $("adsbMapBox").hidden = v !== "map";
  $("adsbMsgBox").hidden = v !== "msgs";
  $("adsbRangeOpt").hidden = $("adsbRangeClr").hidden = v !== "map";
  renderAdsbView();
}

function setAdsbInfo(on) {
  store("adsbInfo", on ? "1" : "0");
  $("adsbInfoKey").classList.toggle("on", on);
  $("adsbNote").hidden = !on;
  if (adsbMap) setTimeout(() => adsbMap.invalidateSize());
}
$("adsbInfoKey").addEventListener("click", () => setAdsbInfo($("adsbNote").hidden));
setAdsbInfo(recall("adsbInfo") === "1");
$("adsbViews").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setAdsbView(b.dataset.view); });
$("adsbMapList").addEventListener("click", (e) => { const r = e.target.closest("[data-icao]"); if (r) adsbSelect(r.dataset.icao); });
$("adsbAcRows").addEventListener("click", (e) => {
  if (!e.target.closest(".adsb-goto")) return;
  e.preventDefault();
  const icao = e.target.closest("tr").dataset.icao;
  setAdsbView("map");
  adsbSelect(icao);
});
setTimeout(() => setAdsbView(adsbView));
setInterval(() => { if (adsbAc.size && adsbView !== "msgs" && !$("adsbCard").hidden) renderAdsbView(); }, 5000);   // ages, grey after 1 min

function adsbReset() {
  adsbLast = {};
  adsbAc.clear();
  adsbSel = null;
  adsbMapFitted = false;
  if (adsbMapLayers) { adsbMapLayers.planes.clearLayers(); adsbMapLayers.tracks.clearLayers(); adsbMapLayers.marks.clear(); }
  $("adsbMsgRows").innerHTML = "";
  $("adsbMsgEmpty").hidden = false;
  $("adsbStatus").textContent = "";
  adsbResume();
  renderAdsbView();
}

async function adsbLoad() {
  const v = active;
  try {
    const d = await fetch(vbase + "/api/adsb").then((r) => r.json());
    if (v !== active) return;
    adsbAc.clear();
    for (const a of d.aircraft || []) adsbAcUpdate(a);
    $("adsbMsgRows").innerHTML = "";
    addAdsbMsgs(d.messages || []);
    renderAdsbInfo(d);
    renderAdsbView();
  } catch { /* an older receiver without ADS-B */ }
}

function renderAdsbBands(freq) {
  adsbFreq = freq || 1090000000;
  $("adsbBands").innerHTML = `<button data-f="${adsbFreq}" title="ADS-B on: the VFO goes to ${fmtMHz(adsbFreq, 3)} MHz at 2.4 MS/s">${fmtMHz(adsbFreq, 3)}</button>`;
}

function renderAdsbInfo(d) {
  const i = (adsbLast = { ...adsbLast, ...d });
  const el = $("adsbInfo");
  el.classList.toggle("err", !!i.error);
  if (i.error) el.textContent = `ADS-B: ${i.error}`;
  else el.textContent = !i.enabled ? "" : !i.running ? "waiting for the VFO…"
    : `${i.aircraft || 0} aircraft (${i.with_pos || 0} with a position) · ${i.count || 0} messages${i.rate ? ` · ${i.rate.toFixed(0)}/s` : ""}${i.fixed ? ` · ${i.fixed} fixed` : ""}${i.dropped ? ` · ${i.dropped} blocks dropped` : ""}`;
  $("adsbStatus").textContent = i.enabled && i.running && i.fs ? `Listening on ${fmtMHz(adsbFreq, 3)} MHz at ${(i.fs / 1e6).toFixed(1)} MS/s` : "";
}

function renderAdsb(s) {
  const on = !!s.adsb;
  $("adsbOn").checked = on;
  $("adsbCard").hidden = !on;
  const no = !!s.chain_owner;
  $("adsbOn").disabled = no;
  $("adsbOn").parentElement.classList.toggle("disabled", no);
  $("adsbOn").parentElement.title = no ? `ADS-B needs its own dongle (this VFO shares the dongle of VFO ${s.chain_owner})` : ADSB_TITLE;
  for (const b of $("adsbBands").children) b.classList.toggle("active", on && s.center_hz === Number(b.dataset.f));
  renderAdsbInfo({ enabled: on, error: s.adsb_error });
}

/** ADS-B on takes the dongle to 1090 MHz: the decoders that need it elsewhere go off (the server does the same). */
function adsbOthersOff() {
  if (!st) return;
  st.acars = st.vdl2 = st.dab = st.ism = st.hfdl = st.ais = false;
  $("acarsOn").checked = $("vdl2On").checked = $("hfdlOn").checked = $("aisOn").checked = false;
}

$("adsbOn").addEventListener("change", () => {
  st.adsb = $("adsbOn").checked;
  if (st.adsb) adsbOthersOff();
  $("adsbCard").hidden = !st.adsb;
  send({ adsb: st.adsb });
  renderAdsbInfo({ enabled: st.adsb });
});
$("adsbBands").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-f]");
  if (!b || !st) return;
  await ensureVfoFor(Number(b.dataset.f));
  if (!st) return;
  adsbOthersOff();
  st.adsb = true;
  $("adsbOn").checked = true;
  send({ adsb: true });
  setDecPage("adsb");
  renderDecTab();
});
$("adsbFilter").addEventListener("input", () => {
  for (const tr of $("adsbMsgRows").rows) tr.hidden = !adsbMsgVisible(tr);
  if (adsbPausedRow?.hidden) adsbResume();
  renderAdsbView();
});
$("adsbClear").addEventListener("click", () => {
  fetch(vbase + "/api/adsb", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"clear"}' });
  adsbReset();
  renderAdsbInfo({ count: 0, aircraft: 0, with_pos: 0, fixed: 0, dropped: 0, rate: 0 });
});

// ---------- DSD: digital voice (a mode with its own DSD tab, not a DECODE key: it replaces the audio) ----------

const DSD_MAX_ROWS = 300;
let dsdModeWas = null;   // mode of this VFO in the last state: selecting DSD opens the DSD tab, a restored state does not

function dsdPost(body) {
  return fetch(vbase + "/api/dsd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json());
}

const dsdTarget = (c) => (!c.tgt ? "-" : c.type === "private" ? `ID ${c.tgt}` : c.type === "group" ? `TG ${c.tgt}` : c.tgt);
const dsdDuration = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const dsdEnc = (c) => (c.enc ? ` <span class="type-tag t-enc" title="Encrypted: not decoded, no audio">ENC</span>` : "");

function addDsdCall(c) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${new Date(c.time * 1000).toISOString().slice(11, 19)}</td><td>${fmtMHz(c.freq_hz, 4)}</td>` +
    `<td>${escHtml(c.proto)}</td><td>${c.slot ?? "-"}</td><td>${escHtml(dsdTarget(c))}</td>` +
    `<td>${escHtml(c.src || "-")}</td><td>${dsdDuration(c.duration)}</td>` +
    `<td class="alias" title="${escHtml(c.alias)}">${escHtml(c.alias)}${dsdEnc(c)}</td>`;
  const tb = $("dsdRows");
  tb.prepend(tr);
  while (tb.rows.length > DSD_MAX_ROWS) tb.lastChild.remove();
  $("dsdEmpty").hidden = true;
}

function dsdReset() {
  dsdModeWas = null;
  $("dsdRows").innerHTML = "";
  $("dsdEmpty").hidden = false;
  $("dsdNow").textContent = "";
}

async function dsdLoad() {
  const v = active;
  try {
    const d = await fetch(vbase + "/api/dsd").then((r) => r.json());
    if (v !== active) return;
    $("dsdRows").innerHTML = "";
    for (const c of d.calls) addDsdCall(c);
    $("dsdEmpty").hidden = d.calls.length > 0;
  } catch { /* an older receiver without the DSD mode */ }
}

function renderDsd(s) {
  const on = s.mode === "DSD", wasOff = dsdModeWas === false;
  dsdModeWas = on;
  renderModeTabs();
  if (on && wasOff && !s.dab) setBodyTab("dsd");
  const i = s.dsd;
  if (!on || !i) return;
  if (document.activeElement !== $("dsdProtocol")) $("dsdProtocol").value = i.protocol;
  if (document.activeElement !== $("dsdSlot")) $("dsdSlot").value = i.slot;
  $("dsdInfo").textContent = `${i.proto ? `● ${i.proto}` : "○ no digital signal"}${i.cc != null ? ` · CC ${i.cc}` : ""} · ${i.count} calls`;
  $("dsdError").textContent = i.error || "";
  $("dsdError").hidden = !i.error;
  $("dsdNow").innerHTML = i.active.map((c) =>
    `<div>${c.slot ? `S${c.slot} ` : ""}${escHtml(c.proto)} · <b>${escHtml(dsdTarget(c))}</b> · ${escHtml(c.src || "?")}` +
    `${c.alias ? ` · <b>${escHtml(c.alias)}</b>` : ""}${dsdEnc(c)} · ${dsdDuration(c.duration)}</div>`).join("");
}

$("dsdProtocol").addEventListener("change", () => dsdPost({ protocol: $("dsdProtocol").value }));
$("dsdSlot").addEventListener("change", () => dsdPost({ slot: $("dsdSlot").value }));
$("dsdClear").addEventListener("click", () => {
  dsdPost({ action: "clear" });
  $("dsdRows").innerHTML = "";
  $("dsdEmpty").hidden = false;
});

// ---------- daily logs: LOG checkbox in each decoder card ----------

for (const box of document.querySelectorAll("input[data-log]")) {
  box.addEventListener("change", () => {
    st.logs = { ...(st.logs || {}), [box.dataset.log]: box.checked };
    send({ log: st.logs });   // the whole state, so two quick changes in one send do not overwrite each other
  });
}

function renderLogs(logs) {
  for (const box of document.querySelectorAll("input[data-log]")) box.checked = !!(logs && logs[box.dataset.log]);
}

// ---------- RTTY ----------

const rttyOut = textOut("rttyText", "rttyEmpty", 12000);

function rttyPost(body) {
  return fetch(vbase + "/api/rtty", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json());
}

function renderRttyInfo(i) {
  const o = i.opts || {};
  $("rttyShift").value = String(o.shift ?? "auto");
  $("rttyBaud").value = String(o.baud ?? "auto");
  $("rttyPol").value = o.polarity || "auto";
  if (i.shift_hz == null) {
    $("rttyInfo").textContent = "searching…";
    $("rttyInfo").title = "looking for two FSK tones in the passband";
    return;
  }
  // Short "● 45.45 Bd 170 Hz N 12 dB", tones in the tooltip.
  const pol = i.polarity === "reverse" ? "R" : "N";
  $("rttyInfo").textContent = `${i.present ? "●" : "○"} ${i.baud} Bd  ${i.shift_hz} Hz  ${pol}  ${Math.round(i.snr_db)} dB`;
  $("rttyInfo").title = `mark ${fmtKHz(i.mark_hz, 2)} kHz · space ${fmtKHz(i.space_hz, 2)} kHz · ${i.polarity}`
    + (i.std_shift ? ` · standard shift ${i.std_shift} Hz` : "");
}

$("rttyOn").addEventListener("change", () => {
  st.rtty = $("rttyOn").checked;
  $("rttyCard").hidden = !st.rtty;
  send({ rtty: st.rtty });
});
$("rttyClear").addEventListener("click", () => { rttyPost({ action: "clear" }); rttyOut.clear(); });
for (const [id, key] of [["rttyShift", "shift"], ["rttyBaud", "baud"], ["rttyPol", "polarity"]]) {
  $(id).addEventListener("change", () => rttyPost({ opts: { [key]: $(id).value } }).then(renderRttyInfo));
}

$("wefaxSave").addEventListener("click", () => {
  if (!wfx.rows) return;
  const out = document.createElement("canvas");
  out.width = wfx.width;
  out.height = wfx.rows;
  const ctx = out.getContext("2d");
  wfx.blocks.forEach((b, i) => ctx.drawImage(b.canvas, 0, i * WFX_BLOCK));
  out.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `wefax_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
});

// ---------- clock, CW row ----------

// Pages of the SETTINGS tab: GENERAL (gen:skins, gen:meter, gen:wheel, gen:location, gen:rotor, gen:recs – the whole station)
// and VFO (vfo:dongle, vfo:adv, vfo:audio, vfo:tx – the VFO chosen by the keys on its left).
// The open ones are remembered in the browser.
function showSetTab(name) {
  for (const b of document.querySelectorAll("[data-set-tab]")) {
    const on = b.dataset.setTab === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on);
  }
  for (const p of document.querySelectorAll("[data-set-panel]")) p.hidden = p.dataset.setPanel !== name;
  setSubOpened(openSetSub(name));
}
/** The open sub-page of a page ("gen" -> "gen:rotor"). */
function openSetSub(page) {
  const b = document.querySelector(`[data-set-sub^="${page}:"].on`);
  return b ? b.dataset.setSub : "";
}
/** A sub-page was opened: the ones that load something fill at once. */
function setSubOpened(name) {
  if (bodyTab !== "set") return;      // setBodyTab("set") calls it again
  if (name === "gen:rotor") setTimeout(pollRotor);
  if (name === "gen:location") setTimeout(() => locLoad());
  if (name === "gen:recs") setTimeout(() => recDirLoad());
  if (name === "vfo:dongle" || name === "vfo:adv") setTimeout(loadDongleList);   // ADVANCED: dongles and VFOs
}
/** The ROTOR page of GENERAL is on the screen. */
function rotorPageOpen() {
  return bodyTab === "set" && !document.hidden && !$("settingsCard").hidden
    && !document.querySelector('[data-set-panel="gen"]').hidden && !document.querySelector('[data-set-subpanel="gen:rotor"]').hidden;
}
/** Opens a settings page by its old short name (location, rotor, ui, dongle, adv, audio, tx) and remembers it. */
function openSetPage(name) {
  const sub = SET_PAGE_OF[name];
  if (!sub) return;
  const page = sub.split(":")[0];
  showSetSub(sub);
  store(`setSub_${page}`, sub);
  showSetTab(page);
  store("setTab", page);
}
const SET_PAGE_OF = { ui: "gen:skins", display: "gen:skins", skins: "gen:skins", meter: "gen:meter", wheel: "gen:wheel", location: "gen:location", rotor: "gen:rotor", recs: "gen:recs",
  dongle: "vfo:dongle", adv: "vfo:adv", audio: "vfo:audio", tx: "vfo:tx" };

// SETTINGS › VFO: one key per VFO window, like the VFO keys beside the S-meter; the lit one (= the active VFO)
// is joined to the card with its settings. A press switches the VFO and SETTINGS stays open.
function renderSetVfoKeys() {
  const box = $("setVfoKeys");
  const named = vfos.filter((v) => v.name);
  box.hidden = !named.length;           // a receiver without VFOs: only the card
  $("setVfoCard").classList.toggle("solo", !named.length);
  const src = [...$("vfoKeys").querySelectorAll(".vfo-sel")];
  if (box.children.length !== src.length) box.innerHTML = src.map(() => `<button class="key set-vfo-key" role="tab"></button>`).join("");
  src.forEach((s, i) => {
    const b = box.children[i];
    if (b.textContent !== s.textContent) b.textContent = s.textContent;
    b.dataset.vfo = s.dataset.vfo;
    b.disabled = s.disabled;
    const on = s.classList.contains("on");
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on);
    b.title = s.disabled ? s.title : `Settings of ${s.textContent.replace("-", " ")}`;
  });
  const v = active && active.name ? `VFO-${active.name}` : "";
  if ($("setVfoName").textContent !== v) $("setVfoName").textContent = v;
  $("setVfoName").title = active && active.note ? active.note : "";
}
$("setVfoKeys").addEventListener("click", async (e) => {
  const b = e.target.closest(".set-vfo-key");
  if (!b || b.disabled) return;
  const v = vfos.find((x) => String(x.name) === b.dataset.vfo);
  if (!v || v === active) return;
  await selectVfo(v, "set");
  setSubOpened(openSetSub("vfo"));
});
// SDR DONGLE › BASIC block diagram: a block names its cards in data-blk-for; a click flashes the first shown one.
// A block whose cards are all hidden (LimeSDR without bias-tee or RTL AGC, VFO with fixed dongle) is grey.
function blkCards(g) {
  return g.dataset.blkFor.split(" ").map((id) => $(id)).filter((el) => el && !el.hidden);
}
function syncBlkDiagram() {
  for (const g of document.querySelectorAll(".blk-diagram .blk")) g.classList.toggle("off", !blkCards(g).length);
}
for (const g of document.querySelectorAll(".blk-diagram .blk")) {
  const go = () => {
    const cards = blkCards(g);
    if (!cards.length) return;
    // SP and AGC+ (10, 11) are on the ADVANCED page: switch to it first
    const sub = cards[0].closest("[data-set-subpanel]");
    if (sub && sub.hidden) { showSetSub(sub.dataset.setSubpanel); store("setSub_vfo", sub.dataset.setSubpanel); }
    cards[0].scrollIntoView({ block: "nearest", behavior: "smooth" });
    for (const c of cards) { c.classList.remove("blk-flash"); void c.offsetWidth; c.classList.add("blk-flash"); }
  };
  g.addEventListener("click", go);
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
}
function showSetSub(name) {
  const page = name.split(":")[0];
  for (const b of document.querySelectorAll(`[data-set-sub^="${page}:"]`)) {
    const on = b.dataset.setSub === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on);
  }
  for (const p of document.querySelectorAll(`[data-set-subpanel^="${page}:"]`)) p.hidden = p.dataset.setSubpanel !== name;
  setSubOpened(name);
}
for (const b of document.querySelectorAll("[data-set-tab]")) {
  b.addEventListener("click", () => { showSetTab(b.dataset.setTab); store("setTab", b.dataset.setTab); });
}
for (const b of document.querySelectorAll("[data-set-sub]")) {
  b.addEventListener("click", () => { showSetSub(b.dataset.setSub); store(`setSub_${b.dataset.setSub.split(":")[0]}`, b.dataset.setSub); });
}
// The open pages from the last time. Up to 0.114beta1 the pages were SDR DONGLE (dongle:basic / dongle:adv), AUDIO,
// UI (ui:skins / ui:meter / ui:wheel), LOCATION, ROTOR and TX side by side: their saved names lead to the new place.
{
  const oldDongle = { "dongle:basic": "vfo:dongle", "dongle:adv": "vfo:adv" }[recall("setSub_dongle")];
  const oldTab = SET_PAGE_OF[recall("setTab")];
  const vfoSub = recall("setSub_vfo") || oldDongle || (oldTab && oldTab.startsWith("vfo:") ? oldTab : "");
  const oldUi = { "ui:skins": "gen:skins", "ui:meter": "gen:meter", "ui:wheel": "gen:wheel" }[recall("setSub_ui")];
  const savedGen = recall("setSub_gen");
  const genSub = (savedGen === "gen:ui" ? oldUi || "gen:skins" : savedGen)
    || (oldTab === "gen:skins" ? oldUi || oldTab : oldTab && oldTab.startsWith("gen:") ? oldTab : "");
  // TX is left out here: its key is hidden until the state says the dongle can transmit.
  if (vfoSub && vfoSub !== "vfo:tx" && document.querySelector(`[data-set-sub="${vfoSub}"]`)) showSetSub(vfoSub);
  if (genSub && document.querySelector(`[data-set-sub="${genSub}"]`)) showSetSub(genSub);
  const t = recall("setTab");
  showSetTab(t === "vfo" || (oldTab && oldTab.startsWith("vfo:")) ? "vfo" : "gen");
}

// ---------- SETTINGS › GENERAL › ROTOR: K3NG rotor (rotor.py) ----------
// One rotor for the whole station, not tied to the active VFO: its serial port is held by the receiver of the first
// VFO (/api/vfos: "rotor": true), so all rotor commands and the rotor tracking of the satellites go there.

/** Address of the receiver that runs the rotor ("" = the server of this page, receiver without VFOs). */
function rotorBase() {
  const v = vfos.find((x) => x.rotor) || vfos[0];
  return v ? v.base : "";
}

let rotorPortsFor = null;     // the address the port list belongs to
let rotorHoldUntil = 0;       // a message from a click stays this long, the regular update does not clear it

function rotorShowError(text, hold) {
  if (hold) rotorHoldUntil = Date.now() + 5000;
  else if (Date.now() < rotorHoldUntil) return;
  for (const id of ["rotorError", "satError"]) {
    const el = document.getElementById(id) || (id === "satError" && satPanel.querySelector("#satError"));
    if (!el) continue;
    el.textContent = text || "";
    el.hidden = !text;
  }
}

async function rotorPost(body) {
  try {
    const res = await fetch(rotorBase() + "/api/rotor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const info = await res.json();
    if (!res.ok) { rotorShowError(info.error || "Error", true); return; }
    rotorHoldUntil = 0;
    renderRotor(info);
  } catch (e) {
    rotorShowError("Receiver is not reachable", true);
  }
}

function fillRotorPorts(info) {
  const sel = $("rotorPort");
  sel.textContent = "";
  const ports = info.ports || [];
  const chosen = ports.find((p) => info.usb_serial && p.usb_serial === info.usb_serial) || ports.find((p) => p.device === info.device);
  if (!chosen) sel.add(new Option(info.device ? `${info.device} (not found)` : "Choose a port", ""));
  for (const p of ports) {
    const opt = new Option(`${p.device} – ${p.description}${p.usb_serial ? ` (${p.usb_serial})` : ""}`, p.device);
    opt.dataset.usbSerial = p.usb_serial;
    sel.add(opt);
  }
  if (chosen) sel.value = chosen.device;
}

let rotorPendingOn = false;   // ON pressed without a chosen port: the page opens, the link starts with the port picked
let rotorInfo = null;         // the last rotor state (ROTOR page)

/** MONITOR of the rotor (AZ / EL in the AD), one for all VFOs, remembered in this browser
 *  (up to 0.114beta1 per VFO: the setting of the active VFO is taken over). */
function rotorMonKey() { return "rotorMon"; }
function rotorMonOn() {
  const v = recall("rotorMon");
  return v != null ? v === "1" : recall(`rotorMon_${(active && active.name) || ""}`) === "1";
}

// Position readings of K3NG jitter by about 1 % of the range: the shown position is averaged (EMA) and moves only
// when the average leaves a dead band, so the numbers and the crosses do not flicker. A real move passes at once.
const ROT_FILT = { alpha: 0.35, az: 2.5, el: 1.5 };     // EMA weight of a new reading, dead band in degrees
let rotFilt = null;     // {base, az, el (averages), azS, elS (shown)}
const azDiff = (a, b) => ((a - b + 540) % 360) - 180;

function rotorFilter(info) {
  if (!info.connected || info.az == null || info.el == null) { rotFilt = null; return; }
  const f = rotFilt && rotFilt.base === rotorBase() ? rotFilt : null;
  if (!f) {
    rotFilt = { base: rotorBase(), az: info.az, el: info.el, azS: info.az, elS: info.el };
  } else {
    const dAz = azDiff(info.az, f.az), dEl = info.el - f.el;
    // while the rotor turns (target away from the reading) or on a big step the reading is taken at once,
    // otherwise small changes are averaged
    const t = info.target, turning = !!t && (Math.abs(azDiff(t[0], info.az)) > 5 || Math.abs(t[1] - info.el) > 5);
    f.az = turning || Math.abs(dAz) > 8 ? info.az : (f.az + ROT_FILT.alpha * dAz + 360) % 360;
    f.el = turning || Math.abs(dEl) > 6 ? info.el : f.el + ROT_FILT.alpha * dEl;
    if (Math.abs(azDiff(f.az, f.azS)) >= ROT_FILT.az) f.azS = f.az;
    if (Math.abs(f.el - f.elS) >= ROT_FILT.el) f.elS = f.el;
  }
  info.azShow = rotFilt.azS;
  info.elShow = rotFilt.elS;
}

/** The rotor is still on its way: the target is further than the dead band of the rotor (5°) from the position. */
function rotorMoving(info) {
  if (!info || !info.target || info.azShow == null) return false;
  return Math.abs(azDiff(info.target[0], info.azShow)) > 5 || Math.abs(info.target[1] - info.elShow) > 5;
}

function renderRotor(info) {
  rotorFilter(info);
  rotorInfo = info;
  if (info.on) rotorPendingOn = false;
  const on = info.on || rotorPendingOn;
  $("rotorOnKey").textContent = on ? "ON" : "OFF";
  $("rotorOnKey").classList.toggle("on", on);
  $("rotorOffNote").hidden = on;
  $("rotorPortBox").hidden = !on;
  $("rotorOnBox").hidden = !on;
  const deg = (v) => (info.connected && v != null ? `${Math.round(v)}°` : "–");
  $("rotAzNow").textContent = deg(info.azShow);
  $("rotElNowT").textContent = deg(info.elShow);
  $("rotAzReq").textContent = deg(info.target && info.target[0]);
  $("rotElReq").textContent = deg(info.target && info.target[1]);
  $("rotorTarget").textContent = !info.on ? "Choose the serial port of the rotor controller."
    : !info.connected ? "Connecting to the rotor controller…"
    : info.target ? `Moving to AZ ${Math.round(info.target[0])}° EL ${Math.round(info.target[1])}° (${info.source})` : "No target";
  rotorShowError(info.fault ? `Fault: ${info.fault}` : info.error);
  $("rotorReset").classList.toggle("warn", !!info.fault);
  $("rotorMon").classList.toggle("on", rotorMonOn());
  rotDialRender(info);
  $("rotorRaw").textContent = info.k3ng_az == null ? ""
    : `K3NG now: ${Math.round(info.k3ng_az)}°${info.k3ng_guess ? " (0–90 or 360–450 not known yet: decided at the first move)" : ""}.`;
  if (info.az_cal) {
    for (const [id, v] of [["rotorCal0", info.az_cal[0]], ["rotorCal450", info.az_cal[1]]]) {
      if (document.activeElement !== $(id)) $(id).value = v;
    }
  }
  renderSat(info);
  rctrlRotor(info);
}

// ---------- rotor control on the TRACK page: STOP and the error line ----------
const satPanel = $("satPanel");      // STOP, error: moved into the TRACK page when it is shown

function renderSat(info) {
  satInfo = info;
  satPolarRotor();
  renderSatRot();      // the TRACKING flag depends on the rotor control
}

let satInfo = null;     // the last rotor state, for the clicks

// -> why the plots do not take a click now, "" if they do
function satDialRefusal(info) {
  if (!info || !info.connected) return "Rotor is not connected";
  if (info.fault) return "Reset the fault in SETTINGS › GENERAL › ROTOR";
  if (info.tracker) return "Satellite tracking moves the rotor (SATELLITES tab, TRACK): stop it to set the position by hand";
  if (info.az == null) return "Rotor position is not known yet";
  return "";
}

// SAT key: the SATELLITES tab, on the TRACK page when the rotor is to be seen at once.
$("satKey").addEventListener("click", () => setSatOn(!amsatTabShown()));
// STOP: the motors first, then the tracking ends (the tracker would otherwise wait for the next pass)
$("satStop").addEventListener("click", async () => {
  await rotorPost({ stop: true });
  if (satRot && satRot.on) await satRotSend({ stop: true });
});

let rotorPollBusy = false;
async function pollRotor() {
  const setOpen = rotorPageOpen();
  if (!setOpen) rotorPortsFor = null;
  const trackOpen = bodyTab === "sat" && amsatPage === "track" && !document.hidden;     // the antenna on the polar plot
  const mon = rotorMonOn() && !document.hidden;                                       // AZ / EL in the AD
  const rcOpen = bodyTab === "rot" && !document.hidden;                               // the antenna on the ROTOR CONTROL map
  if (!mon && adRotInfo) { adRotInfo = null; renderAd(); }
  if ((!setOpen && !trackOpen && !mon && !rcOpen) || rotorPollBusy) return;
  const base = rotorBase();
  const needPorts = setOpen && rotorPortsFor !== base;
  rotorPollBusy = true;
  try {
    const info = await fetch(base + `/api/rotor${needPorts ? "?ports=1" : ""}`).then((r) => r.json());
    if (needPorts) { fillRotorPorts(info); rotorPortsFor = base; }
    renderRotor(info);
    if (rotorMonOn()) { adRotInfo = info; renderAd(); }
  } catch (e) {
    rotorShowError("Receiver is not reachable");
    if (bodyTab === "rot") rctrlRotor(null);
  } finally {
    rotorPollBusy = false;
  }
}

/** Turns the rotor link on with the port chosen in the list (off: closes the port). */
function rotorLink(on) {
  const opt = $("rotorPort").selectedOptions[0];
  if (on && !opt?.value) {
    rotorPendingOn = true;      // show the page, the link starts when a port is chosen
    rotorShowError("Choose the serial port of the rotor controller", true);
    if (rotorInfo) renderRotor(rotorInfo);
    return;
  }
  rotorPendingOn = false;
  rotorPost({ enabled: on, port: opt?.value || "", usb_serial: opt?.dataset.usbSerial || "" });
}

$("rotorRefresh").addEventListener("click", () => { rotorPortsFor = null; pollRotor(); });
$("rotorOnKey").addEventListener("click", () => {
  const on = !!(rotorInfo && rotorInfo.on) || rotorPendingOn;
  if (on && !(rotorInfo && rotorInfo.on)) { rotorPendingOn = false; rotorShowError(""); if (rotorInfo) renderRotor(rotorInfo); return; }
  rotorLink(!on);
});
// another port while ON: the link opens that one
$("rotorPort").addEventListener("change", () => {
  if ((rotorInfo && rotorInfo.on) || rotorPendingOn) rotorLink(true);
});
$("rotorStop").addEventListener("click", () => rotorPost({ stop: true }));
$("rotorReset").addEventListener("click", () => rotorPost({ reset: true }));
$("rotorMon").addEventListener("click", () => {
  const on = !rotorMonOn();
  store(rotorMonKey(), on ? "1" : "0");
  $("rotorMon").classList.toggle("on", on);
  if (!on) adRotInfo = null;
  else if (rotorInfo) adRotInfo = rotorInfo;
  renderAd();
});
$("rotorCalSave").addEventListener("click", () => {
  if ($("rotorCal0").value === "" || $("rotorCal450").value === "") { rotorShowError("Enter both azimuths", true); return; }
  rotorPost({ az_cal: [Number($("rotorCal0").value), Number($("rotorCal450").value)] });
});
setInterval(pollRotor, 500);

// ---------- ROTOR page: polar plot (azimuth, elevation 0–90) and the elevation column 0–180 ----------
// Like the TRACK page: red cross = the antenna now, ring = the target, a click moves the antenna.
const ROT_EL = { top: 8, h: 216 };      // the column in the SVG: y of 180°, height of 0–180°
const rotElY = (el) => ROT_EL.top + (1 - Math.min(Math.max(el, 0), 180) / 180) * ROT_EL.h;
{
  let g = "";
  for (let el = 0; el <= 180; el += 15) {
    const y = rotElY(el).toFixed(1), major = el % 30 === 0;
    g += `<line class="${major ? "rot-elgrid major" : "rot-elgrid"}" x1="${major ? 26 : 30}" x2="46" y1="${y}" y2="${y}"/>`;
    if (major) g += `<text class="rot-ellbl" x="22" y="${(+y + 3.5).toFixed(1)}">${el}</text>`;
  }
  $("rotElGrid").innerHTML = g;
}

function rotDialRender(info) {
  const ok = info.connected && info.azShow != null && info.elShow != null;
  const x = $("rotPolarX"), now = $("rotElNow"), tg = $("rotPolarTgt"), tgEl = $("rotElTgt");
  x.setAttribute("visibility", ok ? "visible" : "hidden");
  now.setAttribute("visibility", ok ? "visible" : "hidden");
  if (ok) {
    const az = info.azShow, el = info.elShow;
    const back = el > 90, [px, py] = satPolarXY(back ? (az + 180) % 360 : az, back ? 180 - el : el, 100);
    x.setAttribute("transform", `translate(${px.toFixed(1)},${py.toFixed(1)})`);
    now.setAttribute("transform", `translate(0,${rotElY(el).toFixed(1)})`);
  }
  const t = info.connected && rotorMoving(info) && info.target;     // the green ring only while the rotor is on its way
  tg.setAttribute("visibility", t ? "visible" : "hidden");
  tgEl.setAttribute("visibility", t ? "visible" : "hidden");
  if (t) {
    const [az, el] = t, back = el > 90, [px, py] = satPolarXY(back ? (az + 180) % 360 : az, back ? 180 - el : el, 100);
    tg.setAttribute("transform", `translate(${px.toFixed(1)},${py.toFixed(1)})`);
    tgEl.setAttribute("transform", `translate(0,${rotElY(el).toFixed(1)})`);
  }
  const refusal = satDialRefusal(info);
  $("rotPolar").classList.toggle("locked", !!refusal);
  $("rotEl").classList.toggle("locked", !!refusal);
}

function rotNote(text) { $("rotPolarNote").textContent = text; }
const ROT_NOTE = $("rotPolarNote").textContent;

/** Elevation column point -> elevation 0–180 in whole degrees. */
function rotElAt(e) {
  const svg = $("rotEl"), p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return Math.round(Math.min(Math.max((1 - (p.y - ROT_EL.top) / ROT_EL.h) * 180, 0), 180));
}

$("rotPolarHit").addEventListener("pointermove", (e) => {
  const at = satPolarAt(e), x = $("rotPolarAim"), refusal = satDialRefusal(rotorInfo);
  if (!at || refusal) { x.setAttribute("visibility", "hidden"); e.target.style.cursor = refusal ? "not-allowed" : ""; rotNote(refusal || ROT_NOTE); return; }
  const [px, py] = satPolarXY(at[0], at[1], 100);
  x.setAttribute("transform", `translate(${px.toFixed(1)},${py.toFixed(1)})`);
  x.setAttribute("visibility", "visible");
  e.target.style.cursor = "crosshair";
  rotNote(`Click: turn the antenna to AZ ${at[0]}° EL ${at[1]}°.`);
});
$("rotPolarHit").addEventListener("pointerleave", () => { $("rotPolarAim").setAttribute("visibility", "hidden"); rotNote(ROT_NOTE); });
$("rotPolarHit").addEventListener("click", (e) => {
  const at = satPolarAt(e), refusal = satDialRefusal(rotorInfo);
  if (!at) return;
  if (refusal) { rotorShowError(refusal, true); return; }
  rotorPost({ goto: at });
});
$("rotElHit").addEventListener("pointermove", (e) => {
  const el = rotElAt(e), aim = $("rotElAim"), refusal = satDialRefusal(rotorInfo);
  aim.setAttribute("visibility", refusal ? "hidden" : "visible");
  aim.setAttribute("y1", rotElY(el).toFixed(1)); aim.setAttribute("y2", rotElY(el).toFixed(1));
  e.target.style.cursor = refusal ? "not-allowed" : "crosshair";
  rotNote(refusal || `Click: antenna EL ${el}°${el > 90 ? " (over the top, looking back)" : ""}, the azimuth stays.`);
});
$("rotElHit").addEventListener("pointerleave", () => { $("rotElAim").setAttribute("visibility", "hidden"); rotNote(ROT_NOTE); });
$("rotElHit").addEventListener("click", (e) => {
  const el = rotElAt(e), info = rotorInfo, refusal = satDialRefusal(info);
  if (refusal) { rotorShowError(refusal, true); return; }
  const az = info.target ? info.target[0] : info.az;     // the azimuth stays
  rotorPost({ goto: [Math.round(az), el] });
});

// ---------- ROTOR CONTROL tab (RCTRL key): a map to aim the rotor at a place ----------
// A click on the map, on a channel point or on a row of the list: azimuth from the QTH (great circle), elevation 0.
// The points are the MEMORIES channels with a location (LAT / LON), shown by their groups (checkboxes beside the map).
// The dashed line is the wanted azimuth (to the target, remembered in this browser until CLEAR); the green sector
// (BEAM °) is where the antenna points now and turns with the rotor. The rotor belongs to the station: its commands
// go to the VFO that holds it (rotorBase), so the map works from every VFO.
const RC_EARTH_KM = 6371;
const RC_ANT_KM = 250;          // length of the antenna sector without a target
let rcMap = null, rcLay = null, rcQth = null, rcListShown = [];
let rcMemPick = null;           // id of the channel last aimed at: selected and scrolled to when MEMORIES opens next
let rcTarget = (() => {
  try {
    const t = JSON.parse(recall("rcTarget") || "null");
    return t && Number.isFinite(t.lat) && Number.isFinite(t.lon) ? t : null;
  } catch { return null; }
})();
let rcMsg = "", rcMsgUntil = 0, rcMsgWarn = false;
const rcBeam = () => Math.min(Math.max(Number(recall("rcBeam")) || 30, 1), 360);
const rcGrpOn = (name) => recall(`rcGrp_${name}`) !== "0";
const RC_NO_GROUP = "(no group)";
// colours of the groups on the map, in the order of the group list
const RC_COLORS = ["#ff9f1c", "#2ec4b6", "#9b5de5", "#00bbf9", "#f15bb5", "#8ac926", "#00f5d4", "#c77dff", "#4895ef", "#b5838d"];
const rcRad = (d) => (d * Math.PI) / 180, rcDeg = (r) => (r * 180) / Math.PI;
const rcKm = (km) => (km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);
const RC_NOTE = "dashed = wanted azimuth (target) · green sector = antenna now · red = QTH · map © OpenStreetMap";
// Page CONNECTION: the sources of the wanted AZ / EL, each can be disconnected from the rotor (rotor.json "links",
// the whole station; the server refuses a goto of a disconnected source and the tracker then only calculates)
const RC_LINKS = [
  { k: "sat", name: "SAT TRACKER", where: "SATELLITES › TRACK" },
  { k: "mem", name: "MEMORY RECALL", where: "MEMORIES channels with LAT / LON" },
  { k: "map", name: "RCTRL MAP", where: "RCTRL › MAP: map, points, list" },
];
const RC_LINK_NAME = Object.fromEntries(RC_LINKS.map((s) => [s.k, s.name]));
/** Connected? Unknown links (no answer from the rotor yet) count as connected: the server decides then. */
const rcLinkOn = (k) => !(rotorInfo && rotorInfo.links && rotorInfo.links[k] === false);
let rcPage = recall("rcPage") === "conn" ? "conn" : "map";

/** Great circle from a to b: [initial azimuth 0–360, distance km]. */
function rcBearing(a, b) {
  const f1 = rcRad(a.lat), f2 = rcRad(b.lat), dl = rcRad(b.lon - a.lon);
  const az = (rcDeg(Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl))) + 360) % 360;
  const h = Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return [az, 2 * RC_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)))];
}

/** The point at a distance of km in the azimuth az from a (great circle): [lat, lon]. */
function rcDest(a, az, km) {
  const d = km / RC_EARTH_KM, f1 = rcRad(a.lat), t = rcRad(az);
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
  const l2 = rcRad(a.lon) + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return [rcDeg(f2), ((rcDeg(l2) + 540) % 360) - 180];
}

/** Great circle line from a in the azimuth az, km long, in steps (a long line bends on the map). */
function rcPath(a, az, km) {
  const n = Math.max(2, Math.min(64, Math.ceil(km / 50)));
  return Array.from({ length: n + 1 }, (_, i) => rcDest(a, az, (km * i) / n));
}

function rcSay(text, warn = false) {
  rcMsg = text;
  rcMsgWarn = warn;
  rcMsgUntil = Date.now() + 6000;
  rcRenderInfo();
}

async function rcLoadQth() {
  try {
    const s = await satFetch("/api/location");
    rcQth = s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && !(s.lat === 0 && s.lon === 0)
      ? { lat: s.lat, lon: s.lon, locator: s.locator || "" } : null;
  } catch { /* server unreachable: keep the last one */ }
}

/** The tab opened (RCTRL key, tab, page switch): the QTH may have changed in SETTINGS › GENERAL › LOCATION, read it again. */
async function rctrlOpened() {
  rcShowPage();
  if (rcPage === "conn") {       // the switches need the links now, not at the next poll
    fetch(rotorBase() + "/api/rotor").then((r) => r.json()).then(renderRotor).catch(() => rcRenderConn());
  }
  await rcLoadQth();
  if (rcPage === "map") await rcMapOpen();
  rcRenderAll();
}

/** The memories changed (MEMORIES editor, import, another VFO): the points and the group list are drawn again. */
function rctrlMemsChanged() {
  if (bodyTab === "rot" && rcMap) rcRenderAll();
}

async function rcMapOpen() {
  try {
    await Promise.all([satAsset("/static/leaflet/leaflet.css"), satAsset("/static/leaflet/leaflet.js")]);
  } catch (e) {
    $("rcNote").textContent = e.message;
    return false;
  }
  if (!rcMap) {
    rcMap = L.map($("rcMap"), { worldCopyJump: true, minZoom: 3 }).setView(rcQth ? [rcQth.lat, rcQth.lon] : [49, 18], 7);
    // the same darkened OpenStreetMap tiles as the AIS and HFDL maps
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 16, className: "hfdl-dark",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).addTo(rcMap);
    rcLay = { ant: L.layerGroup().addTo(rcMap), tgt: L.layerGroup().addTo(rcMap), ov: L.layerGroup().addTo(rcMap), qth: L.layerGroup().addTo(rcMap) };
    rcMap.on("click", (e) => rcAim({ lat: e.latlng.lat, lon: ((e.latlng.lng + 540) % 360) - 180, name: "" }));
    rcMap.on("mousemove", (e) => {
      if (!rcQth) return;
      const [az, km] = rcBearing(rcQth, { lat: e.latlng.lat, lon: e.latlng.lng });
      $("rcNote").textContent = `+ click: rotor to AZ ${Math.round(az)}° EL 0° · ${rcKm(km)} · ${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
    });
    rcMap.on("mouseout", () => { $("rcNote").textContent = RC_NOTE; });
  }
  setTimeout(() => rcMap.invalidateSize());
  return true;
}

/** Aim at a place: draws the target and sends the rotor there (when it can take a hand command and the source
 *  – "map" or "mem" – is connected in CONNECTION). */
function rcAim(t, source = "map") {
  if (!rcQth) { rcSay("Set the station location first (SETTINGS › GENERAL › LOCATION)", true); return; }
  const [az, km] = rcBearing(rcQth, t);
  rcTarget = { lat: t.lat, lon: t.lon, name: t.name || "", az, km };
  rcMemPick = t.id || null;
  store("rcTarget", JSON.stringify(rcTarget));
  rcDrawTarget();
  rcDrawAntenna(rotorInfo);
  rcRenderList();
  rcShowSel();
  if (!rcLinkOn(source)) { rcSay(`Target AZ ${Math.round(az)}° drawn, rotor not moved: ${RC_LINK_NAME[source]} is disconnected (CONNECTION)`, true); return; }
  const refusal = satDialRefusal(rotorInfo);
  if (refusal) { rcSay(`Target AZ ${Math.round(az)}° drawn, rotor not moved: ${refusal}`, true); return; }
  rcPost({ goto: [Math.round(az) % 360, 0], source }, `Rotor → AZ ${Math.round(az)}° EL 0°${t.name ? ` (${t.name})` : ""}`);
}

/** A channel of MEMORIES with a location recalled (list, spectrum tag, editor, step): the ROTOR CONTROL tab opens
 *  (the RCTRL key on), the map centres on the channel and the rotor turns to it, as a click on its point would.
 *  With MEMORY RECALL disconnected (RCTRL › CONNECTION) nothing happens here: the recall only tunes. */
async function rctrlAimMem(m) {
  // a fresh rotor state is needed first: the rotor is not polled while another tab is open, so the last state may be
  // missing or old (the links, or "not connected" that would refuse the command)
  const info = await fetch(rotorBase() + "/api/rotor").then((r) => r.json()).catch(() => null);
  if (info && info.links && !info.links.mem) return;
  rcPage = "map";
  store("rcPage", rcPage);
  if (bodyTab !== "rot") setRotOn(true);
  await rctrlOpened();
  if (info) renderRotor(info);
  rcAim({ id: m.id, name: m.name, lat: m.lat, lon: m.lon }, "mem");
  if (rcMap) rcMap.panTo([m.lat, m.lon]);
}

async function rcPost(body, ok) {
  try {
    const res = await fetch(rotorBase() + "/api/rotor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const info = await res.json();
    if (!res.ok) { rcSay(`Rotor: ${info.error || "error"}`, true); return; }
    rcSay(ok);
    renderRotor(info);
  } catch {
    rcSay("The receiver with the rotor is not reachable", true);
  }
}

function rcDrawQth() {
  if (!rcLay) return;
  rcLay.qth.clearLayers();
  if (rcQth) {
    L.circleMarker([rcQth.lat, rcQth.lon], { radius: 6, color: "#000", weight: 2, fillColor: "#ff5a3c", fillOpacity: 1, bubblingMouseEvents: false })
      .bindTooltip(`QTH ${escHtml(rcQth.locator)}`, { className: "ais-label" }).addTo(rcLay.qth);
  }
}

/** The wanted azimuth: a dashed line from the QTH (great circle) to the target point, with its label. */
function rcDrawTarget() {
  if (!rcLay) return;
  rcLay.tgt.clearLayers();
  if (!rcTarget || !rcQth) return;
  const [az, km] = rcBearing(rcQth, rcTarget);
  rcTarget.az = az;
  rcTarget.km = km;
  L.polyline(rcPath(rcQth, az, km), { color: "#ffe066", weight: 2, dashArray: "8 7", opacity: 0.95, interactive: false }).addTo(rcLay.tgt);
  L.circleMarker([rcTarget.lat, rcTarget.lon], { radius: 5, color: "#ffe066", weight: 2, fillColor: "#0b0e12", fillOpacity: 1, interactive: false })
    .bindTooltip(`${rcTarget.name ? `${escHtml(rcTarget.name)} · ` : ""}AZ ${Math.round(az)}° · ${rcKm(km)}`,
      { className: "ais-label", direction: "right", offset: [8, 0], permanent: true })
    .addTo(rcLay.tgt);
}

/** The antenna now: the beam sector ±BEAM/2 around the azimuth the rotor reports, out to the target distance.
 *  Redrawn with every rotor reading, so it turns with the rotor. */
function rcDrawAntenna(info) {
  if (!rcLay) return;
  rcLay.ant.clearLayers();
  if (!rcQth || !info || !info.connected || info.azShow == null) return;
  const az = info.azShow, bw = rcBeam(), len = Math.max(rcTarget && rcTarget.km ? rcTarget.km : RC_ANT_KM, 5);
  const style = { color: "#4cff7a", weight: 1, opacity: 0.7, fillColor: "#4cff7a", fillOpacity: 0.16, interactive: false };
  if (bw < 360) {
    const n = Math.max(8, Math.ceil(bw / 2)), arc = [];
    for (let i = 0; i <= n; i++) arc.push(rcDest(rcQth, az - bw / 2 + (bw * i) / n, len));
    L.polygon([[rcQth.lat, rcQth.lon], ...arc], style).addTo(rcLay.ant);
  } else {
    L.circle([rcQth.lat, rcQth.lon], { ...style, radius: len * 1000 }).addTo(rcLay.ant);
  }
  L.polyline(rcPath(rcQth, az, len), { color: "#4cff7a", weight: 2, opacity: 0.9, interactive: false }).addTo(rcLay.ant);
}

/** Rotor state (from renderRotor): the antenna sector and the head line. */
function rctrlRotor(info) {
  if (bodyTab !== "rot") return;
  rcRenderInfo();
  rcDrawAntenna(info);
  rcRenderConn();
}

function rcRenderInfo() {
  const i = rotorInfo, parts = [];
  if (!rcQth) parts.push("QTH not set (SETTINGS › GENERAL › LOCATION)");
  if (rcTarget && rcTarget.az != null) parts.push(`target ${rcTarget.name ? `${rcTarget.name} ` : ""}AZ ${Math.round(rcTarget.az)}° · ${rcKm(rcTarget.km)}`);
  parts.push(!i ? "rotor: no answer yet" : i.error && !i.on ? `rotor: ${i.error}` : !i.on ? "rotor off (SETTINGS › GENERAL › ROTOR)" : !i.connected ? "rotor connecting…"
    : i.fault ? `rotor fault: ${i.fault}`
    : `antenna AZ ${i.azShow != null ? Math.round(i.azShow) : "–"}° EL ${i.elShow != null ? Math.round(i.elShow) : "–"}°${rotorMoving(i) ? " (turning)" : ""}`);
  const off = RC_LINKS.filter((s) => !rcLinkOn(s.k)).map((s) => s.name);
  if (off.length) parts.push(`disconnected: ${off.join(", ")}`);
  const msg = Date.now() < rcMsgUntil ? rcMsg : "";
  $("rcInfo").textContent = (msg ? `${msg} · ` : "") + parts.join(" · ");
  $("rcInfo").classList.toggle("warn", !!msg && rcMsgWarn);
}

const rcHasLoc = (m) => Number.isFinite(m.lat) && Number.isFinite(m.lon);
const rcGroupsOf = (m) => { const g = memGroupsOf(m); return g.length ? g : [RC_NO_GROUP]; };

/** The groups of the channels with a location: [{name, color, count}], by name, "(no group)" last. */
function rcGroups() {
  const count = new Map();
  for (const m of mems) if (rcHasLoc(m)) for (const g of rcGroupsOf(m)) count.set(g, (count.get(g) || 0) + 1);
  const names = [...count.keys()].sort((a, b) => (a === RC_NO_GROUP) - (b === RC_NO_GROUP) || a.localeCompare(b, "en", { sensitivity: "base" }));
  return names.map((name, i) => ({ name, color: RC_COLORS[i % RC_COLORS.length], count: count.get(name) }));
}

/** The channels with a location in a group that is on (each once, in the colour of its first shown group),
 *  with the azimuth and distance from the QTH. */
function rcPoints() {
  const color = new Map(rcGroups().map((g) => [g.name, g.color])), out = [];
  for (const m of mems) {
    if (!rcHasLoc(m)) continue;
    const g = rcGroupsOf(m).find(rcGrpOn);
    if (!g) continue;
    const [az, km] = rcQth ? rcBearing(rcQth, m) : [null, null];
    const freq = m.freq_hz >= 30e6 ? `${fmtMHz(m.freq_hz, 4)} MHz` : `${fmtKHz(m.freq_hz, 2)} kHz`;
    out.push({ id: m.id, name: m.name, lat: m.lat, lon: m.lon, info: `${freq} ${m.mode}`, detail: [rcGroupsOf(m).join(", "), m.note || ""].filter(Boolean).join(" · "),
      group: g, color: color.get(g), az, km });
  }
  return out;
}

function rcRenderOverlays() {
  if (!rcLay) return;
  rcLay.ov.clearLayers();
  for (const p of rcPoints()) {
    const tip = `<b>${escHtml(p.name)}</b><br>${escHtml(p.info)}${p.detail ? `<br><span class="rc-tip-d">${escHtml(p.detail)}</span>` : ""}` +
      (p.az != null ? `<br>AZ ${Math.round(p.az)}° · ${rcKm(p.km)} · click: turn the rotor` : "");
    L.circleMarker([p.lat, p.lon], { radius: 5, color: "#000", weight: 1, fillColor: p.color, fillOpacity: 0.95, bubblingMouseEvents: false })
      .bindTooltip(tip, { className: "ais-label rc-tip" })
      .on("click", () => rcAim(p))
      .addTo(rcLay.ov);
  }
}

/** Beside the map: one row per group of channels with a location, its checkbox shows / hides its points. */
function rcRenderToggles() {
  const groups = rcGroups();
  $("rcOvs").innerHTML = `<div class="rc-ovs-head">GROUPS <button class="key small" data-rc-all="1" title="Show all groups">ALL</button>` +
    `<button class="key small" data-rc-all="0" title="Hide all groups">NONE</button></div>` +
    (groups.map((g) =>
      `<label class="rc-ov"><input type="checkbox" data-rc-grp="${escHtml(g.name)}"${rcGrpOn(g.name) ? " checked" : ""}>` +
      `<i style="background:${g.color}"></i>${escHtml(g.name)} <span class="muted">(${g.count})</span></label>`).join("") ||
    '<span class="muted">No channel has a location: set LAT / LON of a channel in MEMORIES › CHANNELS (EDIT, CHOOSE ON MAP).</span>');
}

function rcRenderList() {
  const q = $("rcFilter").value.trim().toLowerCase();
  const list = rcPoints().filter((p) => !q || `${p.name} ${p.info} ${p.detail}`.toLowerCase().includes(q))
    .sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  const isSel = (p) => rcTarget && Math.abs(p.lat - rcTarget.lat) < 1e-6 && Math.abs(p.lon - rcTarget.lon) < 1e-6;
  rcListShown = list.slice(0, 1500);
  $("rcList").innerHTML = `<div class="ais-ml-head">${list.length} channel${list.length === 1 ? "" : "s"}${rcQth ? ", nearest first" : ""} · click: turn the rotor</div>` +
    rcListShown.map((p, i) =>
      `<div class="rc-row${isSel(p) ? " sel" : ""}" data-i="${i}">` +
      `<i style="background:${escHtml(p.color)}"></i><b>${escHtml(p.name)}</b>` +
      `<span class="rc-az">${p.az != null ? `${Math.round(p.az)}°` : ""}</span><span class="rc-km">${p.km != null ? rcKm(p.km) : ""}</span>` +
      `<span class="rc-inf">${escHtml(p.info)}${p.detail ? ` · ${escHtml(p.detail)}` : ""}</span></div>`).join("");
}

/** Scrolls the list so that the row of the target (a clicked point) is visible; only the list moves, not the page. */
function rcShowSel() {
  const box = $("rcList"), row = box.querySelector(".rc-row.sel");
  if (!row) return;
  const head = box.querySelector(".ais-ml-head"), h = head ? head.offsetHeight : 0;
  // offsetTop is relative to the list (position: relative), so a CSS zoom of the page does not matter
  if (row.offsetTop - h < box.scrollTop) box.scrollTop = row.offsetTop - h;
  else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
}

function rcRenderAll() {
  if (bodyTab !== "rot") return;
  rcRenderToggles();
  rcRenderList();
  rcDrawQth();
  rcRenderOverlays();
  rcDrawTarget();
  rctrlRotor(rotorInfo);
  $("rcNote").textContent = RC_NOTE;
}

$("rcOvs").addEventListener("change", (e) => {
  const k = e.target.dataset.rcGrp;
  if (k == null) return;
  store(`rcGrp_${k}`, e.target.checked ? "1" : "0");
  rcRenderOverlays();
  rcRenderList();
});
$("rcOvs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-rc-all]");
  if (!b) return;
  for (const g of rcGroups()) store(`rcGrp_${g.name}`, b.dataset.rcAll);
  rcRenderToggles();
  rcRenderOverlays();
  rcRenderList();
});
$("rcFilter").addEventListener("input", () => rcRenderList());
$("rcList").addEventListener("click", (e) => {
  const r = e.target.closest(".rc-row");
  const p = r && rcListShown[Number(r.dataset.i)];
  if (!p) return;
  rcAim(p);
  if (rcMap) rcMap.panTo([p.lat, p.lon]);
});
$("rcBeam").value = rcBeam();
$("rcBeam").addEventListener("change", () => {
  const v = Math.min(Math.max(Math.round(Number($("rcBeam").value) || 30), 1), 360);
  $("rcBeam").value = v;
  store("rcBeam", String(v));
  rcDrawAntenna(rotorInfo);
});
$("rcClear").addEventListener("click", () => {
  rcTarget = null;
  store("rcTarget", "");
  rcDrawTarget();
  rcDrawAntenna(rotorInfo);
  rcRenderList();
  rcRenderInfo();
});
$("rcStop").addEventListener("click", () => rcPost({ stop: true }, "Rotor stopped"));

/** MAP / CONNECTION: the page keys, the bodies and the keys of the map in the head. */
function rcShowPage() {
  for (const b of $("rcPages").querySelectorAll("button[data-rc-page]")) {
    const on = b.dataset.rcPage === rcPage;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
  $("rcMapBox").hidden = rcPage !== "map";
  $("rcConnBox").hidden = rcPage !== "conn";
  for (const el of $("rotPane").querySelectorAll(".rc-map-only")) el.hidden = rcPage !== "map";
}
$("rcPages").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-rc-page]");
  if (!b || b.dataset.rcPage === rcPage) return;
  rcPage = b.dataset.rcPage;
  store("rcPage", rcPage);
  rctrlOpened();
});

/** What a source does now, for its block. */
function rcSrcState(k, on, i) {
  if (k === "sat") {
    const name = satRot && satRot.on ? satShort(satRot.name) : "";
    if (!(i && i.sat_on)) return "tracker idle";
    return `${name || "tracking"} · ${on ? "drives the rotor" : "calc only"}`;
  }
  if (k === "mem") return on ? "recall turns the rotor" : "recall only tunes";
  return on ? (rcTarget && rcTarget.az != null ? `target AZ ${Math.round(rcTarget.az)}°` : "click turns the rotor") : "click only draws target";
}

// geometry of the CONNECTION mimic (viewBox 960 × 384)
const RCC = { Y: [92, 200, 308], CX: 24, CW: 260, CH: 92, S0: 340, S1: 410, BUS: 500, RX: 636, RY: 92, RW: 300, RH: 252, DX: 712, DY: 226, DR: 58 };
const RC_ICONS = {
  sat: '<path d="M9.5 9.5l5 5-2.5 2.5-5-5z"/><path d="M3.5 7.5l3-3 3.5 3.5-3 3z"/><path d="M14 17.5l3-3 3.5 3.5-3 3z"/><path d="M15 3.5a5.5 5.5 0 0 1 5.5 5.5"/><path d="M15 6.5a2.5 2.5 0 0 1 2.5 2.5"/>',
  mem: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  map: '<path d="M12 21s-6.5-5.8-6.5-11.5a6.5 6.5 0 0 1 13 0C18.5 15.2 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/>',
};

/** Builds the mimic once; rcRenderConn() then only changes classes, texts and angles, so the levers swing,
 *  the flow keeps running and a hover is not lost at every rotor reading. */
function rcConnBuild() {
  const { Y, CX, CW, CH, S0, S1, BUS, RX, RY, RW, RH, DX, DY, DR } = RCC, mid = Y[1];
  let s = `<defs>
    <pattern id="rcGrid" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#1b222b"/></pattern>
    <linearGradient id="rcCardG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#161d26"/><stop offset="1" stop-color="#0a0e13"/></linearGradient>
    <linearGradient id="rcCardOn" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4cff7a" stop-opacity=".16"/><stop offset=".6" stop-color="#4cff7a" stop-opacity=".03"/><stop offset="1" stop-color="#4cff7a" stop-opacity="0"/></linearGradient>
    <radialGradient id="rcDialG" cx=".5" cy=".42" r=".6"><stop offset="0" stop-color="#18202a"/><stop offset="1" stop-color="#07090c"/></radialGradient>
  </defs>
  <rect class="rc-bg" x="0" y="0" width="960" height="384" rx="10"/><rect x="0" y="0" width="960" height="384" rx="10" fill="url(#rcGrid)"/>
  <text class="rc-col" x="${CX}" y="30">SOURCE OF AZ / EL</text><text class="rc-col rc-mid" x="${(S0 + S1) / 2}" y="30">LINK</text>
  <text class="rc-col rc-mid" x="${BUS}" y="30">BUS</text><text class="rc-col" x="${RX}" y="30">ROTOR</text>
  <text class="rc-count" id="rcCount" x="936" y="30"></text>`;
  // the wires after the switches, the bus segments to the feeder and the feeder (under the switches)
  RC_LINKS.forEach((src, n) => {
    const y = Y[n], seg = (x1, y1, x2, y2) => `<line class="rc-w" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><line class="rc-flow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    s += `<g class="rc-path" data-rc-path="${src.k}">${seg(S1, y, BUS, y)}${y !== mid ? seg(BUS, y, BUS, mid) : ""}<circle class="rc-node" cx="${BUS}" cy="${y}" r="5"/></g>`;
  });
  s += `<g class="rc-path rc-feed" id="rcFeed"><line class="rc-w rc-busbar" x1="${BUS}" y1="${Y[0]}" x2="${BUS}" y2="${Y[2]}"/>` +
    `<line class="rc-w" x1="${BUS}" y1="${mid}" x2="${RX}" y2="${mid}"/><line class="rc-flow" x1="${BUS}" y1="${mid}" x2="${RX}" y2="${mid}"/>` +
    `<circle class="rc-node" cx="${BUS}" cy="${mid}" r="6"/><text class="rc-tag rc-mid" x="${(BUS + RX) / 2}" y="${mid - 10}">AZ / EL</text></g>`;
  // the sources with their switches: one clickable group each
  RC_LINKS.forEach((src, n) => {
    const y = Y[n], top = y - CH / 2;
    s += `<g class="rc-link" data-rc-link="${src.k}" role="button" tabindex="0"><title></title>
      <rect class="rc-hit" x="${CX - 6}" y="${top - 6}" width="${S1 + 18 - CX}" height="${CH + 12}"/>
      <rect class="rc-card" x="${CX}" y="${top}" width="${CW}" height="${CH}" rx="10"/>
      <rect class="rc-card-on" x="${CX}" y="${top}" width="${CW}" height="${CH}" rx="10"/>
      <rect class="rc-accent" x="${CX}" y="${top + 12}" width="4" height="${CH - 24}" rx="2"/>
      <circle class="rc-ico-bg" cx="${CX + 40}" cy="${y}" r="22"/>
      <g class="rc-ico" transform="translate(${CX + 28} ${y - 12})">${RC_ICONS[src.k]}</g>
      <text class="rc-name" x="${CX + 74}" y="${y - 14}">${src.name}</text>
      <text class="rc-state" x="${CX + 74}" y="${y + 6}"></text>
      <text class="rc-where" x="${CX + 74}" y="${y + 25}">${escHtml(src.where)}</text>
      <circle class="rc-led" cx="${CX + CW - 16}" cy="${y - CH / 2 + 16}" r="4.5"/>
      <line class="rc-w rc-in" x1="${CX + CW}" y1="${y}" x2="${S0}" y2="${y}"/>
      <line class="rc-lever" x1="${S0}" y1="${y}" x2="${S1 - 4}" y2="${y}" style="transform-origin:${S0}px ${y}px"/>
      <circle class="rc-pin" cx="${S0}" cy="${y}" r="5.5"/><circle class="rc-pin rc-pin2" cx="${S1}" cy="${y}" r="5.5"/>
      <rect class="rc-pill" x="${(S0 + S1) / 2 - 32}" y="${y + 16}" width="64" height="18" rx="9"/>
      <text class="rc-pill-t rc-mid" x="${(S0 + S1) / 2}" y="${y + 29}"></text></g>`;
  });
  // the rotor: frame, status badge, compass dial (antenna AZ needle, target mark), AZ / EL readout and an EL bar
  let ticks = "";
  for (let a = 0; a < 360; a += 10) {
    const r1 = DR - (a % 90 === 0 ? 11 : a % 30 === 0 ? 8 : 4), t = rcRad(a);
    ticks += `<line class="rc-tick${a % 30 ? "" : " big"}" x1="${(DX + Math.sin(t) * r1).toFixed(1)}" y1="${(DY - Math.cos(t) * r1).toFixed(1)}" x2="${(DX + Math.sin(t) * (DR - 1)).toFixed(1)}" y2="${(DY - Math.cos(t) * (DR - 1)).toFixed(1)}"/>`;
  }
  const card = (a, l) => `<text class="rc-card-l rc-mid" x="${(DX + Math.sin(rcRad(a)) * (DR - 21)).toFixed(1)}" y="${(DY - Math.cos(rcRad(a)) * (DR - 21) + 4).toFixed(1)}">${l}</text>`;
  const ex = RX + 168, bw = RW - 168 - 22;
  s += `<g class="rc-rot" id="rcRot"><title>The rotor: green while at least one source is connected, grey when none is</title>
    <rect class="rc-frame" x="${RX}" y="${RY}" width="${RW}" height="${RH}" rx="12"/>
    <rect class="rc-frame-head" x="${RX}" y="${RY}" width="${RW}" height="34" rx="12"/><rect class="rc-frame-head" x="${RX}" y="${RY + 22}" width="${RW}" height="12"/>
    <text class="rc-name" x="${RX + 16}" y="${RY + 22}">ROTOR</text><text class="rc-where" id="rcRotDev" x="${RX + 76}" y="${RY + 22}"></text>
    <rect class="rc-badge" x="${RX + RW - 92}" y="${RY + 8}" width="80" height="18" rx="9"/><text class="rc-badge-t rc-mid" id="rcRotBadge" x="${RX + RW - 52}" y="${RY + 21}"></text>
    <circle class="rc-dial" cx="${DX}" cy="${DY}" r="${DR}"/>${ticks}${card(0, "N")}${card(90, "E")}${card(180, "S")}${card(270, "W")}
    <g id="rcTgt" class="rc-tgt" style="transform-origin:${DX}px ${DY}px"><path d="M${DX} ${DY - DR + 1}l-5.5 -10h11z"/></g>
    <g id="rcNeedle" class="rc-needle" style="transform-origin:${DX}px ${DY}px"><path d="M${DX} ${DY - DR + 13}L${DX + 5} ${DY}L${DX} ${DY + 12}L${DX - 5} ${DY}z"/></g>
    <circle class="rc-cap" cx="${DX}" cy="${DY}" r="4"/>
    <text class="rc-lbl" x="${ex}" y="${RY + 66}">AZIMUTH</text><text class="rc-big" id="rcRotAz" x="${ex}" y="${RY + 96}"></text>
    <text class="rc-lbl" x="${ex}" y="${RY + 126}">ELEVATION</text><text class="rc-big" id="rcRotEl" x="${ex}" y="${RY + 156}"></text>
    <rect class="rc-bar" x="${ex}" y="${RY + 166}" width="${bw}" height="6" rx="3"/><rect class="rc-bar-v" id="rcRotElBar" x="${ex}" y="${RY + 166}" width="0" height="6" rx="3"/>
    <line class="rc-tick" x1="${ex + bw / 2}" y1="${RY + 163}" x2="${ex + bw / 2}" y2="${RY + 175}"/>
    <text class="rc-state" id="rcRotSt" x="${RX + 16}" y="${RY + RH - 30}"></text>
    <text class="rc-where" id="rcRotSrc" x="${RX + 16}" y="${RY + RH - 12}"></text></g>
  <text class="rc-warn" id="rcConnWarn" x="${CX}" y="376"></text>`;
  $("rcConn").innerHTML = `<svg id="rcConnSvg" viewBox="0 0 960 384" role="group" aria-label="Sources of the wanted AZ / EL and the rotor">${s}</svg>`;
}

/** CONNECTION: the mimic of the three sources, each through its switch to one bus, the bus to the rotor.
 *  The rotor glows green while at least one source is connected, grey when none is. */
function rcRenderConn() {
  if (rcPage !== "conn" || bodyTab !== "rot") return;
  if (!$("rcConnSvg")) rcConnBuild();
  const i = rotorInfo, links = i && i.links ? i.links : null, svg = $("rcConnSvg");
  const n = links ? RC_LINKS.filter((s) => links[s.k]).length : 0, any = n > 0;
  const txt = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
  for (const src of RC_LINKS) {
    const on = !!links && links[src.k], g = svg.querySelector(`[data-rc-link="${src.k}"]`);
    g.classList.toggle("on", on);
    g.setAttribute("aria-pressed", String(on));
    g.setAttribute("aria-label", `${src.name} ${on ? "connected" : "disconnected"}`);
    txt(g.querySelector("title"), `${src.name}: ${on ? "connected – click to disconnect it from the rotor" : "disconnected – click to connect it to the rotor"}`);
    txt(g.querySelector(".rc-state"), links ? rcSrcState(src.k, on, i) : "unknown");
    txt(g.querySelector(".rc-pill-t"), on ? "LINKED" : "OPEN");
    svg.querySelector(`[data-rc-path="${src.k}"]`).classList.toggle("on", on);
  }
  $("rcFeed").classList.toggle("on", any);
  $("rcRot").classList.toggle("on", any);
  txt($("rcCount"), links ? `${n} / ${RC_LINKS.length} CONNECTED` : "");
  $("rcCount").classList.toggle("on", any);
  txt($("rcRotBadge"), any ? "ACTIVE" : "ISOLATED");
  txt($("rcRotDev"), i && i.device ? i.device : "");
  const ok = !!(i && i.connected && i.azShow != null);
  txt($("rcRotAz"), ok ? `${String(Math.round(i.azShow) % 360).padStart(3, "0")}°` : "---°");
  txt($("rcRotEl"), ok && i.elShow != null ? `${String(Math.round(i.elShow)).padStart(2, "0")}°` : "--°");
  $("rcRotElBar").setAttribute("width", ok && i.elShow != null ? (Math.min(Math.max(i.elShow, 0), 180) / 180 * (RCC.RW - 190)).toFixed(1) : "0");
  $("rcNeedle").style.transform = `rotate(${ok ? i.azShow : 0}deg)`;
  $("rcNeedle").classList.toggle("off", !ok);
  const tgt = i && i.target ? i.target[0] : null;
  $("rcTgt").style.transform = `rotate(${tgt ?? 0}deg)`;
  $("rcTgt").classList.toggle("off", tgt == null);
  txt($("rcRotSt"), !i ? "no answer" : i.error && !i.on ? i.error : !i.on ? "link off · SETTINGS › GENERAL › ROTOR" : !i.connected ? "connecting…"
    : i.fault ? `FAULT: ${i.fault}` : rotorMoving(i) && i.target ? `turning → AZ ${Math.round(i.target[0])}° EL ${Math.round(i.target[1])}°` : "standing");
  txt($("rcRotSrc"), !any ? "no source connected · hand commands only"
    : `driven by ${RC_LINKS.filter((s) => links[s.k]).map((s) => ({ sat: "SAT", mem: "MEMORY", map: "MAP" })[s.k]).join(" · ")}`);
  txt($("rcConnWarn"), links ? "" : "The receiver with the rotor did not answer yet: the state of the links is not known.");
}

async function rcToggleLink(k) {
  const links = rotorInfo && rotorInfo.links;
  if (!links) { rcSay("The receiver with the rotor is not reachable", true); return; }
  const on = !links[k];
  await rcPost({ links: { [k]: on } }, `${RC_LINK_NAME[k]} ${on ? "connected to" : "disconnected from"} the rotor`);
  rcRenderConn();
}
$("rcConn").addEventListener("click", (e) => {
  const g = e.target.closest("[data-rc-link]");
  if (g) rcToggleLink(g.dataset.rcLink);
});
$("rcConn").addEventListener("keydown", (e) => {
  const g = e.target.closest("[data-rc-link]");
  if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); rcToggleLink(g.dataset.rcLink); }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && bodyTab === "rot") rctrlOpened(); });

// A click on the clock switches UTC / local time (LOC); the choice is remembered.
let clockLocal = recall("clockLocal") === "1";
const CLOCK_DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const CLOCK_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function tickClock() {
  const d = new Date();
  const t = clockLocal
    ? [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":")
    : d.toISOString().slice(11, 19);
  $("clock").innerHTML = seg7(t);
  $("clock").setAttribute("aria-label", `${t} ${clockLocal ? "local time" : "UTC"}`);
  $("zoneLoc").classList.toggle("on", clockLocal);
  $("zoneUtc").classList.toggle("on", !clockLocal);
  // date under the digits, of the same zone as the time
  const [wd, day, mon, year] = clockLocal
    ? [d.getDay(), d.getDate(), d.getMonth(), d.getFullYear()]
    : [d.getUTCDay(), d.getUTCDate(), d.getUTCMonth(), d.getUTCFullYear()];
  const date = `${CLOCK_DAYS[wd]} ${String(day).padStart(2, "0")} ${CLOCK_MONTHS[mon]} ${year}`;
  if ($("clockDate").textContent !== date) $("clockDate").textContent = date;
}
function toggleClock() {
  clockLocal = !clockLocal;
  store("clockLocal", clockLocal ? "1" : "0");
  tickClock();
}
$("clockBox").addEventListener("click", toggleClock);
$("clockBox").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleClock(); } });
tickClock();
setInterval(tickClock, 1000);

// ---------- CPU and memory of the PC, under the S-meter (from the server of this page, every 3 s) ----------
function sysBar(bar, text, pct) {
  const v = pct == null ? 0 : Math.round(pct);
  $(bar).style.width = `${v}%`;
  $(bar).classList.toggle("warn", v > 70 && v <= 90);
  $(bar).classList.toggle("high", v > 90);
  $(text).textContent = pct == null ? "–" : `${v}%`;
}
async function pollSysLoad() {
  if (document.hidden) return;
  try {
    const d = await fetch("/api/sysload").then((r) => (r.ok ? r.json() : null));
    if (!d) return;
    sysBar("sysCpuBar", "sysCpu", d.cpu);
    sysBar("sysMemBar", "sysMem", d.mem);
    $("sysLoad").title = `Load of this PC (the RADIMCOM server)` +
      (d.mem_total ? `\nMemory: ${(d.mem_used / 2 ** 30).toFixed(1)} of ${(d.mem_total / 2 ** 30).toFixed(1)} GB` : "");
    $("sysLoad").hidden = false;
  } catch (e) { /* server not reachable: the indicator keeps its last values */ }
}
pollSysLoad();
setInterval(pollSysLoad, 3000);


// ---------- memories ----------

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function loadMems() {
  mems = await fetch(vbase + "/api/memories").then((r) => r.json());
  await loadMemGroups();
  renderMems();
  rctrlMemsChanged();
}

// MEMORIES tab: the memory editor (CHANNELS, GROUPS, IMPORT, EXPORT; by Brano, brjanicek). A click on a row of CHANNELS
// recalls the channel, so the table is also the list to tune from.
// DAB: the channel of the memory is recalled (DAB on with it); DSD: the digital voice mode. Both have a fixed width.
const MEM_MODES = ["AM", "FM", "WFM", "LSB", "USB", "CW", "DAB", "DSD"];
const MEM_FIXED_BW = { DAB: 1536000, DSD: 12500 };
let dabChannelList = [];     // [[channel, centre Hz]] from /api/state

/** id -> names of the other memories on the same frequency (within 50 Hz) and mode, or the same DAB channel. */
function memDuplicates() {
  const dups = new Map();
  const sorted = [...mems].sort((a, b) => a.freq_hz - b.freq_hz);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].freq_hz - sorted[i].freq_hz < 50; j++) {
      const a = sorted[i], b = sorted[j];
      if (a.mode !== b.mode || (a.dab_channel || "") !== (b.dab_channel || "")) continue;
      for (const [x, y] of [[a, b], [b, a]]) dups.set(x.id, [...(dups.get(x.id) || []), y.name]);
    }
  }
  return dups;
}

/** After a change of the memories: tags in the spectrum, names above the VFOs and the editor pages. */
function renderMems() {
  drawOverlays();   // memory tags in the spectrum
  renderVfoDisplays();   // memory name above each VFO
  renderMed();
}

/** Memory on the frequency of a VFO (same tolerance as the MEM list). More on one frequency: same mode first, then favourite. */
function memAt(hz, mode) {
  let best = null, bestScore = -1;
  for (const m of mems) {
    if (Math.abs(m.freq_hz - hz) >= 50) continue;
    const score = (m.mode === mode ? 2 : 0) + (m.fav ? 1 : 0);
    if (score > bestScore) { best = m; bestScore = score; }
  }
  return best;
}

let memActiveKey = null;   // ids of the highlighted memories, to scroll the table only when they change
/** The channels the VFO is tuned to are highlighted in the CHANNELS table, and the first one is scrolled into the middle
 *  of it (the order stays) when it changes or the page opens, so scrolling by hand is not undone. */
function markActiveMem(scroll = false) {
  if (!st) return;
  const on = (m) => !!m && (m.dab_channel ? !!st.dab && st.dab_channel === m.dab_channel
    : !st.dab && Math.abs(m.freq_hz - st.tune_hz) < 50 && m.mode === st.mode);
  const key = mems.filter(on).map((m) => m.id).join(" ");
  let first = null;
  for (const tr of $("medTable").querySelectorAll("tr[data-id]")) {
    const a = key.includes(tr.dataset.id);
    tr.classList.toggle("active", a);
    if (a) first = first || tr;
  }
  const wrap = $("medTable").closest(".med-table-wrap");
  if (first && bodyTab === "mem" && medTab === "channels" && (scroll || key !== memActiveKey)) {
    wrap.scrollTop = Math.max(0, first.offsetTop - wrap.clientHeight / 2 + first.offsetHeight / 2);
  }
  memActiveKey = key;
  memRecFollow();
}

/** Recall a memory: frequency, mode and bandwidth (on a VFO that can receive the frequency). A DAB memory: DAB on with its channel. */
async function recallMem(m) {
  await ensureVfoFor(m.freq_hz);
  if (!st) return;
  if (m.dab_channel || m.mode === "DAB") {
    if (rcHasLoc(m)) rctrlAimMem(m);   // the rotor turns to it; DAB on below opens the DAB tab, which stays in front
    dabRecall(m.dab_channel || st.dab_channel);
    markActiveMem();
    return;
  }
  // a channel with a location: the ROTOR CONTROL tab opens and the rotor turns to it (after the VFO switch, which may change the tab)
  if (rcHasLoc(m)) rctrlAimMem(m);
  if (st.dab) dabOff();   // an ordinary memory ends DAB like another band does (previous sample rate back)
  st.mode = m.mode;
  st.bandwidth[m.mode] = m.bw;
  renderControls();
  tune(m.freq_hz);
  send({ mode: m.mode, bandwidth: m.bw });
  if (m.decoder) memStartDecoder(m.decoder);
  memStartRecord(m);
  markActiveMem();
}

// What recalling a memory switched on: {id, vfo, at, cont, squelch, asq}. Only that is switched off again, by the
// next memory or by leaving the memory's frequency; a recording or ASQ switched on by hand stays as it is.
const MEM_REC_NONE = { id: null, vfo: "", at: 0, cont: false, squelch: false, asq: false };
let memRec = { ...MEM_REC_NONE };

/** Switches off what memRec says the recalled memory switched on (the keys pressed by hand stay). */
function memRecStop() {
  for (const b of REC_BUTTONS) if (memRec[b.key]) send({ [b.send]: false });
  if (memRec.asq && st.auto_sql) {
    st.auto_sql = st.auto_sql_on = false;
    st.auto_sql_level = null;
    send({ auto_sql: false });
  }
  memRec = { ...MEM_REC_NONE };
  renderRds();
  renderSqlBadge();
  renderVfoDisplays();
}

/** The VFO left the frequency (or mode, DAB channel) of the memory that started a recording: the recording stops. */
function memRecFollow() {
  if (!memRec.id || memRec.vfo !== vbase) return;          // another VFO is active: its own state is shown
  if (!(memRec.cont || memRec.squelch || memRec.asq)) return;
  if (Date.now() - memRec.at < 1500) return;                // the recall itself is still reaching the server
  const m = mems.find((x) => x.id === memRec.id);
  const on = !!m && (m.dab_channel ? !!st.dab && st.dab_channel === m.dab_channel
    : !st.dab && Math.abs(m.freq_hz - st.tune_hz) < 50 && m.mode === st.mode);
  if (!on) memRecStop();
}

/** RECORD of a recalled memory: ON = REC (everything), SQ = REC SQ, ASQ = REC SQ with the auto squelch on
 *  (AM, FM, WFM; other modes REC SQ only), OFF = no recording. */
function memStartRecord(m) {
  const mode = m.record || "off";
  const rec = st.recording || {};
  const want = { cont: mode === "on", squelch: mode === "sq" || mode === "asq" };
  const next = { id: m.id, vfo: vbase, at: Date.now(), cont: false, squelch: false, asq: false };
  for (const b of REC_BUTTONS) {
    const on = !!(rec[b.key] && rec[b.key].on);
    if (want[b.key]) {
      if (!on) send({ [b.send]: true });
      else if (b.key === "cont" && memRec.cont && memRec.id !== m.id) {
        // REC started by the previous memory: a new file, named after this memory
        send({ [b.send]: false });
        setTimeout(() => send({ [b.send]: true }), 700);
      }
      next[b.key] = !on || memRec[b.key];
    } else if (memRec[b.key]) {   // also when the state from the server has not caught up yet
      send({ [b.send]: false });
    }
  }
  const asqOk = ["AM", "FM", "WFM"].includes(m.mode);
  if (mode === "asq" && asqOk) {
    if (!st.auto_sql) {
      st.auto_sql = st.auto_sql_on = true;
      send({ auto_sql: true });
      next.asq = true;
    } else next.asq = memRec.asq;
  } else if (memRec.asq && st.auto_sql) {
    st.auto_sql = st.auto_sql_on = false;
    st.auto_sql_level = null;
    send({ auto_sql: false });
  }
  memRec = next;
  renderRds();
  renderSqlBadge();
  renderVfoDisplays();
}

/** The decoder of a recalled memory: switched on (if not on yet) and its page shown in the DECODERS tab. */
function memStartDecoder(key) {
  if (key === "ism") {
    if (!st.ism) ismOn();
    return;
  }
  const box = $(`${key}On`);
  if (!box || box.disabled) return;   // e.g. VDL2 on a dongle that cannot run it
  if (!box.checked) {
    box.checked = true;
    box.dispatchEvent(new Event("change"));
  }
  setDecPage(key);
  setBodyTab("dec");
}

/** Mode and width of the active VFO for a new memory: DAB while DAB is on, AM when the mode cannot be stored. */
function memCurMode() {
  if (st && (st.dab || st.mode === "DAB")) return { mode: "DAB", bw: MEM_FIXED_BW.DAB };
  const mode = st && MEM_MODES.includes(st.mode) ? st.mode : "AM";
  return { mode, bw: MEM_FIXED_BW[mode] || (st && st.bandwidth && st.bandwidth[mode]) || 3000 };
}

/** Opens the memory editor; template: a new channel to fill in the form (＋ SAVE CURRENT, ＋ NEW). */
async function memOpenEditor(template) {
  await loadMemGroups();
  if (bodyTab !== "mem") setMemOn(true);
  showMedTab(template ? "channels" : medTab);
  if (template && medFormLeaveOk()) medOpenForm(null, template);
}
$("medSaveCur").addEventListener("click", () => {   // the tuned frequency, mode, width (and DAB channel) in the form
  if (!st) return;
  const dabName = st.dab ? ["DAB", st.dab_channel, dabLastInfo.ensemble].filter(Boolean).join(" ") : "";
  const group = $("medGroup").value && $("medGroup").value !== NO_GROUP ? $("medGroup").value : "";
  memOpenEditor({ name: dabName || `${fmtKHz(st.tune_hz, 2)} kHz ${st.mode}`, groups: group ? [group] : [],
    freq_hz: st.tune_hz, ...memCurMode(), ...(st.dab ? { dab_channel: st.dab_channel } : {}) });
});

// ---------- memory editor (MEM → ✎ EDITOR): channels, groups with notes, import and export with a list ----------

const RECORD_NAMES = { off: "OFF", on: "ON", sq: "SQ", asq: "ASQ" };   // RECORD of a memory: recording at recall
const DECODER_NAMES = { "": "—", ft8: "FT8", wefax: "WEFAX", cw: "CW", rtty: "RTTY", sstv: "SSTV", packet: "PACKET",
  acars: "ACARS", vdl2: "VDL2", hfdl: "HFDL", ais: "AIS", adsb: "ADS-B", ism: "ISM" };
const NO_GROUP = "\u0000none";   // value of "(no group)" in the group filters
let memGroupList = [];           // [{name, note, count}] from /api/memory_groups
let medTab = recall("medTab") || "channels";
if (medTab === "list") medTab = "channels";   // the LIST page of 0.113beta1–2 is now CHANNELS
const medSel = new Set();        // ids of the channels ticked in CHANNELS
let medEditId = null;            // channel in the form: id, "new" or null
let medFormGroups = [];          // groups ticked in the form (with new ones typed there)
let medFormColor = "";           // "" = default colour
const medGrpSel = new Set();     // names ticked in GROUPS
const medImp = { rows: [], groups: [] };   // import list: rows as in medRow(), groups [{name, note, sel}]
const medExp = { rows: [], notes: {} };    // export list; notes: group -> {note, incl}

async function memApi(path, body, method = "POST") {
  try {
    const res = await fetch(vbase + path, { method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}${res.status === 404 || res.status === 405 ? " – restart RADIMCOM to load the new version" : ""}` };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function loadMemGroups() {
  const r = await memApi("/api/memory_groups", undefined, "GET");
  if (r.ok) memGroupList = r.data;
}

function memTagColor(m) { return m.color || MEM_COLOR; }
function memGroupsOf(m) { return m.groups || (m.group ? [m.group] : []); }
function memGroupNote(name) { return (memGroupList.find((g) => g.name === name) || {}).note || ""; }
/** Every group name: the group list (also empty groups) and the groups of the memories. */
function memAllGroups() {
  const names = new Set(memGroupList.map((g) => g.name));
  for (const m of mems) for (const g of memGroupsOf(m)) names.add(g);
  return [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}
function fmtMemFreq(hz) { return hz >= 30e6 ? `${fmtMHz(hz, 4)} M` : `${fmtKHz(hz, 2)} k`; }
function kHzText(bw) { return (bw / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 3, useGrouping: false }); }

/** After a change on the server: the memory list and the editor pages are drawn again. */
async function memChanged(newMems) {
  if (newMems) mems = newMems;
  else mems = await fetch(vbase + "/api/memories").then((r) => r.json());
  await loadMemGroups();
  renderMems();
  rctrlMemsChanged();
}

function medMsg(text, error) {
  const el = $("medNote");
  el.textContent = text || "";
  el.classList.toggle("error", !!error);
  el.hidden = !text;
}

function showMedTab(name) {
  medTab = name;
  store("medTab", name);
  for (const b of document.querySelectorAll("[data-med-tab]")) b.classList.toggle("on", b.dataset.medTab === name);
  for (const p of document.querySelectorAll("[data-med-panel]")) p.hidden = p.dataset.medPanel !== name;
  medMsg("");
  renderMed();
}
$("medTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-med-tab]"); if (b) showMedTab(b.dataset.medTab); });

/** The MEMORIES tab was opened: the shown page filled, the list scrolled to the tuned memory. */
function memPaneOpened() {
  medLoadQth();   // the station location may have changed in SETTINGS meanwhile
  // a channel picked on the ROTOR CONTROL map: CHANNELS with that row selected and scrolled into view (once per pick)
  const pick = rcMemPick && mems.some((m) => m.id === rcMemPick) ? rcMemPick : null;
  rcMemPick = null;
  if (pick) {
    medTab = "channels";
    if (!medEditId) { medSel.clear(); medSel.add(pick); }
  }
  showMedTab(medTab);
  if (medTab === "channels") markActiveMem(true);
  if (pick) medScrollTo(pick);
}

/** Scrolls the CHANNELS table so that the row of the channel id is in the middle (if the filters show it). */
function medScrollTo(id) {
  const tr = $("medTable").querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  if (!tr) return;
  const wrap = $("medTable").closest(".med-table-wrap");
  wrap.scrollTop = Math.max(0, tr.offsetTop - wrap.clientHeight / 2 + tr.offsetHeight / 2);
}

function renderMed() {
  if (bodyTab !== "mem") return;
  const names = memAllGroups();
  $("medGroupNames").innerHTML = names.map((g) => `<option value="${escHtml(g)}">`).join("");
  $("medCount").textContent = `${mems.length} channels · ${names.length} groups`;
  $("medExpCount").textContent = medExp.rows.length ? `(${medExp.rows.length})` : "";
  if (medTab === "channels") renderMedChannels();
  else if (medTab === "groups") renderMedGroups();
  else if (medTab === "import") renderMedImport();
  else renderMedExport();
}

// ----- CHANNELS -----

function medFilterSelect(sel, withAll) {
  const cur = sel.value;
  const names = memAllGroups();
  sel.innerHTML = (withAll ? `<option value="">All groups</option><option value="${NO_GROUP}">(no group)</option>` : "") +
    names.map((g) => `<option value="${escHtml(g)}">${escHtml(g)}</option>`).join("");
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : sel.options[0]?.value || "";
}

// the group for the bar above the table: a list of the groups, or "＋ new group…" with a name field
const medBulkIsNew = () => !!$("medBulkGroupSel").selectedOptions[0]?.dataset.new;
function medBulkGroupSelect() {
  const sel = $("medBulkGroupSel"), cur = sel.value;
  sel.innerHTML = `<option value="">Group…</option>` + memAllGroups().map((g) => `<option value="${escHtml(g)}">${escHtml(g)}</option>`).join("") +
    `<option data-new="1">＋ new group…</option>`;
  const wasNew = $("medBulkGroup").hidden === false;
  if (wasNew) sel.value = "＋ new group…";
  else sel.value = [...sel.options].some((o) => o.value === cur && !o.dataset.new) ? cur : "";
  $("medBulkGroup").hidden = !medBulkIsNew();
}
$("medBulkGroupSel").addEventListener("change", () => {
  const isNew = medBulkIsNew();
  $("medBulkGroup").hidden = !isNew;
  if (isNew) { $("medBulkGroup").value = ""; $("medBulkGroup").focus(); }
});
$("medBulkGroup").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("medBulk").querySelector("[data-bulk=add]").click(); }
});
function medBulkGroupName() {
  return medBulkIsNew() ? $("medBulkGroup").value.trim() : $("medBulkGroupSel").value;
}

function medVisible() {
  const q = $("medSearch").value.trim().toLowerCase();
  const qf = q.replace(/\s/g, "");
  const group = $("medGroup").value;
  const dupsOnly = $("medDups").checked;
  const favOnly = $("medFav").checked;
  const dups = memDuplicates();
  return mems.filter((m) => {
    const gs = memGroupsOf(m);
    if (group === NO_GROUP ? gs.length : group && !gs.includes(group)) return false;
    if (dupsOnly && !dups.has(m.id)) return false;
    if (favOnly && !m.fav) return false;
    return !q || m.name.toLowerCase().includes(q) || (m.note || "").toLowerCase().includes(q) ||
      gs.some((g) => g.toLowerCase().includes(q)) || fmtKHz(m.freq_hz, 3).replace(/\s/g, "").includes(qf);
  });
}

// Order of the CHANNELS table: a click on a column header sorts by it, a second click reverses it.
// By groups the table has a section for each group (a channel in two groups is listed in both).
const MED_COLS = [   // [key, header, class of the column (its fixed width), compare]
  ["fav", "★", "c-star", (a, b) => (b.fav - a.fav)],
  ["name", "Name", "c-name", (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })],
  ["freq", "Frequency", "c-freq num", (a, b) => a.freq_hz - b.freq_hz],
  ["mode", "Mode", "c-mode", (a, b) => (a.dab_channel ? "DAB" : a.mode).localeCompare(b.dab_channel ? "DAB" : b.mode)],
  ["bw", "BW", "c-bw num", (a, b) => a.bw - b.bw],
  ["decoder", "Decoder", "c-dec", (a, b) => (a.decoder || "~").localeCompare(b.decoder || "~")],
  ["record", "Rec", "c-rec", (a, b) => RECORD_ORDER.indexOf(a.record || "off") - RECORD_ORDER.indexOf(b.record || "off")],
  ["groups", "Groups", "c-groups", null],
  ["tag", "Tag", "c-tag", (a, b) => (a.tag === false) - (b.tag === false) || memTagColor(a).localeCompare(memTagColor(b))],
  ["lat", "LAT", "c-lat num", (a, b) => medNum(a.lat) - medNum(b.lat)],
  ["lon", "LON", "c-lon num", (a, b) => medNum(a.lon) - medNum(b.lon)],
  ["az", "AZ", "c-az num", (a, b) => medNum(medAzKm(a)?.[0]) - medNum(medAzKm(b)?.[0])],
  ["dist", "Dist", "c-dist num", (a, b) => medNum(medAzKm(a)?.[1]) - medNum(medAzKm(b)?.[1])],
  ["note", "Note", "c-note", (a, b) => (a.note || "~").localeCompare(b.note || "~", "en", { sensitivity: "base" })],
];
const RECORD_ORDER = ["on", "sq", "asq", "off"];
// Azimuth and distance of a channel from the station location of SETTINGS › GENERAL › LOCATION (/api/location,
// data\location.json), not from the browser. medQth: {lat, lon}, null = not set (0 / 0), undefined = not read yet.
let medQth;
const medNum = (v) => (v == null || v === "" ? Infinity : Number(v));   // channels without a value sort last
async function medLoadQth() {
  try {
    const s = await satFetch("/api/location");
    medQth = Number.isFinite(s.lat) && Number.isFinite(s.lon) && !(s.lat === 0 && s.lon === 0) ? { lat: s.lat, lon: s.lon } : null;
  } catch { medQth = null; }
  if (bodyTab === "mem" && medTab === "channels") renderMedChannels();
}
/** [azimuth °, distance km] from the station to the channel, or null (no location of the channel or the station). */
function medAzKm(m) {
  if (!medQth || m.lat == null || m.lon == null) return null;
  return rcBearing(medQth, { lat: m.lat, lon: m.lon });
}
let medSortKey = recall("medSortKey") || "groups";
let medSortDir = recall("medSortDir") === "-1" ? -1 : 1;
if (!MED_COLS.some(([k]) => k === medSortKey)) medSortKey = "groups";

function renderMedChannels() {
  medFilterSelect($("medGroup"), true);
  medBulkGroupSelect();
  const sort = medSortKey, dir = medSortDir;
  const group = $("medGroup").value;
  const dups = memDuplicates();
  const list = medVisible();
  for (const id of [...medSel]) if (!mems.some((m) => m.id === id)) medSel.delete(id);
  const byFreq = (a, b) => a.freq_hz - b.freq_hz;
  const cmp = (MED_COLS.find(([k]) => k === sort) || [])[3] || byFreq;
  list.sort((a, b) => dir * cmp(a, b) || byFreq(a, b));
  let sections;
  if (sort === "groups") {
    let names = group && group !== NO_GROUP ? [group] : memAllGroups();
    if (dir < 0) names = [...names].reverse();
    sections = names.map((g) => [g, list.filter((m) => memGroupsOf(m).includes(g)), memGroupNote(g)]);
    if (!group || group === NO_GROUP) sections.push(["(no group)", list.filter((m) => !memGroupsOf(m).length), ""]);
    if (group === NO_GROUP) sections = sections.slice(-1);
    sections = sections.filter(([, l]) => l.length);
  } else {
    sections = [[null, list, ""]];
  }
  const allSel = list.length && list.every((m) => medSel.has(m.id));
  const n = MED_COLS.length + 2;
  let html = `<colgroup><col class="c-chk"><col class="c-edit">${MED_COLS.map(([, , c]) => `<col class="${c.split(" ")[0]}">`).join("")}</colgroup>` +
    `<thead><tr><th><input type="checkbox" data-selall ${allSel ? "checked" : ""} title="Select all in the list"></th><th class="c-edit"></th>` +
    MED_COLS.map(([k, label, c]) => `<th class="sortable ${c}${k === sort ? " sorted" : ""}" data-sort="${k}" title="Sort by ${k === "fav" ? "star" : label.toLowerCase()}">` +
      `${label}${k === sort ? `<i class="sort-dir">${dir > 0 ? "▲" : "▼"}</i>` : ""}</th>`).join("") + `</tr></thead><tbody>`;
  for (const [title, rows, note] of sections) {
    if (title !== null) {
      html += `<tr class="med-sec"><td colspan="${n}">${escHtml(title)} <span class="muted">${rows.length}</span>` +
        (note ? ` <span class="med-secnote">${escHtml(note)}</span>` : "") + `</td></tr>`;
    }
    for (const m of rows) {
      const dup = dups.get(m.id);
      const groups = memGroupsOf(m);
      const dec = m.decoder ? DECODER_NAMES[m.decoder] || m.decoder : "";
      const rec = RECORD_NAMES[m.record || "off"] || m.record;
      html += `<tr class="med-ch${medSel.has(m.id) ? " sel" : ""}${m.id === medEditId ? " editing" : ""}" data-id="${m.id}">` +
        `<td><input type="checkbox" data-pick ${medSel.has(m.id) ? "checked" : ""}></td>` +
        `<td><button class="med-pen" data-edit title="Edit this channel">✎</button></td>` +
        `<td><button class="star${m.fav ? " on" : ""}" data-star>${m.fav ? "★" : "☆"}</button></td>` +
        `<td class="name" title="${escHtml(m.name)}">${dup ? `<i class="dup" title="Same frequency and mode as: ${escHtml(dup.join(", "))}">⧉</i> ` : ""}${escHtml(m.name)}</td>` +
        `<td class="num mono">${fmtMemFreq(m.freq_hz)}</td>` +
        `<td class="mode">${m.dab_channel ? `DAB ${escHtml(m.dab_channel)}` : m.mode}</td>` +
        `<td class="num mono">${fmtBw(m.bw)}</td>` +
        `<td title="${escHtml(dec)}">${escHtml(dec)}</td>` +
        `<td class="med-rec${m.record && m.record !== "off" ? " on" : ""}">${escHtml(rec)}</td>` +
        `<td class="groups" title="${escHtml(groups.join(", "))}">${groups.map((g) => `<span class="chip">${escHtml(g)}</span>`).join("")}</td>` +
        `<td><span class="swatch${m.tag === false ? " off" : ""}" style="--c:${memTagColor(m)}" title="${m.tag === false ? "tag hidden" : "tag shown"}"></span></td>` +
        medLocCells(m) +
        `<td class="note-cell" title="${escHtml(m.note || "")}">${escHtml(m.note || "")}</td></tr>`;
    }
  }
  if (!list.length) html += `<tr><td colspan="${n}" class="mem-empty">${mems.length ? "Nothing matches the filter." : "No channels yet."}</td></tr>`;
  $("medTable").innerHTML = html + "</tbody>";
  medRenderBulk();
  renderMedForm();
  markActiveMem();
}

/** LAT, LON, AZ and Dist cells of a channel row. */
function medLocCells(m) {
  const has = m.lat != null && m.lon != null;
  const ak = medAzKm(m);
  const azT = ak ? `${Math.round(ak[0])}°` : "", kmT = ak ? rcKm(ak[1]) : "";
  const why = has && !medQth ? ` title="Set the station location in SETTINGS › GENERAL › LOCATION"` : "";
  return `<td class="num mono">${has ? m.lat.toFixed(4) : ""}</td><td class="num mono">${has ? m.lon.toFixed(4) : ""}</td>` +
    `<td class="num mono"${why}>${azT}</td><td class="num mono"${why}>${kmT}</td>`;
}

/** Channels the bar above the table acts on: the ticked ones, or (none ticked) the channel open in the form. */
function medBulkIds() {
  if (medSel.size) return [...medSel];
  return medEditId && mems.some((m) => m.id === medEditId) ? [medEditId] : [];
}
function medRenderBulk() {
  $("medTable").classList.toggle("multi", medSel.size > 1);   // several rows selected: no ✎ (the editor takes one channel)
  const open = !medSel.size && medBulkIds().length ? mems.find((m) => m.id === medEditId) : null;
  $("medSelCount").textContent = open ? "" : `${medSel.size} selected`;
  $("medSelCount").title = open ? `No channel ticked: the keys act on the channel open in the form (${open.name})` : "";
  const none = !medBulkIds().length;
  for (const b of $("medBulk").querySelectorAll("button")) b.disabled = none;
  $("medBulkColor").disabled = none;
  // the groups of the channel open in the form are set in the form: the group keys of the bar are off meanwhile
  const form = !!medEditId;
  for (const el of [$("medBulkGroupSel"), $("medBulkGroup")]) el.disabled = none || form;
  for (const b of $("medBulk").querySelectorAll("[data-bulk=add], [data-bulk=remove]")) b.disabled = none || form;
}

for (const id of ["medSearch", "medDups", "medFav"]) $(id).addEventListener("input", renderMedChannels);
$("medGroup").addEventListener("change", renderMedChannels);

$("medTable").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]");
  if (th) {
    medSortDir = th.dataset.sort === medSortKey ? -medSortDir : 1;
    medSortKey = th.dataset.sort;
    store("medSortKey", medSortKey);
    store("medSortDir", String(medSortDir));
    renderMedChannels();
    return;
  }
  if (e.target.closest("[data-selall]")) {
    const list = medVisible();
    if (e.target.checked) for (const m of list) medSel.add(m.id); else for (const m of list) medSel.delete(m.id);
    renderMedChannels();
    return;
  }
  const row = e.target.closest("tr[data-id]");
  if (!row) return;
  const m = mems.find((x) => x.id === row.dataset.id);
  if (!m) return;
  if (e.target.closest("[data-pick]")) {
    if (e.target.checked) medSel.add(m.id); else medSel.delete(m.id);
    renderMedChannels();
    return;
  }
  if (e.target.closest("[data-star]")) {
    memApi(`/api/memories/${m.id}`, { fav: !m.fav }, "PATCH").then((r) => r.ok ? memChanged(mems.map((x) => (x.id === m.id ? r.data : x))) : medMsg(r.error, true));
    return;
  }
  if (e.target.closest("[data-edit]")) { if (medFormLeaveOk()) medOpenForm(m); return; }
  // a click selects the row (Ctrl/Cmd+click adds it to the selection or removes it); the table is not
  // redrawn here, so a double click still lands on the same row
  if (medEditId) { if (m.id !== medEditId && medFormLeaveOk()) medOpenForm(m); return; }   // the form is open: a click moves it to the clicked channel
  if (e.ctrlKey || e.metaKey) { if (medSel.has(m.id)) medSel.delete(m.id); else medSel.add(m.id); }
  else { medSel.clear(); medSel.add(m.id); }
  medSyncSel();
});
// a double click on a row tunes to the channel (recall, as the old LIST page did)
$("medTable").addEventListener("dblclick", (e) => {
  if (e.target.closest("th, input, button")) return;
  const row = e.target.closest("tr[data-id]");
  const m = row && mems.find((x) => x.id === row.dataset.id);
  if (m && st) recallMem(m);
});
/** Shows medSel on the drawn table (row colour, tick boxes) without redrawing it. */
function medSyncSel() {
  for (const tr of $("medTable").querySelectorAll("tr[data-id]")) {
    const on = medSel.has(tr.dataset.id);
    tr.classList.toggle("sel", on);
    const cb = tr.querySelector("[data-pick]");
    if (cb) cb.checked = on;
  }
  const all = $("medTable").querySelector("[data-selall]");
  const list = medVisible();
  if (all) all.checked = !!list.length && list.every((m) => medSel.has(m.id));
  medRenderBulk();
}

// bulk actions on the ticked channels
$("medBulk").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-bulk]");
  const ids = medBulkIds();
  if (!b || !ids.length) return;
  const act = b.dataset.bulk;
  const group = medBulkGroupName();
  if (["add", "remove"].includes(act) && medEditId) return;   // the form is open: groups are set there
  if (["add", "remove"].includes(act) && !group) {
    ($("medBulkGroup").hidden ? $("medBulkGroupSel") : $("medBulkGroup")).focus();
    medMsg($("medBulkGroup").hidden ? "Choose a group first." : "Enter the name of the new group first.", true);
    return;
  }
  if (act === "remove" && !memAllGroups().includes(group)) { medMsg(`There is no group ${group}.`, true); return; }
  if (act === "export") { medExportAdd(mems.filter((m) => ids.includes(m.id))); showMedTab("export"); return; }
  if (act === "delete" && !confirm(`Delete ${ids.length} selected channel${ids.length === 1 ? "" : "s"}?`)) return;
  const changes = { add: { groups_add: [group] }, remove: { groups_remove: [group] },
    fav: { fav: true }, unfav: { fav: false }, tagon: { tag: true }, tagoff: { tag: false },
    color: { color: $("medBulkColor").value }, nocolor: { color: "" } }[act];
  const r = await memApi("/api/memories/bulk", act === "delete" ? { ids, delete: true } : { ids, changes });
  if (!r.ok) { medMsg(r.error, true); return; }
  if (act === "delete") { medSel.clear(); if (ids.includes(medEditId)) medEditId = null; }
  medMsg(act === "delete" ? `Deleted ${r.data.deleted}.` : `Changed ${r.data.changed.length}.`);
  if (act === "add" && medBulkIsNew()) {
    // the new group now exists: pick it in the list (filled again by memChanged) instead of the name field
    const o = document.createElement("option"); o.value = group; $("medBulkGroupSel").append(o); $("medBulkGroupSel").value = group;
    $("medBulkGroup").hidden = true;
  }
  await memChanged();
});

// CHOOSE ON MAP of the channel form: an OpenStreetMap map in place of the table (as in SETTINGS › GENERAL › LOCATION);
// a click puts its place into LAT / LON of the form, SAVE keeps it. Red = the station location, yellow = the channel.
let medMap = null, medMapMark = null, medMapQth = null;
async function medMapOpen() {
  $("medMapBox").hidden = false;
  $("medTable").closest(".med-table-wrap").hidden = true;
  $("medMapNote").textContent = "Loading the map…";
  try {
    await Promise.all([satAsset("/static/leaflet/leaflet.css"), satAsset("/static/leaflet/leaflet.js")]);
  } catch (e) {
    $("medMapNote").textContent = e.message;
    return;
  }
  if (medQth === undefined) await medLoadQth();
  if (!medMap) {
    medMap = L.map($("medMap"), { worldCopyJump: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).addTo(medMap);
    medMapMark = L.circleMarker([0, 0], { radius: 7, color: "#000", weight: 2, fillColor: "#ffd84a", fillOpacity: 1 });
    medMap.on("click", (ev) => {
      const p = ev.latlng.wrap(), f = $("medForm");
      f.elements.lat.value = p.lat.toFixed(6);
      f.elements.lon.value = p.lng.toFixed(6);
      medFormDirty = true;
      medMapShow(false);
    });
  }
  if (medMapQth) medMapQth.remove();
  medMapQth = medQth ? L.circleMarker([medQth.lat, medQth.lon], { radius: 6, color: "#000", weight: 2, fillColor: "#ff5a3c", fillOpacity: 1,
    interactive: false }).addTo(medMap) : null;
  medMap.invalidateSize();
  medMapShow();
}
/** Marker and note from LAT / LON of the form; center: move the view to it (or to the station). */
function medMapShow(center = true) {
  if (!medMap) return;
  const f = $("medForm");
  const lat = parseFloat(String(f.elements.lat.value).replace(",", ".")), lon = parseFloat(String(f.elements.lon.value).replace(",", "."));
  const ok = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (ok) medMapMark.setLatLng([lat, lon]).addTo(medMap); else medMapMark.remove();
  if (center) {
    if (ok) medMap.setView([lat, lon], Math.max(medMap.getZoom() || 0, 9));
    else if (medQth) medMap.setView([medQth.lat, medQth.lon], 7);
    else medMap.setView([49, 18], 5);
  }
  const ak = ok && medQth ? rcBearing(medQth, { lat, lon }) : null;
  $("medMapNote").textContent = (ok ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` + (ak ? ` · AZ ${Math.round(ak[0])}° · ${rcKm(ak[1])} from the station` : "") +
    " · SAVE keeps it" : "Click the place of the station on the channel") + (medQth ? "" : " · station location not set (SETTINGS › GENERAL › LOCATION)");
}
function medMapClose() {
  if ($("medMapBox").hidden) return;
  $("medMapBox").hidden = true;
  $("medTable").closest(".med-table-wrap").hidden = false;
}
$("medMapClose").addEventListener("click", medMapClose);

// the form of one channel
let medFormAdv = recall("medFormAdv") === "1";   // ADVANCED part of the form shown (remembered in the browser)
function medFormAdvShow() {
  $("medFormAdv").hidden = !medFormAdv;
  $("medFormAdvKey").classList.toggle("on", medFormAdv);
  $("medFormAdvKey").setAttribute("aria-expanded", medFormAdv);
}
medFormAdvShow();
let medFormDirty = false;        // the form was changed and not saved yet
/** Before the form is filled with another channel: asks whether unsaved changes may be dropped. */
function medFormLeaveOk() {
  return !medEditId || !medFormDirty ||
    confirm(medEditId === "new" ? "The new channel is not saved. Discard it?" : "The changes of the channel are not saved. Discard them?");
}
function medOpenForm(m, template) {
  medEditId = m ? m.id : "new";
  medFormDirty = false;
  const f = $("medForm");
  const src = m || template || { name: "", groups: $("medGroup").value && $("medGroup").value !== NO_GROUP ? [$("medGroup").value] : [],
    freq_hz: st ? st.tune_hz : 0, ...memCurMode(), ...(st && st.dab ? { dab_channel: st.dab_channel } : {}), decoder: "", record: "off", note: "", color: "", tag: true, fav: false };
  f.elements.mode.innerHTML = MEM_MODES.map((x) => `<option>${x}</option>`).join("");
  f.elements.decoder.innerHTML = Object.entries(DECODER_NAMES).map(([k, v]) => `<option value="${k}">${k ? v : "none"}</option>`).join("");
  f.elements.dab.innerHTML = `<option value="">—</option>` + dabChannelList.map(([n, hz]) => `<option value="${escHtml(n)}">${escHtml(n)} · ${fmtMHz(hz, 3)} MHz</option>`).join("");
  f.elements.name.value = src.name;
  f.elements.freq.value = src.freq_hz == null ? "" : fmtMHz(src.freq_hz, 6);
  f.elements.mode.value = src.dab_channel ? "DAB" : src.mode;
  f.elements.bw.value = kHzText(src.bw);
  f.elements.decoder.value = src.decoder || "";
  f.elements.record.innerHTML = Object.entries(RECORD_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  f.elements.record.value = src.record || "off";
  f.elements.dab.value = src.dab_channel || "";
  f.elements.note.value = src.note || "";
  f.elements.lat.value = src.lat ?? "";
  f.elements.lon.value = src.lon ?? "";
  if (medMap) medMapShow();
  f.elements.tag.checked = src.tag !== false;
  f.elements.fav.checked = !!src.fav;
  medFormColor = src.color || "";
  f.elements.color.value = medFormColor || MEM_COLOR;
  medFormGroups = [...memGroupsOf(src)];
  $("medFormTitle").textContent = m ? "Edit channel" : "New channel";
  $("medFormSave").textContent = m ? "SAVE" : "＋ ADD";
  f.querySelector("[data-act=recall]").hidden = f.querySelector("[data-act=delete]").hidden = !m;
  $("medFormErr").hidden = true;
  f.hidden = false;
  // only the marks of the rows change: drawing the table again would break a double click (recall) on a row
  for (const tr of $("medTable").querySelectorAll("tr[data-id]")) tr.classList.toggle("editing", tr.dataset.id === medEditId);
  medSel.clear();   // the form takes one channel: no multi-selection while it is open
  medSyncSel();
  renderMedForm();
  if (!m) f.elements.name.focus();
}

function renderMedForm() {
  const f = $("medForm");
  if (medEditId && medEditId !== "new" && !mems.some((m) => m.id === medEditId)) medEditId = null;
  f.hidden = !medEditId;
  if (!medEditId) medMapClose();   // the map belongs to the form
  $("medTable").classList.toggle("form-open", !!medEditId);   // tick boxes hidden while the form is open
  if (!medEditId) return;
  const names = [...new Set([...memAllGroups(), ...medFormGroups])].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  $("medFormGroups").innerHTML = names.length ? names.map((g) => `<label class="chip-check"><input type="checkbox" value="${escHtml(g)}"` +
    `${medFormGroups.includes(g) ? " checked" : ""}> ${escHtml(g)}</label>`).join("") : `<span class="muted">no groups yet</span>`;
  medFormModeFields();
  medFormDupNote();
}

/** The fields of the form that the mode uses: DAB = the DAB channel (frequency = its centre), a fixed width for DAB and
 *  DSD, the DAB channel empty and off for the other modes. */
function medFormModeFields() {
  const f = $("medForm"), mode = f.elements.mode.value, dab = mode === "DAB";
  if (dab && !f.elements.dab.value) f.elements.dab.value = (st && st.dab_channel) || (dabChannelList[0] || [])[0] || "";
  if (!dab) f.elements.dab.value = "";
  f.elements.dab.disabled = !dab;
  f.elements.freq.disabled = dab;
  f.querySelector(".med-freq").hidden = dab;    // one place: the frequency, or for DAB the DAB channel
  f.querySelector(".med-dab").hidden = !dab;
  if (dab) {
    const hz = (dabChannelList.find(([n]) => n === f.elements.dab.value) || [])[1];
    if (hz) f.elements.freq.value = fmtMHz(hz, 6);
  }
  f.elements.bw.disabled = !!MEM_FIXED_BW[mode];
  if (MEM_FIXED_BW[mode]) f.elements.bw.value = kHzText(MEM_FIXED_BW[mode]);
}

/** Warns in the form when another channel is on the same frequency and mode. */
function medFormDupNote() {
  const f = $("medForm");
  const hz = f.elements.dab.value ? (dabChannelList.find(([n]) => n === f.elements.dab.value) || [])[1] : parseFreq(f.elements.freq.value);
  const other = hz ? mems.filter((m) => m.id !== medEditId && m.mode === f.elements.mode.value && Math.abs(m.freq_hz - hz) < 50) : [];
  $("medFormDup").textContent = other.length ? `⧉ Same frequency and mode as: ${other.map((m) => m.name).join(", ")}` : "";
  $("medFormDup").hidden = !other.length;
}

$("medFormGroups").addEventListener("change", (e) => {
  const g = e.target.value;
  medFormGroups = e.target.checked ? [...medFormGroups, g] : medFormGroups.filter((x) => x !== g);
  medFormDirty = true;
});
$("medFormNewGroup").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const g = e.target.value.trim().replace(/\s+/g, " ").slice(0, 40);
  if (g && !medFormGroups.includes(g)) { medFormGroups.push(g); medFormDirty = true; }
  e.target.value = "";
  renderMedForm();
});
$("medForm").addEventListener("input", (e) => {
  const f = $("medForm");
  medFormDirty = true;
  if ((e.target === f.elements.lat || e.target === f.elements.lon) && medMap) medMapShow(false);
  if (e.target === f.elements.color) medFormColor = e.target.value;
  if (e.target === f.elements.dab || e.target === f.elements.mode) medFormModeFields();
  if ([f.elements.freq, f.elements.mode, f.elements.dab].includes(e.target)) medFormDupNote();
});
$("medForm").addEventListener("change", (e) => {
  const f = $("medForm");
  if (e.target === f.elements.mode && !MEM_FIXED_BW[e.target.value] && st && st.bandwidth && st.bandwidth[e.target.value]) f.elements.bw.value = kHzText(st.bandwidth[e.target.value]);
});
$("medForm").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  const f = $("medForm");
  const m = mems.find((x) => x.id === medEditId);
  if (act === "nocolor") { medFormColor = ""; f.elements.color.value = MEM_COLOR; medFormDirty = true; }
  else if (act === "cancel") { medEditId = null; renderMedChannels(); }
  else if (act === "recall" && m) recallMem(m);
  else if (act === "map") medMapOpen();
  else if (act === "adv") { medFormAdv = !medFormAdv; store("medFormAdv", medFormAdv ? "1" : "0"); medFormAdvShow(); }
  else if (act === "delete" && m && confirm(`Delete channel "${m.name}"?`)) {
    const r = await memApi(`/api/memories/${m.id}`, undefined, "DELETE");
    if (!r.ok) { medMsg(r.error, true); return; }
    medEditId = null;
    medSel.delete(m.id);
    await memChanged();
  }
});
$("medForm").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); medEditId = null; renderMedChannels(); }
});
$("medForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = $("medForm");
  const err = (t) => { $("medFormErr").textContent = t; $("medFormErr").hidden = false; };
  const pending = $("medFormNewGroup").value.trim();   // typed but Enter not pressed
  if (pending && !medFormGroups.includes(pending)) medFormGroups.push(pending.slice(0, 40));
  $("medFormNewGroup").value = "";
  const dab = f.elements.mode.value === "DAB" ? f.elements.dab.value : "";
  const freq = dab ? null : parseFreq(f.elements.freq.value);
  const bw = parseFloat(f.elements.bw.value.replace(",", ".")) * 1000;
  if (!f.elements.name.value.trim()) return err("Enter a name.");
  if (f.elements.mode.value === "DAB" && !dab) return err("Choose the DAB channel.");
  if (!dab && !freq) return err("Enter a frequency, e.g. 145.5 or 7100k.");
  if (!(bw > 0)) return err("Enter the bandwidth in kHz.");
  const isNew = medEditId === "new";
  const body = { name: f.elements.name.value.trim(), groups: medFormGroups, mode: f.elements.mode.value, bw: Math.round(bw),
    decoder: f.elements.decoder.value, record: f.elements.record.value, note: f.elements.note.value.trim(), color: medFormColor, tag: f.elements.tag.checked,
    fav: f.elements.fav.checked, lat: f.elements.lat.value.trim() || null, lon: f.elements.lon.value.trim() || null,
    ...(dab ? { dab_channel: dab } : { freq_hz: Math.round(freq), ...(isNew ? {} : { dab_channel: null }) }) };
  const r = await memApi(isNew ? "/api/memories" : `/api/memories/${medEditId}`, body, isNew ? "POST" : "PATCH");
  if (!r.ok) return err(r.error);
  $("medFormErr").hidden = true;
  medEditId = r.data.id;
  medFormDirty = false;
  medMsg(isNew ? `Added "${r.data.name}".` : `Saved "${r.data.name}".`);
  await memChanged(isNew ? [...mems, r.data] : mems.map((x) => (x.id === r.data.id ? r.data : x)));
  if (isNew) medOpenForm(r.data);   // the new channel stays in the form, now as a saved one
});
$("medNew").addEventListener("click", () => { if (medFormLeaveOk()) medOpenForm(null); });

// ----- GROUPS -----

function renderMedGroups() {
  const counts = {};
  for (const m of mems) for (const g of memGroupsOf(m)) counts[g] = (counts[g] || 0) + 1;
  const names = memAllGroups();
  for (const g of [...medGrpSel]) if (!names.includes(g)) medGrpSel.delete(g);
  const noGroup = mems.filter((m) => !memGroupsOf(m).length).length;
  let html = `<thead><tr><th class="c-chk"><input type="checkbox" data-selall ${names.length && names.every((g) => medGrpSel.has(g)) ? "checked" : ""}></th>` +
    `<th class="c-gname">Group</th><th class="num c-count">Channels</th><th class="c-gnote">Note</th><th class="c-acts"></th></tr></thead><tbody>`;
  for (const g of names) {
    html += `<tr data-g="${escHtml(g)}"${medGrpSel.has(g) ? ' class="sel"' : ""}><td><input type="checkbox" data-pick ${medGrpSel.has(g) ? "checked" : ""}></td>` +
      `<td class="name" title="${escHtml(g)}">${escHtml(g)}</td><td class="num">${counts[g] || 0}</td>` +
      `<td class="grow"><input data-note value="${escHtml(memGroupNote(g))}" placeholder="note…" maxlength="200"></td>` +
      `<td class="acts"><button class="icon-btn" data-g-act="show" title="Show channels" aria-label="Show">☰</button>` +
      `<button class="icon-btn" data-g-act="rename" title="Rename" aria-label="Rename">✎</button>` +
      `<button class="icon-btn" data-g-act="copy" title="Copy the group and its channels under a new name" aria-label="Copy">⎘</button>` +
      `<button class="icon-btn danger" data-g-act="delete" title="Delete" aria-label="Delete">🗑</button></td></tr>`;
  }
  if (noGroup) html += `<tr data-g="${NO_GROUP}"><td></td><td class="name muted">(no group)</td><td class="num">${noGroup}</td><td></td>` +
    `<td class="acts"><button class="icon-btn" data-g-act="show" title="Show channels" aria-label="Show">☰</button></td></tr>`;
  if (!names.length && !noGroup) html += `<tr><td colspan="5" class="mem-empty">No groups yet.</td></tr>`;
  $("medGrpTable").innerHTML = html + "</tbody>";
  $("medGrpSelCount").textContent = `${medGrpSel.size} selected`;
  $("medGrpMerge").disabled = medGrpSel.size < 2;
  $("medGrpDel").disabled = $("medGrpExport").disabled = !medGrpSel.size;
}

async function medGroupAction(body, done) {
  const r = await memApi("/api/memory_groups", body);
  if (!r.ok) { medMsg(r.error, true); return false; }
  medMsg(done);
  memGroupList = r.data.groups;
  await memChanged(r.data.memories);
  return true;
}

$("medGrpAdd").addEventListener("click", async () => {
  const name = $("medGrpName").value.trim();
  if (!name) { $("medGrpName").focus(); return; }
  if (await medGroupAction({ action: "add", name, note: $("medGrpNote").value }, `Group "${name}" added.`)) {
    $("medGrpName").value = $("medGrpNote").value = "";
  }
});
for (const id of ["medGrpName", "medGrpNote"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") $("medGrpAdd").click(); });

$("medGrpTable").addEventListener("change", (e) => {
  const row = e.target.closest("tr[data-g]");
  if (e.target.matches("[data-note]") && row) {
    const name = row.dataset.g;
    medGroupAction({ action: "note", name, note: e.target.value }, `Note of "${name}" saved.`);
  }
});
$("medGrpTable").addEventListener("click", async (e) => {
  if (e.target.closest("[data-selall]")) {
    for (const g of memAllGroups()) if (e.target.checked) medGrpSel.add(g); else medGrpSel.delete(g);
    renderMedGroups();
    return;
  }
  const row = e.target.closest("tr[data-g]");
  if (!row) return;
  const name = row.dataset.g;
  if (e.target.closest("[data-pick]")) {
    if (e.target.checked) medGrpSel.add(name); else medGrpSel.delete(name);
    renderMedGroups();
    return;
  }
  const act = e.target.closest("[data-g-act]")?.dataset.gAct;
  if (act === "show") {
    medSortKey = "groups";
    medSortDir = 1;
    showMedTab("channels");
    medFilterSelect($("medGroup"), true);
    $("medGroup").value = name;
    renderMedChannels();
  } else if (act === "rename" || act === "copy") {
    const nw = (prompt(act === "rename" ? `New name of the group "${name}":` : `Copy the group "${name}" and its channels as:`,
      act === "rename" ? name : `${name} copy`) || "").trim();
    if (nw && nw !== name) medGroupAction({ action: act, name, new: nw }, act === "rename" ? `Renamed to "${nw}".` : `Copied to "${nw}".`);
  } else if (act === "delete") {
    medGroupDelete([name]);
  }
});

async function medGroupDelete(names) {
  const only = mems.filter((m) => { const gs = memGroupsOf(m); return gs.length && gs.every((g) => names.includes(g)); }).length;
  const label = names.length === 1 ? `the group "${names[0]}"` : `${names.length} groups`;
  if (!confirm(`Delete ${label}?`)) return;
  const delMems = only > 0 && confirm(`${only} channel${only === 1 ? " is" : "s are"} in no other group.\n\nOK = delete ${only === 1 ? "it" : "them"} too\nCancel = keep ${only === 1 ? "it" : "them"} without a group`);
  for (const name of names) {
    const ok = await medGroupAction({ action: "delete", name, delete_memories: delMems }, `Deleted ${label}${delMems ? ` and ${only} channels` : ""}.`);
    if (!ok) return;
    medGrpSel.delete(name);
  }
}
$("medGrpDel").addEventListener("click", () => medGroupDelete([...medGrpSel]));
$("medGrpMerge").addEventListener("click", async () => {
  const names = [...medGrpSel];
  if (names.length < 2) return;
  const into = (prompt(`Merge ${names.join(", ")} into the group:`, names[0]) || "").trim();
  if (!into) return;
  if (await medGroupAction({ action: "merge", names, into }, `Merged into "${into}".`)) medGrpSel.clear();
  renderMedGroups();
});
$("medGrpExport").addEventListener("click", () => {
  medExportAdd(mems.filter((m) => memGroupsOf(m).some((g) => medGrpSel.has(g))));
  for (const g of medGrpSel) medExp.notes[g] = medExp.notes[g] || { note: memGroupNote(g), incl: true };
  showMedTab("export");
});

// ----- editable lists of IMPORT and EXPORT -----

/** A memory (or an entry of a file) as a row of an editable list: the fields as text, as typed in the inputs. */
function medRow(m) {
  const num = (v) => (typeof v === "number" ? v : parseFloat(String(v).replace(",", ".")));
  const hz = num(m.freq_hz);
  const bw = num(m.bw);
  const r = { name: String(m.name ?? ""), freq: Number.isFinite(hz) ? fmtMHz(hz, 6) : String(m.freq_hz ?? ""),
    mode: m.dab_channel ? "DAB" : String(m.mode || "").toUpperCase(), bw: Number.isFinite(bw) ? kHzText(bw) : String(m.bw ?? ""),
    decoder: m.decoder || "", record: String(m.record || "off").toLowerCase(), groups: (Array.isArray(m.groups) ? m.groups : m.group ? [m.group] : []).filter(Boolean).join(" | "),
    note: m.note || "", color: m.color || "", tag: m.tag !== false && m.tag !== "0", fav: !!m.fav, dab: m.dab_channel || "",
    lat: m.lat ?? "", lon: m.lon ?? "", sel: true, err: m.error || "" };
  if (r.mode === "DAB") medRowModeChanged(r, false);   // a DAB entry without a channel: the channel at its frequency
  return r;
}

/** LAT / LON as typed -> a number, null when empty; a text that is not a number stays text (the server says why). */
function medCoord(v) {
  const t = String(v ?? "").trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : t;
}
/** Row -> entry for the server; throws Error with the reason when a field is wrong. */
function medRowEntry(r) {
  const dab = r.mode === "DAB" ? r.dab : "";   // another mode chosen in the list ends the DAB channel
  const hz = dab ? (dabChannelList.find(([n]) => n === dab) || [])[1] : parseFreq(r.freq);
  const bw = parseFloat(String(r.bw).replace(",", ".")) * 1000;
  if (!r.name.trim()) throw new Error("name is missing");
  if (r.mode === "DAB" && !dab) throw new Error("choose the DAB channel");
  if (!dab && !hz) throw new Error("bad frequency");
  if (!MEM_MODES.includes(r.mode)) throw new Error("unknown mode");
  if (!(bw > 0)) throw new Error("bad bandwidth");
  return { name: r.name.trim(), groups: r.groups.split("|").map((g) => g.trim()).filter(Boolean), mode: r.mode, bw: Math.round(bw),
    decoder: r.decoder, record: r.record, note: r.note.trim(), color: r.color, tag: r.tag, fav: r.fav,
    lat: medCoord(r.lat), lon: medCoord(r.lon),
    ...(dab ? { dab_channel: dab } : {}), ...(hz ? { freq_hz: Math.round(hz) } : {}) };   // DAB: the frequency is the centre of the channel
}

function medRowDup(r) {
  if (r.err) return "";
  const dab = r.mode === "DAB" ? r.dab : "";
  const hz = dab ? (dabChannelList.find(([n]) => n === dab) || [])[1] : parseFreq(r.freq);
  const m = hz && mems.find((x) => x.mode === r.mode && Math.abs(x.freq_hz - hz) < 50 && (x.dab_channel || "") === dab);
  return m ? m.name : "";
}

/** Cells of an editable row (both lists); extra = cells added at the end. */
/** Frequency cell of an editable row: the frequency, or for the mode DAB a dropdown of the DAB channels. */
function medFreqCell(r) {
  if (r.mode !== "DAB") return `<input data-f="freq" class="mono" value="${escHtml(r.freq)}">`;
  const known = dabChannelList.some(([n]) => n === r.dab);
  return `<select data-f="dab" class="mono">${known ? "" : `<option value="" selected>?</option>`}` +
    dabChannelList.map(([n, hz]) => `<option value="${escHtml(n)}"${n === r.dab ? " selected" : ""} title="${fmtMHz(hz, 3)} MHz">${escHtml(n)}</option>`).join("") + `</select>`;
}

/** The mode of an editable row changed: DAB takes the channel at the frequency (or the tuned one), another mode the
 *  centre of the DAB channel as its frequency; DAB and DSD get their fixed width. */
function medRowModeChanged(r, fallback = true) {
  if (r.mode === "DAB") {
    if (!dabChannelList.some(([n]) => n === r.dab)) {
      const hz = parseFreq(r.freq);
      const near = hz ? dabChannelList.find(([, c]) => Math.abs(c - hz) <= 10000) : null;
      r.dab = near ? near[0] : fallback ? (st && st.dab_channel) || (dabChannelList[0] || [])[0] || "" : "";
    }
  } else if (r.dab) {
    const hz = (dabChannelList.find(([n]) => n === r.dab) || [])[1];
    if (hz) r.freq = fmtMHz(hz, 6);
    r.dab = "";
  }
  if (MEM_FIXED_BW[r.mode]) r.bw = kHzText(MEM_FIXED_BW[r.mode]);
  else if (Object.values(MEM_FIXED_BW).map(kHzText).includes(String(r.bw)) && st && st.bandwidth && st.bandwidth[r.mode]) {
    r.bw = kHzText(st.bandwidth[r.mode]);   // the fixed width of DAB / DSD left: the width of the VFO in that mode
  }
}

function medEditCells(r, i, extra = "") {
  return `<tr data-i="${i}" class="${r.sel ? "sel" : ""}${r.err ? " bad" : ""}"><td><input type="checkbox" data-f="sel" ${r.sel ? "checked" : ""}></td>` +
    `<td><input data-f="name" value="${escHtml(r.name)}" maxlength="80"></td>` +
    `<td data-freqcell>${medFreqCell(r)}</td>` +
    `<td><select data-f="mode">${MEM_MODES.map((x) => `<option${x === r.mode ? " selected" : ""}>${x}</option>`).join("")}` +
    `${MEM_MODES.includes(r.mode) ? "" : `<option selected value="${escHtml(r.mode)}">${escHtml(r.mode) || "?"}</option>`}</select></td>` +
    `<td><input data-f="bw" class="mono short" value="${escHtml(r.bw)}"></td>` +
    `<td><select data-f="decoder">${Object.entries(DECODER_NAMES).map(([k, v]) => `<option value="${k}"${k === r.decoder ? " selected" : ""}>${v}</option>`).join("")}</select></td>` +
    `<td><select data-f="record">${Object.entries(RECORD_NAMES).map(([k, v]) => `<option value="${k}"${k === r.record ? " selected" : ""}>${v}</option>`).join("")}${r.record in RECORD_NAMES ? "" : `<option selected value="${escHtml(r.record)}">${escHtml(r.record) || "?"}</option>`}</select></td>` +
    `<td><input data-f="groups" value="${escHtml(r.groups)}" title="Several groups: A | B"></td>` +
    `<td><input data-f="note" value="${escHtml(r.note)}" maxlength="200"></td>` + extra + `</tr>`;
}

const MED_EDIT_HEAD = `<th class="c-name">Name</th><th class="c-freq">Frequency, MHz</th><th class="c-mode">Mode</th><th class="c-bw">BW, kHz</th>` +
  `<th class="c-dec">Decoder</th><th class="c-rec">Rec</th><th class="c-groups">Groups (A | B)</th><th class="c-note">Note</th>`;

// Columns of the tables have fixed widths: a text that does not fit is cut, its whole value is the tooltip.
document.addEventListener("mouseover", (e) => {
  const el = e.target;
  if (el.matches?.(".med-table input:not([type=checkbox]), .med-table select")) {
    const v = el.tagName === "SELECT" ? el.selectedOptions[0]?.textContent || "" : el.value;
    el.title = el.dataset.f === "groups" ? `${v}\nSeveral groups: A | B` : v;
  }
});

/** Typing in an editable list changes its row (without drawing the list again, so the focus stays). */
function medBindEditList(table, list, after) {
  const onEdit = (e) => {
    const tr = e.target.closest("tr[data-i]");
    const f = e.target.dataset.f;
    if (!tr || !f) return;
    const r = list()[Number(tr.dataset.i)];
    r[f] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    if (f !== "sel") r.err = "";
    tr.classList.toggle("sel", !!r.sel);
    tr.classList.remove("bad");
    if (f === "mode") {   // DAB: a DAB channel instead of the frequency
      medRowModeChanged(r);
      tr.querySelector("[data-freqcell]").innerHTML = medFreqCell(r);
      tr.querySelector("[data-f=bw]").value = r.bw;
    }
    after(r, tr, f);
  };
  table.addEventListener("input", onEdit);
  table.addEventListener("change", onEdit);
}

// ----- IMPORT -----

function renderMedImport() {
  const rows = medImp.rows;
  const dupCount = rows.filter((r) => medRowDup(r)).length;
  $("medImpGroups").hidden = !medImp.groups.length;
  $("medImpGroups").innerHTML = `<b>Groups in the file</b> (their notes are imported with the channels):` + medImp.groups.map((g, i) =>
    `<label class="chip-check" data-gi="${i}"><input type="checkbox" data-gf="sel" ${g.sel ? "checked" : ""}> ${escHtml(g.name)}` +
    `<input data-gf="note" value="${escHtml(g.note)}" placeholder="note" maxlength="200"></label>`).join("");
  let html = `<thead><tr><th class="c-chk"><input type="checkbox" data-selall ${rows.length && rows.every((r) => r.sel) ? "checked" : ""}></th>${MED_EDIT_HEAD}<th class="c-status">Status</th></tr></thead><tbody>`;
  rows.forEach((r, i) => {
    const dup = medRowDup(r);
    html += medEditCells(r, i, `<td class="status" data-status>${medImpStatus(r, dup)}</td>`);
  });
  if (!rows.length) html += `<tr><td colspan="10" class="mem-empty">Load an SDR# folder or a file (JSON, CSV, frequencies.xml).</td></tr>`;
  $("medImpTable").innerHTML = html + "</tbody>";
  medImpCount(dupCount);
}

function medImpStatus(r, dup) {
  return r.err ? `<span class="error">✕ ${escHtml(r.err)}</span>` : dup ? `<span class="warn" title="Already in the memories">⧉ ${escHtml(dup)}</span>` : `<span class="ok">new</span>`;
}

function medImpCount(dupCount) {
  const n = medImp.rows.filter((r) => r.sel).length;
  $("medImpSelCount").textContent = medImp.rows.length ? `${n} of ${medImp.rows.length} selected` +
    (dupCount ? `, ${dupCount} already in the memories` : "") : "";
  $("medImpGo").disabled = !n;
  $("medImpGo").textContent = n ? `IMPORT ${n} SELECTED` : "IMPORT SELECTED";
}

medBindEditList($("medImpTable"), () => medImp.rows, (r, tr) => {
  tr.querySelector("[data-status]").innerHTML = medImpStatus(r, medRowDup(r));
  medImpCount(medImp.rows.filter((x) => medRowDup(x)).length);
});
$("medImpTable").addEventListener("click", (e) => {
  if (!e.target.closest("[data-selall]")) return;
  for (const r of medImp.rows) r.sel = e.target.checked;
  renderMedImport();
});
$("medImpGroups").addEventListener("input", (e) => {
  const g = medImp.groups[Number(e.target.closest("[data-gi]")?.dataset.gi)];
  if (!g) return;
  if (e.target.dataset.gf === "sel") g.sel = e.target.checked; else g.note = e.target.value;
});

function medImpLoaded(data, source, quiet = false) {
  const rows = data.entries.map((e) => medRow(e));
  for (const r of rows) r.sel = !r.err;
  medImp.rows.push(...rows);
  for (const g of data.groups || []) if (!medImp.groups.some((x) => x.name === g.name)) medImp.groups.push({ ...g, sel: true });
  const bad = rows.filter((r) => r.err).length;
  if (quiet) { renderMedImport(); return `${source}: ${rows.length}${bad ? ` (${bad} with an error)` : ""}`; }
  medMsg(`Loaded ${rows.length} channels from ${source}${bad ? `, ${bad} with an error (not selected)` : ""}. Nothing is saved until IMPORT.`, false);
  renderMedImport();
}

$("medImpFile").addEventListener("click", () => $("medImpInput").click());
// The server recognises the format by the content (memories.parse_any); several files are loaded one after another.
$("medImpInput").addEventListener("change", async () => {
  const files = [...$("medImpInput").files];
  $("medImpInput").value = "";
  const done = [], failed = [];
  for (const file of files) {
    const r = await memApi("/api/memories/preview", { format: "auto", text: await file.text(), filename: file.name });
    if (!r.ok) { failed.push(`${file.name}: ${r.error}`); continue; }
    if (files.length === 1) { medImpLoaded(r.data, `${file.name} (${r.data.format})`); return; }
    done.push(medImpLoaded(r.data, `${file.name} (${r.data.format})`, true));
  }
  medMsg([done.length ? `Loaded ${done.join(", ")}. Nothing is saved until IMPORT.` : "", ...failed].filter(Boolean).join(" · "),
    failed.length > 0);
});

$("medImpTable").closest(".med-panel").querySelector(".med-bulk").addEventListener("click", (e) => {
  const act = e.target.closest("[data-imp]")?.dataset.imp;
  if (!act) return;
  const rows = medImp.rows;
  if (act === "all") for (const r of rows) r.sel = true;
  if (act === "none") for (const r of rows) r.sel = false;
  if (act === "nodup") for (const r of rows) r.sel = !r.err && !medRowDup(r);
  if (act === "group") {
    const g = $("medImpGroup").value.trim();
    if (!g) { $("medImpGroup").focus(); return; }
    for (const r of rows) if (r.sel) r.groups = g;
  }
  if (act === "clear" && (!rows.length || confirm("Empty the import list?"))) { medImp.rows = []; medImp.groups = []; medMsg(""); }
  renderMedImport();
});

$("medImpGo").addEventListener("click", async () => {
  const chosen = medImp.rows.filter((r) => r.sel);
  const entries = [];
  let bad = 0;
  for (const r of chosen) {
    try { entries.push(medRowEntry(r)); } catch (e) { r.err = e.message; bad++; }
  }
  if (bad) { renderMedImport(); medMsg(`${bad} selected channel${bad === 1 ? " has" : "s have"} an error: correct ${bad === 1 ? "it" : "them"} or untick ${bad === 1 ? "it" : "them"}.`, true); return; }
  const r = await memApi("/api/memories/import_entries", { entries, groups: medImp.groups.filter((g) => g.sel).map(({ name, note }) => ({ name, note })) });
  if (!r.ok) { medMsg(r.error, true); return; }
  medImp.rows = medImp.rows.filter((x) => !x.sel);
  if (!medImp.rows.length) medImp.groups = [];
  medMsg(`Imported ${r.data.added.length} channels.${medImp.rows.length ? ` ${medImp.rows.length} left in the list.` : ""}`);
  await memChanged();
});

// ----- EXPORT -----

function medExportAdd(list) {
  const have = new Set(medExp.rows.map((r) => r.src));
  for (const m of list) {
    if (have.has(m.id)) continue;
    medExp.rows.push({ ...medRow(m), src: m.id, inColor: true, inTag: true, inNote: true, inLoc: true });
    have.add(m.id);
  }
  for (const r of medExp.rows) {
    for (const g of r.groups.split("|").map((x) => x.trim()).filter(Boolean)) {
      if (!medExp.notes[g]) medExp.notes[g] = { note: memGroupNote(g), incl: true };
    }
  }
  medExp.rows.sort((a, b) => (parseFreq(a.freq) || 0) - (parseFreq(b.freq) || 0));
  renderMed();
}

function medExpGroupsUsed() {
  return [...new Set(medExp.rows.filter((r) => r.sel).flatMap((r) => r.groups.split("|").map((x) => x.trim()).filter(Boolean)))]
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

function renderMedExport() {
  medFilterSelect($("medExpGroup"), false);
  const rows = medExp.rows;
  const used = medExpGroupsUsed();
  for (const g of used) if (!medExp.notes[g]) medExp.notes[g] = { note: memGroupNote(g), incl: true };
  $("medExpGroups").hidden = !used.length;
  $("medExpGroups").innerHTML = `<b>Groups in the file</b> — tick to export the note:` + used.map((g) =>
    `<label class="chip-check" data-g="${escHtml(g)}"><input type="checkbox" data-gf="incl" ${medExp.notes[g].incl ? "checked" : ""}> ${escHtml(g)}` +
    `<input data-gf="note" value="${escHtml(medExp.notes[g].note)}" placeholder="note" maxlength="200"></label>`).join("");
  const all = (k) => rows.length && rows.every((r) => r[k]);
  let html = `<thead><tr><th class="c-chk"><input type="checkbox" data-all="sel" ${all("sel") ? "checked" : ""} title="Export all"></th>${MED_EDIT_HEAD}` +
    `<th class="inc c-inc"><label title="Export the tag colour of every channel"><input type="checkbox" data-all="inColor" ${all("inColor") ? "checked" : ""}> colour</label></th>` +
    `<th class="inc c-inc"><label title="Export whether the tag is shown"><input type="checkbox" data-all="inTag" ${all("inTag") ? "checked" : ""}> tag</label></th>` +
    `<th class="inc c-inc"><label title="Export the note of every channel"><input type="checkbox" data-all="inNote" ${all("inNote") ? "checked" : ""}> note</label></th>` +
    `<th class="inc c-incloc"><label title="Export the location (LAT / LON) of every channel"><input type="checkbox" data-all="inLoc" ${all("inLoc") ? "checked" : ""}> LAT/LON</label></th>` +
    `<th class="c-del"></th></tr></thead><tbody>`;
  rows.forEach((r, i) => {
    html += medEditCells(r, i,
      `<td class="inc"><label><input type="checkbox" data-f="inColor" ${r.inColor ? "checked" : ""}><span class="swatch" style="--c:${r.color || MEM_COLOR}"></span></label></td>` +
      `<td class="inc"><label><input type="checkbox" data-f="inTag" ${r.inTag ? "checked" : ""}> ${r.tag ? "on" : "off"}</label></td>` +
      `<td class="inc"><input type="checkbox" data-f="inNote" ${r.inNote ? "checked" : ""}></td>` +
      `<td class="inc" title="${escHtml(String(r.lat ?? "") && `${r.lat}, ${r.lon}`)}"><label><input type="checkbox" data-f="inLoc" ${r.inLoc ? "checked" : ""}> ${String(r.lat ?? "") !== "" ? "✓" : "—"}</label></td>` +
      `<td><button class="key small" data-del title="Remove from the list">×</button></td>`);
  });
  if (!rows.length) html += `<tr><td colspan="14" class="mem-empty">Add groups, the starred channels or all of them above, or tick channels in CHANNELS and press ⇩ TO EXPORT.</td></tr>`;
  $("medExpTable").innerHTML = html + "</tbody>";
  medExpCountNote();
}

function medExpCountNote() {
  const n = medExp.rows.filter((r) => r.sel).length;
  $("medExpGo").disabled = !n;
  $("medExpGo").textContent = n ? `⇩ DOWNLOAD ${n}` : "⇩ DOWNLOAD";
  $("medExpCount").textContent = medExp.rows.length ? `(${medExp.rows.length})` : "";
}

medBindEditList($("medExpTable"), () => medExp.rows, (r, tr, f) => {
  if (f === "groups" || f === "sel") { renderMedExportGroupsOnly(); }
  medExpCountNote();
});
function renderMedExportGroupsOnly() {
  // the group notes above the list follow the groups of the ticked rows; the rows themselves are not redrawn
  const used = medExpGroupsUsed();
  for (const g of used) if (!medExp.notes[g]) medExp.notes[g] = { note: memGroupNote(g), incl: true };
  $("medExpGroups").hidden = !used.length;
  $("medExpGroups").innerHTML = `<b>Groups in the file</b> — tick to export the note:` + used.map((g) =>
    `<label class="chip-check" data-g="${escHtml(g)}"><input type="checkbox" data-gf="incl" ${medExp.notes[g].incl ? "checked" : ""}> ${escHtml(g)}` +
    `<input data-gf="note" value="${escHtml(medExp.notes[g].note)}" placeholder="note" maxlength="200"></label>`).join("");
}
$("medExpTable").addEventListener("click", (e) => {
  const all = e.target.closest("[data-all]");
  if (all) { for (const r of medExp.rows) r[all.dataset.all] = all.checked; renderMedExport(); return; }
  if (e.target.closest("[data-del]")) {
    medExp.rows.splice(Number(e.target.closest("tr[data-i]").dataset.i), 1);
    renderMedExport();
  }
});
$("medExpGroups").addEventListener("input", (e) => {
  const g = medExp.notes[e.target.closest("[data-g]")?.dataset.g];
  if (!g) return;
  if (e.target.dataset.gf === "incl") g.incl = e.target.checked; else g.note = e.target.value;
});
$("medExpAddGroup").addEventListener("click", () => {
  const g = $("medExpGroup").value;
  if (g) medExportAdd(mems.filter((m) => memGroupsOf(m).includes(g)));
});
$("medExpAddFav").addEventListener("click", () => medExportAdd(mems.filter((m) => m.fav)));
$("medExpAddAll").addEventListener("click", () => medExportAdd(mems));
$("medExpClear").addEventListener("click", () => { medExp.rows = []; medExp.notes = {}; renderMed(); });

function csvCell(v) {
  const s = String(v ?? "");
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

$("medExpGo").addEventListener("click", () => {
  const out = [];
  let bad = 0;
  for (const r of medExp.rows) {
    if (!r.sel) continue;
    try {
      const e = medRowEntry(r);
      if (!r.inColor) delete e.color;
      if (!r.inTag) delete e.tag;
      if (!r.inNote) delete e.note;
      if (!r.inLoc) { delete e.lat; delete e.lon; }
      e.group = e.groups[0] || "";
      out.push(e);
    } catch (err) { r.err = err.message; bad++; }
  }
  if (bad) { renderMedExport(); medMsg(`${bad} channel${bad === 1 ? " has" : "s have"} an error (marked red): correct or untick.`, true); return; }
  const fmt = $("medExpFormat").value;
  const name = ($("medExpName").value.trim() || "radimcom-memories").replace(/[^\w.-]+/g, "_");
  let blob;
  if (fmt === "csv") {
    const cols = ["name", "frequency_hz", "mode", "bandwidth_hz", "groups", "decoder", "record", "dab_channel", "favourite", "note", "color", "show_tag", "lat", "lon"];
    const lines = [cols.join(";")].concat(out.map((e) => [e.name, e.freq_hz ?? "", e.mode, e.bw, e.groups.join("|"), e.decoder, e.record,
      e.dab_channel || "", e.fav ? 1 : 0, e.note ?? "", e.color ?? "", e.tag === undefined ? "" : e.tag ? 1 : 0, e.lat ?? "", e.lon ?? ""].map(csvCell).join(";")));
    blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv" });   // BOM: Excel reads it as UTF-8
  } else {
    const groups = [...new Set(out.flatMap((e) => e.groups))].sort().map((g) =>
      (medExp.notes[g] && medExp.notes[g].incl && medExp.notes[g].note ? { name: g, note: medExp.notes[g].note } : { name: g }));
    blob = new Blob([JSON.stringify({ format: "radimcom-memories", version: 2, groups, memories: out }, null, 1)], { type: "application/json" });
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.${fmt}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  medMsg(`Exported ${out.length} channels to ${name}.${fmt}${fmt === "csv" ? " (group notes go only into JSON)" : ""}.`);
});


// ---------- stav zo servera ----------

let sampleRates = [];

function onStatus(s) {
  const first = !st;
  const rateChanged = st && st.audio_rate !== s.audio_rate;
  // Shortly after a local change, do not let an older state from the server overwrite tuning and selection.
  if (st && Date.now() - localChangeAt < 700) {
    for (const k of ["tune_hz", "mode", "bandwidth", "zoom", "gain", "rtl_agc", "smart_agc", "dc_remove", "dc_hz", "dc_db", "spur_on", "spur_hz", "spur_edge", "spur_shift", "spur_db", "spur_learning", "stereo_on", "notch", "autotune", "ft8", "wefax", "cw", "rtty", "sstv", "packet", "hfdl", "ais", "adsb", "acars", "cpdlc", "dab", "dab_channel", "dab_sids", "logs", "upconv", "device", "squelch_levels", "auto_sql", "auto_sql_on", "auto_sql_level", "ctcss", "ctcss_hz", "dcs", "dcs_code"]) s[k] = st[k];
  }
  s.sample_rates = sampleRates;
  st = s;
  renderRec();
  renderScanNow();
  renderStatusPill();
  renderSpurInfo();
  meterTarget = s.smeter;
  $("smeterText").innerHTML = `<b>${sReading(s.smeter)}</b> · <span>${s.smeter.toFixed(1)} dBFS</span>`;
  renderTuner();
  drawOverlays();
  renderSqlBadge();
  renderRds();
  $("ft8On").checked = s.ft8;
  renderFt8Info();
  $("wefaxOn").checked = s.wefax;
  $("wefaxCard").hidden = !s.wefax;
  $("cwOn").checked = s.cw;
  $("cwCard").hidden = !s.cw;
  $("rttyOn").checked = !!s.rtty;
  $("rttyCard").hidden = !s.rtty;
  $("packetOn").checked = !!s.packet;
  $("packetCard").hidden = !s.packet;
  renderHfdl(s);
  renderAis(s);
  renderAdsb(s);
  renderLogs(s.logs);
  $("sstvOn").checked = !!s.sstv;
  $("sstvCard").hidden = !s.sstv;
  $("acarsOn").checked = !!s.acars;
  $("vdl2On").checked = !!s.vdl2;
  // VDL2 runs on RTL-SDR only: greyed out on a LimeSDR or Airspy VFO
  const noVdl2 = noRtlDongle(s) || !!s.chain_owner;   // a chained VFO cannot set its own centre and sample rate
  $("vdl2On").disabled = noVdl2;
  $("vdl2On").parentElement.classList.toggle("disabled", noVdl2);
  $("vdl2On").parentElement.title = s.chain_owner ? `VDL2 needs its own dongle (this VFO shares the dongle of VFO ${s.chain_owner})`
    : noRtlDongle(s) ? `VDL2 is not supported on ${DEVICE_NAMES[s.driver]} (RTL-SDR only)` : VDL2_TITLE;
  $("acarsCard").hidden = !(s.acars || s.vdl2);
  renderVdl2Info({ enabled: s.vdl2, error: s.vdl2_error });
  renderVdl2Region();
  renderDab(s);
  renderIsm(s);
  renderDsd(s);
  renderLinkBands();
  renderDecTab();
  guessBodyTab();
  markActiveMem();
  if (first) {
    renderControls();
    renderSettings();
  } else if (Date.now() - localChangeAt >= 700) {
    renderControls();
    if (document.activeElement !== $("gainSlider")) renderGain();
  }
  if (rateChanged && audio) { stopAudio(); startAudio(); }
}

// ---------- VFO A/B/C ----------
// Each VFO is a separate receiver (own dongle and port). Events are received from all of them:
// for the inactive ones the state (VFO bar) and waterfall rows are kept, so the history is visible after a switch.

const VFO_ROWS_MAX = 1400;

function connectEvents(v) {
  const es = new EventSource(v.base + "/api/events");
  const on = (kind, fn) => es.addEventListener(kind, (e) => { if (v === active) fn(JSON.parse(e.data)); });
  es.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    // Inactive VFO retuned by the wheel: an older state from the server must not turn the display back.
    if (v.localTune && Date.now() - v.localAt < 700) s.tune_hz = v.localTune;
    if (v.localGain != null && Date.now() - v.localGainAt < 700) s.gain = v.localGain;
    if (v.localSql && Date.now() - v.localSqlAt < 700) s.squelch_levels = v.localSql;
    v.st = s;
    v.online = true;
    if (v === active) onStatus(s);
    renderVfoDisplays();
  });
  es.addEventListener("wf", (e) => {
    const ev = JSON.parse(e.data);
    v.rows.push(ev);
    if (v.rows.length > VFO_ROWS_MAX) v.rows.splice(0, v.rows.length - VFO_ROWS_MAX);
    if (v === active && !MAP_ONLY) onRow(ev.c, ev.span, ev.row, false, wfFullOf(ev));
  });
  on("meter", (d) => { meterTarget = d.db; });
  on("memories", () => memChanged());
  on("ft8", (d) => {
    addFt8(d, true);
    renderFt8Info(`cycle ${ft8Cycle} · ${ft8Count} messages`);
  });
  on("wefaxnew", (d) => wefaxReset(d.id, d.width));
  on("wefaxrow", (d) => { if (d.id === wfx.id) wefaxAddRow(d.row); });
  on("wefaxtrim", (d) => { if (d.id === wfx.id) wefaxTrim(d.rows); });
  on("wefaxreload", (d) => { if (d.id === wfx.id) wefaxLoadImage(); });
  on("wefaxstate", renderWefaxInfo);
  on("sstvnew", (d) => sstvReset(d.id, d.width, d.height));
  on("sstvrow", (d) => { if (d.id === sstvImg.id) sstvAddRow(d.y, d.row); });
  on("sstvdone", (d) => { if (d.id === sstvImg.id) sstvReload(); });
  on("sstvstate", renderSstvInfo);
  on("cwtext", (d) => { cwAppend(d.t); if (st && st.cw) cwBubbleAdd(d.t); });
  on("cwpeek", (d) => { if (st && !st.cw) cwBubbleAdd(d.t); });
  on("cwstate", renderCwInfo);
  on("rttytext", (d) => rttyOut.add(d.t));
  on("rttystate", renderRttyInfo);
  on("packet", (m) => { addPacket(m); decActivity("packet"); });
  on("packetstate", renderPacketInfo);
  on("packeteye", drawPktEye);
  on("packetspec", drawPktSpec);
  on("dsdcall", (c) => { addDsdCall(c); if (bodyTab !== "dsd") $("dsdTabDot").hidden = false; });
  on("acars", (m) => { acarsReceive(m); decActivity(st && st.vdl2 ? "vdl2" : "acars"); });
  on("cpdlc", (c) => { if (c.imi === "ATN") { addAtn(c, true); decActivity("vdl2"); } });   // others come inside "acars"
  on("ft8", () => decActivity("ft8"));
  on("cwtext", () => decActivity("cw"));
  on("rttytext", () => decActivity("rtty"));
  on("wefaxnew", () => decActivity("wefax"));
  on("sstvnew", () => decActivity("sstv"));
  on("acarsstate", renderAcarsInfo);
  on("vdl2state", renderVdl2Info);
  on("dabstate", (d) => { if (st) renderDabInfo(d); });
  on("ism", (m) => { addIsm(m); if (m.n === 1) decActivity("ism"); });
  on("ismstate", (d) => { if (st) renderIsmInfo(d); });
  on("hfdl", (m) => { addHfdl(m); decActivity("hfdl"); });
  on("hfdlstate", (d) => { if (st) renderHfdlInfo(d); });
  on("hfdlinfo", onHfdlInfo);
  on("ais", (m) => { addAis(m); decActivity("ais"); });
  on("aisstate", (d) => { if (st) renderAisInfo(d); });
  on("adsb", (d) => { onAdsb(d); if (d.msgs && d.msgs.length) decActivity("adsb"); });
  on("adsbstate", (d) => { if (st) renderAdsbInfo(d); });
  on("acarsinfo", onAcarsInfo);
  on("acarspos", acarsPosUpdate);
  on("ft8cycle", (d) => renderFt8Info(`cycle ${d.time} · decoding…`));
  es.onerror = () => {
    v.online = false;
    renderVfoDisplays();
    if (v === active) renderStatusPill();
  };
}

// USB symbol (trident): circle, arrow, upper branch with a ring, lower one with a square.
const USB_ICON = `<svg class="usb-icon" viewBox="0 0 690 440" aria-label="running"><g fill="currentColor">` +
  `<circle cx="78" cy="222" r="76"/><path d="M560 146 L690 222 L560 298 Z"/><circle cx="414" cy="56" r="52"/>` +
  `<rect x="430" y="322" width="118" height="118" rx="10"/></g><g fill="none" stroke="currentColor" stroke-width="38">` +
  `<path d="M140 222 H580"/><path d="M200 222 C250 160 250 56 370 56"/><path d="M290 222 C340 280 330 381 440 381"/></g></svg>`;

// Annunciators of a VFO window: lit like LCD segments when on, dark when off or not used in the current mode.
// [class, text, tooltip]; the order is fixed, so nothing moves. SAT = Doppler correction from satellite tracking.
const SAT_ANN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.6 7C3.2 12.6 8.4 18.8 15 17.4Z"/><path d="M9.8 12.2L13.4 8.6"/>` +
  `<circle cx="14.6" cy="7.4" r="1.6"/><path d="M16.6 3.1A5 5 0 0 1 19 5.5"/><path d="M7.6 15.4L5.8 20.6M11 17.2L12.4 20.6M3.2 21.2H15"/></svg>`;
const VFO_ANNS = [
  ["agc", "AGC<i>+</i>", "AGC: automatic tuner gain · AGC+: highest gain without A/D clipping"],
  ["nf", "NF", "NF: automatic notch filter (AM/LSB/USB)"],
  ["sp", "SP", "SP: spur removal"],
  ["alc", "ALC", "ALC: automatic audio level (AM/LSB/USB/CW)"],
  ["afi", "AFI", "AFI: audio frequency inversion"],
  ["asq", "ASQ", "ASQ: auto squelch (AM/FM/WFM)"],
  ["atu", "ATU", "ATU: autotune (USB/LSB/AM)"],
  ["sat", SAT_ANN_ICON, "SAT: frequency corrected for Doppler by satellite tracking"],
];
const vfoAnnsHtml = (mode = "") => `<div class="vfo-anns"><span class="ann vfo-mode">${mode}</span>` +
  VFO_ANNS.map(([c, t, tip]) => `<span class="ann ${c}" title="${tip}">${t}</span>`).join("") +
  `<span class="gap"></span><span class="ann vfo-cue" role="button">CUE</span></div>`;
/** Lights the annunciators of one VFO window from its state s. */
function renderVfoAnns(row, s) {
  const a = (c) => row.querySelector(`.vfo-anns .${c}`);
  const auto = s.gain === "auto", smart = !!s.smart_agc && !auto;
  const agc = a("agc");
  agc.classList.toggle("on", auto || smart);
  agc.classList.toggle("plus", smart);   // the + is always there, lit only with AGC+
  agc.classList.toggle("clip", smart && !!s.adc_clip);
  a("nf").classList.toggle("on", ["AM", "LSB", "USB"].includes(s.mode) && !!s.notch);
  a("sp").classList.toggle("on", !!s.spur_on);
  a("alc").classList.toggle("on", ["AM", "LSB", "USB", "CW"].includes(s.mode) && s.audio_agc !== false);
  a("afi").classList.toggle("on", s.mode !== "WFM" && s.mode !== "DSD" && !!s.afi);
  a("asq").classList.toggle("on", ["AM", "FM", "WFM"].includes(s.mode) && !!s.auto_sql_on);
  a("atu").classList.toggle("on", ATU_MODES.includes(s.mode) && !!s.autotune);
  a("sat").classList.toggle("on", !!s.trsp_name);
}
// Info row under the frequency (was the flags beside the S-meter): RX/TX, filter width, audio HPF and LPF with their
// cutoffs, stereo pilot, squelch and the upconverter switch. Every item has a fixed width, so no text moves.
const PASS_ICON = {
  hpf: `<svg class="inf-ico" viewBox="60 180 680 440" aria-hidden="true"><path d="M100 576H150Q190 576 215 535L390 265Q415 228 460 228H695"/></svg>`,
  lpf: `<svg class="inf-ico" viewBox="60 180 680 440" aria-hidden="true"><path d="M100 228H340Q390 228 415 270L580 540Q610 576 650 576H695"/></svg>`,
};
// Tone squelch row under the frequency: the set CTCSS tone and DCS code, dark (as an unlit annunciator) = off, orange = on (FM), glowing = received.
const vfoToneHtml = () => `<div class="vfo-tone"><span class="ann tsq ctcss">CTCSS<b></b></span>` +
  `<span class="ann tsq dcs">DCS<b></b></span></div>`;
function renderVfoTone(row, s) {
  const fm = s.mode === "FM";
  for (const [c, on, val, name] of [["ctcss", s.ctcss, ctcssText(ctcssHz(s)), "TSQ-C: CTCSS tone squelch"],
    ["dcs", s.dcs, dcsCode(s), "TSQ-D: DCS code squelch"]]) {
    const el = row.querySelector(`.vfo-tone .${c}`);
    if (!el) continue;
    const act = fm && !!on;
    el.classList.toggle("act", act);
    el.classList.toggle("rx", act && !!s.tone_match);
    const b = el.querySelector("b");
    if (b.textContent !== val) b.textContent = val;
    el.title = `${name} ${val}${c === "ctcss" ? " Hz" : ""}: ` + (!on ? "off" : !fm ? "on, works only in FM"
      : s.tone_match ? "received now" : "not received");
  }
}
const vfoInfoHtml = () => `<div class="vfo-info">` +
  `<span class="ann rx" title="RX / TX (hold SPACE to transmit: PTT, only with the LimeSDR VFO selected)">RX</span>` +
  `<span class="ann bw" title="Filter width"></span>` +
  `<span class="ann hpf">${PASS_ICON.hpf}<b></b></span><span class="ann lpf">${PASS_ICON.lpf}<b></b></span>` +
  `<span class="ann st" title="Stereo: 19 kHz pilot detected (WFM)"><svg class="st-icon" viewBox="0 0 30 20" aria-hidden="true">` +
  `<circle cx="10.5" cy="10" r="8.6"/><circle cx="19.5" cy="10" r="8.6"/></svg>ST</span>` +
  `<span class="ann sql">SQL</span><span class="ann conv" title="Required position of the upconverter switch">CONV</span></div>`;
/** Fills the info row of one VFO window from its state s. */
function renderVfoInfo(row, s) {
  const a = (c) => row.querySelector(`.vfo-info .${c}`);
  if (!a("bw")) return;
  a("bw").textContent = fmtBw(s.bandwidth?.[s.mode] ?? 0);
  for (const kind of ["hpf", "lpf"]) {
    const hz = s[kind + "_hz"] ?? PASS[kind].def, on = !s.dab && !!s[kind];
    a(kind).classList.toggle("on", on);
    a(kind).querySelector("b").textContent = passText(hz);
    a(kind).title = `${PASS[kind].text} ${hz} Hz: ${on ? "on" : "off"}`;
  }
  // ST: lit while stereo is decoded (pilot + S/M on), grey in WFM without a pilot or with S/M off, dark in other modes
  const wfm = s.mode === "WFM";
  a("st").classList.toggle("on", wfm && !!s.stereo);
  a("st").classList.toggle("set", wfm && !s.stereo);
  a("st").title = !wfm ? "Stereo (WFM only)" : s.stereo ? "Stereo: 19 kHz pilot, L−R decoded"
    : s.pilot ? "Mono: 19 kHz pilot present, stereo switched off (S/M)" : "Mono: no 19 kHz pilot";
  // SQL: lit while the squelch is open, grey while closed, dark without squelch
  const levels = s.squelch_levels || {};
  const sqOk = s.mode in levels;
  const lvl = !sqOk ? SQUELCH_OFF : s.auto_sql_on ? (s.auto_sql_level ?? SQUELCH_OFF) : levels[s.mode];
  const sqOn = sqOk && lvl > SQUELCH_OFF;
  const sql = a("sql");
  sql.classList.toggle("on", sqOn && !!s.squelch_open);
  sql.classList.toggle("set", sqOn && !s.squelch_open);
  sql.title = sqOn ? `Squelch ${lvl} dBFS: ${s.squelch_open ? "open" : "closed"}` : "Squelch off";
  // upconverter in Auto mode: CONV below 30 MHz, BYPASS (amber) above
  const conv = a("conv"), has = s.upconv === "auto" && s.lo_offset_hz > 0, need = s.tune_hz < 30e6;
  conv.textContent = has && !need ? "BYPASS" : "CONV";
  conv.classList.toggle("on", has && need);
  conv.classList.toggle("warn", has && !need);
}

/** Keys under the VFO windows, a pair for each window (also the free ones, disabled): the VFO key (the active one lit)
 *  and beside it CUE of that VFO (lit = it stays audible at CUE level while another VFO is selected). */
function renderVfoKeys() {
  const box = $("vfoKeys");
  if (!box) return;
  const rows = [...$("vfoList").querySelectorAll(".vfo-row")].filter((r) => r.querySelector(".vfo-key"));
  if (box.children.length !== rows.length) box.innerHTML = rows.map(() =>
    `<div class="vfo-pair"><button class="key vfo-sel"></button><button class="key vfo-cuekey">CUE</button></div>`).join("");
  rows.forEach((r, i) => {
    const pair = box.children[i], b = pair.querySelector(".vfo-sel"), c = pair.querySelector(".vfo-cuekey");
    const name = r.querySelector(".vfo-key").textContent, spare = r.classList.contains("spare");
    const v = vfos.find((x) => String(x.name) === r.dataset.vfo);
    if (b.textContent !== name) b.textContent = name;
    b.dataset.vfo = c.dataset.vfo = r.dataset.vfo;
    b.disabled = c.disabled = spare;
    b.classList.toggle("on", r.classList.contains("active"));
    b.classList.toggle("busy", r.classList.contains("busy"));
    b.classList.toggle("tx", r.classList.contains("tx"));
    b.title = spare ? r.title : `Select ${name.replace("-", " ")}`;
    c.classList.toggle("on", !!(v && v.cue));
    c.title = spare ? r.title : v && v.cue ? `CUE on: ${name.replace("-", " ")} stays audible at CUE level (click to turn off)`
      : `CUE off (click to keep hearing ${name.replace("-", " ")} when another VFO is selected)`;
  });
  renderSetVfoKeys();
}
$("vfoKeys").addEventListener("click", (e) => {
  const b = e.target.closest(".vfo-sel, .vfo-cuekey");
  if (!b || b.disabled) return;
  const v = vfos.find((x) => String(x.name) === b.dataset.vfo);
  if (!v) return;
  if (b.classList.contains("vfo-cuekey")) setCue(v, !v.cue);   // CUE does not switch the VFO
  else selectVfo(v);
});

/** Lit part of an RF / SQL segment bar = position of its value (CSS --p). */
function setBarFill(inp) {
  const lo = Number(inp.min), hi = Number(inp.max);
  inp.style.setProperty("--p", `${hi > lo ? ((Number(inp.value) - lo) / (hi - lo)) * 100 : 0}%`);
}

// With fewer than 4 SDRs the remaining VFO windows stay in place but without function (grey, "NO SDR"),
// so the screen layout is always the same. SDR added -> run setup.bat.
const VFO_SLOTS = 4;
function renderSpareVfos() {
  const used = new Set(vfos.map((v) => v.name));
  const free = [..."ABCDEFGH"].filter((n) => !used.has(n));
  for (let i = vfos.length; i < VFO_SLOTS; i++) {
    const name = free.shift();
    const row = document.createElement("div");
    row.className = "vfo-row spare";
    row.dataset.vfo = "spare";
    row.title = `VFO ${name}: no SDR assigned (connect one and run the SDR setup)`;
    row.innerHTML = `<div class="vfo-top"><button class="vfo-key" disabled>VFO-${name}</button><div class="vfo-memname"></div>` +
      `<div class="vfo-ind"><span class="vfo-stat off">NO SDR</span></div></div>` +
      `<div class="vfo-disp"><div class="freq">${seg7("          ")}<span class="unit">MHz</span></div></div>` +
      vfoInfoHtml() + vfoAnnsHtml("---") +
      `<div class="vfo-foot"><label class="vfo-rf"><span>RF</span>` +
      `<input type="range" min="0" max="1" value="0" disabled></label><span class="vfo-gain">---</span></div>` +
      `<div class="vfo-foot vfo-sqrow"><label class="vfo-rf vfo-sq"><span>SQL</span>` +
      `<input type="range" min="0" max="1" value="0" disabled></label><span class="vfo-sql">---</span></div>`;
    $("vfoList").append(row);
  }
}

/** Frequency displays of all VFOs side by side (fixed order A, B, C) with a button to switch.
 *  A standalone receiver without VFOs has a single display without the button. */
function renderVfoDisplays() {
  const list = $("vfoList");
  for (const v of vfos) {
    let row = v.row;
    if (!row) {
      row = v.row = document.createElement("div");
      row.className = "vfo-row";
      row.dataset.vfo = String(v.name);
      // on top the name of the memory on this frequency or the band plan, above the display the receiver state, VFO button, mode and CUE; under the display the RF GAIN slider and the gain value
      // one dark window: VFO-x, name and state on top, the frequency, the annunciators, RF and SQL bars
      row.innerHTML = `<div class="vfo-top">` + (v.name ? `<button class="vfo-key">VFO-${v.name}</button>` : "<span></span>") +
        `<div class="vfo-memname"></div><div class="vfo-ind"><span class="rec-tag"></span>` +
        `<span class="mute-tag" title="Audio muted while the ACARS, VDL2, HFDL or ISM decoder runs" hidden></span>` +
        (v.name ? `<span class="vfo-stat"></span>` : "") + `</div></div>` +
        `<div class="vfo-disp"><div class="freq"></div></div>` +
        (v.name ? vfoToneHtml() + vfoInfoHtml() + vfoAnnsHtml() + `<div class="vfo-foot"><label class="vfo-rf"><span>RF</span>` +
        `<input type="range" min="0" max="0" step="1" value="0"></label>` +
        `<span class="vfo-gain" title="RF gain"></span></div>` +
        `<div class="vfo-foot vfo-sqrow"><label class="vfo-rf vfo-sq"><span>SQL</span>` +
        `<input type="range" min="${SQUELCH_OFF}" max="-20" step="1" value="${SQUELCH_OFF}"></label>` +
        `<span class="vfo-sql"></span></div>` : "");
      if (v.name) row.querySelector(".vfo-key").title = `VFO ${v.name} · ` +
        (v.chain ? `dongle of VFO ${v.chain}` : v.serial || "") + (v.note ? " · " + v.note : "");
      list.append(row);
    }
    // The active VFO shows local changes even before the receiver answers.
    const s = v === active ? st || v.st : v.st;
    const isActive = v === active;
    row.classList.toggle("active", isActive);
    row.classList.toggle("offline", !!v.name && !v.online);
    const fr = row.querySelector(".freq");
    fr.title = isActive ? "Click to enter a frequency" : `Switch to VFO ${v.name}`;
    if (s) {
      const { txt, unit } = freqDigits(s.tune_hz);
      if (txt !== v.shown) {
        v.shown = txt;
        fr.innerHTML = seg7(txt) + `<span class="unit">${unit}</span>`;
        fr.setAttribute("aria-label", `${fmtMHz(s.tune_hz, 6)} MHz`);
      }
      // red struck-through speaker in the top row: the audio of this VFO is muted by a decoder
      row.querySelector(".mute-tag").hidden = !s.audio_muted;
      if (v.name) { renderVfoAnns(row, s); renderVfoTone(row, s); renderVfoInfo(row, s); }
      // red dot in the corner of the display: blinks while a file is being written, steady while waiting for the squelch
      const recs = [s.recording?.cont, s.recording?.squelch];
      const recTag = row.querySelector(".rec-tag");
      recTag.classList.toggle("on", recs.some((r) => r?.on) && (!v.name || v.online));
      recTag.classList.toggle("writing", recs.some((r) => r?.on && r.open));
    }
    // Frame on top of the VFO: satellite and transponder of the Doppler correction, otherwise the memory on this frequency, otherwise the band plan (narrowest band).
    const trsp = s && s.trsp_name ? [s.trsp_sat, s.trsp_name].filter(Boolean).join(" · ") : "";
    const mem = s ? memAt(s.tune_hz, s.mode) : null;
    const bands = s && !mem ? bandsAt(s.tune_hz) : [];
    const memEl = row.querySelector(".vfo-memname");
    const memText = trsp || (mem ? mem.name : bands.length ? bands[0][2] : "");
    if (memEl.textContent !== memText) memEl.textContent = memText;
    memEl.classList.toggle("band", !mem && !trsp);
    memEl.classList.toggle("trsp", !!trsp);
    // the memory's own tag colour (memory editor) also colours its name here; the default green stays the CSS green
    const own = !trsp && mem && mem.color ? mem.color : "";
    memEl.classList.toggle("own", !!own);
    if (own) memEl.style.setProperty("--mc", own); else memEl.style.removeProperty("--mc");
    memEl.title = trsp ? `Doppler correction: ${trsp}` : mem ? `${mem.name} · ${memGroupsOf(mem).join(", ")} · ${mem.mode} · ${fmtBw(mem.bw)}${mem.note ? ` · ${mem.note}` : ""}`
      : bands.map(([, , label, , desc]) => `${label}: ${desc}`).join("\n");
    if (!v.name) continue;
    // VFO receiver state: RUNNING = dongle open and delivering samples.
    const stat = row.querySelector(".vfo-stat");
    // Unplugged dongle, error or unreachable VFO server: grey OFFLINE, detail in the tooltip.
    const [stTxt, stCls, stTitle] = !v.online ? (v.st ? ["OFFLINE", "off", "connection to the VFO server lost"] : ["WAIT", "wait", "waiting for receiver"])
      : !s ? ["WAIT", "wait", "waiting for receiver"]
      : s.error ? ["OFFLINE", "off", s.error]
      : s.status === "running" && s.out_of_band ? ["OOR", "wait", `out of range VFO-${s.chain_owner}`]
      : s.status === "running" && s.chain_owner ? ["CHAIN", "chain", `chained to the dongle of VFO ${s.chain_owner}`]
      : s.status === "running" ? ["RUNNING", "", "receiver running"]
      : s.status === "opening dongle" ? ["OPENING", "wait", "opening dongle"]
      : s.status === "calibrating" ? ["CAL", "wait", "LimeSDR calibration"]
      : ["OFFLINE", "off", `receiver ${s.status}`];
    // Connection as a USB icon: green = running, blinking orange = connecting (WAIT / OPENING / CAL),
    // grey = disconnected (OFFLINE); CHAIN and OOR stay as text. Details in the tooltip.
    const connecting = ["WAIT", "OPENING", "CAL"].includes(stTxt);
    const icon = connecting || stTxt === "RUNNING" || stTxt === "OFFLINE";
    const stHtml = icon ? USB_ICON : stTxt;
    if (stat.dataset.html !== stHtml) { stat.innerHTML = stHtml; stat.dataset.html = stHtml; }
    stat.className = `vfo-stat ${stCls}${connecting ? " blink" : ""}`;
    stat.title = `${stTxt}: ${stTitle}`;
    const mode = row.querySelector(".vfo-mode"), gain = row.querySelector(".vfo-gain"), sql = row.querySelector(".vfo-sql");
    // without a state only make it invisible, so the layout does not shift
    mode.style.visibility = gain.style.visibility = sql.style.visibility = s ? "" : "hidden";
    if (s) {
      mode.textContent = s.dab ? "DAB" : s.mode;
      const smart = s.smart_agc && s.gain !== "auto";
      gain.textContent = s.gain === "auto" ? "AGC" : smart ? `+${gainLabel(s)}` : gainLabel(s);
      if (!gain.matches(":hover")) gain.title = smart ? `AGC+ ${gainLabel(s)}, A/D peak ${s.adc_peak} dBFS${s.adc_clip ? ", clipping" : ""}` : "RF gain";
      // slider: disabled with AGC (as in SET); while dragging, the state from the server does not overwrite it
      const rf = row.querySelector(".vfo-rf input");
      const gains = s.gains || [];
      rf.disabled = s.gain === "auto" || smart || !gains.length;
      rf.max = Math.max(gains.length - 1, 0);
      if ((smart || document.activeElement !== rf) && gains.length && s.gain !== "auto") {
        let best = 0;
        gains.forEach((g, i) => { if (Math.abs(g - s.gain) < Math.abs(gains[best] - s.gain)) best = i; });
        rf.value = best;
      }
      setBarFill(rf);
      // manual RF gain (AGC and AGC+ off): the whole RF bar and its dB value red while the A/D clips, held 1 s
      const manual = s.gain !== "auto" && !smart, now = performance.now();
      if (manual && s.adc_clip) row._rfClipAt = now;
      const rfClip = manual && now - (row._rfClipAt ?? -1e9) < 1000;
      gain.closest(".vfo-foot").classList.toggle("clip", rfClip);
      if (manual && !gain.matches(":hover")) gain.title = `RF gain, A/D peak ${s.adc_peak} dBFS${rfClip ? ", CLIPPING – lower the RF gain" : ""}`;
      // squelch only in AM/FM/WFM; in other modes it stays in place but dimmed and inactive
      const levels = s.squelch_levels || {};
      const sqOk = s.mode in levels, set = sqOk ? levels[s.mode] : SQUELCH_OFF;
      const auto = sqOk && !!s.auto_sql_on, lvl = auto ? (s.auto_sql_level ?? SQUELCH_OFF) : set;
      const sq = row.querySelector(".vfo-sq input");
      row.querySelector(".vfo-sqrow").classList.toggle("na", !sqOk);
      sq.disabled = !sqOk || (auto && !!s.auto_sql);
      if (document.activeElement !== sq) sq.value = auto && !s.auto_sql ? set : lvl;
      setBarFill(sq);
      sql.textContent = !sqOk ? "OFF" : auto ? "AUTO" : lvl <= SQUELCH_OFF ? "OFF" : `${lvl} dB`;
      sql.title = !sqOk ? `squelch not available in ${s.mode}` : auto ? `auto squelch ${lvl > SQUELCH_OFF ? `${lvl} dBFS (${sReading(lvl)})` : "(measuring the noise)"}`
        : lvl <= SQUELCH_OFF ? "squelch off" : `squelch ${lvl} dBFS (${sReading(lvl)})`;
    }
    const cue = row.querySelector(".vfo-cue");
    cue.classList.toggle("on", !!v.cue);
    cue.title = v.cue ? `CUE on: VFO ${v.name} stays audible at CUE level (click to turn off)`
      : `CUE off (click to keep hearing VFO ${v.name} when another VFO is selected)`;
    row.classList.toggle("tx", !!(s && s.tx));
    // Squelch open on an inactive VFO: the button lights up to show activity.
    row.classList.toggle("busy", !!(s && !isActive && (s.squelch > SQUELCH_OFF || s.tsq_on) && s.squelch_open));
  }
  renderTx();
  renderVfoKeys();
}

// ---------- vysielanie (PTT) ----------
// PTT = space bar held. Works only when the selected VFO can transmit (LimeSDR);
// with another VFO selected the space bar does nothing. Switching the VFO during PTT ends the transmission.
// While PTT is held, {"ptt": true} is sent every 300 ms; without it the server turns transmitting off itself.
let ptt = null;

function txVfo() { return active && active.online && active.st && active.st.can_tx ? active : null; }

function pttSend(v, on) {
  return fetch(v.base + "/api/tx", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ptt: on }) }).then((r) => r.json()).catch(() => null);
}

function pttDown() {
  if (ptt) return;
  const v = txVfo();
  if (!v) return;
  const me = ptt = { v, timer: setInterval(() => pttSend(v, true), 300) };
  renderTx();
  pttSend(v, true).then((r) => {
    if (r && r.error && ptt === me) { pttUp(); pttError(r.error); }
  });
}

function pttUp() {
  if (!ptt) return;
  clearInterval(ptt.timer);
  pttSend(ptt.v, false);
  ptt = null;
  renderTx();
}

function pttError(msg) {
  adError(`TX: ${msg}`);
}

/** RX / TX in the info row of each VFO window (TX = that VFO transmits, also while PTT is held before the server answers). */
function renderTx() {
  for (const v of vfos) {
    const f = v.row && v.row.querySelector(".vfo-info .rx");
    if (!f) continue;
    const s = v === active ? st || v.st : v.st;
    const on = !!(s && s.tx) || (!!ptt && ptt.v === v);
    f.textContent = on ? "TX" : "RX";
    f.classList.toggle("tx", on);
  }
}

const isSpace = (e) => !MAP_ONLY && e.code === "Space" && !e.target.closest("input, select, textarea");
document.addEventListener("keydown", (e) => {
  if (!isSpace(e)) return;
  e.preventDefault();               // the space bar must not press the focused button or scroll the page
  if (!e.repeat) pttDown();
});
document.addEventListener("keyup", (e) => { if (isSpace(e)) { e.preventDefault(); pttUp(); } });
window.addEventListener("blur", pttUp);
document.addEventListener("visibilitychange", () => { if (document.hidden) pttUp(); });

/** Makes v the active VFO. keepTab: this tab stays open (SETTINGS › VFO keys), instead of the one saved for v. */
async function selectVfo(v, keepTab) {
  if (!v || v === active) return;
  pttUp();
  flushSend();
  stopAudio();
  stopDab();
  active = v;
  vbase = v.base;
  store("vfo", v.name);
  restoreBodyTab(keepTab);
  // Everything shown belongs to the previous VFO: state, waterfall, decoders.
  closeFreqInput();
  st = null; view = null; wfRow = null; spec = null; floor = null; wfFull = null;
  convPrev = null;
  adRotInfo = null; rotorInfo = null; rotorPendingOn = false;
  for (const id of ["modes", "bandwidths", "steps"]) $(id)._html = null;
  $("ft8Rows").innerHTML = ""; $("ft8Empty").hidden = false; ft8Cycle = null; ft8Count = 0;
  cwOut.clear(); rttyOut.clear();
  packetReset();
  acarsResume();
  acarsDropHeld();
  $("acarsRows").innerHTML = ""; $("acarsEmpty").hidden = false; renderAcarsFilter();
  acarsAcClear();
  dsdReset();
  ismReset();
  hfdlReset();
  aisReset();
  adsbReset();
  $("convWarn").hidden = true;
  if (v.st) {
    onStatus(v.st);
    for (const r of v.rows) onRow(r.c, r.span, r.row, true, wfFullOf(r));
    drawSpectrum();
  } else {
    clearWaterfall(wfCanvas.width || 1024);
    renderStatusPill();
  }
  renderVfoDisplays();
  renderCueKey();
  startAudio();
  await loadDecoders();
}

/** Frequency outside the range of the active VFO: switches to a VFO that can receive it. */
async function ensureVfoFor(hz) {
  const fits = (v) => v.st && v.st.range && hz >= v.st.range[0] && hz <= v.st.range[1];
  if (!active || !active.st || fits(active)) return;
  const other = vfos.find((v) => v !== active && fits(v));
  if (other) await selectVfo(other);
}

async function loadDecoders() {
  const v = active;
  await wefaxLoad();
  await sstvLoad();
  await dsdLoad();
  await ismLoad();
  await hfdlLoad();
  await aisLoad();
  await adsbLoad();
  await packetLoad();
  const cwi = await fetch(vbase + "/api/cw").then((r) => r.json());
  if (v !== active) return;
  renderCwInfo(cwi);
  if (cwi.text) cwAppend(cwi.text);
  const rti = await fetch(vbase + "/api/rtty").then((r) => r.json());
  if (v !== active) return;
  renderRttyInfo(rti);
  if (rti.text) rttyOut.add(rti.text);
  const decodes = await fetch(vbase + "/api/ft8").then((r) => r.json());
  if (v !== active) return;
  for (const d of decodes) addFt8(d, false);
  const ac = await fetch(vbase + "/api/acars").then((r) => r.json());
  const cp = await fetch(vbase + "/api/cpdlc").then((r) => r.json());
  if (v !== active) return;
  // ACARS messages and ATN messages (no ACARS around them) in the order they came
  const rows = ac.messages.map((m) => [m.id, () => addAcars(m, false)])
    .concat(cp.messages.filter((c) => c.imi === "ATN").map((c) => [c.id, () => addAtn(c, false)]));
  rows.sort((a, b) => a[0] - b[0]).forEach(([, add]) => add());
  for (const p of (ac.gs_pos || []).concat(ac.positions || [])) acarsPosUpdate(p);
  renderAcarsInfo(ac);
}

// ---------- upconverter switch (VFO with upconverter in Auto mode) ----------
// The upconverter has only a manual switch: crossing 30 MHz needs a clear warning.

let convPrev = null;

function renderConv() {
  // the required switch position is shown in the info row of the VFO window (CONV / BYPASS)
  const has = st.upconv === "auto" && st.lo_offset_hz > 0;
  if (!has) { $("convWarn").hidden = true; return; }
  const needConv = st.tune_hz < 30e6;
  if (convPrev !== null && convPrev !== needConv) {
    $("convWarnText").textContent = needConv
      ? "HF below 30 MHz: switch the upconverter ON"
      : "Above 30 MHz: switch the upconverter to BYPASS";
    $("convWarn").hidden = false;
  }
  convPrev = needConv;
}
$("convWarnOk").addEventListener("click", () => { $("convWarn").hidden = true; });

// ---------- audio ----------

// Audio plays all the time (active VFO); silence is only MUTE. One AudioContext for the whole page:
// the browser keeps it suspended until the user clicks, so it is started on the first click or key press.
// Other VFOs with CUE on play alongside through their own gain node (CUE level).
let audio = null;
let actx = null;
let masterGain = null;
let cueGain = null;
let audioTap = null, audioAnalyser = null;   // audio of the active VFO before the volume, for the audio spectrum bubble

function audioContext() {
  if (!actx) {
    actx = new AudioContext();
    masterGain = actx.createGain();
    masterGain.gain.value = volumeNow();
    masterGain.connect(actx.destination);
    audioTap = actx.createGain();
    audioTap.connect(masterGain);
    audioAnalyser = actx.createAnalyser();
    audioAnalyser.fftSize = 2048;
    audioAnalyser.smoothingTimeConstant = 0.6;
    audioTap.connect(audioAnalyser);
    cueGain = actx.createGain();
    cueGain.gain.value = cueVolumeNow();
    cueGain.connect(actx.destination);
    // output level meter: MAIN + CUE (what goes to the speaker) split into L and R
    const split = actx.createChannelSplitter(2);
    masterGain.connect(split);
    cueGain.connect(split);
    vuAnalysers = [0, 1].map((ch) => {
      const a = actx.createAnalyser();
      a.fftSize = 1024;
      split.connect(a, ch);
      return a;
    });
    const resume = () => actx.resume().then(renderAudioHint);
    for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, resume, { capture: true });
    actx.onstatechange = renderAudioHint;
    renderAudioHint();
  }
  return actx;
}

function renderAudioHint() {
  $("audioHint").hidden = !actx || actx.state !== "suspended";
}

/** Plays the /api/audio stream of receiver `base` into MAIN (isMain) or CUE. When the stream ends by itself
 *  (receiver restart, connection loss), it stops it after a while and calls onEnd, which reconnects. */
function playStream(base, isMain, onEnd) {
  const ctx = audioContext();
  // Own gain node for this stream: on stop it is disconnected and the scheduled remainder goes silent at once.
  const gain = ctx.createGain();
  gain.connect(isMain ? audioTap : cueGain);
  const me = { gain, ctrl: new AbortController(), playTime: 0, live: true };
  pumpStream(ctx, base, me, isMain).then((aborted) => {
    if (!aborted) setTimeout(() => { if (me.live) { stopStream(me); onEnd(); } }, 1500);
  });
  return me;
}

function stopStream(h) {
  h.live = false;
  h.ctrl.abort();
  h.gain.disconnect();
}

function startAudio() {
  if (MAP_ONLY) return;
  stopAudio();
  const h = audio = playStream(vbase, true, () => { if (audio === h) { audio = null; startAudio(); } });
  syncCue();
}

/** Starts or stops the CUE streams: every VFO with CUE on plays except the active one (that goes through MAIN). */
function syncCue() {
  for (const v of vfos) {
    const want = !!(v.name && v.cue && v !== active);
    if (want && !v.cueAudio) {
      const h = v.cueAudio = playStream(v.base, false, () => { if (v.cueAudio === h) { v.cueAudio = null; syncCue(); } });
    } else if (!want && v.cueAudio) {
      stopStream(v.cueAudio);
      v.cueAudio = null;
    }
  }
}

function setCue(v, on) {
  v.cue = on;
  store("cue_" + v.name, on ? "1" : "");
  syncCue();
  renderVfoDisplays();
  renderVfoKeys();
  renderCueKey();
}

function renderCueKey() {
  const k = $("cueKey");
  k.disabled = !active || !active.name;
  k.classList.toggle("on", !!(active && active.cue));
}

$("cueKey").addEventListener("click", () => { if (active && active.name) setCue(active, !active.cue); });

/** Reads the stream and schedules playback; returns true if the stream was stopped on purpose. */
async function pumpStream(ctx, base, me, isMain) {
  const { gain, ctrl } = me;
  try {
    const res = await fetch(base + "/api/audio", { signal: ctrl.signal });
    const rate = Number(res.headers.get("X-Sample-Rate")) || st.audio_rate;
    const chans = Number(res.headers.get("X-Channels")) || 1;
    const frame = 2 * chans; // bytes per sample of all channels
    const reader = res.body.getReader();
    let carry = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !me.live) break;
      let bytes = value;
      if (carry) {
        bytes = new Uint8Array(carry.length + value.length);
        bytes.set(carry); bytes.set(value, carry.length);
        carry = null;
      }
      const even = bytes.length - (bytes.length % frame);
      if (even < bytes.length) carry = bytes.slice(even);
      const n = even / frame;
      if (!n) continue;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, even);
      const buf = ctx.createBuffer(chans, n, rate);
      for (let c = 0; c < chans; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * frame + c * 2, true) / 32768;
      }
      const now = ctx.currentTime;
      // Small buffer against dropouts; if latency builds up, a bit is dropped.
      if (me.playTime < now + 0.03) me.playTime = now + 0.15;
      if (me.playTime > now + 0.8) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      src.start(me.playTime);
      me.playTime += buf.duration;
    }
  } catch (e) {
    if (e.name === "AbortError") return true;
  }
  return !me.live;
}

function stopAudio() {
  if (!audio) return;
  stopStream(audio);
  audio = null;
}

// ---------- recording (MP3, on the server, in the folder of SETTINGS › GENERAL › RECORDINGS) ----------
// The buttons switch the recording of the active VFO; it goes on without the page, so the state comes from the receiver.
const REC_BUTTONS = [
  { btn: "recBtn", time: "recTime", key: "cont", send: "rec", label: "REC",
    title: "Record everything to MP3 until switched off, a new file every 15 min (folder: SETTINGS › GENERAL › RECORDINGS)" },
  { btn: "recSqBtn", time: "recSqTime", key: "squelch", send: "rec_sq", label: "REC SQ",
    title: "Record to MP3 only while the squelch is open, each session in its own file (folder: SETTINGS › GENERAL › RECORDINGS)" },
];
const recErrors = {};

function renderRec() {
  const rec = (st && st.recording) || {};
  for (const b of REC_BUTTONS) {
    const r = rec[b.key] || {};
    const btn = $(b.btn);
    btn.classList.toggle("on", !!r.on && !!r.open);
    btn.classList.toggle("armed", !!r.on && !r.open);
    $(b.time).textContent = r.on && r.open ? `${Math.floor(r.secs / 60)}:${String(r.secs % 60).padStart(2, "0")}` : b.label;
    btn.title = r.error || (r.on ? `Recording, click to stop${r.file ? "\n" + r.file : ""}` : b.title);
    if (r.error && r.error !== recErrors[b.key]) adError(r.error);
    recErrors[b.key] = r.error;
  }
}

for (const b of REC_BUTTONS) {
  $(b.btn).addEventListener("click", () => {
    const r = (st && st.recording && st.recording[b.key]) || {};
    memRec[b.key] = false;   // pressed by hand: the recording no longer follows the recalled memory
    send({ [b.send]: !r.on });
  });
}
renderRec();

// ---------- SETTINGS › GENERAL › RECORDINGS: folder of the MP3 recordings (recorder.py), shared by all VFOs ----------

function recDirMsg(text, err) {
  $("recDirMsg").textContent = text || "";
  $("recDirMsg").classList.toggle("error", !!err);
}

async function recDirLoad(body) {
  try {
    const r = await fetch(vbase + "/api/recording_folder", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    const s = await r.json();
    if (!r.ok) throw new Error(s.error || `HTTP ${r.status}`);
    $("recDir").value = s.folder;
    $("recDirNow").textContent = s.custom ? "own folder" : "default";
    $("recDirDefaultPath").textContent = s.default;
    if (body) recordings = [];          // the RECORDINGS tab reads the new folder when it opens
    recDirMsg("");
    return true;
  } catch (e) {
    recDirMsg(e.message, true);
    return false;
  }
}

$("recDirSave").addEventListener("click", async () => {
  if (await recDirLoad({ folder: $("recDir").value.trim() })) recDirMsg("Saved");
});
$("recDirDefault").addEventListener("click", async () => {
  if (await recDirLoad({ folder: "" })) recDirMsg("Saved: default folder");
});
$("recDir").addEventListener("keydown", (e) => { if (e.key === "Enter") $("recDirSave").click(); });

// ---------- RECORDINGS tab (RECS key): the files of the recordings folder, played in the browser ----------
// The folder is shared by all VFOs, so the list is the same on every receiver. A click on a row plays the file
// with the <audio> element (its own volume, not through MAIN); NEXT continues with the row below (the older file).
let recordings = [];          // from the server, newest first
let recsPlaying = "";         // file name in the player
let recsWriting = "";         // files being written when the list was read (a change = read again)
let recsLoading = false;

function recsSecs(s) { return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function recsSize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " kB"; }

async function loadRecordings() {
  if (recsLoading) return;
  recsLoading = true;
  try {
    const r = await fetch(vbase + "/api/recordings");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    recordings = await r.json();
    recsWriting = recordings.filter((f) => f.writing).map((f) => f.name).join("\n");
    $("recsInfo").classList.remove("error");
  } catch (e) {
    recordings = [];
    $("recsInfo").classList.add("error");
    $("recsInfo").textContent = `Recordings: ${e.message}`;
  } finally {
    recsLoading = false;
  }
  renderRecordings();
}

/** The rows that pass the filter (name, memory, frequency in kHz, mode, start). */
function recsShown() {
  const q = $("recsFilter").value.trim().toLowerCase();
  if (!q) return recordings;
  return recordings.filter((f) => `${f.name} ${f.memory} ${f.hz / 1e3} ${f.mode} ${f.start}`.toLowerCase().includes(q));
}

function renderRecordings() {
  const shown = recsShown();
  const playing = recsPlaying && !$("recsAudio").paused;
  const rows = shown.map((f) => {
    const tr = document.createElement("tr");
    tr.dataset.name = f.name;
    tr.classList.toggle("playing", f.name === recsPlaying);
    tr.title = f.writing ? "Being written now: plays what is saved so far" : "Click to play";
    const cells = [
      ["play", f.name === recsPlaying && playing ? "▮▮" : "▶", ""],
      ["", f.start || "—", ""], ["", f.memory, ""], ["num", f.hz ? `${(f.hz / 1e6).toFixed(6)} MHz` : "", ""], ["", f.mode, ""],
      ["num", recsSecs(f.secs), ""], ["num", recsSize(f.size), ""], ["file", f.name, f.name], ["del", f.writing ? "" : "✕", f.writing ? "" : "Delete the file"],
    ];
    for (const [cls, text, title] of cells) {
      const td = document.createElement("td");
      if (cls) td.className = cls;
      td.textContent = text;
      if (title) td.title = title;
      tr.append(td);
    }
    if (f.writing) { const m = document.createElement("span"); m.className = "rec-mark"; m.textContent = " ●"; tr.children[7].append(m); }
    return tr;
  });
  $("recsRows").replaceChildren(...rows);
  $("recsEmpty").hidden = recordings.length > 0;
  if (!$("recsInfo").classList.contains("error")) {
    const total = recordings.reduce((a, f) => a + f.size, 0), secs = recordings.reduce((a, f) => a + f.secs, 0);
    const n = shown.length === recordings.length ? `${recordings.length}` : `${shown.length} of ${recordings.length}`;
    $("recsInfo").textContent = recordings.length ? `${n} recordings, ${recsSecs(secs)}, ${recsSize(total)}` : "";
  }
  $("recsNow").textContent = recsPlaying;
  $("recsPlayKey").textContent = playing ? "▮▮ PAUSE" : "▶ PLAY";
}

function playRecording(name) {
  const a = $("recsAudio");
  if (name === recsPlaying) {
    if (a.paused) a.play().catch((e) => adError(`Play: ${e.message}`));
    else a.pause();
    return;
  }
  recsPlaying = name;
  a.src = `${vbase}/api/recordings/${encodeURIComponent(name)}`;
  a.play().catch((e) => adError(`Play: ${e.message}`));
  renderRecordings();
  $("recsRows").querySelector("tr.playing")?.scrollIntoView({ block: "nearest" });
}

async function deleteRecording(name) {
  if (!confirm(`Delete the recording?\n${name}`)) return;
  const r = await fetch(`${vbase}/api/recordings/${encodeURIComponent(name)}`, { method: "DELETE" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { adError(j.error || `Delete: HTTP ${r.status}`); return; }
  if (name === recsPlaying) { $("recsAudio").pause(); $("recsAudio").removeAttribute("src"); recsPlaying = ""; }
  loadRecordings();
}

$("recsRows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-name]");
  if (!tr) return;
  if (e.target.closest("td.del") && e.target.textContent) deleteRecording(tr.dataset.name);
  else playRecording(tr.dataset.name);
});
$("recsPlayKey").addEventListener("click", () => {
  const first = recsShown()[0];
  if (recsPlaying) playRecording(recsPlaying);
  else if (first) playRecording(first.name);
});
$("recsReload").addEventListener("click", loadRecordings);
$("recsFilter").addEventListener("input", renderRecordings);
$("recsNext").checked = recall("recsNext") !== "0";
$("recsNext").addEventListener("change", () => store("recsNext", $("recsNext").checked ? "1" : "0"));
for (const ev of ["play", "pause", "ended"]) $("recsAudio").addEventListener(ev, renderRecordings);
$("recsAudio").addEventListener("ended", () => {
  if (!$("recsNext").checked) return;
  const shown = recsShown(), i = shown.findIndex((f) => f.name === recsPlaying);
  if (i >= 0 && i + 1 < shown.length) playRecording(shown[i + 1].name);
});
$("recsAudio").addEventListener("error", () => { if (recsPlaying) adError(`Cannot play ${recsPlaying}`); });
// a running recording changes the list (new files, a growing size): read it again every 10 s while the tab is open
setInterval(() => {
  if (bodyTab !== "recs" || document.hidden) return;
  const writing = Object.values((st && st.recording) || {}).filter((r) => r && r.open && r.file).map((r) => r.file).join("\n");
  if (writing || writing !== recsWriting) loadRecordings();
}, 10000);

// ---------- SCAN tab (SCAN key in MENU): scanner of the active VFO (scanner.py) ----------
// Top: three tiles = what is scanned (MEMORY / VISIBLE BAND / RANGE) with the settings of the one chosen, then the keys
// (START / STOP; HOLD, SKIP, ◀ ▶ only while scanning), REC and ⚙ (squelch, continue, priority, carrier lockout, history).
// Pages CHANNELS (live table; SCAN / SQ / ASQ / PRIO of a memory are saved in it and a running scan takes them at once;
// ✕ locks a channel out until STOP), ACTIVITY and HEATMAP. Both show THIS SCAN by default: the activities of the scan
// session of this VFO; a START of another source / range or CLR begins a new session, so they start empty. The history
// (all VFOs, data\logs\scan_*.csv) is kept KEEP HISTORY days. The options are saved on the server of the VFO (cfg "scan").
let scanData = null;          // last GET /api/scan of the active VFO
let scanOptsCur = null;       // options shown (saved on the server)
let scanPresets = [];
let scanRowsKey = "";
let scanRowsHover = false;    // the mouse is over the CHANNELS table: no rebuild (the rows stay under the pointer)
// HEARD in the State column: a speaker (what is heard now), not ▶ (that looks like a play key)
const SCAN_SPK = `<svg class="scan-spk" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>`;         // the rows are rebuilt only when the memories / channels change (inputs keep focus)
let scanPolling = false;
let scanPage = "scan";
let scanLogRows = [];
let scanSession = "";         // session of THIS SCAN
const SCAN_RANGE_SRC = ["range", "view", "fmbc"];
const SCAN_MODES = ["AM", "FM"];           // a squelch scan needs AM or FM (WFM: the FM BCAST tile)
const SCAN_FM = { from_hz: 88e6, to_hz: 108e6, step_hz: 50000 };   // FM BCAST (scanner.py FMBC_*)

/** Tile chosen: "mem" / "view" / "range" / "fmbc". */
function scanTile() {
  const s = scanOptsCur ? scanOptsCur.source : "all";
  return SCAN_RANGE_SRC.includes(s) ? s : "mem";
}
function scanIsRange() { return scanTile() !== "mem"; }

/** Memories of the source chosen (as scanner.py chooses them; those with SCAN off are shown too). */
function scanMemsOf(o) {
  return mems.filter((m) => o.mem === "all" || (o.mem === "fav" ? m.fav : memGroupsOf(m).includes(o.group)));
}
function scanMems() { return scanIsRange() || !scanOptsCur ? [] : scanMemsOf(scanOptsCur); }

const scanNum = (v, d = 3) => (v === null || v === undefined || v === "" ? "" : +(+v).toFixed(d));
const scanMHz = (hz) => scanNum(hz / 1e6, 4);

/** VISIBLE BAND: the spectrum shown now, the mode of the VFO (or the one just chosen) with its width, a grid of half the width. */
function scanViewOpts(mode) {
  const v = viewNow();
  if (!mode) mode = st && SCAN_MODES.includes(st.mode) ? st.mode : "FM";
  const bw = (st && st.bandwidth && st.bandwidth[mode]) || 12500;
  return { from_hz: Math.round(v.c - v.span / 2), to_hz: Math.round(v.c + v.span / 2), mode, bw, step_hz: Math.max(bw / 2, 100) };
}
const scanChans = (o) => Math.floor(Math.abs(o.to_hz - o.from_hz) / o.step_hz + 1e-6) + 1;
/** innerHTML only when it changed: the tiles and chips are redrawn with every status, a rebuilt chip would lose its click. */
function scanHtml(id, html) {
  const el = $(id);
  if (el._html !== html) { el._html = html; el.innerHTML = html; }
}

function scanFillOpts(o) {
  scanOptsCur = o;
  $("scanFrom").value = scanNum(o.from_hz / 1e6, 5);
  $("scanTo").value = scanNum(o.to_hz / 1e6, 5);
  $("scanStep").value = scanNum(o.step_hz / 1e3, 3);
  $("scanBw").value = scanNum(o.bw / 1e3, 2);
  $("scanPick").value = o.pick;
  $("scanStore").checked = !!o.store;
  $("scanAsq").checked = !!o.asq;
  $("scanMargin").value = o.margin;
  $("scanResume").value = o.resume;
  $("scanPrioS").value = o.prio_s;
  const car = $("scanCarrier");
  if (![...car.options].some((x) => +x.value === +o.carrier_min)) car.add(new Option(`${scanNum(o.carrier_min, 1)} min`, o.carrier_min));
  car.value = String(+o.carrier_min);
  $("scanKeep").value = o.keep_days;
  $("scanRec").checked = !!o.rec;
  $("scanFmS").value = o.fm_s;
  $("scanFmStore").checked = !!o.store;
  scanResumeInput();
  scanTilesShown();
}
/** The tile chosen and its card (group chips, presets, mode keys), the numbers of the tiles, the summary on the ⚙ key. */
function scanTilesShown() {
  const o = scanOptsCur;
  if (!o || !st) return;
  const tile = scanTile();
  for (const b of $("scanSrc").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.src === tile);
    b.setAttribute("aria-checked", b.dataset.src === tile);
  }
  $("scanCard").dataset.tile = tile;
  for (const el of $("scanCard").querySelectorAll("[data-sub]")) el.hidden = el.dataset.sub !== tile;
  // MEMORY: chips = all / favourites / the groups, with the number of memories scanned
  const cnt = (list) => list.filter((m) => m.scan !== false).length;
  const chip = (val, label, n, on) => `<button class="scan-chip${on ? " on" : ""}" data-g="${escHtml(val)}">${label}<i>${n}</i></button>`;
  scanHtml("scanGroups", chip("all", "ALL", cnt(mems), o.mem === "all")
    + chip("fav", "★ FAVOURITES", cnt(mems.filter((m) => m.fav)), o.mem === "fav")
    + memAllGroups().map((g) => chip(`group:${g}`, escHtml(g), cnt(mems.filter((m) => memGroupsOf(m).includes(g))), o.mem === "group" && o.group === g)).join(""));
  $("scanNMem").textContent = cnt(scanMemsOf(o));
  $("scanSubMem").textContent = o.mem === "all" ? "all memories" : o.mem === "fav" ? "favourites ★" : `group ${o.group}`;
  // VISIBLE BAND
  const v = scanViewOpts();
  const band = `${scanMHz(v.from_hz)}–${scanMHz(v.to_hz)} MHz`;
  $("scanNView").textContent = scanChans(v);
  $("scanSubView").textContent = `${band} · ${v.mode}`;
  $("scanViewBand").textContent = band;
  $("scanViewInfo").textContent = `BW ${scanNum(v.bw / 1e3, 2)} kHz · grid ${scanNum(v.step_hz / 1e3, 3)} kHz (the bandwidth of the VFO for ${v.mode}). `
    + `The band is taken at START: zoom or move the spectrum first.`;
  $("scanNFm").textContent = scanChans(SCAN_FM);
  // RANGE
  $("scanNRange").textContent = scanChans(o);
  $("scanSubRange").textContent = `${scanMHz(Math.min(o.from_hz, o.to_hz))}–${scanMHz(Math.max(o.from_hz, o.to_hz))} MHz · ${o.mode}`;
  const same = (p) => Math.abs(p.from_hz - o.from_hz) < 1 && Math.abs(p.to_hz - o.to_hz) < 1 && Math.abs(p.step_hz - o.step_hz) < 0.01 && p.mode === o.mode;
  scanHtml("scanPresetBox", scanPresets.map((p, i) => `<button class="scan-chip${same(p) ? " on" : ""}" data-preset="${i}">${escHtml(p.name)}</button>`).join(""));
  const modeKeys = (cur) => SCAN_MODES.map((m) => `<button data-mode="${m}" class="${m === cur ? "on" : ""}">${m}</button>`).join("");
  scanHtml("scanViewModes", modeKeys(v.mode));
  scanHtml("scanRangeModes", modeKeys(o.mode));
  $("scanCfgSum").textContent = (o.asq ? `auto squelch +${o.margin} dB` : "squelch of the mode") + " · continue "
    + (o.resume === "delay" ? `${o.hang_s} s after signal` : o.resume === "carrier" ? "at once" : `after ${o.time_s} s`);
}
function scanResumeInput() {
  const r = $("scanResume").value, o = scanOptsCur || {};
  $("scanResumeS").disabled = r === "carrier";
  $("scanResumeS").value = r === "time" ? o.time_s : r === "delay" ? o.hang_s : "";
}
/** The options from the inputs (seconds: AFTER SIGNAL → hang_s, AFTER TIME → time_s). The source, the memory group and
 *  the mode are set by the tiles, chips and mode keys straight in scanOptsCur. */
function scanOptsFromInputs() {
  const r = $("scanResume").value, o = { ...(scanOptsCur || {}) };
  const num = (id, lo, hi, k, mul = 1) => { const v = parseFloat($(id).value); if (v >= lo && v <= hi) o[k] = v * mul; };
  o.asq = $("scanAsq").checked;
  num("scanMargin", 1, 30, "margin");
  o.resume = r;
  if (r === "delay") num("scanResumeS", 0, 60, "hang_s");
  if (r === "time") num("scanResumeS", 1, 600, "time_s");
  num("scanPrioS", 0, 60, "prio_s");
  num("scanCarrier", 0, 120, "carrier_min");
  num("scanKeep", 1, 365, "keep_days");
  num("scanFmS", 1, 600, "fm_s");
  o.rec = $("scanRec").checked;
  // the range inputs show rounded values (8.333 kHz): an input left as shown keeps the exact value (25/3 kHz of a
  // preset), else the airband grid would drift by 0.3 Hz per channel
  const edited = (id, lo, hi, k, mul, digits) => { if (parseFloat($(id).value) !== scanNum(o[k] / mul, digits)) num(id, lo, hi, k, mul); };
  edited("scanFrom", 0, 6000, "from_hz", 1e6, 5);
  edited("scanTo", 0, 6000, "to_hz", 1e6, 5);
  edited("scanStep", 0.1, 1000, "step_hz", 1e3, 3);
  edited("scanBw", 0.1, 250, "bw", 1e3, 2);
  o.pick = $("scanPick").value;
  o.store = (scanTile() === "fmbc" ? $("scanFmStore") : $("scanStore")).checked;   // one option, a key in each card
  return o;
}
/** Options sent with START: VISIBLE BAND takes the spectrum shown now (mode: the one just chosen, else that of the VFO). */
function scanStartOpts(mode) {
  const o = scanOptsFromInputs();
  return o.source === "view" ? { ...o, ...scanViewOpts(mode) } : o;
}

async function scanPost(action, extra = {}) {
  const r = await memApi("/api/scan", { action, ...extra });
  if (!r.ok) adError(`SCAN: ${r.error}`);
  await scanPoll();
  return r.ok;
}
async function scanSaveOpts() {
  scanOptsCur = scanOptsFromInputs();
  scanRowsKey = "";
  scanTilesShown();
  renderScanRows();
  await scanPost("opts", { opts: scanOptsCur });
}
async function scanStart(mode) {
  const o = scanStartOpts(mode);
  if (await scanPost("start", { opts: o })) scanHistoryReload();
}

async function scanPaneOpened() {
  if (!mems.length) await loadMems();
  else await loadMemGroups();
  scanData = null;
  scanRowsKey = "";
  await scanPoll();
  if (scanData) {
    scanPresets = scanData.presets || [];
    scanFillOpts(scanData.saved_opts);
  }
  $("scanCfg").hidden = recall("scanCfgOpen") !== "1";
  $("scanCfgKey").classList.toggle("on", !$("scanCfg").hidden);
  $("scanShow").value = recall("scanShow") || "session";
  if (!$("scanShow").value) $("scanShow").value = "session";
  setScanPage(recall("scanPage") || "scan", false);
  renderScanRows();
  renderScanNow();
}

function setScanPage(page, save = true) {
  if (!["scan", "log", "heat"].includes(page)) page = "scan";
  scanPage = page;
  if (save) store("scanPage", page);
  for (const b of $("scanPages").querySelectorAll("button[data-scan-page]")) b.classList.toggle("on", b.dataset.scanPage === page);
  for (const el of $("scanPane").querySelectorAll("[data-scan-panel]")) el.hidden = el.dataset.scanPanel !== page;
  $("scanShowBox").hidden = page === "scan";
  scanHistoryReload();
  renderScanRows();
}
$("scanPages").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-scan-page]");
  if (b) setScanPage(b.dataset.scanPage);
});

async function scanPoll() {
  if (scanPolling) return;
  scanPolling = true;
  try {
    const r = await memApi("/api/scan", undefined, "GET");
    scanData = r.ok ? r.data : null;
    if (!r.ok) $("scanInfo").textContent = `Scan: ${r.error}`;
  } finally {
    scanPolling = false;
  }
  if (scanData && scanData.session_id !== scanSession) {   // another source / range started, or CLR (any page of this VFO)
    scanSession = scanData.session_id;
    scanHistoryReload();
  }
  renderScanRows();
}

function scanTime(t) { return t ? new Date(t * 1000).toLocaleTimeString(LOCALE, { hour12: false }) : ""; }

/** Table of the channels: rebuilt when the memories / channels change, else only the live cells are updated. */
function renderScanRows() {
  if (bodyTab !== "scan" || scanPage !== "scan") return;
  const range = scanIsRange();
  const live = new Map(((scanData && scanData.list) || []).map((c) => [c.id, c]));
  const list = range ? [...live.values()] : scanMems();
  const key = scanTile() + "|" + (range ? list.map((c) => c.id).join(",")
    : list.map((m) => [m.id, m.name, m.freq_hz, m.mode, m.bw, m.scan, m.scan_sq, m.scan_asq, m.scan_prio].join(",")).join(";"));
  const body = $("scanRows");
  body.parentElement.classList.toggle("grid", range);   // a band / range: no memory columns (SCAN, Name, BW, SQ, ASQ, PRIO)
  // while the mouse is over the table the rows are not rebuilt (a new channel heard would move the row under the
  // pointer and the ✕ aimed at would be missed); only the live cells change, the rebuild comes when it leaves
  if (key !== scanRowsKey && !(scanRowsHover && body.rows.length)) {
    scanRowsKey = key;
    const num = (v) => (v === null || v === undefined ? "" : v);
    const live5 = `<td class="num" data-live="power"></td><td class="num" data-live="floor"></td><td class="num" data-live="level"></td>
      <td class="num" data-live="hits"></td><td data-live="last"></td><td class="scan-x" data-live="x"></td><td data-live="state"></td>`;
    body.innerHTML = range
      ? list.map((c) => `<tr data-id="${c.id}" data-hz="${c.freq_hz}"><td></td><td class="scan-name">${escHtml(c.name || "")}</td>
          <td class="num">${fmtMemFreq(c.freq_hz)}</td><td>${c.mode}</td><td></td><td></td><td></td><td></td>${live5}</tr>`).join("")
      : list.map((m) => `<tr data-id="${m.id}" data-hz="${m.freq_hz}" class="${m.scan === false ? "scan-off" : ""}">
          <td><input type="checkbox" data-f="scan" ${m.scan === false ? "" : "checked"}></td>
          <td class="scan-name" title="${escHtml(m.name)}">${escHtml(m.name)}</td><td class="num">${fmtMemFreq(m.freq_hz)}</td><td>${m.mode}</td><td class="num">${kHzText(m.bw)} k</td>
          <td><input type="number" class="scan-num" data-f="scan_sq" min="-120" max="0" step="1" value="${num(m.scan_sq)}" placeholder="auto"></td>
          <td><input type="number" class="scan-num" data-f="scan_asq" min="1" max="30" step="0.5" value="${num(m.scan_asq)}" placeholder="–"></td>
          <td><input type="checkbox" data-f="scan_prio" ${m.scan_prio ? "checked" : ""}></td>${live5}</tr>`).join("");
    const empty = !list.length;
    $("scanEmpty").hidden = !empty;
    $("scanEmpty").textContent = !empty ? "" : range
      ? "The channels heard, active or locked out appear here while the scan runs (a range has too many channels to list them all)."
      : "No memories here. Store channels with MEM (MEMORIES tab), or choose VISIBLE BAND or RANGE above.";
  }
  const excl = new Map(((scanData && scanData.excluded_list) || []).map((c) => [c.id, c]));
  const cur = scanData && scanData.cur ? scanData.cur.id : null;
  const fmt = (v) => (v === null || v === undefined ? "" : v.toFixed(1));
  for (const tr of body.rows) {
    const c = live.get(tr.dataset.id), x = excl.get(tr.dataset.id);
    const cell = (k) => tr.querySelector(`[data-live="${k}"]`);
    cell("power").textContent = c ? fmt(c.power) : "";
    cell("floor").textContent = c ? fmt(c.floor) : "";
    cell("level").textContent = c ? fmt(c.level) : "";
    cell("hits").textContent = c && c.hits ? c.hits : "";
    cell("last").textContent = c ? scanTime(c.last) : "";
    const out = !!(c && c.locked && c.lock_s === null);
    const xc = cell("x");
    xc.textContent = c ? "✕" : "";
    xc.classList.toggle("on", out);
    xc.title = !c ? "" : out ? "LOCKED OUT until STOP: the scan skips this channel. Click to scan it again."
      : "LOCK OUT: leave this channel out of the scan until STOP";
    let state = "", kind = "";
    if (tr.dataset.id === cur) { state = scanData.paused ? "HOLD" : "HEARD"; kind = scanData.paused ? "hold" : "heard"; }
    else if (c && c.locked) { state = c.lock_s === null ? "LOCKED OUT" : `SKIP ${Math.ceil(c.lock_s / 60)} min`; kind = c.lock_s === null ? "lock" : "skip"; }
    else if (c && c.active) { state = "● signal"; kind = "sig"; }
    else if (x) { state = x.why; kind = "why"; }
    const sc = cell("state");
    const html = !state ? "" : kind === "why" ? escHtml(state)
      : `<span class="scan-st ${kind}">${kind === "heard" ? SCAN_SPK : ""}${escHtml(state)}</span>`;
    if (sc._html !== html) { sc._html = html; sc.innerHTML = html; }
    sc.title = kind === "lock" ? "Locked out until STOP (by ✕ or by CARRIER LOCKOUT). A click on the red ✕ scans it again."
      : kind === "skip" ? "Skipped by SKIP; it comes back by itself" : state;
    sc.className = x && !c ? "scan-why" : "";
    tr.classList.toggle("playing", tr.dataset.id === cur);
    tr.classList.toggle("scan-active", !!(c && c.active));
  }
}

/** The keys and the status display: what the scan of the active VFO does now (from the status). */
function renderScanNow() {
  renderScanKey();
  if (bodyTab !== "scan") return;
  const sc = st && st.scan;
  const on = !!(sc && sc.on);
  scanTilesShown();
  const go = $("scanGo");
  go.textContent = on ? "■ STOP" : "▶ START";
  go.classList.toggle("accent", !on);
  go.classList.toggle("stop", on);
  $("scanRun").hidden = !on;
  $("scanPause").textContent = on && sc.paused ? "▶ CONTINUE" : "❚❚ HOLD";
  $("scanPause").classList.toggle("on", on && sc.paused);
  $("scanSkip").disabled = !(on && sc.cur);
  $("scanLockout").disabled = !(on && sc.cur);
  const msg = sc && sc.message ? `<span class="scan-msg">${escHtml(sc.message)}</span>` : "";
  if (!sc || !on) {
    $("scanStatus").className = "scan-status";
    scanHtml("scanNow", `<b class="scan-badge">SCAN OFF</b><span>Choose what to scan and press START</span>${msg}`);
    $("scanInfo").textContent = "";
    return;
  }
  const what = sc.paused ? "HOLD" : sc.state === "listen" ? "LISTENING" : sc.state === "peek" ? "PRIORITY LOOK" : "SCANNING";
  const ch = sc.cur;
  const pct = (db) => Math.min(100, Math.max(0, (db + 110) / 100 * 100)).toFixed(0);   // −110 … −10 dBFS
  $("scanStatus").className = `scan-status ${sc.paused ? "hold" : sc.state}`;
  scanHtml("scanNow", `<b class="scan-badge">${what}</b>`
    + (ch ? `<span class="scan-ch">${ch.prio ? "★ " : ""}${escHtml(ch.name || fmtMemFreq(ch.freq_hz))}</span><span class="scan-f">${fmtMemFreq(ch.freq_hz)} ${ch.mode}</span>`
      + (ch.power === null ? "" : `<span class="scan-meter" title="Level of the channel (green) and its squelch (yellow line), −110 … −10 dBFS"><i style="width:${pct(ch.power)}%"></i>`
        + (ch.level === null ? "" : `<em style="left:${pct(ch.level)}%"></em>`) + `</span><span class="scan-f">${ch.power.toFixed(1)} dBFS</span>`) : "")
    + (sc.rec_file ? `<span class="scan-rec">● REC</span>` : "") + msg);
  $("scanInfo").textContent = `${sc.channels} ch · ${sc.rate.toFixed(0)} ch/s`
    + (sc.windows > 1 ? ` · window ${sc.window}/${sc.windows}` : "")
    + (sc.locked ? ` · ${sc.locked} locked` : "") + (sc.excluded ? ` · ${sc.excluded} left out` : "")
    + (sc.stored ? ` · ${sc.stored} stored` : "");
}

$("scanGo").addEventListener("click", () => {
  if (st && st.scan && st.scan.on) scanPost("stop");
  else scanStart();
});
$("scanPause").addEventListener("click", () => scanPost(st && st.scan && st.scan.paused ? "resume" : "pause"));
$("scanSkip").addEventListener("click", () => scanPost("skip"));
$("scanLockout").addEventListener("click", () => scanPost("lockout"));
$("scanPrev").addEventListener("click", () => scanPost("step", { dir: -1 }));
$("scanNext").addEventListener("click", () => scanPost("step", { dir: 1 }));
$("scanCfgKey").addEventListener("click", () => {
  $("scanCfg").hidden = !$("scanCfg").hidden;
  $("scanCfgKey").classList.toggle("on", !$("scanCfg").hidden);
  store("scanCfgOpen", $("scanCfg").hidden ? "0" : "1");
});
// a tile: choose what is scanned; a running scan is stopped (START scans the new source).
// RANGE: the VFO is switched to the mode of the range (as the mode keys of the card do).
$("scanSrc").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-src]");
  if (!b || !scanOptsCur) return;
  const tileBefore = scanTile();
  scanOptsCur = { ...scanOptsFromInputs(), source: b.dataset.src === "mem" ? scanOptsCur.mem : b.dataset.src };
  if (st && st.scan && st.scan.on && b.dataset.src !== tileBefore) await scanPost("stop");
  await scanSourceChanged(b.dataset.src === "range" ? scanOptsCur.mode : b.dataset.src === "fmbc" ? "WFM" : null, true);
});
/** After a tile / chip / mode key: show it, save it; a running scan restarts with it (not after a tile: stopped = true),
 *  else the VFO takes the mode. */
async function scanSourceChanged(mode, stopped = false) {
  const on = !stopped && st && st.scan && st.scan.on;
  scanFillOpts(scanOptsCur);
  scanRowsKey = "";
  renderScanRows();
  if (on) { await scanStart(mode); return; }
  if (mode && st && st.mode !== mode) send({ mode });
  await scanPost("opts", { opts: scanOptsCur });
}
// the card: memory group chips, range presets, mode keys (VISIBLE BAND / RANGE; they switch the VFO too)
$("scanCard").addEventListener("click", async (e) => {
  if (!scanOptsCur) return;
  const g = e.target.closest("[data-g]"), p = e.target.closest("[data-preset]"), m = e.target.closest("[data-mode]");
  let mode = null;
  if (g) {
    const v = g.dataset.g, mem = v.startsWith("group:") ? "group" : v;
    scanOptsCur = { ...scanOptsFromInputs(), mem, group: mem === "group" ? v.slice(6) : "", source: mem };
  } else if (p) {
    const x = scanPresets[+p.dataset.preset];
    scanOptsCur = { ...scanOptsFromInputs(), from_hz: x.from_hz, to_hz: x.to_hz, step_hz: x.step_hz, mode: x.mode, bw: x.bw };
    mode = x.mode;
  } else if (m) {
    mode = m.dataset.mode;
    if (scanTile() === "range") {          // RANGE keeps its own mode; BW = the bandwidth the VFO uses for it
      const bw = st && st.bandwidth && st.bandwidth[mode];
      scanOptsCur = { ...scanOptsFromInputs(), mode, ...(bw ? { bw: Math.min(Math.max(bw, 100), 250000) } : {}) };
    }
  } else return;
  await scanSourceChanged(mode);
});
for (const id of ["scanAsq", "scanMargin", "scanResumeS", "scanPrioS", "scanCarrier", "scanKeep", "scanRec",
  "scanFrom", "scanTo", "scanStep", "scanBw", "scanPick", "scanStore", "scanFmS", "scanFmStore"]) $(id).addEventListener("change", scanSaveOpts);
$("scanResume").addEventListener("change", () => { scanResumeInput(); scanSaveOpts(); });
// SCAN / SQ / ASQ / PRIO of a memory: saved at once (empty SQ / ASQ = null)
$("scanRows").addEventListener("change", async (e) => {
  const inp = e.target.closest("[data-f]"), tr = e.target.closest("tr[data-id]");
  if (!inp || !tr) return;
  const f = inp.dataset.f;
  const v = inp.type === "checkbox" ? (f === "scan_prio" ? (inp.checked ? 1 : 0) : inp.checked)
    : inp.value.trim() === "" ? null : parseFloat(inp.value);
  const r = await memApi(`/api/memories/${tr.dataset.id}`, { [f]: v }, "PATCH");
  if (!r.ok) { adError(`SCAN: ${r.error}`); scanRowsKey = ""; renderScanRows(); return; }
  await memChanged(mems.map((x) => (x.id === r.data.id ? r.data : x)));
  renderScanRows();
});
// ✕ of a row: lock the channel out until STOP / back in. On pointerdown: a click (down + up) is lost when the row
// changes between the two while scanning.
$("scanRows").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const x = e.target.closest(".scan-x"), tr = e.target.closest("tr[data-id]");
  if (!x || !tr || !x.textContent) return;
  e.preventDefault();
  const on = !x.classList.contains("on");
  x.classList.toggle("on", on);                // shown at once, the next status confirms it
  scanPost(on ? "lock" : "unlock", { id: tr.dataset.id });
});
$("scanRows").addEventListener("pointerenter", () => { scanRowsHover = true; });
$("scanRows").addEventListener("pointerleave", () => { scanRowsHover = false; renderScanRows(); });
setInterval(() => { if (bodyTab === "scan" && !document.hidden) scanPoll(); }, 500);

// ACTIVITY and HEATMAP: THIS SCAN (session of this VFO) or the history of all VFOs
function scanShowQuery() {
  const v = $("scanShow").value;
  return v === "session" ? `session=${encodeURIComponent(scanSession || "-")}` : `days=${v}`;
}
function scanHistoryReload() {
  if (bodyTab !== "scan") return;
  if (scanPage === "log") loadScanLog();
  if (scanPage === "heat") loadScanHeat();
}
const scanEmptyText = () => ($("scanShow").value === "session"
  ? "Nothing heard in this scan yet. SHOW › TODAY / 7 DAYS shows the history."
  : "No activity in the history for these days.");
$("scanShow").addEventListener("change", () => { store("scanShow", $("scanShow").value); scanHistoryReload(); });
$("scanClr").addEventListener("click", async () => {
  const r = await memApi("/api/scan", { action: "clear" });
  if (!r.ok) { adError(`SCAN: ${r.error}`); return; }
  scanSession = r.data.session_id;
  $("scanShow").value = "session";
  store("scanShow", "session");
  scanHistoryReload();
});

function scanLogShown() {
  const q = $("scanLogFilter").value.trim().toLowerCase();
  return !q ? scanLogRows : scanLogRows.filter((r) => [r.name, (r.freq_hz / 1e6).toFixed(4), r.vfo, r.note, r.mode].join(" ").toLowerCase().includes(q));
}
/** An activity at the frequency of a memory (nearest within 500 Hz, the same mode first; a RANGE / FM BCAST scan has
 *  no names): its name when the row has none (RDS PS stays), its note before the note of the scan (carrier lockout). */
function scanLogMem(r) {
  const hz = +r.freq_hz;
  let best = null, bestD = 501;
  for (const m of mems) {
    const d = Math.abs(m.freq_hz - hz) + (m.mode === r.mode ? 0 : 0.5);
    if (d < bestD) { best = m; bestD = d; }
  }
  if (!best) return r;
  const note = [best.note, r.note].map((x) => (x || "").trim()).filter(Boolean).join(" · ");
  return { ...r, name: r.name || best.name || "", note, mem_note: best.note || "" };
}
async function loadScanLog() {
  if (!mems.length) await loadMems();
  const r = await memApi(`/api/scan/log?${scanShowQuery()}`, undefined, "GET");
  scanLogRows = r.ok ? r.data.rows.map(scanLogMem) : [];
  if (!r.ok) adError(`SCAN activity: ${r.error}`);
  renderScanLog();
}
function renderScanLog() {
  const rows = scanLogShown();
  const local = (t) => { const d = new Date(t.replace(" ", "T")); return isNaN(d) ? t : d.toLocaleString(LOCALE, { hour12: false }); };
  $("scanLogRows").innerHTML = rows.map((r) => `<tr data-file="${escHtml(r.file || "")}" data-hz="${r.freq_hz}" data-mode="${escHtml(r.mode)}">
    <td class="play">${r.file ? "▶" : ""}</td><td>${local(r.time_utc)}</td><td>${escHtml(r.vfo || "")}</td>
    <td class="num">${fmtMemFreq(+r.freq_hz)}</td><td class="scan-name" title="${escHtml(r.name || "")}">${escHtml(r.name || "")}</td><td>${escHtml(r.mode)}</td>
    <td class="num">${(+r.duration_s).toFixed(1)} s</td><td class="num">${r.max_dbfs}</td><td class="num">${r.snr_db}</td>
    <td class="scan-note" title="${escHtml(r.note || "")}">${escHtml(r.note || "")}</td></tr>`).join("");
  $("scanActN").textContent = scanLogRows.length ? `(${scanLogRows.length})` : "";
  $("scanLogEmpty").hidden = rows.length > 0;
  $("scanLogEmpty").textContent = scanEmptyText();
}
$("scanLogRows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  if (e.target.closest(".play") && tr.dataset.file) {
    const a = $("scanAudio");
    a.src = vbase + "/api/scan/rec/" + encodeURIComponent(tr.dataset.file);
    a.play().catch(() => adError(`Cannot play ${tr.dataset.file}`));
    $("scanPlaying").textContent = tr.dataset.file;
  }
});
$("scanLogRows").addEventListener("dblclick", (e) => {
  const tr = e.target.closest("tr");
  if (tr) send({ tune_hz: +tr.dataset.hz, mode: tr.dataset.mode });
});
$("scanLogFilter").addEventListener("input", renderScanLog);
$("scanLogCsv").addEventListener("click", () => {
  const f = ["time_utc", "vfo", "freq_hz", "name", "mode", "duration_s", "max_dbfs", "snr_db", "file", "note"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [f.join(","), ...scanLogShown().map((r) => f.map((k) => q(r[k])).join(","))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `scan_activity_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
setInterval(() => { if (bodyTab === "scan" && !document.hidden) scanHistoryReload(); }, 5000);

async function loadScanHeat() {
  const r = await memApi(`/api/scan/heatmap?${scanShowQuery()}`, undefined, "GET");
  const rows = r.ok ? r.data.rows : [];
  if (!r.ok) adError(`SCAN heatmap: ${r.error}`);
  const max = Math.max(1, ...rows.flatMap((x) => x.hours));
  $("scanHeatHead").innerHTML = `<tr><th>Frequency</th><th>Name</th><th>Total</th>${Array.from({ length: 24 }, (_, h) => `<th class="hh">${h}</th>`).join("")}</tr>`;
  $("scanHeatRows").innerHTML = rows.map((x) => `<tr data-hz="${x.freq_hz}" data-mode="${escHtml(x.mode)}">
    <td class="num">${fmtMemFreq(x.freq_hz)}</td><td class="scan-name" title="${escHtml(x.name || "")}">${escHtml(x.name || "")}</td><td class="num">${x.total >= 60 ? (x.total / 60).toFixed(1) + " min" : x.total.toFixed(0) + " s"}</td>
    ${x.hours.map((s, h) => {
      const k = s ? Math.log1p(s) / Math.log1p(max) : 0;   // log scale: a few seconds still show
      return `<td class="hc" style="background:${s ? `hsla(${48 - 48 * (1 - k)}, 100%, ${18 + 40 * k}%, ${0.35 + 0.65 * k})` : "transparent"}" title="${h}:00–${h}:59 · ${s.toFixed(0)} s"></td>`;
    }).join("")}</tr>`).join("");
  $("scanHeatHead").hidden = !rows.length;
  $("scanHeatEmpty").hidden = rows.length > 0;
  $("scanHeatEmpty").textContent = scanEmptyText();
}
$("scanHeatRows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr) send({ tune_hz: +tr.dataset.hz, mode: tr.dataset.mode });
});

// ---------- stereo level meter next to the sliders ----------
// LEDs from the bottom up: 10 green up to 0 dB, then yellow (+3 dB) and red (+6 dB = 0 dBFS, clipping).
// 0 dB of the meter = −6 dBFS, so yellow and red warn before clipping.
const VU_STEPS = [-40, -30, -25, -20, -15, -12, -9, -6, -3, 0, 3, 6];
const VU_REF_DBFS = -6;
let vuAnalysers = null;
const vuLevel = [-99, -99];
const vuBuf = new Float32Array(1024);
// Above each column a round CLIP LED (0 dBFS reached, held 1.5 s); between the columns the dB numbers of the LEDs.
// Peak hold: the highest LED reached stays lit for 1 s, then falls.
const VU_LABELS = { "-40": "40", "-20": "20", "-12": "12", "-6": "6", "0": "0" };
for (const col of document.querySelectorAll(".vu-ch")) {
  col.innerHTML = VU_STEPS.map((d) => `<i class="${d > 3 ? "red" : d > 0 ? "yellow" : ""}"></i>`).join("") + `<i class="clip"></i>`;
}
for (const col of document.querySelectorAll(".vu-db")) {
  col.innerHTML = VU_STEPS.map((d) => `<b>${VU_LABELS[d] ?? ""}</b>`).join("") + `<b class="clip">CLIP</b>`;
}
const vuLeds = [...document.querySelectorAll(".vu-ch")].map((c) => [...c.children].slice(0, VU_STEPS.length));
const vuClip = [...document.querySelectorAll(".vu-ch")].map((c) => c.lastElementChild);
const vuPeak = [-99, -99], vuPeakAt = [0, 0], vuClipAt = [-1e9, -1e9];
function animateVu() {
  const now = performance.now();
  vuAnalysers?.forEach((a, ch) => {
    a.getFloatTimeDomainData(vuBuf);
    let peak = 0;
    for (const x of vuBuf) peak = Math.max(peak, Math.abs(x));
    const db = 20 * Math.log10(peak + 1e-9) - VU_REF_DBFS;
    vuLevel[ch] = Math.max(db, vuLevel[ch] - 0.8);   // fast attack, slow decay (~48 dB/s)
    if (db >= vuPeak[ch]) { vuPeak[ch] = db; vuPeakAt[ch] = now; }
    else if (now - vuPeakAt[ch] > 1000) vuPeak[ch] -= 0.8;
    if (peak >= 0.999) vuClipAt[ch] = now;
    let pk = -1;
    for (let i = 0; i < VU_STEPS.length; i++) if (vuPeak[ch] >= VU_STEPS[i]) pk = i;
    vuLeds[ch].forEach((led, i) => {
      const on = vuLevel[ch] >= VU_STEPS[i];
      led.classList.toggle("on", on);
      led.classList.toggle("pk", i === pk && !on);
    });
    vuClip[ch].classList.toggle("on", now - vuClipAt[ch] < 1500);
  });
  requestAnimationFrame(animateVu);
}
requestAnimationFrame(animateVu);

let muted = false;
// MUTE silences both MAIN and CUE.
function volumeNow() { return muted ? 0 : Number($("volume").value); }
function cueVolumeNow() { return muted ? 0 : Number($("cueVolume").value); }
// colouring of the slider track by level (CSS --p = fill height, --vc = thumb colour)
function renderVolume() {
  for (const [id, name] of [["volume", "MAIN"], ["cueVolume", "CUE"]]) {
    const el = $(id);
    const p = (el.value - el.min) / (el.max - el.min);
    el.style.setProperty("--p", (p * 100).toFixed(1) + "%");
    el.style.setProperty("--vc", muted ? "#7d8794" : p <= 0.67 ? "#3cf07c" : p < 0.84 ? "#ffd84a" : "#ff4b3e");
    el.title = `${name} level ${Math.round(el.value * 100)} %`;
  }
  $("volume").closest(".vol").classList.toggle("muted", muted);
}
function applyVolume() {
  if (masterGain) masterGain.gain.value = volumeNow();
  if (cueGain) cueGain.gain.value = cueVolumeNow();
  renderVolume();
}
$("volume").addEventListener("input", applyVolume);
$("cueVolume").addEventListener("input", applyVolume);
$("muteBtn").addEventListener("click", () => {
  muted = !muted;
  $("muteBtn").classList.toggle("on", muted);
  applyVolume();
});
renderVolume();

/** After start: a newer version on GitHub Releases (update_check.py on the server) shown beside the own one,
 *  and a small window offering the upgrade. LATER hides it until RADIMCOM is started again, SKIP until a still newer one. */
let updInfo = null;
async function updFetch(opts) {
  const r = await fetch("/api/update", opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

async function checkUpdate(tries = 0) {
  let u;
  try { u = await updFetch(); } catch (e) { return; }
  if (u.state === "checking" && tries < 20) { setTimeout(() => checkUpdate(tries + 1), 3000); return; }
  const a = $("updLink");
  if (!u.newer || !a) return;
  updInfo = u;
  a.textContent = u.latest;
  a.href = u.url;
  a.title = `${u.name}${u.published ? `, released ${u.published.slice(0, 10)}` : ""} is available: click here for the latest version`;
  a.hidden = false;
  const logo = document.querySelector(".r-logo-link");   // red logo: this is not the newest version
  if (logo) {
    logo.classList.add("outdated");
    logo.href = u.url;      // the release page, in a new tab (target=_blank)
    logo.title = `RADIMCOM ${u.latest} is available (this is ${u.current}): click here for the latest version`;
  }
  if (recall("updSkip") !== u.latest && recall("updLater") !== String(u.checked)) showUpdate();
}


function showUpdate() {
  const u = updInfo;
  let w = $("updWin");
  if (!w) {
    w = document.createElement("aside");
    w.className = "drawer upd-win";
    w.id = "updWin";
    w.setAttribute("aria-label", "New version");
    document.querySelector(".stage").append(w);
  }
  const mb = u.zip_size ? ` (${(u.zip_size / 1e6).toFixed(1)} MB)` : "";
  w.innerHTML = `<div class="drawer-head"><b>New version ${escHtml(u.latest)}</b><button class="key small" id="updX">✕</button></div>
    <div class="drawer-body">
      <p>RADIMCOM <b>${escHtml(u.latest)}</b> is out${u.published ? ` (${u.published.slice(0, 10)})` : ""}; this one is ${escHtml(u.current)}.
        <a href="${escHtml(u.url)}" target="_blank" rel="noopener noreferrer">What is new</a></p>
      ${u.can_upgrade
        ? `<p class="muted small">UPGRADE downloads the upgrade zip${mb}, closes the receiver, installs it in its own window
            (with upgrade.bat) and starts RADIMCOM again; this page then reloads. The data folder and the settings stay.
            It takes about a minute.</p>`
        : `<p class="note warn">No automatic upgrade here: ${escHtml(u.why_not || "")}.</p>`}
      <p class="note error" id="updErr" hidden></p>
      <div class="upd-keys">
        ${u.can_upgrade ? '<button class="key" id="updGo">UPGRADE</button>' : `<a class="key" href="${escHtml(u.url)}" target="_blank" rel="noopener noreferrer">RELEASE PAGE</a>`}
        <button class="key" id="updLater" title="Ask again at the next start of RADIMCOM">LATER</button>
        <button class="key" id="updSkip" title="Do not ask again for ${escHtml(u.latest)}; the note beside the version stays">SKIP THIS VERSION</button>
      </div>
    </div>`;
  w.hidden = false;
  const close = () => { w.hidden = true; };
  $("updX").onclick = close;
  $("updLater").onclick = () => { store("updLater", String(u.checked)); close(); };
  $("updSkip").onclick = () => { store("updSkip", u.latest); close(); };
  if ($("updGo")) $("updGo").onclick = () => updStart(u);
}

async function updStart(u) {
  const body = $("updWin").querySelector(".drawer-body");
  const say = (html) => { body.innerHTML = `<p>${html}</p>`; };
  try {
    await updFetch({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ upgrade: true }) });
  } catch (e) {
    $("updErr").textContent = e.message;
    $("updErr").hidden = false;
    return;
  }
  say("Downloading…");
  const t0 = Date.now();
  let down = false;
  const poll = async () => {
    let s = null;
    try { s = await updFetch(); } catch (e) { down = true; }
    if (s && s.current && s.current !== u.current) { location.reload(); return; }     // the new version answers
    if (s && s.upgrade_error) { say(`<span class="error">Upgrade failed: ${escHtml(s.upgrade_error)}</span>`); return; }
    if (s && s.state === "downloading") {
      say(`Downloading… ${s.got ? (s.got / 1e6).toFixed(1) : 0}${u.zip_size ? ` of ${(u.zip_size / 1e6).toFixed(1)}` : ""} MB`);
    } else if (down || (s && s.state === "installing")) {
      say(`Installing ${escHtml(u.latest)} in the window "RADIMCOM upgrade"… This page reloads when RADIMCOM runs again.`);
    }
    if (Date.now() - t0 > 600000) {
      say("RADIMCOM did not come back within 10 minutes: look at the window \"RADIMCOM upgrade\", then start RADIMCOM by hand.");
      return;
    }
    setTimeout(poll, down ? 3000 : 1000);
  };
  setTimeout(poll, 1000);
}

/** "?map=…" tab: the map box alone over the whole window, the map view of its decoder. */
function mapOnlySetup() {
  const box = $(`${MAP_ONLY}MapBox`);
  document.body.append(box);
  box.classList.add("map-only-box");
  document.body.classList.add("map-only");
  document.title = `${({ packet: "APRS", acars: "ACARS / VDL2", adsb: "ADS-B" })[MAP_ONLY] || MAP_ONLY.toUpperCase()} map${active && active.name ? ` · VFO ${active.name}` : ""} · RADIMCOM`;
  ({ packet: setPktView, hfdl: setHfdlView, ais: setAisView, adsb: setAdsbView, acars: setAcarsView })[MAP_ONLY]("map");
}

/** □ key in the top right corner of a map: the same map in a new browser tab. */
function mapPopout(map, kind) {
  if (MAP_ONLY) return;
  const Ctl = L.Control.extend({
    onAdd() {
      const bar = L.DomUtil.create("div", "leaflet-bar map-popout");
      const a = L.DomUtil.create("a", "", bar);
      a.href = "#";
      a.title = "Open the map in a new tab";
      a.setAttribute("role", "button");
      a.innerHTML = '<svg viewBox="0 0 16 16"><path d="M9 2h5v5M14 2 7.5 8.5M12 9.5V14H2V4h4.5"/></svg>';
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(a, "click", (e) => {
        L.DomEvent.preventDefault(e);
        const q = `?map=${kind}${active && active.name ? `&vfo=${encodeURIComponent(active.name)}` : ""}`;
        window.open(location.pathname + q, "_blank", "noopener");
      });
      return bar;
    },
  });
  new Ctl({ position: "topright" }).addTo(map);
}

async function init() {
  if (!MAP_ONLY) checkUpdate();
  // With the VFO launcher the page gets the VFO list; a standalone receiver has no list (one VFO without the bar).
  let list = null;
  try {
    const r = await fetch("/api/vfos");
    if (r.ok) list = await r.json();
  } catch (e) { /* no VFOs */ }
  vfos = list && list.length
    ? list.map((x) => ({ ...x, base: `${location.protocol}//${location.hostname}:${x.port}`, st: null, rows: [], online: false,
        cue: recall("cue_" + x.name) === "1", cueAudio: null }))
    : [{ name: null, base: "", st: null, rows: [], online: false }];
  const want = MAP_ONLY ? new URLSearchParams(location.search).get("vfo") : recall("vfo");
  active = vfos.find((v) => v.name === want) || vfos[0];
  vbase = active.base;
  restoreBodyTab();
  if (MAP_ONLY) mapOnlySetup();
  renderVfoDisplays();
  if (list && list.length) { renderSpareVfos(); renderVfoKeys(); }
  renderCueKey();
  // The VFO receivers open one after another after start: keep trying until the active one answers.
  let info = null;
  while (!info) {
    try { info = await fetch(vbase + "/api/state").then((r) => r.json()); } catch (e) {
      renderStatusPill();
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  sampleRates = info.sample_rates;
  renderFt8Bands(info.ft8_freqs);
  dabChannelList = info.dab_channels || [];
  $("dabChannel").innerHTML = (info.dab_channels || []).map(([n, f]) => `<option value="${n}">${n} · ${fmtMHz(f, 3)}</option>`).join("");
  renderHfdlBands(info.hfdl_bands || [], info.hfdl_stations || []);
  renderAisBands(info.ais_center, info.ais_channels);
  renderAdsbBands(info.adsb_freq);
  $("ismBands").innerHTML = (info.ism_freqs || []).map((f) => `<button data-f="${f}" title="Centre the VFO on ${fmtMHz(f, 2)} MHz">${fmtMHz(f, 2)}</button>`).join("");
  linkFreqs = { acars: info.acars_freqs || [], vdl2Center: info.vdl2_center || 136500000,
    vdl2Rate: info.vdl2_rate || 2100000,
    vdl2RegionFreqs: info.vdl2_region_freqs || {} };
  linkShown = null;
  renderLinkBands();
  loadMems();
  for (const v of vfos) connectEvents(v);
  startAudio();
  await loadDecoders();
}
init();
