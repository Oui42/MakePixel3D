# Foldery programu i danych użytkownika.
# Program może być zainstalowany w folderze tylko do odczytu (C:\Program Files\MakePixel3D – instalator „dla wszystkich”).
# Wtedy dane, które program zapisuje w trakcie pracy (galeria, ustawienia, logi, pobrane aktualizacje), trafiają do
# %LOCALAPPDATA%\MakePixel3D. Gdy folder programu jest zapisywalny (kopia robocza, instalacja „tylko dla mnie”),
# wszystko zostaje obok programu – tak jak dotychczas (nic nie trzeba przenosić).
# Zmienna środowiskowa MAKEPIXEL3D_DATA wymusza folder danych (np. wersja przenośna na pendrive).
import os
import uuid
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent


def _writable(folder: Path) -> bool:
    try:
        folder.mkdir(parents=True, exist_ok=True)
        probe = folder / f".write-test-{uuid.uuid4().hex}"
        probe.write_bytes(b"")
        probe.unlink()
        return True
    except OSError:
        return False


PROJECT_WRITABLE = _writable(PROJECT)

if os.environ.get("MAKEPIXEL3D_DATA"):
    DATA = Path(os.environ["MAKEPIXEL3D_DATA"])
elif PROJECT_WRITABLE:
    DATA = PROJECT
else:
    DATA = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "MakePixel3D"

LIBRARY = DATA / "library"     # galeria użytkownika
CONFIG = DATA / "config"       # settings.json, update.json
LOGS = DATA / "logs"
UPDATES = DATA / "updates"     # pobrane aktualizacje (updates/pending) – instaluje je launch.py
# Pamięć podręczna bibliotek (numba/pymatting kompiluje funkcje przy pierwszym imporcie). MUSI być zapisywalna:
# w C:\Program Files numba próbowała pisać obok siebie, a tempfile przy odmowie dostępu zapętlał się bez końca
# (program „wisiał” na „Loading the background removal model…”). app.py ustawia NUMBA_CACHE_DIR przed importami.
CACHE = DATA / "cache"
# Modele AI: instalator pobiera je obok programu (models/). Gdy folderu programu nie da się zapisać, a modeli
# przy nim nie ma – pobieramy je do folderu danych.
MODELS = PROJECT / "models" if (PROJECT_WRITABLE or (PROJECT / "models").is_dir()) else DATA / "models"
# Modele funkcji zaawansowanych (S8–S10) pobierane NA ŻĄDANIE już po instalacji – muszą trafić do folderu zapisywalnego
# dla zwykłego użytkownika (w Program Files nie da się pisać bez administratora).
FEATURE_MODELS = (PROJECT / "models" if PROJECT_WRITABLE else DATA / "models") / "features"


def describe() -> dict:
    return {"project": str(PROJECT), "data": str(DATA), "models": str(MODELS), "projectWritable": PROJECT_WRITABLE}
