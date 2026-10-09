# -*- coding: utf-8 -*-
"""Level 0 のブロックテクスチャ5枚とノークリップのアイコン(16x16 PNG)を生成する。

    python tools/gen_textures.py

出力: BackroomsRP/textures/blocks/{wall,floor,ceiling,light,exit_door}.png
      BackroomsRP/textures/items/{noclip,almond_water}.png

冪等。乱数は固定シードの default_rng のみなので、何度走らせても同じ絵になる。
壁・床・天井は彩度を落とした黄土色の同系色で揃える(仕様書 5.6)。
出口ドアだけ色相を外す(非常口の緑) -- 遠くから「あれは違う」と分かることが狙い。
マニラルームの3枚(v0.4.0)も桃色がかったベージュで色相を外す -- 入った瞬間に「ここは違う」と分かるように。
"""
from pathlib import Path

import numpy as np
from PIL import Image

S = 16
OUT = Path(__file__).resolve().parent.parent / "BackroomsRP" / "textures" / "blocks"

# 同系色の黄土色。色相をばらけさせない
C_WALL = (186, 168, 110)
C_FLOOR = (150, 133, 84)
C_CEIL = (222, 216, 190)
C_LIGHT = (246, 240, 206)
C_EXIT = (34, 108, 66)


def canvas(color):
    return np.full((S, S, 3), color, dtype=np.float64)


def noise(seed, sigma):
    """固定シードの粒ノイズ(全チャンネル共通 = 色相を動かさない)"""
    n = np.random.default_rng(seed).normal(0.0, sigma, (S, S))
    return n[:, :, None]


def save(img, name):
    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    assert out.size == (S, S), f"{name}: {out.size}"
    OUT.mkdir(parents=True, exist_ok=True)
    out.save(OUT / f"{name}.png", optimize=True)
    return OUT / f"{name}.png"


def wall():
    """黄ばんだ壁紙。縦ストライプ + 上下端の見切り材/幅木"""
    a = canvas(C_WALL)
    x = np.arange(S)
    stripe = np.where((x // 2) % 2 == 0, 9.0, -9.0)          # 2px 幅の縦ストライプ
    stripe += np.where(x % 2 == 0, 3.0, 0.0)                 # ストライプ内の織り目
    a += stripe[None, :, None]
    a += np.linspace(6.0, -10.0, S)[:, None, None]           # 上が明るい(照明が天井)
    a += noise(1, 3.0)
    a[0:2] -= 26.0                                           # 上端: 見切り材
    a[1] -= 8.0
    a[14:16] -= 40.0                                         # 下端: 幅木
    a[14] += 14.0                                            # 幅木の上面ハイライト
    return save(a, "wall")


def floor():
    """黄土色の毛足の短いカーペット。細かいノイズ"""
    a = canvas(C_FLOOR)
    a += noise(2, 9.0)                                       # 毛羽立ち
    a += noise(3, 4.0) * np.array([1.0, 0.9, 0.6])           # 汚れのムラ(わずかに褐色)
    y, x = np.mgrid[0:S, 0:S]
    a -= np.where((x + y) % 4 == 0, 5.0, 0.0)[:, :, None]    # 織りの目
    return save(a, "floor")


def ceiling():
    """白〜オフホワイトの吸音天井タイル。穴模様"""
    a = canvas(C_CEIL)
    a += noise(4, 3.5)
    y, x = np.mgrid[0:S, 0:S]
    holes = ((x % 3 == 1) & (y % 3 == 1)) | ((x % 3 == 0) & (y % 3 == 2))
    a[holes] -= 30.0                                         # 吸音材の穴
    a[0, :] -= 22.0                                          # タイルの合わせ目
    a[:, 0] -= 22.0
    a[15, :] -= 10.0
    a[:, 15] -= 10.0
    return save(a, "ceiling")


def light():
    """乳白色パネル。わずかに黄ばんだ色味"""
    a = canvas(C_LIGHT)
    y, x = np.mgrid[0:S, 0:S]
    r = np.hypot(y - 7.5, x - 7.5) / 10.6
    a -= (r ** 2 * 26.0)[:, :, None]                         # 中央が明るい拡散板
    a += noise(5, 2.0)
    frame = (x == 0) | (x == 15) | (y == 0) | (y == 15)
    a[frame] = np.array([196, 190, 166], dtype=np.float64)   # パネル枠
    a[8, :] -= 7.0                                           # 管の継ぎ目
    return save(a, "light")


def exit_door():
    """非常口の緑。ここだけ意図的に色相を外す"""
    a = canvas(C_EXIT)
    a += noise(6, 2.5)
    a[1:15, 1:15] += 16.0                                    # 落とし込みパネル
    a[0, :] += 24.0                                          # 枠のハイライト
    a[:, 0] += 18.0
    a[15, :] -= 16.0
    a[:, 15] -= 12.0
    a[3:7, 4:12] = np.array([228, 236, 224], dtype=np.float64)   # 非常口サイン(白地)
    a[4:6, 5:8] = np.array([34, 108, 66], dtype=np.float64)      # サインの人型(簡略)
    a[9:11, 2:14] = np.array([198, 204, 196], dtype=np.float64)  # 押し棒
    a[11, 2:14] -= 60.0                                          # 押し棒の影
    return save(a, "exit_door")


# ---- v0.3.0 小物13種のテクスチャ(担当②)。壁・床・天井と同じ黄土色の系統。誘導灯だけ緑 ----

C_DECOR = (214, 204, 176)        # コンセント/スイッチの板(クリーム)
C_DECOR_EDGE = (120, 108, 78)    # 板の縁の色(側面UV用。コーナー1pxをこの色にする)
C_VENT_DARK = (46, 42, 34)       # 通気口のスリット
C_STAIN_MIX = (-30.0, -45.0, -70.0)  # 水ジミの色寄せ(天井色を沈めて茶色〜黄土色に。修正ラウンド2)
C_PIPE = (150, 150, 150)
C_WIRE = (120, 40, 30)
C_FLOOR_STAIN = (78, 62, 40)
C_DESK_TOP = (150, 150, 150)
C_DESK_LEG = (190, 190, 196)
C_DESK_DRAWER = (120, 120, 124)
C_DESK_HANDLE = (60, 60, 64)
C_CHAIR_BASE = (150, 150, 156)
C_CHAIR_POLE = (185, 185, 190)
C_CHAIR_SEAT = (70, 66, 64)
C_CHAIR_SEAM = (46, 42, 40)
C_MARK = (40, 36, 34)            # 落書きのマーカー線


def outlet():
    """クリーム色の板に縦長の差込口2組。縁は C_DECOR_EDGE(側面UVがコーナーを拾う)"""
    a = canvas(C_DECOR)
    a += noise(30, 2.0)
    a[1:15, 1:15] += 6.0
    a[0, :] = a[15, :] = a[:, 0] = a[:, 15] = np.array(C_DECOR_EDGE, dtype=np.float64)
    for ox in (4, 10):
        a[5:11, ox : ox + 1] -= 90.0
        a[5:11, ox + 2 : ox + 3] -= 90.0
    return save(a, "outlet")


def switch():
    """同色の板に片切りスイッチのレバー"""
    a = canvas(C_DECOR)
    a += noise(31, 2.0)
    a[1:15, 1:15] += 6.0
    a[0, :] = a[15, :] = a[:, 0] = a[:, 15] = np.array(C_DECOR_EDGE, dtype=np.float64)
    a[5:11, 6:10] -= 70.0
    a[5:7, 6:10] -= 30.0
    return save(a, "switch")


def exit_sign(arrow):
    """緑の地に白の走る人と矢印。arrow: left / right / none"""
    seed = {"left": 32, "right": 33, "none": 34}[arrow]
    a = canvas(C_EXIT)
    a += noise(seed, 2.0)
    a[0, :] -= 40.0
    a[15, :] -= 40.0
    a[:, 0] -= 40.0
    a[:, 15] -= 40.0
    person = np.array([228, 236, 224], dtype=np.float64)
    a[4:6, 6:9] = person
    a[6:11, 7:9] = person
    a[7:9, 5:7] = person
    a[9:12, 5:7] = person
    a[9:12, 9:11] = person
    if arrow == "left":
        a[7:9, 1:5] = person
        a[6:10, 1:3] = person
    elif arrow == "right":
        a[7:9, 11:15] = person
        a[6:10, 13:15] = person
    return save(a, f"exit_sign_{arrow}")


def ceiling_vent():
    """通気口(下の面だけ)。格子のスリット"""
    a = canvas(C_CEIL)
    a += noise(35, 2.0)
    y, x = np.mgrid[0:S, 0:S]
    frame = (x < 2) | (x >= 14) | (y < 2) | (y >= 14)
    a[frame] -= 30.0
    inner = (~frame)
    slats = inner & (y % 3 == 1)
    a[slats] = np.array(C_VENT_DARK, dtype=np.float64)
    a[inner & ~slats] -= 18.0
    return save(a, "ceiling_vent")


def ceiling_stained():
    """水ジミの天井タイル(下の面だけ)。彩度を落とした茶色〜黄土色の、輪郭が不揃いな輪ジミ。
    天井タイルの穴模様(ceiling() と同じマスク)は残す(修正ラウンド2)"""
    a = canvas(C_CEIL)
    a += noise(36, 2.0)
    y, x = np.mgrid[0:S, 0:S]
    holes = ((x % 3 == 1) & (y % 3 == 1)) | ((x % 3 == 0) & (y % 3 == 2))
    a[holes] -= 30.0

    cy, cx = 8.3, 7.6
    dy, dx = y - cy, x - cx
    theta = np.arctan2(dy, dx)
    # 低次+高次の波を重ねて輪郭を歪ませる(完全な円にしない)
    wobble = 1.1 * np.sin(theta * 3.0 + 0.6) + 0.7 * np.sin(theta * 5.0 - 1.3)
    r = np.hypot(dy, dx * 1.15) + wobble
    width = 1.1 + 0.6 * np.sin(theta * 4.0 + 2.0)  # 場所によって輪の太さを変える(太い所・細い所)
    ring = (r > 5.0 - width) & (r < 5.0 + width)
    gap = np.cos(theta * 2.0 - 0.8) > 0.82  # ところどころ途切れる
    ring &= ~gap
    mottle = (r <= 5.0 - width) & (noise(361, 1.0)[:, :, 0] > 0.4)  # 内側の薄いムラ

    mix = np.array(C_STAIN_MIX, dtype=np.float64)
    a[ring] += mix
    a[mottle] += mix * 0.3
    return save(a, "ceiling_stained")


def ceiling_missing():
    """外れた天井タイル(下の面だけ)。暗い空洞に配管1本と配線"""
    a = canvas((20, 18, 14))
    a += noise(37, 3.0)
    y, x = np.mgrid[0:S, 0:S]
    rim = (x < 1) | (x >= 15) | (y < 1) | (y >= 15)
    a[rim] = np.array(C_CEIL, dtype=np.float64) - 20.0
    a[6:8, 2:14] = np.array(C_PIPE, dtype=np.float64)
    a[7, 2:14] -= 30.0
    for i in range(3, 13):
        yy = 10 + (i % 2)
        a[yy, i] = np.array(C_WIRE, dtype=np.float64)
    return save(a, "ceiling_missing")


def floor_stained():
    """床のシミ。暗い不定形が2か所"""
    a = canvas(C_FLOOR)
    a += noise(38, 9.0)
    a += noise(39, 4.0) * np.array([1.0, 0.9, 0.6])
    y, x = np.mgrid[0:S, 0:S]
    for cy, cx, rad, nseed in ((4, 5, 3.0, 40), (11, 10, 2.4, 41)):
        r = np.hypot(y - cy, x - cx)
        blot = r < rad + noise(nseed, 0.6)[:, :, 0]
        a[blot] = np.array(C_FLOOR_STAIN, dtype=np.float64)
    return save(a, "floor_stained")


def floor_wet():
    """濡れたカーペット。-25の色と光沢の点"""
    a = canvas(C_FLOOR)
    a += noise(42, 9.0)
    a -= 25.0
    y, x = np.mgrid[0:S, 0:S]
    gloss = ((x * 7 + y * 13) % 23) == 0
    a[gloss] += 70.0
    return save(a, "floor_wet")


def light_flicker():
    """16x48。点灯/暗い/消灯の3コマを縦に並べる(flipbook_textures.json から参照)。
    phase 0/1/2 用に同じ絵を3ファイル出力する(コマ割りは flipbook_textures.json 側でずらすので絵は同じでよい。最終レビューで足した)"""

    def frame(bright, seed):
        f = canvas(tuple(c * bright for c in C_LIGHT))
        y, x = np.mgrid[0:S, 0:S]
        r = np.hypot(y - 7.5, x - 7.5) / 10.6
        f -= (r**2 * 20.0 * bright)[:, :, None]
        f += noise(seed, 2.0)
        frame_px = (x == 0) | (x == 15) | (y == 0) | (y == 15)
        f[frame_px] = np.array([196, 190, 166], dtype=np.float64) * max(bright, 0.3)
        return f

    imgs = [frame(1.0, 43), frame(0.45, 44), frame(0.12, 45)]
    arr = np.clip(np.vstack(imgs), 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    assert img.size == (S, S * 3), f"light_flicker: {img.size}"
    OUT.mkdir(parents=True, exist_ok=True)
    paths = []
    for name in ("light_flicker", "light_flicker_1", "light_flicker_2"):
        p = OUT / f"{name}.png"
        img.save(p, optimize=True)
        paths.append(p)
    return paths


def light_dead():
    """切れた蛍光灯。灰色で両端が黒ずむ"""
    a = canvas((150, 148, 140))
    a += noise(46, 2.0)
    a[0:3, :] -= 60.0
    a[13:16, :] -= 60.0
    return save(a, "light_dead")


def desk():
    """事務机。天板(灰色化粧板)/脚(銀)/引き出し(灰色に取っ手)を上から帯で塗り分け"""
    a = canvas(C_DESK_TOP)
    a += noise(47, 2.0)
    a[6:11, :] = np.array(C_DESK_LEG, dtype=np.float64)
    a[6:11, :] += noise(48, 1.5)[6:11, :]
    a[11:16, :] = np.array(C_DESK_DRAWER, dtype=np.float64)
    a[11:16, :] += noise(49, 1.5)[11:16, :]
    a[13:14, 3:13] = np.array(C_DESK_HANDLE, dtype=np.float64)
    a[0:1, :] -= 10.0
    return save(a, "desk")


def office_chair():
    """事務椅子。5本脚の台/支柱(銀)/座面/背もたれ(灰色の布地)を帯で塗り分け"""
    a = canvas(C_CHAIR_BASE)
    a += noise(50, 2.0)
    a[4:9, :] = np.array(C_CHAIR_POLE, dtype=np.float64)
    a[4:9, :] += noise(51, 1.5)[4:9, :]
    a[9:13, :] = np.array(C_CHAIR_SEAT, dtype=np.float64)
    a[9:13, :] += noise(52, 1.5)[9:13, :]
    a[13:16, :] = np.array(C_CHAIR_SEAT, dtype=np.float64) - 6.0
    a[13:16, :] += noise(53, 1.5)[13:16, :]
    a[14:15, :] = np.array(C_CHAIR_SEAM, dtype=np.float64)
    return save(a, "office_chair")


def seg_mask(y, x, x0, y0, x1, y1, width):
    """線分(x0,y0)-(x1,y1)から width 未満の距離にある画素を true にする(落書きの線用)"""
    dx, dy = x1 - x0, y1 - y0
    length2 = dx * dx + dy * dy
    if length2 == 0:
        t = np.zeros_like(x, dtype=np.float64)
    else:
        t = ((x - x0) * dx + (y - y0) * dy) / length2
        t = np.clip(t, 0.0, 1.0)
    px, py = x0 + t * dx, y0 + t * dy
    return np.hypot(x - px, y - py) < width


def save_graffiti(mask, seed, name):
    """透明の地に黒ずんだ線。mask の画素だけ不透明(ノイズでムラを付ける)"""
    n = noise(seed, 20.0)[:, :, 0]
    rgba = np.zeros((S, S, 4), dtype=np.float64)
    rgba[..., :3] = C_MARK
    rgba[..., 3] = np.where(mask, np.clip(235.0 + n, 120.0, 255.0), 0.0)
    out = Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8))
    OUT.mkdir(parents=True, exist_ok=True)
    out.save(OUT / f"{name}.png", optimize=True)
    return OUT / f"{name}.png"


def graffiti_0():
    """図柄0: 矢印"""
    y, x = np.mgrid[0:S, 0:S]
    m = seg_mask(y, x, 3, 12, 12, 4, 0.9)
    m |= seg_mask(y, x, 12, 4, 8, 5, 0.9)
    m |= seg_mask(y, x, 12, 4, 11, 8, 0.9)
    return save_graffiti(m, 60, "graffiti_0")


def graffiti_1():
    """図柄1: 正の字(タリーマーク5画)"""
    y, x = np.mgrid[0:S, 0:S]
    m = np.zeros((S, S), dtype=bool)
    for cx in (4, 6, 8, 10):
        m |= seg_mask(y, x, cx, 3, cx, 13, 0.8)
    m |= seg_mask(y, x, 3, 8, 11, 8, 0.8)
    return save_graffiti(m, 61, "graffiti_1")


def graffiti_2():
    """図柄2: 手形"""
    y, x = np.mgrid[0:S, 0:S]
    r = np.hypot(y - 10, x - 8)
    m = r < 3.2
    fingers = (
        ((8, 5), (3, 3)),
        ((7, 7), (2, 5)),
        ((7, 9), (2, 8)),
        ((7, 11), (2, 10)),
        ((9, 13), (4, 12)),
    )
    for (fy, fx), (ty, tx) in fingers:
        m |= seg_mask(y, x, fx, fy, tx, ty, 1.0)
    return save_graffiti(m, 62, "graffiti_2")


def graffiti_3():
    """図柄3: 渦巻き"""
    y, x = np.mgrid[0:S, 0:S]
    theta = np.linspace(0, 4 * np.pi, 60)
    r = np.linspace(0.6, 6.0, 60)
    px, py = 8 + r * np.cos(theta), 8 + r * np.sin(theta)
    m = np.zeros((S, S), dtype=bool)
    for i in range(len(px) - 1):
        m |= seg_mask(y, x, px[i], py[i], px[i + 1], py[i + 1], 0.8)
    return save_graffiti(m, 63, "graffiti_3")


def graffiti_4():
    """図柄4: ×印"""
    y, x = np.mgrid[0:S, 0:S]
    m = seg_mask(y, x, 3, 3, 13, 13, 1.1) | seg_mask(y, x, 3, 13, 13, 3, 1.1)
    return save_graffiti(m, 64, "graffiti_4")


# 3x5ピクセルの数字グリフ(行=上から下、'1'=塗る画素)
DIGIT_GLYPH = {
    "0": ["111", "101", "101", "101", "111"],
    "1": ["010", "110", "010", "010", "111"],
    "2": ["111", "001", "111", "100", "111"],
    "3": ["111", "001", "111", "001", "111"],
    "4": ["101", "101", "111", "001", "001"],
    "5": ["111", "100", "111", "001", "111"],
    "6": ["111", "100", "111", "101", "111"],
    "7": ["111", "001", "010", "010", "010"],
    "8": ["111", "101", "111", "101", "111"],
    "9": ["111", "101", "111", "001", "111"],
}


def graffiti_5():
    """図柄5: 数字の羅列。3x5の数字を2行(上「371」下「409」)、書きなぐった感じにジッターと太さのばらつきを付ける"""
    y, x = np.mgrid[0:S, 0:S]
    m = np.zeros((S, S), dtype=bool)
    rng = np.random.default_rng(66)
    for row_digits, oy0 in (("371", 2.0), ("409", 9.0)):
        ox = 1.6
        for ch in row_digits:
            jx, jy = rng.uniform(-0.6, 0.6), rng.uniform(-0.5, 0.5)
            skew = rng.uniform(-0.4, 0.4)  # 行の中で少し傾いて見えるように x をずらす
            width = 0.62 if rng.random() < 0.5 else 0.42  # 太さのばらつき
            gox, goy = ox + jx, oy0 + jy
            for ry, row in enumerate(DIGIT_GLYPH[ch]):
                for rx, on in enumerate(row):
                    if on != "1":
                        continue
                    py = goy + ry
                    px = gox + rx + skew * (ry - 2) / 4.0
                    m |= seg_mask(y, x, px, py, px + 0.3, py + 0.3, width)
            ox += 4.2 + rng.uniform(-0.3, 0.3)
    return save_graffiti(m, 67, "graffiti_5")


# ---- v0.4.0 マニラルーム(担当Ⓐ)。Backrooms Wiki の Level 0「The Manila Room」の写真に寄せる ----

C_MANILA_GROUND = (168, 140, 132)   # 菱形の格子の線 = 壁紙の地(くすんだ桃色がかったベージュ)
C_MANILA_MOTIF = (216, 200, 188)    # 白っぽいクリームのダマスク柄
C_MANILA_BORDER = (160, 114, 88)    # 天井際の縁取りの帯(赤みのある茶)
C_MANILA_LIGHT = (236, 164, 92)     # 橙色がかった電灯のパネル(通常の蛍光灯より暗い)


# 菱形1つ分のダマスク柄(行 = 上から dy -3..3、列 = 左から dx -3..3、空白は菱形の外 = 地の色)。
# M = 柄のクリーム、m = 柄と地の中間(柄の縁)、h = 柄の芯(明るい)。3案を並べて写真に一番近いものを選んだ
MANILA_STAMP = [
    "   M   ",
    "  mMm  ",
    " MMhMM ",
    "MmMhMmM",
    " MMMMM ",
    "  mMm  ",
    "   M   ",
]


def manila_pattern(seed):
    """菱形の格子(幅8px・高さ8px)に並ぶダマスク柄。周期8なので 16x16 で継ぎ目なく並ぶ。
    菱形の中心は (4,4) と四隅。菱形どうしの境目(中心から L1 距離 4)が地の色の格子の線になる"""
    y, x = np.mgrid[0:S, 0:S]
    ox, oy = x % 8 - 4, y % 8 - 4                            # 中心 (4,4) の菱形からのずれ
    far = np.abs(ox) + np.abs(oy) > 4                        # その外側は四隅の中心の菱形
    dx = np.where(far, ox - 4 * np.sign(ox), ox)
    dy = np.where(far, oy - 4 * np.sign(oy), oy)
    ground = np.array(C_MANILA_GROUND, dtype=np.float64)
    motif = np.array(C_MANILA_MOTIF, dtype=np.float64)
    tone = {"M": motif, "m": (ground + motif) / 2.0, "h": motif + 10.0}
    a = canvas(C_MANILA_GROUND)
    for py in range(S):
        for px in range(S):
            j, i = dy[py, px] + 3, dx[py, px] + 3
            ch = MANILA_STAMP[j][i] if 0 <= j < 7 and 0 <= i < 7 else " "
            if ch in tone:
                a[py, px] = tone[ch]
    a += noise(seed, 2.0)                                    # 紙の地のムラ
    return a


def manila_wall():
    """マニラルームの壁紙。くすんだ桃色がかったベージュの地に白っぽいダマスク柄が菱形の格子に並ぶ"""
    return save(manila_pattern(70), "manila_wall")


def manila_border():
    """天井際の縁取り(壁の最上段)。上の5行が横長の帯、その下は壁紙の続き(下の壁紙ブロックと柄がつながる)"""
    a = manila_pattern(70)
    x = np.arange(S)
    band = np.array(C_MANILA_BORDER, dtype=np.float64)
    a[0:5] = band
    a[0:5] += noise(71, 3.0)[0:5]
    a[2, x % 4 == 1] += 34.0                                 # 帯の中の小さな連続模様
    a[1, x % 4 == 1] += 16.0
    a[3, x % 4 == 1] += 16.0
    a[2, x % 4 == 3] -= 18.0
    a[0] -= 26.0                                             # 帯の上下の見切り線
    a[4] -= 34.0
    a[5] -= 12.0                                             # 帯が壁紙に落とす影
    return save(a, "manila_border")


def manila_light():
    """マニラルームの電灯。橙色がかった鈍い光のパネル(light() と同じ作り)"""
    a = canvas(C_MANILA_LIGHT)
    y, x = np.mgrid[0:S, 0:S]
    r = np.hypot(y - 7.5, x - 7.5) / 10.6
    a -= (r ** 2 * 40.0)[:, :, None]                         # 中央が明るい拡散板
    a += noise(72, 2.0)
    frame = (x == 0) | (x == 15) | (y == 0) | (y == 15)
    a[frame] = np.array([128, 96, 66], dtype=np.float64)     # パネル枠(くすんだ茶)
    return save(a, "manila_light")


# ---- v0.5.0 Level 1(担当Ⓐ)。Backrooms Wiki の Level 1「The Habitable Zone」の写真に寄せる ----
# 明るい灰色〜くすんだ打ちっぱなしのコンクリート。黄土色の Level 0 から色相ごと外し、入った瞬間に別の階層と分かるように

C_L1_WALL = (160, 160, 155)
C_L1_FLOOR = (128, 128, 124)
C_L1_CEIL = (104, 106, 108)
C_L1_LIGHT = (234, 242, 250)   # 白っぽく少し青い蛍光灯
C_L1_RUST = (128, 72, 40)


def blotches(seed, sigma, cell=4):
    """粗いムラ(cell px 角のまだら)。コンクリートの打ち継ぎの色むら"""
    n = np.random.default_rng(seed).normal(0.0, sigma, (S // cell, S // cell))
    return np.kron(n, np.ones((cell, cell)))[:, :, None]


def l1_concrete(seed):
    """打ちっぱなしの壁の地。粒・まだら・型枠の継ぎ目・セパ穴・下の方の水染み"""
    a = canvas(C_L1_WALL)
    a += noise(seed, 5.0)
    a += blotches(seed + 1, 5.0)
    a[7] -= 9.0                                              # 型枠の継ぎ目(横)
    a[8] += 4.0
    for py, px in ((3, 3), (3, 12), (11, 3), (11, 12)):      # セパ穴
        a[py, px] = (92, 92, 90)
        a[py + 1, px] += 10.0
    a[12:16] += np.linspace(-2.0, -14.0, 4)[:, None, None] * np.array([1.0, 1.0, 0.85])  # 下の水染み(わずかに緑がかる)
    return a


def l1_wall():
    return save(l1_concrete(80), "l1_wall")


def l1_rebar():
    """コンクリートが欠けて鉄筋が剥き出しになった壁。欠けは中央の不規則な窪み、錆びた縦2本・横1本"""
    a = l1_concrete(81)
    y, x = np.mgrid[0:S, 0:S]
    r = np.hypot((x - 7.5) / 5.6, (y - 8.0) / 4.6) + np.random.default_rng(84).uniform(-0.18, 0.18, (S, S))
    hole = r < 1.0
    a[hole] = np.array([96, 95, 92], dtype=np.float64) + noise(85, 6.0)[hole]
    rim = (r >= 1.0) & (r < 1.2)
    a[rim] += 16.0                                           # 欠けた縁の明るいかけら
    rust = np.array(C_L1_RUST, dtype=np.float64)
    bars = hole & ((x == 5) | (x == 10) | (y == 8))
    a[bars] = rust + noise(86, 10.0)[bars]
    a[hole & ((x == 5) | (x == 10)) & (y % 3 == 0)] += np.array([34, 24, 14])  # 節のハイライト
    a[hole & (y == 9) & ~((x == 5) | (x == 10))] -= 10.0     # 横筋の影
    a[(y >= 13) & ((x == 5) | (x == 10))] += np.array([-10.0, -20.0, -26.0])  # 錆の垂れ
    return save(a, "l1_rebar")


def l1_floor_base(seed):
    """くすんだコンクリートの床。粒・まだら・細いひび"""
    a = canvas(C_L1_FLOOR)
    a += noise(seed, 6.0)
    a += blotches(seed + 1, 4.0)
    rng = np.random.default_rng(seed + 2)
    px, py = 2, 3
    for _ in range(14):                                      # ひび(左上から右下へのランダムウォーク)
        a[py % S, px % S] -= 26.0
        px += 1
        py += int(rng.integers(0, 2))
    return a


def l1_floor():
    return save(l1_floor_base(82), "l1_floor")


def l1_ceiling():
    """暗めのコンクリートのスラブ。型枠の板目(4px おきの横筋)"""
    a = canvas(C_L1_CEIL)
    a += noise(87, 4.0)
    a += blotches(88, 4.0)
    a[3::4] -= 7.0
    a[0] -= 4.0
    return save(a, "l1_ceiling")


def l1_light():
    """白っぽく少し青い蛍光灯。管2本と枠"""
    a = canvas((214, 222, 232))
    y, x = np.mgrid[0:S, 0:S]
    for r0 in (4, 10):
        a[r0:r0 + 2] = np.array(C_L1_LIGHT, dtype=np.float64)   # 管
        a[r0 - 1] += 6.0
    a -= (np.abs(x - 7.5) / 7.5 * 10.0)[:, :, None]           # 端ほど少し暗い
    a += noise(89, 1.5)
    frame = (x == 0) | (x == 15) | (y == 0) | (y == 15)
    a[frame] = np.array([168, 174, 182], dtype=np.float64)
    return save(a, "l1_light")


def l1_puddle():
    """結露の水たまり。床を暗く・わずかに青くし、粒をならして、蛍光灯の映り込みを少し"""
    a = l1_floor_base(90) * 0.62
    a += np.array([0.0, 3.0, 9.0])
    a = (a + np.roll(a, 1, axis=0) + np.roll(a, 1, axis=1)) / 3.0   # 濡れて粒が見えにくい
    for py, px0, n in ((4, 5, 5), (5, 6, 3), (11, 9, 4)):
        a[py, px0:px0 + n] = np.array([190, 198, 210], dtype=np.float64)
    return save(a, "l1_puddle")


OUT_ITEMS = OUT.parent / "items"

C_OUTLINE = (58, 46, 24)
C_PAPER_BACK = (234, 224, 190)
C_VOID = (12, 9, 14)
C_FIBER = (240, 232, 204)
C_PEARL = (38, 150, 128)
C_PEARL_HI = (130, 236, 204)


def noclip():
    """ノークリップ。Level 0 の壁紙の切れ端に裂け目が走り、奥の虚空にエンダーパールの色がのぞく。

    以前はバニラの ender_pearl アイコンをそのまま使っていて、インベントリで本物のパールと
    見分けがつかなかった。壁紙の黄色(外枠つき)で「Level 0 の物」だと一目で分かるようにする。
    """
    n = S
    y, x = np.mgrid[0:n, 0:n]

    # 紙片: x=1..14, y=1..14。下辺だけ破れてギザギザ(列ごとの下端)
    bottom = np.array([14, 14, 13, 14, 14, 13, 13, 14, 14, 14, 13, 14, 14, 13, 14, 14])
    paper = (x >= 1) & (x <= 14) & (y >= 1) & (y <= bottom[x])
    # 右上の角は折れている(ドッグイヤー)。切り口 x - y = 10 より右上は無い
    paper &= (x - y) <= 10

    rgb = np.full((n, n, 3), C_WALL, dtype=np.float64)
    rgb += np.where((x // 2) % 2 == 0, 9.0, -9.0)[:, :, None]    # 壁紙と同じ 2px の縦ストライプ
    rgb += np.linspace(8.0, -12.0, n)[:, None, None]             # 上が明るい
    rgb += noise(7, 2.5)

    # 折り返し(裏面)。切り口を軸に消えた角を鏡映した三角形。直角が (11, 4)
    flap = paper & (x >= 11) & (y <= 4)
    back = np.array(C_PAPER_BACK, dtype=np.float64) - ((14 - x) * 3.0)[:, :, None]
    rgb = np.where(flap[:, :, None], back, rgb)
    # 折り返しが表に落とす影
    shade = paper & ~flap & (((x == 10) & (y <= 5)) | ((y == 5) & (x >= 10)))
    rgb = np.where(shade[:, :, None], rgb - 34.0, rgb)

    # 裂け目: 行ごとの (左端, 右端)。上から下へ少しずつ右へずれる
    rift = {3: (7, 7), 4: (7, 7), 5: (6, 7), 6: (6, 8), 7: (6, 8), 8: (7, 9), 9: (7, 8), 10: (8, 8), 11: (8, 8)}
    void = np.zeros((n, n), dtype=bool)
    fiber = np.zeros((n, n), dtype=bool)
    for ry, (x0, x1) in rift.items():
        void[ry, x0 : x1 + 1] = True
        fiber[ry, x0 - 1] = True                                 # 縁の紙の繊維。光は左上から
    fiber[2, 7] = fiber[12, 8] = True
    rgb = np.where(void[:, :, None], np.array(C_VOID, dtype=np.float64), rgb)
    rgb = np.where(fiber[:, :, None], np.array(C_FIBER, dtype=np.float64), rgb)
    for py, px in ((6, 7), (8, 8)):                              # 虚空の奥のパール
        rgb[py, px] = C_PEARL
    rgb[7, 7] = C_PEARL_HI

    # 外枠: 紙片の外側に上下左右で接するピクセル。紙の側の縁は少し沈めて厚みを出す
    def touching(mask):
        pad = np.pad(mask, 1)
        return pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]

    outline = touching(paper) & ~paper
    rim = paper & touching(~paper) & ~flap & ~void & ~fiber
    rgb = np.where(rim[:, :, None], rgb - 16.0, rgb)
    rgb = np.where(outline[:, :, None], np.array(C_OUTLINE, dtype=np.float64), rgb)

    rgba = np.dstack([rgb, np.where(paper | outline, 255.0, 0.0)])
    out = Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8))
    OUT_ITEMS.mkdir(parents=True, exist_ok=True)
    out.save(OUT_ITEMS / "noclip.png", optimize=True)
    return OUT_ITEMS / "noclip.png"


C_ALMOND_BOTTLE = (234, 224, 198)   # クリーム色の瓶
C_ALMOND_CAP = (182, 182, 176)      # 銀の蓋
C_ALMOND_LABEL = (222, 138, 52)     # 橙の帯のラベル
C_ALMOND_INK = (150, 70, 30)        # ラベルの字の代わりの点


def almond_water():
    """アーモンドウォーター(v0.4.0)。Wiki(Object 1)の挿絵の、クリーム色の丸い瓶・銀の蓋・橙の帯のラベル。

    実在の商品の銘柄やロゴは描かない(16px なので文字も入らない)。色と形で「瓶入りの飲み物」と分かればよい。
    """
    n = S
    y, x = np.mgrid[0:n, 0:n]
    # 行ごとの (左端, 右端)。蓋 1〜2 / 首 3〜4 / 肩 5 / 胴 6〜13 / 底 14(角は丸い)
    rows = {1: (6, 9), 2: (6, 9), 3: (6, 9), 4: (6, 9), 5: (5, 10), 14: (5, 10)}
    for r in range(6, 14):
        rows[r] = (4, 11)
    body = np.zeros((n, n), dtype=bool)
    for r, (x0, x1) in rows.items():
        body[r, x0 : x1 + 1] = True
    cap = body & (y <= 2)

    rgb = np.full((n, n, 3), C_ALMOND_BOTTLE, dtype=np.float64)
    # 丸みの陰影。光は左上から
    rgb += np.where(x <= 5, 16.0, 0.0)[:, :, None]
    rgb += np.where(x >= 10, -22.0, 0.0)[:, :, None]
    rgb += np.where(y == 14, -18.0, 0.0)[:, :, None]
    rgb[5, 6] += 10.0                                            # 肩のつや

    capc = np.array(C_ALMOND_CAP, dtype=np.float64) + np.where(x <= 6, 36.0, np.where(x >= 9, -40.0, 0.0))[:, :, None]
    capc += np.where(y == 2, -24.0, 0.0)[:, :, None]
    rgb = np.where(cap[:, :, None], capc, rgb)

    # 橙の帯のラベル(9〜11 行)と、その上の細い金の線
    label = body & (y >= 9) & (y <= 11)
    labc = np.array(C_ALMOND_LABEL, dtype=np.float64) + np.where(x <= 5, 14.0, np.where(x >= 10, -26.0, 0.0))[:, :, None]
    rgb = np.where(label[:, :, None], labc, rgb)
    for px in (6, 8, 9):
        rgb[10, px] = C_ALMOND_INK
    rgb[8, 5:11] = np.array(C_ALMOND_LABEL, dtype=np.float64) + 30.0

    pad = np.pad(body, 1)
    outline = (pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]) & ~body
    rgb = np.where(outline[:, :, None], np.array(C_OUTLINE, dtype=np.float64), rgb)

    rgba = np.dstack([rgb, np.where(body | outline, 255.0, 0.0)])
    out = Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8))
    OUT_ITEMS.mkdir(parents=True, exist_ok=True)
    out.save(OUT_ITEMS / "almond_water.png", optimize=True)
    return OUT_ITEMS / "almond_water.png"


def pack_icon():
    """パックのアイコン(v0.5.0・256x256)。一点透視の Level 0 の廊下: 黄ばんだ壁紙・カーペット・天井の蛍光灯。
    BP と RP の両方に同じ絵を置く(ゲームのパック一覧で並ぶので揃える)"""
    from PIL import ImageDraw, ImageFilter

    n = 256
    img = Image.new("RGB", (n, n))
    d = ImageDraw.Draw(img)
    vx, vy = n // 2, n // 2 + 10  # 消失点
    # 奥の壁(暗い)を中心に、手前ほど明るい4面を重ねる
    for i in range(24, 0, -1):
        t = i / 24  # 1 = 手前
        half = int(8 + t * (n // 2 - 8))
        top, bot = vy - int(half * 1.1), vy + int(half * 0.9)
        k = 0.35 + 0.65 * t
        d.rectangle([vx - half, top, vx + half, bot], fill=tuple(int(c * k) for c in C_CEIL))  # 天井
        d.polygon([(vx - half, bot), (vx + half, bot), (vx, vy)], fill=tuple(int(c * k) for c in C_FLOOR))  # 床
        d.polygon([(vx - half, top), (vx - half, bot), (vx, vy)], fill=tuple(int(c * k) for c in C_WALL))  # 左壁
        d.polygon([(vx + half, top), (vx + half, bot), (vx, vy)], fill=tuple(int(c * k * 0.92) for c in C_WALL))  # 右壁
        # 壁紙の縦ストライプ(1枚おき)
        if i % 2 == 0:
            d.line([(vx - half, top + 2), (vx - half, bot - 2)], fill=tuple(int(c * k * 0.85) for c in C_WALL), width=2)
            d.line([(vx + half, top + 2), (vx + half, bot - 2)], fill=tuple(int(c * k * 0.8) for c in C_WALL), width=2)
    # 天井の蛍光灯(手前ほど大きく、ぼかして光らせる)
    glow = Image.new("RGB", (n, n))
    g = ImageDraw.Draw(glow)
    for t in (0.2, 0.35, 0.55, 0.85):
        half = int(8 + t * (n // 2 - 8))
        y = vy - int(half * 1.1) + int(half * 0.1)
        w, h = int(half * 0.28), max(2, int(half * 0.07))
        g.rectangle([vx - w, y, vx + w, y + h], fill=C_LIGHT)
    img = Image.composite(glow, img, glow.convert("L").point(lambda p: 255 if p > 0 else 0))
    img = Image.blend(img, Image.eval(glow.filter(ImageFilter.GaussianBlur(10)), lambda p: min(255, p * 2)), 0.25)
    # 奥の暗がり
    d = ImageDraw.Draw(img)
    d.rectangle([vx - 6, vy - 7, vx + 6, vy + 8], fill=(40, 36, 22))
    outs = []
    for pack in ("BackroomsBP", "BackroomsRP"):
        p = OUT.parent.parent.parent / pack / "pack_icon.png"
        img.save(p, optimize=True)
        outs.append(p)
    return outs


def main():
    for f in (
        pack_icon,
        wall,
        floor,
        ceiling,
        light,
        exit_door,
        outlet,
        switch,
        lambda: exit_sign("left"),
        lambda: exit_sign("right"),
        lambda: exit_sign("none"),
        ceiling_vent,
        ceiling_stained,
        ceiling_missing,
        floor_stained,
        floor_wet,
        light_flicker,
        light_dead,
        desk,
        office_chair,
        graffiti_0,
        graffiti_1,
        graffiti_2,
        graffiti_3,
        graffiti_4,
        graffiti_5,
        manila_wall,
        manila_border,
        manila_light,
        l1_wall,
        l1_rebar,
        l1_floor,
        l1_ceiling,
        l1_light,
        l1_puddle,
        noclip,
        almond_water,
    ):
        result = f()
        for p in result if isinstance(result, list) else [result]:
            print(f"{p.name}: {Image.open(p).size} {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()
