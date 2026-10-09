# -*- coding: utf-8 -*-
"""Level 0 のエンティティ3体(フェイスリング・ハウンド・スマイラー)のモデルとテクスチャを生成する。

    python tools/gen_entities.py

出力: BackroomsRP/models/entity/{shadow,hound,smiler}.geo.json
      BackroomsRP/textures/entity/{shadow,shadow_1,shadow_2,hound,smiler}.png

姿は Backrooms Wiki（backrooms.fandom.com。Entity 3 Smilers / Entity 8 Hounds / Entity 9 Facelings）の
記述と挿絵を元にしている。フェイスリングの ID は、最初に「人影」として作ったときの backrooms:shadow のまま
（ID は変えない）。

モデルとテクスチャを同じ場所で作るのは、UV の食い違いを起こさないため。
立方体の面ごとに UV を割り当てる(面ごとの uv 指定)ので、ボックス UV の展開図の向きを
覚えておく必要が無い。面の塗りは painter(面名, 幅, 高さ) が返す RGBA 配列で決める。

モデルの前は -Z(north)。バニラの四つ足(牛・豚)も頭が -Z 側にある。
冪等。乱数は固定シードの default_rng のみ。
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "BackroomsRP"
OUT_GEO = ROOT / "models" / "entity"
OUT_TEX = ROOT / "textures" / "entity"

# 面の大きさ(テクスチャ上の幅, 高さ)を立方体の size (x, y, z) から出す
FACE_DIMS = {
    "north": lambda s: (s[0], s[1]),
    "south": lambda s: (s[0], s[1]),
    "east": lambda s: (s[2], s[1]),
    "west": lambda s: (s[2], s[1]),
    "up": lambda s: (s[0], s[2]),
    "down": lambda s: (s[0], s[2]),
}
SIDES = ("north", "south", "east", "west")


class Model:
    """ボーンと立方体を積み、面ごとの UV をテクスチャに棚詰めで割り付ける"""

    def __init__(self, name, tex_w, tex_h):
        self.name = name
        self.tw, self.th = tex_w, tex_h
        self.bones = []
        self.img = np.zeros((tex_h, tex_w, 4), dtype=np.float64)
        self.cx = self.cy = self.row_h = 0

    def bone(self, name, pivot, parent=None, rotation=None):
        b = {"name": name, "pivot": list(pivot)}
        if parent:
            b["parent"] = parent
        if rotation:
            b["rotation"] = list(rotation)
        self.bones.append(b)
        return b

    def _alloc(self, w, h):
        if self.cx + w > self.tw:
            self.cx, self.cy, self.row_h = 0, self.cy + self.row_h, 0
        assert self.cy + h <= self.th, f"{self.name}: テクスチャ {self.tw}x{self.th} に収まらない"
        u, v = self.cx, self.cy
        self.cx += w
        self.row_h = max(self.row_h, h)
        return u, v

    def cube(self, bone, origin, size, painter, faces=None):
        """faces を省くと6面すべて。面積0の面(厚み0の板など)は自動で落とす"""
        uv = {}
        for face in faces or FACE_DIMS:
            w, h = FACE_DIMS[face](size)
            if w == 0 or h == 0:
                continue
            u, v = self._alloc(w, h)
            tile = painter(face, w, h)
            assert tile.shape == (h, w, 4), f"{self.name}/{bone['name']}/{face}: {tile.shape}"
            self.img[v : v + h, u : u + w] = tile
            uv[face] = {"uv": [u, v], "uv_size": [w, h]}
        bone.setdefault("cubes", []).append({"origin": list(origin), "size": list(size), "uv": uv})

    def save(self, bounds_w, bounds_h, bounds_offset):
        geo = {
            "format_version": "1.12.0",
            "minecraft:geometry": [
                {
                    "description": {
                        "identifier": f"geometry.backrooms.{self.name}",
                        "texture_width": self.tw,
                        "texture_height": self.th,
                        "visible_bounds_width": bounds_w,
                        "visible_bounds_height": bounds_h,
                        "visible_bounds_offset": list(bounds_offset),
                    },
                    "bones": self.bones,
                }
            ],
        }
        OUT_GEO.mkdir(parents=True, exist_ok=True)
        geo_path = OUT_GEO / f"{self.name}.geo.json"
        geo_path.write_text(json.dumps(geo, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        return geo_path, self.save_texture(self.name)

    def save_texture(self, name):
        """同じ UV の割り付けで塗り分けた別のテクスチャ(バリアント)も、この関数で書き出す"""
        OUT_TEX.mkdir(parents=True, exist_ok=True)
        tex_path = OUT_TEX / f"{name}.png"
        Image.fromarray(np.clip(self.img, 0, 255).astype(np.uint8)).save(tex_path, optimize=True)
        return tex_path


# ---- 塗り ----


def flat(color, seed, sigma, shade=None):
    """単色 + 粒ノイズ。shade は面ごとの明るさの足し引き(上面を明るく・下面を暗く等)"""
    rng = np.random.default_rng(seed)

    def paint(face, w, h):
        t = np.empty((h, w, 4))
        t[:, :, :3] = np.array(color, dtype=np.float64) + rng.normal(0.0, sigma, (h, w))[:, :, None]
        t[:, :, :3] += (shade or {}).get(face, 0.0)
        t[:, :, 3] = 255.0
        return t

    return paint


def mottle(color, seed, amp, scale=4, shade=None):
    """低周波のまだら。粒ノイズと違い、数ピクセルのかたまりで濃淡が変わる(皮膚のまだら用)"""
    rng = np.random.default_rng(seed)

    def paint(face, w, h):
        sw, sh = max(2, w // scale + 2), max(2, h // scale + 2)
        small = rng.uniform(-amp, amp, (sh, sw)).astype(np.float32)
        big = np.asarray(Image.fromarray(small).resize((w, h), Image.Resampling.BILINEAR))
        t = np.empty((h, w, 4))
        t[:, :, :3] = np.array(color, dtype=np.float64) + big[:, :, None]
        t[:, :, :3] += (shade or {}).get(face, 0.0)
        t[:, :, 3] = 255.0
        return t

    return paint


def solid(rgb, alpha=255.0):
    def paint(face, w, h):
        t = np.zeros((h, w, 4))
        t[:, :, :3] = rgb
        t[:, :, 3] = alpha
        return t

    return paint


def board(m, bone, origin, size, painter, mirror=True):
    """厚み0の板。north にだけ描き、south は同じ絵を使う(左右対称なので鏡でも崩れない)。
    mirror=False なら south は作らない(裏からは見えない板)"""
    m.cube(bone, origin, size, painter, faces=["north"])
    if mirror:
        uv = bone["cubes"][-1]["uv"]
        uv["south"] = dict(uv["north"])


def mirror_x(origin, size):
    """左右対称の相方の origin（x を反転）"""
    return (-origin[0] - size[0], origin[1], origin[2])


# ---- フェイスリング（ID は backrooms:shadow）----
# Wiki の Entity 9 "Facelings": 体つきも服も髪も普通の人間で、顔だけが無い。
# 遠目には人に見え、近づくと顔の部分がのっぺりした肌（皮膚を頭蓋に張ったような・泡の頭のような）だと分かる。
# 服装は出たレベルに合わせる。Level 0 なのでオフィスの人間。服と髪の違う3種類をバリアントで出し分ける。
# 背は 32px（2ブロック）。人と同じ大きさなのが不気味さの元なので、誇張しない。

FACELING_VARIANTS = [
    # 0: 会社員。白いワイシャツ・紺のネクタイ・灰色のスラックス・短い黒髪
    {"skin": (222, 188, 160), "hair": (38, 30, 26), "long_hair": False, "top": (226, 224, 212),
     "tie": (38, 44, 78), "sleeve_skin": 0, "bottom": (72, 72, 78), "shoes": (24, 22, 22), "cardigan": None},
    # 1: 事務員。灰緑のカーディガン・黒いズボン・肩までの髪
    {"skin": (236, 204, 180), "hair": (52, 36, 28), "long_hair": True, "top": (58, 58, 62),
     "tie": None, "sleeve_skin": 0, "bottom": (34, 34, 38), "shoes": (40, 30, 26), "cardigan": (118, 128, 108)},
    # 2: 清掃員。紺のつなぎ・白髪まじりの短髪。袖をまくっている
    {"skin": (200, 164, 134), "hair": (132, 128, 124), "long_hair": False, "top": (46, 60, 92),
     "tie": None, "sleeve_skin": 4, "bottom": (46, 60, 92), "shoes": (30, 28, 26), "cardigan": None},
]


def faceling_painters(v):
    """バリアント v の各部の塗り"""
    skin = mottle(v["skin"], 60, 4.0, scale=3, shade={"up": 6.0, "down": -12.0})
    cloth_shade = {"up": 6.0, "down": -16.0}

    def head(face, w, h):
        t = skin(face, w, h)
        hair = flat(v["hair"], 61, 5.0)(face, w, h)
        rows = {"up": h, "north": 1, "east": 3, "west": 3, "south": h if v["long_hair"] else 6, "down": 0}[face]
        t[:rows] = hair[:rows]
        if face in ("east", "west"):
            t[3:5, 5:, :3] = hair[3:5, 5:, :3]  # もみあげから後ろ
        if face == "north":
            t[1, : w - 3, :3] = hair[1, : w - 3, :3]  # 分け目のある生え際
            # 顔は無い。目・鼻・口のあるはずの場所が、ぼかしたように少しだけ沈んで・膨らんでいる
            t[3:5, 1:7, :3] -= 7.0
            t[4:6, 3:5, :3] += 5.0
            t[6, 2:6, :3] -= 4.0
            t[h - 1, :, :3] -= 8.0  # あごの下
        return t

    def ear(face, w, h):
        t = skin(face, w, h)
        t[:, :, :3] -= 6.0
        return t

    def back_hair(face, w, h):
        t = flat(v["hair"], 62, 5.0, {"down": -10.0})(face, w, h)
        if not v["long_hair"]:
            t[:, :, 3] = 0.0  # 短髪のバリアントでは見えない（材質は alphatest）
        return t

    def torso(face, w, h):
        t = flat(v["top"], 63, 3.0, cloth_shade)(face, w, h)
        if v["cardigan"] is not None and face in SIDES:
            card = flat(v["cardigan"], 64, 4.0, cloth_shade)(face, w, h)
            if face == "north":
                t[:, :2] = card[:, :2]  # 前は開いていて中のシャツが見える
                t[:, w - 2 :] = card[:, w - 2 :]
                t[:, 2, :3] -= 10.0
                t[:, w - 3, :3] -= 10.0
            else:
                t[:] = card
        if face == "north":
            t[0, 3:5, :3] = np.array(v["skin"]) - 10.0  # 襟元の首
            if v["tie"] is not None:
                t[1:8, 3:5, :3] = v["tie"]
                t[8, 3:5, :3] = np.array(v["tie"]) - 12.0
                t[1, 2, :3] = t[1, 5, :3] = np.array(v["top"]) - 20.0  # 襟
            elif v["cardigan"] is None:
                t[1:10, 4, :3] -= 18.0  # つなぎの前立て
        if face in SIDES:
            t[h - 1, :, :3] -= 18.0  # ベルトの位置
        return t

    def arm(face, w, h):
        base = v["cardigan"] if v["cardigan"] is not None else v["top"]
        t = flat(base, 65, 3.0, cloth_shade)(face, w, h)
        hands = 3 + v["sleeve_skin"]
        if face in SIDES:
            t[h - hands :] = skin(face, w, hands)
            t[h - hands - 1, :, :3] -= 14.0  # 袖口
        if face == "down":
            t[:] = skin(face, w, h)
        return t

    def leg(face, w, h):
        t = flat(v["bottom"], 66, 3.0, cloth_shade)(face, w, h)
        if face in SIDES:
            t[h - 2 :] = flat(v["shoes"], 67, 2.0)(face, w, 2)
        if face == "down":
            t[:] = flat(v["shoes"], 67, 2.0)(face, w, h)
        return t

    return {"head": head, "ear": ear, "back_hair": back_hair, "torso": torso, "arm": arm, "leg": leg}


def faceling_model(v):
    p = faceling_painters(v)
    m = Model("shadow", 64, 64)
    m.bone("root", (0, 0, 0))
    body = m.bone("body", (0, 12, 0), "root")
    head = m.bone("head", (0, 24, 0), "body")
    arm_l = m.bone("arm_l", (-5, 23, 0), "body")
    arm_r = m.bone("arm_r", (5, 23, 0), "body")
    leg_l = m.bone("leg_l", (-2, 12, 0), "root")
    leg_r = m.bone("leg_r", (2, 12, 0), "root")
    m.cube(body, (-4, 12, -2), (8, 12, 4), p["torso"])
    m.cube(head, (-4, 24, -4), (8, 8, 8), p["head"])
    m.cube(head, (-5, 27, -1), (1, 2, 1), p["ear"])
    m.cube(head, (4, 27, -1), (1, 2, 1), p["ear"])
    m.cube(head, (-4, 20, 4), (8, 8, 1), p["back_hair"])  # 肩までの髪。短髪のバリアントでは透明
    m.cube(arm_l, (-7, 12, -1.5), (3, 12, 3), p["arm"])
    m.cube(arm_r, (4, 12, -1.5), (3, 12, 3), p["arm"])
    m.cube(leg_l, (-4, 0, -2), (4, 12, 4), p["leg"])
    m.cube(leg_r, (0, 0, -2), (4, 12, 4), p["leg"])
    return m


def shadow():
    models = [faceling_model(v) for v in FACELING_VARIANTS]
    # 3つとも同じ順で立方体を積むので UV の割り付けは同じ。形はバリアント0の geo.json を使う
    for other in models[1:]:
        assert other.bones == models[0].bones, "バリアントで UV の割り付けが食い違った"
    geo, tex = models[0].save(2, 3, (0, 1, 0))
    for i, m in enumerate(models[1:], start=1):
        m.save_texture(f"shadow_{i}")
    return geo, tex


# ---- ハウンド ----
# Wiki の Entity 8 "Hounds": 四つん這いで動く、ひどく痩せた人型。骨ばった細い手足で、前足には人の手の形が残る。
# 背中と頭を長い黒いぼさぼさの毛が覆い、髪の隙間から白く光る目がのぞく。何列もの歯が並ぶ裂けた大口。
# 目は材質 entity_emissive_alpha で光らせる: 半透明のピクセルほど強く発光する（完全に透明にすると消える）。
# だからハウンドのテクスチャは目以外すべて不透明にし、目のピクセルだけ EYE_GLOW_ALPHA にする。

C_SKIN = (138, 126, 112)  # 青白くくすんだ皮膚
C_HAIR = (20, 18, 21)  # 黒い毛
C_EYE = (252, 252, 244)
C_TOOTH = (228, 220, 198)
C_GUM = (112, 40, 44)
C_MAW = (30, 8, 10)
EYE_GLOW_ALPHA = 40.0  # 小さいほど強く光る。0 にはしない
SKIN_SHADE = {"up": 10.0, "down": -22.0}


def hound_skin(seed):
    """皮膚。まだらに、疥癬のような黒ずみの斑点"""
    base = mottle(C_SKIN, seed, 12.0, scale=3, shade=SKIN_SHADE)
    rng = np.random.default_rng(seed + 100)

    def paint(face, w, h):
        t = base(face, w, h)
        t[rng.random((h, w)) < 0.12, :3] -= 30.0
        return t

    return paint


def hound_hair(seed):
    """黒い毛。毛の流れの縦筋と、ところどころの抜け"""
    base = flat(C_HAIR, seed, 4.0, {"up": 6.0, "down": -6.0})
    rng = np.random.default_rng(seed + 200)

    def paint(face, w, h):
        t = base(face, w, h)
        t[:, rng.random(w) < 0.35, :3] += 12.0
        if face in SIDES and h > 2:
            t[h - 1, rng.random(w) < 0.4, :3] += 18.0  # 毛先がばらつく
        return t

    return paint


def hound_chest(face, w, h):
    t = hound_skin(71)(face, w, h)
    if face in ("east", "west"):
        # 浮いた肋骨。側面の UV の向きは実機未確認なので、中央に対して左右対称に置く
        for x in (1, 3, w - 4, w - 2):
            t[1 : h - 1, x, :3] += 26.0
            t[1 : h - 1, x + 1, :3] -= 16.0
    return t


def hound_head(face, w, h):
    t = hound_skin(72)(face, w, h)
    if face == "north":
        # 頭蓋の顔。目の板の後ろは落ちくぼんだ眼窩、鼻は2つの穴、下の端に上の歯
        t[1:4, 0:3, :3] = np.array(C_SKIN) - 70.0
        t[1:4, w - 3 :, :3] = np.array(C_SKIN) - 70.0
        t[3, w // 2 - 1 : w // 2 + 1, :3] = np.array(C_MAW)
        t[h - 1, :, :3] = C_GUM
        t[h - 1, ::2, :3] = C_TOOTH
    return t


def hound_jaw(face, w, h):
    t = hound_skin(73)(face, w, h)
    if face == "up":
        # 顎の内側。歯が何列も並ぶ
        t[:, :, :3] = C_MAW
        for row in range(0, h, 2):
            t[row, ::2, :3] = C_TOOTH
        t[:, 0, :3] = C_GUM
        t[:, w - 1, :3] = C_GUM
    if face == "north":
        t[0, :, :3] = C_TOOTH
        t[0, 1::2, :3] = C_GUM
    return t


def hound_eye(face, w, h):
    t = np.zeros((h, w, 4))
    t[:, :, :3] = C_EYE
    t[:, :, 3] = EYE_GLOW_ALPHA
    t[h - 1, w - 1, :3] = (120, 120, 110)  # 小さな瞳
    return t


def hound_hand(face, w, h):
    t = hound_skin(74)(face, w, h)
    if face == "up":
        t[:, 1::2, :3] -= 24.0  # 指の境目（水かきのようにくっついている）
    if face == "north":
        t[:, 1::2, :3] -= 30.0  # 擦り切れた爪
    return t


def hound():
    m = Model("hound", 128, 64)
    hair = hound_hair
    m.bone("root", (0, 0, 0))
    hips = m.bone("hips", (0, 11, 4), "root")
    chest = m.bone("chest", (0, 12, 0), "hips")
    neck = m.bone("neck", (0, 14, -8), "chest")
    head = m.bone("head", (0, 13, -11), "neck")
    jaw = m.bone("jaw", (0, 10.5, -12), "head", rotation=(18, 0, 0))  # いつも少し開いている
    eyes = m.bone("eyes", (0, 13.5, -17), "head")

    # 胴。胸が広く、腰が細い
    m.cube(hips, (-3.5, 9, 0), (7, 5, 8), hound_skin(75))
    m.cube(chest, (-4.5, 10, -8), (9, 6, 8), hound_chest)
    # 背中の黒い毛。胸と腰で分けて、胴がしなると一緒に動く
    m.cube(chest, (-3.5, 16, -9), (7, 2, 9), hair(80))
    m.cube(chest, (-5.5, 11, -8), (1, 5, 8), hair(81))
    m.cube(chest, (4.5, 11, -8), (1, 5, 8), hair(81))
    m.cube(hips, (-3, 14, 0), (6, 2, 8), hair(82))
    m.cube(hips, (-4.5, 10, 1), (1, 4, 6), hair(83))
    m.cube(hips, (3.5, 10, 1), (1, 4, 6), hair(83))

    # 首と頭
    m.cube(neck, (-1.5, 11, -11), (3, 4, 4), hound_skin(76))
    m.cube(head, (-3.5, 10, -17), (7, 6, 6), hound_head)
    m.cube(head, (-2.5, 9.5, -17), (5, 1, 5), solid(C_MAW))  # 口の奥
    m.cube(jaw, (-3, 8, -18), (6, 2, 6), hound_jaw)
    # 頭の毛: 頭頂を覆い、頬の横と顔の前に垂れる。前の3本の間から目がのぞく
    m.cube(head, (-4, 15, -17.5), (8, 3, 7), hair(84))
    m.cube(head, (-4.5, 8, -17), (1, 8, 6), hair(85))
    m.cube(head, (3.5, 8, -17), (1, 8, 6), hair(85))
    for x in (-3.5, -0.5, 2.5):
        m.cube(head, (x, 11, -18), (1, 5, 1), hair(86))
    # 目は光る板（前の毛の間）
    m.cube(eyes, (-2.5, 12.5, -17.05), (2, 2, 0), hound_eye, faces=["north"])
    m.cube(eyes, (0.5, 12.5, -17.05), (2, 2, 0), hound_eye, faces=["north"])

    # 前足: 細い人の腕。手は平たく、指はくっついている
    for side, px in (("l", -1), ("r", 1)):
        up = m.bone(f"leg_f{side}_upper", (5.5 * px, 13, -6), "chest")
        low = m.bone(f"leg_f{side}_lower", (5.5 * px, 7, -6), up["name"])
        for bone_, origin, size, painter in (
            (up, (-6.5, 7, -7), (2, 6, 2), hound_skin(77)),
            (low, (-6, 1, -6.5), (1, 6, 1), hound_skin(78)),  # 前腕は骨と皮だけ（1px）
            (low, (-7, 0, -8.5), (3, 1, 4), hound_hand),
        ):
            m.cube(bone_, origin if px < 0 else mirror_x(origin, size), size, painter)
    # 後ろ足: 折れ曲がった脚（膝が前、すねが後ろへずれる）
    for side, px in (("l", -1), ("r", 1)):
        up = m.bone(f"leg_b{side}_upper", (3 * px, 11, 5), "hips")
        low = m.bone(f"leg_b{side}_lower", (3 * px, 5, 6), up["name"])
        for bone_, origin, size, painter in (
            (up, (-4.5, 5, 4), (2, 6, 2), hound_skin(79)),
            (low, (-4, 1, 6.5), (1, 4, 1), hound_skin(88)),  # すねも1px
            (low, (-4.5, 0, 4.5), (2, 1, 4), hound_hand),
        ):
            m.cube(bone_, origin if px < 0 else mirror_x(origin, size), size, painter)
    return m.save(3, 2, (0, 0.75, 0))


# ---- スマイラー ----
# Wiki の Entity 3 "Smilers": 体は真っ黒な炎のような不定形で、光る目と歯だけが浮かぶ。弱点は光と火。
# 描画コントローラ controller.render.backrooms.glow（ignore_lighting）で、暗さに関係なく白く見せる。
# 体は黒なので、光を無視しても黒いまま。暗闇では見えず、明るい所を背にしたときだけ輪郭が浮かぶ。

C_SMILE = (248, 246, 236)
C_GAP = (140, 136, 126)
C_LIP = (64, 12, 18)  # 歯茎。暗くして歯の白を立たせる
C_THROAT = (30, 2, 6)
C_BODY = (5, 3, 7)


def smiler_eyes(face, w, h):
    """離れた2つの細い目。外側の端が吊り上がる（左右対称）"""
    t = np.zeros((h, w, 4))
    y, x = np.mgrid[0:h, 0:w]
    for cx, lift in ((3.0, 0.4), (w - 4.0, -0.4)):
        dy = (y - (h - 1) / 2 + (x - cx) * lift) / 0.8
        t[((x - cx) / 2.6) ** 2 + dy**2 <= 1.0] = (*C_SMILE, 255)
    return t


# 笑みの形。幅 GRIN_W の板の上で、列ごとに上唇・歯の合わせ目・下唇の行を決める。
# 端（口角）は上に大きく吊り上がり、真ん中が一番下がる三日月
GRIN_W, GRIN_H = 22, 11


def grin_curves():
    s = (np.arange(GRIN_W) - (GRIN_W - 1) / 2) / ((GRIN_W - 1) / 2)  # -1..1
    bow = 1 - s**2
    top = np.rint(0.5 + 5.0 * bow).astype(int)  # 上唇: 口角 0 → 真ん中 5
    bottom = np.rint(2.0 + 8.0 * bow).astype(int)  # 下唇: 口角 2 → 真ん中 10
    mid = (top + bottom) // 2  # 上下の歯の合わせ目
    return top, mid, bottom


def smiler_teeth(half):
    """上の歯（half="upper"）か下の歯（"lower"）。同じ大きさの板を2枚重ね、攻撃で上下に離す"""

    def paint(face, w, h):
        t = np.zeros((h, w, 4))
        top, mid, bottom = grin_curves()
        for x in range(w):
            a, b = (top[x], mid[x]) if half == "upper" else (mid[x] + 1, bottom[x])
            if b < a:
                continue
            t[a : b + 1, x] = (*C_SMILE, 255)
            edge = a if half == "upper" else b
            t[edge, x] = (*C_LIP, 255)  # 歯茎の線
            if x % 2 == (0 if half == "upper" else 1):
                t[a : b + 1, x] = (*C_GAP, 255)  # 歯の境目
                tip = b if half == "upper" else a
                if b > a:
                    t[tip, x] = (0, 0, 0, 0)  # 尖った歯先
        return t

    return paint


def smiler_throat(face, w, h):
    """口の奥。口を開けたときだけ見える暗がり。四角く透けないよう笑みの形に切り抜く"""
    t = np.zeros((h, w, 4))
    top, _mid, bottom = grin_curves()
    for x in range(w):
        t[top[x] : bottom[x] + 3, x] = (*C_THROAT, 255)  # 下の歯が下がる分、下へ少し長く
    return t


def smiler_body(seed):
    """黒い炎の輪郭。上へ伸びる舌のような先端が不揃いに揺らぐ"""
    rng = np.random.default_rng(seed)

    def paint(face, w, h):
        t = np.zeros((h, w, 4))
        s = np.abs((np.arange(w) - (w - 1) / 2) / ((w - 1) / 2))
        tops = (h * (0.1 + 0.55 * s**1.5) + rng.integers(-3, 4, w) * (s < 0.9)).clip(0, h - 3)
        for x in range(w):
            y0 = int(tops[x])
            t[y0:, x, :3] = C_BODY
            t[y0:, x, 3] = 255
            t[y0:, x, :3] += rng.normal(0, 2.0, (h - y0, 1))
        t[h - 2 :, :, 3] = np.where(rng.random((2, w)) < 0.5, 255, 0)  # 裾はほつれて途切れる
        return t

    return paint


def smiler():
    m = Model("smiler", 64, 64)
    m.bone("root", (0, 0, 0))
    body = m.bone("body", (0, 2, 1), "root")
    head = m.bone("head", (0, 27, 0), "root")
    eyes = m.bone("eyes", (0, 30, 0), "head")
    teeth_upper = m.bone("teeth_upper", (0, 26, 0), "head")
    teeth_lower = m.bone("teeth_lower", (0, 23, 0), "head")
    throat = m.bone("throat", (0, 24, 0), "head")
    # 黒い炎の体。顔より奥に3枚、ずらして重ねる
    board(m, body, (-8, 2, 1.5), (16, 34, 0), smiler_body(90))
    board(m, body, (-10, 2, 2.5), (9, 26, 0), smiler_body(91))
    board(m, body, (1, 2, 2.5), (9, 28, 0), smiler_body(92))
    board(m, eyes, (-9, 30, 0), (18, 4, 0), smiler_eyes)
    board(m, teeth_upper, (-11, 18, -0.5), (GRIN_W, GRIN_H, 0), smiler_teeth("upper"))
    board(m, teeth_lower, (-11, 18, -0.6), (GRIN_W, GRIN_H, 0), smiler_teeth("lower"))
    board(m, throat, (-11, 15, 0.5), (GRIN_W, GRIN_H + 3, 0), smiler_throat, mirror=False)  # north 面だけ
    return m.save(2, 3, (0, 1.2, 0))


def main():
    for f in (shadow, hound, smiler):
        geo, tex = f()
        print(f"{geo.name} / {tex.name}: {Image.open(tex).size}")


if __name__ == "__main__":
    main()
