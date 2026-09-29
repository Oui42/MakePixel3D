# Wykrywanie sprzętu i „bramka” dla zaawansowanych funkcji AI.
# Każda funkcja ma minimalne wymagania (VRAM, RAM, miejsce na dysku). Na komputerze, który ich nie spełnia,
# funkcja jest widoczna, ale zablokowana z czytelnym powodem – zamiast wysypać się w połowie pobierania modelu.
import ctypes
import shutil
from functools import lru_cache
from pathlib import Path

from i18n import tr

import paths  # noqa: E402

PROJECT = paths.PROJECT

# Wymagania w GB. Wartości ostrożne – lepiej zablokować, niż obiecać coś, co nie ruszy.
FEATURES = {
    "text2image": {
        "name": "Tekst → obraz → sprite",
        "description": "Opisujesz obiekt słowami, a program sam tworzy obraz, model 3D i sprite'y (bez szukania zdjęć).",
        # FLUX.1-schnell w wersji skwantyzowanej (fp8 / NF4, ~6–8 GB VRAM przy generowaniu) – pełna wersja bf16
        # potrzebowałaby ~24 GB. 10 GB = zapas na model 3D wczytany obok. Karta „12 GB” zgłasza 11.9 GB (GiB),
        # dlatego wymagania nie mogą być równe nominalnej pojemności karty (zgłoszenie użytkownika, RTX 5070).
        # RAM: po wczytaniu koder T5 (bf16, 9,5 GB) i transformer (7 GB) siedzą w RAM między generowaniami
        # (cpu offload) – zmierzone 28.09.2026; 16 GB RAM oznaczałoby ciągłe swapowanie.
        "vram": 10, "ram": 24, "disk": 20,
    },
    "multiview": {
        "name": "Lepszy tył obiektu",
        "description": "AI dorysowuje widoki z innych stron, zanim powstanie model 3D – wyraźnie lepsze boki i tył.",
        "vram": 8, "ram": 16, "disk": 12,
    },
    "imageedit": {
        "name": "Edycja obrazu (dodaj, zmień)",
        "description": "Zmieniasz gotowy obraz poleceniem („dodaj miecz”, „zielone spodnie”), a potem generujesz model 3D od nowa.",
        # FLUX.1 Kontext dev GGUF Q4 (6,8 GB) + składniki S8 (T5, CLIP, VAE) – te same wymagania co „Tekst → obraz”
        "vram": 10, "ram": 24, "disk": 10,
    },
    "rigging": {
        "name": "Szkielet i animacje ruchu",
        "description": "Automatyczny szkielet postaci i gotowe animacje (chodzenie, bieg, atak).",
        # UniRig we własnym Pythonie 3.11 (~4 GB) + wagi 5,5 GB + pliki tymczasowe
        "vram": 8, "ram": 16, "disk": 15,
    },
}


@lru_cache(maxsize=1)
def hardware() -> dict:
    info = {"gpu": None, "vramGb": 0.0, "cuda": False, "ramGb": 0.0, "diskFreeGb": 0.0, "torch": ""}
    try:
        import torch
        info["torch"] = torch.__version__
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            info["gpu"] = props.name
            info["vramGb"] = round(props.total_memory / 1024**3, 1)
            info["cuda"] = True
    except Exception:  # noqa: BLE001 – brak torch/CUDA = po prostu brak GPU
        pass
    if not info["gpu"]:
        info["gpu"] = _gpu_from_nvidia_smi(info)
    info["ramGb"] = round(_total_ram_bytes() / 1024**3, 1)
    info["diskFreeGb"] = round(shutil.disk_usage(PROJECT).free / 1024**3, 1)
    return info


def _gpu_from_nvidia_smi(info: dict):
    """Karta NVIDIA bez działającego CUDA w PyTorch (np. zainstalowana wersja CPU) – i tak ją pokażmy."""
    import subprocess
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip().splitlines()
        if out:
            name, mem = out[0].rsplit(",", 1)
            info["vramGb"] = round(float(mem) / 1024, 1)
            return name.strip()
    except Exception:  # noqa: BLE001
        pass
    return None


def _total_ram_bytes() -> int:
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
    try:
        st = MemoryStatus()
        st.dwLength = ctypes.sizeof(MemoryStatus)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
        return st.ullTotalPhys
    except Exception:  # noqa: BLE001 – nie Windows
        return 0


def features() -> dict:
    """Stan każdej zaawansowanej funkcji: dostępna / zablokowana (z powodami) / nie zainstalowana."""
    hw = hardware()
    out = {}
    for key, f in FEATURES.items():
        reasons = []
        if not hw["cuda"]:
            reasons.append(tr("wymaga karty NVIDIA z obsługą CUDA") + (tr(" (wykryto: {gpu})", gpu=hw["gpu"]) if hw["gpu"] else ""))
        elif hw["vramGb"] + 0.3 < f["vram"]:   # 0.3 GB tolerancji: karta „8 GB” zgłasza ~7.9 GB
            reasons.append(tr("za mało pamięci karty: {have} GB, potrzeba {need} GB", have=hw["vramGb"], need=f["vram"]))
        # system zgłasza np. 15,8 GB przy 16 GB kości – 1 GB tolerancji
        if hw["ramGb"] and hw["ramGb"] + 1 < f["ram"]:
            reasons.append(tr("za mało pamięci RAM: {have} GB, potrzeba {need} GB", have=hw["ramGb"], need=f["ram"]))
        if hw["diskFreeGb"] < f["disk"]:
            reasons.append(tr("za mało miejsca na dysku: {have} GB, potrzeba {need} GB", have=hw["diskFreeGb"], need=f["disk"]))
        out[key] = {
            **f,
            "name": tr(f["name"]),
            "description": tr(f["description"]),
            "available": not reasons,
            "reasons": reasons,
            "installed": (paths.FEATURE_MODELS / key / "installed.json").is_file(),
        }
    return out
