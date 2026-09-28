# Patrz __init__.py – atrapa nvdiffrast.torch dla InstantMesh (tylko import + kontekst).
_MSG = "nvdiffrast (renderowanie/tekstury) nie jest dostępny w MakePixel3D – używamy siatki z kolorami wierzchołków"


class RasterizeCudaContext:
    def __init__(self, device=None):
        self.device = device


class RasterizeGLContext(RasterizeCudaContext):
    pass


def _unavailable(*_args, **_kwargs):
    raise RuntimeError(_MSG)


rasterize = interpolate = antialias = texture = _unavailable


class DepthPeeler:
    def __init__(self, *_args, **_kwargs):
        raise RuntimeError(_MSG)
