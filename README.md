# MakePixel3D

Photo → 3D model (AI) → pixel art from any angle → transparent PNG.
Everything runs locally and for free: no accounts, no paid APIs. After installation the program works offline.

## Download

**[⬇ Download the installer: MakePixel3D-Setup.exe](https://github.com/Oui42/MakePixel3D/releases/latest/download/MakePixel3D-Setup.exe)**
(Windows 10/11 64-bit, about 2 MB)

The installer downloads everything it needs: the program, Python, libraries (PyTorch for an NVIDIA card or for the CPU)
and the AI models – about 4 GB in total, so an internet connection is required. By default it installs to
`C:\Program Files\MakePixel3D` (administrator rights); you can also choose "install for me only" without them.
Your gallery and settings are kept in `%LOCALAPPDATA%\MakePixel3D` and survive uninstalling.
The program checks for updates at startup. Terms of use: [LICENSE.txt](LICENSE.txt) (MIT).

All releases: [Releases](https://github.com/Oui42/MakePixel3D/releases).

> Windows SmartScreen or your antivirus may warn about a new, unsigned .exe file.
> In SmartScreen click "More info" → "Run anyway".

Requirements: 64-bit Windows, about 8 GB of disk space, 8 GB RAM (16 GB recommended). An NVIDIA card is optional –
without one the 3D model is computed on the CPU (about 20–30 s instead of 2 s).

## How to use

1. **Photo**: the background is removed automatically (you can fix it with a brush).
2. **3D model**: generation with optional left–right symmetry; voxel mode.
3. **Style**: ready-made presets (RPG character, PICO-8, isometric, icon, Game Boy…); settings are remembered.
4. **Camera**: 4/8/16 directions, tilt, "feet on the ground" framing.
5. **Pixel art**: size and aspect ratio, sharp details, palettes (built-in or from a file), dithering, outline, shadow.
6. **Export**: transparent PNG (single view, sprite sheet, separate files, ×1–×8), animated rotation GIF, pixel editor, gallery of your work.

The interface is available in English and Polish (settings → language).

## Best photos

- one object, fully in frame, ideally on a plain background;
- front view or slightly from above (a photo that is already isometric gives a tilted model);
- the back of the object is **guessed** by the AI – the simpler the shape, the better the result.

## Support the project

MakePixel3D is free and made in spare time. If it saves you work, you can buy me a coffee –
it helps keep the project going and adds new features:

**[☕ Buy me a coffee](https://buymeacoffee.com/oui42)**

## Installing from source (for developers)

Requirements: Python 3.11–3.13 (with "Add to PATH"), Git.

```bat
install.bat          :: computer with an NVIDIA card (e.g. RTX 5070)
install.bat cpu      :: computer without an NVIDIA card (works, but slower)
start.bat            :: run – own window, no console
start-debug.bat      :: same with a console – when something does not work (--browser = run in the browser)
```

The installer is built by `tools\installer\build.ps1` (Inno Setup 6), the release package by `tools\release.py`.

## Licenses

- TripoSR (Stability AI + VAST) – MIT
- rembg / IS-Net – MIT / Apache 2.0
- Three.js – MIT
- gifenc – MIT
