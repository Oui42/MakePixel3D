# Zastępnik pakietu flash_attn (Dao-AILab) – oryginał wymaga kompilacji CUDA i nie ma gotowych kół dla Windows.
# UniRig (S10) importuje z niego tylko moduł MHA (uwaga krzyżowa w modelu skórowania) oraz sprawdza obecność
# pakietu w PTv3 (tam używamy ścieżki bez flash-attn: `flash: False` w konfiguracji modelu).
# Implementacja MHA poniżej liczy to samo zwykłym scaled_dot_product_attention z PyTorch – te same nazwy parametrów
# (Wq, Wkv, Wqkv, out_proj), więc wagi z checkpointu wczytują się bez zmian.
__version__ = "0.0-makepixel3d-stub"
