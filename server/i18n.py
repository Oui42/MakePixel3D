# Tłumaczenia komunikatów serwera (błędy, etapy generowania, ekran ładowania, wymagania AI).
# Teksty źródłowe w kodzie są po polsku; słownik EN tłumaczy je, gdy w ustawieniach wybrano angielski.
# Interfejs (web/) ma własny słownik: web/lang/en.js – te same zasady.
import settings

EN = {
    # ekran ładowania i okno programu
    "Uruchamianie…": "Starting…",
    "Uruchamianie serwera…": "Starting the server…",
    "Wczytywanie bibliotek AI…": "Loading AI libraries…",
    "Rozpoznawanie karty graficznej…": "Detecting the graphics card…",
    "Wczytywanie modelu usuwania tła…": "Loading the background removal model…",
    "Wczytywanie modelu 3D…": "Loading the 3D model…",
    "Gotowe": "Ready",
    "{app} już działa": "{app} is already running",
    "Nie udało się uruchomić programu": "The program could not start",
    "Szczegóły są w pliku logs\\makepixel3d.log.": "Details are in logs\\makepixel3d.log.",
    "Bieżąca praca ma niezapisane zmiany (przycisk „Zapisz w galerii”). Zamknąć mimo to?":
        "Your current work has unsaved changes (“Save to gallery” button). Close anyway?",
    "Program nie mógł się uruchomić.\n\nSzczegóły: {log}": "The program could not start.\n\nDetails: {log}",
    "{app} – błąd": "{app} – error",
    # zdjęcie i model 3D
    "Nie znaleziono obiektu na zdjęciu (całe tło zostało usunięte).":
        "No object was found in the photo (the whole image was removed as background).",
    "Nieobsługiwany format pliku – wybierz zdjęcie (JPG, PNG, WEBP).":
        "Unsupported file format – choose a photo (JPG, PNG, WEBP).",
    "Błąd generowania 3D: {exc}": "3D generation error: {exc}",
    "Ładowanie modelu TripoSR (przy pierwszym razie: pobieranie ~1,7 GB)":
        "Loading the TripoSR model (first time: downloading ~1.7 GB)",
    "Analiza zdjęcia (sieć neuronowa)": "Analysing the photo (neural network)",
    "Budowanie siatki 3D ({n}³)": "Building the 3D mesh ({n}³)",
    "Porządkowanie siatki": "Cleaning up the mesh",
    # modele AI
    "Usuwanie tła (IS-Net)": "Background removal (IS-Net)",
    "Model 3D (TripoSR)": "3D model (TripoSR)",
    "Analiza obrazu (DINO, konfiguracja)": "Image analysis (DINO, configuration)",
    "Brakuje modeli AI, a nie udało się ich pobrać (brak internetu?). Pobierz je przyciskiem na pasku u góry okna, gdy będzie połączenie.":
        "AI models are missing and could not be downloaded (no internet?). Download them with the button in the bar at the top of the window when you are online.",
    # galeria i zapis
    "Nie ma takiego wpisu w galerii.": "There is no such gallery entry.",
    "Uszkodzony zapis projektu.": "The saved project is damaged.",
    "Folder nie istnieje albo nie można w nim zapisywać.": "The folder does not exist or is not writable.",
    "Nie wybrano folderu zapisu.": "No save folder has been chosen.",
    "Nieprawidłowe ustawienie: {key}": "Invalid setting: {key}",
    # aktualizacje
    "Aktualizacje nie są skonfigurowane (brak adresu w config/update.json).":
        "Updates are not configured (no address in config/update.json).",
    "Nie udało się sprawdzić aktualizacji: {exc}": "Could not check for updates: {exc}",
    "plik jest uszkodzony (niezgodna suma kontrolna)": "the file is damaged (checksum mismatch)",
    "Nie udało się pobrać aktualizacji: {exc}": "Could not download the update: {exc}",
    "niebezpieczna ścieżka w archiwum: {name}": "unsafe path in the archive: {name}",
    # zaawansowane AI
    "Tekst → obraz → sprite": "Text → image → sprite",
    "Opisujesz obiekt słowami, a program sam tworzy obraz, model 3D i sprite'y (bez szukania zdjęć).":
        "Describe an object in words and the program creates the image, 3D model and sprites (no photo needed).",
    "Lepszy tył obiektu": "Better back side",
    "Edycja obrazu (dodaj, zmień)": "Image editing (add, change)",
    "Zmieniasz gotowy obraz poleceniem („dodaj miecz”, „zielone spodnie”), a potem generujesz model 3D od nowa.":
        "Change a finished image with an instruction (\"add a sword\", \"green trousers\"), then generate the 3D model again.",
    "składniki wspólne z „Tekst → obraz” (10,6 GB)": "components shared with \"Text → image\" (10.6 GB)",
    "edycja: FLUX.1 Kontext (6,8 GB)": "editing: FLUX.1 Kontext (6.8 GB)",
    "konfiguracja pipeline'u": "pipeline configuration",
    "Wczytywanie modelu edycji (pierwszy raz trwa dłużej)…": "Loading the editing model (the first time takes longer)…",
    "Edycja obrazu…": "Editing the image…",
    "Napisz, co zmienić na obrazie.": "Write what to change in the image.",
    "Model edycji obrazu nie jest zainstalowany.": "The image editing model is not installed.",
    "Błąd edycji obrazu: {exc}": "Image editing error: {exc}",
    "Szkielet innego modelu jest właśnie liczony – poczekaj na jego koniec.": "A skeleton for another model is being computed – wait for it to finish.",
    "Nie ma takiego zadania.": "No such job.",
    # S8: tekst → obraz
    "obraz: FLUX.1-schnell (6,8 GB)": "image: FLUX.1-schnell (6.8 GB)",
    "tekst: koder T5 (3,3 GB)": "text: T5 encoder (3.3 GB)",
    "pozostałe składniki (0,5 GB)": "remaining components (0.5 GB)",
    "po pobraniu brakuje plików modelu": "model files are missing after the download",
    "Nie udało się pobrać modelu: {exc}": "Could not download the model: {exc}",
    "Wczytywanie modelu obrazu (pierwszy raz trwa dłużej)…": "Loading the image model (the first time takes longer)…",
    "Wpisz, co ma przedstawiać obraz.": "Type what the image should show.",
    "Model tekst → obraz nie jest zainstalowany.": "The text → image model is not installed.",
    "Generowanie obrazu…": "Generating the image…",
    "Ten komputer nie spełnia wymagań: {why}": "This computer does not meet the requirements: {why}",
    "Błąd generowania obrazu: {exc}": "Image generation error: {exc}",
    # S9: lepszy tył obiektu
    "brakuje kodu InstantMesh (server/third_party/InstantMesh) – uruchom instalator ponownie":
        "InstantMesh code is missing (server/third_party/InstantMesh) – run the installer again",
    "widoki: Zero123++ (5,6 GB)": "views: Zero123++ (5.6 GB)",
    "siatka: InstantMesh (3,2 GB)": "mesh: InstantMesh (3.2 GB)",
    "koder obrazu DINO (0,3 GB)": "DINO image encoder (0.3 GB)",
    "Wczytywanie modeli widoków i siatki…": "Loading the view and mesh models…",
    "Funkcja „Lepszy tył obiektu” nie jest zainstalowana.": "The \"Better back side\" feature is not installed.",
    "Dorysowywanie widoków z innych stron (Zero123++)…": "Imagining views from other sides (Zero123++)…",
    "Budowanie siatki 3D z widoków (InstantMesh)…": "Building the 3D mesh from the views (InstantMesh)…",
    # S10: szkielet i animacje
    "Python 3.11 (11 MB)": "Python 3.11 (11 MB)",
    "pip": "pip",
    "PyTorch dla Pythona 3.11 ({v}, ok. 3 GB)": "PyTorch for Python 3.11 ({v}, about 3 GB)",
    "torch_scatter / torch_cluster": "torch_scatter / torch_cluster",
    "biblioteki UniRig i Blender (bpy, 0,3 GB)": "UniRig libraries and Blender (bpy, 0.3 GB)",
    "kod UniRig (GitHub)": "UniRig code (GitHub)",
    "konfiguracja UniRig zmieniła się ({f}) – funkcja wymaga aktualizacji programu":
        "the UniRig configuration has changed ({f}) – this feature needs a program update",
    "wagi UniRig: szkielet (1,3 GB)": "UniRig weights: skeleton (1.3 GB)",
    "wagi UniRig: skórowanie (4,2 GB)": "UniRig weights: skinning (4.2 GB)",
    "konfiguracja OPT-350m": "OPT-350m configuration",
    "po instalacji brakuje plików funkcji": "feature files are missing after the installation",
    "Nie udało się zainstalować funkcji: {exc}": "Could not install the feature: {exc}",
    "Funkcja „Szkielet i animacje” nie jest zainstalowana.": "The \"Skeleton and animations\" feature is not installed.",
    "Przygotowanie siatki (Blender)…": "Preparing the mesh (Blender)…",
    "Przewidywanie szkieletu (UniRig)…": "Predicting the skeleton (UniRig)…",
    "Przygotowanie szkieletu…": "Preparing the skeleton…",
    "Wagi skórowania (UniRig)…": "Skinning weights (UniRig)…",
    "Scalanie modelu ze szkieletem…": "Merging the model with the skeleton…",
    "UniRig nie zapisał wyniku": "UniRig did not write a result",
    "UniRig nie zapisał pliku {name}": "UniRig did not write the file {name}",
    "Przewidywanie szkieletu (UniRig)… próba {n}": "Predicting the skeleton (UniRig)… attempt {n}",
    "Błąd tworzenia szkieletu: {exc}": "Skeleton generation error: {exc}",
    "AI dorysowuje widoki z innych stron, zanim powstanie model 3D – wyraźnie lepsze boki i tył.":
        "AI draws views from other sides before the 3D model is built – much better sides and back.",
    "Szkielet i animacje ruchu": "Skeleton and motion animations",
    "Automatyczny szkielet postaci i gotowe animacje (chodzenie, bieg, atak).":
        "Automatic character skeleton and ready-made animations (walk, run, attack).",
    "wymaga karty NVIDIA z obsługą CUDA": "requires an NVIDIA card with CUDA support",
    " (wykryto: {gpu})": " (detected: {gpu})",
    "za mało pamięci karty: {have} GB, potrzeba {need} GB": "not enough graphics memory: {have} GB, {need} GB required",
    "za mało pamięci RAM: {have} GB, potrzeba {need} GB": "not enough RAM: {have} GB, {need} GB required",
    "za mało miejsca na dysku: {have} GB, potrzeba {need} GB": "not enough disk space: {have} GB, {need} GB required",
}


def lang() -> str:
    return settings.get()["language"]


def tr(text: str, **kw) -> str:
    s = EN.get(text, text) if lang() == "en" else text
    return s.format(**kw) if kw else s
