# S9: „lepszy tył obiektu” – alternatywny silnik 3D: Zero123++ dorysowuje 6 widoków obiektu (z góry/z dołu, dookoła),
# a InstantMesh (LRM + FlexiCubes) buduje z nich siatkę z kolorami wierzchołków. Wyraźnie lepsze boki i tył niż
# TripoSR z jednego zdjęcia, ale wolniej (kilkadziesiąt sekund) i ok. 9 GB modeli pobieranych na żądanie.
# Licencje: kod InstantMesh/Zero123++ Apache-2.0; WAGI Zero123++ (także dostrojony UNet z TencentARC/InstantMesh)
# CC-BY-NC 4.0 – decyzja użytkownika 28.09.2026; informacja o tym jest w oknie funkcji i w LICENSE.txt.
# nvdiffrast (kompilacja CUDA) zastąpiony atrapą server/nvdiffrast – ścieżka kolorów wierzchołków go nie potrzebuje.
import json
import os
import sys
import threading
import types
import time
from pathlib import Path

import numpy as np
from PIL import Image

import paths
from i18n import tr

FEATURE = "multiview"
DIR = paths.FEATURE_MODELS / FEATURE
# Pliki modeli w zwykłych folderach (local_dir), NIE w pamięci podręcznej HF: ta tworzy dowiązania symboliczne,
# a Windows bez trybu dewelopera odmawia (WinError 1314 – zgłoszone w eksperymencie).
ZERO_DIR = DIR / "zero123plus-v1.2"
IM_FILES = DIR / "InstantMesh"
INSTALLED_FLAG = DIR / "installed.json"
IM_DIR = paths.PROJECT / "server" / "third_party" / "InstantMesh"
if not (IM_DIR / "src").is_dir() and (DIR / "InstantMesh-code" / "src").is_dir():
    IM_DIR = DIR / "InstantMesh-code"   # kod pobrany przez _download_code() w instalacji Program Files

ZERO_REPO = "sudo-ai/zero123plus-v1.2"
ZERO_PATTERNS = ["*.json", "*.txt", "*.safetensors", "*.bin"]
ZERO_IGNORE = ["*.msgpack", "*.h5", "*.onnx"]
IM_REPO = "TencentARC/InstantMesh"
UNET_FILE = "diffusion_pytorch_model.bin"      # UNet Zero123++ dostrojony przez InstantMesh (białe tło)
LRM_FILE = "instant_mesh_large.ckpt"
# Koder obrazu DINO (Apache-2.0) – LRM buduje go przez from_pretrained; wagi i tak nadpisuje ckpt, ale transformers
# wymaga pliku wag (w HF_HOME programu jest tylko config.json z TripoSR → w trybie offline "NoneType … endswith").
DINO_REPO = "facebook/dino-vitb16"
DINO_DIR = DIR / "dino-vitb16"
DINO_PATTERNS = ["config.json", "preprocessor_config.json", "pytorch_model.bin"]
TOTAL_MB = 5600 + 1730 + 1510 + 343

VIEW_STEPS = 75          # Zero123++: ~28 wystarcza dla prostych obiektów, 75 daje wyraźniejsze detale
FOREGROUND_RATIO = 0.85

status = {
    "installed": False, "installing": False, "progress": 0.0, "current": None, "error": None,
    "generating": False, "stage": "idle", "started": None, "loaded": False,
}
_lock = threading.Lock()
_pipe = None
_model = None


def _trust_windows_certificates():
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        pass


def code_present() -> bool:
    return (IM_DIR / "src" / "models" / "lrm_mesh.py").is_file() and (IM_DIR / "zero123plus" / "pipeline.py").is_file()


def installed() -> bool:
    ok = (code_present() and (ZERO_DIR / "model_index.json").is_file() and (ZERO_DIR / "unet" / "config.json").is_file()
          and (IM_FILES / UNET_FILE).is_file() and (IM_FILES / LRM_FILE).is_file()
          and (DINO_DIR / "pytorch_model.bin").is_file() and (DINO_DIR / "preprocessor_config.json").is_file())
    status["installed"] = ok
    if ok and not INSTALLED_FLAG.is_file():
        try:
            DIR.mkdir(parents=True, exist_ok=True)
            INSTALLED_FLAG.write_text(json.dumps({"installed": time.strftime("%Y-%m-%d"), "lrm": LRM_FILE}), encoding="utf-8")
        except OSError:
            pass
    return ok


def summary() -> dict:
    installed()
    return {**status, "sizeMb": TOTAL_MB, "codePresent": code_present()}


def _size_of_downloads() -> int:
    total = 0
    for p in DIR.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


def _install():
    _trust_windows_certificates()
    os.environ.pop("HF_HUB_OFFLINE", None)
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
    from huggingface_hub import hf_hub_download, snapshot_download
    DIR.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()

    def watch():
        while not stop.wait(1.0):
            status["progress"] = min(0.99, _size_of_downloads() / (TOTAL_MB * 1024 * 1024))

    threading.Thread(target=watch, daemon=True).start()
    try:
        if not code_present():
            # kopie zaktualizowane z wersji sprzed S9 nie mają kodu (paczka aktualizacji pomija third_party)
            status["current"] = tr("kod InstantMesh (GitHub)")
            _download_code()
        if not code_present():
            raise RuntimeError(tr("brakuje kodu InstantMesh (server/third_party/InstantMesh) – uruchom instalator ponownie"))
        status["current"] = tr("widoki: Zero123++ (5,6 GB)")
        snapshot_download(ZERO_REPO, local_dir=ZERO_DIR, allow_patterns=ZERO_PATTERNS, ignore_patterns=ZERO_IGNORE)
        status["current"] = tr("siatka: InstantMesh (3,2 GB)")
        hf_hub_download(IM_REPO, UNET_FILE, local_dir=IM_FILES)
        hf_hub_download(IM_REPO, LRM_FILE, local_dir=IM_FILES)
        status["current"] = tr("koder obrazu DINO (0,3 GB)")
        snapshot_download(DINO_REPO, local_dir=DINO_DIR, allow_patterns=DINO_PATTERNS)
        if not installed():
            raise RuntimeError(tr("po pobraniu brakuje plików modelu"))
        status["progress"] = 1.0
    except Exception as exc:  # noqa: BLE001
        status["error"] = tr("Nie udało się pobrać modelu: {exc}", exc=exc)
        print(f"[multiview] {status['error']}", flush=True)
    finally:
        stop.set()
        status.update(installing=False, current=None)
        import models_setup
        models_setup.enable_offline_if_ready()


CODE_ZIP_URL = "https://github.com/TencentARC/InstantMesh/archive/refs/heads/main.zip"


def _download_code():
    """Kod InstantMesh jako ZIP z GitHuba (bez Gita) → server/third_party/InstantMesh. Folder programu w Program Files
    jest tylko do odczytu → wtedy kod trafia obok modeli (paths.FEATURE_MODELS/multiview/InstantMesh-code)."""
    import io
    import shutil
    import urllib.request
    import zipfile
    global IM_DIR
    target = IM_DIR if paths.PROJECT_WRITABLE else DIR / "InstantMesh-code"
    req = urllib.request.Request(CODE_ZIP_URL, headers={"User-Agent": "MakePixel3D"})
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310
        data = r.read()
    tmp = target.parent / "InstantMesh-extract"
    if tmp.exists():
        shutil.rmtree(tmp)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(tmp)
    inner = next(p for p in tmp.iterdir() if p.is_dir())
    if target.exists():
        shutil.rmtree(target)
    shutil.move(str(inner), str(target))
    shutil.rmtree(tmp, ignore_errors=True)
    IM_DIR = target


def install_in_background():
    if status["installing"] or installed():
        return
    status.update(installing=True, progress=0.0, error=None)
    threading.Thread(target=_install, daemon=True).start()


def _set_stage(stage: str):
    status["stage"] = stage
    print(f"[multiview] {stage}", flush=True)


def _import_instantmesh():
    """Kod InstantMesh (pakiet `src`) + atrapa nvdiffrast z server/ – dopiero przy pierwszym użyciu."""
    for p in (str(paths.PROJECT / "server"), str(IM_DIR)):
        if p not in sys.path:
            sys.path.insert(0, p)


def _load():
    global _pipe, _model
    if _pipe is not None and _model is not None:
        return _pipe, _model
    import torch
    from diffusers import DiffusionPipeline, EulerAncestralDiscreteScheduler
    from omegaconf import OmegaConf

    _import_instantmesh()
    from src.utils.train_util import instantiate_from_config

    _set_stage(tr("Wczytywanie modeli widoków i siatki…"))
    pipe = DiffusionPipeline.from_pretrained(str(ZERO_DIR), custom_pipeline=str(IM_DIR / "zero123plus"), torch_dtype=torch.float16, trust_remote_code=True)
    pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing")
    pipe.unet.load_state_dict(torch.load(IM_FILES / UNET_FILE, map_location="cpu"), strict=True)
    pipe.set_progress_bar_config(disable=True)
    # cały pipeline na karcie (5 GB); enable_model_cpu_offload() nie działa z tym własnym pipeline'em
    # („Expected all tensors to be on the same device” – pipeline sam przenosi tensory)
    pipe = pipe.to("cuda")

    cfg = OmegaConf.load(IM_DIR / "configs" / "instant-mesh-large.yaml")
    cfg.model_config.params.encoder_model_name = str(DINO_DIR)   # lokalna kopia zamiast pobierania z HF
    model = instantiate_from_config(cfg.model_config)
    sd = torch.load(IM_FILES / LRM_FILE, map_location="cpu")["state_dict"]
    model.load_state_dict({k[14:]: v for k, v in sd.items() if k.startswith("lrm_generator.")}, strict=True)
    model = model.to("cuda").eval()
    model.init_flexicubes_geometry("cuda", fovy=30.0)
    model.synthesizer.get_geometry_prediction = types.MethodType(_geometry_prediction_chunked, model.synthesizer)
    _pipe, _model = pipe, model
    status["loaded"] = True
    return pipe, model


def _geometry_prediction_chunked(synth, planes, sample_coordinates, flexicubes_indices, chunk=131072):
    """Zamiennik TriplaneSynthesizer.get_geometry_prediction liczony kawałkami. Oryginał składa cechy 8 narożników
    każdej z 2,1 mln kostek FlexiCubes w jednym tensorze (~16 GB) – na 12 GB VRAM Windows przelewał to do RAM
    (19,6 GB „VRAM”, 7–11 s); kawałkami: 0,6 s i 5,7 GB (pomiar 28.09.2026). Wynik identyczny co do wartości."""
    import torch
    from src.models.renderer.utils.renderer import sample_from_planes
    plane_axes = synth.plane_axes.to(planes.device)
    feats = sample_from_planes(plane_axes, planes, sample_coordinates, padding_mode="zeros",
                               box_warp=synth.rendering_kwargs["box_warp"])
    n, n_planes, m, c = feats.shape
    feats = feats.permute(0, 2, 1, 3).reshape(n, m, n_planes * c)
    dec = synth.decoder
    sdf = torch.cat([dec.net_sdf(feats[:, i:i + chunk]) for i in range(0, m, chunk)], dim=1)
    deformation = torch.cat([dec.net_deformation(feats[:, i:i + chunk]) for i in range(0, m, chunk)], dim=1)
    weight = []
    for i in range(0, flexicubes_indices.shape[0], chunk):
        idx = flexicubes_indices[i:i + chunk]
        g = torch.index_select(feats, 1, idx.reshape(-1)).reshape(n, idx.shape[0], idx.shape[1] * feats.shape[-1])
        weight.append(dec.net_weight(g) * 0.1)
    return sdf, deformation, torch.cat(weight, dim=1)


def unload():
    global _pipe, _model
    with _lock:
        if _pipe is None and _model is None:
            return
        _pipe = _model = None
        status["loaded"] = False
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        print("[multiview] modele zwolnione", flush=True)


def _prepare_input(rgba: Image.Image) -> Image.Image:
    _import_instantmesh()
    from src.utils.infer_util import resize_foreground
    return resize_foreground(rgba.convert("RGBA"), FOREGROUND_RATIO)


def generate(rgba: Image.Image, seed: int | None = None) -> tuple[bytes, Image.Image]:
    """Obiekt bez tła → (GLB z kolorami wierzchołków, siatka 6 widoków jako obraz – do podglądu w galerii).
    Oś Y w górę, przód = +Z (tak jak reconstruct.generate)."""
    import torch
    import trimesh
    from einops import rearrange
    from torchvision.transforms import v2

    import reconstruct
    import text2image

    if not installed():
        raise RuntimeError(tr("Funkcja „Lepszy tył obiektu” nie jest zainstalowana."))
    with _lock:
        status.update(generating=True, started=time.time(), error=None)
        try:
            reconstruct.unload()
            text2image.unload()
            pipe, model = _load()
            _import_instantmesh()
            from src.utils.camera_util import get_zero123plus_input_cameras

            _set_stage(tr("Dorysowywanie widoków z innych stron (Zero123++)…"))
            gen = torch.Generator("cuda").manual_seed(seed if seed is not None else 0)
            grid = pipe(_prepare_input(rgba), num_inference_steps=VIEW_STEPS, generator=gen).images[0]
            views = torch.from_numpy(np.asarray(grid, dtype=np.float32) / 255.0).permute(2, 0, 1).contiguous()
            views = rearrange(views, "c (n h) (m w) -> (n m) c h w", n=3, m=2)   # 6 widoków 320×320

            _set_stage(tr("Budowanie siatki 3D z widoków (InstantMesh)…"))
            cams = get_zero123plus_input_cameras(batch_size=1, radius=4.0).to("cuda")
            imgs = v2.functional.resize(views.unsqueeze(0).to("cuda"), 320, interpolation=3, antialias=True).clamp(0, 1)
            # extract_mesh zwraca tablice numpy; pamięć: patrz _geometry_prediction_chunked
            with torch.no_grad():
                with torch.autocast("cuda", dtype=torch.float16):   # transformer/DINO w fp16 (3,3 GB)
                    planes = model.forward_planes(imgs, cams)
                vertices, faces, colors = model.extract_mesh(planes.float(), use_texture_map=False)   # FlexiCubes: fp32
            vertices, faces, colors = [np.asarray(x.detach().cpu() if hasattr(x, "cpu") else x) for x in (vertices, faces, colors)]
            if colors.dtype != np.uint8:   # extract_mesh oddaje już uint8 0–255; zabezpieczenie, gdyby oddał 0–1
                colors = (np.clip(colors, 0, 1) * 255).astype(np.uint8)
            mesh = trimesh.Trimesh(vertices, faces, vertex_colors=colors, process=False)
            mesh = _orient(mesh)
            _set_stage("idle")
            return mesh.export(file_type="glb"), grid
        except Exception as exc:
            status["error"] = str(exc)
            _set_stage("idle")
            raise
        finally:
            status["generating"] = False
            if torch.cuda.is_available():
                torch.cuda.empty_cache()


def _orient(mesh):
    """Układ InstantMesh → układ programu (Y w górę, przód obiektu = +Z). Dobrane doświadczalnie – patrz CLAUDE.md."""
    import trimesh
    # InstantMesh: Z w górę, przód obiektu (kierunek zdjęcia wejściowego, azymut 0 kamer Zero123++) = +X.
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))   # Z w górę → Y w górę
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [0, 1, 0]))   # przód +X → +Z
    return mesh
