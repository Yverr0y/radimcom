"""Draws the annotated screenshots of docs/images/ (yellow callout boxes with lines to the parts of the screen).

  python docs/annotate.py            all sheets
  python docs/annotate.py main       one sheet

Each sheet = a screenshot + callouts. A callout has a title, a text, the box position on the canvas (x, y, width;
the height follows the text) and the target in the coordinates of the SCREENSHOT: a point (x, y) or a region
(x, y, w, h) that gets a yellow outline. The browser lays out the boxes and draws the lines (from the box edge
to the nearest point of the target). Needs Chrome or Edge. Standard library only.
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from html import escape as E

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "images")
BROWSERS = [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"]


def C(title, text, box, target):
    return {"title": title, "text": text, "box": box, "target": target}


# ---------------------------------------------------------------- main screen
# screenshot 1660 x 919, placed at (OX, OY)
MAIN_OX, MAIN_OY = 420, 380
TW = 196          # width of a box in the top row
def top(i):       # x of the i-th box of the top row
    return 20 + i * (TW + 13)
BW = 290          # width of a box in the bottom row
def bot(i):
    return 20 + i * (BW + 22)
RX = MAIN_OX + 1660 + 30

MAIN = {
    "name": "main",
    "image": "0.114main.PNG",
    "out": "main_annotated.png",
    "size": (2500, None),
    "origin": (MAIN_OX, MAIN_OY),
    "title": "RADIMCOM 0.114 – main screen",
    "subtitle": "Head with the four VFO windows, the key rows, and the lower part with the tabs (here SPECTRUM). "
                "Details in docs/controls.md.",
    "callouts": [
        # --- top row: the VFO window
        C("VFO WINDOW", "One display per receiver (VFO-A … D). The active one is faintly lit; a click on another "
          "window selects it.", (top(0), 110, TW), (258, 18)),
        C("TONE SQUELCH", "CTCSS tone and DCS code (TSQ-C / TSQ-D): dark = off, orange = on, lit box = the tone "
          "is received now.", (top(1), 110, TW), (300, 77)),
        C("INFO ROW", "RX / TX, filter width, audio HPF and LPF, ST stereo, SQL squelch state and CONV / BYPASS "
          "of the upconverter switch.", (top(2), 110, TW), (282, 92)),
        C("ANNUNCIATORS", "Lit functions: mode, AGC / AGC+, NF, SP, ALC, AFI, ASQ, ATU, satellite Doppler and CUE "
          "(a click toggles CUE).", (top(3), 110, TW), (360, 107)),
        C("RF / SQL BARS", "RF gain and squelch level: drag, click or mouse wheel – also on an inactive VFO "
          "without switching.", (top(4), 110, TW), (262, 114, 212, 26)),
        C("NAME", "Memory, band plan entry or satellite transponder on this frequency; a memory with its own tag "
          "colour shows in that colour.", (top(5), 110, TW), (378, 29)),
        C("FREQUENCY", "Click to type a new one (7100, 145.5 …). Mouse wheel over a digit tunes by that digit. "
          "kHz below 30 MHz, MHz above; the small digits are Hz.", (top(6), 110, TW), (316, 42, 150, 34)),
        C("SDR STATE", "USB icon: green = dongle running, blinking orange = connecting, grey = disconnected "
          "(hover for details).", (top(7), 110, TW), (464, 30)),
        C("DECODER MUTE", "Struck-through red speaker: a decoder (ACARS, VDL2, HFDL, AIS, ISM) has muted the audio "
          "of this VFO.", (top(8), 110, TW), (674, 30)),
        C("INACTIVE VFOs", "VFO-B, C, D keep receiving at the same time: live frequency, mode, level and squelch. "
          "A green VFO label = squelch open.", (top(9), 110, TW), (712, 16, 446, 126)),
        # --- left column
        C("S-METER", "Signal of the active VFO in S-units and dBFS. Yellow mark = squelch level. Seven layouts in "
          "SETTINGS › GENERAL › S-METER, S9 calibration per VFO.", (20, MAIN_OY, 370), (32, 20, 214, 86)),
        C("CPU / MEM", "Load of the processor and memory use of the PC running RADIMCOM (amber over 70 %, "
          "red over 90 %).", (20, None, 370), (60, 120, 172, 14)),
        C("VFO + CUE KEYS", "VFO-A … D select the receiver (yellow LED = active, green = squelch open, red = TX). "
          "CUE keeps that VFO audible at the CUE level while another one is selected.", (20, None, 370),
          (256, 153, 218, 26)),
        C("VIEW", "Hides the whole lower part with the tabs and shows it again.", (20, None, 370), (30, 198, 44, 60)),
        C("BAND KEYS", "Bands in four groups: HF HAM, HF BROADCAST, VHF / UHF HAM, OTHER. If the band is out of "
          "range of the active VFO, a VFO that can receive it is selected. MENU › BAND hides the row.",
          (20, None, 370), (26, 286, 1604, 28)),
        C("TABS", "SPECTRUM, and when switched on DECODERS, SATELLITES, MEMORIES, SCAN, RECORDINGS, SETTINGS, "
          "ROTOR CONTROL.", (20, None, 370), (34, 337, 84, 18)),
        C("SPECTRUM", "Live spectrum of the dongle band in dBFS. Click = tune, drag the passband = move it, drag "
          "its edge = filter width, mouse wheel = step.", (20, None, 370), (30, 460)),
        C("WATERFALL", "The history of the band. Drag = move the band, click = tune, hover = frequency under the "
          "mouse.", (20, None, 370), (30, 760)),
        C("HELP LINE", "Short help for the mouse and the arrow keys (↑ ↓ = next memory in view).",
          (20, None, 370), (36, 890)),
        # --- right column
        C("CLOCK", "Local time or UTC (a click switches), the date of the same zone. The glass under it (AD) shows "
          "errors, rotor AZ / EL, DAB now on air or RDS.", (RX, 110, 370), (1170, 20, 194, 120)),
        C("LOGO + VERSION", "A click opens the project on GitHub. Turns red when a newer version is released.",
          (RX, None, 370), (1428, 30, 166, 62)),
        C("MAIN / CUE FADERS", "Volume of the active VFO (MAIN) and of the VFOs with CUE, dB scale +3 … −∞ "
          "between them.", (RX, None, 370), (1392, 152, 64, 102)),
        C("OUTPUT METER", "Stereo L / R level with 1 s peak hold and a round CLIP LED above each column (0 dBFS).",
          (RX, None, 370), (1460, 152, 36, 90)),
        C("MUTE", "Speaker key: green LED = sound on, red = muted.", (RX, None, 370), (1508, 155, 122, 24)),
        C("REC / REC SQ", "Recording of the active VFO to MP3. REC = everything until switched off; REC SQ = only "
          "while the squelch is open, one file per transmission.", (RX, None, 370), (1508, 207, 122, 50)),
        C("ZOOM", "Zoom of the spectrum 1× – 32×: − / +, a click on a cell or the mouse wheel.",
          (RX, None, 370), (1504, 358, 116, 15)),
        C("PASSBAND LABEL", "Tuned frequency, mode and filter width. Hover = audio spectrum of the VFO (MPX in WFM, "
          "decoded text in CW).", (RX, None, 370), (714, 393, 76, 31)),
        C("WATERFALL SETTINGS", "Gear: colour scheme, range and offset. Bar under it: waterfall speed 1/8 – 4×.",
          (RX, None, 370), (1596, 573, 26, 142)),
        C("BAND PLAN", "The band of the band plan (blue bar) and the memories in view as tags above the spectrum.",
          (RX, None, 370), (1100, 377, 520, 11)),
        # --- bottom row: the key row
        C("MODE", "Demodulation AM, FM, WFM, LSB, USB, CW; DAB turns on DAB / DAB+ radio, DSD digital voice "
          "(DMR, P25, D-Star …).", (bot(0), "B", BW), (110, 198, 188, 58)),
        C("FILTER", "Bandwidth for the current mode. Any width also by dragging the passband edge in the spectrum.",
          (bot(1), "B", BW), (330, 198, 130, 58)),
        C("GAIN", "AGC = automatic tuner gain. AGC+ = as high as possible without clipping the A/D (red line when "
          "it clips).", (bot(2), "B", BW), (472, 198, 52, 58)),
        C("STEP + ATU", "Tuning step for the wheel and the arrow keys. ATU (USB, LSB, AM) moves the tuning onto the "
          "carrier / voice edge after a click.", (bot(3), "B", BW), (554, 198, 190, 58)),
        C("AUDIO", "S/M stereo / mono, NF notch, SP spurs, LPF / HPF, ALC, AFI inversion, ASQ auto squelch, "
          "TSQ-C / TSQ-D tone squelch, CUE, RECS = recordings tab.", (bot(4), "B", BW), (776, 198, 292, 58)),
        C("DECODE", "FT8, WEFAX, CW, RTTY, SSTV, PACKET, ACARS, VDL2, HFDL, AIS, ISM – panels in the DECODERS tab.",
          (bot(5), "B", BW), (1100, 198, 64, 58)),
        C("TRACKING", "SAT = satellites tab (passes, map, Doppler, rotor). RCTRL = rotor control map.",
          (bot(6), "B", BW), (1194, 198, 52, 58)),
        C("MENU", "Gear = SETTINGS, MEM = memories, SCAN = scanner, BAND = show / hide the band keys.",
          (bot(7), "B", BW), (1278, 198, 96, 58)),
    ],
}

def row(i, n, W, gap=14):
    """(x, width) of the i-th of n boxes spread over a canvas W wide"""
    w = (W - 40 - (n - 1) * gap) // n
    return 20 + i * (w + gap), w


def boxes(n, W, y):
    return [(row(i, n, W)[0], y, row(i, n, W)[1]) for i in range(n)]


# ---------------------------------------------------------------- SATELLITES › TRACK (sat_track.png 1887 x 601)
SW = 1950
st, sb = boxes(6, SW, 110), boxes(4, SW, "B")
SAT = {
    "name": "satellites",
    "image": "sat_track.png",
    "out": "satellites_annotated.png",
    "size": (SW, None),
    "origin": (31, 285),
    "title": "RADIMCOM – SATELLITES › TRACK",
    "subtitle": "Doppler correction and the rotor for one satellite. Opened by the SAT key (TRACKING group). "
                "Details in docs/satellites.md.",
    "callouts": [
        C("TABS", "The SATELLITES tab beside SPECTRUM and DECODERS; the SAT key switches to it and back.",
          st[0], (6, 8, 292, 22)),
        C("PAGES", "PASSES = timeline of passes, MAP = world map with footprints, TRACK = Doppler + rotor, "
          "SETUP = station and the satellites on the timeline.", st[1], (12, 41, 222, 21)),
        C("SATELLITE", "A satellite of the timeline (SETUP). Doppler and rotor work on this VFO and go on when "
          "the page is closed.", st[2], (70, 80, 228, 32)),
        C("DOPPLER (RECEIVE)", "The transponder tracked, the frequency the satellite sends, the VFO frequency with "
          "the Doppler shift, the satellite's azimuth / elevation and range rate now.", st[3], (20, 143, 952, 118)),
        C("AMSAT LISTS", "LINEAR, FM, IMAGE, MISC: active satellites from AMSAT with their frequencies, kept 12 h.",
          st[4], (248, 41, 206, 21)),
        C("ROTOR PLAN", "The pass being tracked and the plan of the rotor: normal, overlap (K3NG azimuth up to 450°) "
          "or flipped (over the top), with the expected pointing error.", st[5], (984, 143, 870, 118)),
        C("TRANSMITTERS", "From SatNOGS DB. A click tunes the VFO, sets the mode and keeps correcting the Doppler "
          "shift; OFF stops the correction. Tuning by hand within the transponder keeps it.", sb[0],
          (20, 268, 952, 142)),
        C("TRACK / STOP", "TRACK follows the passes of the satellite and moves the rotor, a second press ends it. "
          "STOP stops both motors and ends the tracking.", sb[1], (984, 277, 174, 24)),
        C("POLAR PLOT", "The track of the next pass over the sky from AOS to LOS (north up, centre = zenith).",
          sb[2], (995, 336, 215, 222)),
        C("PASS DATA", "AOS, maximum elevation, LOS, length, nearest distance, Doppler range at 145.9 / 435 MHz, "
          "age of the orbital elements and the time to AOS.", sb[3], (1218, 338, 304, 166)),
    ],
}

# ---------------------------------------------------------------- DAB / DAB+ (dab_decoder.png, the tab only)
DW = 1940
dt, db = boxes(6, DW, 110), boxes(5, DW, "B")
DAB = {
    "name": "dab",
    "image": "dab_decoder.png",
    "out": "dab_annotated.png",
    "crop": (20, 385, 1877, 505),
    "size": (DW, None),
    "origin": (31, 250),
    "title": "RADIMCOM – DAB / DAB+ radio",
    "subtitle": "The DAB tab, opened by the DAB key in MODE. Decoded by welle-cli, RTL-SDR only. "
                "Details in docs/decoders/dab.md.",
    "callouts": [
        C("ON", "DAB decoding on / off.", dt[0], (52, 400, 46, 20)),
        C("CHANNEL", "The Band III channel of your region (e.g. 12C), remembered per VFO with its last station.",
          dt[1], (106, 398, 172, 26)),
        C("ENSEMBLE", "The ensemble name with its country flag and the channel frequency.", dt[2],
          (284, 398, 194, 26)),
        C("STATION", "Name, programme type, DAB / DAB+, bitrate, language, error protection and codec.",
          dt[3], (708, 472, 400, 82)),
        C("NOW ON AIR", "The DLS text (artist, song). The station and DLS also show in the AD window of the head.",
          dt[4], (708, 562, 846, 54)),
        C("SIGNAL", "SNR with a quality mark (DAB+ needs roughly 8 dB or more), frequency correction and "
          "FIC CRC errors.", dt[5], (1572, 460, 290, 142)),
        C("STATION LIST", "The stations of the ensemble with DAB / DAB+ and bitrate. Click = listen, click again = "
          "stop.", db[0], (52, 460, 298, 420)),
        C("SLIDESHOW", "The picture the station sends (cover, logo, news).", db[1], (376, 470, 322, 244)),
        C("ERRORS", "Decoding errors (frame, RS, AAC), service ID and subchannel.", db[2], (364, 734, 292, 18)),
        C("ENSEMBLE", "Name, country, ID, number of stations, local time and UTC of the ensemble.", db[3],
          (1572, 612, 290, 150)),
        C("MULTIPLEX CAPACITY", "The share of each station in the multiplex; the one playing is yellow.", db[4],
          (1572, 774, 290, 100)),
    ],
}

SHEETS = [MAIN, SAT, DAB]


JS = r"""
const S = SHEET, svg = document.getElementById('lines'), NS = 'http://www.w3.org/2000/svg';
const crop = S.crop || [0, 0, 0, 0];
const ox = S.origin[0] - crop[0], oy = S.origin[1] - crop[1];   // target (screenshot) -> canvas
function el(n, a) { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); svg.appendChild(e); return e; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const boxes = [...document.querySelectorAll('.box')];
// layout: y null = under the previous box of the same column, "B" = the bottom row under everything
const colEnd = {}; let low = S.origin[1] + document.getElementById('shot').offsetHeight + 24;
boxes.forEach((b, i) => {
  const [x, y] = S.callouts[i].box;
  if (y === 'B') return;
  const top = y === null ? colEnd[x] + 14 : y;
  b.style.top = top + 'px';
  colEnd[x] = top + b.offsetHeight; low = Math.max(low, colEnd[x] + 30);
});
let H = low;
boxes.forEach((b, i) => { if (S.callouts[i].box[1] === 'B') { b.style.top = low + 'px'; H = Math.max(H, low + b.offsetHeight + 24); } });
H = S.size[1] || H;
document.getElementById('c').style.height = H + 'px'; svg.setAttribute('height', H);
document.body.setAttribute('data-h', H);
const ends = [];
document.querySelectorAll('.box').forEach((b, i) => {
  const c = S.callouts[i], r = b.getBoundingClientRect(), t = c.target;
  let tx, ty;
  const bx = r.left + r.width / 2, by = r.top + r.height / 2;
  if (t.length === 4) {
    const [x, y, w, h] = [t[0] + ox, t[1] + oy, t[2], t[3]];
    el('rect', {x, y, width: w, height: h, rx: 4, class: 'reg-h'});
    el('rect', {x, y, width: w, height: h, rx: 4, class: 'reg'});
    tx = clamp(bx, x, x + w); ty = clamp(by, y, y + h);
  } else { tx = t[0] + ox; ty = t[1] + oy; }
  const ax = clamp(tx, r.left, r.right), ay = clamp(ty, r.top, r.bottom);
  ends.push([ax, ay, tx, ty]);
});
// halos first, then the lines, so a line never disappears under the halo of another one
ends.forEach(([ax, ay, tx, ty]) => el('line', {x1: ax, y1: ay, x2: tx, y2: ty, class: 'halo'}));
ends.forEach(([ax, ay, tx, ty]) => el('line', {x1: ax, y1: ay, x2: tx, y2: ty, class: 'ln'}));
ends.forEach(([ax, ay, tx, ty]) => el('circle', {cx: tx, cy: ty, r: 5.5, class: 'dot'}));
"""

CSS = """
body{margin:0;background:#16191d;font-family:'Segoe UI',Arial,sans-serif}
#c{position:relative;overflow:hidden}
#shot{position:absolute;overflow:hidden;box-shadow:0 0 0 1px #3a4048,0 10px 40px rgba(0,0,0,.6)}
h1{position:absolute;left:20px;top:14px;margin:0;color:#ffd23f;font-size:34px;font-weight:700;letter-spacing:.5px}
.sub{position:absolute;left:22px;top:60px;color:#aab3bd;font-size:16px}
.box{position:absolute;box-sizing:border-box;background:#ffd23f;border:2px solid #a07800;border-radius:7px;
     padding:7px 10px 8px;color:#1b1b1b;box-shadow:0 3px 10px rgba(0,0,0,.55);z-index:2}
.box b{display:block;font-size:16px;letter-spacing:.6px;margin-bottom:2px}
.box span{font-size:14px;line-height:1.3}
#shot img{display:block;position:relative}
#lines{position:absolute;left:0;top:0;z-index:1}
.halo{stroke:#000;stroke-opacity:.8;stroke-width:5.5;stroke-linecap:round}
.ln{stroke:#ffd23f;stroke-width:2;stroke-linecap:round}
.dot{fill:#ffd23f;stroke:#000;stroke-width:2}
.reg-h{fill:none;stroke:#000;stroke-opacity:.7;stroke-width:5}
.reg{fill:none;stroke:#ffd23f;stroke-width:2}
"""


def page(sheet):
    W, H = sheet["size"]
    ox, oy = sheet["origin"]
    with open(os.path.join(IMG, sheet["image"]), "rb") as f:
        data = base64.b64encode(f.read()).decode()
    cx, cy, cw, ch = sheet.get("crop") or (0, 0, 0, 0)
    size = f";width:{cw}px;height:{ch}px" if cw else ""
    shift = f' style="left:-{cx}px;top:-{cy}px"' if cw else ""
    boxes = "".join(
        f'<div class="box" style="left:{c["box"][0]}px;width:{c["box"][2]}px">'
        f'<b>{E(c["title"])}</b><span>{E(c["text"])}</span></div>' for c in sheet["callouts"])
    return (f'<!DOCTYPE html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body>'
            f'<div id="c" style="width:{W}px;height:{H or 3000}px">'
            f'<h1>{E(sheet["title"])}</h1><div class="sub">{E(sheet["subtitle"])}</div>'
            f'<div id="shot" style="left:{ox}px;top:{oy}px{size}"><img src="data:image/png;base64,{data}"{shift}></div>'
            f'<svg id="lines" width="{W}" height="{H or 3000}"></svg>{boxes}</div>'
            f'<script>const SHEET={json.dumps(sheet)};addEventListener("load",()=>{{{JS}}});</script></body></html>')


def render(sheet):
    browser = next((b for b in BROWSERS if os.path.exists(b)), None)
    if not browser:
        sys.exit("Chrome or Edge not found")
    W, H = sheet["size"]
    out = os.path.join(IMG, sheet["out"])
    with tempfile.TemporaryDirectory() as tmp:
        html = os.path.join(tmp, "sheet.html")
        png = os.path.join(tmp, "sheet.png")
        with open(html, "w", encoding="utf-8") as f:
            f.write(page(sheet))
        url = "file:///" + html.replace("\\", "/")
        common = [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={tmp}\\profile",
                  "--virtual-time-budget=2000"]
        if H is None:   # first pass: the page lays out the boxes and says how tall it is
            dom = subprocess.run(common + [f"--window-size={W},3000", "--dump-dom", url], check=True, timeout=120,
                                 capture_output=True, text=True, encoding="utf-8").stdout
            H = int(re.search(r'data-h="(\d+)"', dom).group(1))
        subprocess.run(common + ["--force-device-scale-factor=1", f"--window-size={W},{H}", f"--screenshot={png}", url],
                       check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not os.path.exists(png):
            sys.exit("the browser did not write the image")
        os.replace(png, out)
    print(f"{out}: {os.path.getsize(out) / 1e6:.1f} MB")


if __name__ == "__main__":
    want = sys.argv[1:]
    for s in SHEETS:
        if not want or s["name"] in want:
            render(s)
