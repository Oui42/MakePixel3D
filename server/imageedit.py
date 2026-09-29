# S11: edycja obrazu przez AI (FLUX.1 Kontext dev) – „dodaj miecz w prawej dłoni”, „zmień spodnie na zielone” itp.
# Edytujemy OBRAZ ŹRÓDŁOWY (zdjęcie/obraz z opisu, obiekt na białym tle), a potem użytkownik generuje model 3D od nowa –
# to jedyna realna droga do dogenerowania elementów (edycja gotowej siatki 3D wymagałaby osobnego modelu 3D i ręcznego
# doczepiania). Licencja: wagi FLUX.1 Kontext dev są NIEKOMERCYJNE (FluxDev Non-Commercial License) – decyzja użytkownika
# 29.09.2026 (jak Zero123++). Składniki wspólne z S8 (CLIP, T5, VAE, tokenizery) bierzemy z text2image (bez ponownego
# pobierania i bez drugiej kopii T5 w RAM); do pobrania tylko transformer GGUF Q4_K_S (6,8 GB, QuantStack) + konfiguracja
# pipeline'u z mirroru bez bramki (oryginalne repo black-forest-labs jest gated).
import json
import os
import threading
import time
from pathlib import Path

from PIL import Image

import paths
from i18n import tr

FEATURE = "imageedit"
DIR = paths.FEATURE_MODELS / FEATURE
CACHE = DIR / "hf"
INSTALLED_FLAG = DIR / "installed.json"

TRANSFORMER = ("QuantStack/FLUX.1-Kontext-dev-GGUF", "flux1-kontext-dev-Q4_K_S.gguf", 6800)
BASE_REPO = "fuliucansheng/FLUX.1-Kontext-dev-diffusers"   # mirror bez bramki: tylko konfiguracje (scheduler dev ≠ schnell)
BASE_PATTERNS = ["model_index.json", "scheduler/*", "transformer/config.json"]
TOTAL_MB = TRANSFORMER[2] + 50

# Dopisek: zmieniamy tylko to, o co prosi użytkownik; reszta (postać, poza, styl, białe tło) ma zostać – inaczej Kontext
# chętnie przerysowuje całość, a nowy model 3D nie pasowałby do poprzedniego.
PROMPT_SUFFIX = (". Keep everything else exactly the same: the same subject, pose, proportions, colors, art style and camera "
                 "view, on the same plain white background, the whole subject fully visible.")
STEPS = 28
GUIDANCE = 2.5
MAX_SIDE = 1024
# T-poza postaci (zgłoszenie użytkownika 29.09.2026: FLUX.1-schnell z promptu daje zgięte łokcie i dłonie w górę): zamiast
# promptu – REFERENCJA: szary manekin w T-pozie narysowany programowo, a Kontext „przebiera” go w opisaną postać.
# Sprawdzone: rycerz, elf – ramiona proste, poziomo; 16 kroków wystarcza (81 s na RTX 5070, 28 kroków = 144 s).
TPOSE_STEPS = 16
TPOSE_SIZE = (832, 1216)
# instrukcja „zachowaj wszystko” bywała za ostrożna (elf, seed 5: prawie nietknięty manekin) – opis postaci na początku,
# poza jako warunek, guidance 3.0 (sprawdzone 29.09.2026: 4 warianty × T-poza OK, ta daje najlepsze proporcje)
TPOSE_INSTRUCTION = ("A detailed, colorful {prompt} standing in exactly this T-pose (arms straight out horizontally, palms "
                     "down, legs straight, same proportions and framing), game character concept art, front view, plain "
                     "white background")
TPOSE_GUIDANCE = 3.0
STRAIGHTEN_INSTRUCTION = ("Straighten both arms into a standard T-pose: both arms perfectly horizontal at shoulder height, "
                          "elbows fully straight, palms facing down, fingers pointing sideways")

status = {
    "installed": False, "installing": False, "progress": 0.0, "current": None, "error": None,
    "generating": False, "stage": "idle", "started": None, "loaded": False,
}
_lock = threading.Lock()
_pipe = None


def _hub_present(repo: str, filename: str) -> bool:
    d = CACHE / f"models--{repo.replace('/', '--')}" / "snapshots"
    return d.is_dir() and any(d.glob(f"*/{filename}"))


def installed() -> bool:
    import text2image
    ok = _hub_present(*TRANSFORMER[:2]) and _hub_present(BASE_REPO, "model_index.json") and text2image.installed()
    status["installed"] = ok
    if ok and not INSTALLED_FLAG.is_file():
        try:
            DIR.mkdir(parents=True, exist_ok=True)
            INSTALLED_FLAG.write_text(json.dumps({"installed": time.strftime("%Y-%m-%d"), "transformer": TRANSFORMER[1]}),
                                      encoding="utf-8")
        except OSError:
            pass
    return ok


def summary() -> dict:
    import text2image
    installed()
    # gdy S8 nie jest zainstalowane, instalacja pobiera też jego składniki (T5, CLIP, VAE) – pokazujemy pełny rozmiar
    extra = 0 if text2image.installed() else text2image.TOTAL_MB
    return {**status, "sizeMb": TOTAL_MB + extra}


def _size_of_downloads() -> int:
    total = 0
    for p in CACHE.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


def _install():
    import text2image
    text2image._trust_windows_certificates()
    os.environ.pop("HF_HUB_OFFLINE", None)
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
    from huggingface_hub import hf_hub_download, snapshot_download
    CACHE.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    need_base = not text2image.installed()
    total_mb = TOTAL_MB + (text2image.TOTAL_MB if need_base else 0)

    def watch():
        while not stop.wait(1.0):
            done = _size_of_downloads() + (text2image._size_of_downloads() if need_base else 0)
            status["progress"] = min(0.99, done / (total_mb * 1024 * 1024))

    threading.Thread(target=watch, daemon=True).start()
    try:
        if need_base:
            status["current"] = tr("składniki wspólne z „Tekst → obraz” (10,6 GB)")
            text2image.download_all()
        status["current"] = tr("edycja: FLUX.1 Kontext (6,8 GB)")
        hf_hub_download(TRANSFORMER[0], TRANSFORMER[1], cache_dir=CACHE)
        status["current"] = tr("konfiguracja pipeline'u")
        snapshot_download(BASE_REPO, cache_dir=CACHE, allow_patterns=BASE_PATTERNS)
        if not installed():
            raise RuntimeError(tr("po pobraniu brakuje plików modelu"))
        DIR.mkdir(parents=True, exist_ok=True)
        INSTALLED_FLAG.write_text(json.dumps({"installed": time.strftime("%Y-%m-%d"), "transformer": TRANSFORMER[1]}),
                                  encoding="utf-8")
        status["progress"] = 1.0
    except Exception as exc:  # noqa: BLE001
        status["error"] = tr("Nie udało się pobrać modelu: {exc}", exc=exc)
        print(f"[imageedit] {status['error']}", flush=True)
    finally:
        stop.set()
        status.update(installing=False, current=None)
        import models_setup
        models_setup.enable_offline_if_ready()


def install_in_background():
    if status["installing"] or installed():
        return
    status.update(installing=True, progress=0.0, error=None)
    threading.Thread(target=_install, daemon=True).start()


def _set_stage(stage: str):
    status["stage"] = stage
    print(f"[imageedit] {stage}", flush=True)


def _load():
    global _pipe
    if _pipe is not None:
        return _pipe
    import text2image
    import torch
    from diffusers import (AutoencoderKL, FlowMatchEulerDiscreteScheduler, FluxKontextPipeline, FluxTransformer2DModel,
                           GGUFQuantizationConfig)
    from huggingface_hub import hf_hub_download, snapshot_download
    from transformers import CLIPTextModel, CLIPTokenizer, T5TokenizerFast

    _set_stage(tr("Wczytywanie modelu edycji (pierwszy raz trwa dłużej)…"))
    kbase = snapshot_download(BASE_REPO, cache_dir=CACHE, allow_patterns=BASE_PATTERNS, local_files_only=True)
    sbase = text2image.get_base()   # CLIP, VAE, tokenizery FLUX są wspólne dla schnell/dev/Kontext
    tf_path = hf_hub_download(TRANSFORMER[0], TRANSFORMER[1], cache_dir=CACHE, local_files_only=True)
    dt = torch.bfloat16
    transformer = FluxTransformer2DModel.from_single_file(
        tf_path, quantization_config=GGUFQuantizationConfig(compute_dtype=dt), config=kbase, subfolder="transformer",
        torch_dtype=dt)
    pipe = FluxKontextPipeline(
        scheduler=FlowMatchEulerDiscreteScheduler.from_pretrained(kbase, subfolder="scheduler"),
        vae=AutoencoderKL.from_pretrained(sbase, subfolder="vae", torch_dtype=dt),
        text_encoder=CLIPTextModel.from_pretrained(sbase, subfolder="text_encoder", torch_dtype=dt),
        tokenizer=CLIPTokenizer.from_pretrained(sbase, subfolder="tokenizer"),
        text_encoder_2=text2image.get_t5(),   # jeden T5 (9,5 GB RAM) dla obu funkcji
        tokenizer_2=T5TokenizerFast.from_pretrained(sbase, subfolder="tokenizer_2"),
        transformer=transformer,
    )
    pipe.set_progress_bar_config(disable=True)
    pipe.enable_model_cpu_offload()
    _pipe = pipe
    status["loaded"] = True
    return pipe


def unload():
    global _pipe
    with _lock:
        if _pipe is None:
            return
        _pipe = None
        status["loaded"] = False
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        print("[imageedit] model zwolniony", flush=True)


IDLE_UNLOAD_S = 15 * 60
_idle_timer: threading.Timer | None = None


def _schedule_idle_unload():
    global _idle_timer
    if _idle_timer:
        _idle_timer.cancel()
    _idle_timer = threading.Timer(IDLE_UNLOAD_S, unload)
    _idle_timer.daemon = True
    _idle_timer.start()


def _fit(image: Image.Image) -> Image.Image:
    """Dłuższy bok ≤ MAX_SIDE, boki wielokrotnością 16 (wymóg VAE/pakowania latentów FLUX)."""
    w, h = image.size
    s = min(1.0, MAX_SIDE / max(w, h))
    w, h = max(16, int(w * s) // 16 * 16), max(16, int(h * s) // 16 * 16)
    return image.resize((w, h), Image.LANCZOS)


def tpose_mannequin(size: tuple[int, int] = TPOSE_SIZE) -> Image.Image:
    """Szary manekin w T-pozie (głowa, tułów, poziome ramiona, nogi) – referencja pozy dla Kontext."""
    from PIL import ImageDraw
    w, h = size
    m = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(m)
    g = (150, 150, 150)
    cx, k = w // 2, h / 1216   # proporcje ~7,5 głowy (eksperyment 832×1216; szerszy manekin dawał krępe postacie)
    d.ellipse([cx - 58 * k, 150 * k, cx + 58 * k, 266 * k], fill=g)                    # głowa
    d.rounded_rectangle([cx - 78 * k, 276 * k, cx + 78 * k, 630 * k], 40 * k, fill=g)   # tułów
    d.rounded_rectangle([cx - 400 * k, 296 * k, cx + 400 * k, 360 * k], 32 * k, fill=g) # ramiona poziomo (T)
    d.rounded_rectangle([cx - 76 * k, 630 * k, cx - 14 * k, 1090 * k], 28 * k, fill=g)  # noga L
    d.rounded_rectangle([cx + 14 * k, 630 * k, cx + 76 * k, 1090 * k], 28 * k, fill=g)  # noga P
    return m


def tpose_character(prompt: str, seed: int | None = None) -> Image.Image:
    """Opis postaci → obraz w dokładnej T-pozie (manekin + Kontext). Używane przez /api/text2image dla rodzaju „postać”."""
    prompt = prompt.strip()
    if not prompt:
        raise ValueError(tr("Wpisz, co ma przedstawiać obraz."))
    return generate(tpose_mannequin(), TPOSE_INSTRUCTION.format(prompt=prompt), seed, steps=TPOSE_STEPS, raw=True,
                    guidance=TPOSE_GUIDANCE)


def straighten_arms(image: Image.Image, seed: int | None = None) -> Image.Image:
    """Zdjęcie/obraz postaci → ta sama postać z rękami wyprostowanymi do T-pozy."""
    return generate(image, STRAIGHTEN_INSTRUCTION, seed, steps=TPOSE_STEPS)


def generate(image: Image.Image, prompt: str, seed: int | None = None, steps: int = STEPS, raw: bool = False,
             guidance: float = GUIDANCE) -> Image.Image:
    """Obraz (RGB, obiekt na białym tle) + polecenie → zmieniony obraz RGB tej samej wielkości (w przybliżeniu).
    raw=True: polecenie bez PROMPT_SUFFIX (gotowa instrukcja, np. T-poza z manekina)."""
    import torch
    import multiview
    import reconstruct

    prompt = prompt.strip()
    if not prompt:
        raise ValueError(tr("Napisz, co zmienić na obrazie."))
    if not installed():
        raise RuntimeError(tr("Model edycji obrazu nie jest zainstalowany."))
    with _lock:
        status.update(generating=True, started=time.time(), error=None)
        try:
            reconstruct.unload()
            multiview.unload()
            pipe = _load()
            _set_stage(tr("Edycja obrazu…"))
            src = _fit(image.convert("RGB"))
            gen = torch.Generator("cpu").manual_seed(seed if seed is not None else int(time.time()) % 2**31)
            out = pipe(image=src, prompt=prompt if raw else prompt + PROMPT_SUFFIX, guidance_scale=guidance,
                       num_inference_steps=steps, width=src.width, height=src.height, generator=gen).images[0]
            _set_stage("idle")
            return out.convert("RGB")
        except Exception as exc:
            status["error"] = str(exc)
            _set_stage("idle")
            raise
        finally:
            status["generating"] = False
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            _schedule_idle_unload()
