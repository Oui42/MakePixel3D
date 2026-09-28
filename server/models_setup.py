# Modele AI potrzebne do pracy (pliki z „wiedzą” sieci neuronowych – osobno od bibliotek, które instaluje pip).
# Pobierane RAZ, najlepiej już przy instalacji (install.bat / instalator wywołują ten plik), potem program działa
# bez internetu. Gdy wszystko jest na dysku, włączamy tryb offline Hugging Face – żadnych prób łączenia przy starcie.
#
#   .venv\Scripts\python server\models_setup.py          pobiera brakujące modele (z postępem w konsoli)
#   .venv\Scripts\python server\models_setup.py --check  tylko sprawdza (kod wyjścia 0 = komplet)
import os
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import PROJECT, MODELS  # noqa: E402
os.environ.setdefault("HF_HOME", str(MODELS / "huggingface"))
os.environ.setdefault("U2NET_HOME", str(MODELS / "rembg"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

HF_HUB = Path(os.environ["HF_HOME"]) / "hub"
REMBG_MODEL = "isnet-general-use"

# key: (opis, rozmiar w MB, funkcja sprawdzająca, funkcja pobierająca)
def _rembg_present() -> bool:
    return any(Path(os.environ["U2NET_HOME"]).rglob(f"{REMBG_MODEL}.onnx"))


def _hf_present(repo: str, filename: str) -> bool:
    snaps = HF_HUB / f"models--{repo.replace('/', '--')}" / "snapshots"
    return snaps.is_dir() and any(snaps.glob(f"*/{filename}"))


def _download_rembg():
    from rembg import new_session
    new_session(REMBG_MODEL)


def _download_triposr():
    from huggingface_hub import hf_hub_download
    hf_hub_download("stabilityai/TripoSR", "config.yaml")
    hf_hub_download("stabilityai/TripoSR", "model.ckpt")


def _download_dino():
    from huggingface_hub import hf_hub_download
    hf_hub_download("facebook/dino-vitb16", "config.json")


MODEL_LIST = [
    {"key": "rembg", "name": "Usuwanie tła (IS-Net)", "mb": 170,
     "present": _rembg_present, "download": _download_rembg},
    {"key": "triposr", "name": "Model 3D (TripoSR)", "mb": 1600,
     "present": lambda: _hf_present("stabilityai/TripoSR", "model.ckpt") and _hf_present("stabilityai/TripoSR", "config.yaml"),
     "download": _download_triposr},
    {"key": "dino", "name": "Analiza obrazu (DINO, konfiguracja)", "mb": 1,
     "present": lambda: _hf_present("facebook/dino-vitb16", "config.json"), "download": _download_dino},
]

status = {"downloading": False, "current": None, "done": [], "error": None}
_lock = threading.Lock()


def missing() -> list[dict]:
    return [m for m in MODEL_LIST if not m["present"]()]


def all_present() -> bool:
    return not missing()


def enable_offline_if_ready():
    """Komplet modeli na dysku → Hugging Face nie łączy się z internetem (szybki start bez sieci)."""
    if all_present():
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"


def summary() -> dict:
    miss = missing()
    return {
        "complete": not miss,
        "missing": [{"key": m["key"], "name": m["name"], "mb": m["mb"]} for m in miss],
        "missingMb": sum(m["mb"] for m in miss),
        **status,
    }


def _trust_windows_certificates():
    """Pobieranie ma ufać certyfikatom z magazynu Windows (pakiet truststore), nie tylko wbudowanej liście certifi.
    Bez tego na komputerach z antywirusem/proxy podmieniającym certyfikaty HTTPS pobieranie kończy się błędem
    CERTIFICATE_VERIFY_FAILED (zgłoszone na komputerze użytkownika), choć przeglądarka i pip działają."""
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        pass


def download_missing(log=print) -> bool:
    _trust_windows_certificates()
    """Pobiera brakujące modele po kolei. True = komplet."""
    os.environ.pop("HF_HUB_OFFLINE", None)          # pobieranie wymaga połączenia
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
    with _lock:
        status.update(downloading=True, error=None, done=[])
    try:
        for m in missing():
            status["current"] = m["key"]
            log(f"Pobieranie: {m['name']} (~{m['mb']} MB)…")
            m["download"]()
            status["done"].append(m["key"])
        status["current"] = None
        enable_offline_if_ready()
        return all_present()
    except Exception as exc:  # noqa: BLE001
        status["error"] = str(exc)
        log(f"BŁĄD: {exc}")
        return False
    finally:
        status["downloading"] = False


def download_in_background():
    if not status["downloading"]:
        threading.Thread(target=download_missing, kwargs={"log": lambda s: print(f"[modele] {s}", flush=True)},
                         daemon=True).start()


if __name__ == "__main__":
    if "--check" in sys.argv:
        miss = missing()
        for m in miss:
            print(f"brak: {m['name']} (~{m['mb']} MB)")
        sys.exit(1 if miss else 0)
    miss = missing()
    if not miss:
        print("Wszystkie modele AI są już pobrane.")
        sys.exit(0)
    print(f"Do pobrania: {len(miss)} model(e), ok. {sum(m['mb'] for m in miss)} MB. To może potrwać kilka minut.")
    ok = download_missing()
    print("Gotowe – modele AI pobrane." if ok else
          "Nie udało się pobrać wszystkich modeli (sprawdź internet). Program pobierze je przy pierwszym uruchomieniu.")
    sys.exit(0 if ok else 1)
