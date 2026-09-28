# Własne okno programu (pywebview + WebView2 wbudowany w Windows 11) zamiast karty przeglądarki.
# Start: okno pokazuje się OD RAZU z ekranem ładowania (pasek postępu + nazwa etapu). W tle kolejno:
# serwer (FastAPI) → biblioteki AI (PyTorch) i rozpoznanie karty → model usuwania tła → [opcjonalnie] model 3D.
# Dopiero potem okno przechodzi na interfejs – wszystko jest już wczytane, więc pierwsza praca jest szybka.
# Zwracany kod: 0 = zamknięte, 3 = prośba o ponowne uruchomienie (instalacja aktualizacji – obsługuje launch.py).
import ctypes
import json
import os
import socket
import threading
import time
from pathlib import Path

import webview

from i18n import tr

APP_NAME = "MakePixel3D"
HOST = "127.0.0.1"
PORT = int(os.environ.get("MAKEPIXEL3D_PORT") or os.environ.get("PIXELFORGE_PORT") or "7860")
PROJECT = Path(__file__).resolve().parent.parent
ICON = PROJECT / "assets" / "makepixel3d.ico"
RESTART_EXIT_CODE = 3

SPLASH = """<!doctype html><meta charset="utf-8"><style>
:root { color-scheme: light dark; --bg: #f4f2f7; --fg: #1d1a24; --mu: #6f6980; --ac: #7a4cff; --ac2: #ff7ac6; }
@media (prefers-color-scheme: dark) { :root { --bg: #15131b; --fg: #ece8f5; --mu: #9a93ad; --ac: #9b78ff; --ac2: #ff8fd0; } }
html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg); font: 15px 'Segoe UI', sans-serif; overflow: hidden; }
body { display: grid; place-items: center; user-select: none; }
/* Tło: dryfujące „piksele” – czysta animacja CSS, więc porusza się nawet gdy Python jest zajęty ładowaniem modeli
   (bez tego długi etap wyglądał jak zawieszenie programu – zgłoszenie użytkownika). */
#px { position: fixed; inset: 0; z-index: 0; pointer-events: none; }
#px i { position: absolute; bottom: -8vh; display: block; border-radius: 2px; opacity: 0;
        background: var(--ac); animation: rise linear infinite; }
#px i:nth-child(3n) { background: var(--ac2); }
#px i:nth-child(4n) { border-radius: 0; }
@keyframes rise { 0% { transform: translateY(0) rotate(0deg); opacity: 0; } 10% { opacity: .35; }
                  90% { opacity: .25; } 100% { transform: translateY(-115vh) rotate(90deg); opacity: 0; } }
.box { position: relative; z-index: 1; text-align: center; width: 340px; padding: 28px 24px 24px; border-radius: 16px;
       background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(6px); }
.logo { width: 56px; height: 56px; margin: 0 auto 14px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; }
.logo b { display: block; border-radius: 2px; background: var(--ac); animation: blink 2.4s ease-in-out infinite; }
.logo b:nth-child(2n) { background: var(--ac2); }
@keyframes blink { 0%, 100% { opacity: .25; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
h1 { font-size: 26px; margin: 0 0 18px; letter-spacing: .5px; }
.bar { position: relative; height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--ac) 18%, transparent); overflow: hidden; }
.bar i { display: block; width: 4%; height: 100%; background: var(--ac); border-radius: 4px; transition: width .45s ease; }
/* Błysk przesuwający się po pasku – ciągły ruch niezależnie od postępu */
.bar::after { content: ''; position: absolute; top: 0; bottom: 0; width: 40%; left: -40%;
              background: linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent); animation: shine 1.6s linear infinite; }
@keyframes shine { to { left: 100%; } }
p { color: var(--mu); margin: 12px 0 0; min-height: 1.4em; }
p::after { content: ''; display: inline-block; width: 1.2em; text-align: left; animation: dots 1.5s steps(4, end) infinite; }
@keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
</style><div id="px"></div>
<div class="box"><div class="logo"><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b></div>
<h1>MakePixel3D</h1><div class="bar"><i id="bar"></i></div><p id="msg">__MSG__</p></div>
<script>
(function () {
  var box = document.getElementById('px'), n = 36;
  for (var k = 0; k < n; k++) {
    var i = document.createElement('i'), size = 6 + Math.round(Math.random() * 18);
    i.style.left = (Math.random() * 100) + 'vw'; i.style.width = i.style.height = size + 'px';
    i.style.animationDuration = (9 + Math.random() * 14) + 's'; i.style.animationDelay = (-Math.random() * 20) + 's';
    box.appendChild(i);
  }
  for (var b = document.querySelectorAll('.logo b'), j = 0; j < b.length; j++) b[j].style.animationDelay = (-Math.random() * 2.4) + 's';
})();
function setStage(p, m) { document.getElementById('bar').style.width = p + '%'; document.getElementById('msg').textContent = m.replace(/[.…]+$/, ''); }
</script>"""


def _port_free(host: str, port: int) -> bool:
    """Próba zajęcia portu – natychmiastowa. (Próba POŁĄCZENIA z wolnym portem na Windows czeka ok. 2 s,
    bo system ponawia odrzucone połączenie – to spowalniało start programu.)"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def _message(title: str, text: str) -> str:
    return (f"<!doctype html><meta charset='utf-8'><body style='font:15px Segoe UI;padding:24px'>"
            f"<h2>{title}</h2><p>{text}</p></body>")


def _set_window_icon(window):
    """Ikona okna i paska zadań (WinForms bierze domyślnie ikonę python.exe)."""
    if not ICON.is_file():
        return
    try:
        hwnd = window.native.Handle.ToInt64()
        user32 = ctypes.windll.user32
        user32.LoadImageW.restype = ctypes.c_void_p
        for size, which in ((32, 0), (256, 1)):   # ICON_SMALL = 0, ICON_BIG = 1
            hicon = user32.LoadImageW(None, str(ICON), 1, size, size, 0x10)   # IMAGE_ICON, LR_LOADFROMFILE
            if hicon:
                user32.SendMessageW(ctypes.c_void_p(hwnd), 0x80, which, ctypes.c_void_p(hicon))   # WM_SETICON
    except Exception:  # noqa: BLE001 – brak ikony to nie powód, żeby nie uruchomić programu
        pass


def run() -> int:
    try:
        # osobna grupa na pasku zadań (z naszą ikoną), a nie „Python”
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_NAME)
    except Exception:  # noqa: BLE001
        pass

    if not _port_free(HOST, PORT):   # np. inny program zajął port 7860 (drugą kopię MakePixel3D blokuje launch.py)
        webview.create_window(APP_NAME, html=_message(
            tr("{app} już działa", app=APP_NAME),
            f"Port {PORT}: 127.0.0.1:{PORT}"), width=520, height=220)
        webview.start()
        return 1

    class Api:
        """Most JS → Python. Strona zgłasza tu, czy ma niezapisane zmiany (pywebview.api.set_dirty).
        Przy zamykaniu NIE wolno pytać strony przez evaluate_js – to blokuje wątek okna i okno się nie zamyka."""
        dirty = False

        def set_dirty(self, dirty):
            self.dirty = bool(dirty)

    api = Api()
    webview.settings["ALLOW_DOWNLOADS"] = True   # zapis PNG/GIF bez własnego folderu → folder „Pobrane”
    window = webview.create_window(
        APP_NAME, html=SPLASH.replace("__MSG__", tr("Uruchamianie…")), width=1440, height=900, min_size=(1000, 640),
        text_select=False, js_api=api, background_color="#15131b",
    )
    state = {"server": None, "restart": lambda: False, "t0": time.perf_counter()}

    def stage(percent: int, text: str):
        # czas każdego etapu w logu (logs/makepixel3d.log) – do diagnozy wolnego startu
        print(f"[start] {time.perf_counter() - state['t0']:5.1f} s  {percent:3d}%  {text}", flush=True)
        try:
            window.evaluate_js(f"setStage({percent}, {json.dumps(text)})")
        except Exception:  # noqa: BLE001 – ekran ładowania to tylko informacja
            pass

    def boot():
        """Wątek w tle: serwer, biblioteki AI, modele – potem przejście okna na interfejs programu."""
        try:
            stage(15, tr("Uruchamianie serwera…"))
            import uvicorn

            import app as server_app   # FastAPI + moduły programu; ustawia też foldery modeli (HF_HOME, U2NET_HOME)
            import background
            import reconstruct
            import updater

            state["restart"] = lambda: updater.status["restartRequested"]
            server = uvicorn.Server(uvicorn.Config(server_app.app, host=HOST, port=PORT, log_level="warning"))
            state["server"] = server
            threading.Thread(target=server.run, daemon=True).start()
            for _ in range(300):   # maks. 30 s
                if server.started:
                    break
                time.sleep(0.05)
            if not server.started:
                raise RuntimeError("server did not start within 30 s")

            stage(35, tr("Wczytywanie bibliotek AI…"))
            import torch  # noqa: F401 – najdłuższy krok (2–3 s)
            stage(60, tr("Rozpoznawanie karty graficznej…"))
            reconstruct.device()

            # modele wczytujemy tylko, jeśli już są na dysku – bez internetu start nie może utknąć na pobieraniu
            # (brakujące modele program zgłasza paskiem „Brakuje modeli AI – Pobierz teraz”)
            import models_setup
            if models_setup.MODEL_LIST[0]["present"]():
                stage(75, tr("Wczytywanie modelu usuwania tła…"))
                background.preload()
            if models_setup.all_present():   # model 3D zawsze w pamięci od startu – pierwsze generowanie bez czekania
                stage(88, tr("Wczytywanie modelu 3D…"))
                reconstruct.preload()

            stage(100, tr("Gotowe"))
            window.load_url(f"http://{HOST}:{PORT}/")
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            window.load_html(_message(tr("Nie udało się uruchomić programu"),
                                      f"{exc}<br><br>{tr('Szczegóły są w pliku logs\\makepixel3d.log.')}"))

    def on_closing():
        """Niezapisane zmiany – pytamy, tak jak przeglądarka przy zamykaniu karty."""
        if api.dirty and not state["restart"]():
            return window.create_confirmation_dialog(
                APP_NAME, tr("Bieżąca praca ma niezapisane zmiany (przycisk „Zapisz w galerii”). Zamknąć mimo to?"))
        return True

    window.events.closing += on_closing
    window.events.shown += lambda: _set_window_icon(window)
    webview.start(boot)   # boot() rusza w osobnym wątku, gdy okno już jest; start() blokuje do zamknięcia okna
    if state["server"]:
        state["server"].should_exit = True
    return RESTART_EXIT_CODE if state["restart"]() else 0
