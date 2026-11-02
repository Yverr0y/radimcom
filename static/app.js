"use strict";

const $ = (id) => document.getElementById(id);

const BANDWIDTHS = {
  AM: [4000, 6000, 8000, 10000],
  FM: [500, 3000, 6000, 12000, 25000, 50000],
  WFM: [100000, 150000, 200000],
  LSB: [1800, 2400, 2700, 3000],
  USB: [1800, 2400, 2700, 3000],
  CW: [300, 500, 800, 1200],
};
const STEPS = [10, 100, 500, 1000, 5000, 9000, 10000];
// Skupiny tlačidiel pásiem: [nadpis, [[popis, frekvencia Hz, mód], …]].
// KV ide cez up-konvertor, VKV/UKV (nad 30 MHz) priamo do kľúčenky.
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
    ["FM BCAST", 0, "WFM"], ["CB ch19", 27185000, "FM"], ["Airband", 127500000, "AM"], ["Marine ch16", 156800000, "FM"], ["PMR446", 446006250, "FM"]]],
];

let st = null; // posledný stav zo servera
let view = null; // {c, span} práve zobrazeného výrezu vodopádu
let pendingSet = {};
let setTimer = null;
let localChangeAt = 0;
let stepHz = 1000;
let errorUntil = 0; // do kedy ukazovať chybu poslednej zmeny v stavovom poli
let vbase = ""; // adresa prijímača aktívneho VFO ("" = server tejto stránky, režim bez VFO)
let vfos = []; // [{name, port, serial, note, base, st, rows, online}]
let active = null; // aktívne VFO

function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* bez úložiska */ } }
function recall(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

// ---------- pomocné ----------

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

/** "7100" -> kHz, "7.1" -> MHz (čísla pod 100 berieme ako MHz), "145.5" alebo "433.5" -> MHz
 *  (desatinné číslo do 2000), "7.1M", "7100k", "7100000Hz". */
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

/** Odošle čakajúce zmeny prijímaču aktívneho VFO (adresa sa vezme hneď, pred prepnutím VFO). */
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
    // Zásuvka nastavení býva zatvorená: chybu ukážeme aj v stavovom poli.
    errorUntil = Date.now() + 5000;
    renderStatusPill(err.textContent);
  }
}

/** Stavové pole pod hodinami: chyba poslednej zmeny (5 s). Pri VFO je stav prijímača v bloku nad
 *  displejom, takže pole je inak skryté; samostatný prijímač bez VFO tu ukazuje svoj stav. */
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
  // Prekresľujeme len pri zmene: výmena tlačidla pod myšou spôsobuje blikanie a stratené kliky.
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
  // Tlačidlá ostávajú pevné; šírka nastavená ťahaním okraja v spektre nemá tlačidlo (žiadne nesvieti).
  const bw = st.bandwidth[st.mode];
  segButtons($("bandwidths"), BANDWIDTHS[st.mode], bw, fmtBw);
  segButtons($("steps"), STEPS, stepHz, fmtBw);
  segButtons($("zooms"), st.zooms, st.zoom, (z) => `${z}×`);
  $("modeBadge").textContent = st.mode;
  $("bwBadge").textContent = fmtBw(bw);
  renderSqlBadge();
  renderRds();
}

// ---------- 7-segmentový displej ----------

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

/** Text typu " 7_066.29" -> SVG číslice; medzera = nesvietiaca číslica, bodka (desatinná) patrí
 *  k predošlej číslici, podčiarkovník = malá medzera medzi skupinami tisícov, dvojbodka pre hodiny. */
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
    // xMidYMax: číslica sedí na spodku svojho boxu, aby menšie číslice (Hz) mali rovnaký spodok ako veľké
    out += `<svg viewBox="-4 0 66 100" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><g transform="skewX(-6) translate(8 0)">${s}</g></svg>`;
  }
  return out;
}

/** Ako na transceiveri, rozlíšenie 1 Hz, posledné tri číslice (Hz) menšie. KV v kHz (prvá bodka
 *  oddeľuje tisíce: „   7.016.500“ kHz), od 30 MHz v MHz (prvá bodka desatinná: „ 439.475.000“ MHz). */
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
$("zooms").addEventListener("click", (e) => {
  const b = e.target.closest("[data-v]");
  if (!b) return;
  st.zoom = Number(b.dataset.v);
  renderControls();
  send({ zoom: st.zoom });
});
document.addEventListener("keydown", (e) => {
  if (!st || e.target.closest("input, select, textarea")) return;
  if (e.key === "ArrowLeft") { tune(st.tune_hz - stepHz, true); e.preventDefault(); }
  if (e.key === "ArrowRight") { tune(st.tune_hz + stepHz, true); e.preventDefault(); }
});

// Klik na displej aktívneho VFO otvorí zadávanie frekvencie, klik na neaktívne VFO (displej
// alebo tlačidlo A/B/C) naň prepne.
// Koliesko nad číslicou displeja ladí o jej rád (číslice MHz.kHz.Hz = 10^9 … 1 Hz), aj na neaktívnom
// VFO – to sa preladí bez prepnutia.
$("vfoList").addEventListener("wheel", (e) => {
  const digit = e.target.closest(".freq svg");
  const row = e.target.closest(".vfo-row:not(.spare)");
  if (!digit || !row) return;
  e.preventDefault();
  const v = vfos.find((x) => String(x.name) === row.dataset.vfo);
  const s = v === active ? st : v.st;
  if (!s) return;
  const digits = [...digit.parentElement.querySelectorAll("svg")];
  const place = 10 ** (digits.length - 1 - digits.indexOf(digit));
  let hz = s.tune_hz + (e.deltaY < 0 ? place : -place);
  const [lo, hi] = s.range || [0, Infinity];
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

// Posuvník RF GAIN pod displejom: nastaví zisk daného VFO bez prepnutia (to isté ako posuvník v SET).
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

// Posuvník SQUELCH pod RF GAIN: úroveň squelchu pre aktuálny mód daného VFO (to isté ako posuvník v SET).
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
  const row = e.target.closest(".vfo-row:not(.spare)");   // voľné okno bez SDR nereaguje
  if (!row) return;
  const v = vfos.find((x) => String(x.name) === row.dataset.vfo);
  if (e.target.closest(".vfo-cue")) { setCue(v, !v.cue); return; }   // CUE neprepína VFO
  if (e.target.closest(".vfo-rf")) return;                             // RF GAIN tiež nie
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

// FM BCAST (frekvencia 0 v BAND_GROUPS) naladí poslednú počúvanú FM stanicu.
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
  list.map((b) => `<button data-f="${b[1]}" data-m="${b[2]}" title="${b[1] ? fmtBand(b[1]) : "last FM station"} · ${b[2]}">${b[0]}</button>`).join("") +
  `</div></div>`).join("");
$("bandGroups").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-f]");
  if (!b || !st) return;
  const f = Number(b.dataset.f) || fmLast();
  await ensureVfoFor(f);   // napr. KV pásmo na VFO bez konvertora -> VFO A
  if (!st) return;
  for (const x of $("bandGroups").querySelectorAll("button")) x.classList.toggle("active", x === b);
  st.mode = b.dataset.m;
  renderControls();
  tune(f);
  send({ mode: b.dataset.m });
});

// ---------- ručičkový S-meter ----------

// Plochý široký oblúk ako na displeji transceivera; os ručičky je pod spodným okrajom.
const METER = { cx: 130, cy: 290, r: 252, a0: -25, a1: 25, s9pos: 0.6 };
let s9Dbfs = -40;
let meterTarget = -120;
let meterNow = -120;

/** dBFS -> poloha 0..1 na stupnici: S0..S9 po 6 dB, nad S9 do +60 dB. */
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
  // Vzhľad merača z displeja transceivera: čierny podklad, biele čísla a ryhy,
  // zelený pás S1–S9, červený nad S9, tenká červená ručička.
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
  // ryhy každé S a každých 10 dB, čísla na nepárnych S a na +20/+40/+60
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
  // Balistika ako analógový merák: rýchly nábeh, pomalší návrat.
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

// ---------- spektrum a vodopád ----------

// Riadkov vodopádu = výška okna vodopádu v CSS pixeloch (pri zmene okna sa prepočíta).
let WF_ROWS = wfRowsWanted();
function wfRowsWanted() {
  return Math.max(120, Math.min(1400, Math.round(document.querySelector(".waterfall-wrap").clientHeight || 320)));
}
const wfCanvas = $("waterfall");
const wfCtx = wfCanvas.getContext("2d");
let wfRow = null;
let floor = null;
let spec = null;
let imgC = 0; // stred, ktorému presne zodpovedá obraz vodopádu (posúva sa po celých bodoch)
let viewLocalAt = 0; // kedy sme výrez naposledy posunuli ťahaním
let drag = null;

const LUT = (() => {
  // Šum takmer čierny až tmavomodrý, signály prudko prechádzajú do žltej a červenej (vyšší kontrast).
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
    // Server posunul výrez (ladenie pri okraji, zmena pásma): obraz posunieme s ním.
    setView(center);
  }

  const sorted = Array.from(vals).sort((a, b) => a - b);
  const p20 = sorted[Math.floor(n * 0.2)];
  floor = floor === null ? p20 : floor * 0.95 + p20 * 0.05;
  const [lo, rng] = colorRange();
  // Riadok kreslíme na miesto podľa zobrazeného výrezu; pri ťahaní môže server ešte meškať.
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

/** Posunie zobrazený výrez na stred c: obraz vodopádu aj spektra sa posunú o celé body. */
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
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, cv.clientWidth, cv.clientHeight];
}

function drawSpectrum() {
  const [ctx, w, h] = fitCanvas($("spectrum"));
  // Čierno-sivý panoramatický displej (hore sivá, dole čierna).
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#3a3d42"); g.addColorStop(0.6, "#1a1c1f"); g.addColorStop(1, "#050506");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // zvislá mriežka podľa osi frekvencie
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
  // Spektrum má vlastnú pevnú mierku (55 dB), rozsah farieb vodopádu ju nemení.
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
    // Pásmo musí byť vidieť aj pri malom zoome: aspoň 6 px.
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
      // Popis šírky pásma nad pásmom.
      const txt = `${st.mode} · ${fmtBw(bw)}`;
      ctx.font = "600 11px system-ui, sans-serif";
      const tw = ctx.measureText(txt).width + 12;
      const tx = Math.min(Math.max((x0 + x1) / 2 - tw / 2, 4), w - tw - 4);
      ctx.fillStyle = "rgba(10,13,18,.85)";
      ctx.strokeStyle = "rgba(255,181,71,.7)";
      ctx.beginPath(); ctx.roundRect(tx, 6, tw, 18, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#ffb547";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, tx + 6, 15);
    }
  }
  drawAxis();
}

function niceStep(span) {
  const raw = span / 8;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

// Pásma na osi frekvencií (Hz): amatérske IARU Región 1 modrou, rozhlasové KV (ITU) oranžovou.
const HAM_BANDS = [
  [135700, 137800, "2200m"], [472000, 479000, "630m"], [1810000, 2000000, "160m"], [3500000, 3800000, "80m"],
  [5351500, 5366500, "60m"], [7000000, 7200000, "40m"], [10100000, 10150000, "30m"], [14000000, 14350000, "20m"],
  [18068000, 18168000, "17m"], [21000000, 21450000, "15m"], [24890000, 24990000, "12m"], [28000000, 29700000, "10m"],
  [50000000, 52000000, "6m"], [70000000, 70500000, "4m"], [144000000, 146000000, "2m"],
  [430000000, 440000000, "70cm"], [1240000000, 1300000000, "23cm"],
];
const BC_BANDS = [
  [2300000, 2495000, "120m"], [3200000, 3400000, "90m"], [3900000, 4000000, "75m"], [4750000, 5060000, "60m"],
  [5900000, 6200000, "49m"], [7200000, 7450000, "41m"], [9400000, 9900000, "31m"], [11600000, 12100000, "25m"],
  [13570000, 13870000, "22m"], [15100000, 15800000, "19m"], [17480000, 17900000, "16m"],
  [18900000, 19020000, "15m"], [21450000, 21850000, "13m"], [25670000, 26100000, "11m"],
];
// Ostatné služby (bez predpony v názve).
const FM_BANDS = [[87500000, 108000000, "FM BCAST"]];
const AIR_BANDS = [[118000000, 137000000, "AIRBAND"]];
const PMR_BANDS = [[446000000, 446200000, "PMR446"]];
const CB_BANDS = [[26965000, 27405000, "CB"]];
const AXIS_STRIP = 13; // px, pásik s názvom pásma pri spodnom okraji osi
const BAND_STYLES = [
  [HAM_BANDS, "HAM", "rgba(40,120,255,.16)", "#2f7bff", "#fff"],
  [BC_BANDS, "BC", "rgba(255,150,40,.16)", "#ff9a2e", "#1a1206"],
  [FM_BANDS, "", "rgba(176,97,255,.16)", "#a95cff", "#fff"],
  [AIR_BANDS, "", "rgba(34,199,199,.16)", "#1fbfbf", "#04201f"],
  [PMR_BANDS, "", "rgba(60,200,100,.16)", "#33c060", "#05200d"],
  [CB_BANDS, "", "rgba(255,216,74,.16)", "#f2cc3a", "#1f1a04"],
];

function drawAxis() {
  const [ctx, w, h] = fitCanvas($("axis"));
  ctx.clearRect(0, 0, w, h);
  const v = viewNow();
  const f0 = v.c - v.span / 2, f1 = v.c + v.span / 2;
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [bands, kind, bg, strip, ink] of BAND_STYLES) {
    for (const [a, b, name] of bands) {
      if (b < f0 || a > f1) continue;
      const x0 = Math.max(0, freqToX(a, w)), x1 = Math.min(w, freqToX(b, w));
      ctx.fillStyle = bg;
      ctx.fillRect(x0, 0, x1 - x0, h - AXIS_STRIP);
      ctx.fillStyle = strip;
      ctx.fillRect(x0, h - AXIS_STRIP, x1 - x0, AXIS_STRIP);
      // Názov do stredu viditeľnej časti pásma, ak sa tam zmestí.
      const label = kind ? `${kind} ${name}` : name;
      if (x1 - x0 > ctx.measureText(label).width + 8) {
        ctx.fillStyle = ink;
        ctx.fillText(label, (x0 + x1) / 2, h - AXIS_STRIP / 2 + 0.5);
      }
    }
  }
  const s = niceStep(f1 - f0);
  ctx.font = "13px ui-monospace, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(255,255,255,.4)";
  ctx.fillStyle = "#d6d8dc";
  const decimals = s >= 1e5 ? 1 : s >= 1e4 ? 2 : s >= 1e3 ? 3 : 4;
  // Os je nad spektrom: značky smerujú dole k spektru.
  for (let f = Math.ceil(f0 / s) * s; f <= f1; f += s) {
    const x = Math.round(freqToX(f, w)) + 0.5;
    const top = h - AXIS_STRIP;
    ctx.beginPath(); ctx.moveTo(x, top - 5); ctx.lineTo(x, top); ctx.stroke();
    if (x > 24 && x < w - 24) ctx.fillText(fmtMHz(f, decimals), x, top / 2);
  }
}

// Šírka filtra: v spektre sa dá chytiť okrajová čiara pásma a ťahať. Pri SSB len vonkajší okraj
// (vnútorný je pevne 300 Hz od nosnej), pri ostatných módoch sa pásmo mení súmerne.
const BW_GRAB_PX = 5;
const BW_LIMITS = { WFM: [50000, 250000, 1000], FM: [500, 50000, 50], other: [100, 18000, 50] }; // min, max, zaokrúhlenie

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

// Frekvencia pod myšou: po 1 s nehybnosti (posun do 2 px sa neráta) sa ukáže na 5 s.
const HOVER_DELAY_MS = 1000, HOVER_SHOW_MS = 5000;
let hover = null;
function hoverHide() {
  if (hover) { clearTimeout(hover.timer); hover = null; }
  $("hoverFreq").hidden = true;
}
function hoverMove(e, cv) {
  if (drag || !st) { hoverHide(); return; }
  if (hover && Math.abs(e.clientX - hover.x) <= 2 && Math.abs(e.clientY - hover.y) <= 2) return;
  hoverHide();
  hover = { x: e.clientX, y: e.clientY };
  hover.timer = setTimeout(() => {
    const r = cv.getBoundingClientRect(), box = $("hoverFreq"), scope = box.parentElement.getBoundingClientRect();
    const f = xToFreq(hover.x - r.left, r.width);
    box.textContent = f >= 30e6 ? `${fmtMHz(f, 4)} MHz` : `${fmtKHz(f, 2)} kHz`;
    box.hidden = false;
    // vedľa kurzora; pri pravom okraji naľavo od neho
    const x = hover.x - scope.left, y = hover.y - scope.top;
    box.style.left = `${x + 14 + box.offsetWidth > scope.width ? x - 14 - box.offsetWidth : x + 14}px`;
    box.style.top = `${Math.max(0, y - box.offsetHeight - 10)}px`;
    hover.timer = setTimeout(() => { box.hidden = true; }, HOVER_SHOW_MS);
  }, HOVER_DELAY_MS);
}

for (const id of ["specOverlay", "wfOverlay"]) {
  const cv = $(id);
  const spectrum = id === "specOverlay";
  // Klik bez pohybu naladí bod pod myšou. Ťahanie posúva celý vodopád: pásmo ostáva na mieste
  // obrazovky a pod ním sa mení frekvencia.
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
    if (spectrum && !drag && st) cv.style.cursor = bwEdgeAt(e.clientX - r.left, r.width) ? "ew-resize" : "";
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
      tune(xToFreq(e.clientX - r.left, r.width), true);
    }
    if (drag.moved && !drag.bw) viewLocalAt = Date.now();
    drag = null;
    if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
    cv.parentElement.classList.remove("dragging");
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("pointermove", (e) => hoverMove(e, cv));
  cv.addEventListener("pointerleave", hoverHide);
  cv.addEventListener("pointerdown", hoverHide);
  // ladenie kolieskom: tooltip skryť a neukázať, kým sa myš znova nepohne
  cv.addEventListener("wheel", (e) => { hoverHide(); hover = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    tune(st.tune_hz + (e.deltaY < 0 ? 1 : -1) * stepHz, true);
  }, { passive: false });
}
window.addEventListener("resize", () => {
  resizeWaterfall();
  drawSpectrum();
  drawOverlays();
});
// Výška pevnej hornej časti (mení sa so šírkou okna a zalomením tlačidiel): spodná časť so spektrom
// a vodopádom dostane zvyšok okna.
new ResizeObserver(([e]) => {
  const h = Math.round(e.target.getBoundingClientRect().height);
  if (document.documentElement.style.getPropertyValue("--head-h") === `${h}px`) return;
  document.documentElement.style.setProperty("--head-h", `${h}px`);
  window.dispatchEvent(new Event("resize"));
}).observe($("radioHead"));

/** Zmena výšky okna: nový počet riadkov, doterajší obraz sa zachová (hore sú najnovšie riadky). */
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
  // VFO má pevnú kľúčenku (podľa sériového čísla) aj zapojenie konvertora: výber kľúčenky sa skryje.
  $("deviceSetting").hidden = !!st.vfo;
  $("upconvSetting").hidden = !!st.vfo;
  $("vfoSetting").hidden = !st.vfo;
  if (st.vfo) {
    $("vfoSettingText").textContent = `VFO ${st.vfo} · ${st.driver === "lime" ? "LimeSDR" : "dongle"} ${st.serial}` +
      (active && active.note ? ` · ${active.note}` : "");
  } else {
    loadDevices();
  }
  // LimeSDR nemá bias-tee ani digitálne AGC RTL2832.
  $("rtlAgcBox").hidden = st.has_rtl_agc === false;
  $("biasTeeSetting").hidden = st.has_bias_tee === false;
  $("biasTee").checked = st.bias_tee;
  $("txSetting").hidden = !st.tx_capable;
  $("txEnabled").checked = !!st.tx_enabled;
  renderSquelch();
  renderWfLabels();
}

const SQUELCH_OFF = -120;

// Squelch má vlastnú úroveň pre AM, FM a WFM; posuvník v SET nastavuje tú pre aktuálny mód.
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

/** Žltá značka úrovne squelchu na stupnici S-metra. */
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

// WFM: príznaky ST (stereo pilot) a RDS (synchronizované bloky), pod frekvenciou PS a RadioText.
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
  // príznak ALC pri S-metri: zelený = zapnuté, sivý = vypnuté; vo FM/WFM (bez ALC) skrytý
  $("alcBadge").hidden = !alcMode;
  $("alcBadge").classList.toggle("dim", st.audio_agc === false);
  $("stBadge").hidden = !wfm;
  $("stBadge").classList.toggle("dim", !st.stereo);
  // Rámik RDS je vždy na mieste (vodopád sa neposúva); bez RDS je prázdny a zhasnutý.
  const has = !!r && (r.ps || r.rt || r.pi);
  $("rds").classList.toggle("off", !has);
  $("rdsPs").textContent = has ? r.ps || "········" : " ";
  $("rdsMeta").textContent = has ? [r.pi && `PI ${r.pi}`, r.pty, r.tp && (r.ta ? "TP TA" : "TP")].filter(Boolean).join(" · ") : "";
  $("rdsRt").textContent = has ? r.rt : "";
  $("rds").title = has ? [r.rt, r.ct && `Clock: ${r.ct}`].filter(Boolean).join("\n") : "RDS";
}

// Príznak SQL pri zapnutom squelchu (AM/FM/WFM): svieti, keď je squelch otvorený.
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
  // Aktívna kľúčenka musí byť v zozname, aj keď ju zoznam nevrátil (napr. odpojená).
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
$("txEnabled").addEventListener("change", () => {
  st.tx_enabled = $("txEnabled").checked;
  if (!st.tx_enabled) pttUp();
  send({ tx_enabled: st.tx_enabled });
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
  // Nové správy idú hore, hneď pod oddeľovač svojho cyklu.
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
  await ensureVfoFor(Number(b.dataset.f));   // KV pásmo -> VFO s konvertorom
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

// ---------- záložky SPECTRUM / DECODERS ----------
// Dekodéry nie sú pod obrazovkou (zle sa k nim posúvalo), ale v záložke, ktorá prekryje spektrum a vodopád.

// otvorená záložka sa pamätá pre každé VFO zvlášť (bodyTab_A, bodyTab_B…)
const tabKey = () => (active ? `bodyTab_${active.name}` : "bodyTab");
let bodyTab = recall(tabKey()) === "dec" ? "dec" : "scope";

// VFO bez uloženej záložky: rozhodne prvý stav zo servera (beží dekodér → DECODERS)
let bodyTabGuess = false;

/** Záložka uložená pre aktívne VFO, volá sa po prepnutí VFO. */
function restoreBodyTab() {
  $("decNew").hidden = true;
  const saved = recall(tabKey());
  bodyTabGuess = saved !== "dec" && saved !== "scope";
  setBodyTab(saved === "dec" ? "dec" : "scope", !bodyTabGuess);
}

/** Prvý stav VFO bez uloženej záložky: ak na ňom beží dekodér, otvorí DECODERS. */
function guessBodyTab() {
  if (!bodyTabGuess) return;
  bodyTabGuess = false;
  const any = ["ft8On", "wefaxOn", "cwOn", "rttyOn", "sstvOn", "acarsOn"].some((id) => $(id).checked);
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

/** Počet zapnutých dekodérov v záložke a text, keď nie je zapnutý žiadny. */
function renderDecTab() {
  // podľa zaškrtnutí – platí hneď po kliknutí, aj kým server nepotvrdí stav
  const n = ["ft8On", "wefaxOn", "cwOn", "rttyOn", "sstvOn", "acarsOn"].filter((id) => $(id).checked).length;
  $("decCount").textContent = n ? `(${n})` : "";
  $("decEmpty").hidden = n > 0;
}

/** Nová správa dekodéra: zelená bodka na záložke, kým sa na ňu nepozrieš. */
function decActivity() {
  if (bodyTab !== "dec") $("decNew").hidden = false;
}

$("bodyTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) setBodyTab(b.dataset.tab);
});
// zapnutie dekodéra (FT8, WEFAX, SSTV, ACARS) otvorí záložku DECODERS a vidno jeho kartu
for (const id of ["ft8On", "wefaxOn", "cwOn", "rttyOn", "sstvOn", "acarsOn"]) {
  $(id).addEventListener("change", () => {
    if ($(id).checked) setBodyTab("dec");
    renderDecTab();
  });
}
setBodyTab(bodyTab);

// ---------- ACARS ----------

const ACARS_MAX_ROWS = 300;

function renderAcarsBands(freqs) {
  $("acarsBands").innerHTML = (freqs || []).map((f) =>
    `<button data-f="${f}" title="${fmtMHz(f, 3)} MHz AM">${fmtMHz(f, 3)}</button>`).join("");
}

function addAcars(m, fresh) {
  const tb = $("acarsRows");
  $("acarsEmpty").hidden = true;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const tr = document.createElement("tr");
  if (!m.crc_ok) tr.classList.add("bad");
  if (fresh) tr.classList.add("new");
  const arrow = m.dir === "down" ? "↓" : "↑";   // ↓ z lietadla, ↑ zo zeme
  tr.title = `mode ${m.mode} · block ${m.block}${m.msgno ? " · msg " + m.msgno : ""}${m.ack ? " · ack " + m.ack : ""}` +
    `${m.crc_ok ? "" : " · CRC error"}${m.more ? " · continues in the next block" : ""}`;
  tr.dataset.id = m.id;
  tr.innerHTML = `<td>${m.time}</td><td class="num">${fmtMHz(m.freq_hz, 3)}</td>` +
    `<td class="reg"></td><td class="flt"></td><td>${arrow} ${esc(m.label)}</td>` +
    `<td class="desc">${esc(m.desc || "")}</td>` +
    `<td class="msg"><div class="msg-text">${m.crc_ok ? "" : "✗ "}${esc(m.text) || "<span class='muted'>(no text)</span>"}</div></td>`;
  // dlhá správa (technické hlásenia s tabuľkami): skrátená na 3 riadky, klik ju rozbalí/zbalí
  if (m.text.split("\n").length > 3 || m.text.length > 240) tr.querySelector("td.msg").classList.add("long");
  tr._msg = m;
  renderAcarsAircraft(tr, m.ac);
  tb.prepend(tr);
  while (tb.rows.length > ACARS_MAX_ROWS) tb.lastChild.remove();
}

/** Registrácia a let; z ADS-B (adsb.fi / adsb.lol) typ, poloha a odkaz na mapu v novom okne:
 *  registrácia -> globe.adsb.fi, let -> adsb.lol. */
function renderAcarsAircraft(tr, ac) {
  const m = tr._msg;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const link = (url, text, title) => `<a href="${url}" target="_blank" rel="noopener" title="${esc(title)}">${esc(text)}</a>`;
  let reg = esc(m.reg), flt = esc(m.flight);
  if (ac && ac.found && ac.hex) {
    reg = link(`https://globe.adsb.fi/?icao=${encodeURIComponent(ac.hex)}`, m.reg, "Show on the map (adsb.fi)");
    if (m.flight || ac.callsign)
      flt = link(`https://adsb.lol/?icao=${encodeURIComponent(ac.hex)}`, m.flight || ac.callsign, "Show on the map (adsb.lol)");
    const type = [ac.type, ac.desc].filter(Boolean).join(" · ");
    const pos = ac.lat != null ? `${Math.abs(ac.lat).toFixed(2)}${ac.lat >= 0 ? "N" : "S"} ${Math.abs(ac.lon).toFixed(2)}${ac.lon >= 0 ? "E" : "W"}` : "";
    const alt = ac.ground ? "on ground" : ac.alt_ft != null ? `FL${String(Math.round(ac.alt_ft / 100)).padStart(3, "0")}` : "";
    const gs = ac.gs_kt != null && !ac.ground ? `${Math.round(ac.gs_kt)} kt` : "";
    const src = `title="from ADS-B (${esc(ac.src || "adsb.fi")}) at the time of the message"`;
    reg += type ? `<div class="ac-sub" ${src}>${esc(type)}</div>` : "";
    reg += pos || alt ? `<div class="ac-sub" ${src}>${[pos, alt, gs].filter(Boolean).join(" · ")}</div>` : "";
    if (ac.callsign && ac.callsign !== m.flight) flt += `<div class="ac-sub" ${src}>${esc(ac.callsign)}</div>`;
  } else if (ac && !ac.found) {
    reg += `<div class="ac-sub none">not seen on ADS-B now</div>`;
  }
  tr.querySelector("td.reg").innerHTML = reg;
  tr.querySelector("td.flt").innerHTML = flt;
}

function onAcarsInfo(d) {
  const tr = $("acarsRows").querySelector(`tr[data-id="${d.id}"]`);
  if (!tr) return;
  tr._msg.ac = d.ac;
  renderAcarsAircraft(tr, d.ac);
}

function renderAcarsInfo(i) {
  if (!st) return;
  $("acarsCard").hidden = !st.acars;
  if (!i) return;
  $("acarsInfo").textContent = `${i.count} messages${i.crc_errors ? ` · ${i.crc_errors} CRC errors` : ""}`;
}

$("acarsOn").addEventListener("change", () => {
  st.acars = $("acarsOn").checked;
  renderAcarsInfo();
  send({ acars: st.acars });
});
$("acarsBands").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-f]");
  if (!b || !st) return;
  await ensureVfoFor(Number(b.dataset.f));   // VHF -> VFO bez konvertora
  if (!st) return;
  st.mode = "AM";
  renderControls();
  tune(Number(b.dataset.f));
  const changes = { mode: "AM" };
  if (!st.acars) { st.acars = true; $("acarsOn").checked = true; changes.acars = true; }
  send(changes);
});
$("acarsRows").addEventListener("click", (e) => {
  const td = e.target.closest("td.msg.long");
  if (td) td.classList.toggle("open");
});
$("acarsClear").addEventListener("click", () => {
  fetch(vbase + "/api/acars", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"clear"}' });
  $("acarsRows").innerHTML = "";
  $("acarsEmpty").hidden = false;
  $("acarsInfo").textContent = "";
});

// ---------- WEFAX ----------

const WFX_BLOCK = 32; // riadkov na jeden canvas; obrázok rastie po blokoch bez kopírovania
const WFX_STATES = { idle: "waiting for signal", free: "receiving (no start)", phasing: "phasing", rx: "receiving" };
let wfx = { id: null, width: 1810, rows: 0, blocks: [] };

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
  if (info.rows) {
    const img = new Image();
    img.crossOrigin = "anonymous";   // obrázok z portu VFO; bez toho by sa plátno nedalo uložiť
    img.src = `${vbase}/api/wefax/image.png?t=${Date.now()}`;
    await img.decode();
    wfx.width = img.width;
    for (let b = 0; b * WFX_BLOCK < img.height; b++) {
      wefaxBlock(b).drawImage(img, 0, b * WFX_BLOCK, img.width, WFX_BLOCK, 0, 0, img.width, WFX_BLOCK);
    }
    wfx.rows = img.height;
    $("wefaxEmpty").hidden = true;
  }
  renderWefaxInfo(info);
}

function renderWefaxInfo(i) {
  const afc = i.afc ? `centre ${i.center_hz} Hz ✓` : "searching for signal";
  $("wefaxInfo").textContent = `${WFX_STATES[i.state] || i.state} · ${i.lpm} LPM · IOC ${i.ioc} · ${afc}` +
    (i.rows ? ` · ${i.rows} lines` : "") + (i.saved ? ` · saved ${i.saved}` : "");
  if (document.activeElement !== $("wefaxLpm")) $("wefaxLpm").value = i.lpm_mode;
  if (document.activeElement !== $("wefaxIoc")) $("wefaxIoc").value = i.ioc_mode;
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
  // Štandard: USB ladenie o 1,9 kHz pod priradenú frekvenciu (AFC aj tak nájde presný stred).
  st.mode = "USB";
  renderControls();
  tune(Number(b.dataset.f) - 1900);
  send({ mode: "USB" });
});
$("wefaxLpm").addEventListener("change", () => wefaxCmd({ lpm_mode: $("wefaxLpm").value }));
$("wefaxIoc").addEventListener("change", () => wefaxCmd({ ioc_mode: $("wefaxIoc").value }));
$("wefaxNew").addEventListener("click", () => wefaxCmd({ action: "new" }));
$("wefaxWrap").addEventListener("click", (e) => {
  const cv = e.target.closest("canvas");
  if (!cv) return;
  const r = cv.getBoundingClientRect();
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

// Celý obrázok zo servera (pri prepnutí VFO a po dokončení, keď je prekreslený s korekciou náklonu).
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

/** Textový výstup dekodéra (CW, RTTY): pridá text, drží posun na konci, ak tam používateľ bol. */
function textOut(boxId, emptyId, max) {
  const box = $(boxId), empty = $(emptyId), node = document.createTextNode("");
  box.append(node);
  return {
    add(t) {
      empty.hidden = true;
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
      // Starý text zahodíme, nech sa stránka pri dlhom počúvaní nespomalí.
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
  // Krátko ako na stanici „WPM:25“; podrobnosti v bubline.
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

// ---------- denné logy: zaškrtávadlo LOG v každej karte dekodéra ----------

for (const box of document.querySelectorAll("input[data-log]")) {
  box.addEventListener("change", () => {
    st.logs = { ...(st.logs || {}), [box.dataset.log]: box.checked };
    send({ log: st.logs });   // celý stav, nech sa dve rýchle zmeny v jednom odoslaní neprepíšu
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
  // Krátko „● 45.45 Bd 170 Hz N 12 dB“, tóny v bubline.
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

// ---------- zásuvky SET a MEM, hodiny, CW riadok ----------

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

// Klik na hodiny prepína UTC / miestny čas (LOC); voľba sa pamätá.
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


// ---------- pamäte ----------

let mems = [];
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
}

function renderMems() {
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
  // Pri zobrazení všetkých skupín zoskupujeme podľa pásma (MHz), inak je zoznam len zoradený.
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
  // Vyvolanie pamäte: frekvencia, mód a šírka pásma (na VFO, ktoré frekvenciu vie prijať).
  await ensureVfoFor(m.freq_hz);
  if (!st) return;
  st.mode = m.mode;
  st.bandwidth[m.mode] = m.bw;
  renderControls();
  tune(m.freq_hz);
  send({ mode: m.mode, bandwidth: m.bw });
  markActiveMem();
});

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

// ---------- stav zo servera ----------

let sampleRates = [];

function onStatus(s) {
  const first = !st;
  const rateChanged = st && st.audio_rate !== s.audio_rate;
  // Krátko po lokálnej zmene nenecháme starší stav zo servera prepísať ladenie a výber.
  if (st && Date.now() - localChangeAt < 700) {
    for (const k of ["tune_hz", "mode", "bandwidth", "zoom", "gain", "rtl_agc", "stereo_on", "notch", "ft8", "wefax", "cw", "rtty", "sstv", "acars", "logs", "upconv", "device", "squelch_levels"]) s[k] = st[k];
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
  $("acarsCard").hidden = !s.acars;
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
// Každé VFO je samostatný prijímač (vlastná kľúčenka a port). Udalosti počúvame zo všetkých:
// neaktívnym si pamätáme stav (lišta VFO) a riadky vodopádu, aby po prepnutí bola vidieť história.

const VFO_ROWS_MAX = 1400;

function connectEvents(v) {
  const es = new EventSource(v.base + "/api/events");
  const on = (kind, fn) => es.addEventListener(kind, (e) => { if (v === active) fn(JSON.parse(e.data)); });
  es.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    // Neaktívne VFO preladené kolieskom: starší stav zo servera nesmie vrátiť displej späť.
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
  on("ft8", decActivity);
  on("cwtext", decActivity);
  on("rttytext", decActivity);
  on("wefaxnew", decActivity);
  on("sstvnew", decActivity);
  on("acarsstate", renderAcarsInfo);
  on("acarsinfo", onAcarsInfo);
  on("ft8cycle", (d) => renderFt8Info(`cycle ${d.time} · decoding…`));
  es.onerror = () => {
    v.online = false;
    renderVfoDisplays();
    if (v === active) renderStatusPill();
  };
}

// Symbol USB (trojzubec): kruh, šípka, horná vetva s krúžkom, dolná so štvorčekom.
const USB_ICON = `<svg class="usb-icon" viewBox="0 0 690 440" aria-label="running"><g fill="currentColor">` +
  `<circle cx="78" cy="222" r="76"/><path d="M560 146 L690 222 L560 298 Z"/><circle cx="414" cy="56" r="52"/>` +
  `<rect x="430" y="322" width="118" height="118" rx="10"/></g><g fill="none" stroke="currentColor" stroke-width="38">` +
  `<path d="M140 222 H580"/><path d="M200 222 C250 160 250 56 370 56"/><path d="M290 222 C340 280 330 381 440 381"/></g></svg>`;

// Pri menej ako 4 SDR ostanú zvyšné okná VFO na mieste, ale bez funkcie (sivé, „NO SDR“),
// aby rozloženie obrazovky bolo vždy rovnaké. Pribudne SDR -> spustiť setup.bat.
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
    row.innerHTML = `<div class="vfo-head"><span class="flag vfo-stat off">NO SDR</span>` +
      `<button class="key vfo-key" disabled>VFO-${name}</button><span class="flag vfo-mode">---</span>` +
      `<span class="flag vfo-cue">CUE</span></div>` +
      `<div class="vfo-disp"><div class="freq">${seg7("          ")}<span class="unit">MHz</span></div></div>` +
      `<div class="vfo-foot"><label class="vfo-rf"><span>RF GAIN</span>` +
      `<input type="range" min="0" max="1" value="0" disabled></label><span class="flag vfo-gain">--- dB</span></div>` +
      `<div class="vfo-foot"><label class="vfo-rf vfo-sq"><span>SQUELCH</span>` +
      `<input type="range" min="0" max="1" value="0" disabled></label><span class="flag vfo-sql">---</span></div>`;
    $("vfoList").append(row);
  }
}

/** Displeje frekvencie všetkých VFO vedľa seba (pevné poradie A, B, C) s tlačidlom na prepnutie.
 *  Samostatný prijímač bez VFO má jediný displej bez tlačidla. */
function renderVfoDisplays() {
  const list = $("vfoList");
  for (const v of vfos) {
    let row = v.row;
    if (!row) {
      row = v.row = document.createElement("div");
      row.className = "vfo-row";
      row.dataset.vfo = String(v.name);
      // nad displejom stav prijímača, tlačidlo VFO, mód a CUE; pod displejom posuvník RF GAIN a hodnota zisku
      row.innerHTML = (v.name ? `<div class="vfo-head"><span class="flag vfo-stat"></span>` +
        `<button class="key vfo-key">VFO-${v.name}</button><span class="flag vfo-mode"></span>` +
        `<span class="flag vfo-cue" role="button">CUE</span></div>` : "") +
        `<div class="vfo-disp"><div class="freq"></div></div>` +
        (v.name ? `<div class="vfo-foot"><label class="vfo-rf"><span>RF GAIN</span>` +
        `<input type="range" min="0" max="0" step="1" value="0"></label>` +
        `<span class="flag vfo-gain" title="RF gain"></span></div>` +
        `<div class="vfo-foot vfo-sqrow"><label class="vfo-rf vfo-sq"><span>SQUELCH</span>` +
        `<input type="range" min="${SQUELCH_OFF}" max="-20" step="1" value="${SQUELCH_OFF}"></label>` +
        `<span class="flag vfo-sql"></span></div>` : "");
      if (v.name) row.querySelector(".vfo-key").title = `VFO ${v.name} · ${v.serial || ""}${v.note ? " · " + v.note : ""}`;
      list.append(row);
    }
    // Aktívne VFO ukazuje aj lokálne zmeny ešte pred odpoveďou prijímača.
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
    }
    if (!v.name) continue;
    // Stav prijímača VFO: RUNNING = kľúčenka otvorená a dodáva vzorky.
    const stat = row.querySelector(".vfo-stat");
    // Odpojená kľúčenka, chyba alebo nedostupný server VFO: sivé OFFLINE, podrobnosť v popise.
    const [stTxt, stCls, stTitle] = !v.online ? (v.st ? ["OFFLINE", "off", "connection to the VFO server lost"] : ["WAIT", "wait", "waiting for receiver"])
      : !s ? ["WAIT", "wait", "waiting for receiver"]
      : s.error ? ["OFFLINE", "off", s.error]
      : s.status === "running" ? ["RUNNING", "", "receiver running"]
      : s.status === "opening dongle" ? ["OPENING", "wait", "opening dongle"]
      : s.status === "calibrating" ? ["CAL", "wait", "LimeSDR calibration"]
      : ["OFFLINE", "off", `receiver ${s.status}`];
    // RUNNING sa zobrazí ako ikona USB (kľúčenka pripojená a dodáva dáta), ostatné stavy textom.
    const stHtml = stTxt === "RUNNING" ? USB_ICON : stTxt;
    if (stat.dataset.html !== stHtml) { stat.innerHTML = stHtml; stat.dataset.html = stHtml; }
    stat.className = `flag vfo-stat ${stCls}${stTxt === "RUNNING" ? " usb" : ""}`;
    stat.title = stTitle;
    const mode = row.querySelector(".vfo-mode"), gain = row.querySelector(".vfo-gain"), sql = row.querySelector(".vfo-sql");
    // bez stavu len zneviditeľniť, aby sa rozloženie neposúvalo
    mode.style.visibility = gain.style.visibility = sql.style.visibility = s ? "" : "hidden";
    if (s) {
      mode.textContent = s.mode;
      gain.textContent = s.gain === "auto" ? "AGC" : `${Number(s.gain).toFixed(1)} dB`;
      // posuvník: pri AGC zablokovaný (ako v SET); počas ťahania ho stav zo servera neprepisuje
      const rf = row.querySelector(".vfo-rf input");
      const gains = s.gains || [];
      rf.disabled = s.gain === "auto" || !gains.length;
      rf.max = Math.max(gains.length - 1, 0);
      if (document.activeElement !== rf && gains.length && s.gain !== "auto") {
        let best = 0;
        gains.forEach((g, i) => { if (Math.abs(g - s.gain) < Math.abs(gains[best] - s.gain)) best = i; });
        rf.value = best;
      }
      // squelch len v AM/FM/WFM; v ostatných módoch ostane na mieste, ale stlmený a nefunkčný
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
    // Squelch otvorený na neaktívnom VFO: tlačidlo zasvieti, aby bolo vidno aktivitu.
    row.classList.toggle("busy", !!(s && !isActive && s.squelch > SQUELCH_OFF && s.squelch_open));
  }
  renderTx();
}

// ---------- vysielanie (PTT) ----------
// PTT = držaný medzerník. Funguje len vtedy, keď je zvolené VFO, ktoré vie vysielať (LimeSDR);
// pri inom zvolenom VFO medzerník nerobí nič. Prepnutie VFO počas PTT vysielanie ukončí.
// Kým je PTT držané, každých 300 ms ide {"ptt": true}; server bez neho vysielanie sám vypne.
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
  e.preventDefault();               // medzerník nesmie stlačiť tlačidlo s fokusom ani posúvať stránku
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
  active = v;
  vbase = v.base;
  store("vfo", v.name);
  restoreBodyTab();
  // Všetko zobrazené patrí predošlému VFO: stav, vodopád, dekodéry.
  closeFreqInput();
  st = null; view = null; wfRow = null; spec = null; floor = null;
  errorUntil = 0; convPrev = null;
  for (const id of ["modes", "bandwidths", "steps", "zooms"]) $(id)._html = null;
  $("ft8Rows").innerHTML = ""; $("ft8Empty").hidden = false; ft8Cycle = null; ft8Count = 0;
  cwOut.clear(); rttyOut.clear();
  $("acarsRows").innerHTML = ""; $("acarsEmpty").hidden = false;
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

/** Frekvencia mimo rozsahu aktívneho VFO: prepne na VFO, ktoré ju vie prijať. */
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
  if (v !== active) return;
  for (const m of ac.messages) addAcars(m, false);
  renderAcarsInfo(ac);
}

// ---------- prepínač up-konvertora (VFO s konvertorom v režime Auto) ----------
// Konvertor má len ručný prepínač: pri prechode cez 30 MHz treba výrazne upozorniť.

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

// Audio hrá stále (aktívne VFO); ticho je len MUTE. Jeden AudioContext na celú stránku:
// prehliadač ho bez kliknutia používateľa nechá pozastavený, preto sa spustí pri prvom kliknutí či klávese.
// Ostatné VFO so zapnutým CUE hrajú popri ňom cez vlastný zosilňovač (CUE level).
let audio = null;
let actx = null;
let masterGain = null;
let cueGain = null;

function audioContext() {
  if (!actx) {
    actx = new AudioContext();
    masterGain = actx.createGain();
    masterGain.gain.value = volumeNow();
    masterGain.connect(actx.destination);
    cueGain = actx.createGain();
    cueGain.gain.value = cueVolumeNow();
    cueGain.connect(actx.destination);
    // merač výstupnej úrovne: MAIN + CUE (to, čo ide do reproduktora) rozdelené na L a R
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

/** Prehráva prúd /api/audio prijímača `base` do MAIN (isMain) alebo CUE. Keď prúd skončí sám
 *  (reštart prijímača, výpadok spojenia), po chvíli ho zastaví a zavolá onEnd, ktorý sa pripojí znova. */
function playStream(base, isMain, onEnd) {
  const ctx = audioContext();
  // Vlastný zosilňovač pre tento prúd: pri zastavení ho odpojíme a naplánované zvyšky stíchnu hneď.
  const gain = ctx.createGain();
  gain.connect(isMain ? masterGain : cueGain);
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

/** Spustí alebo zastaví prúdy CUE: hrá každé VFO so zapnutým CUE okrem aktívneho (to ide cez MAIN). */
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

/** Číta prúd a plánuje prehrávanie; vráti true, ak bol prúd zastavený zámerne. */
async function pumpStream(ctx, base, me, isMain) {
  const { gain, ctrl } = me;
  try {
    const res = await fetch(base + "/api/audio", { signal: ctrl.signal });
    const rate = Number(res.headers.get("X-Sample-Rate")) || st.audio_rate;
    const chans = Number(res.headers.get("X-Channels")) || 1;
    const frame = 2 * chans; // bajtov na jednu vzorku všetkých kanálov
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
      // Malý zásobník proti výpadkom; ak sa nahromadí oneskorenie, kúsok zahodíme.
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

// ---------- nahrávanie (WAV) ----------
// Ukladá surové PCM z prúdu aktívneho VFO (pred hlasitosťou a MUTE); pri prepnutí VFO pokračuje
// s novým prúdom. Po zastavení sa súbor stiahne cez prehliadač.
let rec = null;

function recordChunk(bytes, rate, chans) {
  if (!rec) return;
  if (!rec.rate) { rec.rate = rate; rec.chans = chans; }
  if (rate !== rec.rate || chans !== rec.chans) return; // iný formát by WAV pokazil
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

// ---------- stereo merač úrovne vedľa posuvníkov ----------
// LED zdola nahor: 10 zelených do 0 dB, potom žltá (+3 dB) a červená (+6 dB = 0 dBFS, orezanie).
// 0 dB merača = −6 dBFS, aby žltá a červená varovali pred orezaním.
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
    vuLevel[ch] = Math.max(db, vuLevel[ch] - 0.8);   // rýchly nábeh, pomalý pokles (~48 dB/s)
    vuLeds[ch].forEach((led, i) => led.classList.toggle("on", vuLevel[ch] >= VU_STEPS[i]));
  });
  requestAnimationFrame(animateVu);
}
requestAnimationFrame(animateVu);

let muted = false;
// MUTE stlmí MAIN aj CUE.
function volumeNow() { return muted ? 0 : Number($("volume").value); }
function cueVolumeNow() { return muted ? 0 : Number($("cueVolume").value); }
// vyfarbenie osi posuvníkov podľa úrovne (CSS --p = výška výplne, --vc = farba bežca)
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
  // So spúšťačom VFO stránka dostane zoznam VFO; samostatný prijímač zoznam nemá (jedno VFO bez lišty).
  let list = null;
  try {
    const r = await fetch("/api/vfos");
    if (r.ok) list = await r.json();
  } catch (e) { /* bez VFO */ }
  vfos = list && list.length
    ? list.map((x) => ({ ...x, base: `${location.protocol}//${location.hostname}:${x.port}`, st: null, rows: [], online: false,
        cue: recall("cue_" + x.name) === "1", cueAudio: null }))
    : [{ name: null, base: "", st: null, rows: [], online: false }];
  active = vfos.find((v) => v.name === recall("vfo")) || vfos[0];
  vbase = active.base;
  renderVfoDisplays();
  if (list && list.length) renderSpareVfos();
  renderCueKey();
  // Prijímače VFO sa po spustení otvárajú postupne: skúšame, kým aktívny neodpovie.
  let info = null;
  while (!info) {
    try { info = await fetch(vbase + "/api/state").then((r) => r.json()); } catch (e) {
      renderStatusPill();
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  sampleRates = info.sample_rates;
  renderFt8Bands(info.ft8_freqs);
  renderAcarsBands(info.acars_freqs);
  loadMems();
  for (const v of vfos) connectEvents(v);
  startAudio();
  await loadDecoders();
}
init();
