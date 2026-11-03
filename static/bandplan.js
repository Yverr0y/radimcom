// Local table of frequency bands for the spectrum axis (Europe / ITU Region 1).
// Sources: ITU Radio Regulations Art. 5 (Table of Frequency Allocations), CEPT ECC ERC Report 25 (European Common
// Allocation Table), ERC/REC 70-03 (SRD: LPD433, SRD/LoRaWAN 868), IARU Region 1 band plan (HAM),
// ITU HFBC seasonal bands (HF broadcast), 3GPP TS 36.101 / ETSI (GSM, LTE, UMTS bands in Europe),
// ICAO Annex 10 (aeronautical bands, SSR/ADS-B), WMO (radiosondes, weather satellites).
//
// Row: [from Hz, to Hz, name on the axis, kind, description (tooltip)]
// The kind sets the colour (BANDPLAN_STYLES). Narrower bands are drawn on top of wider ones.

const BANDPLAN_STYLES = {
  //       background              strip      text
  ham:   ["rgba(40,120,255,.16)", "#2f7bff", "#fff"],
  bc:    ["rgba(255,150,40,.16)", "#ff9a2e", "#1a1206"],
  fm:    ["rgba(176,97,255,.16)", "#a95cff", "#fff"],
  air:   ["rgba(34,199,199,.16)", "#1fbfbf", "#04201f"],
  mil:   ["rgba(120,140,80,.18)", "#7d8f4e", "#fff"],
  pmr:   ["rgba(60,200,100,.16)", "#33c060", "#05200d"],
  cb:    ["rgba(255,216,74,.16)", "#f2cc3a", "#1f1a04"],
  tv:    ["rgba(230,80,160,.14)", "#d9468f", "#fff"],
  cell:  ["rgba(240,70,70,.13)",  "#d84040", "#fff"],
  ism:   ["rgba(150,220,60,.15)", "#8fcf3a", "#142004"],
  wx:    ["rgba(120,200,255,.16)", "#5cb8f0", "#04182a"],
  nav:   ["rgba(160,160,170,.14)", "#8a8d96", "#fff"],
  sat:   ["rgba(200,170,255,.15)", "#a98ee8", "#140a2a"],
  marine:["rgba(40,170,230,.15)", "#1f8fd0", "#fff"],
};

const BANDPLAN = [
  // --- Amateur bands (IARU Region 1) ---
  [135700, 137800, "HAM 2200m", "ham", "Amateur 2200 m (135.7–137.8 kHz)"],
  [472000, 479000, "HAM 630m", "ham", "Amateur 630 m (472–479 kHz)"],
  [1810000, 2000000, "HAM 160m", "ham", "Amateur 160 m (1.81–2.0 MHz)"],
  [3500000, 3800000, "HAM 80m", "ham", "Amateur 80 m (3.5–3.8 MHz)"],
  [5351500, 5366500, "HAM 60m", "ham", "Amateur 60 m (5351.5–5366.5 kHz, WRC-15)"],
  [7000000, 7200000, "HAM 40m", "ham", "Amateur 40 m (7.0–7.2 MHz)"],
  [10100000, 10150000, "HAM 30m", "ham", "Amateur 30 m (10.1–10.15 MHz), CW/digital only"],
  [14000000, 14350000, "HAM 20m", "ham", "Amateur 20 m (14.0–14.35 MHz)"],
  [18068000, 18168000, "HAM 17m", "ham", "Amateur 17 m (18.068–18.168 MHz)"],
  [21000000, 21450000, "HAM 15m", "ham", "Amateur 15 m (21.0–21.45 MHz)"],
  [24890000, 24990000, "HAM 12m", "ham", "Amateur 12 m (24.89–24.99 MHz)"],
  [28000000, 29700000, "HAM 10m", "ham", "Amateur 10 m (28.0–29.7 MHz)"],
  [50000000, 52000000, "HAM 6m", "ham", "Amateur 6 m (50–52 MHz)"],
  [70000000, 70500000, "HAM 4m", "ham", "Amateur 4 m (70.0–70.5 MHz, national)"],
  [144000000, 146000000, "HAM 2m", "ham", "Amateur 2 m (144–146 MHz)"],
  [430000000, 440000000, "HAM 70cm", "ham", "Amateur 70 cm (430–440 MHz)"],
  [1240000000, 1300000000, "HAM 23cm", "ham", "Amateur 23 cm (1240–1300 MHz)"],
  [2300000000, 2450000000, "HAM 13cm", "ham", "Amateur 13 cm (2300–2450 MHz)"],

  // --- AM broadcast (LW/MW) and HF bands (ITU) ---
  [148500, 283500, "LW BCAST", "bc", "Long wave AM broadcast (148.5–283.5 kHz)"],
  [526500, 1606500, "MW BCAST", "bc", "Medium wave AM broadcast (526.5–1606.5 kHz, 9 kHz raster)"],
  [2300000, 2495000, "BC 120m", "bc", "HF broadcast 120 m (tropical band)"],
  [3200000, 3400000, "BC 90m", "bc", "HF broadcast 90 m (tropical band)"],
  [3900000, 4000000, "BC 75m", "bc", "HF broadcast 75 m"],
  [4750000, 5060000, "BC 60m", "bc", "HF broadcast 60 m (tropical band)"],
  [5900000, 6200000, "BC 49m", "bc", "HF broadcast 49 m"],
  [7200000, 7450000, "BC 41m", "bc", "HF broadcast 41 m"],
  [9400000, 9900000, "BC 31m", "bc", "HF broadcast 31 m"],
  [11600000, 12100000, "BC 25m", "bc", "HF broadcast 25 m"],
  [13570000, 13870000, "BC 22m", "bc", "HF broadcast 22 m"],
  [15100000, 15800000, "BC 19m", "bc", "HF broadcast 19 m"],
  [17480000, 17900000, "BC 16m", "bc", "HF broadcast 16 m"],
  [18900000, 19020000, "BC 15m", "bc", "HF broadcast 15 m"],
  [21450000, 21850000, "BC 13m", "bc", "HF broadcast 13 m"],
  [25670000, 26100000, "BC 11m", "bc", "HF broadcast 11 m"],

  // --- Navigation, time signals, maritime (LW/MW/HF) ---
  [77000, 78000, "DCF77", "nav", "DCF77 time signal, 77.5 kHz (Mainflingen, DE)"],
  [283500, 526500, "NDB", "nav", "Aeronautical radio beacons NDB (283.5–526.5 kHz)"],
  [517000, 519000, "NAVTEX", "marine", "NAVTEX maritime safety info, 518 kHz (SITOR-B)"],
  [2173500, 2190500, "MAR 2182", "marine", "Maritime distress/calling 2182 kHz, DSC 2187.5 kHz"],

  // --- CB, PMR, SRD/ISM ---
  [26965000, 27405000, "CB", "cb", "CB radio, 40 channels (26.965–27.405 MHz)"],
  [446000000, 446200000, "PMR446", "pmr", "PMR446 licence-free walkie-talkies (16 ch analog + DMR)"],
  [433050000, 434790000, "LPD433", "ism", "ISM / LPD433 (433.05–434.79 MHz): remotes, weather sensors, LPD radios"],
  [863000000, 870000000, "SRD 868 / LoRa", "ism", "SRD 863–870 MHz: LoRaWAN EU868, Sigfox, alarms, smart meters (ERC/REC 70-03)"],
  [2400000000, 2483500000, "ISM 2.4G / WiFi", "ism", "ISM 2.4 GHz: Wi-Fi, Bluetooth, Zigbee (2400–2483.5 MHz)"],

  // --- Rozhlas a TV VKV/UKV ---
  [87500000, 108000000, "FM BCAST", "fm", "FM broadcast (87.5–108 MHz), WFM + RDS"],
  [174000000, 240000000, "DAB (BAND III)", "tv", "VHF Band III: DAB/DAB+ digital radio, blocks 5A–13F (174–240 MHz)"],
  [470000000, 694000000, "DVB-T/T2", "tv", "UHF TV Bands IV/V: DVB-T/T2, ch. 21–48 (470–694 MHz)"],

  // --- Letectvo ---
  [108000000, 117975000, "VOR / ILS", "air", "Aeronautical radionavigation: VOR, ILS localizer (108–117.975 MHz)"],
  [117975000, 137000000, "AIRBAND", "air", "VHF civil airband, AM voice + ACARS/VDL2 (117.975–137 MHz)"],
  [225000000, 400000000, "MIL AIR", "mil", "UHF military airband (NATO 225–400 MHz), AM"],
  [960000000, 1215000000, "DME / TACAN", "air", "Aeronautical radionavigation DME/TACAN (960–1215 MHz)"],
  [1029000000, 1031000000, "SSR 1030", "air", "Secondary radar interrogations (Mode A/C/S), 1030 MHz"],
  [1087000000, 1093000000, "ADS-B 1090", "air", "SSR replies / Mode S / ADS-B 1090ES, 1090 MHz"],

  // --- Military / professional ---
  [30000000, 87500000, "VHF LOW / MIL", "mil", "VHF low band 30–87.5 MHz: military tactical (CNR), land mobile"],
  [380000000, 400000000, "TETRA", "mil", "TETRA emergency services (380–400 MHz, e.g. Pegas in SK)"],

  // --- Maritime ---
  [156000000, 162025000, "MARINE VHF", "marine", "Maritime VHF (156–162 MHz), ch16 = 156.8 MHz distress/calling"],
  [161962500, 162037500, "AIS", "marine", "AIS ship tracking: AIS1 161.975 / AIS2 162.025 MHz"],

  // --- Paging ---
  [169400000, 169812500, "PAGING 169", "nav", "169.4–169.8125 MHz: paging (POCSAG/ERMES), smart meters (W-MBus)"],

  // --- Meteorology and satellites ---
  [137000000, 138000000, "WX SAT", "wx", "Weather satellites NOAA APT / Meteor LRPT (137–138 MHz)"],
  [400150000, 406000000, "RADIOSONDE", "wx", "Meteorological aids: radiosondes RS41/M10/M20 (400.15–406 MHz)"],
  [406000000, 406100000, "COSPAS 406", "sat", "COSPAS-SARSAT emergency beacons (EPIRB/ELT/PLB), 406–406.1 MHz"],
  [1668400000, 1690000000, "RADIOSONDE L", "wx", "Meteorological aids: L-band radiosondes (1668.4–1690 MHz)"],
  [1690000000, 1710000000, "WX SAT HRPT", "wx", "Meteorological satellites HRPT/AHRPT: NOAA, MetOp, Meteor (1690–1710 MHz)"],
  [1525000000, 1559000000, "INMARSAT", "sat", "Mobile satellite downlink L-band: Inmarsat (1525–1559 MHz)"],
  [1616000000, 1626500000, "IRIDIUM", "sat", "Iridium satellite phones (1616–1626.5 MHz)"],
  [1164000000, 1215000000, "GNSS L5/E5", "sat", "GNSS: GPS L5, Galileo E5a/E5b (1164–1215 MHz)"],
  [1215000000, 1240000000, "GNSS L2", "sat", "GNSS: GPS L2, GLONASS G2 (1215–1240 MHz)"],
  [1559000000, 1610000000, "GNSS L1", "sat", "GNSS: GPS L1 1575.42, Galileo E1, GLONASS G1 (1559–1610 MHz)"],

  // --- Mobile networks (Europe) ---
  [703000000, 733000000, "LTE 700 UL", "cell", "LTE band 28 uplink (703–733 MHz)"],
  [758000000, 788000000, "LTE 700 DL", "cell", "LTE band 28 downlink (758–788 MHz)"],
  [791000000, 821000000, "LTE 800 DL", "cell", "LTE band 20 downlink (791–821 MHz)"],
  [832000000, 862000000, "LTE 800 UL", "cell", "LTE band 20 uplink (832–862 MHz)"],
  [876000000, 915000000, "GSM-900 UL", "cell", "GSM/UMTS/LTE 900 uplink incl. E-GSM, GSM-R (876–915 MHz)"],
  [921000000, 960000000, "GSM-900 DL", "cell", "GSM/UMTS/LTE 900 downlink incl. E-GSM, GSM-R (921–960 MHz)"],
  [1710000000, 1785000000, "GSM-1800 UL", "cell", "GSM/LTE 1800 uplink, band 3 (1710–1785 MHz)"],
  [1805000000, 1880000000, "GSM-1800 DL", "cell", "GSM/LTE 1800 downlink, band 3 (1805–1880 MHz)"],
  [1920000000, 1980000000, "UMTS 2100 UL", "cell", "UMTS/LTE 2100 uplink, band 1 (1920–1980 MHz)"],
  [2110000000, 2170000000, "UMTS 2100 DL", "cell", "UMTS/LTE 2100 downlink, band 1 (2110–2170 MHz)"],
];
// Wider first, narrower on top.
BANDPLAN.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
