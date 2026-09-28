# Aktualizacje programu.
# Jak to działa:
#   1. W internecie (np. GitHub Releases) leży plik latest.json: { version, url, sha256, notes, date }.
#   2. Przy starcie (w tle) pobieramy ten plik i porównujemy wersję z version.json.
#   3. Na życzenie użytkownika pobieramy ZIP z nową wersją, sprawdzamy sumę SHA-256 i rozpakowujemy do updates/pending/.
#   4. Po ponownym uruchomieniu launch.py kopiuje pliki z updates/pending/ na miejsce (omijając .venv, models,
#      library, config, updates) i w razie potrzeby doinstalowuje biblioteki z requirements.txt.
# Adres latest.json: config/update.json → "manifestUrl" (plik użytkownika, aktualizacje go nie nadpisują),
# a gdy go nie ma – DEFAULT_MANIFEST_URL poniżej.
import hashlib
import json
import shutil
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

import settings
from i18n import tr

from paths import PROJECT, PROJECT_WRITABLE, CONFIG as _CONFIG_DIR, UPDATES  # noqa: E402

CONFIG = _CONFIG_DIR / "update.json"
PENDING = UPDATES / "pending"
PENDING_INFO = UPDATES / "pending.json"

# GitHub pod tym stałym adresem zawsze serwuje latest.json z NAJNOWSZEGO wydania
DEFAULT_MANIFEST_URL = "https://github.com/Oui42/MakePixel3D/releases/latest/download/latest.json"
USER_AGENT = "MakePixel3D-updater"

# Katalogi, których aktualizacja nigdy nie rusza (dane użytkownika i środowisko)
PROTECTED = {".venv", "models", "library", "config", "updates", ".git"}

status = {
    "current": "0.0.0", "configured": False, "checking": False, "checkedAt": None,
    "available": None,        # {version, notes, date, url, size} gdy jest nowsza wersja
    "downloading": False, "progress": 0.0, "downloaded": None,   # wersja gotowa do instalacji
    "error": None, "restartRequested": False,
}
_lock = threading.Lock()


def current_version() -> str:
    try:
        return json.loads((PROJECT / "version.json").read_text(encoding="utf-8-sig"))["version"]
    except (OSError, ValueError, KeyError):
        return "0.0.0"


def config() -> dict:
    cfg = {"manifestUrl": DEFAULT_MANIFEST_URL, "checkOnStart": True}
    try:
        cfg.update(json.loads(CONFIG.read_text(encoding="utf-8-sig")))
    except (OSError, ValueError):
        pass
    return cfg


def parse_version(v: str) -> tuple:
    parts = []
    for p in str(v).lstrip("v").split("."):
        num = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(num) if num else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def _fetch(url: str, timeout: float = 15):
    # ?nocache=<czas>: GitHub przez kilka minut po podmianie pliku w wydaniu potrafi serwować starą wersję latest.json
    # (nagłówek Cache-Control nie wystarcza) – instalator dostawał wtedy błąd sumy kontrolnej
    url += ("&" if "?" in url else "?") + f"nocache={int(time.time())}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Cache-Control": "no-cache"})
    return urllib.request.urlopen(req, timeout=timeout)  # noqa: S310 – adres z konfiguracji użytkownika


def init():
    status["current"] = current_version()
    status["configured"] = bool(config().get("manifestUrl"))
    if PENDING_INFO.is_file():
        try:
            status["downloaded"] = json.loads(PENDING_INFO.read_text(encoding="utf-8-sig"))["version"]
        except (OSError, ValueError, KeyError):
            status["downloaded"] = None
    if status["configured"] and settings.get()["checkUpdatesOnStart"]:
        threading.Thread(target=check, daemon=True).start()


def check() -> dict:
    """Pobiera latest.json i ustawia status["available"], gdy jest nowsza wersja."""
    cfg = config()
    if not cfg.get("manifestUrl"):
        status.update(error=tr("Aktualizacje nie są skonfigurowane (brak adresu w config/update.json)."))
        return status
    with _lock:
        status.update(checking=True, error=None)
    try:
        with _fetch(cfg["manifestUrl"]) as r:
            manifest = json.loads(r.read().decode("utf-8"))
        latest = str(manifest.get("version", "0.0.0"))
        if parse_version(latest) > parse_version(status["current"]):
            status["available"] = {
                "version": latest, "notes": manifest.get("notes", ""), "date": manifest.get("date", ""),
                "url": manifest["url"], "sha256": manifest.get("sha256", ""), "size": manifest.get("size"),
            }
        else:
            status["available"] = None
    except Exception as exc:  # noqa: BLE001 – brak internetu itp. to nie błąd programu
        status["error"] = tr("Nie udało się sprawdzić aktualizacji: {exc}", exc=exc)
    finally:
        status.update(checking=False, checkedAt=time.time())
    return status


def download() -> dict:
    """Pobiera ZIP nowej wersji, sprawdza SHA-256 i rozpakowuje do updates/pending/ (w tle)."""
    avail = status.get("available")
    if not avail or status["downloading"]:
        return status
    threading.Thread(target=_download, args=(avail,), daemon=True).start()
    return status


def _download(avail: dict):
    with _lock:
        status.update(downloading=True, progress=0.0, error=None)
    try:
        UPDATES.mkdir(exist_ok=True)
        zip_path = UPDATES / f"MakePixel3D-{avail['version']}.zip"
        sha = hashlib.sha256()
        with _fetch(avail["url"], timeout=60) as r, open(zip_path, "wb") as out:
            total = int(r.headers.get("Content-Length") or avail.get("size") or 0)
            done = 0
            while chunk := r.read(1 << 16):
                out.write(chunk)
                sha.update(chunk)
                done += len(chunk)
                if total:
                    status["progress"] = done / total
        if avail.get("sha256") and sha.hexdigest().lower() != avail["sha256"].lower():
            zip_path.unlink(missing_ok=True)
            raise ValueError(tr("plik jest uszkodzony (niezgodna suma kontrolna)"))
        if PENDING.exists():
            shutil.rmtree(PENDING)
        with zipfile.ZipFile(zip_path) as z:
            _safe_extract(z, PENDING)
        zip_path.unlink(missing_ok=True)
        PENDING_INFO.write_text(json.dumps({"version": avail["version"], "notes": avail.get("notes", "")},
                                           ensure_ascii=False), encoding="utf-8")
        status.update(downloaded=avail["version"], progress=1.0)
    except Exception as exc:  # noqa: BLE001
        status["error"] = tr("Nie udało się pobrać aktualizacji: {exc}", exc=exc)
    finally:
        status["downloading"] = False


def _safe_extract(z: zipfile.ZipFile, dest: Path):
    """Rozpakowanie z ochroną przed ścieżkami typu ../ (zip slip). Nadrzędny folder w ZIP-ie pomijamy."""
    names = z.namelist()
    root = names[0].split("/")[0] + "/" if names and all(n.startswith(names[0].split("/")[0] + "/") for n in names) else ""
    dest = dest.resolve()
    for n in names:
        rel = n[len(root):]
        if not rel or rel.endswith("/"):
            continue
        target = (dest / rel).resolve()
        if dest not in target.parents:
            raise ValueError(tr("niebezpieczna ścieżka w archiwum: {name}", name=n))
        target.parent.mkdir(parents=True, exist_ok=True)
        with z.open(n) as src, open(target, "wb") as out:
            shutil.copyfileobj(src, out)


def request_restart():
    status["restartRequested"] = True


def has_pending() -> bool:
    return PENDING_INFO.is_file() and PENDING.is_dir()


def _ensure_torchvision():
    """torchvision (S9) nie jest w requirements.txt – musi pochodzić z tego samego indeksu PyTorch (cpu/cu128) co torch,
    a wariant zapisał instalator w config/install.json. Kopie sprzed 0.2.0 nie mają torchvision → doinstalowanie."""
    import subprocess
    import sys
    try:
        import torchvision  # noqa: F401
        return
    except Exception:  # noqa: BLE001 – brak albo niezgodna wersja
        pass
    variant = "cu128"
    try:
        variant = json.loads((_CONFIG_DIR / "install.json").read_text(encoding="utf-8-sig")).get("torch") or variant
    except (OSError, ValueError):
        pass
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "torchvision", "--index-url",
                    f"https://download.pytorch.org/whl/{variant}"], check=False)


def apply_pending() -> str | None:
    """Wywoływane przez launch.py PRZED startem serwera. Zwraca zainstalowaną wersję albo None.
    Gdy folder programu nie jest zapisywalny (np. C:/Program Files), launch.py uruchamia to w procesie z uprawnieniami
    administratora (`launch.py --apply-update`)."""
    if not has_pending():
        return None
    if not PROJECT_WRITABLE:
        return None
    info = json.loads(PENDING_INFO.read_text(encoding="utf-8"))
    old_req = (PROJECT / "requirements.txt").read_bytes() if (PROJECT / "requirements.txt").is_file() else b""
    for src in PENDING.rglob("*"):
        rel = src.relative_to(PENDING)
        if rel.parts and rel.parts[0] in PROTECTED:
            continue
        if src.is_file():
            dst = PROJECT / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    new_req = (PROJECT / "requirements.txt").read_bytes() if (PROJECT / "requirements.txt").is_file() else b""
    if new_req != old_req:
        import subprocess
        import sys
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(PROJECT / "requirements.txt")], check=False)
        _ensure_torchvision()
    shutil.rmtree(PENDING, ignore_errors=True)
    PENDING_INFO.unlink(missing_ok=True)
    UPDATES.mkdir(parents=True, exist_ok=True)
    (UPDATES / "last_update.log").write_text(
        f"{time.strftime('%Y-%m-%d %H:%M')} zainstalowano wersję {info.get('version')}\n", encoding="utf-8")
    return info.get("version")
