# Rekonstrukcja modelu 3D z jednego zdjęcia (TripoSR, licencja MIT).
# Model ładowany leniwie przy pierwszym użyciu (~1,7 GB pobierane raz z Hugging Face).
# torch i trimesh importujemy DOPIERO w funkcjach – ich wczytanie trwa ok. 2–3 s, a przy starcie programu
# nie są potrzebne (warmup() wczytuje je w tle zaraz po uruchomieniu okna).
import threading
import time

import numpy as np
from PIL import Image

from i18n import tr

MODEL_REPO = "stabilityai/TripoSR"
FOREGROUND_RATIO = 0.85   # jaką część kadru zajmuje obiekt na wejściu modelu
MIN_COMPONENT = 0.02      # usuwamy „odpryski” mniejsze niż 2% największej części siatki

_model = None
_device = None
_lock = threading.Lock()

# Stan dla /api/status (podgląd postępu w przeglądarce)
status = {"stage": "idle", "started": None, "error": None}


def _set_stage(stage: str):
    status["stage"] = stage
    print(f"[3D] {stage}", flush=True)


def device() -> str:
    """cuda, jeśli karta jest obsługiwana przez zainstalowaną wersję PyTorch; inaczej cpu."""
    global _device
    if _device is None:
        import torch
        found = "cpu"
        if torch.cuda.is_available():
            try:
                torch.zeros(1, device="cuda").add_(1)  # stare karty mogą nie mieć kerneli w danej wersji torch
                found = "cuda"
            except Exception as exc:  # noqa: BLE001
                print(f"[3D] GPU niedostępne dla tej wersji PyTorch ({exc}) – używam CPU", flush=True)
        _device = found
    return _device


def device_name() -> str:
    if device() == "cuda":
        import torch
        return torch.cuda.get_device_name(0)
    return "CPU"


_warm_started = False


def warmup():
    """Wczytanie PyTorch i rozpoznanie karty w tle – interfejs działa w tym czasie normalnie."""
    global _warm_started
    if not _warm_started:
        _warm_started = True
        threading.Thread(target=device, daemon=True).start()


def device_if_ready():
    """(urządzenie, nazwa) albo (None, None), gdy PyTorch jeszcze się wczytuje."""
    if _device is None:
        warmup()
        return None, None
    return _device, device_name()


def _load_fast():
    """Szybkie wczytanie (~1 s zamiast ~6 s na CPU): sieć budujemy „na sucho” (urządzenie meta – bez losowania
    wag, które i tak zaraz zostałyby nadpisane), a wagi mapujemy z pliku (mmap) i podpinamy bez kopiowania."""
    import torch
    from huggingface_hub import hf_hub_download
    from omegaconf import OmegaConf
    from tsr.system import TSR

    cfg = OmegaConf.load(hf_hub_download(MODEL_REPO, "config.yaml"))
    OmegaConf.resolve(cfg)
    with torch.device("meta"):
        model = TSR(cfg)
    state = torch.load(hf_hub_download(MODEL_REPO, "model.ckpt"), map_location="cpu", mmap=True, weights_only=True)
    model.load_state_dict(state, assign=True)
    # stałe normalizacji obrazu (średnia/odchylenie ImageNet) nie są zapisane w pliku wag – odtwarzamy je
    # tak samo, jak robi to tsr/models/tokenizers/image.py
    tok = model.image_tokenizer
    tok.register_buffer("image_mean", torch.as_tensor([0.485, 0.456, 0.406]).reshape(1, 1, 3, 1, 1), persistent=False)
    tok.register_buffer("image_std", torch.as_tensor([0.229, 0.224, 0.225]).reshape(1, 1, 3, 1, 1), persistent=False)
    leftover = [n for n, t in [*model.named_parameters(), *model.named_buffers()] if t.is_meta]
    if leftover:
        raise RuntimeError(f"niewczytane tensory: {leftover[:5]}")
    return model


def _load():
    global _model
    if _model is None:
        import models_setup
        _set_stage(tr("Wczytywanie modelu 3D…") if models_setup.all_present()
                   else tr("Ładowanie modelu TripoSR (przy pierwszym razie: pobieranie ~1,7 GB)"))
        try:
            model = _load_fast()
        except Exception as exc:  # noqa: BLE001 – np. inna wersja TripoSR; wracamy do zwykłego (wolniejszego) wczytania
            print(f"[3D] szybkie wczytanie nie wyszło ({exc}) – zwykłe wczytanie", flush=True)
            from tsr.system import TSR
            model = TSR.from_pretrained(MODEL_REPO, config_name="config.yaml", weight_name="model.ckpt")
        model.renderer.set_chunk_size(8192)
        model.to(device())
        _model = model
    return _model


def preload():
    """Opcja „Wczytuj model 3D przy starcie”: model w pamięci od razu (ok. 1,7 GB), pierwsze generowanie szybsze."""
    with _lock:
        _load()
        _set_stage("idle")


def unload():
    """Zwolnienie modelu 3D z pamięci karty – na czas pracy cięższych funkcji (S8 tekst → obraz). Następne
    generowanie 3D wczyta go ponownie (_load jest leniwe, ~1 s z mmap)."""
    global _model
    with _lock:
        if _model is None:
            return
        _model = None
        import gc
        gc.collect()
        if device() == "cuda":
            import torch
            torch.cuda.empty_cache()
        print("[3D] model zwolniony z pamięci", flush=True)


def _prepare_input(rgba: Image.Image) -> Image.Image:
    """Jak w run.py z TripoSR: obiekt wyśrodkowany na szarym tle."""
    from tsr.utils import resize_foreground
    image = resize_foreground(rgba.convert("RGBA"), FOREGROUND_RATIO)
    arr = np.asarray(image).astype(np.float32) / 255.0
    arr = arr[..., :3] * arr[..., 3:4] + (1.0 - arr[..., 3:4]) * 0.5
    return Image.fromarray((arr * 255.0).astype(np.uint8))


def _cleanup(mesh):
    import trimesh
    parts = mesh.split(only_watertight=False)
    if len(parts) > 1:
        biggest = max(len(p.faces) for p in parts)
        parts = [p for p in parts if len(p.faces) >= biggest * MIN_COMPONENT]
        mesh = trimesh.util.concatenate(parts)
    if mesh.is_volume and mesh.volume < 0:
        mesh.invert()  # normalne na zewnątrz (ważne dla oświetlenia)
    return mesh


def generate(rgba: Image.Image, mc_resolution: int = 192) -> bytes:
    """Zwraca model w formacie GLB (siatka z kolorami wierzchołków, oś Y w górę)."""
    import torch
    import trimesh
    from tsr.utils import to_gradio_3d_orientation

    with _lock:
        status.update(started=time.time(), error=None)
        try:
            model = _load()
            _set_stage(tr("Analiza zdjęcia (sieć neuronowa)"))
            image = _prepare_input(rgba)
            with torch.no_grad():
                scene_codes = model([image], device=device())
            _set_stage(tr("Budowanie siatki 3D ({n}³)", n=mc_resolution))
            mesh = model.extract_mesh(scene_codes, True, resolution=mc_resolution)[0]
            _set_stage(tr("Porządkowanie siatki"))
            mesh = to_gradio_3d_orientation(_cleanup(mesh))
            # po tej transformacji przód obiektu patrzy w -Z; obracamy, żeby patrzył w +Z (standard glTF)
            mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [0, 1, 0]))
            data = mesh.export(file_type="glb")
            _set_stage("idle")
            return data
        except Exception as exc:
            status["error"] = str(exc)
            _set_stage("idle")
            raise
        finally:
            if device() == "cuda":
                torch.cuda.empty_cache()
