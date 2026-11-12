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

W,H=2800,1740
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
text(40,78,"Signal flows from the hardware at the bottom up to the browser at the top. Ver. 0.114beta1",16,MUTE)

# ---------- top row ----------
group(40,115,300,215,"VFO launcher",FILL["srv"])
box(60,155,260,70,"launcher.py",["serves the page and /api/vfos on :8434,","starts the VFO processes"])
text(60,250,"Starts one receiver per VFO.",13.5,MUTE)
text(60,270,"Without vfos.json: one receiver on",13.5,MUTE)
text(60,288,":8434, settings from config.json.",13.5,MUTE)
text(60,310,"start.bat → app.py → launcher",13.5,MUTE)

group(380,115,1090,215,"Web browser",FILL["ui"],"The page talks directly to each VFO's port; localStorage holds UI preferences")
box(400,180,200,132,"index.html",["style.css","layout, VFO windows,","function keys"],)
box(614,180,200,132,"app.js",["UI logic, one connection","set per VFO"])
box(828,180,200,132,"bandplan.js",["icao_countries.js, world.js,","leaflet\\ (station map);","band labels, country flags"])
box(1042,180,200,132,"Display",["S-meter, spectrum,","waterfall, decoder cards"],mono=False)
box(1256,180,200,132,"Web Audio",["MAIN and CUE faders,","level meter, MUTE"],mono=False)

group(1510,115,270,215,"Scripts and other programs",FILL["tool"])
text(1526,175,"Anything can drive a receiver",14,MUTE)
text(1526,195,"through the same HTTP API.",14,MUTE)
box(1530,225,230,60,"API/API.md",["API description"])

group(1860,115,520,215,"Internet (optional)",FILL["net"],"Everything works without it")
box(1880,180,150,132,"opendata.adsb.fi",["api.adsb.lol","aircraft type,","flight level, speed,","position"],size=13.5)
box(2040,180,150,132,"flagcdn.com",["country flags;","globe.adsb.fi and","adsb.lol as map links"],size=13.5)
box(2200,180,165,132,"Satellite data",["CelesTrak: orbits","SatNOGS: transmitters","AMSAT: active lists","OpenStreetMap: tiles"],mono=False,size=14)

# ---------- receiver process ----------
for d in (16,8):
    rect(40+d,440+d,1740,810,fill="#e4dcf2",stroke="#9aa6b2",r=12)
rect(40,440,1740,810,fill=FILL["srv"],stroke="#7f6aa8",sw=2,r=12)
text(640,468,"VFO receiver process: app.py --vfo A | B | C | D",19,weight=700)
text(640,488,"one process per VFO, :8441–:8444, config_X.json. Flask, NumPy, SciPy, pyserial, lameenc",13.5,MUTE)

# API row
Y=500;HA=58
box(110,Y,320,HA,"/api/set /state /tx /devices /mpx",["tuning, mode, gain, PTT, MPX spectrum"],size=14)
box(450,Y,500,HA,"/api/ft8 /wefax /sstv /cw /rtty /packet /acars /cpdlc",["decoder on/off, options, messages and images"],size=14)
box(1140,Y,98,HA,"/events",["SSE"],size=14)
box(1248,Y,98,HA,"/audio",["16-bit PCM"],size=14)
box(1362,Y,230,HA,"/api/vdl2 /hfdl /ais /adsb",["/dab/* /dsd /ism /scan","/rotor /sat/*"],size=13.5)
box(1612,Y,150,HA,"/api/memories",["list, edit, import"],size=14)
text(960,527,"Flask API in app.py",13.5,MUTE)
text(960,547,"sysload.py: CPU, RAM",13,MUTE)
box(1140,590,206,46,"Hub",["broadcast to browsers"],size=14)

# Decoders
group(110,680,850,195,"Decoders on baseband (on_baseband)",FILL["dec"],tx=126)
BW=157
for i,(n,l) in enumerate([("ft8.py",["needs PyFT8"]),("wefax.py",["radio fax, PNG"]),("cw.py",["Morse, AFC, speed"]),("rtty.py",["Baudot, auto shift"]),("packet.py",["AX.25 1k2 / 9k6","aprs.py: APRS"])]):
    box(126+i*(BW+8),716,BW,60,n,l)
box(126,792,250,31,"adsc.py: ADS-C reports",[],size=13.5)
box(126,827,250,31,"cpdlc_schema.py: message set",[],size=13.5)
box(430,792,210,66,"cpdlc.py",["FANS-1/A, ARINC 622"])
box(714,792,226,66,"acars.py",["ACARS, AM MSK 2400 bit/s"])
group(980,680,150,195,"Audio",FILL["dec"],tx=994)
box(994,716,122,72,"sstv.py",["on_demod","14 modes, VIS"])
box(994,796,122,70,"dsd.py",["on_dsd","digital voice"])
group(1282,680,370,195,"Raw IQ decoders (on_raw)",FILL["dec"],tx=1296)
box(1292,716,92,48,"adsb.py",["1090 MHz"],size=14)
box(1292,770,92,48,"ais.py",["ships"],size=14)
box(1292,824,92,48,"hfdl.py",["dumphfdl"],size=14)
box(1416,714,222,38,"vdl2.py",["EU / US channels, ATN CPDLC"],size=14)
box(1416,756,222,34,"airports.py",["+ VDL2_Ground_Stations.txt"],size=12.5)
box(1416,794,222,38,"dab.py",["DAB / DAB+"],size=14)
box(1416,836,222,36,"ism.py",["433 / 868 MHz devices"],size=14)

# DSP
group(70,930,1270,170,"Receiver in sdr.py: DSP chain",FILL["dsp"],tx=360)
Yd=972;Hd=58
chain=[(90,150,"Shift",["NCO to the tuned freq."]),(258,155,"Decimator",["polyphase FIR /64"]),(431,175,"Channel filter",["by mode, LPF/HPF, notch"]),(624,180,"Demodulator",["AM FM LSB USB CW WFM"]),(822,170,"ALC, DYN",["EXP + AUTO, LIM"]),(1010,196,"Squelch",["SQL, ASQ; tonesq.py"]),]
for x,w,n,l in chain:
    box(x,Yd,w,Hd,n,l,mono=False,size=14.5)
box(190,1042,270,44,"Remove DC peak, spurs",["from IQ and waterfall; SP key, LEARN"],mono=False,size=13.5)
path([(165,1064),(190,1064)],"iq",sw=2)
box(1000,1042,120,44,"Waterfall",["FFT, zoom 1–32×"],mono=False,size=13.5)
box(1224,Yd,100,Hd,"PCM",["stereo audio"],mono=False,size=14.5)
box(624,1042,180,44,"rds.py",["RDS in WFM"],size=13.5)
box(470,1042,140,44,"autotune.py",["ATU key"],size=13.5)
box(818,1042,172,44,"scanner.py",["SCAN tab"],size=13.5)
path([(1000,1064),(990,1064)],"ev",sw=2)
for a,b in [(240,258),(413,431),(606,624),(804,822)]:
    path([(a,Yd+29),(b,Yd+29)],"iq",sw=2)
for a,b in [(992,1010),(1206,1224)]:
    path([(a,Yd+29),(b,Yd+29)],"audio",sw=2)
path([(714,1030),(714,1042)],"iq",sw=2)

# Device layer
group(70,1125,1370,110,"Device layer: same interface for all, chosen by open_device()",FILL["dev"])
box(90,1165,165,58,"RtlSdr",["in sdr.py, via ctypes"],size=14.5)
box(270,1165,160,58,"LimeSdr",["lime.py, RX and TX"],size=14.5)
box(445,1165,145,58,"AirspySdr",["airspy.py, RX only"],size=14.5)
box(605,1165,230,58,"ChainedSdr",["iqshare.py, no dongle of its own"],size=14.5)
box(1030,1165,190,58,"IqServer",["iqshare.py, owner VFO"],size=14.5)
text(1236,1185,"A chained VFO's dongle",12.5,MUTE)
text(1236,1202,"settings are forwarded to",12.5,MUTE)
text(1236,1219,"the owner's /api/set",12.5,MUTE)
path([(1030,1194),(835,1194)],"iq")
label(932,1186,"TCP :port+100")
label(932,1212,"to another VFO")

# Persistence
group(1460,930,300,305,"Storage modules",FILL["data"])
box(1480,968,260,42,"memories.py",["memories, SDR# import"])
box(1480,1016,260,42,"paths.py",["locates data\\, migrates old files"])
box(1480,1064,260,42,"daylog.py",["daily decoder logs"])
box(1480,1112,260,42,"recorder.py",["REC, REC SQ: MP3 files"])
box(1480,1160,260,42,"location.py",["station location, locator"])
text(1610,1224,"config: app.py; logs, images: decoders",13,MUTE,anchor="middle")

# ---------- external programs ----------
group(2020,430,360,445,"Separate programs (lib\\)",FILL["ext"])
box(2040,475,320,90,"dsd-fme.exe",["DMR, P25, D-Star, YSF, NXDN, dPMR, M17...","mbelib; ISC, parts GPL v2","downloaded by install_dsd.bat, not in the zips"])
box(2040,575,320,80,"dumpvdl2.exe",["demodulation, FEC, ATN ASN.1","libacars, MSYS2 runtime; GPL v3"])
box(2040,665,320,90,"welle-cli.exe (our patch)",["OFDM, Viterbi, AAC / MP2","FFTW, FAAD2, mpg123, LAME;","GPL v2 or later"])
box(2040,765,320,50,"rtl_433.exe",["ISM devices; GPL v2 or later"])
box(2040,823,320,46,"dumphfdl.exe (lib\\hfdl)",["HFDL, IQ from hfdl.py; GPL v3"])

# ---------- satellite tracking ----------
group(2420,115,340,760,"Satellite tracking",FILL["srv"],"in the VFO process (dashed link)")
box(2440,175,300,150,"sattrack.py, satplan.py",["TLE (CelesTrak), SGP4 passes, map;","Doppler correction of the VFO;","rotor plan of each pass","(normal, overlap, flipped, over top);","satellites.py: AMSAT lists"])
box(2440,410,300,130,"rotor.py",["K3NG azimuth 0-450, calibration,","GS-232, position checks and stop;","one per station: data\\rotor.json;","SETTINGS › GENERAL › ROTOR,","ROTOR CONTROL tab, TRACK page"])
box(2440,640,300,80,"K3NG rotor controller",["Arduino, USB serial"],mono=False)
box(2440,775,300,70,"Antenna rotor",["azimuth and elevation"],mono=False)

# ---------- data ----------
group(1860,905,520,330,"data\\ folder: your settings and logs, never packaged",FILL["data"])
rows=[("vfos.json","dongle to VFO assignment"),("config.json","single-receiver settings, VFO template"),("config_A…D.json","settings of each VFO"),("memories.json","frequency memories"),("logs\\  acars\\","daily decoder logs (UTC)"),("wefax\\  sstv\\","saved images (PNG)"),("recordings\\","audio recordings (MP3)"),("tx_audio\\","optional FM test message"),("sat_*.json  sat_tle.txt","satellites: station, orbits, transmitters"),("satellites.json","AMSAT lists (SATELLITES tab)"),("rotor.json","the station rotor"),("location.json","station location"),("config_backup\\","previous vfos.json and configs"),("eeprom_backup\\","dongle EEPROM backups")]
for i,(a,b) in enumerate(rows):
    y=954+i*20.5
    text(1880,y,a,14,weight=700,mono=True); text(2085,y,b,13.5,MUTE)

# ---------- native + drivers + hw ----------
group(70,1285,530,135,"",FILL["dev"])
box(90,1322,165,40,"librtlsdr.dll",[],size=14)
box(90,1370,165,40,"libusb-1.0.dll",[],size=14)
box(270,1322,160,88,"LimeSuite.dll",["from lib\\ or","PothosSDR"],size=14)
box(445,1322,145,88,"airspy.dll",["pthreadVC2.dll;","from PothosSDR"],size=14)
group(70,1430,530,100,"",FILL["dev"])
box(90,1470,165,46,"WinUSB",["with Zadig"],mono=False,size=14)
box(270,1470,160,46,"FTDI D3XX",["driver"],mono=False,size=14)
box(445,1470,145,46,"WinUSB",["with Zadig"],mono=False,size=14)
group(70,1542,530,168,"Hardware",FILL["hw"])
box(90,1578,165,52,"RTL-SDR dongles",["picked by serial"],mono=False,size=14)
box(270,1578,160,52,"LimeSDR Mini",["optional TX on PTT"],mono=False,size=14)
box(445,1578,145,52,"Airspy R2",["receive only"],mono=False,size=14)
box(90,1648,165,52,"HF upconverter,",["VHF/UHF antenna"],mono=False,size=14)
box(270,1648,160,52,"Antenna / dummy",["load, filter for TX"],mono=False,size=14)
text(517,1668,"Up to 4 SDRs,",12.5,MUTE,anchor="middle")
text(517,1686,"one per VFO",12.5,MUTE,anchor="middle")

# Tools
group(640,1285,1140,425,"Install, setup and build tools (run outside the receiver)",FILL["tool"])
text(660,1336,"Install and run",15,weight=700)
box(660,1348,230,60,"install.bat",["creates .venv, pip packages, PyFT8"])
box(900,1348,240,60,"install_dsd.bat",["install_dsd.py downloads","DSD-FME to lib\\dsd-fme"])
box(1150,1348,130,60,"start.bat",["starts app.py"])
box(1290,1348,170,60,"zadig.exe",["installs WinUSB driver"])
box(1470,1348,290,60,"drivers\\  INSTALL.txt  DRIVERS.txt",["USB drivers and installation guide"],size=14)
text(660,1446,"Setup and maintenance",15,weight=700)
box(660,1458,250,60,"setup.bat",["starts the wizard"])
box(935,1458,300,60,"setup_sdr.py",["wizard: finds dongles, writes vfos.json"])
box(1260,1458,250,60,"eeprom_tool.py",["read, back up, write serial number"])
path([(910,1488),(935,1488)],"ctl",sw=2)
path([(1235,1488),(1260,1488)],"ctl",sw=2)
text(660,1538,"setup_sdr.py and eeprom_tool.py open the dongles through sdr.py / lime.py; the receiver is stopped",13,MUTE)
box(1525,1458,235,60,"update_check.py",["upgrade_helper.py: upgrade","from GitHub Releases"])
text(660,1556,"Build (installer\\)",15,weight=700)
box(660,1568,210,60,"make_installer.py",["install and upgrade zips"],size=14)
box(880,1568,210,60,"make_sources.py",["GPL / LGPL source zip"],size=14)
box(1100,1568,200,60,"make_world.py",["world.js, Natural Earth"],size=14)
box(1310,1568,190,60,"build_dab.sh",["welle-cli (MSYS2)"],size=14)
box(1510,1568,250,60,"dist\\",["zips for GitHub Releases"])
text(660,1660,"Git-ignored and not in the repository: lib\\, apps\\, drivers\\, data\\, dist\\. The install zip contains lib\\, apps\\ and drivers\\, without DSD-FME.",14,MUTE)
text(660,1684,"Docs: README, CHANGELOG, NOTICE, CONTRIBUTING, SECURITY, ROADMAP; installer\\VDL2, DAB and ISM.txt give sources.",14,MUTE)

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
path([(1400,115),(1400,98),(2115,98),(2115,180)],"net",dash="7 5"); label(1830,92,"flag images, map links","net")
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
# memories, recording
path([(1323,1010),(1450,1010),(1450,1133),(1480,1133)],"audio"); label(1362,1002,"PCM","audio")
path([(1700,558),(1700,968)],"ctl",start=True)
# ADS-B
path([(940,825),(970,825),(970,574),(1800,574),(1800,350),(1955,350),(1955,312)],"net",dash="7 5"); label(1880,342,"aircraft lookup (ADS-B)","net")
# vdl2->acars
path([(1530,714),(1530,688),(1268,688),(1268,892),(827,892),(827,858)],"ev"); label(940,908,"ACARS, ATN from VDL2","ev",size=12.5)
# internal data link
path([(714,825),(640,825)],"ctl",sw=2)
path([(430,807),(376,807)],"ctl",sw=2)
path([(430,843),(376,843)],"ctl",sw=2)
# dsp to decoders
path([(335,972),(335,875)],"iq"); label(335,920,"baseband (on_baseband)","iq")
path([(714,972),(714,916),(1055,916),(1055,875)],"iq"); label(880,934,"demodulated audio (on_demod, on_dsd)","iq",size=12.5)
# lanes
path([(1120,1064),(1190,1064),(1190,636)],"ev"); label(1190,780,"waterfall rows","ev",rot=-90)
path([(1246,972),(1246,636)],"audio"); label(1246,780,"audio","audio",rot=-90)
# Waterfall fed from IQ
path([(165,1125),(165,1030)],"iq"); label(205,1115,"IQ blocks","iq",anchor="start")
path([(165,1094),(1060,1094),(1060,1086)],"iq",sw=2)
# raw IQ
path([(1400,1125),(1400,733),(1416,733)],"iq"); path([(1400,813),(1416,813)],"iq"); path([(1400,854),(1416,854)],"iq"); label(1394,1010,"raw IQ","iq",rot=-90)
# external programs
path([(1638,725),(1990,725),(1990,600),(2040,600)],"iq"); label(1875,717,"IQ on stdin","iq")
path([(2040,630),(2010,630),(2010,745),(1638,745)],"ev"); label(1875,762,"JSON messages on stdout","ev")
path([(1638,805),(2025,805),(2025,690),(2040,690)],"iq"); label(1875,797,"IQ over rtl_tcp (localhost)","iq")
path([(2040,725),(2033,725),(2033,825),(1638,825)],"audio",start=True); label(1875,839,"web server: mux.json, slides, MP3","audio",size=12.5)
path([(1638,846),(2000,846),(2000,782),(2040,782)],"iq")
path([(2040,800),(2015,800),(2015,860),(1638,860)],"ev"); label(1875,876,"rtl_433: IQ over rtl_tcp, JSON messages","ev",size=12.5)
# satellite tracking
path([(2590,315),(2590,410)],"ctl",start=True); label(2598,352,"targets with the","ctl",anchor="start"); label(2598,372,"K3NG azimuth","ctl",anchor="start")
path([(2590,540),(2590,640)],"ctl",start=True); label(2598,582,"USB serial, 9600 baud","ctl",anchor="start"); label(2598,602,"GS-232 commands","ctl",anchor="start")
path([(2590,720),(2590,775)],"ctl",start=True)
path([(1720,440),(1720,420),(2440,420)],"ctl",start=True,dash="7 5"); label(2000,412,"CTRL, GO, position: /api/rotor, /api/sat/*","ctl")
path([(2440,250),(2365,250)],"net",dash="7 5"); label(2402,240,"downloads","net",size=11.5)
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
path([(172,1235),(172,1322)],"iq",start=True)
path([(350,1235),(350,1322)],"iq",start=True)
path([(517,1235),(517,1322)],"iq",start=True)
path([(172,1362),(172,1370)],"iq",end=False)
path([(172,1410),(172,1470)],"iq",start=True)
path([(350,1410),(350,1470)],"iq",start=True)
path([(517,1410),(517,1470)],"iq",start=True)
path([(172,1578),(172,1516)],"iq")
path([(350,1578),(350,1516)],"iq",start=True)
path([(517,1578),(517,1516)],"iq")
path([(172,1648),(172,1630)],"iq"); path([(350,1648),(350,1630)],"iq",start=True)
# titles over the arrows of the bottom left column
text(86,1312,"Native libraries (lib\\), loaded through ctypes",17,weight=700,halo=True)
text(86,1457,"Windows USB drivers",17,weight=700,halo=True)
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
