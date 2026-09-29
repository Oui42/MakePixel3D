# MakePixel3D – serwer lokalny: usuwanie tła + model 3D (AI), a interfejs to strona w web/.
# Uruchomienie: start.bat  (albo: .venv\Scripts\python server\app.py)
import io
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
sys.path.insert(0, str(ROOT))
import paths  # noqa: E402 – foldery programu/danych (Program Files → dane w %LOCALAPPDATA%\MakePixel3D)

# Modele AI trzymamy obok programu (models/), a nie w profilu użytkownika na C:
os.environ.setdefault("HF_HOME", str(paths.MODELS / "huggingface"))
os.environ.setdefault("U2NET_HOME", str(paths.MODELS / "rembg"))
os.environ.setdefault("NUMBA_CACHE_DIR", str(paths.CACHE / "numba"))   # patrz paths.CACHE
# diffusers zapisuje kod własnych pipeline'ów (Zero123++, S9) do HF_MODULES_CACHE (domyślnie HF_HOME/modules) –
# w Program Files to „Odmowa dostępu” → folder zapisywalny
os.environ.setdefault("HF_MODULES_CACHE", str(paths.CACHE / "hf_modules"))
                             # zamiennik torchmcubes
sys.path.insert(0, str(ROOT / "third_party" / "TripoSR"))  # pakiet tsr

import models_setup  # noqa: E402

# komplet modeli na dysku → bez prób łączenia z internetem (start i praca offline bez opóźnień)
models_setup.enable_offline_if_ready()

import anyio  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from PIL import Image, UnidentifiedImageError  # noqa: E402

import background  # noqa: E402
import capabilities  # noqa: E402
import library  # noqa: E402
import multiview  # noqa: E402
import reconstruct  # noqa: E402
import rigging  # noqa: E402
import settings  # noqa: E402
import text2image  # noqa: E402
import updater  # noqa: E402
from i18n import tr  # noqa: E402

HOST, PORT = "127.0.0.1", int(os.environ.get("MAKEPIXEL3D_PORT") or os.environ.get("PIXELFORGE_PORT") or "7860")

app = FastAPI(title="MakePixel3D")


@app.middleware("http")
async def no_cache_for_ui(request, call_next):
    """Pliki interfejsu zawsze sprawdzane na nowo – inaczej po aktualizacji przeglądarka
    potrafi połączyć nowy index.html ze starym app.js z pamięci podręcznej."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/") or request.url.path.startswith("/api/library/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


async def _read_image(file: UploadFile) -> Image.Image:
    try:
        return Image.open(io.BytesIO(await file.read()))
    except UnidentifiedImageError:
        raise HTTPException(400, tr("Nieobsługiwany format pliku – wybierz zdjęcie (JPG, PNG, WEBP)."))


def _png(image: Image.Image) -> Response:
    buf = io.BytesIO()
    image.save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png")


@app.get("/api/status")
def api_status():
    st = reconstruct.status
    if multiview.status["generating"]:   # S9: silnik InstantMesh ma własne etapy
        st = multiview.status
    if rigging.status["generating"]:     # S10: szkielet (UniRig)
        st = rigging.status
    elapsed = time.time() - st["started"] if st["started"] and st["stage"] != "idle" else 0
    dev, dev_name = reconstruct.device_if_ready()   # None, dopóki PyTorch wczytuje się w tle
    return {
        "device": dev,
        "deviceName": dev_name,
        "version": updater.status["current"],
        "stage": st["stage"],
        "elapsed": round(elapsed, 1),
        "error": st["error"],
    }


# ---------- Wersja, aktualizacje, sprzęt ----------
@app.get("/api/update")
def api_update():
    return updater.status


@app.post("/api/update/check")
async def api_update_check():
    return await anyio.to_thread.run_sync(updater.check)


@app.post("/api/update/download")
def api_update_download():
    return updater.download()


@app.post("/api/update/restart")
def api_update_restart():
    """Okno programu po zamknięciu kończy się kodem 3, a start.bat uruchamia program ponownie
    (launch.py instaluje wtedy pobraną aktualizację). W przeglądarce trzeba zrobić to ręcznie."""
    updater.request_restart()
    import threading
    threading.Timer(0.5, _close_window).start()
    return {"ok": True, "desktop": _desktop_window() is not None}


def _desktop_window():
    try:
        import webview
        return webview.windows[0] if webview.windows else None
    except ImportError:
        return None


def _close_window():
    win = _desktop_window()
    if win:
        win.destroy()


# ---------- Modele AI (pobierane raz – przy instalacji albo z paska w programie) ----------
@app.get("/api/models")
def api_models():
    s = models_setup.summary()
    for m in s["missing"]:
        m["name"] = tr(m["name"])
    return s


@app.post("/api/models/download")
def api_models_download():
    models_setup.download_in_background()
    return models_setup.summary()


# ---------- Ustawienia programu (zębatka) ----------
@app.get("/api/settings")
def api_settings():
    return {**settings.get(), "downloadsDir": settings.downloads_dir(), "desktop": _desktop_window() is not None}


@app.put("/api/settings")
async def api_settings_update(request: Request):
    try:
        data = settings.update(await request.json())
    except ValueError as exc:
        key = str(exc)
        raise HTTPException(400, tr("Folder nie istnieje albo nie można w nim zapisywać.") if key == "exportDir"
                            else tr("Nieprawidłowe ustawienie: {key}", key=key))
    return {**data, "downloadsDir": settings.downloads_dir(), "desktop": _desktop_window() is not None}


@app.post("/api/settings/pick-folder")
def api_pick_folder():
    """Systemowe okno wyboru folderu (tylko w oknie programu; w przeglądarce ścieżkę wpisuje się ręcznie)."""
    win = _desktop_window()
    if not win:
        return {"supported": False}
    import webview
    start = settings.get()["exportDir"] or settings.downloads_dir()
    picked = win.create_file_dialog(webview.FileDialog.FOLDER, directory=start)
    return {"supported": True, "path": picked[0] if picked else None}


@app.post("/api/settings/open-folder")
def api_open_folder():
    folder = settings.get()["exportDir"] or settings.downloads_dir()
    os.startfile(folder)  # noqa: S606 – folder wybrany przez użytkownika albo Pobrane
    return {"ok": True}


@app.post("/api/export")
async def api_export(file: UploadFile = File(...), name: str = Form(...)):
    """Zapis eksportu (PNG, GIF, GLB) do folderu wybranego w ustawieniach. Nazwa zajęta → dopisujemy _2, _3…"""
    folder = settings.get()["exportDir"]
    if not folder or not Path(folder).is_dir():
        raise HTTPException(400, tr("Nie wybrano folderu zapisu."))
    safe = Path(name).name.strip() or "export.png"
    target = Path(folder) / safe
    n = 2
    while target.exists():
        target = Path(folder) / f"{Path(safe).stem}_{n}{Path(safe).suffix}"
        n += 1
    target.write_bytes(await file.read())
    return {"path": str(target), "name": target.name}


# ---------- S8: tekst → obraz (funkcja zaawansowana, instalowana na żądanie) ----------
@app.get("/api/text2image")
def api_text2image_status():
    feat = capabilities.features()["text2image"]
    return {**text2image.summary(), "available": feat["available"], "reasons": feat["reasons"]}


@app.post("/api/text2image/install")
def api_text2image_install():
    feat = capabilities.features()["text2image"]
    if not feat["available"]:
        raise HTTPException(409, tr("Ten komputer nie spełnia wymagań: {why}", why="; ".join(feat["reasons"])))
    text2image.install_in_background()
    return {**text2image.summary(), "available": True, "reasons": []}


@app.post("/api/text2image")
async def api_text2image(request: Request):
    """Opis słowny → obraz PNG (RGB). Dalej przeglądarka wysyła go jak zdjęcie do /api/cutout."""
    data = await request.json()
    prompt = str(data.get("prompt", ""))
    seed = data.get("seed")
    try:
        image = await anyio.to_thread.run_sync(
            text2image.generate, prompt, int(seed) if seed not in (None, "") else None, int(data.get("size") or 1024))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, tr("Błąd generowania obrazu: {exc}", exc=exc))
    return _png(image)


# ---------- S9: lepszy tył obiektu (silnik InstantMesh, instalowany na żądanie) ----------
@app.get("/api/multiview")
def api_multiview_status():
    feat = capabilities.features()["multiview"]
    return {**multiview.summary(), "available": feat["available"], "reasons": feat["reasons"]}


@app.post("/api/multiview/install")
def api_multiview_install():
    feat = capabilities.features()["multiview"]
    if not feat["available"]:
        raise HTTPException(409, tr("Ten komputer nie spełnia wymagań: {why}", why="; ".join(feat["reasons"])))
    multiview.install_in_background()
    return {**multiview.summary(), "available": True, "reasons": []}


# ---------- S10: szkielet i animacje (UniRig we własnym Pythonie 3.11, instalowany na żądanie) ----------
@app.get("/api/rigging")
def api_rigging_status():
    feat = capabilities.features()["rigging"]
    return {**rigging.summary(), "available": feat["available"], "reasons": feat["reasons"]}


@app.post("/api/rigging/install")
def api_rigging_install():
    feat = capabilities.features()["rigging"]
    if not feat["available"]:
        raise HTTPException(409, tr("Ten komputer nie spełnia wymagań: {why}", why="; ".join(feat["reasons"])))
    rigging.install_in_background()
    return {**rigging.summary(), "available": True, "reasons": []}


@app.post("/api/library/{entry_id}/rig")
async def api_library_rig(entry_id: str, humanoid: bool = Form(False)):
    """Szkielet + wagi skórowania dla modelu z galerii → rigged.glb w tym samym wpisie (zwracany też w odpowiedzi)."""
    try:
        glb = library.file_path(entry_id, "model.glb").read_bytes()
    except KeyError:
        raise HTTPException(404, tr("Nie ma takiego wpisu w galerii."))
    if not rigging.installed():
        raise HTTPException(409, tr("Funkcja „Szkielet i animacje” nie jest zainstalowana."))
    try:
        rigged, used_humanoid = await anyio.to_thread.run_sync(rigging.rig, glb, humanoid)
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        raise HTTPException(500, tr("Błąd tworzenia szkieletu: {exc}", exc=exc))
    library.save_rigged(entry_id, rigged, used_humanoid)
    # X-Rig-Fallback: proszono o szkielet postaci, ale UniRig nie dał kompletu kości VRoid – jest szkielet ogólny
    headers = {"X-Rig-Humanoid": "1" if used_humanoid else "0",
               "X-Rig-Fallback": "1" if humanoid and not used_humanoid else "0"}
    return Response(rigged, media_type="model/gltf-binary", headers=headers)


@app.get("/api/capabilities")
def api_capabilities():
    return {"hardware": capabilities.hardware(), "features": capabilities.features()}


updater.init()


@app.post("/api/cutout")
async def api_cutout(file: UploadFile = File(...), remove_bg: bool = Form(True)):
    """Zdjęcie → całe zdjęcie z maską obiektu w kanale alfa (PNG). Przycięcie robi przeglądarka."""
    image = background.prepare(await _read_image(file))
    try:
        if remove_bg or not background.has_transparency(image):
            image = await anyio.to_thread.run_sync(background.with_ai_mask, image)
        return _png(background.clean_alpha(image))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:  # noqa: BLE001 – najczęściej: brak modelu i brak internetu do jego pobrania
        if not models_setup.all_present():
            raise HTTPException(503, tr("Brakuje modeli AI, a nie udało się ich pobrać (brak internetu?). Pobierz je przyciskiem na pasku u góry okna, gdy będzie połączenie."))
        raise HTTPException(500, str(exc))


@app.post("/api/reconstruct")
async def api_reconstruct(
    file: UploadFile = File(...),                  # obiekt bez tła, przycięty – wejście modelu 3D
    source: UploadFile | None = File(None),        # całe zdjęcie z maską – zapisujemy w galerii
    resolution: int = Form(192),
    name: str = Form(""),
    engine: str = Form("triposr"),                 # triposr | instantmesh (S9 „lepszy tył obiektu”, gdy zainstalowany)
):
    """Obiekt bez tła (PNG) → model 3D (GLB). Wynik trafia też do galerii (nagłówek X-Library-Id)."""
    image = await _read_image(file)
    source_png = await source.read() if source else None
    resolution = max(64, min(320, resolution))
    t0 = time.time()
    try:
        # w wątku roboczym – serwer odpowiada w tym czasie na /api/status
        if engine == "instantmesh":
            if not multiview.installed():
                raise HTTPException(409, tr("Funkcja „Lepszy tył obiektu” nie jest zainstalowana."))
            glb, _views = await anyio.to_thread.run_sync(multiview.generate, image)
        else:
            glb = await anyio.to_thread.run_sync(reconstruct.generate, image, resolution)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()   # pełny ślad w logu (logs/makepixel3d.log) – użytkownik widzi tylko komunikat
        if not models_setup.all_present():
            raise HTTPException(503, tr("Brakuje modeli AI, a nie udało się ich pobrać (brak internetu?). Pobierz je przyciskiem na pasku u góry okna, gdy będzie połączenie."))
        raise HTTPException(500, tr("Błąd generowania 3D: {exc}", exc=exc))
    meta = {"quality": resolution, "seconds": round(time.time() - t0, 1), "device": reconstruct.device_name(),
            "engine": engine}
    try:
        entry_id = library.add(name, source_png, image, glb, meta)
    except OSError as exc:  # brak miejsca itp. – model i tak oddajemy, tylko bez zapisu w galerii
        print(f"[galeria] nie zapisano: {exc}", flush=True)
        entry_id = ""
    return Response(glb, media_type="model/gltf-binary", headers={"X-Library-Id": entry_id})


# ---------- Galeria ----------
@app.get("/api/library")
def api_library():
    return library.list_entries()


@app.get("/api/library/{entry_id}/{name}")
def api_library_file(entry_id: str, name: str):
    try:
        return FileResponse(library.file_path(entry_id, name), media_type=library.FILES[name])
    except KeyError:
        raise HTTPException(404, tr("Nie ma takiego wpisu w galerii."))


@app.post("/api/library")
async def api_library_add(
    model: UploadFile = File(...),
    source: UploadFile | None = File(None),
    thumb: UploadFile | None = File(None),
    name: str = Form(""),
):
    """Nowy wpis dla modelu, który nie powstał tutaj (np. wczytany z pliku .glb)."""
    glb = await model.read()
    source_png = await source.read() if source else None
    thumb_png = await thumb.read() if thumb else None
    entry_id = library.add(name, source_png, None, glb, {"device": "wczytany z pliku"}, thumb_png)
    return {"id": entry_id}


@app.put("/api/library/{entry_id}/project")
async def api_library_project(
    entry_id: str,
    project: UploadFile = File(...),
    source: UploadFile | None = File(None),
    thumb: UploadFile | None = File(None),
):
    """„Zapisz w galerii” – ustawienia, obrót modelu, poprawki pikseli, poprawione tło, miniatura."""
    try:
        return library.save_project(
            entry_id,
            await project.read(),
            await source.read() if source else None,
            await thumb.read() if thumb else None,
        )
    except KeyError:
        raise HTTPException(404, tr("Nie ma takiego wpisu w galerii."))
    except ValueError:
        raise HTTPException(400, tr("Uszkodzony zapis projektu."))


@app.patch("/api/library/{entry_id}")
def api_library_rename(entry_id: str, name: str = Form(...)):
    try:
        return library.rename(entry_id, name)
    except KeyError:
        raise HTTPException(404, tr("Nie ma takiego wpisu w galerii."))


@app.delete("/api/library/{entry_id}")
def api_library_delete(entry_id: str):
    try:
        library.delete(entry_id)
    except KeyError:
        raise HTTPException(404, tr("Nie ma takiego wpisu w galerii."))
    return {"ok": True}


app.mount("/", StaticFiles(directory=PROJECT / "web", html=True), name="web")


if __name__ == "__main__":
    url = f"http://{HOST}:{PORT}/"
    print(f"MakePixel3D działa: {url}", flush=True)
    reconstruct.warmup()
    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
