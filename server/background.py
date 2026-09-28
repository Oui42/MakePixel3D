# Usuwanie tła ze zdjęcia (rembg).
# Zwracamy CAŁE zdjęcie z maską w kanale alfa (kolory tła zostają nietknięte) – dzięki temu w przeglądarce
# można ręcznie przywrócić fragment, który AI usunęło przez pomyłkę. Przycięcie do obiektu robi przeglądarka.
import threading

import numpy as np
from PIL import Image, ImageOps

MAX_SIDE = 1280          # większe zdjęcia zmniejszamy – szybciej, a jakość i tak wystarcza
ALPHA_NOISE = 16         # alfa poniżej tej wartości traktujemy jako tło (szum po rembg)
DEFAULT_MODEL = "isnet-general-use"

_sessions = {}
_lock = threading.Lock()


def _session(model_name: str):
    with _lock:
        if model_name not in _sessions:
            from rembg import new_session
            _sessions[model_name] = new_session(model_name)
        return _sessions[model_name]


def preload():
    """Wczytanie modelu usuwania tła przy starcie (ekran ładowania) – pierwsze zdjęcie jest wtedy szybkie."""
    _session(DEFAULT_MODEL)


def prepare(image: Image.Image) -> Image.Image:
    """Obrót wg EXIF (zdjęcia z telefonu) + zmniejszenie."""
    image = ImageOps.exif_transpose(image)
    image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    return image


def has_transparency(image: Image.Image) -> bool:
    return image.mode == "RGBA" and image.getextrema()[3][0] < 255


def with_ai_mask(image: Image.Image, model_name: str = DEFAULT_MODEL) -> Image.Image:
    """Oryginalne kolory + maska obiektu od AI jako kanał alfa."""
    from rembg import remove
    rgb = image.convert("RGB")
    mask = remove(rgb, session=_session(model_name), only_mask=True).convert("L")
    out = rgb.convert("RGBA")
    out.putalpha(mask)
    return out


def clean_alpha(image: Image.Image) -> Image.Image:
    """Czyści szum alfy; błąd, gdy na zdjęciu nie został żaden obiekt."""
    arr = np.array(image.convert("RGBA"))
    alpha = arr[..., 3]
    alpha[alpha < ALPHA_NOISE] = 0
    if not alpha.any():
        from i18n import tr
        raise ValueError(tr("Nie znaleziono obiektu na zdjęciu (całe tło zostało usunięte)."))
    return Image.fromarray(arr, "RGBA")
