# -*- coding: utf-8 -*-
"""v0.3.0 の小物13種を生成する(担当②・タスクB1〜B3)。

    python tools/gen_blocks.py

出力:
  BackroomsBP/blocks/{outlet,switch,exit_sign,ceiling_vent,ceiling_stained,ceiling_missing,
                       floor_stained,floor_wet,light_flicker,light_dead,desk,office_chair,graffiti}.json
  BackroomsRP/models/blocks/{outlet,switch,exit_sign,desk,office_chair,graffiti}.geo.json
  BackroomsRP/textures/terrain_texture.json (既存5キー + 新規キー全体を書く)
  BackroomsRP/textures/flipbook_textures.json

既存5種(wall/floor/ceiling/light/exit_door)の JSON は出力しない(触らない)。
向きの回転・permutation の書き方は unit-B-brief.md の取り決めどおり。
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_BLOCKS = ROOT / "BackroomsBP" / "blocks"
OUT_MODELS = ROOT / "BackroomsRP" / "models" / "blocks"
TERRAIN_JSON = ROOT / "BackroomsRP" / "textures" / "terrain_texture.json"
FLIPBOOK_JSON = ROOT / "BackroomsRP" / "textures" / "flipbook_textures.json"


def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


# ---- terrain_texture.json(既存5キーは値も含めて必ず残す) ----

EXISTING_TERRAIN = {
    "backrooms_wall": "textures/blocks/wall",
    "backrooms_floor": "textures/blocks/floor",
    "backrooms_ceiling": "textures/blocks/ceiling",
    "backrooms_light": "textures/blocks/light",
    "backrooms_exit_door": "textures/blocks/exit_door",
}

NEW_TERRAIN = {
    "backrooms_outlet": "textures/blocks/outlet",
    "backrooms_switch": "textures/blocks/switch",
    "backrooms_exit_sign_left": "textures/blocks/exit_sign_left",
    "backrooms_exit_sign_right": "textures/blocks/exit_sign_right",
    "backrooms_exit_sign_none": "textures/blocks/exit_sign_none",
    "backrooms_ceiling_vent": "textures/blocks/ceiling_vent",
    "backrooms_ceiling_stained": "textures/blocks/ceiling_stained",
    "backrooms_ceiling_missing": "textures/blocks/ceiling_missing",
    "backrooms_floor_stained": "textures/blocks/floor_stained",
    "backrooms_floor_wet": "textures/blocks/floor_wet",
    "backrooms_light_flicker": "textures/blocks/light_flicker",
    "backrooms_light_flicker_1": "textures/blocks/light_flicker_1",
    "backrooms_light_flicker_2": "textures/blocks/light_flicker_2",
    "backrooms_light_dead": "textures/blocks/light_dead",
    "backrooms_desk": "textures/blocks/desk",
    "backrooms_office_chair": "textures/blocks/office_chair",
    **{f"backrooms_graffiti_{i}": f"textures/blocks/graffiti_{i}" for i in range(6)},
    # v0.4.0 のマニラルーム(JSON は手書き)。ここに無いと、このスクリプトを流したとき terrain_texture.json から消える
    "backrooms_manila_wall": "textures/blocks/manila_wall",
    "backrooms_manila_border": "textures/blocks/manila_border",
    "backrooms_manila_light": "textures/blocks/manila_light",
}

# v0.5.0 Level 1(INTERFACES.md 9.2・担当Ⓐ)
L1_BLOCKS = ["l1_wall", "l1_rebar", "l1_floor", "l1_ceiling", "l1_light", "l1_puddle"]
L1_TERRAIN = {f"backrooms_{b}": f"textures/blocks/{b}" for b in L1_BLOCKS}


def gen_terrain_texture():
    data = {}
    for k, v in {**EXISTING_TERRAIN, **NEW_TERRAIN, **L1_TERRAIN}.items():
        data[k] = {"textures": v}
    doc = {
        "resource_pack_name": "backrooms",
        "texture_name": "atlas.terrain",
        "padding": 8,
        "num_mip_levels": 4,
        "texture_data": data,
    }
    return write_json(TERRAIN_JSON, doc)


def gen_flipbook():
    # 点いている時間が長く、ときどき2〜3コマ消える基本パターン(旧・唯一の light_flicker のコマ割り)。
    # flipbook は全ブロック共通の時計で動くため、3つのブロック(phase 0..2)がこの同じパターンを
    # 別の位置から再生することで、点滅が世界中で同時に起きないようにする(最終レビューで足した)。
    base = (
        [0] * 12 + [1, 2, 0, 0]
        + [0] * 12 + [2, 1, 2, 0]
        + [0] * 8 + [1] + [0] * 7
        + [0] * 4 + [2, 2, 2, 1, 0, 0]
    )

    def rotate(frames, k):
        k %= len(frames)
        return frames[-k:] + frames[:-k] if k else list(frames)

    specs = [
        ("backrooms_light_flicker", "textures/blocks/light_flicker", base),
        ("backrooms_light_flicker_1", "textures/blocks/light_flicker_1", rotate(base, 19)),
        ("backrooms_light_flicker_2", "textures/blocks/light_flicker_2", rotate(base, 39)),
    ]
    doc = [
        {
            "flipbook_texture": path,
            "atlas_tile": tile,
            "ticks_per_frame": 2,
            "blend_frames": False,  # コマの間を補間させず、パッと消える(既定は補間ありのため明示)
            "frames": frames,
        }
        for tile, path, frames in specs
    ]
    return write_json(FLIPBOOK_JSON, doc)


# ---- ブロック JSON の共通部品 ----

ROT = [
    ("north", [0, 0, 0]),
    ("west", [0, 90, 0]),
    ("south", [0, 180, 0]),
    ("east", [0, -90, 0]),
]


def block_shell(identifier, components, extra_desc=None):
    desc = {"identifier": identifier, "menu_category": {"category": "construction"}}
    if extra_desc:
        desc.update(extra_desc)
    return {"format_version": "1.26.20", "minecraft:block": {"description": desc, "components": components}}


def mi(texture, render_method="opaque"):
    """material_instances の "*" だけの単純な形(面ごとの絵はモデルの UV 側で分ける)"""
    return {"*": {"texture": texture, "render_method": render_method}}


# ---- Task B1: 天井・床・蛍光灯の変化(7種。geometry.full_block・状態なし) ----


def gen_full_block(name, light, material_instances):
    components = {
        "minecraft:display_name": f"tile.backrooms:{name}.name",
        "minecraft:geometry": "minecraft:geometry.full_block",
        "minecraft:material_instances": material_instances,
        "minecraft:destructible_by_mining": False,
        "minecraft:destructible_by_explosion": False,
    }
    if light:
        components["minecraft:light_emission"] = light
    return write_json(OUT_BLOCKS / f"{name}.json", block_shell(f"backrooms:{name}", components))


def gen_b1():
    out = []
    out.append(
        gen_full_block(
            "ceiling_vent", 0, {"*": {"texture": "backrooms_ceiling", "render_method": "opaque"}, "down": {"texture": "backrooms_ceiling_vent", "render_method": "opaque"}}
        )
    )
    out.append(
        gen_full_block(
            "ceiling_stained", 0, {"*": {"texture": "backrooms_ceiling", "render_method": "opaque"}, "down": {"texture": "backrooms_ceiling_stained", "render_method": "opaque"}}
        )
    )
    out.append(
        gen_full_block(
            "ceiling_missing", 0, {"*": {"texture": "backrooms_ceiling", "render_method": "opaque"}, "down": {"texture": "backrooms_ceiling_missing", "render_method": "opaque"}}
        )
    )
    out.append(gen_full_block("floor_stained", 0, mi("backrooms_floor_stained")))
    out.append(gen_full_block("floor_wet", 0, mi("backrooms_floor_wet")))
    out.append(gen_light_flicker())
    out.append(gen_full_block("light_dead", 0, mi("backrooms_light_dead")))
    return out


def gen_light_flicker():
    """点滅する蛍光灯。backrooms:phase(0..2)で material_instances のテクスチャを切り替える
    (flipbook のコマ割りをブロックごとにずらすため。最終レビューで足した)。光量13・壊せない設定は変えない"""
    phase_tex = {0: "backrooms_light_flicker", 1: "backrooms_light_flicker_1", 2: "backrooms_light_flicker_2"}
    components = {
        "minecraft:display_name": "tile.backrooms:light_flicker.name",
        "minecraft:geometry": "minecraft:geometry.full_block",
        "minecraft:material_instances": mi(phase_tex[0]),
        "minecraft:destructible_by_mining": False,
        "minecraft:destructible_by_explosion": False,
        "minecraft:light_emission": 13,
    }
    perms = [
        {"condition": f"q.block_state('backrooms:phase') == {phase}", "components": {"minecraft:material_instances": mi(tex)}}
        for phase, tex in phase_tex.items()
    ]
    j = block_shell("backrooms:light_flicker", components, {"states": {"backrooms:phase": [0, 1, 2]}})
    j["minecraft:block"]["permutations"] = perms
    return write_json(OUT_BLOCKS / "light_flicker.json", j)


# ---- geometry(小物の立体) ----


def cube(origin, size, uv):
    """uv: {face: (u, v, uw, uh)}"""
    return {
        "origin": list(origin),
        "size": list(size),
        "uv": {face: {"uv": [u, v], "uv_size": [uw, uh]} for face, (u, v, uw, uh) in uv.items()},
    }


def write_geo(name, cubes):
    doc = {
        "format_version": "1.12.0",
        "minecraft:geometry": [
            {
                "description": {
                    "identifier": f"geometry.backrooms.{name}",
                    "texture_width": 16,
                    "texture_height": 16,
                },
                "bones": [{"name": "root", "pivot": [0, 0, 0], "cubes": cubes}],
            }
        ],
    }
    return write_json(OUT_MODELS / f"{name}.geo.json", doc)


# 板もの(outlet/switch/exit_sign)共通の UV: north 面いっぱいに絵、他の面はコーナー(縁色)を引き伸ばす
EDGE_UV = (15, 15, 1, 1)


def board_uv(front=(0, 0, 16, 16)):
    return {
        "north": front,
        "south": EDGE_UV,
        "east": EDGE_UV,
        "west": EDGE_UV,
        "up": EDGE_UV,
        "down": EDGE_UV,
    }


def facing_permutations(extra_components=None):
    perms = []
    for facing, rot in ROT:
        comp = {"minecraft:transformation": {"rotation": rot}}
        if extra_components:
            comp.update(extra_components)
        perms.append({"condition": f"q.block_state('minecraft:cardinal_direction') == '{facing}'", "components": comp})
    return perms


# y_rotation_offset 180: このトレイトの cardinal_direction は「置いた人が見ている方角」なので、
# 反転しないと壁を向いて置いたときに表が壁側を向く(最終レビューで足した。wiki.bedrock.dev の block-traits と同じ形)
TRAITS_FACING = {
    "minecraft:placement_direction": {
        "enabled_states": ["minecraft:cardinal_direction"],
        "y_rotation_offset": 180,
    }
}


# ---- Task B2: 壁の小物(outlet / switch / exit_sign) ----


def gen_b2():
    write_geo("outlet", [cube([-2, 3, 7], [4, 6, 1], board_uv())])
    components = {
        "minecraft:display_name": "tile.backrooms:outlet.name",
        "minecraft:geometry": "geometry.backrooms.outlet",
        "minecraft:material_instances": mi("backrooms_outlet"),
        "minecraft:collision_box": False,
        "minecraft:selection_box": {"origin": [-2, 3, 7], "size": [4, 6, 1]},
        "minecraft:light_dampening": 0,
        "minecraft:destructible_by_mining": {"seconds_to_destroy": 0.3},
        "minecraft:destructible_by_explosion": {"explosion_resistance": 1},
    }
    j = block_shell("backrooms:outlet", components, {"traits": TRAITS_FACING})
    j["minecraft:block"]["permutations"] = facing_permutations()
    write_json(OUT_BLOCKS / "outlet.json", j)

    write_geo("switch", [cube([-1.5, 3, 7], [3, 5, 1], board_uv())])
    components = {
        "minecraft:display_name": "tile.backrooms:switch.name",
        "minecraft:geometry": "geometry.backrooms.switch",
        "minecraft:material_instances": mi("backrooms_switch"),
        "minecraft:collision_box": False,
        "minecraft:selection_box": {"origin": [-1.5, 3, 7], "size": [3, 5, 1]},
        "minecraft:light_dampening": 0,
        "minecraft:destructible_by_mining": {"seconds_to_destroy": 0.3},
        "minecraft:destructible_by_explosion": {"explosion_resistance": 1},
    }
    j = block_shell("backrooms:switch", components, {"traits": TRAITS_FACING})
    j["minecraft:block"]["permutations"] = facing_permutations()
    write_json(OUT_BLOCKS / "switch.json", j)

    write_geo("exit_sign", [cube([-5, 5, 7], [10, 5, 1], board_uv())])
    arrow_tex = {0: "backrooms_exit_sign_left", 1: "backrooms_exit_sign_right", 2: "backrooms_exit_sign_none"}
    components = {
        "minecraft:display_name": "tile.backrooms:exit_sign.name",
        "minecraft:geometry": "geometry.backrooms.exit_sign",
        "minecraft:material_instances": mi(arrow_tex[2]),
        "minecraft:light_emission": 3,
        "minecraft:collision_box": False,
        "minecraft:selection_box": {"origin": [-5, 5, 7], "size": [10, 5, 1]},
        "minecraft:light_dampening": 0,
        "minecraft:destructible_by_mining": {"seconds_to_destroy": 0.3},
        "minecraft:destructible_by_explosion": {"explosion_resistance": 1},
    }
    perms = []
    for facing, rot in ROT:
        for arrow, tex in arrow_tex.items():
            cond = f"q.block_state('minecraft:cardinal_direction') == '{facing}' && q.block_state('backrooms:arrow') == {arrow}"
            perms.append({"condition": cond, "components": {"minecraft:transformation": {"rotation": rot}, "minecraft:material_instances": mi(tex)}})
    j = block_shell(
        "backrooms:exit_sign",
        components,
        {"traits": TRAITS_FACING, "states": {"backrooms:arrow": [0, 1, 2]}},
    )
    j["minecraft:block"]["permutations"] = perms
    write_json(OUT_BLOCKS / "exit_sign.json", j)
    return len(perms)


# ---- Task B3: 事務机・事務椅子・壁の落書き ----

# desk.png の帯: y0-5 天板 / y6-10 脚 / y11-15 引き出し(y13 に取っ手)
DESK_TOP_UV = (0, 0, 16, 6)
DESK_LEG_UV = (0, 6, 16, 5)
DESK_DRAWER_UV = (0, 11, 16, 2)
DESK_DRAWER_FRONT_UV = (0, 12, 16, 3)


def solid_uv(rect):
    return {f: rect for f in ("north", "south", "east", "west", "up", "down")}


def gen_desk():
    cubes = [
        cube([-8, 12, -8], [16, 2, 16], solid_uv(DESK_TOP_UV)),
        cube([-7, 0, -7], [2, 12, 2], solid_uv(DESK_LEG_UV)),
        cube([5, 0, -7], [2, 12, 2], solid_uv(DESK_LEG_UV)),
        cube(
            [-7, 0, 1],
            [14, 12, 6],
            {**solid_uv(DESK_DRAWER_UV), "north": DESK_DRAWER_FRONT_UV},
        ),
    ]
    write_geo("desk", cubes)
    box = {"origin": [-8, 0, -8], "size": [16, 14, 16]}
    components = {
        "minecraft:display_name": "tile.backrooms:desk.name",
        "minecraft:geometry": "geometry.backrooms.desk",
        "minecraft:material_instances": mi("backrooms_desk"),
        "minecraft:collision_box": box,
        "minecraft:selection_box": box,
        "minecraft:light_dampening": 0,
        "minecraft:destructible_by_mining": {"seconds_to_destroy": 1.0},
        "minecraft:destructible_by_explosion": {"explosion_resistance": 3},
    }
    j = block_shell("backrooms:desk", components, {"traits": TRAITS_FACING})
    j["minecraft:block"]["permutations"] = facing_permutations()
    write_json(OUT_BLOCKS / "desk.json", j)


# office_chair.png の帯: y0-3 台 / y4-8 支柱 / y9-12 座面 / y13-15 背もたれ
CHAIR_BASE_UV = (0, 0, 16, 4)
CHAIR_POLE_UV = (0, 4, 16, 5)
CHAIR_SEAT_UV = (0, 9, 16, 4)
CHAIR_BACK_UV = (0, 13, 16, 3)


def gen_office_chair():
    cubes = [
        cube([-5, 0, -5], [10, 1, 10], solid_uv(CHAIR_BASE_UV)),
        cube([-1, 1, -1], [2, 6, 2], solid_uv(CHAIR_POLE_UV)),
        cube([-5, 7, -5], [10, 2, 10], solid_uv(CHAIR_SEAT_UV)),
        cube([-5, 9, 3], [10, 9, 2], solid_uv(CHAIR_BACK_UV)),
    ]
    write_geo("office_chair", cubes)
    box = {"origin": [-5, 0, -5], "size": [10, 9, 10]}
    components = {
        "minecraft:display_name": "tile.backrooms:office_chair.name",
        "minecraft:geometry": "geometry.backrooms.office_chair",
        "minecraft:material_instances": mi("backrooms_office_chair"),
        "minecraft:collision_box": box,
        "minecraft:selection_box": box,
        "minecraft:light_dampening": 0,
        "minecraft:destructible_by_mining": {"seconds_to_destroy": 1.0},
        "minecraft:destructible_by_explosion": {"explosion_resistance": 3},
    }
    j = block_shell("backrooms:office_chair", components, {"traits": TRAITS_FACING})
    j["minecraft:block"]["permutations"] = facing_permutations()
    write_json(OUT_BLOCKS / "office_chair.json", j)


def gen_graffiti():
    # 厚み0の板。north 面だけに UV を書く(表の絵が見えるのは -Z 側から)
    cube_def = {"origin": [-7, 1, 7.9], "size": [14, 14, 0], "uv": {"north": {"uv": [0, 0], "uv_size": [16, 16]}}}
    write_geo("graffiti", [cube_def])
    components = {
        "minecraft:display_name": "tile.backrooms:graffiti.name",
        "minecraft:geometry": "geometry.backrooms.graffiti",
        "minecraft:material_instances": mi("backrooms_graffiti_0", "alpha_test"),
        "minecraft:collision_box": False,
        # 見た目(geometry)は厚み0のままだが、選択範囲だけ+Z端に奥行き1pxを持たせる。
        # 奥行き0だと視線判定が当たらずプレイヤーが狙えない恐れがある(修正ラウンド1・統合側の指摘)
        "minecraft:selection_box": {"origin": [-7, 1, 7], "size": [14, 14, 1]},
        "minecraft:light_dampening": 0,
        "minecraft:destructible_by_mining": {"seconds_to_destroy": 0.3},
        "minecraft:destructible_by_explosion": {"explosion_resistance": 1},
    }
    perms = []
    for facing, rot in ROT:
        for design in range(6):
            cond = f"q.block_state('minecraft:cardinal_direction') == '{facing}' && q.block_state('backrooms:design') == {design}"
            perms.append(
                {
                    "condition": cond,
                    "components": {
                        "minecraft:transformation": {"rotation": rot},
                        "minecraft:material_instances": mi(f"backrooms_graffiti_{design}", "alpha_test"),
                    },
                }
            )
    j = block_shell(
        "backrooms:graffiti",
        components,
        {"traits": TRAITS_FACING, "states": {"backrooms:design": [0, 1, 2, 3, 4, 5]}},
    )
    j["minecraft:block"]["permutations"] = perms
    write_json(OUT_BLOCKS / "graffiti.json", j)
    return len(perms)


# ---- v0.5.0 Level 1 の6種(担当Ⓐ)。壊せる/壊せないは Level 0 に倣う: 壁(鉄筋の壁も)は壊せる、床・天井・照明・水たまりは壊せない ----


def gen_level1():
    out = []
    for name in ("l1_wall", "l1_rebar"):
        components = {
            "minecraft:display_name": f"tile.backrooms:{name}.name",
            "minecraft:geometry": "minecraft:geometry.full_block",
            "minecraft:material_instances": mi(f"backrooms_{name}"),
            "minecraft:light_emission": 0,
            "minecraft:destructible_by_mining": {"seconds_to_destroy": 0.8},
            "minecraft:destructible_by_explosion": {"explosion_resistance": 1},
        }
        out.append(write_json(OUT_BLOCKS / f"{name}.json", block_shell(f"backrooms:{name}", components)))
    out.append(gen_full_block("l1_floor", 0, mi("backrooms_l1_floor")))
    out.append(gen_full_block("l1_ceiling", 0, mi("backrooms_l1_ceiling")))
    out.append(gen_full_block("l1_light", 13, mi("backrooms_l1_light")))
    out.append(gen_full_block("l1_puddle", 0, mi("backrooms_l1_puddle")))
    return out


def main():
    gen_terrain_texture()
    gen_level1()
    gen_flipbook()
    gen_b1()
    exit_sign_perms = gen_b2()
    gen_desk()
    gen_office_chair()
    graffiti_perms = gen_graffiti()
    print(f"7 blocks (B1) + outlet/switch/exit_sign({exit_sign_perms} perms) (B2) + desk/office_chair/graffiti({graffiti_perms} perms) (B3) を生成した")


if __name__ == "__main__":
    main()
