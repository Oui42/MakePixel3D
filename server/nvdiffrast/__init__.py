# Zastępnik pakietu nvdiffrast (NVIDIA) – oryginał wymaga kompilacji C++/CUDA (u użytkowników niemożliwe).
# InstantMesh importuje go w kilku miejscach, ale ścieżka, której używamy (siatka z kolorami wierzchołków,
# extract_mesh(use_texture_map=False)), nie rasteryzuje niczego: renderer tylko tworzy kontekst w konstruktorze.
# Renderowanie i wypiekanie tekstur (funkcje niżej) zgłaszają czytelny błąd zamiast działać.
