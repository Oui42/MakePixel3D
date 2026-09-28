# Ustawienia programu (okno „Ustawienia” – zębatka). Plik config/settings.json – dane użytkownika,
# aktualizacje go nie nadpisują (config/ jest chroniony w updater.PROTECTED).
import json
import os
import threading
from pathlib import Path

from paths import CONFIG

PATH = CONFIG / "settings.json"

DEFAULTS = {
    "language": "en",              # en (domyślny) | pl
    "exportDir": "",               # pusty = zwykłe pobieranie (folder „Pobrane”)
    "checkUpdatesOnStart": True,
}
LANGUAGES = ("en", "pl")

_lock = threading.Lock()
_cache = {"mtime": None, "data": dict(DEFAULTS)}


def get() -> dict:
    with _lock:
        try:
            mtime = PATH.stat().st_mtime
        except OSError:
            return dict(DEFAULTS)
        if mtime != _cache["mtime"]:
            data = dict(DEFAULTS)
            try:
                data.update(json.loads(PATH.read_text(encoding="utf-8-sig")))
            except (OSError, ValueError):
                pass
            _cache.update(mtime=mtime, data=data)
        return dict(_cache["data"])


def update(changes: dict) -> dict:
    """Zapis zmienionych pól (z walidacją). ValueError z czytelnym opisem, gdy wartość jest zła."""
    data = get()
    for key, value in changes.items():
        if key not in DEFAULTS:
            continue
        if key == "language":
            if value not in LANGUAGES:
                raise ValueError(f"language: {value}")
        elif key == "exportDir":
            value = str(value or "").strip()
            if value:
                p = Path(value)
                if not p.is_dir():
                    raise ValueError("exportDir")
                if not os.access(p, os.W_OK):
                    raise ValueError("exportDir")
                value = str(p.resolve())
        else:
            value = bool(value)
        data[key] = value
    PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _cache["mtime"] = None
    return get()


def downloads_dir() -> str:
    return str(Path.home() / "Downloads")
