# Punkt startowy programu (skrót MakePixel3D / start.bat → pythonw.exe server\launch.py).
# 1. Tylko jedna kopia programu: druga próba uruchomienia przywraca okno już działającego programu i kończy się.
# 2. pythonw.exe nie ma konsoli – wszystko, co program wypisuje, trafia do logs\makepixel3d.log.
# 3. Jeśli czeka pobrana aktualizacja (updates/pending) – instaluje ją PRZED wczytaniem reszty kodu.
# 4. Uruchamia okno programu (desktop.py). Z opcją --browser: stary tryb, karta w przeglądarce.
# 5. Okno zakończone kodem 3 (prośba o restart po aktualizacji) → uruchamiamy program od nowa (--restarted).
import ctypes
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
os.chdir(PROJECT)
sys.path.insert(0, str(ROOT))
# to samo, co ustawia start.bat – skrót na pulpicie uruchamia launch.py bezpośrednio
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# Proces administratora (--apply-update) widzi Program Files jako ZAPISYWALNY, więc paths.py wziąłby folder programu
# za folder danych i nie znalazłby pobranej aktualizacji (leży w %LOCALAPPDATA%\MakePixel3D\updates) – dlatego
# proces zwykłego użytkownika przekazuje mu swój folder danych w --data (zgłoszony błąd: „Restart and install” w kółko).
if "--data" in sys.argv:
    os.environ["MAKEPIXEL3D_DATA"] = sys.argv[sys.argv.index("--data") + 1]

import paths  # noqa: E402 – dane użytkownika (logi, aktualizacje) mogą leżeć poza folderem programu

APP_NAME = "MakePixel3D"
MUTEX_NAME = "Local\\MakePixel3D.SingleInstance"
LOG_DIR = paths.LOGS
LOG = LOG_DIR / "makepixel3d.log"


def _single_instance(wait_ms: int):
    """Uchwyt mutexu, gdy jesteśmy jedyną kopią; None, gdy program już działa.
    Po restarcie (aktualizacja) czekamy, aż poprzedni proces się zamknie i zwolni mutex."""
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        return True   # nie udało się utworzyć mutexu – nie blokujemy startu
    result = kernel32.WaitForSingleObject(ctypes.c_void_p(handle), wait_ms)
    if result in (0, 0x80):   # WAIT_OBJECT_0 albo WAIT_ABANDONED (poprzedni proces zakończył się bez zwolnienia)
        return handle
    kernel32.CloseHandle(ctypes.c_void_p(handle))
    return None


def _activate_existing():
    user32 = ctypes.windll.user32
    hwnd = user32.FindWindowW(None, APP_NAME)
    if hwnd:
        user32.ShowWindow(hwnd, 9)   # SW_RESTORE – także z paska zadań po zminimalizowaniu
        user32.SetForegroundWindow(hwnd)


def _apply_update_elevated() -> bool:
    """Program w C:\\Program Files: pliki aktualizacji może podmienić tylko administrator. Uruchamiamy ten sam
    launch.py z opcją --apply-update przez UAC („Uruchom jako administrator”) i czekamy na koniec.
    Odmowa w oknie UAC → False, aktualizacja czeka do następnego uruchomienia."""
    import ctypes.wintypes as wt

    class SHELLEXECUTEINFO(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("fMask", wt.ULONG), ("hwnd", wt.HWND), ("lpVerb", wt.LPCWSTR),
                    ("lpFile", wt.LPCWSTR), ("lpParameters", wt.LPCWSTR), ("lpDirectory", wt.LPCWSTR),
                    ("nShow", ctypes.c_int), ("hInstApp", wt.HINSTANCE), ("lpIDList", ctypes.c_void_p),
                    ("lpClass", wt.LPCWSTR), ("hkeyClass", wt.HKEY), ("dwHotKey", wt.DWORD),
                    ("hIcon", wt.HANDLE), ("hProcess", wt.HANDLE)]

    info = SHELLEXECUTEINFO()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = 0x00000040          # SEE_MASK_NOCLOSEPROCESS
    info.lpVerb = "runas"
    info.lpFile = sys.executable
    info.lpParameters = f'"{ROOT / "launch.py"}" --apply-update --data "{paths.DATA}"'
    info.lpDirectory = str(PROJECT)
    info.nShow = 0                   # SW_HIDE
    if not ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(info)) or not info.hProcess:
        return False
    ctypes.windll.kernel32.WaitForSingleObject(info.hProcess, 10 * 60 * 1000)
    code = wt.DWORD()
    ctypes.windll.kernel32.GetExitCodeProcess(info.hProcess, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(info.hProcess)
    return code.value == 0


def _log_to_file():
    """Bez konsoli (pythonw) stdout/stderr to None – biblioteki (np. pasek pobierania modeli) by się wysypały."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if LOG.is_file() and LOG.stat().st_size > 2_000_000:   # prosta rotacja: jeden stary plik
        LOG.replace(LOG.with_suffix(".old.log"))
    f = open(LOG, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 – plik otwarty do końca programu
    f.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} start =====\n")
    sys.stdout = sys.stderr = f


def _error_box(text: str, title: str):
    try:
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x10)
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    if "--apply-update" in sys.argv:
        # proces administratora uruchomiony przez _apply_update_elevated – tylko instaluje pliki i kończy się
        _log_to_file()
        import updater
        installed = updater.apply_pending()
        print(f"[admin] zainstalowano aktualizację: {installed}", flush=True)
        return 0 if installed else 1

    restarted = "--restarted" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--restarted"]
    mutex = _single_instance(15000 if restarted else 0)
    if mutex is None:
        _activate_existing()
        return 0

    if sys.stdout is None or "pythonw" in Path(sys.executable).name.lower():
        _log_to_file()

    import updater
    if updater.has_pending() and not paths.PROJECT_WRITABLE:
        print("Aktualizacja czeka, folder programu tylko do odczytu – prośba o uprawnienia administratora", flush=True)
        if not _apply_update_elevated():
            print("Aktualizacja nie została zainstalowana (brak zgody administratora) – spróbujemy następnym razem", flush=True)
    installed = updater.apply_pending()
    if installed:
        print(f"Zainstalowano aktualizację: wersja {installed}", flush=True)

    if "--browser" in args:
        import runpy
        runpy.run_path(str(ROOT / "app.py"), run_name="__main__")
        return 0

    import desktop
    code = desktop.run()
    if code == desktop.RESTART_EXIT_CODE:
        # nowy proces – ten sam interpreter (pythonw = bez konsoli); poczeka, aż ten zwolni mutex
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen([sys.executable, str(ROOT / "launch.py"), *args, "--restarted"], cwd=PROJECT, creationflags=flags)
        return 0
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        try:
            from i18n import tr
            _error_box(tr("Program nie mógł się uruchomić.\n\nSzczegóły: {log}", log=LOG), tr("{app} – błąd", app=APP_NAME))
        except Exception:  # noqa: BLE001
            _error_box(f"MakePixel3D: {LOG}", "MakePixel3D")
        sys.exit(1)
