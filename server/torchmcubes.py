# Zamiennik pakietu `torchmcubes` (wymaga kompilacji C++/CUDA, na Windows kłopotliwy).
# TripoSR woła `marching_cubes(volume, threshold)` i oczekuje wierzchołków w kolejności (x, y, z),
# gdzie x odpowiada OSTATNIEMU wymiarowi tablicy – skimage zwraca odwrotnie, więc odwracamy.
import numpy as np
import torch
from skimage.measure import marching_cubes as _skimage_mc


def marching_cubes(volume: torch.Tensor, threshold: float):
    vol = volume.detach().float().cpu().numpy()
    verts, faces, _normals, _values = _skimage_mc(vol, level=threshold)
    verts = np.ascontiguousarray(verts[:, ::-1])
    return (
        torch.from_numpy(verts).float(),
        torch.from_numpy(faces.astype(np.int64)),
    )
