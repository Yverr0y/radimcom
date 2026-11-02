# RADIMCOM

Prijímač s RTL-SDR kľúčenkami ovládaný z prehliadača: KV cez up-konvertor, VKV/UKV priamo.
Obrazovka vyzerá ako transceiver: S-meter, 7-segmentové displeje, spektrum, vodopád a funkčné klávesy.
Tri kľúčenky fungujú ako tri VFO (A, B, C), medzi ktorými sa prepína jedným tlačidlom.

## Vlastnosti

- **Tri VFO, A/B/C.** Každé VFO má vlastnú kľúčenku (podľa sériového čísla) a vlastné nastavenia.
  Všetky tri frekvencie sú vedľa seba: aktívne VFO svieti, neaktívne je sivé, ale ukazuje skutočnú
  nastavenú frekvenciu. Vodopád všetkých VFO beží stále, takže po prepnutí je hneď vidieť jeho históriu.
- **Módy:** AM, FM, WFM, LSB, USB a CW s voliteľnou šírkou filtra.
- **WFM stereo** (19 kHz pilot, príznak **ST**) a **RDS**: názov stanice (PS), RadioText, PI, PTY, TP/TA a čas (CT).
- **Squelch** pre AM, FM a WFM, každý mód s vlastnou úrovňou. Rozhoduje každých ~8 ms, takže neodsekne
  začiatok relácie (letecké pásmo). Úroveň je na S-metri vyznačená žltou značkou.
- **Spektrum a vodopád** so zoomom 1×–32×.
- **Dekodéry:** FT8, WEFAX (rádiofax s automatickou detekciou formátu), CW (Morse s AFC a odhadom rýchlosti), RTTY (Baudot, automatický posun 90–1000 Hz, rýchlosť 45,45/50/75/100 Bd a polarita), SSTV (farebné obrázky, 14 režimov, VIS) a ACARS (dátové správy lietadiel na 131,725 MHz a ďalších, AM, MSK 2400 bit/s, kontrola CRC; typ a poloha lietadla z adsb.fi / adsb.lol).
- **Denné logy:** zaškrtávadlo LOG v karte každého dekodéra zapisuje do `data\logs\<dekodér>_RRRR-MM-DD.txt` (UTC, riadok na správu; WEFAX/SSTV názvy uložených obrázkov), ACARS do `data\acars\acars_RRRR-MM-DD.txt`.
- **Pamäte frekvencií** (MEM) s obľúbenými a importom zo SDR# (`frequencies.xml`).
- **Up-konvertor:** KV sa ladí cez LO (napr. 100 MHz). Pri VFO s ručným prepínačom konvertora sa pri
  prechode cez 30 MHz zobrazí upozornenie, či ho treba zapnúť (CONV) alebo prepnúť na BYPASS.
- **Audio** sa spustí samo po otvorení stránky a ide vždy z aktívneho VFO.

## Požiadavky

- Windows, Python 3 a balíčky `flask`, `numpy`, `scipy` a `PyFT8` (ten treba len pre FT8):

  ```bash
  pip install flask numpy scipy PyFT8
  ```

- RTL-SDR kľúčenky s ovládačom WinUSB (napr. cez Zadig). `librtlsdr.dll` a `libusb-1.0.dll` sú v priečinku `lib`.
- Kvôli FT8 musia hodiny PC ísť presne (±1 s).

## Spustenie

```bash
python app.py
```

Na Windows stačí dvojklik na `start.bat`. Potom otvor v prehliadači **http://localhost:8434**.

- Ak existuje `vfos.json`, spustí sa **spúšťač VFO** (`launcher.py`). Pre každé VFO otvorí samostatný
  prijímač na vlastnom porte a sám na porte 8434 podáva stránku. Ukončením spúšťača sa zavrú aj prijímače.
- Bez `vfos.json` beží jeden prijímač s nastaveniami z `config.json`.
- Naraz môže bežať len jeden takýto server, pretože kľúčenky sú zdieľané.
- Ak prehliadač nedovolí zvuk bez kliknutia, pri tlačidle MUTE bliká *„click anywhere to start audio“*.
  Zvuk sa spustí po prvom kliknutí alebo stlačení klávesu na stránke.

## Ovládanie

### Ladenie

| Akcia | Ako |
|---|---|
| Prepnúť VFO | tlačidlo **VFO-A / VFO-B / VFO-C** alebo klik na sivý displej |
| Zadať frekvenciu | klik na displej aktívneho VFO, napísať napr. `7100` (kHz) alebo `145.5` (MHz), Enter (Esc zruší) |
| Krok o 1 / 10 krokov | tlačidlá `‹ ›` / `« »` pod displejom, šípky ← → na klávesnici |
| Naladiť bod | klik do spektra alebo vodopádu |
| Posúvať pásmo | ťahanie myšou vo vodopáde |
| Jemné ladenie | koliesko myši nad spektrom alebo vodopádom (o jeden krok) |
| Pásmo | tlačidlá v skupinách HF HAM, HF BROADCAST, VHF/UHF HAM, FM BROADCAST, OTHER |

Ak pásmo alebo pamäť nepatrí do rozsahu aktívneho VFO, prijímač sa sám prepne na VFO, ktoré ju prijme
(napr. KV pásmo na VFO s konvertorom).

### Displej frekvencie

- Pod 30 MHz v **kHz**: `7.016.500` kHz, prvá bodka oddeľuje tisíce, druhá je desatinná.
- Od 30 MHz v **MHz**: `439.475.000` MHz.
- Posledné tri (menšie) číslice sú Hz.

### Funkčné klávesy

- **MODE**: demodulácia. **FILTER**: šírka pásma pre aktuálny mód.
- **STEP**: krok ladenia. **ZOOM**: výrez spektra a vodopádu.
- **DECODE**: zapne dekodér FT8, WEFAX, CW, RTTY, SSTV alebo ACARS. Panely sú v záložke
  **DECODERS** vedľa SPECTRUM; zapnutie dekodéra ju otvorí, zelená bodka hlási novú správu/obrázok:
  - FT8: výber pásma a CLR.
  - WEFAX: stanice (DWD Pinneberg 3855/7880/13882,5 kHz, Northwood GYA 2618,5/4610/8040/11086,5 kHz), LPM/IOC, NEW a PNG (obrázky sa ukladajú do `wefax/`).
  - CW: TUNE doladí na nájdený tón, CLR vymaže text.
  - SSTV: frekvencie (80m–10m, ISS FM), voľba režimu (Auto podľa VIS), STOP, PNG a galéria posledných
    obrázkov (ukladajú sa do `sstv/`). Režimy Martin M1/M2, Scottie S1/S2/DX, Robot 36/72, PD 50–290;
    AFC a korekcia náklonu automaticky. Filter aspoň 2,7 kHz.
- **AUDIO**: STEREO (WFM) a NOTCH: automatický notch pre AM/LSB/USB, sám nájde a vyreže ustálené
  tóny (hvízdanie, nosné) o ~40 dB, reč nechá. Ide aj do SSTV dekodéra, preto ho pri SSTV vypni.
  Hlasitosť je na posuvníku vpravo hore, ikona reproduktora pod ním je MUTE.
- **SET**: nastavenia aktívneho VFO.
  - Squelch pre aktuálny mód.
  - Zisk (ručne alebo automaticky).
  - LO up-konvertora a režim konvertora (off / on / auto).
  - Korekcia ppm.
  - Bias-tee 4,5 V. Zapínaj ho len vtedy, keď ho anténa alebo predzosilňovač naozaj potrebuje.
  - RESET DONGLE.
- **MEM**: pamäte frekvencií. ＋ SAVE CURRENT uloží frekvenciu, mód a šírku; ★ označí obľúbenú.

### Príznaky vedľa S-metra

| Príznak | Význam |
|---|---|
| RX | prijímač beží |
| mód, šírka | aktuálna demodulácia a filter |
| SQL | squelch je zapnutý; svieti, keď je otvorený |
| ST | WFM: zachytený stereo pilot |
| ALC | AM/SSB/CW: automatická úroveň audia (sivé = vypnuté) |
| CONV / BYPASS | požadovaná poloha ručného prepínača up-konvertora |

Keď je na neaktívnom VFO zapnutý squelch a otvorí sa, jeho tlačidlo VFO zasvieti nazeleno.

## Konfigurácia

### `vfos.json`: priradenie kľúčeniek k VFO

```json
{
  "port": 8434,
  "vfos": [
    { "name": "A", "serial": "SDR00001", "port": 8441, "config": "config_A.json",
      "note": "HF via upconverter",
      "init": { "upconv": "auto", "lo_offset_hz": 100000000, "ppm": 0 } },
    { "name": "B", "serial": "SDR00002", "port": 8442, "config": "config_B.json", "init": { "ppm": 0 } },
    { "name": "C", "driver": "lime", "serial": "1D3C...", "port": 8443, "config": "config_C.json",
      "note": "LimeSDR, VHF/UHF direct" }
  ]
}
```

- `serial` je sériové číslo kľúčenky v EEPROM (pri LimeSDR jeho sériové číslo, `driver: "lime"`).
- `port` je port prijímača daného VFO. Stránka s ním komunikuje priamo.
- `config` je súbor s nastaveniami VFO. Pri prvom spustení vznikne z `config.json` doplneného o hodnoty z `init`.
  Potom si každé VFO pamätá vlastné ladenie, mód, filtre, squelch, zisk a ppm.

### Prvotná konfigurácia: `setup_sdr.py`

```bash
python setup_sdr.py
```

Sprievodca (na Windows `setup.bat`) nájde pripojené RTL-SDR a LimeSDR a priradí ich k VFO A, B, C…:
zariadenie pre dané VFO sa vyberie číslom alebo tak, že ho na chvíľu odpojíš (sprievodca zistí, ktoré
chýba). Potom sa spýta na up-konvertor a ppm a zapíše `vfos.json`. Ak majú kľúčenky rovnaké sériové číslo
(bežne `00000001`), ponúkne zápis jedinečného čísla do EEPROM. Staré `vfos.json` a `config_X.json`
presunie do `config_backup/`. Prijímač musí byť počas konfigurácie vypnutý.

Korekcia ppm sa nastavuje aj neskôr v SET daného VFO.

### Vysielanie (LimeSDR)

Pri VFO s LimeSDR je v SET prepínač **Enable TX** (predvolene vypnutý). Keď je zapnutý, PTT je
držaný medzerník: v FM ide skúšobná relácia z `tx_audio/test_message.wav` (ak existuje), inak nosná.
Vysiela sa len bez up-konvertora.

### Sériové čísla kľúčeniek: `eeprom_tool.py`

```bash
python eeprom_tool.py
```

Vypíše pripojené kľúčenky a zálohuje ich EEPROM do `eeprom_backup/`.

```bash
python eeprom_tool.py write INDEX SERIAL
```

Zapíše nové sériové číslo. Musí mať rovnakú dĺžku ako pôvodné. Po zápise kľúčenku odpoj a znova pripoj.

```bash
python eeprom_tool.py restore INDEX FILE
```

Obnoví EEPROM zo zálohy.

### Import pamätí zo SDR#

```bash
python memories.py C:\sdrsharpSW\frequencies.xml
```

## Súbory

| Súbor | Obsah |
|---|---|
| `app.py` | server prijímača (Flask): API, udalosti (SSE) a audio |
| `launcher.py` | spúšťač VFO A/B/C |
| `sdr.py` | RTL-SDR cez librtlsdr (ctypes) a DSP: ladenie, filtre, demodulácia, squelch, vodopád |
| `rds.py` | RDS dekodér |
| `ft8.py`, `wefax.py`, `cw.py`, `rtty.py`, `sstv.py`, `acars.py` | dekodéry |
| `daylog.py` | denné logy dekodérov |
| `memories.py` | pamäte a import zo SDR# |
| `eeprom_tool.py` | čítanie, zálohovanie a zápis EEPROM kľúčeniek |
| `setup_sdr.py` | sprievodca prvotnou konfiguráciou kľúčeniek (`vfos.json`) |
| `lime.py` | LimeSDR cez LimeSuite.dll (príjem a vysielanie) |
| `static/` | webové rozhranie (`index.html`, `style.css`, `app.js`) |
| `paths.py` | cesty k dátam (`data\`), presun dát zo starších verzií |
| `installer/` | tvorba inštalačného balíka (`make_installer.py`) a súbory do neho; balík vzniká v `dist\` |

Dáta tohto PC sú v `data\` (nie sú v gite ani v inštalačnom balíku):

| Súbor / priečinok | Obsah |
|---|---|
| `config.json` | nastavenia pre režim bez VFO a šablóna pre nové VFO |
| `vfos.json`, `config_A/B/C/D.json` | priradenie kľúčeniek a nastavenia jednotlivých VFO |
| `memories.json` | uložené pamäte |
| `logs\`, `acars\`, `wefax\`, `sstv\` | denné logy a uložené obrázky |
| `config_backup\`, `eeprom_backup\` | zálohy nastavení a EEPROM |

Staršie inštalácie mali tieto súbory v koreni; pri prvom spustení sa presunú do `data\` samé.
