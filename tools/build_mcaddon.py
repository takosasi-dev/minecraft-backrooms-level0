# -*- coding: utf-8 -*-
"""
BP と RP を 1 つの .mcaddon にまとめる。

    python tools/build_mcaddon.py
    python tools/build_mcaddon.py --deploy    開発用フォルダへ直接展開もする

出力: dist/backrooms_level0.mcaddon

ビヘイビアパック単体では成立しない（テクスチャ・フォグ・音が RP 側にある）ので、
必ず2点セットで配る。リソースパック未適用のプレイヤーには壁も床も天井も
「未知のブロック」として表示される（仕様書 16.2）。
"""

import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
OUT = os.path.join(DIST, "backrooms_level0.mcaddon")

PACKS = ["BackroomsBP", "BackroomsRP"]

EXCLUDE_DIRS = {"__pycache__", "node_modules", ".git"}
EXCLUDE_SUFFIX = (".pyc", ".map", ".ts")
EXCLUDE_NAMES = {"NOTES.md", ".DS_Store", "Thumbs.db"}

# 非UWPストア版の実体（ユーザー環境。%APPDATA%\Minecraft Bedrock 配下）
MOJANG = os.path.join(
    os.environ.get("APPDATA", ""), "Minecraft Bedrock", "Users", "Shared", "games", "com.mojang"
)
DEV_DIRS = {
    "BackroomsBP": "development_behavior_packs",
    "BackroomsRP": "development_resource_packs",
}


def collect(pack):
    base = os.path.join(ROOT, pack)
    if not os.path.isdir(base):
        raise SystemExit("パックが見つからない: %s" % base)
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for name in filenames:
            if name in EXCLUDE_NAMES or name.endswith(EXCLUDE_SUFFIX):
                continue
            full = os.path.join(dirpath, name)
            out.append((full, os.path.relpath(full, base).replace("\\", "/")))
    return out


def build():
    os.makedirs(DIST, exist_ok=True)
    total = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for pack in PACKS:
            files = collect(pack)
            if not files:
                raise SystemExit("パックが空: %s" % pack)
            for full, arc in files:
                zf.write(full, "%s/%s" % (pack, arc))
            total += len(files)
            print("  %-14s %3d files" % (pack, len(files)))
    print("built %s (%d files, %.1f KB)" % (OUT, total, os.path.getsize(OUT) / 1024))


def deploy():
    """開発用フォルダへ直接コピーする。.mcaddon のインポートより速く回せる。

    development_* は Minecraft の再起動で読み直される。
    ただしカスタム音声ファイルはクライアントの完全再起動が必要（仕様書 9.2）。
    """
    if not os.path.isdir(MOJANG):
        print("com.mojang が見つからないので deploy を飛ばす: %s" % MOJANG)
        return
    for pack, devdir in DEV_DIRS.items():
        dst = os.path.join(MOJANG, devdir, pack)
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        shutil.copytree(
            os.path.join(ROOT, pack),
            dst,
            ignore=shutil.ignore_patterns(*EXCLUDE_DIRS, "*.pyc", "NOTES.md"),
        )
        print("deployed -> %s" % dst)


if __name__ == "__main__":
    build()
    if "--deploy" in sys.argv:
        deploy()
