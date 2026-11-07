"use strict";

const $ = (id) => document.getElementById(id);

// ---------- page scale (responsive layout) ----------
// The page is drawn in a "virtual window" of at least STAGE_W × STAGE_H px and is scaled as a whole
// to the browser window (CSS .stage). Browser zoom changes innerWidth/innerHeight, so it is
// cancelled out: the content depends only on the window size. With a different aspect ratio the virtual
// window gets longer (wider / taller) and the layout stretches.
const STAGE_W = 1920, STAGE_H = 820;
let uiScale = 1;
function fitStage() {
  const w = window.innerWidth, h = window.innerHeight;
  uiScale = Math.min(w / STAGE_W, h / STAGE_H) || 1;
  const root = document.documentElement, vw = w / uiScale;
  root.style.setProperty("--k", uiScale);
  root.style.setProperty("--vw", `${vw}px`);
  root.style.setProperty("--vh", `${h / uiScale}px`);
  root.classList.toggle("compact", vw <= 2100);
}
fitStage();
window.addEventListener("resize", fitStage);   // before the other resize handlers (redraw)

const BANDWIDTHS = {
  AM: [4000, 6000, 8000, 10000],
  FM: [500, 3000, 6000, 12000, 25000, 50000],
  WFM: [100000, 150000, 200000],
  LSB: [1800, 2400, 2700, 3000],
  USB: [1800, 2400, 2700, 3000],
  CW: [300, 500, 800, 1200],
  DSD: [12500],      // fixed channel width of the digital voice decoder
};
const STEPS = [10, 100, 500, 1000, 5000, 9000, 10000];
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
let zoomLast = Number(recall("zoomLast")) || 0;   // last zoom above 1×, the ZOOM key returns to it
let errorUntil = 0; // until when to show the error of the last change in the status field
let vbase = ""; // receiver address of the active VFO ("" = server of this page, mode without VFOs)
let vfos = []; // [{name, port, serial, note, base, st, rows, online}]
let active = null; // active VFO

function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* no storage */ } }
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
  const err = $("settingsError");
  err.hidden = res.ok;
  if (!res.ok) {
    err.textContent = (await res.json()).error || "Error";
    // The settings drawer is usually closed: show the error in the status field too.
    errorUntil = Date.now() + 5000;
    renderStatusPill(err.textContent);
  }
}

/** Status field under the clock: error of the last change (5 s). With VFOs the receiver state is in the block above
 *  the display, so the field is otherwise hidden; a standalone receiver without VFOs shows its state here. */
function renderStatusPill(error) {
  const pill = $("status");
  if (error) pill._error = error;
  let txt = null, cls = "bad";
  if (Date.now() < errorUntil) txt = pill._error;
  else if (active && !active.name) {
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

function segButtons(el, items, active, label) {
  // Redraw only on a change: replacing the button under the mouse causes flicker and lost clicks.
  const html = items.map((v) => `<button data-v="${v}" class="${String(v) === String(active) ? "active" : ""}">${label(v)}</button>`).join("");
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

function renderControls() {
  if (!st) return;
  segButtons($("modes"), Object.keys(BANDWIDTHS), st.mode, (m) => m);
  // The buttons stay fixed; a width set by dragging the edge in the spectrum has no button (none is lit).
  const bw = st.bandwidth[st.mode];
  segButtons($("bandwidths"), BANDWIDTHS[st.mode], bw, fmtBw);
  segButtons($("steps"), STEPS, stepHz, fmtBw);
  $("zoomKey").textContent = `${st.zoom}×`;
  $("zoomKey").classList.toggle("active", st.zoom > 1);
  if (st.zoom > 1 && st.zoom !== zoomLast) { zoomLast = st.zoom; store("zoomLast", zoomLast); }
  $("modeBadge").textContent = st.mode;
  $("bwBadge").textContent = fmtBw(bw);
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
  if (!b) return;
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
  store("step", stepHz);
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
// One key: click = off (back to 1×) / on (last value above 1×), wheel = next zoom up or down; lit above 1×.
$("zoomKey").addEventListener("click", () => {
  if (!st) return;
  setZoom(st.zoom > 1 ? 1 : st.zooms.includes(zoomLast) ? zoomLast : st.zooms[1]);
});
$("zoomKey").addEventListener("wheel", (e) => {
  e.preventDefault();
  const dir = wheelStep(e);
  if (!st || !dir) return;
  const z = st.zooms[st.zooms.indexOf(st.zoom) + dir];
  if (z) setZoom(z);
}, { passive: false });
document.addEventListener("keydown", (e) => {
  if (!st || e.target.closest("input, select, textarea")) return;
  if (e.key === "ArrowLeft") { tune(st.tune_hz - stepHz, true); e.preventDefault(); }
  if (e.key === "ArrowRight") { tune(st.tune_hz + stepHz, true); e.preventDefault(); }
});

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
  if (v === active) { tune(hz); return; }
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
    <clipPath id="${id}clip"><rect x="0" y="0" width="260" height="100" rx="6"/></clipPath>${defs}
  </defs>
  <g clip-path="url(#${id}clip)">
  <rect x="0" y="0" width="260" height="100" fill="${background}"/>${inner}
  </g>
  <rect x=".5" y=".5" width="259" height="99" rx="6" fill="none" stroke="#262c35"/>`;
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

let meterStyle = METER_STYLES[recall("meterStyle")] ? recall("meterStyle") : "needle";
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

const LUT = (() => {
  // Noise almost black to dark blue, signals change sharply to yellow and red (higher contrast).
  const stops = [[0, 0, 0, 10], [0.16, 4, 14, 70], [0.32, 18, 60, 190], [0.46, 40, 175, 240],
    [0.6, 250, 235, 60], [0.78, 255, 100, 20], [1, 255, 255, 255]];
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
})();

function clearWaterfall(bins) {
  wfCanvas.width = bins;
  wfCanvas.height = WF_ROWS;
  wfCtx.fillStyle = "#020828";
  wfCtx.fillRect(0, 0, bins, WF_ROWS);
  wfRow = new ImageData(bins, 1);
  spec = null;
}

function colorRange() {
  const stepDb = st.wf.db_step;
  const lo = floor + (Number($("wfShift").value) - 3) / stepDb;
  return [lo, Number($("wfRange").value) / stepDb];
}

function onRow(center, span, b64, replay = false) {
  if (!st) return;
  const bin = atob(b64);
  const n = bin.length;
  const vals = new Uint8Array(n);
  for (let i = 0; i < n; i++) vals[i] = bin.charCodeAt(i);

  if (!wfRow || wfRow.width !== n || !view || Math.abs(view.span - span) > 1) {
    clearWaterfall(n);
    view = { c: center, span };
    imgC = center;
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
  const d = wfRow.data;
  for (let j = 0; j < n; j++) {
    const i = j - off;
    let c = 0;
    if (i >= 0 && i < n) c = Math.max(0, Math.min(255, Math.round(((vals[i] - lo) / rng) * 255))) * 3;
    d[j * 4] = LUT[c]; d[j * 4 + 1] = LUT[c + 1]; d[j * 4 + 2] = LUT[c + 2]; d[j * 4 + 3] = 255;
  }
  wfCtx.drawImage(wfCanvas, 0, 0, n, WF_ROWS - 1, 0, 1, n, WF_ROWS - 1);
  wfCtx.putImageData(wfRow, 0, 0);

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
    wfCtx.fillStyle = "#020828";
    wfCtx.fillRect(0, 0, n, WF_ROWS);
    wfCtx.putImageData(img, -dx, 0);
    if (spec) {
      const s = new Float32Array(n).fill(floor ?? 0);
      for (let j = 0; j < n; j++) { const i = j + dx; if (i >= 0 && i < n) s[j] = spec[i]; }
      spec = s;
    }
    imgC += (dx * view.span) / n;
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
    if (spectrum) {
      // Label above the passband: tuned frequency, then demodulator and bandwidth.
      const { txt: fTxt, unit } = freqDigits(st.tune_hz);
      const lines = [`${fTxt.trim()} ${unit}`, `${st.mode} · ${fmtBw(bw)}`];
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
  const list = mems.filter((m) => m.freq_hz >= f0 && m.freq_hz <= f1)
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
    const tw = ctx.measureText(name).width + 10;
    const bx = Math.min(Math.max(x - tw / 2, 2), w - tw - 2);
    let row = -1;
    for (let r = 0; r < MEM_TAG_ROWS && row < 0; r++) {
      if (used[r].every(([a, b]) => bx + tw + 2 < a || bx - 2 > b)) row = r;
    }
    // the ▲ mark at the top edge points at the frequency
    ctx.fillStyle = MEM_COLOR;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 4, 6); ctx.lineTo(x + 4, 6); ctx.closePath(); ctx.fill();
    if (row < 0) { memTagBoxes.push({ m, x0: x - 5, x1: x + 5, y0: 0, y1: 7 }); continue; }
    used[row].push([bx, bx + tw]);
    const y0 = rowY(row);
    ctx.strokeStyle = "rgba(126,224,168,.55)";
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, y0); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(8,20,14,.88)";
    ctx.strokeStyle = MEM_COLOR;
    ctx.beginPath(); ctx.roundRect(bx, y0, tw, MEM_TAG_H, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = MEM_COLOR;
    ctx.textAlign = "left";
    ctx.fillText(name, bx + 5, y0 + MEM_TAG_H / 2 + 0.5);
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
function audioBubbleHide() {
  audioBubblePos = null;
  mpxSpec = null;
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
      const tip = m ? `${m.name} · ${m.freq_hz >= 30e6 ? `${fmtMHz(m.freq_hz, 4)} MHz` : `${fmtKHz(m.freq_hz, 2)} kHz`} · ${m.mode} · ${m.group}` : "";
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
      else tune(xToFreq(e.clientX - r.left, r.width), true);
    }
    if (drag.moved && !drag.bw) viewLocalAt = Date.now();
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
    if (dir) tune(st.tune_hz + dir * stepHz, true);
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
  const rows = wfRowsWanted();
  if (rows === WF_ROWS || !wfRow) { WF_ROWS = rows; return; }
  const w = wfCanvas.width;
  const old = wfCtx.getImageData(0, 0, w, Math.min(rows, WF_ROWS));
  WF_ROWS = rows;
  wfCanvas.height = rows;
  wfCtx.fillStyle = "#020828";
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
  const auto = st.gain === "auto";
  $("gainAuto").checked = auto;
  $("agcKey").classList.toggle("on", auto);
  $("rtlAgc").checked = !!st.rtl_agc;
  $("gainSlider").disabled = auto;
  $("gainSlider").max = Math.max(st.gains.length - 1, 0);
  if (!auto) {
    let best = 0;
    st.gains.forEach((g, i) => { if (Math.abs(g - st.gain) < Math.abs(st.gains[best] - st.gain)) best = i; });
    $("gainSlider").value = best;
  }
  $("gainText").textContent = auto ? "auto" : gainLabel(st);
  renderVfoDisplays();
}

const spurShiftText = (hz) => `${hz > 0 ? "+" : ""}${hz} Hz`;

/** LEARN changes this on the server at any time, so it is drawn with every status. */
function renderSpurInfo() {
  $("spurKey").classList.toggle("on", !!st.spur_on);
  $("spurOn").checked = !!st.spur_on;
  $("spurHz").disabled = $("spurEdge").disabled = $("spurShift").disabled = $("spurDb").disabled = !st.spur_on;
  $("spurLearn").disabled = !!st.spur_learning;
  $("spurClear").disabled = !st.spur_count;
  $("spurInfo").textContent = st.spur_learning ? "learning…"
    : st.spur_found === 0 ? `none found · ${st.spur_count} stored` : `${st.spur_count} lines stored`;
}

function renderSettings() {
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
  $("txSetting").hidden = !st.tx_capable;
  $("setTabTx").hidden = !st.tx_capable;
  if (!st.tx_capable && $("setTabTx").classList.contains("on")) showSetTab("dongle");
  $("txEnabled").checked = !!st.tx_enabled;
  renderSquelch();
  renderWfLabels();
}

const SQUELCH_OFF = -120;

// Squelch has its own level for AM, FM and WFM; the slider in SET sets the one for the current mode.
function squelchLevel() {
  const v = st.squelch_levels ? st.squelch_levels[st.mode] : undefined;
  return v === undefined ? SQUELCH_OFF : v;
}

function renderSquelch() {
  const ok = st.squelch_levels && st.mode in st.squelch_levels;
  const v = squelchLevel();
  if (document.activeElement !== $("squelch")) $("squelch").value = v;
  $("squelch").disabled = !ok;
  $("squelchMode").textContent = ok ? `(${st.mode})` : "";
  $("squelchText").textContent = !ok ? `not in ${st.mode}` : v <= SQUELCH_OFF ? "OFF" : `${v} dBFS (${sReading(v)})`;
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
  $("afiKey").disabled = !afiMode;
  $("afiKey").classList.toggle("on", afiMode && !!st.afi);
  $("afiKey").title = `AFI: audio frequency inversion around ${st.afi_hz ?? 1750} Hz – voice inversion scrambler / descrambler (all modes except WFM); frequency in SET`;
  if (st.afi_hz != null && document.activeElement !== $("afiHz")) $("afiHz").value = st.afi_hz;
  renderPassKeys();
  // ALC flag at the S-meter: green = on, grey = off; hidden in FM/WFM (no ALC)
  $("alcBadge").hidden = !alcMode;
  $("alcBadge").classList.toggle("dim", st.audio_agc === false);
  $("stBadge").hidden = !wfm;
  $("stBadge").classList.toggle("dim", !st.stereo);
  // The RDS frame is always in place (the waterfall does not move); without RDS it is empty and dark.
  const has = !!r && (r.ps || r.rt || r.pi);
  $("rds").classList.toggle("off", !has);
  $("rdsPs").textContent = has ? r.ps || "········" : " ";
  $("rdsMeta").textContent = has ? [r.pi && `PI ${r.pi}`, r.pty, r.tp && (r.ta ? "TP TA" : "TP")].filter(Boolean).join(" · ") : "";
  $("rdsRt").textContent = has ? r.rt : "";
  $("rds").title = has ? [r.rt, r.ct && `Clock: ${r.ct}`].filter(Boolean).join("\n") : "RDS";
}

// SQL flag with squelch on (AM/FM/WFM): lit while the squelch is open.
function renderSqlBadge() {
  $("sqlBadge").hidden = squelchLevel() <= SQUELCH_OFF;
  $("sqlBadge").classList.toggle("dim", !st.squelch_open);
  renderSquelch();
}

function renderWfLabels() {
  $("wfRangeText").textContent = `${$("wfRange").value} dB`;
  const s = Number($("wfShift").value);
  $("wfShiftText").textContent = `${s > 0 ? "+" : ""}${s} dB`;
}

function setAgc(on) {
  st.gain = on ? "auto" : st.gains[Number($("gainSlider").value)] ?? 0;
  renderGain();
  send({ gain: st.gain });
}
$("gainAuto").addEventListener("change", () => setAgc($("gainAuto").checked));
$("agcKey").addEventListener("click", () => { if (st) setAgc(st.gain !== "auto"); });
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
$("afiKey").addEventListener("click", () => {
  if (!st) return;
  st.afi = !st.afi;
  renderRds();
  renderVfoDisplays();
  send({ afi: st.afi });
});
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
    key.title = `${PASS[kind].text} ${hz} Hz. Click = on/off, mouse wheel = frequency (also in SET)`;
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
$("spurKey").addEventListener("click", () => { if (st) setSpurOn(!st.spur_on); });
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
$("squelch").addEventListener("input", () => {
  const v = Number($("squelch").value);
  st.squelch_levels = { ...st.squelch_levels, [st.mode]: v };
  renderSqlBadge();
  send({ squelch: v, squelch_mode: st.mode });
});
$("resetBtn").addEventListener("click", () => { floor = null; send({ reset: true }); });
for (const id of ["wfRange", "wfShift"]) {
  $(id).addEventListener("input", () => { renderWfLabels(); drawSpectrum(); store(id, $(id).value); });
  const saved = recall(id);
  if (saved !== null) $(id).value = saved;
}
const savedStep = Number(recall("step"));
if (STEPS.includes(savedStep)) stepHz = savedStep;

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
function restoreBodyTab() {
  $("decNew").hidden = true;
  renderAmsatTab();
  const saved = recall(tabKey());
  bodyTabGuess = !["dec", "scope", "sat"].includes(saved);
  setBodyTab(saved === "dec" || (saved === "sat" && amsatTabShown()) ? saved : "scope", !bodyTabGuess);
}

/** First state of a VFO without a saved tab: if a decoder runs on it, opens DECODERS. */
function guessBodyTab() {
  if (!bodyTabGuess) return;
  bodyTabGuess = false;
  const any = ["ft8On", "wefaxOn", "cwOn", "rttyOn", "sstvOn", "acarsOn", "vdl2On"].some((id) => $(id).checked) || !!(st && (st.dab || st.ism || st.mode === "DSD"));
  setBodyTab(any ? "dec" : "scope");
}

function setBodyTab(tab, save = true) {
  bodyTab = tab;
  if (save) store(tabKey(), tab);
  for (const b of $("bodyTabs").querySelectorAll("button")) b.classList.toggle("on", b.dataset.tab === tab);
  $("decPane").hidden = tab !== "dec";
  $("amsatPane").hidden = tab !== "sat";
  if (tab === "dec") $("decNew").hidden = true;
  if (tab === "sat") renderSatTab();
  renderAmsatTab();
  hoverHide();
}

/** Number of enabled decoders on the tab and a text when none is enabled. */
function renderDecTab() {
  // by the checkboxes – valid right after the click, even before the server confirms the state
  const n = ["ft8On", "wefaxOn", "cwOn", "rttyOn", "sstvOn", "acarsOn", "vdl2On"].filter((id) => $(id).checked).length + (st && st.dab ? 1 : 0) + (st && st.ism ? 1 : 0) + (st && st.mode === "DSD" ? 1 : 0);
  $("decCount").textContent = n ? `(${n})` : "";
  $("decEmpty").hidden = n > 0;
}

/** New decoder message: green dot on the tab until you look at it. */
function decActivity() {
  if (bodyTab !== "dec") $("decNew").hidden = false;
}

$("bodyTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) setBodyTab(b.dataset.tab);
});
// enabling a decoder (FT8, WEFAX, SSTV, ACARS) opens the DECODERS tab so its card is visible
for (const id of ["ft8On", "wefaxOn", "cwOn", "rttyOn", "sstvOn", "acarsOn", "vdl2On"]) {
  $(id).addEventListener("change", () => {
    if ($(id).checked) setBodyTab("dec");
    renderDecTab();
  });
}
setBodyTab(bodyTab, false);

// ---------- SATELLITES tab: the lists of amsat.org ----------

let amsatPages = null;   // from the server (satellites.py), loaded when the tab is first opened
let amsatPage = recall("amsatPage") || "passes";
let amsatBusy = false;

/** The SATELLITES tab is always there; the SAT key switches to it. */
function amsatTabShown() { return true; }
function renderAmsatTab() { $("satKey").classList.toggle("on", bodyTab === "sat"); }

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

async function satFetch(url, opts) {
  const r = await fetch(vbase + url, opts);
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
  box.innerHTML = `<div class="satp-dh"><b>${escHtml(d.name)}</b> <span class="muted">NORAD ${d.norad} · ${satDay(aos.t)}</span>
    ${amsatPage === "track" ? "" : `<button class="key small" id="satDetailTrack" data-norad="${d.norad}" title="Open this satellite on the TRACK page (Doppler, rotor)">TRACK</button>`}</div>
    <div class="satp-dbody">${polar}
      <table class="satp-facts">
        <tr><th>AOS</th><td>${satTime(aos.t)}</td><td>az ${Math.round(aos.az)}°</td></tr>
        <tr><th>Max</th><td>${satTime(top.t)}</td><td>el ${top.el.toFixed(1)}°, az ${Math.round(top.az)}°</td></tr>
        <tr><th>LOS</th><td>${satTime(los.t)}</td><td>az ${Math.round(los.az)}°</td></tr>
        <tr><th>Length</th><td colspan="2">${satDur(los.t - aos.t)}</td></tr>
        <tr><th>Nearest</th><td colspan="2">${Math.round(near.range)} km</td></tr>
        <tr><th>Doppler</th><td colspan="2">±${(dop * 145.9 / 1000).toFixed(1)} kHz at 145.9 MHz, ±${(dop * 435 / 1000).toFixed(1)} kHz at 435 MHz</td></tr>
        <tr><th>Elements</th><td colspan="2">${((aos.t - d.tle_epoch) / 86400).toFixed(1)} days old at AOS</td></tr>
        <tr><th>Now</th><td colspan="2" id="satNowText">–</td></tr>
      </table></div>
    <div class="satp-elchart" id="satElChart"></div>
    ${amsatPage === "track" ? '<p class="muted small" id="satPolarNote">Red cross: the antenna now. A click on the polar plot turns the antenna there, a click on the elevation chart sets only the elevation (not while TRACK moves the rotor).</p>'
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
  const s = d.samples, W = Math.max(box.clientWidth, 260), H = track ? 170 : 120, L = 34, B = 18, T = 8;
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
  if (ex && box && box._x) {     // the elevation of the antenna now (above the horizon; over 90 = looking back), at the time now
    const now = Math.min(Math.max(Date.now() / 1000, box._t0), box._t1), X = box._x(now), Y = box._y(info.el);
    ex.setAttribute("transform", `translate(${X.toFixed(1)},${Y.toFixed(1)})`);
    ex.setAttribute("visibility", "visible");
    const t = $("satElRotT");      // the real elevation of the rotor
    if (t) {
      t.textContent = `EL ${Math.round(info.el)}°`;
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
function satTickNow() {
  const d = satDetail, dot = $("satNowDot");
  if (!d || !dot) return;
  const now = Date.now() / 1000, s = d.samples;
  const on = now >= s[0].t && now <= s[s.length - 1].t;
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
          Received = sent × (1 − range rate / c), calculated every 0.25 s; the VFO is retuned when it is off by more than 20 Hz (SSB, CW), 500 Hz (AM) or 1 kHz (FM), at most once a second.
          Tuning the VFO by hand moves the frequency within the transponder and the correction keeps it; tuning more than 50 kHz outside the transponder stops it.
          Transmitters: <a href="https://db.satnogs.org/" target="_blank" rel="noopener noreferrer">SatNOGS DB</a>, downloaded again after 7 days.</p>
      </div>
      <div class="satt-right">
        <h4>Rotor</h4>
        <div class="satt-live" id="satRotBox"></div>
        <div class="sats-row satt-start">
          <button class="key small" id="satRotStart" title="On: plan the next pass, turn the rotor to its start in time and follow it; the rotor moves only while CTRL is on (with CTRL off it only calculates). Off: tracking ends, the rotor stays">TRACK</button>
          <span id="satPanelSlot"></span></div>
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
    satRot = await satFetch("/api/sat/rotor");
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
  if ($("satRotStart")) $("satRotStart").classList.toggle("on", !!(d && d.on) && !other);
  if (!d) { box.innerHTML = '<p class="muted">Loading…</p>'; return; }
  if (other) {
    const shown = satData && satData.sats.find((s) => s.norad === satTrackNorad);
    box.innerHTML = `<p><b>The rotor follows ${escHtml(satShort(d.name))}</b> (${escHtml(d.state)}).
      <span class="muted">TRACK switches it to ${escHtml(shown ? satShort(shown.name) : String(satTrackNorad))}.</span></p>`;
    return;
  }
  if (!d.on) {
    box.innerHTML = `<p><b>Tracking with the rotor is off.</b>${d.rotor_on ? "" : ' <span class="muted">(rotor link off: SET, ROTOR tab; TRACK then only calculates)</span>'}
      ${d.stopped ? `<span class="${d.stopped === "stopped by hand" ? "muted" : "error"}">Stopped: ${escHtml(d.stopped)}</span>` : ""}</p>`;
    return;
  }
  const p = d.pass, pl = d.plan, n = d.now || {};
  let html = `<table class="satp-facts"><tr><th>Tracking</th><td><b class="satt-sat">${escHtml(satShort(d.name))}</b> · ${escHtml(d.state)}</td></tr>`;
  if (p && pl) {
    html += `<tr><th>Pass</th><td>${satDay(p.aos)} ${satClock(p.aos)} – ${satClock(p.los)}, max. ${p.max_el}°${d.state === "waiting for the pass" && d.prep_at ? ` · turns to the start at ${satClock(d.prep_at)}` : ""}</td></tr>
      <tr><th>Plan</th><td>${escHtml(SAT_ROT_MODES[pl.mode] || pl.mode)}</td></tr>
      <tr><th></th><td>K3NG ${Math.round(pl.raw0)}° → ${Math.round(pl.raw1)}° (range ${Math.round(pl.raw_min)}–${Math.round(pl.raw_max)}°), elevation up to ${Math.round(pl.el_max)}°;
        simulated pointing error up to ${pl.max_err}° (mean ${pl.mean_err}°)</td></tr>`;
    const others = pl.options.filter((o, i, a) => o.mode !== pl.mode && a.findIndex((x) => x.mode === o.mode) === i);
    if (others.length) html += `<tr><th></th><td class="muted">Other ways: ${others.map((o) => `${o.mode} ${o.max_err}°`).join(", ")}</td></tr>`;
  }
  if (n.cmd_az != null) html += `<tr><th>Command</th><td>az ${Math.round(n.cmd_az)}° (K3NG ${Math.round(n.cmd_raw)}°), el ${Math.round(n.cmd_el)}°</td></tr>`;
  if (n.sat_az != null) html += `<tr><th>Satellite</th><td>az ${Math.round(n.sat_az)}°, el ${n.sat_el.toFixed(1)}°${n.err != null ? ` · the antenna is ${n.err}° off` : ""}</td></tr>`;
  if (d.note) html += `<tr><th>Rotor</th><td class="${d.control && d.rotor_on ? "error" : "muted"}">${escHtml(d.note)}</td></tr>`;
  box.innerHTML = html + "</table>";
}

async function satRotSend(body) {
  try {
    satRot = await satFetch("/api/sat/rotor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    amsatInfo(satRot.on ? `Rotor tracking: ${satShort(satRot.name)}` : "Rotor tracking off");
  } catch (e) {
    if (body.start && !body.start.force && /days old/.test(e.message) && confirm(`${e.message}\n\nTrack anyway?`)) {
      return satRotSend({ start: { ...body.start, force: true } });
    }
    amsatInfo(e.message, true);
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
  if (e.target.id === "satRotStart") satRotSend(satRot && satRot.on && satRot.norad === satTrackNorad ? { stop: true } : { start: { norad: satTrackNorad } });
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
  if (satPick) { satPick.remove(); satPick = null; }
  satQthMode = "latlon";
  const chosen = new Set(s.sats);
  body.innerHTML = `<div class="sats-setup">
    <section><h4>Station</h4>
      <div class="sats-row"><label>Locator <input id="satLoc" value="${escHtml(s.locator)}" maxlength="8" size="8"></label>
        <span class="muted">or</span>
        <label>Latitude <input id="satLat" type="number" step="0.0001" value="${s.lat}"></label>
        <label>Longitude <input id="satLon" type="number" step="0.0001" value="${s.lon}"></label>
        <button class="key small" id="satPickBtn" title="Choose the place on an OpenStreetMap map (needs internet)">CHOOSE ON MAP</button></div>
      <div class="sats-pick" id="satPickMap" hidden></div>
      <p class="muted small" id="satPickNote" hidden>Click the place of the antenna, then SAVE. Map tiles: OpenStreetMap, need internet.</p>
      <div class="sats-row"><label>Altitude <input id="satAlt" type="number" step="1" value="${s.alt_m}"> m</label>
        <label>Passes from <input id="satMinEl" type="number" min="0" max="60" step="1" value="${s.min_el}">° of elevation</label>
        <button class="key small" id="satSaveQth">SAVE</button></div>
      <p class="muted small">A locator gives the centre of its square (JN88WQ: about 2 km from any point in it; enough for tracking). Latitude and longitude
        give an exact point. The same station is used on all VFOs.</p></section>
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
    const loc = $("satLoc").value.trim().toUpperCase(), body = { alt_m: Number($("satAlt").value), min_el: Number($("satMinEl").value) };
    if (satQthMode === "loc" && loc) body.locator = loc;
    else { body.lat = Number($("satLat").value); body.lon = Number($("satLon").value); }
    if (await satSetupLoad(body)) amsatInfo("Saved");
    return;
  }
  if (e.target.id === "satPickBtn") {
    satPickOpen();
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
  if (e.target.id === "satLoc") satQthMode = "loc";
  if (e.target.id === "satLat" || e.target.id === "satLon") satQthMode = "latlon";
  if (e.target.id !== "satFilter") return;
  satChoiceFilter();
});

window.addEventListener("resize", () => {
  if (bodyTab === "sat" && amsatPage === "passes" && satData) { renderSatTimeline(); renderSatElChart(); satTickNow(); }
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

// ---------- station on an OpenStreetMap map (SETUP) ----------

let satPick = null;     // Leaflet map
let satQthMode = "latlon";   // which fields SAVE uses: "loc" after typing a locator, else latitude and longitude

async function satPickOpen() {
  const box = $("satPickMap");
  if (!box) return;
  box.hidden = false;
  $("satPickNote").hidden = false;
  try {
    await Promise.all([satAsset("/static/leaflet/leaflet.css"), satAsset("/static/leaflet/leaflet.js")]);
  } catch (e) {
    $("satPickNote").textContent = e.message;
    return;
  }
  const lat = Number($("satLat").value), lon = Number($("satLon").value);
  if (satPick) satPick.remove();
  satPick = L.map(box, { worldCopyJump: true }).setView([lat, lon], 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  }).addTo(satPick);
  const mark = L.circleMarker([lat, lon], { radius: 7, color: "#000", weight: 2, fillColor: "#ffd84a", fillOpacity: 1 }).addTo(satPick);
  satPick.on("click", (ev) => {
    const p = ev.latlng.wrap();
    mark.setLatLng(p);
    $("satLat").value = p.lat.toFixed(5);
    $("satLon").value = p.lng.toFixed(5);
    $("satLoc").value = satLocator(p.lat, p.lng);
    satQthMode = "latlon";
    amsatInfo(`Chosen ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} (${satLocator(p.lat, p.lng)}): SAVE keeps it`);
  });
}

// ---------- ACARS ----------

const ACARS_MAX_ROWS = 300;

let linkFreqs = { acars: [], vdl2Center: 0, vdl2Rate: 0, vdl2RegionFreqs: {} };
let linkShown = null;

/** Band buttons, title and notes of the ACARS and CPDLC cards by the active link:
 *  ACARS = the classic channels, VDL2 = one centre button (all channels of the region are received at once) and the region. */
function renderLinkBands() {
  const vdl2 = !!(st && st.vdl2);
  if (vdl2 === linkShown) return;
  linkShown = vdl2;
  const f = linkFreqs;
  const html = vdl2
    ? `<button data-vdl2="1">${fmtMHz(f.vdl2Center, 3)}</button>` +
      `<button data-region="eu">EU</button><button data-region="us">US</button>`
    : f.acars.map((x) => `<button data-f="${x}" title="${fmtMHz(x, 3)} MHz AM">${fmtMHz(x, 3)}</button>`).join("");
  $("acarsBands").innerHTML = html;
  renderVdl2Region();
  $("acarsTitle").textContent = vdl2 ? "VDL2" : "ACARS";
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
  const m = { id: c.id, time: c.time, freq_hz: c.freq_hz, link: c.link, vdl2: c.vdl2, reg: c.reg, flight: "", label: "",
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
  }
}

function renderAcarsInfo(i) {
  if (!st) return;
  $("acarsCard").hidden = !(st.acars || st.vdl2);
  if (!i) return;
  $("acarsInfo").textContent = `${i.count} messages${i.crc_errors ? ` · ${i.crc_errors} CRC errors` : ""}`;
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

const dabEsc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** DAB key in DECODE: DAB on (the server tunes the VFO to the saved channel at 2.048 MS/s). */
function dabOn() {
  if (noRtlDongle(st) || st.chain_owner) {
    errorUntil = Date.now() + 5000;
    renderStatusPill(st.chain_owner ? `DAB needs its own dongle (this VFO shares the dongle of VFO ${st.chain_owner})`
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
  setBodyTab("dec");
  renderDecTab();
}

function renderDab(s) {
  const on = !!s.dab;
  $("dabCard").hidden = !on;
  $("dabKey").classList.toggle("on", on);
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

function renderDabSide(m, cur) {
  const snr = m.snr == null ? null : Number(m.snr);
  const quality = snr == null ? ["", ""] : snr >= 12 ? ["good", "#3cf07c"] : snr >= 8 ? ["usable", "#ffd84a"] : ["weak", "#ff7b6b"];
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
  dabMotTime = 0;
  $("dabSlide").hidden = true;
  $("dabSlide").removeAttribute("src");
  $("dabGlow").style.backgroundImage = "";
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

$("dabSlide").addEventListener("load", () => {
  $("dabSlide").hidden = false;
  $("dabGlow").style.backgroundImage = `url("${$("dabSlide").src}")`;
});
$("dabFlag").addEventListener("load", () => { $("dabFlag").hidden = false; });
$("dabFlag").addEventListener("error", () => { $("dabFlag").hidden = true; });
$("dabSlide").addEventListener("error", () => { $("dabSlide").hidden = true; });
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
/** DAB off (DAB key again, another band button, or OFF in the card): the previous sample rate comes back. */
function dabOff() {
  st.dab = false;
  send({ dab: false });
  renderDab(st);
  renderDecTab();
}
$("dabOff").addEventListener("click", dabOff);
$("dabKey").addEventListener("click", () => { if (st) { if (st.dab) dabOff(); else dabOn(); } });

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

function renderWefaxInfo(i) {
  const afc = i.afc ? `centre ${i.center_hz} Hz ✓` : "searching for signal";
  $("wefaxInfo").textContent = `${WFX_STATES[i.state] || i.state} · ${i.lpm} LPM · IOC ${i.ioc} · ${afc}` +
    (i.rows ? ` · ${i.rows} lines` : "") + (i.saved ? ` · saved ${i.saved}` : "");
  if (document.activeElement !== $("wefaxLpm")) $("wefaxLpm").value = i.lpm_mode;
  if (document.activeElement !== $("wefaxIoc")) $("wefaxIoc").value = i.ioc_mode;
  if (i.slant_ppm != null) {
    wfxSlant = i.slant_ppm;
    if (document.activeElement !== $("wefaxSlant")) $("wefaxSlant").value = i.slant_ppm;
  }
}

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
      return `<a href="${u}" target="_blank" title="${n}"><img src="${u}" loading="lazy" alt=""><span>${n.slice(5, 20).replace("_", " ")}</span></a>`;
    }).join("");
  }
}

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
$("ismOff").addEventListener("click", ismOff);
$("ismBands").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (b && st) send({ ism_hz: Number(b.dataset.f) });
});
$("ismClear").addEventListener("click", () => {
  fetch(vbase + "/api/ism", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"clear"}' });
  ismReset();
  renderIsmInfo({ count: 0 });
});

// ---------- DSD: digital voice (a mode, not a DECODE key: it replaces the audio) ----------

const DSD_MAX_ROWS = 300;
let dsdModeWas = null;   // mode of this VFO in the last state: selecting DSD opens the DECODERS tab, a restored state does not

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
  const on = s.mode === "DSD";
  if (on && dsdModeWas === false) setBodyTab("dec");
  dsdModeWas = on;
  $("dsdCard").hidden = !on;
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

// ---------- SET and MEM drawers, clock, CW row ----------

const DRAWERS = { setKey: "settingsCard", memKey: "memCard" };

function openDrawer(id) {
  for (const [key, d] of Object.entries(DRAWERS)) {
    $(d).hidden = d !== id;
    $(key).classList.toggle("on", d === id);
  }
  if (id) placeFloating[id]();
  if (id === "memCard") $("memSearch").focus();
}
for (const [key, d] of Object.entries(DRAWERS)) {
  $(key).addEventListener("click", () => openDrawer($(d).hidden ? d : null));
}
for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", () => openDrawer(null));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || Object.values(DRAWERS).every((d) => $(d).hidden)) return;
  // the radio stays usable behind the window: Esc in its fields (frequency entry) must not close the window
  if (e.target.closest("input, select, textarea") && !e.target.closest(".drawer")) return;
  openDrawer(null);
});

// A floating window is moved by its title bar; the place is remembered in the browser. It is inside the scaled
// .stage, so everything here is in stage px (screen px / uiScale). The title bar always stays reachable, and
// the window is only as tall as the space below its top edge (the rest of it scrolls). Returns the placing function.
const FLOAT_KEEP_W = 160, FLOAT_KEEP_H = 100, FLOAT_MARGIN = 8;
function makeFloating(win, storeKey) {
  const head = win.querySelector(".drawer-head");
  let pos = null;     // {x, y} once it has been moved, null = the place from the CSS
  let drag = null;    // {dx, dy} from the top left corner of the window to the pointer
  try { pos = JSON.parse(recall(storeKey)); } catch (e) { /* bad value: the default place */ }

  function place() {
    if (!pos || win.hidden) return;
    const stage = $("stage");
    const x = Math.max(FLOAT_KEEP_W - win.offsetWidth, Math.min(pos.x, stage.clientWidth - FLOAT_KEEP_W));
    const y = Math.max(0, Math.min(pos.y, stage.clientHeight - FLOAT_KEEP_H));
    win.style.left = `${x}px`;
    win.style.right = "auto";
    win.style.top = `${y}px`;
    win.style.maxHeight = `${stage.clientHeight - y - FLOAT_MARGIN}px`;
  }
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    const r = win.getBoundingClientRect();
    drag = { dx: (e.clientX - r.left) / uiScale, dy: (e.clientY - r.top) / uiScale };
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    pos = { x: e.clientX / uiScale - drag.dx, y: e.clientY / uiScale - drag.dy };
    place();
  });
  for (const type of ["pointerup", "pointercancel"]) {
    head.addEventListener(type, () => {
      if (!drag) return;
      drag = null;
      if (!win.style.left) return;     // pressed without moving, it stays at the place from the CSS
      pos = { x: parseFloat(win.style.left), y: parseFloat(win.style.top) };
      store(storeKey, JSON.stringify(pos));
    });
  }
  window.addEventListener("resize", place);
  return place;
}
const placeFloating = Object.fromEntries(Object.values(DRAWERS).map((d) => [d, makeFloating($(d), `${d}Pos`)]));

// Tabs of the SET window; the open one is remembered in the browser.
function showSetTab(name) {
  for (const b of document.querySelectorAll("[data-set-tab]")) {
    const on = b.dataset.setTab === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on);
  }
  for (const p of document.querySelectorAll("[data-set-panel]")) p.hidden = p.dataset.setPanel !== name;
}
for (const b of document.querySelectorAll("[data-set-tab]")) {
  b.addEventListener("click", () => { showSetTab(b.dataset.setTab); store("setTab", b.dataset.setTab); });
}
// TX is left out here: its key is hidden until the state says the dongle can transmit.
if (["audio", "display", "rotor"].includes(recall("setTab"))) showSetTab(recall("setTab"));

// ---------- ROTOR tab of SET: K3NG rotor (rotor.py) ----------

let rotorPortsFor = null;     // the address of the VFO the port list belongs to
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
    const res = await fetch(vbase + "/api/rotor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

function renderRotor(info) {
  $("rotorEnabled").checked = info.on;
  $("rotorPos").textContent = info.az == null ? "–" : `AZ ${Math.round(info.az)}°  EL ${Math.round(info.el ?? 0)}°`;
  $("rotorTarget").textContent = info.target
    ? `Moving to AZ ${Math.round(info.target[0])}° EL ${Math.round(info.target[1])}° (${info.source})` : "No target";
  rotorShowError(info.fault ? `Fault: ${info.fault}` : info.error);
  $("rotorReset").hidden = !info.fault;
  $("rotorRaw").textContent = info.k3ng_az == null ? ""
    : `K3NG now: ${Math.round(info.k3ng_az)}°${info.k3ng_guess ? " (0–90 or 360–450 not known yet: decided at the first move)" : ""}.`;
  if (info.az_cal) {
    for (const [id, v] of [["rotorCal0", info.az_cal[0]], ["rotorCal450", info.az_cal[1]]]) {
      if (document.activeElement !== $(id)) $(id).value = v;
    }
  }
  renderSat(info);
}

// ---------- rotor control on the TRACK page: CTRL, STOP and the error line ----------
const satPanel = $("satPanel");      // CTRL, STOP, error: moved into the TRACK page when it is shown
const $p = (id) => satPanel.querySelector("#" + id);

function renderSat(info) {
  satInfo = info;
  satPolarRotor();
  $p("satCtrl").classList.toggle("on", !!info.control);
  $p("satCtrl").disabled = !info.on;
}

let satInfo = null;     // the last rotor state, for the clicks

// -> why the plots do not take a click now, "" if they do
function satDialRefusal(info) {
  if (!info || !info.connected) return "Rotor is not connected";
  if (info.fault) return "Reset the fault in SET, ROTOR tab";
  if (info.tracker) return "Satellite tracking moves the rotor (SATELLITES tab, TRACK): stop it to set the position by hand";
  if (info.az == null) return "Rotor position is not known yet";
  return "";
}

// SAT key: the SATELLITES tab, on the TRACK page when the rotor is to be seen at once.
$("satKey").addEventListener("click", () => setBodyTab(bodyTab === "sat" ? "scope" : "sat"));
$("satCtrl").addEventListener("click", (e) => rotorPost(e.currentTarget.classList.contains("on") ? { stop: true } : { start: true }));
$("satStop").addEventListener("click", () => rotorPost({ stop: true }));

async function pollRotor() {
  const panel = document.querySelector('[data-set-panel="rotor"]');
  const setOpen = !panel.hidden && !$("settingsCard").hidden;
  if (!setOpen) rotorPortsFor = null;
  const trackOpen = bodyTab === "sat" && amsatPage === "track" && !document.hidden;     // the antenna on the polar plot
  if (!setOpen && !trackOpen) return;
  const needPorts = setOpen && rotorPortsFor !== vbase;
  try {
    const info = await fetch(vbase + `/api/rotor${needPorts ? "?ports=1" : ""}`).then((r) => r.json());
    if (needPorts) { fillRotorPorts(info); rotorPortsFor = vbase; }
    renderRotor(info);
  } catch (e) {
    rotorShowError("Receiver is not reachable");
  }
}

$("rotorRefresh").addEventListener("click", () => { rotorPortsFor = null; pollRotor(); });
$("rotorEnabled").addEventListener("change", (e) => {
  const opt = $("rotorPort").selectedOptions[0];
  if (e.target.checked && !opt?.value) {
    e.target.checked = false;
    rotorShowError("Choose a port first", true);
    return;
  }
  rotorPost({ enabled: e.target.checked, port: opt?.value || "", usb_serial: opt?.dataset.usbSerial || "" });
});
$("rotorStop").addEventListener("click", () => rotorPost({ stop: true }));
$("rotorReset").addEventListener("click", () => rotorPost({ reset: true }));
$("rotorCalSave").addEventListener("click", () => {
  if ($("rotorCal0").value === "" || $("rotorCal450").value === "") { rotorShowError("Enter both azimuths", true); return; }
  rotorPost({ az_cal: [Number($("rotorCal0").value), Number($("rotorCal450").value)] });
});
$("rotorGo").addEventListener("click", () => {
  if ($("rotorAz").value === "" || $("rotorEl").value === "") { rotorShowError("Enter azimuth and elevation", true); return; }
  rotorPost({ goto: [Number($("rotorAz").value), Number($("rotorEl").value)] });
});
setInterval(pollRotor, 500);

// A click on the clock switches UTC / local time (LOC); the choice is remembered.
let clockLocal = recall("clockLocal") === "1";

function tickClock() {
  const d = new Date();
  const t = clockLocal
    ? [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":")
    : d.toISOString().slice(11, 19);
  $("clock").innerHTML = seg7(t);
  $("clock").setAttribute("aria-label", `${t} ${clockLocal ? "local time" : "UTC"}`);
  $("zoneLoc").classList.toggle("on", clockLocal);
  $("zoneUtc").classList.toggle("on", !clockLocal);
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


// ---------- memories ----------

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function loadMems() {
  mems = await fetch(vbase + "/api/memories").then((r) => r.json());
  renderMemGroups();
  renderMems();
}

function renderMemGroups() {
  const groups = [...new Set(mems.map((m) => m.group))].sort((a, b) => a.localeCompare(b, "en"));
  const sel = $("memGroup");
  const cur = sel.value || recall("memGroup") || "";
  sel.innerHTML = `<option value="">All</option>` + groups.map((g) => `<option>${escHtml(g)}</option>`).join("");
  sel.value = groups.includes(cur) ? cur : "";
  $("memGroups").innerHTML = groups.map((g) => `<option value="${escHtml(g)}">`).join("");
  updateExportLabel();
}

function renderMems() {
  drawOverlays();   // memory tags in the spectrum
  renderVfoDisplays();   // memory name above each VFO
  const q = $("memSearch").value.trim().toLowerCase();
  const group = $("memGroup").value;
  const favOnly = $("memFav").checked;
  const list = mems.filter((m) => (!group || m.group === group) && (!favOnly || m.fav) &&
    (!q || m.name.toLowerCase().includes(q) || fmtKHz(m.freq_hz, 3).replace(/\s/g, "").includes(q.replace(/\s/g, ""))))
    .sort((a, b) => a.freq_hz - b.freq_hz);
  $("memCount").textContent = `${list.length} / ${mems.length}`;
  if (!list.length) {
    $("memList").innerHTML = `<div class="mem-empty">${mems.length ? "Nothing matches the filter." : "No memories yet."}</div>`;
    return;
  }
  // When all groups are shown, group by band (MHz), otherwise the list is just sorted.
  let html = "";
  let lastMhz = null;
  for (const m of list) {
    const mhz = Math.floor(m.freq_hz / 1e6);
    if (!group && mhz !== lastMhz) { html += `<div class="mem-group">${mhz} MHz</div>`; lastMhz = mhz; }
    html += `<div class="mem" data-id="${m.id}" title="${escHtml(m.name)} · ${escHtml(m.group)} · ${fmtBw(m.bw)}">` +
      `<button class="star${m.fav ? " on" : ""}" data-star aria-label="Favourite">${m.fav ? "★" : "☆"}</button>` +
      `<span class="name">${escHtml(m.name)}</span>` +
      `<span class="meta">${m.freq_hz >= 30e6 ? `${fmtMHz(m.freq_hz, 4)} M` : fmtKHz(m.freq_hz, 2)}<b>${m.dab_channel ? `DAB ${escHtml(m.dab_channel)}` : m.mode}</b></span>` +
      `<button class="del" data-del aria-label="Delete">×</button></div>`;
  }
  $("memList").innerHTML = html;
  markActiveMem();
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

function markActiveMem() {
  if (!st) return;
  for (const el of $("memList").querySelectorAll(".mem")) {
    const m = mems.find((x) => x.id === el.dataset.id);
    el.classList.toggle("active", !!m && (m.dab_channel ? !!st.dab && st.dab_channel === m.dab_channel
      : !st.dab && Math.abs(m.freq_hz - st.tune_hz) < 50 && m.mode === st.mode));
  }
}

$("memList").addEventListener("click", async (e) => {
  const row = e.target.closest(".mem");
  if (!row || !st) return;
  const m = mems.find((x) => x.id === row.dataset.id);
  if (!m) return;
  if (e.target.closest("[data-del]")) {
    if (!confirm(`Delete memory "${m.name}"?`)) return;
    const res = await fetch(`${vbase}/api/memories/${m.id}`, { method: "DELETE" });
    if (res.ok) { mems = mems.filter((x) => x !== m); renderMemGroups(); renderMems(); }
    return;
  }
  if (e.target.closest("[data-star]")) {
    m.fav = !m.fav;
    renderMems();
    fetch(`${vbase}/api/memories/${m.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fav: m.fav }) });
    return;
  }
  recallMem(m);
});

/** Recall a memory: frequency, mode and bandwidth (on a VFO that can receive the frequency). A DAB memory: DAB on with its channel. */
async function recallMem(m) {
  await ensureVfoFor(m.freq_hz);
  if (!st) return;
  if (m.dab_channel) {
    dabRecall(m.dab_channel);
    markActiveMem();
    return;
  }
  if (st.dab) dabOff();   // an ordinary memory ends DAB like another band does (previous sample rate back)
  st.mode = m.mode;
  st.bandwidth[m.mode] = m.bw;
  renderControls();
  tune(m.freq_hz);
  send({ mode: m.mode, bandwidth: m.bw });
  markActiveMem();
}

$("memSave").addEventListener("click", async () => {
  if (!st) return;
  const dabName = st.dab ? ["DAB", st.dab_channel, dabLastInfo.ensemble].filter(Boolean).join(" ") : "";
  const name = $("memName").value.trim() || dabName || `${fmtKHz(st.tune_hz, 2)} kHz ${st.mode}`;
  const body = { name, group: $("memGroupNew").value.trim() || $("memGroup").value || "My",
    freq_hz: st.tune_hz, mode: st.mode, bw: st.bandwidth[st.mode], ...(st.dab ? { dab_channel: st.dab_channel } : {}) };
  const res = await fetch(vbase + "/api/memories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  $("memError").hidden = res.ok;
  if (!res.ok) { $("memError").textContent = data.error || "Error"; return; }
  mems.push(data);
  $("memName").value = "";
  renderMemGroups();
  renderMems();
});
$("memName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("memSave").click(); });
$("memSearch").addEventListener("input", renderMems);
$("memGroup").addEventListener("change", () => { store("memGroup", $("memGroup").value); renderMems(); });
$("memFav").addEventListener("change", renderMems);

// Import from SDR# (frequencies.xml in its installation folder) and export of memories to a JSON file.
function memIoNote(text, error) {
  const el = $("memIoNote");
  el.textContent = text;
  el.classList.toggle("error", !!error);
  el.hidden = !text;
}

function updateExportLabel() {
  const g = $("memGroup").value;
  $("memExportGroup").textContent = g ? `⇩ EXPORT ${g}` : "⇩ EXPORT ALL";
  $("memExportGroup").title = g ? `Downloads the group "${g}" as a JSON file` : "Downloads every memory as a JSON file";
}

function exportMems(list, label) {
  if (!list.length) { memIoNote(`Nothing to export (${label}).`, true); return; }
  const out = [...list].sort((a, b) => a.freq_hz - b.freq_hz);
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `radimcom-memories-${label.replace(/[^\w.-]+/g, "_")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  memIoNote(`Exported ${out.length} memories (${label}).`);
}

$("memSdrPath").value = recall("memSdrPath") || "C:\\sdrsharp";
$("memSdrPath").addEventListener("change", () => store("memSdrPath", $("memSdrPath").value.trim()));
$("memSdrPath").addEventListener("keydown", (e) => { if (e.key === "Enter") $("memImport").click(); });
$("memImport").addEventListener("click", async () => {
  const path = $("memSdrPath").value.trim();
  if (!path) { memIoNote("Enter the SDR# installation folder.", true); return; }
  store("memSdrPath", path);
  $("memImport").disabled = true;
  try {
    const res = await fetch(vbase + "/api/memories/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      memIoNote(data.error || `Import failed (HTTP ${res.status}${res.status === 405 || res.status === 404 ? " – restart RADIMCOM to load the new version" : ""})`, true);
      return;
    }
    const n = data.files.length;
    memIoNote(`Imported ${data.added}, skipped ${data.skipped} (duplicates / unsupported) from ${n} file${n === 1 ? "" : "s"}` +
      (n > 1 ? ` (${data.files.map((f) => f.split(/[\\/]/).slice(-2, -1)[0]).join(", ")})` : "") +
      (data.errors.length ? `. Failed: ${data.errors.join("; ")}` : "."), data.errors.length > 0);
    await loadMems();
  } catch (e) {
    memIoNote("Import failed: " + e.message, true);
  } finally {
    $("memImport").disabled = false;
  }
});
$("memImportJson").addEventListener("click", () => $("memJsonFile").click());
$("memJsonFile").addEventListener("change", async () => {
  const file = $("memJsonFile").files[0];
  $("memJsonFile").value = "";   // the same file can be chosen again
  if (!file) return;
  $("memImportJson").disabled = true;
  try {
    const res = await fetch(vbase + "/api/memories/import_json", { method: "POST", headers: { "Content-Type": "application/json" }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      memIoNote(data.error || `Import failed (HTTP ${res.status}${res.status === 405 || res.status === 404 ? " – restart RADIMCOM to load the new version" : ""})`, true);
      return;
    }
    memIoNote(`Imported ${data.added}, skipped ${data.skipped} (duplicates / invalid) from ${file.name}.`);
    await loadMems();
  } catch (e) {
    memIoNote("Import failed: " + e.message, true);
  } finally {
    $("memImportJson").disabled = false;
  }
});
$("memExportFav").addEventListener("click", () => exportMems(mems.filter((m) => m.fav), "starred"));
$("memExportGroup").addEventListener("click", () => {
  const g = $("memGroup").value;
  exportMems(g ? mems.filter((m) => m.group === g) : mems, g || "all");
});
$("memGroup").addEventListener("change", updateExportLabel);

// ---------- stav zo servera ----------

let sampleRates = [];

function onStatus(s) {
  const first = !st;
  const rateChanged = st && st.audio_rate !== s.audio_rate;
  // Shortly after a local change, do not let an older state from the server overwrite tuning and selection.
  if (st && Date.now() - localChangeAt < 700) {
    for (const k of ["tune_hz", "mode", "bandwidth", "zoom", "gain", "rtl_agc", "dc_remove", "dc_hz", "dc_db", "spur_on", "spur_hz", "spur_edge", "spur_shift", "spur_db", "spur_learning", "stereo_on", "notch", "ft8", "wefax", "cw", "rtty", "sstv", "acars", "cpdlc", "dab", "dab_channel", "dab_sids", "logs", "upconv", "device", "squelch_levels"]) s[k] = st[k];
  }
  s.sample_rates = sampleRates;
  st = s;
  renderRec();
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
    if (v === active) onRow(ev.c, ev.span, ev.row);
  });
  on("meter", (d) => { meterTarget = d.db; });
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
  on("cwtext", (d) => cwAppend(d.t));
  on("cwstate", renderCwInfo);
  on("rttytext", (d) => rttyOut.add(d.t));
  on("rttystate", renderRttyInfo);
  on("dsdcall", (c) => { addDsdCall(c); decActivity(); });
  on("acars", (m) => { acarsReceive(m); decActivity(); });
  on("cpdlc", (c) => { if (c.imi === "ATN") { addAtn(c, true); decActivity(); } });   // others come inside "acars"
  on("ft8", decActivity);
  on("cwtext", decActivity);
  on("rttytext", decActivity);
  on("wefaxnew", decActivity);
  on("sstvnew", decActivity);
  on("acarsstate", renderAcarsInfo);
  on("vdl2state", renderVdl2Info);
  on("dabstate", (d) => { if (st) renderDabInfo(d); });
  on("ism", (m) => { addIsm(m); if (m.n === 1) decActivity(); });
  on("ismstate", (d) => { if (st) renderIsmInfo(d); });
  on("acarsinfo", onAcarsInfo);
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
    row.innerHTML = `<div class="vfo-memname"></div><div class="vfo-head"><span class="flag vfo-stat off">NO SDR</span>` +
      `<button class="key vfo-key" disabled>VFO-${name}</button><span class="flag vfo-mode">---</span>` +
      `<span class="flag vfo-cue">CUE</span></div>` +
      `<div class="vfo-disp"><span class="rec-tag"></span><div class="freq">${seg7("          ")}<span class="unit"><span class="mute-tag" hidden></span><span class="afi-tag">AFI</span>MHz</span></div></div>` +
      `<div class="vfo-foot"><label class="vfo-rf"><span>RF GAIN</span>` +
      `<input type="range" min="0" max="1" value="0" disabled></label><span class="flag vfo-gain">--- dB</span></div>` +
      `<div class="vfo-foot"><label class="vfo-rf vfo-sq"><span>SQUELCH</span>` +
      `<input type="range" min="0" max="1" value="0" disabled></label><span class="flag vfo-sql">---</span></div>`;
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
      row.innerHTML = `<div class="vfo-memname"></div>` + (v.name ? `<div class="vfo-head"><span class="flag vfo-stat"></span>` +
        `<button class="key vfo-key">VFO-${v.name}</button><span class="flag vfo-mode"></span>` +
        `<span class="flag vfo-cue" role="button">CUE</span></div>` : "") +
        `<div class="vfo-disp"><span class="rec-tag"></span><div class="freq"></div></div>` +
        (v.name ? `<div class="vfo-foot"><label class="vfo-rf"><span>RF GAIN</span>` +
        `<input type="range" min="0" max="0" step="1" value="0"></label>` +
        `<span class="flag vfo-gain" title="RF gain"></span></div>` +
        `<div class="vfo-foot vfo-sqrow"><label class="vfo-rf vfo-sq"><span>SQUELCH</span>` +
        `<input type="range" min="${SQUELCH_OFF}" max="-20" step="1" value="${SQUELCH_OFF}"></label>` +
        `<span class="flag vfo-sql"></span></div>` : "");
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
        fr.innerHTML = seg7(txt) + `<span class="unit"><span class="mute-tag" title="Audio muted while the ACARS, VDL2 or ISM decoder runs" hidden></span><span class="afi-tag">AFI</span>${unit}</span>`;
        fr.setAttribute("aria-label", `${fmtMHz(s.tune_hz, 6)} MHz`);
      }
      // AFI above the unit: lit while this VFO's audio is inverted (no AFI in WFM), otherwise dark like an unlit LCD segment
      const afiTag = fr.querySelector(".afi-tag");
      if (afiTag) afiTag.classList.toggle("on", !!s.afi && s.mode !== "WFM");
      const muteTag = fr.querySelector(".mute-tag");
      if (muteTag) muteTag.hidden = !s.audio_muted;
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
    memEl.title = trsp ? `Doppler correction: ${trsp}` : mem ? `${mem.name} · ${mem.group} · ${mem.mode} · ${fmtBw(mem.bw)}`
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
    // RUNNING is shown as a USB icon (dongle connected and delivering data), other states as text.
    const stHtml = stTxt === "RUNNING" ? USB_ICON : stTxt;
    if (stat.dataset.html !== stHtml) { stat.innerHTML = stHtml; stat.dataset.html = stHtml; }
    stat.className = `flag vfo-stat ${stCls}${stTxt === "RUNNING" ? " usb" : ""}`;
    stat.title = stTitle;
    const mode = row.querySelector(".vfo-mode"), gain = row.querySelector(".vfo-gain"), sql = row.querySelector(".vfo-sql");
    // without a state only make it invisible, so the layout does not shift
    mode.style.visibility = gain.style.visibility = sql.style.visibility = s ? "" : "hidden";
    if (s) {
      mode.textContent = s.mode;
      gain.textContent = s.gain === "auto" ? "AGC" : gainLabel(s);
      // slider: disabled with AGC (as in SET); while dragging, the state from the server does not overwrite it
      const rf = row.querySelector(".vfo-rf input");
      const gains = s.gains || [];
      rf.disabled = s.gain === "auto" || !gains.length;
      rf.max = Math.max(gains.length - 1, 0);
      if (document.activeElement !== rf && gains.length && s.gain !== "auto") {
        let best = 0;
        gains.forEach((g, i) => { if (Math.abs(g - s.gain) < Math.abs(gains[best] - s.gain)) best = i; });
        rf.value = best;
      }
      // squelch only in AM/FM/WFM; in other modes it stays in place but dimmed and inactive
      const levels = s.squelch_levels || {};
      const sqOk = s.mode in levels, lvl = sqOk ? levels[s.mode] : SQUELCH_OFF;
      const sq = row.querySelector(".vfo-sq input");
      row.querySelector(".vfo-sqrow").classList.toggle("na", !sqOk);
      sq.disabled = !sqOk;
      if (document.activeElement !== sq) sq.value = lvl;
      sql.textContent = !sqOk || lvl <= SQUELCH_OFF ? "OFF" : `${lvl} dB`;
      sql.title = !sqOk ? `squelch not available in ${s.mode}` : lvl <= SQUELCH_OFF ? "squelch off" : `squelch ${lvl} dBFS (${sReading(lvl)})`;
    }
    const cue = row.querySelector(".vfo-cue");
    cue.classList.toggle("on", !!v.cue);
    cue.title = v.cue ? `CUE on: VFO ${v.name} stays audible at CUE level (click to turn off)`
      : `CUE off (click to keep hearing VFO ${v.name} when another VFO is selected)`;
    row.classList.toggle("tx", !!(s && s.tx));
    // Squelch open on an inactive VFO: the button lights up to show activity.
    row.classList.toggle("busy", !!(s && !isActive && s.squelch > SQUELCH_OFF && s.squelch_open));
  }
  renderTx();
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
  errorUntil = Date.now() + 5000;
  renderStatusPill(`TX: ${msg}`);
}

function renderTx() {
  const on = !!ptt || vfos.some((v) => v.st && v.st.tx);
  const f = $("rxtxFlag");
  f.textContent = on ? "TX" : "RX";
  f.classList.toggle("tx", on);
}

const isSpace = (e) => e.code === "Space" && !e.target.closest("input, select, textarea");
document.addEventListener("keydown", (e) => {
  if (!isSpace(e)) return;
  e.preventDefault();               // the space bar must not press the focused button or scroll the page
  if (!e.repeat) pttDown();
});
document.addEventListener("keyup", (e) => { if (isSpace(e)) { e.preventDefault(); pttUp(); } });
window.addEventListener("blur", pttUp);
document.addEventListener("visibilitychange", () => { if (document.hidden) pttUp(); });

async function selectVfo(v) {
  if (!v || v === active) return;
  pttUp();
  flushSend();
  stopAudio();
  stopDab();
  active = v;
  vbase = v.base;
  store("vfo", v.name);
  restoreBodyTab();
  // Everything shown belongs to the previous VFO: state, waterfall, decoders.
  closeFreqInput();
  st = null; view = null; wfRow = null; spec = null; floor = null;
  errorUntil = 0; convPrev = null;
  for (const id of ["modes", "bandwidths", "steps"]) $(id)._html = null;
  $("ft8Rows").innerHTML = ""; $("ft8Empty").hidden = false; ft8Cycle = null; ft8Count = 0;
  cwOut.clear(); rttyOut.clear();
  acarsResume();
  acarsDropHeld();
  $("acarsRows").innerHTML = ""; $("acarsEmpty").hidden = false; renderAcarsFilter();
  dsdReset();
  ismReset();
  $("convWarn").hidden = true;
  if (v.st) {
    onStatus(v.st);
    for (const r of v.rows) onRow(r.c, r.span, r.row, true);
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
  renderAcarsInfo(ac);
}

// ---------- upconverter switch (VFO with upconverter in Auto mode) ----------
// The upconverter has only a manual switch: crossing 30 MHz needs a clear warning.

let convPrev = null;

function renderConv() {
  const has = st.upconv === "auto" && st.lo_offset_hz > 0;
  $("convBadge").hidden = !has;
  if (!has) { $("convWarn").hidden = true; return; }
  const needConv = st.tune_hz < 30e6;
  $("convBadge").textContent = needConv ? "CONV" : "BYPASS";
  $("convBadge").classList.toggle("warn", !needConv);
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

// ---------- recording (MP3, on the server, data\recordings) ----------
// The buttons switch the recording of the active VFO; it goes on without the page, so the state comes from the receiver.
const REC_BUTTONS = [
  { btn: "recBtn", time: "recTime", key: "cont", send: "rec", label: "REC",
    title: "Record everything to MP3 until switched off, a new file every 15 min (data\\recordings)" },
  { btn: "recSqBtn", time: "recSqTime", key: "squelch", send: "rec_sq", label: "REC SQ",
    title: "Record to MP3 only while the squelch is open, each session in its own file (data\\recordings)" },
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
    if (r.error && r.error !== recErrors[b.key]) { errorUntil = Date.now() + 5000; renderStatusPill(r.error); }
    recErrors[b.key] = r.error;
  }
}

for (const b of REC_BUTTONS) {
  $(b.btn).addEventListener("click", () => {
    const r = (st && st.recording && st.recording[b.key]) || {};
    send({ [b.send]: !r.on });
  });
}
renderRec();

// ---------- stereo level meter next to the sliders ----------
// LEDs from the bottom up: 10 green up to 0 dB, then yellow (+3 dB) and red (+6 dB = 0 dBFS, clipping).
// 0 dB of the meter = −6 dBFS, so yellow and red warn before clipping.
const VU_STEPS = [-40, -30, -25, -20, -15, -12, -9, -6, -3, 0, 3, 6];
const VU_REF_DBFS = -6;
let vuAnalysers = null;
const vuLevel = [-99, -99];
const vuBuf = new Float32Array(1024);
for (const col of document.querySelectorAll(".vu-ch")) {
  col.innerHTML = VU_STEPS.map((d) => `<i class="${d > 3 ? "red" : d > 0 ? "yellow" : ""}"></i>`).join("");
}
const vuLeds = [...document.querySelectorAll(".vu-ch")].map((c) => [...c.children]);
function animateVu() {
  vuAnalysers?.forEach((a, ch) => {
    a.getFloatTimeDomainData(vuBuf);
    let peak = 0;
    for (const x of vuBuf) peak = Math.max(peak, Math.abs(x));
    const db = 20 * Math.log10(peak + 1e-9) - VU_REF_DBFS;
    vuLevel[ch] = Math.max(db, vuLevel[ch] - 0.8);   // fast attack, slow decay (~48 dB/s)
    vuLeds[ch].forEach((led, i) => led.classList.toggle("on", vuLevel[ch] >= VU_STEPS[i]));
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
  a.textContent = `→ ${u.latest} available`;
  a.href = u.url;
  a.title = `${u.name}${u.published ? `, released ${u.published.slice(0, 10)}` : ""}: click for the upgrade`;
  a.hidden = false;
  if (recall("updSkip") !== u.latest && recall("updLater") !== String(u.checked)) showUpdate();
}

$("updLink").addEventListener("click", (e) => {
  if (!updInfo) return;
  e.preventDefault();
  showUpdate();
});

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

async function init() {
  checkUpdate();
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
  active = vfos.find((v) => v.name === recall("vfo")) || vfos[0];
  vbase = active.base;
  restoreBodyTab();
  renderVfoDisplays();
  if (list && list.length) renderSpareVfos();
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
  $("dabChannel").innerHTML = (info.dab_channels || []).map(([n, f]) => `<option value="${n}">${n} · ${fmtMHz(f, 3)}</option>`).join("");
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
