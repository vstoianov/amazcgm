#!/usr/bin/env python3
"""Split a Zeus .zab into per-watch .zpk files that install from a QR code.

The Zepp app's developer-mode scanner (zpkd1:// links) cannot parse a .zab and
only accepts preview packages. For every .zpk inside the .zab this script sets
packageInfo.mode to "preview" and packageInfo.expiredTime far in the future in
the app.json of device.zip and app-side.zip. Everything else is copied byte for
byte.

Usage: make-zpk.py <app.json> <file.zab> <out-dir> <name-prefix>
Writes <out-dir>/<name-prefix>-<group>.zpk and prints one line per package,
Bip Max first: <file name><TAB><watch names for people, comma separated>
"""
import io
import json
import sys
import zipfile

EXPIRED_TIME = 2147483647  # about 68 years; zeus stamps 48 hours

WATCH_NAMES = {
    "bip-max": "Amazfit Bip Max",
    "t-rex-3": "T-Rex 3",
    "t-rex-3-pro-48": "T-Rex 3 Pro 48 mm",
    "t-rex-3-pro-44": "T-Rex 3 Pro 44 mm",
    "balance-2": "Balance 2",
    "balance-2-xt": "Balance 2 XT",
    "active-max": "Active Max",
}


def copy_zip(src_bytes, patch):
    """Rebuild a zip, keeping entry order and compression; patch(name, data) may change data."""
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(src_bytes)) as src, zipfile.ZipFile(out, "w") as dst:
        for info in src.infolist():
            data = src.read(info)
            new = patch(info.filename, data)
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = info.compress_type
            zi.external_attr = info.external_attr
            zi.create_system = info.create_system
            dst.writestr(zi, new)
    return out.getvalue()


def patch_app_json(name, data):
    if name != "app.json":
        return data
    app = json.loads(data)
    info = app.setdefault("packageInfo", {})
    info["mode"] = "preview"
    info["expiredTime"] = EXPIRED_TIME
    return json.dumps(app, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def patch_zpk(zpk_bytes):
    def inner(name, data):
        if name.endswith(".zip"):
            return copy_zip(data, patch_app_json)
        return data
    return copy_zip(zpk_bytes, inner)


def platform_names(app_json_path):
    with open(app_json_path, encoding="utf-8") as f:
        app = json.load(f)
    names = {}
    for target in app.get("targets", {}).values():
        for p in target.get("platforms", []):
            names[p["deviceSource"]] = (p["name"], p.get("sr", ""))
    return names


def group_slug(sources, names):
    known = [names[s] for s in sources if s in names]
    models = sorted({n for n, _ in known})
    if len(models) == 1:
        return models[0], models
    widths = sorted({sr.lstrip("w") for _, sr in known if sr})
    return "round-" + "-".join(widths or ["mixed"]), models


def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    app_json, zab, out_dir, prefix = sys.argv[1:]
    names = platform_names(app_json)
    with zipfile.ZipFile(zab) as z:
        manifest = json.loads(z.read("manifest.json"))
        used = set()
        rows = []
        for entry in manifest["zpks"]:
            sources = [p["deviceSource"] for p in entry.get("platforms", [])]
            slug, models = group_slug(sources, names)
            if slug in used:
                sys.exit("duplicate package group " + slug)
            used.add(slug)
            file_name = f"{prefix}-{slug}.zpk"
            with open(f"{out_dir}/{file_name}", "wb") as f:
                f.write(patch_zpk(z.read(entry["name"])))
            label = ", ".join(WATCH_NAMES.get(m, m) for m in models)
            rows.append((slug != "bip-max", label, file_name))
        for _, label, file_name in sorted(rows):
            print(f"{file_name}\t{label}")


if __name__ == "__main__":
    main()
