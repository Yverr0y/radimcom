"""Draws docs/images/block_diagram.png. Edit the drawing below and run it after a change of the components:

  python docs/block_diagram.py

The version in the subtitle is written by hand: it says for which version the diagram is valid.
Needs Chrome or Edge, which turn the drawing (an SVG in a page) into the PNG. Standard library only.
"""
import os
import subprocess
import sys
import tempfile
from html import escape as E

W,H=2420,1740
INK="#1f2933";MUTE="#5b6875";LINE="#c3ccd5"
C={"iq":"#0b6fb8","audio":"#c2570c","ctl":"#39434e","ev":"#7a3fb5","file":"#8a6d1f","net":"#12805c"}
FILL={"ui":"#eaf3fb","srv":"#f3eefa","dsp":"#e8f6f3","dec":"#fdf3e4","dev":"#eef1f4","ext":"#fbeaea","data":"#fbf7e6","net":"#e8f6ee","tool":"#f2f4f6","hw":"#e7e9ec"}
o=[]
def rect(x,y,w,h,fill="#fff",stroke=LINE,sw=1.5,r=8,dash=None):
    d=f' stroke-dasharray="{dash}"' if dash else ''
    o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')
def text(x,y,s,size=15,fill=INK,weight=400,anchor="start",mono=False,rot=None,halo=False):
    fam="Consolas,monospace" if mono else "'Segoe UI',Arial,sans-serif"
    t=f' transform="rotate({rot} {x} {y})"' if rot is not None else ''
    h=' paint-order="stroke" stroke="#fff" stroke-width="5" stroke-linejoin="round"' if halo else ''
    o.append(f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{t}{h}>{E(s)}</text>')
def group(x,y,w,h,title,fill,sub=None,tx=None):
    rect(x,y,w,h,fill=fill,stroke="#9aa6b2",r=12)
    text(tx if tx else x+16,y+27,title,18,weight=700)
    if sub: text(tx if tx else x+16,y+49,sub,13.5,MUTE)
def box(x,y,w,h,name,lines=(),mono=True,fill="#fff",size=15):
    rect(x,y,w,h,fill=fill)
    n=1+len(lines);lh=18
    y0=y+h/2-(n*lh)/2+14
    text(x+w/2,y0,name,size,weight=700,anchor="middle",mono=mono)
    for i,l in enumerate(lines):
        text(x+w/2,y0+(i+1)*lh,l,13,MUTE,anchor="middle")
def path(pts,kind,start=False,end=True,dash=None,sw=2.4):
    d="M"+" L".join(f"{a},{b}" for a,b in pts)
    c=C[kind]
    o.append(f'<path d="{d}" fill="none" stroke="#fff" stroke-width="{sw+4}"/>')
    a=f' marker-end="url(#a-{kind})"' if end else ''
    s=f' marker-start="url(#s-{kind})"' if start else ''
    ds=f' stroke-dasharray="{dash}"' if dash else ''
    o.append(f'<path d="{d}" fill="none" stroke="{c}" stroke-width="{sw}"{ds}{a}{s}/>')
def label(x,y,s,kind=None,anchor="middle",size=13,rot=None):
    text(x,y,s,size,C[kind] if kind else MUTE,600 if kind else 400,anchor,rot=rot,halo=True)

# Title
text(40,50,"RADIMCOM: block diagram of all components",32,weight=700)
text(40,78,"Signal flows from the hardware at the bottom up to the browser at the top. Ver. 0.109",16,MUTE)

# ---------- top row ----------
group(40,115,300,215,"VFO launcher",FILL["srv"])
box(60,155,260,70,"launcher.py",["serves the page and /api/vfos on :8434"])
text(60,250,"Starts one receiver per VFO.",13.5,MUTE)
text(60,270,"Without vfos.json: one receiver on",13.5,MUTE)
text(60,288,":8434, settings from config.json.",13.5,MUTE)
text(60,310,"start.bat → app.py → launcher",13.5,MUTE)

group(380,115,1090,215,"Web browser",FILL["ui"],"The page talks directly to each VFO's port; localStorage holds UI preferences")
box(400,180,200,132,"index.html",["style.css","layout, VFO windows,","function keys"],)
box(614,180,200,132,"app.js",["UI logic, one connection","set per VFO"])
box(828,180,200,132,"bandplan.js",["icao_countries.js","band labels and","aircraft country flags"])
box(1042,180,200,132,"Display",["S-meter, spectrum,","waterfall, decoder cards"],mono=False)
box(1256,180,200,132,"Web Audio",["MAIN and CUE faders,","level meter,","REC to a WAV file"],mono=False)

group(1510,115,270,215,"Scripts and other programs",FILL["tool"])
text(1526,175,"Anything can drive a receiver",14,MUTE)
text(1526,195,"through the same HTTP API.",14,MUTE)
box(1530,225,230,60,"API/API.md",["API description"])

group(1860,115,520,215,"Internet (optional)",FILL["net"],"Decoding works without it; these only add detail")
box(1880,180,235,132,"opendata.adsb.fi",["api.adsb.lol","aircraft type, flight level,","speed, position"])
box(2130,180,235,132,"flagcdn.com",["country flag images;","globe.adsb.fi and adsb.lol","open as map links"])

# ---------- receiver process ----------
for d in (16,8):
    rect(40+d,440+d,1740,810,fill="#e4dcf2",stroke="#9aa6b2",r=12)
rect(40,440,1740,810,fill=FILL["srv"],stroke="#7f6aa8",sw=2,r=12)
text(640,468,"VFO receiver process: app.py --vfo A | B | C | D",19,weight=700)
text(640,488,"one process per VFO, port :8441–:8444, own config_X.json. Flask, NumPy, SciPy",13.5,MUTE)

# API row
Y=500;HA=58
box(110,Y,320,HA,"/api/set /state /tx /devices /mpx",["tuning, mode, gain, PTT, MPX spectrum"],size=14)
box(450,Y,500,HA,"/api/ft8 /wefax /sstv /cw /rtty /acars /cpdlc",["decoder on/off, options, messages and images"],size=14)
box(1140,Y,98,HA,"/events",["SSE"],size=14)
box(1248,Y,98,HA,"/audio",["16-bit PCM"],size=14)
box(1362,Y,230,HA,"/api/vdl2 /api/dab/* /api/dsd",["control; DAB data, DSD calls"],size=13.5)
box(1612,Y,150,HA,"/api/memories",["list, edit, import"],size=14)
text(960,533,"Flask API in app.py",13.5,MUTE)
box(1140,590,206,46,"Hub",["broadcast to browsers"],size=14)

# Decoders
group(110,680,850,195,"Decoders on baseband (on_baseband)",FILL["dec"],tx=126)
BW=196
for i,(n,l) in enumerate([("ft8.py",["needs PyFT8"]),("wefax.py",["radio fax, PNG images"]),("cw.py",["Morse, AFC, speed"]),("rtty.py",["Baudot, auto shift, speed"])]):
    box(126+i*(BW+10),716,BW,60,n,l)
box(126,792,250,31,"adsc.py: ADS-C reports",[],size=13.5)
box(126,827,250,31,"cpdlc_schema.py: message set",[],size=13.5)
box(430,792,210,66,"cpdlc.py",["FANS-1/A, ARINC 622"])
box(714,792,226,66,"acars.py",["ACARS, AM MSK 2400 bit/s"])
group(980,680,150,195,"Audio",FILL["dec"],tx=994)
box(994,716,122,72,"sstv.py",["on_demod","14 modes, VIS"])
box(994,796,122,70,"dsd.py",["on_dsd","digital voice"])
group(1362,680,290,195,"Raw IQ decoders (on_raw)",FILL["dec"],tx=1376)
box(1416,716,222,46,"vdl2.py",["VDL2 channels, ATN CPDLC"])
box(1416,768,222,40,"airports.py",["+ VDL2_Ground_Stations.txt"],size=13)
box(1416,818,222,48,"dab.py",["DAB / DAB+"])

# DSP
group(70,930,1270,170,"Receiver in sdr.py: DSP chain",FILL["dsp"],tx=360)
Yd=972;Hd=58
chain=[(90,150,"Shift",["NCO to the tuned freq."]),(258,155,"Decimator",["polyphase FIR /64"]),(431,175,"Channel filter",["by mode, LPF/HPF, notch"]),(624,180,"Demodulator",["AM FM LSB USB CW WFM"]),(822,160,"Squelch, AGC",["decides about every 8 ms"]),]
for x,w,n,l in chain:
    box(x,Yd,w,Hd,n,l,mono=False,size=14.5)
box(1000,1042,120,44,"Waterfall",["FFT, zoom 1–32×"],mono=False,size=13.5)
box(1224,Yd,100,Hd,"PCM",["stereo audio"],mono=False,size=14.5)
box(624,1042,180,44,"rds.py",["RDS in WFM"],size=13.5)
for a,b in [(240,258),(413,431),(606,624),(804,822)]:
    path([(a,Yd+29),(b,Yd+29)],"iq",sw=2)
path([(982,Yd+29),(1224,Yd+29)],"audio",sw=2)
path([(714,1030),(714,1042)],"iq",sw=2)

# Device layer
group(70,1125,1370,110,"Device layer: same interface for all, chosen by open_device()",FILL["dev"])
box(90,1165,235,58,"RtlSdr",["in sdr.py, via ctypes"],size=14.5)
box(345,1165,235,58,"LimeSdr",["lime.py, RX and optional TX"],size=14.5)
box(600,1165,235,58,"ChainedSdr",["iqshare.py, no dongle of its own"],size=14.5)
box(1030,1165,190,58,"IqServer",["iqshare.py, owner VFO"],size=14.5)
text(1236,1185,"A chained VFO's dongle",12.5,MUTE)
text(1236,1202,"settings are forwarded to",12.5,MUTE)
text(1236,1219,"the owner's /api/set",12.5,MUTE)
path([(1030,1194),(835,1194)],"iq")
label(932,1186,"TCP :port+100")
label(932,1212,"to another VFO")

# Persistence
group(1460,930,300,305,"Storage modules",FILL["data"])
box(1480,968,260,60,"memories.py",["memories, SDR# import"])
box(1480,1038,260,60,"paths.py",["locates data\\, migrates old files"])
box(1480,1108,260,50,"daylog.py",["daily decoder logs"])
text(1610,1183,"config saving: app.py",13,MUTE,anchor="middle")
text(1610,1202,"logs and images: the decoders",13,MUTE,anchor="middle")

# ---------- external programs ----------
group(2020,430,360,445,"Separate programs (lib\\)",FILL["ext"])
box(2040,475,320,110,"dsd-fme.exe",["DMR, P25, D-Star, YSF, NXDN, dPMR, M17...","mbelib; ISC, parts GPL v2","downloaded by install_dsd.bat, not in the zips"])
box(2040,605,320,110,"dumpvdl2.exe",["demodulation, FEC, ATN ASN.1","libacars, MSYS2 runtime; GPL v3"])
box(2040,735,320,120,"welle-cli.exe",["OFDM, Viterbi, AAC / MP2","FFTW, FAAD2, mpg123, LAME;","GPL v2 or later"])

# ---------- data ----------
group(1860,905,520,330,"data\\ folder: your settings and logs, never packaged",FILL["data"])
rows=[("vfos.json","dongle to VFO assignment"),("config.json","single-receiver settings, VFO template"),("config_A…D.json","settings of each VFO"),("memories.json","frequency memories"),("logs\\  acars\\","daily decoder logs (UTC)"),("wefax\\  sstv\\","saved images (PNG)"),("tx_audio\\","optional FM test message"),("config_backup\\","previous vfos.json and configs"),("eeprom_backup\\","dongle EEPROM backups")]
for i,(a,b) in enumerate(rows):
    y=962+i*29
    text(1880,y,a,14.5,weight=700,mono=True); text(2060,y,b,14,MUTE)

# ---------- native + drivers + hw ----------
group(70,1285,530,135,"Native libraries (lib\\)",FILL["dev"])
text(312,1310,"loaded through ctypes",13,MUTE)
box(90,1322,235,40,"librtlsdr.dll",[],size=14.5)
box(90,1370,235,40,"libusb-1.0.dll",[],size=14.5)
box(345,1322,235,88,"LimeSuite.dll",["from lib\\ or PothosSDR"],size=14.5)
group(70,1432,530,75,"Windows USB drivers",FILL["dev"],tx=240)
box(90,1448,135,46,"WinUSB",["with Zadig"],mono=False,size=14)
box(445,1448,135,46,"FTDI D3XX",["driver"],mono=False,size=14)
group(70,1520,530,190,"Hardware",FILL["hw"],tx=280)
box(90,1560,235,56,"RTL-SDR dongles",["up to 4, picked by serial"],mono=False,size=14.5)
box(345,1560,235,56,"LimeSDR Mini",["RX, optional TX on PTT"],mono=False,size=14.5)
box(90,1638,110,58,"HF up-",["converter"],mono=False,size=14)
box(215,1638,110,58,"VHF/UHF",["antenna"],mono=False,size=14)
box(345,1638,235,58,"Antenna / dummy load",["filter when transmitting"],mono=False,size=14)

# Tools
group(640,1285,1140,425,"Install, setup and build tools (run outside the receiver)",FILL["tool"])
text(660,1336,"Install and run",15,weight=700)
box(660,1348,230,60,"install.bat",["creates .venv, pip packages, PyFT8"])
box(900,1348,240,60,"install_dsd.bat",["downloads DSD-FME to lib\\dsd-fme"])
box(1150,1348,130,60,"start.bat",["starts app.py"])
box(1290,1348,170,60,"zadig.exe",["installs WinUSB driver"])
box(1470,1348,290,60,"drivers\\  INSTALL.txt  DRIVERS.txt",["USB drivers and installation guide"],size=14)
text(660,1446,"Setup and maintenance",15,weight=700)
box(660,1458,250,60,"setup.bat",["starts the wizard"])
box(935,1458,300,60,"setup_sdr.py",["wizard: finds dongles, writes vfos.json"])
box(1260,1458,250,60,"eeprom_tool.py",["read, back up, write serial number"])
path([(910,1488),(935,1488)],"ctl",sw=2)
path([(1235,1488),(1260,1488)],"ctl",sw=2)
text(1525,1482,"Both open the dongles through",13,MUTE)
text(1525,1500,"sdr.py / lime.py; receiver stopped",13,MUTE)
text(660,1556,"Build (installer\\)",15,weight=700)
box(660,1568,250,60,"make_installer.py",["install and upgrade zips"])
box(935,1568,250,60,"make_sources.py",["GPL / LGPL source zip"])
box(1210,1568,250,60,"build_dab.sh",["builds welle-cli (MSYS2)"])
box(1485,1568,275,60,"dist\\",["zip packages for GitHub Releases"])
text(660,1660,"Git-ignored and not in the repository: lib\\, drivers\\, data\\, dist\\. The install zip contains lib\\ and drivers\\, without DSD-FME.",14,MUTE)
text(660,1684,"Docs: README, CHANGELOG, NOTICE, CONTRIBUTING, SECURITY, ROADMAP; installer\\VDL2.txt and DAB.txt give build steps.",14,MUTE)

# ---------- legend ----------
group(1860,1285,520,425,"Legend",FILL["tool"])
leg=[("iq","Radio samples: raw IQ, baseband, demod",None),("audio","Audio: PCM to the browser, MP3 from DAB",None),("ev","Events: waterfall, status, decoder results",None),("ctl","Control: HTTP, process start, Python calls",None),("file","Files: reads and writes in data\\","7 5"),("net","Internet requests (optional)","7 5")]
for i,(k,t,d) in enumerate(leg):
    y=1340+i*38
    path([(1885,y),(1955,y)],k,dash=d)
    text(1970,y+5,t,15)
text(1885,1590,"Stacked purple box: one process per VFO.",14,MUTE)
text(1885,1612,"Two arrowheads: traffic in both directions.",14,MUTE)
text(1885,1634,"Monospace names are files in the project.",14,MUTE)
text(1885,1668,"Third-party components and licences: NOTICE.md",14,MUTE)

# ---------- flows ----------
# launcher
path([(380,222),(340,222)],"ctl"); label(360,210,"page",size=12)
path([(190,330),(190,440)],"ctl"); label(198,390,"starts, ends with launcher",anchor="start")
# browser <-> api
path([(420,330),(420,500)],"ctl",start=True); label(428,385,"HTTP JSON","ctl",anchor="start")
path([(620,330),(620,500)],"ctl",start=True); label(628,385,"HTTP JSON","ctl",anchor="start")
path([(1190,500),(1190,330)],"ev"); label(1198,385,"SSE","ev",anchor="start")
path([(1297,500),(1297,330)],"audio"); label(1305,385,"PCM","audio",anchor="start")
path([(1440,330),(1440,500)],"ctl",start=True); label(1448,385,"HTTP, MP3","ctl",anchor="start")
path([(1645,330),(1645,500)],"ctl",start=True); label(1653,385,"same HTTP API","ctl",anchor="start")
# internet from browser
path([(1400,115),(1400,98),(2247,98),(2247,180)],"net",dash="7 5"); label(1830,92,"flag images, map links","net")
# hub
path([(1190,590),(1190,558)],"ev"); path([(1297,590),(1297,558)],"audio")
# decoder events
path([(930,680),(930,612),(1140,612)],"ev"); label(1035,604,"decoder events","ev")
path([(1055,680),(1055,612)],"ev",end=False)
path([(1500,680),(1500,612),(1346,612)],"ev"); label(1425,604,"VDL2, DAB state","ev")
# decoder controls
path([(700,558),(700,680)],"ctl",start=True)
path([(1560,558),(1560,680)],"ctl",start=True)
# control lane
path([(110,529),(88,529),(88,930)],"ctl"); label(82,760,"tune, mode, gain, PTT","ctl",rot=-90)
# memories
path([(1700,558),(1700,968)],"ctl",start=True)
# ADS-B
path([(940,825),(970,825),(970,574),(1800,574),(1800,350),(1997,350),(1997,312)],"net",dash="7 5"); label(1880,342,"aircraft lookup (ADS-B)","net")
# vdl2->acars
path([(1416,739),(1350,739),(1350,892),(827,892),(827,858)],"ev"); label(940,908,"ACARS, ATN from VDL2","ev",size=12.5)
# internal data link
path([(714,825),(640,825)],"ctl",sw=2)
path([(430,807),(376,807)],"ctl",sw=2)
path([(430,843),(376,843)],"ctl",sw=2)
# dsp to decoders
path([(335,972),(335,875)],"iq"); label(335,920,"baseband (on_baseband)","iq")
path([(714,972),(714,916),(1055,916),(1055,875)],"iq"); label(880,934,"demodulated audio (on_demod, on_dsd)","iq",size=12.5)
# lanes
path([(1120,1064),(1190,1064),(1190,636)],"ev"); label(1190,780,"waterfall rows","ev",rot=-90)
path([(1274,972),(1274,636)],"audio"); label(1274,780,"audio","audio",rot=-90)
# Waterfall fed from IQ
path([(165,1125),(165,1030)],"iq"); label(205,1115,"IQ blocks","iq",anchor="start")
path([(165,1094),(1060,1094),(1060,1086)],"iq",sw=2)
# raw IQ
path([(1400,1125),(1400,739),(1416,739)],"iq"); path([(1400,838),(1416,838)],"iq"); label(1394,1010,"raw IQ","iq",rot=-90)
# external programs
path([(1638,732),(1990,732),(1990,660),(2040,660)],"iq"); label(1875,724,"IQ on stdin","iq")
path([(2040,690),(2010,690),(2010,752),(1638,752)],"ev"); label(1875,769,"JSON messages on stdout","ev")
path([(1638,826),(2040,826)],"iq"); label(1875,818,"IQ over rtl_tcp (localhost)","iq")
path([(2040,850),(1638,850)],"audio",start=True); label(1875,868,"web server: mux.json, slides, MP3","audio",size=12.5)
# DSD mode
path([(1116,812),(1136,812),(1136,650),(1950,650),(1950,505),(2040,505)],"iq")
path([(2040,530),(1965,530),(1965,660),(1148,660),(1148,830),(1116,830)],"audio")
path([(2040,555),(1980,555),(1980,670),(1160,670),(1160,848),(1116,848)],"ev")
label(1942,509,"FM signal over TCP","iq",anchor="end")
label(1942,534,"voice over UDP","audio",anchor="end")
label(1942,559,"calls on stderr","ev",anchor="end")
path([(1030,866),(1030,950),(902,950),(902,972)],"audio",sw=2)
label(1040,956,"DSD voice","audio",anchor="start",size=12.5)
# device to native
path([(300,1235),(300,1322)],"iq",start=True)
path([(540,1235),(540,1322)],"iq",start=True)
path([(207,1362),(207,1370)],"iq",end=False)
path([(157,1410),(157,1448)],"iq",start=True)
path([(512,1410),(512,1448)],"iq",start=True)
path([(157,1560),(157,1494)],"iq")
path([(512,1560),(512,1494)],"iq",start=True)
path([(145,1638),(145,1616)],"iq"); path([(270,1638),(270,1616)],"iq")
path([(462,1638),(462,1616)],"iq",start=True)
# storage to data
path([(1760,1080),(1860,1080)],"file",start=True,dash="7 5"); label(1810,1070,"read/write","file")
# tools to data
path([(1780,1488),(1820,1488),(1820,1200),(1860,1200)],"file",dash="7 5")
label(1840,1400,"vfos.json, EEPROM backups","file",rot=-90,size=12.5)

defs="<defs>"
for k,c in C.items():
    defs+=f'<marker id="a-{k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" markerUnits="strokeWidth" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>'
    defs+=f'<marker id="s-{k}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="5" markerHeight="5" markerUnits="strokeWidth" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="{c}"/></marker>'
defs+="</defs>"
svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">{defs}<rect width="{W}" height="{H}" fill="#fff"/>'+"".join(o)+"</svg>"
page = f'<!DOCTYPE html><html><body style="margin:0">{svg}</body></html>'

BROWSERS = [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "images", "block_diagram.png")


def render():
    browser = next((b for b in BROWSERS if os.path.exists(b)), None)
    if not browser:
        sys.exit("Chrome or Edge not found")
    with tempfile.TemporaryDirectory() as tmp:
        html = os.path.join(tmp, "diagram.html")
        png = os.path.join(tmp, "diagram.png")
        with open(html, "w", encoding="utf-8") as f:
            f.write(page)
        subprocess.run([browser, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={tmp}\\profile",
                        "--force-device-scale-factor=2", f"--window-size={W},{H}", "--virtual-time-budget=1000",
                        f"--screenshot={png}", "file:///" + html.replace("\\", "/")], check=True, timeout=120,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not os.path.exists(png):
            sys.exit("the browser did not write the image")
        os.replace(png, OUT)
    print(f"{OUT}: {os.path.getsize(OUT) / 1e6:.1f} MB")


if __name__ == "__main__":
    render()
