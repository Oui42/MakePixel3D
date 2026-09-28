# Uruchamia run.py z UniRig w środowisku Python 3.11 z poprawkami dla nowego PyTorch:
#   - torch.load w PyTorch ≥ 2.6 domyślnie ładuje tylko wagi, a checkpointy UniRig zawierają obiekty `box.Box`
#     (konfiguracja) → dopisujemy je do listy zaufanych klas (checkpoint pochodzi z VAST-AI/UniRig, pobrany przez nas);
#   - zastępnik flash_attn (server/flash_attn) musi być na ścieżce przed pakietami.
# Użycie (z folderu UniRig):  python <ta ścieżka> run.py --task configs/task/skeleton_mp3d.yaml ...
import runpy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # server/ → flash_attn (atrapa)
import torch  # noqa: E402

# Lista zaufanych klas nie wystarcza (unpickler „weights only” nie umie odtworzyć zawartości Box) – checkpointy UniRig
# są zaufanym źródłem (pobrane przez nas z VAST-AI/UniRig), więc wczytujemy je klasycznie (weights_only=False).
_torch_load = torch.load


def _load_trusted(*args, **kwargs):
    kwargs["weights_only"] = False
    return _torch_load(*args, **kwargs)


torch.load = _load_trusted

script = sys.argv[1]
sys.argv = sys.argv[1:]
runpy.run_path(script, run_name="__main__")
