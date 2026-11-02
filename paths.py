"""Spoločné cesty: program v koreni, dáta tohto PC (nastavenia, pamäte, logy, nahrávky) v data/.

Pri prvom importe presunie dáta zo starého umiestnenia (koreň) do data/, aby staršie inštalácie
fungovali po aktualizácii bez zásahu. config.json z inštalačky (šablóna) sa tiež presunie do data/.
"""
import os
import shutil

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")

LEGACY_DIRS = ("logs", "acars", "wefax", "sstv", "eeprom_backup", "config_backup", "tx_audio")
LEGACY_FILES = ("config.json", "vfos.json", "memories.json")


def data(*parts):
    return os.path.join(DATA, *parts)


def _migrate():
    os.makedirs(DATA, exist_ok=True)
    names = list(LEGACY_FILES) + list(LEGACY_DIRS)
    names += [f for f in os.listdir(BASE) if f.startswith("config_") and f.endswith(".json")]
    for name in names:
        src, dst = os.path.join(BASE, name), data(name)
        if os.path.exists(src) and not os.path.exists(dst):
            try:
                shutil.move(src, dst)
                print(f"moved {name} -> data/{name}")
            except OSError as e:
                print(f"could not move {name} to data/: {e}")


_migrate()
