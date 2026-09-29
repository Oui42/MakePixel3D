# S10: szkielet i skórowanie modelu (UniRig, VAST – kod i wagi MIT) → GLB ze szkieletem i wagami (Three.js SkinnedMesh),
# animacje buduje przeglądarka (web/rig.js) na kościach: dla humanoidów nazwanych po VRoid (J_Bip_…), dla reszty ogólne.
#
# UniRig wymaga bpy (Blender jako moduł, tylko Python 3.11) i kilku bibliotek z gotowymi kołami dla Windows, dlatego
# funkcja instaluje WŁASNE środowisko Python 3.11 („embeddable”, bez instalatora systemowego) w paths.FEATURE_MODELS/rigging:
#   python311/   – Python embeddable + pip + torch/torchvision (index cpu|cu128 jak program), torch_scatter/torch_cluster
#                  (data.pyg.org), spconv, bpy 4.2, transformers 4.51.3, lightning, …  (~4 GB)
#   UniRig/      – kod z GitHuba (ZIP, bez Gita) + nasze konfiguracje *_mp3d.yaml (bez flash-attn, lokalne wagi)
#   weights/     – VAST-AI/UniRig: skeleton (1,3 GB) i skin (4,2 GB);  opt-350m/ – konfiguracja OPT-350m (HF offline)
# flash_attn zastępuje atrapa server/flash_attn (patrz tam); checkpointy wczytuje server/unirig_run.py (weights_only=False).
# Przebieg (eksperyment 28.09.2026, ~1 min na model): extract (bpy: GLB → raw_data.npz) → szkielet (run.py, FBX) →
# extract FBX szkieletu → skin (FBX) → merge (rigged GLB). Szczegóły i pułapki: CLAUDE.md, sekcja S10.
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from pathlib import Path

import paths
from i18n import tr

FEATURE = "rigging"
DIR = paths.FEATURE_MODELS / FEATURE
PY_DIR = DIR / "python311"
PY = PY_DIR / "python.exe"
CODE_DIR = DIR / "UniRig"
WEIGHTS = DIR / "weights"
OPT_DIR = DIR / "opt-350m"
INSTALLED_FLAG = DIR / "installed.json"
INSTALL_LOG = DIR / "install.log"
SERVER_DIR = Path(__file__).resolve().parent
RUNNER = SERVER_DIR / "unirig_run.py"

PY_VERSION = "3.11.9"
PY_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
GETPIP_URL = "https://bootstrap.pypa.io/get-pip.py"
CODE_URL = "https://github.com/VAST-AI-Research/UniRig/archive/refs/heads/main.zip"
HF_REPO = "VAST-AI/UniRig"
SKELETON_CKPT = "skeleton/articulation-xl_quantization_256/model.ckpt"
SKIN_CKPT = "skin/articulation-xl/model.ckpt"
OPT_REPO = "facebook/opt-350m"
OPT_FILES = ["config.json", "generation_config.json", "tokenizer_config.json", "vocab.json", "merges.txt",
             "special_tokens_map.json"]
PACKAGES = ["transformers==4.51.3", "python-box", "einops", "omegaconf", "lightning", "addict", "timm",
            "fast-simplification", "trimesh", "open3d", "huggingface_hub<1.0", "numpy==1.26.4", "scipy", "scikit-learn",
            "tqdm", "pillow", "psutil", "matplotlib", "pyrender", "truststore", "bpy==4.2"]
TOTAL_MB = 10500
TIMEOUT_S = 20 * 60

# udział etapów instalacji w pasku postępu (pip nie zgłasza postępu – pasek idzie etapami)
STAGES = [("python", 0.02), ("pip", 0.03), ("torch", 0.35), ("pyg", 0.05), ("packages", 0.15), ("code", 0.02),
          ("weights", 0.38)]

status = {
    "installed": False, "installing": False, "progress": 0.0, "current": None, "error": None,
    "generating": False, "stage": "idle", "started": None,
}
_lock = threading.Lock()


def _trust_windows_certificates():
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        pass


def installed() -> bool:
    ok = (PY.is_file() and INSTALLED_FLAG.is_file() and (CODE_DIR / "run.py").is_file()
          and (CODE_DIR / "configs" / "task" / "skeleton_mp3d.yaml").is_file()
          and (WEIGHTS / SKELETON_CKPT).is_file() and (WEIGHTS / SKIN_CKPT).is_file()
          and (OPT_DIR / "config.json").is_file())
    status["installed"] = ok
    return ok


def summary() -> dict:
    installed()
    return {**status, "sizeMb": TOTAL_MB}


def _torch_variant() -> str:
    try:
        return json.loads((paths.CONFIG / "install.json").read_text(encoding="utf-8-sig")).get("torch") or "cu128"
    except (OSError, ValueError):
        return "cu128"


def _log(text: str):
    print(f"[rigging] {text}", flush=True)
    try:
        DIR.mkdir(parents=True, exist_ok=True)
        with open(INSTALL_LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {text}\n")
    except OSError:
        pass


def _download(url: str, dest: Path):
    import urllib.request
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "MakePixel3D"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as out:  # noqa: S310
        shutil.copyfileobj(r, out)


def _run(args: list[str], cwd: Path | None = None, env: dict | None = None, timeout: int = TIMEOUT_S) -> str:
    """Uruchamia proces bez okna konsoli, wyjście do install.log; błąd → wyjątek z ostatnimi liniami."""
    full_env = {**os.environ, **(env or {})}
    full_env.setdefault("PYTHONIOENCODING", "utf-8")
    full_env.setdefault("PYTHONUTF8", "1")
    p = subprocess.run(args, cwd=str(cwd) if cwd else None, env=full_env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    out = (p.stdout or "") + (p.stderr or "")
    try:
        with open(INSTALL_LOG, "a", encoding="utf-8") as f:
            f.write(f"$ {' '.join(str(a) for a in args)}\n{out}\n")
    except OSError:
        pass
    if p.returncode != 0:
        tail = "\n".join(out.strip().splitlines()[-8:])
        raise RuntimeError(f"{Path(args[0]).name} ({p.returncode}): {tail}")
    return out


def _set_progress(stage: str, frac_in_stage: float = 0.0):
    done = 0.0
    for name, share in STAGES:
        if name == stage:
            status["progress"] = min(0.99, done + share * max(0.0, min(1.0, frac_in_stage)))
            return
        done += share
    status["progress"] = min(0.99, done)


# ---------------------------------------------------------------- instalacja
def _install_python():
    if (PY_DIR / "Lib" / "site-packages" / "pip").is_dir():
        return
    status["current"] = tr("Python 3.11 (11 MB)")
    tmp = DIR / "python-embed.zip"
    _download(PY_URL, tmp)
    if PY_DIR.exists():
        shutil.rmtree(PY_DIR)
    with zipfile.ZipFile(tmp) as z:
        z.extractall(PY_DIR)
    tmp.unlink(missing_ok=True)
    # python311._pth: wersja embeddable ma wyłączone `import site` (bez tego pip i site-packages nie działają)
    pth = next(PY_DIR.glob("python*._pth"))
    lines = [ln for ln in pth.read_text(encoding="utf-8").splitlines() if ln.strip() != "#import site"]
    lines += ["Lib\\site-packages", "import site"]
    pth.write_text("\n".join(lines) + "\n", encoding="utf-8")
    _set_progress("pip")
    status["current"] = tr("pip")
    getpip = DIR / "get-pip.py"
    _download(GETPIP_URL, getpip)
    _run([str(PY), str(getpip), "--no-warn-script-location", "--disable-pip-version-check"], cwd=DIR)
    getpip.unlink(missing_ok=True)
    _ensure_sitecustomize()


SITECUSTOMIZE = '''# MakePixel3D: Python embeddable (plik ._pth) IGNORUJE PYTHONPATH i nie dodaje bieżącego folderu do sys.path,
# a UniRig uruchamiamy przez `-m src.data.extract` z kodu poza tym folderem – ścieżki podajemy zmienną MAKEPIXEL3D_PYPATH.
import os, sys
for p in os.environ.get("MAKEPIXEL3D_PYPATH", "").split(os.pathsep):
    if p and p not in sys.path:
        sys.path.insert(0, p)
'''


def _ensure_sitecustomize():
    sp = PY_DIR / "Lib" / "site-packages"
    sp.mkdir(parents=True, exist_ok=True)
    f = sp / "sitecustomize.py"
    if not f.is_file() or f.read_text(encoding="utf-8") != SITECUSTOMIZE:
        f.write_text(SITECUSTOMIZE, encoding="utf-8")


def _pip(*args: str):
    _run([str(PY), "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location",
          "--progress-bar", "off", *args], cwd=DIR)


def _install_packages():
    variant = _torch_variant()
    _set_progress("torch")
    status["current"] = tr("PyTorch dla Pythona 3.11 ({v}, ok. 3 GB)", v=variant)
    if not (_has_module("torch") and _has_module("torchvision")):
        _pip("torch", "torchvision", "--index-url", f"https://download.pytorch.org/whl/{variant}")
    torch_ver = _run([str(PY), "-c", "import torch; print(torch.__version__.split('+')[0])"], cwd=DIR).strip().splitlines()[-1]
    _set_progress("pyg")
    status["current"] = tr("torch_scatter / torch_cluster")
    if not _has_module("torch_scatter") or not _has_module("torch_cluster"):
        _pip("torch_scatter", "torch_cluster", "-f", f"https://data.pyg.org/whl/torch-{torch_ver}+{variant}.html")
    if not _has_module("spconv"):
        _pip("spconv-cu126" if variant.startswith("cu") else "spconv")
    _set_progress("packages")
    status["current"] = tr("biblioteki UniRig i Blender (bpy, 0,3 GB)")
    _pip(*PACKAGES)
    _run([str(PY), "-c", "import bpy, spconv, torch_scatter, torch_cluster, transformers, lightning, box, open3d; print('ok')"], cwd=DIR)


def _has_module(name: str) -> bool:
    try:
        _run([str(PY), "-c", f"import {name}"], cwd=DIR, timeout=120)
        return True
    except Exception:  # noqa: BLE001
        return False


def _install_code():
    _set_progress("code")
    if not (CODE_DIR / "run.py").is_file():
        status["current"] = tr("kod UniRig (GitHub)")
        tmp = DIR / "unirig.zip"
        _download(CODE_URL, tmp)
        ex = DIR / "unirig-extract"
        if ex.exists():
            shutil.rmtree(ex)
        with zipfile.ZipFile(tmp) as z:
            z.extractall(ex)
        inner = next(p for p in ex.iterdir() if p.is_dir())
        if CODE_DIR.exists():
            shutil.rmtree(CODE_DIR)
        shutil.move(str(inner), str(CODE_DIR))
        shutil.rmtree(ex, ignore_errors=True)
        tmp.unlink(missing_ok=True)
    _write_configs()


def _write_configs():
    """Nasze konfiguracje obok oryginalnych: bez flash-attn, lokalne checkpointy i OPT-350m, klasa VRoid dla humanoidów."""
    cfg = CODE_DIR / "configs"
    def patched(src: Path, pairs: list[tuple[str, str]]) -> str:
        s = src.read_text(encoding="utf-8")
        for a, b in pairs:
            if a not in s:
                raise RuntimeError(tr("konfiguracja UniRig zmieniła się ({f}) – funkcja wymaga aktualizacji programu", f=src.name))
            s = s.replace(a, b)
        return s
    (cfg / "model" / "unirig_skin_mp3d.yaml").write_text(patched(cfg / "model" / "unirig_skin.yaml", [
        ("  upcast_attention: False\n  upcast_softmax: False\n", "  upcast_attention: True\n  upcast_softmax: True\n  enable_flash: False\n"),
        ("  flash: True\n", "  flash: False\n")]), encoding="utf-8")
    (cfg / "model" / "unirig_ar_mp3d.yaml").write_text(patched(cfg / "model" / "unirig_ar_350m_1024_81920_float32.yaml", [
        ("_attn_implementation: flash_attention_2", "_attn_implementation: sdpa"),
        ("  flash: True\n", "  flash: False\n"),
        ("pretrained_model_name_or_path: facebook/opt-350m", f"pretrained_model_name_or_path: {OPT_DIR.as_posix()}")]), encoding="utf-8")
    (cfg / "system" / "ar_inference_vroid_mp3d.yaml").write_text(patched(cfg / "system" / "ar_inference_articulationxl.yaml", [
        ("assign_cls: articulationxl", "assign_cls: vroid")]), encoding="utf-8")
    skel = patched(cfg / "task" / "quick_inference_skeleton_articulationxl_ar_256.yaml", [
        ("resume_from_checkpoint: experiments/skeleton/articulation-xl_quantization_256/model.ckpt",
         f"resume_from_checkpoint: {(WEIGHTS / SKELETON_CKPT).as_posix()}"),
        ("model: unirig_ar_350m_1024_81920_float32", "model: unirig_ar_mp3d")])
    (cfg / "task" / "skeleton_mp3d.yaml").write_text(skel, encoding="utf-8")
    (cfg / "task" / "skeleton_vroid_mp3d.yaml").write_text(
        skel.replace("system: ar_inference_articulationxl", "system: ar_inference_vroid_mp3d"), encoding="utf-8")
    (cfg / "task" / "skin_mp3d.yaml").write_text(patched(cfg / "task" / "quick_inference_unirig_skin.yaml", [
        ("resume_from_checkpoint: experiments/skin/articulation-xl/model.ckpt",
         f"resume_from_checkpoint: {(WEIGHTS / SKIN_CKPT).as_posix()}"),
        ("model: unirig_skin", "model: unirig_skin_mp3d")]), encoding="utf-8")


def _install_weights():
    _set_progress("weights")
    from huggingface_hub import hf_hub_download, snapshot_download
    total = (1300 + 4200) * 1024 * 1024
    stop = threading.Event()

    def watch():
        while not stop.wait(1.0):
            have = sum(p.stat().st_size for p in WEIGHTS.rglob("*") if p.is_file()) if WEIGHTS.exists() else 0
            _set_progress("weights", have / total)

    threading.Thread(target=watch, daemon=True).start()
    try:
        status["current"] = tr("wagi UniRig: szkielet (1,3 GB)")
        hf_hub_download(HF_REPO, SKELETON_CKPT, local_dir=WEIGHTS)
        status["current"] = tr("wagi UniRig: skórowanie (4,2 GB)")
        hf_hub_download(HF_REPO, SKIN_CKPT, local_dir=WEIGHTS)
        status["current"] = tr("konfiguracja OPT-350m")
        snapshot_download(OPT_REPO, local_dir=OPT_DIR, allow_patterns=OPT_FILES)
    finally:
        stop.set()


def _install():
    _trust_windows_certificates()
    os.environ.pop("HF_HUB_OFFLINE", None)
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
    try:
        DIR.mkdir(parents=True, exist_ok=True)
        _log("instalacja: start")
        _set_progress("python")
        _install_python()
        _install_packages()
        _install_code()
        _install_weights()
        INSTALLED_FLAG.write_text(json.dumps({"installed": time.strftime("%Y-%m-%d"), "python": PY_VERSION,
                                              "torch": _torch_variant()}), encoding="utf-8")
        if not installed():
            raise RuntimeError(tr("po instalacji brakuje plików funkcji"))
        status["progress"] = 1.0
        _log("instalacja: gotowe")
    except Exception as exc:  # noqa: BLE001
        status["error"] = tr("Nie udało się zainstalować funkcji: {exc}", exc=exc)
        _log(f"BŁĄD: {exc}")
    finally:
        status.update(installing=False, current=None)
        import models_setup
        models_setup.enable_offline_if_ready()


def install_in_background():
    if status["installing"] or installed():
        return
    status.update(installing=True, progress=0.0, error=None)
    threading.Thread(target=_install, daemon=True).start()


# ---------------------------------------------------------------- szkielet + skórowanie
def _set_stage(stage: str):
    status["stage"] = stage
    print(f"[rigging] {stage}", flush=True)


def _env() -> dict:
    return {
        # Python embeddable ignoruje PYTHONPATH – ścieżki dokłada sitecustomize.py (patrz SITECUSTOMIZE)
        "MAKEPIXEL3D_PYPATH": f"{SERVER_DIR}{os.pathsep}{CODE_DIR}",   # server/ = atrapa flash_attn
        "PYTHONPATH": f"{SERVER_DIR}{os.pathsep}{CODE_DIR}",
        "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1",
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "HF_HOME": str(paths.CACHE / "hf_rigging"),            # zapisywalny (Program Files jest tylko do odczytu)
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def _step(args: list[str], cwd: Path):
    p = subprocess.run(args, cwd=str(cwd), env={**os.environ, **_env()}, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=TIMEOUT_S,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if p.returncode != 0:
        out = (p.stdout or "") + (p.stderr or "")
        print(out[-4000:], flush=True)
        tail = "\n".join(out.strip().splitlines()[-6:])
        raise RuntimeError(tail)


def rig(glb: bytes, humanoid: bool = False) -> bytes:
    """GLB (siatka z kolorami) → GLB ze szkieletem i wagami skórowania. humanoid=True: kości nazwane po VRoid."""
    if not installed():
        raise RuntimeError(tr("Funkcja „Szkielet i animacje” nie jest zainstalowana."))
    import multiview
    import reconstruct
    import text2image

    with _lock:
        status.update(generating=True, started=time.time(), error=None)
        work = paths.CACHE / "rig" / uuid.uuid4().hex
        try:
            _ensure_sitecustomize()
            _write_configs()          # ścieżki do wag są absolutne – odświeżamy, gdyby folder danych się zmienił (kopia)
            reconstruct.unload()      # UniRig potrzebuje karty dla siebie (min. 8 GB)
            text2image.unload()
            multiview.unload()
            work.mkdir(parents=True, exist_ok=True)
            src = work / "input.glb"
            src.write_bytes(glb)
            npz = work / "npz"
            extract = [str(PY), "-m", "src.data.extract", "--config", "configs/data/quick_inference.yaml",
                       "--faces_target_count", "50000", "--num_runs", "1", "--force_override", "true", "--id", "0",
                       "--time", "t", "--output_dir", str(npz)]
            _set_stage(tr("Przygotowanie siatki (Blender)…"))
            _step(extract + ["--require_suffix", "glb", "--input", str(src)], CODE_DIR)
            _set_stage(tr("Przewidywanie szkieletu (UniRig)…"))
            task = "configs/task/skeleton_vroid_mp3d.yaml" if humanoid else "configs/task/skeleton_mp3d.yaml"
            skel = work / "skeleton.fbx"
            _step([str(PY), str(RUNNER), "run.py", "--task", task, "--seed", "12345", "--input", str(src),
                   "--output", str(skel), "--npz_dir", str(npz)], CODE_DIR)
            _set_stage(tr("Przygotowanie szkieletu…"))
            _step(extract + ["--require_suffix", "fbx", "--input", str(skel)], CODE_DIR)
            _set_stage(tr("Wagi skórowania (UniRig)…"))
            skin = work / "skin.fbx"
            _step([str(PY), str(RUNNER), "run.py", "--task", "configs/task/skin_mp3d.yaml", "--seed", "12345",
                   "--input", str(skel), "--output", str(skin), "--npz_dir", str(npz), "--data_name", "raw_data.npz"],
                  CODE_DIR)
            _set_stage(tr("Scalanie modelu ze szkieletem…"))
            out = work / "rigged.glb"
            _step([str(PY), "-m", "src.inference.merge", "--require_suffix", "glb", "--num_runs", "1", "--id", "0",
                   "--source", str(skin), "--target", str(src), "--output", str(out)], CODE_DIR)
            if not out.is_file():
                raise RuntimeError(tr("UniRig nie zapisał wyniku"))
            _set_stage("idle")
            return out.read_bytes()
        except Exception as exc:
            status["error"] = str(exc)
            _set_stage("idle")
            raise
        finally:
            status["generating"] = False
            shutil.rmtree(work, ignore_errors=True)
