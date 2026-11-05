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
  const f = Number(b.dataset.f) || fmLast();
  await ensureVfoFor(f);   // e.g. an HF band on a VFO without upconverter -> VFO A
  if (!st) return;
  for (const x of $("bandGroups").querySelectorAll("button")) x.classList.toggle("active", x === b);
  st.mode = b.dataset.m;
  renderControls();
  tune(f);
  send({ mode: b.dataset.m });
});

// ---------- needle S-meter ----------

// Flat wide arc like on a transceiver display; the needle pivot is below the bottom edge.
const METER = { cx: 130, cy: 290, r: 252, a0: -25, a1: 25, s9pos: 0.6 };
let s9Dbfs = -40;
let meterTarget = -120;
let meterNow = -120;

/** dBFS -> position 0..1 on the scale: S0..S9 in 6 dB steps, above S9 up to +60 dB. */
function meterPos(dbfs) {
  const over = dbfs - s9Dbfs;
  if (over <= 0) return Math.max(0, (over + 54) / 54) * METER.s9pos;
  return METER.s9pos + Math.min(over, 60) / 60 * (1 - METER.s9pos);
}

function meterPoint(pos, r) {
  const a = (METER.a0 + pos * (METER.a1 - METER.a0)) * Math.PI / 180;
  return [METER.cx + r * Math.sin(a), METER.cy - r * Math.cos(a)];
}

function buildMeter() {
  const { r } = METER;
  const arc = (p0, p1, rr) => {
    const [x0, y0] = meterPoint(p0, rr), [x1, y1] = meterPoint(p1, rr);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${rr},${rr} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  // Meter look taken from a transceiver display: black background, white numbers and ticks,
  // green band S1–S9, red above S9, thin red needle.
  const WHITE = "#e8edf2", GREEN = "#3cf07c", RED = "#ff3b30";
  const H = 100;
  let svg = `<defs>
    <linearGradient id="mface" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0b0f14"/><stop offset="1" stop-color="#020304"/>
    </linearGradient>
    <clipPath id="mclip"><rect x="0" y="0" width="260" height="${H}" rx="6"/></clipPath>
  </defs>
  <g clip-path="url(#mclip)">
  <rect x="0" y="0" width="260" height="${H}" fill="url(#mface)"/>
  <path d="${arc(0, METER.s9pos, r - 3)}" stroke="${GREEN}" stroke-width="4" fill="none"/>
  <path d="${arc(METER.s9pos, 1, r - 3)}" stroke="${RED}" stroke-width="4" fill="none"/>
  <path d="${arc(0, 1, r + 1)}" stroke="${WHITE}" stroke-width="1" fill="none" opacity=".75"/>`;
  // ticks every S unit and every 10 dB, numbers on odd S units and on +20/+40/+60
  for (let s = 0; s <= 9; s++) {
    const p = (s / 9) * METER.s9pos;
    const major = s % 2 === 1;
    const [x0, y0] = meterPoint(p, r + (major ? 7 : 4)), [x1, y1] = meterPoint(p, r + 1);
    svg += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${WHITE}" stroke-width="${major ? 1.6 : 1}"/>`;
    if (major) {
      const [tx, ty] = meterPoint(p, r + 16);
      svg += `<text x="${tx}" y="${ty}" fill="${WHITE}">${s}</text>`;
    }
  }
  for (const db of [10, 20, 30, 40, 50, 60]) {
    const p = METER.s9pos + db / 60 * (1 - METER.s9pos);
    const major = db % 20 === 0;
    const [x0, y0] = meterPoint(p, r + (major ? 7 : 4)), [x1, y1] = meterPoint(p, r + 1);
    svg += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${RED}" stroke-width="${major ? 1.6 : 1}"/>`;
    if (major) {
      const [tx, ty] = meterPoint(p, r + 16);
      svg += `<text x="${tx}" y="${ty}" fill="${RED}">+${db}</text>`;
    }
  }
  const [sx, sy] = meterPoint(0, r + 4);
  svg += `<text x="${sx - 2}" y="${sy + 14}" class="big" fill="${WHITE}">S</text>
    <text x="236" y="${H - 10}" fill="${RED}">dB</text>
    <text x="130" y="${H - 12}" class="title" fill="#7d8896">SIGNAL</text>
    <line id="sqlMark" stroke="#ffd84a" stroke-width="3" stroke-linecap="round" style="display:none"><title>Squelch</title></line>
    <g id="needle">
      <line x1="${METER.cx}" y1="${METER.cy}" x2="${METER.cx}" y2="${METER.cy - r - 8}" stroke="${RED}" stroke-width="1.8" stroke-linecap="round"/>
    </g>
    </g>
    <rect x=".5" y=".5" width="259" height="${H - 1}" rx="6" fill="none" stroke="#262c35"/>`;
  $("smeter").innerHTML = svg;
}

function animateMeter() {
  // Ballistics like an analogue meter: fast attack, slower return.
  const k = meterTarget > meterNow ? 0.35 : 0.07;
  meterNow += (meterTarget - meterNow) * k;
  const a = METER.a0 + meterPos(meterNow) * (METER.a1 - METER.a0);
  const needle = $("needle");
  if (needle) needle.setAttribute("transform", `rotate(${a.toFixed(2)} ${METER.cx} ${METER.cy})`);
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

function bwEdgeAt(x, w) {
  const [a, b] = passband();
  let x0 = freqToX(a, w), x1 = freqToX(b, w);
  if (x1 - x0 < 6) { const m = (x0 + x1) / 2; x0 = m - 3; x1 = m + 3; }
  const d0 = st.mode === "USB" ? Infinity : Math.abs(x - x0);
  const d1 = st.mode === "LSB" ? Infinity : Math.abs(x - x1);
  if (Math.min(d0, d1) > BW_GRAB_PX) return null;
  return d0 < d1 ? "lo" : "hi";
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
  // the label can move away from under a still mouse (wheel tuning) or the decoders can cover it
  if (drag || !inPassLabel(audioBubblePos) || !$("decPane").hidden) { audioBubbleHide(); return; }
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
  // place on the screen and the frequency changes under it.
  cv.addEventListener("pointerdown", (e) => {
    if (!st || e.button !== 0) return;
    cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect();
    if (spectrum && bwEdgeAt(e.clientX - r.left, r.width)) {
      drag = { bw: true, moved: true };
      return;
    }
    const v = viewNow();
    drag = { x0: e.clientX, tune0: st.tune_hz, off: v.c - st.tune_hz, moved: false };
  });
  cv.addEventListener("pointermove", (e) => {
    const r = cv.getBoundingClientRect();
    if (spectrum && !drag && st) {
      const m = memTagAt((e.clientX - r.left) / uiScale, (e.clientY - r.top) / uiScale);
      cv.style.cursor = bwEdgeAt(e.clientX - r.left, r.width) ? "ew-resize" : m ? "pointer" : "";
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
    if (!drag.moved) { drag.moved = true; cv.parentElement.classList.add("dragging"); }
    let t = drag.tune0 - (dx / r.width) * viewNow().span;
    t = Math.max(0, Math.round(t / stepHz) * stepHz);
    if (t === st.tune_hz) return;
    st.tune_hz = t;
    viewLocalAt = Date.now();
    if (view) setView(t + drag.off);
    renderTuner();
    send({ tune_hz: t, view_hz: t + drag.off });
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
  $("gainText").textContent = auto ? "auto" : `${Number(st.gain).toFixed(1)} dB`;
  renderVfoDisplays();
}

function renderSettings() {
  renderGain();
  $("sampleRate").innerHTML = st.sample_rates.map((r) =>
    `<option value="${r}">${(r / 1e6).toLocaleString(LOCALE)} MHz</option>`).join("");
  $("sampleRate").value = String(st.sample_rate);
  $("ppm").value = st.ppm;
  $("lo").value = st.lo_offset_hz / 1e6;
  $("upconv").value = st.upconv;
  // The VFO has a fixed dongle (by serial number) and upconverter wiring: the dongle selection is hidden.
  $("deviceSetting").hidden = !!st.vfo;
  $("upconvSetting").hidden = !!st.vfo;
  $("vfoSetting").hidden = !st.vfo;
  if (st.vfo) {
    const dongle = `${st.driver === "lime" ? "LimeSDR" : "dongle"} ${st.serial}`;
    $("vfoSettingText").textContent = (st.chain_owner
      ? `VFO ${st.vfo} · chained to the ${dongle} of VFO ${st.chain_owner}: tunes inside its band; ` +
        `gain, ppm and sample rate are shared with VFO ${st.chain_owner}`
      : `VFO ${st.vfo} · ${dongle}` + (st.chained_vfos ? ` · also serves ${st.chained_vfos} chained VFO(s)` : "")) +
      (active && active.note ? ` · ${active.note}` : "");
  } else {
    loadDevices();
  }
  // LimeSDR has no bias-tee and no RTL2832 digital AGC.
  $("rtlAgcBox").hidden = st.has_rtl_agc === false;
  $("biasTeeSetting").hidden = st.has_bias_tee === false;
  $("biasTee").checked = st.bias_tee;
  $("txSetting").hidden = !st.tx_capable;
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
  const mark = $("sqlMark");
  if (!mark || !st) return;
  const v = squelchLevel();
  mark.style.display = v > SQUELCH_OFF ? "" : "none";
  if (v <= SQUELCH_OFF) return;
  const p = meterPos(v);
  const [x0, y0] = meterPoint(p, METER.r - 9), [x1, y1] = meterPoint(p, METER.r + 1);
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
  const afiMode = st.mode !== "WFM";
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

// ---------- SPECTRUM / DECODERS tabs ----------
// The decoders are not below the screen (scrolling to them was awkward) but in a tab that covers the spectrum and waterfall.

// the open tab is remembered for each VFO separately (bodyTab_A, bodyTab_B…)
const tabKey = () => (active ? `bodyTab_${active.name}` : "bodyTab");
let bodyTab = "scope";   // the saved tab is restored in init(), once the active VFO is known

// VFO without a saved tab: the first state from the server decides (a decoder is running → DECODERS)
let bodyTabGuess = false;

/** Tab saved for the active VFO, called after a VFO switch. */
function restoreBodyTab() {
  $("decNew").hidden = true;
  const saved = recall(tabKey());
  bodyTabGuess = saved !== "dec" && saved !== "scope";
  setBodyTab(saved === "dec" ? "dec" : "scope", !bodyTabGuess);
}

/** First state of a VFO without a saved tab: if a decoder runs on it, opens DECODERS. */
function guessBodyTab() {
  if (!bodyTabGuess) return;
  bodyTabGuess = false;
  const any = ["ft8On", "wefaxOn", "cwOn", "rttyOn", "sstvOn", "acarsOn", "vdl2On"].some((id) => $(id).checked) || !!(st && st.dab);
  setBodyTab(any ? "dec" : "scope");
}

function setBodyTab(tab, save = true) {
  bodyTab = tab;
  if (save) store(tabKey(), tab);
  for (const b of $("bodyTabs").querySelectorAll("button")) b.classList.toggle("on", b.dataset.tab === tab);
  $("decPane").hidden = tab !== "dec";
  if (tab === "dec") $("decNew").hidden = true;
  hoverHide();
}

/** Number of enabled decoders on the tab and a text when none is enabled. */
function renderDecTab() {
  // by the checkboxes – valid right after the click, even before the server confirms the state
  const n = ["ft8On", "wefaxOn", "cwOn", "rttyOn", "sstvOn", "acarsOn", "vdl2On"].filter((id) => $(id).checked).length + (st && st.dab ? 1 : 0);
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

// ---------- ACARS ----------

const ACARS_MAX_ROWS = 300;

let linkFreqs = { acars: [], vdl2Center: 0, vdl2Rate: 0, vdl2Freqs: [] };
let linkShown = null;

/** Band buttons, title and notes of the ACARS and CPDLC cards by the active link:
 *  ACARS = the classic channels, VDL2 = one centre button (all VDL2 channels are received at once). */
function renderLinkBands() {
  const vdl2 = !!(st && st.vdl2);
  if (vdl2 === linkShown) return;
  linkShown = vdl2;
  const f = linkFreqs;
  const html = vdl2
    ? `<button data-vdl2="1" title="VDL2 centre ${fmtMHz(f.vdl2Center, 3)} MHz, 2.1 MS/s: receives ` +
      `${f.vdl2Freqs.map((x) => fmtMHz(x, 3)).join(", ")} MHz at once">${fmtMHz(f.vdl2Center, 3)}</button>`
    : f.acars.map((x) => `<button data-f="${x}" title="${fmtMHz(x, 3)} MHz AM">${fmtMHz(x, 3)}</button>`).join("");
  $("acarsBands").innerHTML = html;
  $("acarsTitle").textContent = vdl2 ? "VDL2" : "ACARS";
  for (const el of document.querySelectorAll("#acarsCard [data-link]")) {
    el.hidden = el.dataset.link !== (vdl2 ? "vdl2" : "acars");
  }
  renderAcarsFilter();
}

/** Click on a band button in the ACARS card. */
async function onLinkBand(e) {
  const b = e.target.closest("[data-f], [data-vdl2]");
  if (!b || !st) return;
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
  tr._lookupDone = !fresh;      // rows from the history: the lookup is long over, no waiting
  renderAcarsAircraft(tr, m.ac);
  tb.prepend(tr);
  while (tb.rows.length > ACARS_MAX_ROWS) tb.lastChild.remove();
  renderAcarsFilter();
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
  for (const tr of rows) {
    tr.hidden = (acarsFilter.size > 0 && !acarsFilter.has(tr.dataset.kind)) || (loc !== "" && tr.dataset.loc !== loc);
    if (!tr.hidden) shown++;
  }
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
  addAcars({ id: c.id, time: c.time, freq_hz: c.freq_hz, link: c.link, vdl2: c.vdl2, reg: c.reg, flight: "", label: "",
    dir: c.dir, desc: c.imi_desc, text: "", crc_ok: true, cpdlc: c, ac: c.ac, atn: true }, fresh);
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
  // ATN: wait for the ADS-B lookup instead of showing the ICAO address and then rewriting it;
  // without an answer in 15 s the ICAO address is shown after all
  if (m.atn && !ac && !tr._lookupDone) {
    if (!tr._lookupTimer) tr._lookupTimer = setTimeout(() => { tr._lookupDone = true; if (!tr._msg.ac) renderAcarsAircraft(tr, null); }, 15000);
    reg = `<span class="ac-sub none" title="ICAO ${esc(m.reg)}: looking up on ADS-B">…</span>`;
  }
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
  const hex = m.atn ? m.reg : ac && ac.found ? ac.hex : "";
  tr.querySelector("td.icao").textContent = (hex || "").toUpperCase();
  const cty = hex && !(m.atn && !ac && !tr._lookupDone) ? icaoCountry(hex) : null;   // ATN: together with the lookup
  tr.querySelector("td.cty").innerHTML = !cty ? ""
    : cty.cc ? `<span class="cflag" title="${esc(cty.name)}"><img src="https://flagcdn.com/w40/${cty.cc}.png" alt="${cty.cc.toUpperCase()}"` +
      ` onerror="this.replaceWith(this.alt)"><span>${cty.cc.toUpperCase()}</span></span>`
    : `<span class="muted" title="${esc(cty.name)}">—</span>`;
}

function onAcarsInfo(d) {
  // the same aircraft data for the ACARS row and the CPDLC row of the message
  for (const tb of ["acarsRows"]) {
    const tr = $(tb).querySelector(`tr[data-id="${d.id}"]`);
    if (!tr) continue;
    tr._msg.ac = d.ac;
    renderAcarsAircraft(tr, d.ac);
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

const VDL2_TITLE = $("vdl2On").parentElement.title;   // tooltip from index.html (replaced on LimeSDR)
let vdl2Last = {};   // the status sends only on/off and the error; channels and counts come from vdl2state

function renderVdl2Info(d) {
  if (!d) return;
  const i = (vdl2Last = { ...vdl2Last, ...d });
  const el = $("vdl2Info");
  el.hidden = !i.enabled;
  el.classList.toggle("err", !!i.error);
  if (i.error) { el.textContent = `VDL2: ${i.error}`; return; }
  const ch = (i.channels || []).map((f) => fmtMHz(f, 3)).join(" ");
  el.textContent = `VDL2${ch ? " " + ch : ""}${i.frames ? ` · ${i.frames} frames` : ""}`;
}

$("vdl2On").addEventListener("change", () => {
  st.vdl2 = $("vdl2On").checked;
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
  if (st.driver === "lime" || st.chain_owner) {
    errorUntil = Date.now() + 5000;
    renderStatusPill(st.chain_owner ? `DAB needs its own dongle (this VFO shares the dongle of VFO ${st.chain_owner})`
      : "DAB is not supported on LimeSDR (RTL-SDR only)");
    return;
  }
  if (!st.dab) {
    st.dab = true;
    if (st.acars || st.vdl2) { st.acars = st.vdl2 = false; $("acarsOn").checked = $("vdl2On").checked = false; }
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
  if (i.snr != null) parts.push(`SNR ${Number(i.snr).toFixed(1)} dB`);
  if (i.enabled && i.connected === false) parts.push("starting welle-cli…");
  else if (i.enabled && i.on_channel === false) parts.push("tuning…");
  if (i.utc) parts.push(`${i.utc} UTC`);
  el.textContent = parts.join(" · ");
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
  $("dabNowLabel").textContent = "–";
  $("dabNowMeta").textContent = "";
  $("dabDls").textContent = "";
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
  const key = m.services.map((x) => x.sid + x.label + x.audio).join("|") + "#" + !!m.ensemble;
  if (list._key !== key) {
    list._key = key;
    list.innerHTML = m.services.length
      ? m.services.map((x) => `<button data-sid="${x.sid}" ${x.audio ? "" : "disabled"} title="${dabEsc(x.pty || "")} · SID ${x.sid}">` +
        `<span>${dabEsc(x.label || x.sid)}</span><small>${x.type || ""}${x.bitrate ? " " + x.bitrate + "k" : ""}</small></button>`).join("")
      : `<div class="ft8-empty">${m.ensemble ? "No stations yet…" : "Searching the ensemble… (no DAB signal on this channel?)"}</div>`;
  }
  for (const b of list.querySelectorAll("button")) b.classList.toggle("on", b.dataset.sid === dabSid);
  const cur = m.services.find((x) => x.sid === dabSid);
  if (!cur) return;
  $("dabNowLabel").textContent = cur.label || cur.sid;
  const e = cur.errors || {};
  const errs = (e.frameerrors || 0) + (e.rserrors || 0) + (e.aacerrors || 0);
  $("dabNowMeta").textContent = [cur.pty, cur.type, cur.bitrate && `${cur.bitrate} kbit/s`, cur.mode,
    cur.samplerate && `${cur.samplerate / 1000} kHz`, errs && `errors: frame ${e.frameerrors} · RS ${e.rserrors} · AAC ${e.aacerrors}`]
    .filter(Boolean).join(" · ");
  $("dabDls").textContent = cur.dls || "";
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
  if (dabEl) { dabEl.pause(); dabEl.removeAttribute("src"); dabEl.load(); }
  for (const b of $("dabServices").querySelectorAll("button")) b.classList.toggle("on", b.dataset.sid === sid);
  if (!sid) return;
  const ctx = audioContext();
  if (!dabEl) {
    dabEl = new Audio();
    dabEl.crossOrigin = "anonymous";      // the receiver of the VFO is on another port (CORS * on the server)
    ctx.createMediaElementSource(dabEl).connect(audioTap);
  }
  dabEl.src = `${vbase}/api/dab/audio/${sid}`;
  dabEl.play().catch(() => {});
  ctx.resume();
  const b = $("dabServices").querySelector(`[data-sid="${sid}"] span`);
  $("dabNowLabel").textContent = b ? b.textContent : sid;
  $("dabNowMeta").textContent = "buffering…";
  $("dabDls").textContent = "";
}

$("dabSlide").addEventListener("load", () => { $("dabSlide").hidden = false; });
$("dabSlide").addEventListener("error", () => { $("dabSlide").hidden = true; });
$("dabServices").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sid]");
  if (b && !b.disabled) dabPlay(b.dataset.sid === dabSid ? null : b.dataset.sid);
});
$("dabChannel").addEventListener("change", () => {
  dabPlay(null);
  $("dabServices")._key = null;
  st.dab_channel = $("dabChannel").value;
  send({ dab_channel: st.dab_channel });
});
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
  const td = e.target.closest("td.msg.long");
  if (!td || e.target.closest(".atn-detail") || String(getSelection())) return;   // selecting text in the detail
  td.classList.toggle("open");
});
$("acarsClear").addEventListener("click", () => {
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
  $("scrim").hidden = !id;
  if (id === "memCard") $("memSearch").focus();
}
for (const [key, d] of Object.entries(DRAWERS)) {
  $(key).addEventListener("click", () => openDrawer($(d).hidden ? d : null));
}
$("scrim").addEventListener("click", () => openDrawer(null));
for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", () => openDrawer(null));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("scrim").hidden) openDrawer(null); });

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
      `<span class="meta">${m.freq_hz >= 30e6 ? `${fmtMHz(m.freq_hz, 4)} M` : fmtKHz(m.freq_hz, 2)}<b>${m.mode}</b></span>` +
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
    el.classList.toggle("active", !!m && Math.abs(m.freq_hz - st.tune_hz) < 50 && m.mode === st.mode);
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

/** Recall a memory: frequency, mode and bandwidth (on a VFO that can receive the frequency). */
async function recallMem(m) {
  await ensureVfoFor(m.freq_hz);
  if (!st) return;
  st.mode = m.mode;
  st.bandwidth[m.mode] = m.bw;
  renderControls();
  tune(m.freq_hz);
  send({ mode: m.mode, bandwidth: m.bw });
  markActiveMem();
}

$("memSave").addEventListener("click", async () => {
  if (!st) return;
  const name = $("memName").value.trim() || `${fmtKHz(st.tune_hz, 2)} kHz ${st.mode}`;
  const body = { name, group: $("memGroupNew").value.trim() || $("memGroup").value || "My",
    freq_hz: st.tune_hz, mode: st.mode, bw: st.bandwidth[st.mode] };
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
    for (const k of ["tune_hz", "mode", "bandwidth", "zoom", "gain", "rtl_agc", "stereo_on", "notch", "ft8", "wefax", "cw", "rtty", "sstv", "acars", "cpdlc", "dab", "logs", "upconv", "device", "squelch_levels"]) s[k] = st[k];
  }
  s.sample_rates = sampleRates;
  st = s;
  renderStatusPill();
  meterTarget = s.smeter;
  $("smeterText").innerHTML = `<b>${sReading(s.smeter)}</b> · ${s.smeter.toFixed(1)} dBFS`;
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
  // VDL2 runs on RTL-SDR only: greyed out on a LimeSDR VFO
  const lime = s.driver === "lime";
  const noVdl2 = lime || !!s.chain_owner;   // a chained VFO cannot set its own centre and sample rate
  $("vdl2On").disabled = noVdl2;
  $("vdl2On").parentElement.classList.toggle("disabled", noVdl2);
  $("vdl2On").parentElement.title = s.chain_owner ? `VDL2 needs its own dongle (this VFO shares the dongle of VFO ${s.chain_owner})`
    : lime ? "VDL2 is not supported on LimeSDR (RTL-SDR only)" : VDL2_TITLE;
  $("acarsCard").hidden = !(s.acars || s.vdl2);
  renderVdl2Info({ enabled: s.vdl2, error: s.vdl2_error });
  renderDab(s);
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
  on("acars", (m) => { addAcars(m, true); decActivity(); });
  on("cpdlc", (c) => { if (c.imi === "ATN") { addAtn(c, true); decActivity(); } });   // others come inside "acars"
  on("ft8", decActivity);
  on("cwtext", decActivity);
  on("rttytext", decActivity);
  on("wefaxnew", decActivity);
  on("sstvnew", decActivity);
  on("acarsstate", renderAcarsInfo);
  on("vdl2state", renderVdl2Info);
  on("dabstate", (d) => { if (st) renderDabInfo(d); });
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
      `<div class="vfo-disp"><div class="freq">${seg7("          ")}<span class="unit"><span class="afi-tag">AFI</span>MHz</span></div></div>` +
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
        `<div class="vfo-disp"><div class="freq"></div></div>` +
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
        fr.innerHTML = seg7(txt) + `<span class="unit"><span class="afi-tag">AFI</span>${unit}</span>`;
        fr.setAttribute("aria-label", `${fmtMHz(s.tune_hz, 6)} MHz`);
      }
      // AFI above the unit: lit while this VFO's audio is inverted (no AFI in WFM), otherwise dark like an unlit LCD segment
      const afiTag = fr.querySelector(".afi-tag");
      if (afiTag) afiTag.classList.toggle("on", !!s.afi && s.mode !== "WFM");
    }
    // Frame on top of the VFO: name of the memory on this frequency, otherwise the band plan (narrowest band).
    const mem = s ? memAt(s.tune_hz, s.mode) : null;
    const bands = s && !mem ? bandsAt(s.tune_hz) : [];
    const memEl = row.querySelector(".vfo-memname");
    const memText = mem ? mem.name : bands.length ? bands[0][2] : "";
    if (memEl.textContent !== memText) memEl.textContent = memText;
    memEl.classList.toggle("band", !mem);
    memEl.title = mem ? `${mem.name} · ${mem.group} · ${mem.mode} · ${fmtBw(mem.bw)}`
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
      gain.textContent = s.gain === "auto" ? "AGC" : `${Number(s.gain).toFixed(1)} dB`;
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
  $("acarsRows").innerHTML = ""; $("acarsEmpty").hidden = false; renderAcarsFilter();
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
      if (isMain) recordChunk(bytes.slice(0, even), rate, chans);
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

// ---------- recording (WAV) ----------
// Stores raw PCM from the stream of the active VFO (before volume and MUTE); on a VFO switch it continues
// with the new stream. After stopping, the file is downloaded through the browser.
let rec = null;

function recordChunk(bytes, rate, chans) {
  if (!rec) return;
  if (!rec.rate) { rec.rate = rate; rec.chans = chans; }
  if (rate !== rec.rate || chans !== rec.chans) return; // a different format would corrupt the WAV
  rec.chunks.push(bytes);
  rec.bytes += bytes.length;
}

function recStamp(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function wavBlob(chunks, dataLen, rate, chans) {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); h.setUint32(4, 36 + dataLen, true); str(8, "WAVE");
  str(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, chans, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * chans * 2, true); h.setUint16(32, chans * 2, true);
  h.setUint16(34, 16, true);
  str(36, "data"); h.setUint32(40, dataLen, true);
  return new Blob([h, ...chunks], { type: "audio/wav" });
}

function renderRec() {
  $("recBtn").classList.toggle("on", !!rec);
  let t = "REC";
  if (rec) {
    const s = Math.floor((Date.now() - rec.t0) / 1000);
    t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  $("recTime").textContent = t;
  $("recBtn").title = rec ? "Stop recording and save WAV" : "Record audio (WAV)";
}

$("recBtn").addEventListener("click", () => {
  if (!rec) {
    const name = active ? active.name : "";
    const f = st ? (st.tune_hz / 1e3).toFixed(1) + "kHz_" + st.mode : "";
    rec = { chunks: [], bytes: 0, rate: 0, chans: 0, t0: Date.now(),
            file: `rec_${recStamp(new Date())}${name ? "_VFO-" + name : ""}${f ? "_" + f : ""}.wav`,
            timer: setInterval(renderRec, 500) };
    renderRec();
    return;
  }
  const r = rec;
  rec = null;
  clearInterval(r.timer);
  renderRec();
  if (!r.bytes) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(wavBlob(r.chunks, r.bytes, r.rate, r.chans));
  a.download = r.file;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

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

async function init() {
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
  linkFreqs = { acars: info.acars_freqs || [], vdl2Center: info.vdl2_center || 136850000,
    vdl2Rate: info.vdl2_rate || 2100000,
    vdl2Freqs: info.vdl2_freqs || [] };
  linkShown = null;
  renderLinkBands();
  loadMems();
  for (const v of vfos) connectEvents(v);
  startAudio();
  await loadDecoders();
}
init();
