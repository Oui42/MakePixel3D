# Prepares a release: a ZIP with the program + latest.json for the update mechanism and the installer.
#
#   python tools\release.py --base-url https://github.com/Oui42/MakePixel3D/releases/download/v0.1.0 --notes "..."
#
# Output in dist/:  MakePixel3D-<version>.zip  and  latest.json (version, ZIP address, SHA-256, size, date, notes).
# Both files are uploaded to the GitHub release named in --base-url (tools\installer\gh_release.ps1 does that).
# GitHub serves the newest release's latest.json under the fixed address .../releases/latest/download/latest.json,
# which the program's updater and the installer read.
# NOT included in the ZIP: .venv, models, library, config, updates, third_party (installed by the installer / install.bat),
# and notes such as CLAUDE.md or INSTRUKCJA.md.
import argparse
import hashlib
import json
import sys
import time
import zipfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
INCLUDE_DIRS = ["server", "web", "tools", "assets"]
INCLUDE_FILES = ["version.json", "requirements.txt", "install.bat", "start.bat", "start-debug.bat", "README.md",
                 "LICENSE.txt"]
EXCLUDE_PARTS = {"third_party", "__pycache__", "_test", ".git"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True, help="address of the folder where the ZIP will be published")
    ap.add_argument("--notes", default="", help="what is new (short)")
    args = ap.parse_args()

    version = json.loads((PROJECT / "version.json").read_text(encoding="utf-8-sig"))["version"]
    dist = PROJECT / "dist"
    dist.mkdir(exist_ok=True)
    for old in dist.glob("MakePixel3D-*.zip"):   # only one package in dist/ (gh_release.ps1 uploads everything there)
        old.unlink()
    zip_name = f"MakePixel3D-{version}.zip"
    zip_path = dist / zip_name

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in INCLUDE_FILES:
            if (PROJECT / f).is_file():
                z.write(PROJECT / f, f)
        for d in INCLUDE_DIRS:
            for p in sorted((PROJECT / d).rglob("*")):
                if p.is_file() and not (EXCLUDE_PARTS & set(p.relative_to(PROJECT).parts)):
                    z.write(p, p.relative_to(PROJECT).as_posix())

    sha = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    manifest = {
        "version": version,
        "date": time.strftime("%Y-%m-%d"),
        "url": f"{args.base_url.rstrip('/')}/{zip_name}",
        "sha256": sha,
        "size": zip_path.stat().st_size,
        "notes": args.notes,
    }
    (dist / "latest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Release {version}: {zip_path} ({zip_path.stat().st_size // 1024} KB)\nlatest.json: {dist / 'latest.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
