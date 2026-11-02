"""Shared paths: the program in the root folder, this PC's data (settings, memories, logs, recordings) in data/.

On the first import, data from the old location (root) is moved to data/, so older installations
keep working after an update without any manual steps. config.json from the installer (template) is moved to data/ too.
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
