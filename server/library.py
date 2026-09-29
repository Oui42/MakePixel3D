# Galeria / historia: każdy wygenerowany model zapisujemy w folderze library/ (per komputer, jak folder models/).
# Wpis = podfolder <id>/ z plikami: source.png (całe zdjęcie z maską tła w kanale alfa – do ponownej edycji maski),
# model.glb, thumb.png (miniatura obiektu) i meta.json (nazwa, data, jakość, czas, urządzenie).
import io
import json
import re
import shutil
import time
import uuid
from pathlib import Path

from PIL import Image

from paths import LIBRARY as ROOT  # noqa: E402 – folder danych (patrz paths.py)
# project.json – zapisany stan pracy (ustawienia, obrót modelu, poprawki pikseli); powstaje przy „Zapisz w galerii”
FILES = {"source.png": "image/png", "model.glb": "model/gltf-binary", "thumb.png": "image/png",
         "project.json": "application/json",
         "rigged.glb": "model/gltf-binary"}   # S10: model ze szkieletem i wagami skórowania (UniRig)
_ID = re.compile(r"^[0-9a-f]{32}$")
THUMB = 192


def _dir(entry_id: str) -> Path:
    if not _ID.match(entry_id):
        raise KeyError(entry_id)
    d = ROOT / entry_id
    if not d.is_dir():
        raise KeyError(entry_id)
    return d


def add(name: str, source_png: bytes | None, cutout: Image.Image | None, glb: bytes, meta: dict,
        thumb_png: bytes | None = None) -> str:
    """Nowy wpis. Miniatura: podana (np. pixel-art z przeglądarki) albo zmniejszony obiekt ze zdjęcia."""
    entry_id = uuid.uuid4().hex
    d = ROOT / entry_id
    d.mkdir(parents=True)
    (d / "model.glb").write_bytes(glb)
    if source_png:
        (d / "source.png").write_bytes(source_png)
    elif cutout is not None:
        cutout.save(d / "source.png")
    if thumb_png:
        (d / "thumb.png").write_bytes(thumb_png)
    elif cutout is not None:
        thumb = cutout.convert("RGBA").copy()
        thumb.thumbnail((THUMB, THUMB), Image.LANCZOS)
        thumb.save(d / "thumb.png")
    info = {"id": entry_id, "name": name or "bez nazwy", "created": time.time(), **meta}
    _write_meta(d, info)
    return entry_id


def _write_meta(d: Path, info: dict) -> None:
    (d / "meta.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")


def save_project(entry_id: str, project_json: bytes, source_png: bytes | None, thumb_png: bytes | None,
                 model_glb: bytes | None = None, model_name: str = "model.glb") -> dict:
    """„Zapisz w galerii”: stan pracy + (opcjonalnie) poprawione zdjęcie, miniatura z aktualnym pixel-artem
    i model z przemalowanymi kolorami (S11; nadpisuje ten plik GLB, który był otwarty)."""
    d = _dir(entry_id)
    json.loads(project_json)   # tylko poprawny JSON – uszkodzony zapis nie może nadpisać dobrego
    (d / "project.json").write_bytes(project_json)
    if model_glb and model_name in FILES:
        (d / model_name).write_bytes(model_glb)
    if source_png:
        (d / "source.png").write_bytes(source_png)
    if thumb_png:
        (d / "thumb.png").write_bytes(thumb_png)
    info = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    info["updated"] = time.time()
    info["hasProject"] = True
    _write_meta(d, info)
    return info


def list_entries() -> list[dict]:
    if not ROOT.is_dir():
        return []
    out = []
    for meta in ROOT.glob("*/meta.json"):
        try:
            out.append(json.loads(meta.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue  # uszkodzony wpis pomijamy, reszta galerii działa
    return sorted(out, key=lambda m: m.get("created", 0), reverse=True)


def save_rigged(entry_id: str, glb: bytes, humanoid: bool) -> dict:
    """S10: model ze szkieletem (UniRig) obok model.glb; meta dostaje `rigged` i `humanoid`."""
    d = _dir(entry_id)
    (d / "rigged.glb").write_bytes(glb)
    info = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    info["rigged"] = True
    info["humanoid"] = bool(humanoid)
    info["updated"] = time.time()
    _write_meta(d, info)
    return info


def file_path(entry_id: str, name: str) -> Path:
    if name not in FILES:
        raise KeyError(name)
    p = _dir(entry_id) / name
    if not p.is_file():
        raise KeyError(name)
    return p


def rename(entry_id: str, name: str) -> dict:
    meta_path = _dir(entry_id) / "meta.json"
    info = json.loads(meta_path.read_text(encoding="utf-8"))
    info["name"] = name.strip()[:80] or info["name"]
    _write_meta(meta_path.parent, info)
    return info


def delete(entry_id: str) -> None:
    shutil.rmtree(_dir(entry_id))
