# S8: tekst → obraz (FLUX.1-schnell, Apache-2.0) – obraz obiektu na jednolitym tle, który dalej przechodzi zwykłą
# drogę: usunięcie tła → model 3D → sprite'y. Funkcja zaawansowana (bramka w capabilities.py): instalowana na żądanie
# z okna „Sprzęt i zaawansowane AI”, modele trzymane osobno w paths.FEATURE_MODELS/text2image (ok. 11 GB).
#
# Wersja skwantyzowana, żeby zmieścić się w 12 GB VRAM (RTX 5070):
#   - transformer FLUX.1-schnell w GGUF Q4_K_S (6,8 GB; city96/FLUX.1-schnell-gguf) – diffusers dekwantyzuje w locie,
#   - koder tekstu T5-XXL w GGUF Q5_K_S (3,3 GB; city96/t5-v1_1-xxl-encoder-gguf) – transformers dekwantyzuje do bf16
#     przy wczytaniu (ok. 9,5 GB RAM), koder działa na karcie tylko w trakcie kodowania tekstu (cpu offload),
#   - CLIP-L, VAE, tokenizery, scheduler z lustra unsloth/FLUX.1-schnell (ok. 0,5 GB).
# Model 3D (TripoSR) jest na czas generowania zwalniany z karty (reconstruct.unload()) i wczyta się ponownie przy
# następnym generowaniu 3D.
import json
import os
import threading
import time
from pathlib import Path

from PIL import Image

import paths
from i18n import tr

FEATURE = "text2image"
DIR = paths.FEATURE_MODELS / FEATURE
CACHE = DIR / "hf"
INSTALLED_FLAG = DIR / "installed.json"

# Oryginalne repozytorium black-forest-labs/FLUX.1-schnell jest „gated” (wymaga konta HF) – program ma działać bez kont,
# więc składniki bierzemy z publicznego lustra w formacie diffusers (Apache-2.0, te same pliki).
BASE_REPO = "unsloth/FLUX.1-schnell"
BASE_PATTERNS = ["model_index.json", "scheduler/*", "text_encoder/*", "tokenizer/*", "tokenizer_2/*", "vae/*",
                 "transformer/config.json", "text_encoder_2/config.json"]
TRANSFORMER = ("city96/FLUX.1-schnell-gguf", "flux1-schnell-Q4_K_S.gguf", 6780)
T5 = ("city96/t5-v1_1-xxl-encoder-gguf", "t5-v1_1-xxl-encoder-Q5_K_S.gguf", 3290)
TOTAL_MB = TRANSFORMER[2] + T5[2] + 500

# Dopisek do opisu użytkownika zależny od RODZAJU obiektu (wybór w zakładce Źródło): obiekt w całości, na jednolitym
# tle – tak, żeby usuwanie tła i model 3D miały łatwo. Postać: T-poza, cała sylwetka ze stopami (potrzebna do szkieletu
# i animacji), format PIONOWY – w kwadracie nogi często były ucięte. Budynek/przedmiot: widok trzy czwarte (lepszy tył).
COMMON_SUFFIX = ", isolated on a plain white background, nothing else in the frame, soft even lighting, game asset concept art, high detail"
KINDS = {
    "character": {
        # standardowa T-poza z gier: ramiona PROSTE na wysokość barków, dłonie płasko w dół – bez zgiętych łokci i uniesionych
        # dłoni (zgłoszenie użytkownika 29.09.2026); najważniejsze na początku, bo CLIP czyta tylko pierwsze 77 tokenów
        "prefix": "game character reference sheet, standard T-pose: standing upright, both arms stretched straight out horizontally to the left and to the right in line with the shoulders, elbows locked straight, palms facing down, fingers together pointing sideways, legs straight and slightly apart, feet flat on the ground, ",
        "suffix": ", full body from the top of the head to the soles of the feet with empty space above the head and below the feet, front view, facing the camera, symmetrical, neutral expression" + COMMON_SUFFIX,
        "size": (832, 1216),
    },
    "creature": {
        "prefix": "full body ",
        "suffix": ", the whole animal is visible including all legs, feet and tail, standing naturally, three-quarter view from the front, centered with empty space around it" + COMMON_SUFFIX,
        "size": (1024, 1024),
    },
    "building": {
        "prefix": "",
        "suffix": ", the whole building is visible from the ground to the roof, three-quarter view from a front corner, slightly elevated camera, centered with empty space around it, no surrounding objects" + COMMON_SUFFIX,
        "size": (1152, 896),
    },
    "object": {
        "prefix": "",
        "suffix": ", the whole object is visible, three-quarter view, centered with empty space around it" + COMMON_SUFFIX,
        "size": (1024, 1024),
    },
}
PROMPT_SUFFIX = KINDS["object"]["suffix"]   # zgodność: wywołania bez rodzaju


def build_prompt(prompt: str, kind: str) -> tuple[str, int, int]:
    """Pełny prompt i rozmiar obrazu dla rodzaju obiektu (nieznany rodzaj = przedmiot)."""
    k = KINDS.get(kind) or KINDS["object"]
    w, h = k["size"]
    return k["prefix"] + prompt + k["suffix"], w, h

status = {
    "installed": False, "installing": False, "progress": 0.0, "current": None, "error": None,
    "generating": False, "stage": "idle", "started": None, "loaded": False,
}
_lock = threading.Lock()
_pipe = None
_t5 = None   # koder T5 (bf16, 9,5 GB RAM) – wspólny dla S8 i S11 (imageedit), patrz get_t5()


def _trust_windows_certificates():
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        pass


def _hub_present(repo: str, filename: str) -> bool:
    d = CACHE / f"models--{repo.replace('/', '--')}" / "snapshots"
    return d.is_dir() and any(d.glob(f"*/{filename}"))


def installed() -> bool:
    ok = _hub_present(*TRANSFORMER[:2]) and _hub_present(*T5[:2]) and _hub_present(BASE_REPO, "vae/config.json")
    status["installed"] = ok
    if ok and not INSTALLED_FLAG.is_file():   # znacznik dla capabilities.features() (np. pliki skopiowane ręcznie)
        try:
            DIR.mkdir(parents=True, exist_ok=True)
            INSTALLED_FLAG.write_text(json.dumps({"installed": time.strftime("%Y-%m-%d"), "transformer": TRANSFORMER[1],
                                                  "t5": T5[1]}), encoding="utf-8")
        except OSError:
            pass
    return ok


def summary() -> dict:
    installed()
    return {**status, "sizeMb": TOTAL_MB}


def _size_of_downloads() -> int:
    """Bajty już pobrane w pamięci podręcznej funkcji (także pliki częściowe *.incomplete) – do paska postępu."""
    total = 0
    for p in CACHE.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


def download_all():
    """Pobranie wszystkich plików S8 (także z instalacji S11, gdy S8 brakuje). Wyjątek = błąd pobierania."""
    _trust_windows_certificates()
    os.environ.pop("HF_HUB_OFFLINE", None)
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
    from huggingface_hub import hf_hub_download, snapshot_download
    CACHE.mkdir(parents=True, exist_ok=True)
    status["current"] = tr("obraz: FLUX.1-schnell (6,8 GB)")
    hf_hub_download(TRANSFORMER[0], TRANSFORMER[1], cache_dir=CACHE)
    status["current"] = tr("tekst: koder T5 (3,3 GB)")
    hf_hub_download(T5[0], T5[1], cache_dir=CACHE)
    status["current"] = tr("pozostałe składniki (0,5 GB)")
    snapshot_download(BASE_REPO, cache_dir=CACHE, allow_patterns=BASE_PATTERNS)
    if not installed():
        raise RuntimeError(tr("po pobraniu brakuje plików modelu"))
    DIR.mkdir(parents=True, exist_ok=True)
    INSTALLED_FLAG.write_text(json.dumps({"installed": time.strftime("%Y-%m-%d"), "transformer": TRANSFORMER[1],
                                          "t5": T5[1]}), encoding="utf-8")


def _install():
    stop = threading.Event()

    def watch():
        while not stop.wait(1.0):
            status["progress"] = min(0.99, _size_of_downloads() / (TOTAL_MB * 1024 * 1024))

    threading.Thread(target=watch, daemon=True).start()
    try:
        download_all()
        status["progress"] = 1.0
    except Exception as exc:  # noqa: BLE001
        status["error"] = tr("Nie udało się pobrać modelu: {exc}", exc=exc)
        print(f"[text2image] {status['error']}", flush=True)
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
    print(f"[text2image] {stage}", flush=True)


def get_base() -> str:
    """Folder składników bazowych FLUX (CLIP, VAE, tokenizery, scheduler) w cache – wspólne dla S8 i S11."""
    from huggingface_hub import snapshot_download
    return snapshot_download(BASE_REPO, cache_dir=CACHE, allow_patterns=BASE_PATTERNS, local_files_only=True)


def get_t5():
    """Koder T5-XXL z GGUF (dekwantyzowany do bf16, ~9,5 GB RAM, 81 s) – jeden egzemplarz dla S8 i S11."""
    global _t5
    if _t5 is None:
        import torch
        from transformers import T5EncoderModel
        _t5 = T5EncoderModel.from_pretrained(T5[0], gguf_file=T5[1], cache_dir=CACHE, torch_dtype=torch.bfloat16,
                                             local_files_only=True)
    return _t5


def _load():
    global _pipe
    if _pipe is not None:
        return _pipe
    import torch
    from diffusers import FluxPipeline, FluxTransformer2DModel, GGUFQuantizationConfig
    from huggingface_hub import hf_hub_download

    _set_stage(tr("Wczytywanie modelu obrazu (pierwszy raz trwa dłużej)…"))
    base = get_base()
    tf_path = hf_hub_download(TRANSFORMER[0], TRANSFORMER[1], cache_dir=CACHE, local_files_only=True)
    transformer = FluxTransformer2DModel.from_single_file(
        tf_path, quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
        config=base, subfolder="transformer", torch_dtype=torch.bfloat16)
    pipe = FluxPipeline.from_pretrained(base, transformer=transformer, text_encoder_2=get_t5(), torch_dtype=torch.bfloat16)
    pipe.set_progress_bar_config(disable=True)
    pipe.enable_model_cpu_offload()   # każdy składnik na karcie tylko wtedy, gdy pracuje – mieści się w 12 GB
    _pipe = pipe
    status["loaded"] = True
    return pipe


def unload():
    """Zwolnienie pamięci (RAM ~17 GB i karta) – np. gdy użytkownik długo nie generuje albo przed pracą innej funkcji.
    T5 jest wspólny z S11 – znika z RAM dopiero, gdy żaden pipeline go nie trzyma (imageedit.unload() też)."""
    global _pipe, _t5
    with _lock:
        if _pipe is None and _t5 is None:
            return
        _pipe = None
        _t5 = None
        status["loaded"] = False
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        print("[text2image] model zwolniony", flush=True)


IDLE_UNLOAD_S = 15 * 60   # po kwadransie bez generowania zwalniamy ~17 GB RAM (T5 bf16 + transformer)
_idle_timer: threading.Timer | None = None


def _schedule_idle_unload():
    global _idle_timer
    if _idle_timer:
        _idle_timer.cancel()
    _idle_timer = threading.Timer(IDLE_UNLOAD_S, unload)
    _idle_timer.daemon = True
    _idle_timer.start()


def generate(prompt: str, seed: int | None = None, size: int = 0, steps: int = 4, kind: str = "object") -> Image.Image:
    """Opis → obraz RGB. Rozmiar i dopisek do promptu zależą od rodzaju obiektu (KINDS); `size` > 0 wymusza kwadrat.
    Model 3D schodzi z karty na czas pracy."""
    import torch
    import reconstruct

    prompt = prompt.strip()
    if not prompt:
        raise ValueError(tr("Wpisz, co ma przedstawiać obraz."))
    if not installed():
        raise RuntimeError(tr("Model tekst → obraz nie jest zainstalowany."))
    full, width, height = build_prompt(prompt, kind)
    if size:
        width = height = max(512, min(1280, (size // 64) * 64))
    with _lock:
        status.update(generating=True, started=time.time(), error=None)
        try:
            reconstruct.unload()
            pipe = _load()
            _set_stage(tr("Generowanie obrazu…"))
            gen = torch.Generator("cpu").manual_seed(seed if seed is not None else int(time.time()) % 2**31)
            image = pipe(full, num_inference_steps=steps, guidance_scale=0.0, width=width, height=height,
                         generator=gen).images[0]
            _set_stage("idle")
            return image.convert("RGB")
        except Exception as exc:
            status["error"] = str(exc)
            _set_stage("idle")
            raise
        finally:
            status["generating"] = False
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            _schedule_idle_unload()
