/**
 * 遺留品の設置（仕様書 6.8 / FR-15）
 *
 * 「誰かがここにいて、そして今はいない」という事実だけを残す。
 * 置くものはすべてブロックかエンティティであり、ドロップアイテムは一切使わない
 * （時間経過で消滅し、再訪時に消えているため・15章が名指しで禁止）。
 *
 * どこに置くかは layout.js の relicAt() が決めている。このファイルは
 * 「決まった場所に、決まったものを、決まった中身で置く」だけを担当する。
 * 中身の選択にも Math.random() は使わない（15章）。乱数は rng.js の hash32 のみ。
 */

import { BlockPermutation, EquipmentSlot, ItemStack, world } from "@minecraft/server";
import { hash32, SALT } from "./rng.js";
import {
  CELL,
  I_ALMOND,
  Y_AIR_MIN,
  B_DESK,
  B_CHAIR,
  B_GRAFFITI,
  S_FACING,
  RELIC_CAMP,
  RELIC_CHEST,
  RELIC_SIGN,
  RELIC_GEAR,
  RELIC_OFFICE,
  RELIC_DIARY,
  RELIC_GRAFFITI,
  RELIC_GEAR_USE_ARMOR_STAND,
} from "./config.js";

// ---- 看板テキスト（6.8）----
//
// 方向の手がかり・状況の記録・意味をなさないもの を混ぜる。
// プレイヤーを直接助ける情報（出口の座標など）は書かない。
// 手がかりのようで手がかりにならないことが、この空間の性格に合う。
//
// 表示制約: ゲーム内フォントは日本語と ASCII しか出ない。
// 装飾記号（矢印・罫線・チェック等）は JIS X 0208 に入っていても豆腐になるので使わない。
// 看板は4行、1行あたり全角8文字程度が上限。
const SIGN_TEXTS = [
  // 方向の手がかり
  "東へ 13時間\nまだ壁",
  "この先 水\n引き返した",
  "右へ 右へ\n右へ\n同じ場所",
  "北 のつもり\nもう\nわからない",
  "下へ 行ける\n場所がある\nらしい",
  // 状況の記録
  "3日目\nまだ出口がない",
  "食料 あと2日\n歩き続ける",
  "水は飲める\n味はしない",
  "電気の音が\n止まらない",
  "ここは通った\n印をつけた\nはずだった",
  "寝た\n朝は来ない",
  // 意味をなさないもの
  "ありがとう",
  "1 2 3 4 5\n6 7 8 9",
  "おかえり",
  "まだ ここに\nいる",
];

// ---- 手記の中身（設計書 3.4）----
//
// 1編 = 1ページ。看板と同じく方向の手がかり・状況の記録・意味をなさないものを混ぜ、住人の手がかりも入れる。
// 出口の座標は書かない。表示制約は看板と同じ（日本語と ASCII と 、。ー だけ。かぎ括弧や三点リーダーも豆腐）。
// 1ページは全角150字まで（ページの上限は256字）。
const DIARY_TEXTS = [
  // 状況の記録
  "3日目。同じ廊下を3回通った気がする。壁のシミが同じ形をしている。気のせいだと思いたい",
  "床に土を置いて目印にした。これで迷わない。迷わないはずだ",
  "今日は何日目だろう。数えるのをやめた日を数えるのもやめた",
  "机を見つけた。引き出しは空だった。誰かがここで仕事をしていたのだろうか",
  "電気の音がずっと鳴っている。止まったら、たぶん自分の耳のほうが止まったのだと思う",
  // 方向の手がかり（手がかりにならない）
  "誘導灯の矢印のとおりに歩いた。3時間歩いた。あれはあてにならない",
  "出口のドアを見た。戻ってきたら無かった。いや、場所を間違えただけだ",
  "上へ行く階段があった。上っても何もなかった。下りたら、少しだけ安心した",
  "水のたまった部屋に出た。水は冷たくて、底が見えなかった。入らなかった",
  // 住人の手がかり
  "暗いところに笑っている顔があった。松明を置いたら消えた。松明はあと4本",
  "後ろを振り返る癖がついた。何もいない。何もいないのに足が速くなる",
  "遠くに人が立っていた。声をかけたら、いなくなった。近づくと消えるらしい",
  "四つ足の何かが走る音を聞いた。犬ではない。犬はあんなに長く走らない",
  // 意味をなさないもの
  "天井のタイルが一枚外れていた。のぞいたら、配管の奥にも黄色い壁があった",
  "ここに来た人はみんな、同じことを書いている気がする。だから私も書いておく",
  "おかえり、と書いてある壁があった。私はここに来たのは初めてのはずだ",
];

// ---- 物資チェストの中身（6.8 / Q-14）----
//
// ルートテーブルは使わない。カスタムディメンションでの動作が未確認（Q-14）であることに加え、
// ルートテーブルはランダムなので FR-4 の決定論性と噛み合わないため。
// 中身は「遭難した人が持っていそうなもの」だけ。鉄・ダイヤ級の装備や貴重品は入れない。
const SUPPLY = [
  { id: "minecraft:bread", min: 1, max: 5 },
  { id: "minecraft:potato", min: 2, max: 8 },
  { id: "minecraft:cooked_beef", min: 1, max: 3 },
  { id: "minecraft:torch", min: 2, max: 12 },
  { id: "minecraft:ladder", min: 1, max: 6 },
  { id: "minecraft:bucket", min: 1, max: 1 },
  { id: "minecraft:string", min: 1, max: 4 },
  { id: "minecraft:paper", min: 1, max: 6 },
];

// ---- 装備の遺留品（6.8 / Q-13）----
// 革・木・石級のみ。使い込まれた状態にする（耐久を減らす）。
const GEAR = [
  { id: "minecraft:leather_helmet", slot: EquipmentSlot.Head },
  { id: "minecraft:leather_chestplate", slot: EquipmentSlot.Chest },
  { id: "minecraft:leather_leggings", slot: EquipmentSlot.Legs },
  { id: "minecraft:leather_boots", slot: EquipmentSlot.Feet },
  { id: "minecraft:wooden_pickaxe", slot: EquipmentSlot.Mainhand },
  { id: "minecraft:stone_pickaxe", slot: EquipmentSlot.Mainhand },
  { id: "minecraft:stone_axe", slot: EquipmentSlot.Mainhand },
  { id: "minecraft:stone_shovel", slot: EquipmentSlot.Mainhand },
  { id: "minecraft:stone_sword", slot: EquipmentSlot.Mainhand },
];

const CARDINALS = ["north", "east", "south", "west"];

/** キャンプ跡の松明を置く候補。基準タイル内の空き1つ＋周囲。空いている場所にだけ置く */
const TORCH_SPOTS = [
  { dx: 0, dz: 1 },
  { dx: -1, dz: 0 },
  { dx: 2, dz: 0 },
  { dx: -1, dz: 1 },
  { dx: 2, dz: 1 },
  { dx: 0, dz: -1 },
  { dx: 1, dz: -1 },
  { dx: 0, dz: 2 },
  { dx: 1, dz: 2 },
];

// ---- アーモンドウォーター（INTERFACES.md 8.4）----
// 仕様書1章は「追加しない」だったが、依頼者の判断で足した（README 9節）。遺留品のチェストでしか見つからない。
// Wiki（Object 1）の効き目: 軽い不調を治し、住人から受けた効果を打ち消し、少し元気になる。

/** 飲むと消える効果。住人は効果を与えないが、持ち込んだものや遭難中の不調をまとめて治す */
const ALMOND_CURES = ["poison", "fatal_poison", "wither", "hunger", "nausea", "blindness", "darkness", "slowness", "weakness", "mining_fatigue"];
/** 飲んだあとの再生（tick）。再生 I を5秒でハート1つ分 */
const ALMOND_REGEN_TICKS = 100;

/** main.js から1回だけ呼ぶ。飲み終えた瞬間に効き目を出す（空き瓶は minecraft:food の using_converts_to が残す） */
export function registerAlmondWater() {
  world.afterEvents.itemCompleteUse.subscribe((event) => {
    if (event.itemStack?.typeId !== I_ALMOND) return;
    const player = event.source;
    for (const effect of ALMOND_CURES) {
      try {
        player.removeEffect(effect);
      } catch {
        /* 掛かっていない・この版に無い効果 */
      }
    }
    try {
      player.addEffect("regeneration", ALMOND_REGEN_TICKS, { amplifier: 0, showParticles: false });
    } catch (e) {
      console.warn(`[backrooms] almond water effect failed: ${e}`);
    }
  });
}

/**
 * 遺留品を1つ置く。generator.js から `yield* placeRelic(...)` で呼ばれる。
 *
 * @param dim   Level 0 の Dimension
 * @param cx    セル座標
 * @param cz    セル座標
 * @param relic layout.js の relicAt() が返した { kind, bx, bz, tx, tz, spots? }
 * @param seed  ワールドの seed
 */
export function* placeRelic(dim, cx, cz, relic, seed) {
  if (!relic) return;
  const x = cx * CELL + relic.bx;
  const z = cz * CELL + relic.bz;
  const y = Y_AIR_MIN;

  switch (relic.kind) {
    case RELIC_CAMP:
      yield* placeCamp(dim, x, y, z, seed);
      break;
    case RELIC_CHEST:
      yield* placeSupplyChest(dim, x, y, z, seed);
      break;
    case RELIC_SIGN:
      yield* placeSign(dim, x, y, z, seed);
      break;
    case RELIC_GEAR:
      yield* placeGear(dim, x, y, z, seed);
      break;
    case RELIC_OFFICE:
      yield* placeOffice(dim, x, y, z, seed);
      break;
    case RELIC_DIARY:
      yield* placeDiary(dim, x, y, z, seed);
      break;
    case RELIC_GRAFFITI:
      // 遺留品のタイルには何も置かない。壁の場所は relicAt が決めてある
      for (const s of relic.spots ?? []) setBlock(dim, cx * CELL + s.bx, s.y, cz * CELL + s.bz, B_GRAFFITI, s.states);
      yield;
      break;
    default:
      break;
  }
}

// ---- 種別ごとの設置 ----

/**
 * キャンプ跡。消火した焚き火・ベッド・松明2〜3本。アイテムは一切置かない（6.8）。
 * ベッドはここに置くが、Level 0 では寝られない（portal.js が FR-21 でキャンセルする）。
 */
function* placeCamp(dim, x, y, z, seed) {
  setBlock(dim, x, y, z, "minecraft:campfire", {
    extinguished: true,
    "minecraft:cardinal_direction": CARDINALS[hash32(x, z, SALT.RELIC_KIND, seed) % 4],
  });
  yield;

  // ベッドは2ブロック。足側 (x+1, z) / 頭側 (x+1, z+1)。
  // 基準タイルは 2x2 なので、この2ブロックは壁でないタイルの中に収まる。
  setBlock(dim, x + 1, y, z, "minecraft:bed", { direction: 0, head_piece_bit: false, occupied_bit: false });
  setBlock(dim, x + 1, y, z + 1, "minecraft:bed", { direction: 0, head_piece_bit: true, occupied_bit: false });
  yield;

  const want = 2 + (hash32(x, z, SALT.RELIC, seed) % 2); // 2 または 3本
  let placed = 0;
  for (const spot of TORCH_SPOTS) {
    if (placed >= want) break;
    const tx = x + spot.dx;
    const tz = z + spot.dz;
    if (!isAir(dim, tx, y, tz)) continue;
    if (setBlock(dim, tx, y, tz, "minecraft:torch", { torch_facing_direction: "top" })) placed++;
    yield;
  }
}

/** 物資チェスト。中身はルートテーブルではなくここで決定論的に詰める（Q-14） */
function* placeSupplyChest(dim, x, y, z, seed) {
  if (!setBlock(dim, x, y, z, "minecraft:chest", { "minecraft:cardinal_direction": cardinalOf(x, z, seed) })) return;
  yield;

  const container = containerAt(dim, x, y, z);
  if (!container) return;

  const count = 2 + (hash32(x, z, SALT.CHEST, seed) % 4); // 2〜5スタック
  const pool = SUPPLY.slice();
  for (let i = 0; i < count && pool.length > 0; i++) {
    const entry = pool.splice(hash32(x + i, z, SALT.CHEST, seed) % pool.length, 1)[0];
    const span = entry.max - entry.min + 1;
    const amount = entry.min + (hash32(x, z + i, SALT.CHEST, seed) % span);
    putItem(container, hash32(x + i, z + i, SALT.CHEST, seed) % container.size, entry.id, amount);
  }
  // アーモンドウォーターは必ず1〜2本（Wiki では Level 0 でいちばん見つかる飲み水。INTERFACES.md 8.4）
  const almond = hash32(z, x, SALT.CHEST, seed);
  putItem(container, (almond >>> 1) % container.size, I_ALMOND, 1 + (almond & 1));
  yield;
}

/** 看板／メモ。テキストは SALT.SIGN_TEXT で決定論的に選ぶ（6.8） */
function* placeSign(dim, x, y, z, seed) {
  const facing = hash32(z, x, SALT.SIGN_TEXT, seed) % 16;
  if (!setBlock(dim, x, y, z, "minecraft:standing_sign", { ground_sign_direction: facing })) return;
  yield;

  const text = SIGN_TEXTS[hash32(x, z, SALT.SIGN_TEXT, seed) % SIGN_TEXTS.length];
  try {
    const sign = dim.getBlock({ x, y, z })?.getComponent("minecraft:sign");
    if (sign) {
      sign.setText(text);
      // 書き換えを封じて「痕跡」として残す。メモ帳にはさせない
      sign.setWaxed(true);
    }
  } catch (e) {
    console.warn(`[backrooms] sign text failed @ ${x},${y},${z}: ${e}`);
  }
  yield;
}

/**
 * 装備（6.8 / Q-13）。
 * RELIC_GEAR_USE_ARMOR_STAND が true ならアーマースタンドに着せる。
 * false、またはスポーンに失敗したらチェストに1点だけ入れる。
 * どちらの場合もドロップアイテムでは置かない（15章）。
 */
function* placeGear(dim, x, y, z, seed) {
  const entry = GEAR[hash32(x, z, SALT.GEAR, seed) % GEAR.length];

  if (RELIC_GEAR_USE_ARMOR_STAND && spawnGearStand(dim, x, y, z, entry, seed)) {
    yield;
    return;
  }

  // フォールバック: チェストに1点だけ（Q-13）
  if (!setBlock(dim, x, y, z, "minecraft:chest", { "minecraft:cardinal_direction": cardinalOf(x, z, seed) })) return;
  yield;
  const container = containerAt(dim, x, y, z);
  if (container) {
    const stack = wornItem(entry.id, x, z, seed);
    if (stack) {
      try {
        container.setItem(hash32(x, z, SALT.GEAR, seed) % container.size, stack);
      } catch (e) {
        console.warn(`[backrooms] gear chest failed @ ${x},${y},${z}: ${e}`);
      }
    }
  }
  yield;
}

/**
 * 事務机と椅子（設計書 3.4）。机 (x, z)、半分の確率で2台目 (x+1, z)、椅子 (x, z+1)。
 * 椅子は倒れていないが、あさっての方を向いている。すべて遺留品のタイル（2x2）の中
 */
function* placeOffice(dim, x, y, z, seed) {
  const v = hash32(x, z, SALT.RELIC_OFFICE, seed);
  const desk = { [S_FACING]: CARDINALS[(v >>> 1) & 3] };
  setBlock(dim, x, y, z, B_DESK, desk);
  if (v & 1) setBlock(dim, x + 1, y, z, B_DESK, desk);
  setBlock(dim, x, y, z + 1, B_CHAIR, { [S_FACING]: CARDINALS[(v >>> 3) & 3] });
  yield;
}

/**
 * 手記（設計書 3.4）。机 (x, z) と、机に向いた椅子 (x, z+1)、署名済みの本「手記」の入ったチェスト (x+1, z)。
 * 椅子の north は座る人が -Z（机）を向く向き（INTERFACES 7.2）
 */
function* placeDiary(dim, x, y, z, seed) {
  setBlock(dim, x, y, z, B_DESK, { [S_FACING]: "south" });
  setBlock(dim, x, y, z + 1, B_CHAIR, { [S_FACING]: "north" });
  if (!setBlock(dim, x + 1, y, z, "minecraft:chest", { "minecraft:cardinal_direction": "south" })) return;
  yield;

  const container = containerAt(dim, x + 1, y, z);
  if (!container) return;
  const v = hash32(x, z, SALT.RELIC_DIARY, seed);
  try {
    container.setItem((v >>> 16) % container.size, diaryBook(v));
  } catch (e) {
    console.warn(`[backrooms] diary chest failed @ ${x + 1},${y},${z}: ${e}`);
  }
  putItem(container, (v >>> 20) % container.size, I_ALMOND, 1); // 書き手が残した飲みかけの1本
  yield;
}

/** 署名済みの本「手記」。DIARY_TEXTS から続きの1〜3編。本が作れなければ紙1枚にして警告する */
function diaryBook(v) {
  const pages = [];
  for (let i = 0, n = 1 + (v % 3); i < n; i++) pages.push(DIARY_TEXTS[((v >>> 4) + i) % DIARY_TEXTS.length]);
  try {
    const stack = new ItemStack("minecraft:writable_book", 1);
    const book = stack.getComponent("minecraft:book");
    if (book) {
      book.setContents(pages);
      book.signBook("手記", "名無し");
      return stack;
    }
    console.warn("[backrooms] diary: minecraft:book component missing, put paper instead");
  } catch (e) {
    console.warn(`[backrooms] diary book failed, put paper instead: ${e}`);
  }
  return new ItemStack("minecraft:paper", 1);
}

// ---- 小物 ----

/**
 * ブロックを1つ置く。状態指定で弾かれた場合は状態なしで置き直す
 * （ブロック状態名はバージョン差が出やすい。遺留品が丸ごと消えるよりはましにする）。
 */
function setBlock(dim, x, y, z, id, states) {
  try {
    dim.setBlockPermutation({ x, y, z }, BlockPermutation.resolve(id, states));
    return true;
  } catch (e) {
    if (states) {
      try {
        dim.setBlockPermutation({ x, y, z }, BlockPermutation.resolve(id));
        console.warn(`[backrooms] relic block states rejected, placed plain: ${id} (${e})`);
        return true;
      } catch {
        /* 下の警告へ落ちる */
      }
    }
    console.warn(`[backrooms] relic block failed ${id} @ ${x},${y},${z}: ${e}`);
    return false;
  }
}

function isAir(dim, x, y, z) {
  try {
    return dim.getBlock({ x, y, z })?.isAir === true;
  } catch {
    return false;
  }
}

function containerAt(dim, x, y, z) {
  try {
    const container = dim.getBlock({ x, y, z })?.getComponent("minecraft:inventory")?.container;
    // 詰める直前に空にする。判定点を置く前に失敗して作り直すと中身が二重に入る（v0.5.0 最終レビュー 軽微-8 と同じ）
    container?.clearAll();
    return container;
  } catch (e) {
    console.warn(`[backrooms] relic container failed @ ${x},${y},${z}: ${e}`);
    return undefined;
  }
}

function cardinalOf(x, z, seed) {
  return CARDINALS[hash32(x, z, SALT.CHEST, seed) % 4];
}

/** startSlot から順に空きスロットを探して入れる */
function putItem(container, startSlot, id, amount) {
  try {
    for (let i = 0; i < container.size; i++) {
      const slot = (startSlot + i) % container.size;
      if (container.getItem(slot)) continue;
      container.setItem(slot, new ItemStack(id, amount));
      return true;
    }
  } catch (e) {
    console.warn(`[backrooms] relic item failed ${id}: ${e}`);
  }
  return false;
}

/** 使い込まれた装備。耐久を 55〜89% 削る */
function wornItem(id, x, z, seed) {
  try {
    const stack = new ItemStack(id, 1);
    const durability = stack.getComponent("minecraft:durability");
    if (durability) {
      const worn = 55 + (hash32(x, z, SALT.GEAR, seed) % 35);
      durability.damage = Math.floor((durability.maxDurability * worn) / 100);
    }
    return stack;
  } catch (e) {
    console.warn(`[backrooms] relic gear item failed ${id}: ${e}`);
    return undefined;
  }
}

/** アーマースタンドを立てて装備を着せる。成功したら true */
function spawnGearStand(dim, x, y, z, entry, seed) {
  const stack = wornItem(entry.id, x, z, seed);
  if (!stack) return false;
  try {
    const stand = dim.spawnEntity("minecraft:armor_stand", { x: x + 0.5, y, z: z + 0.5 });
    const equippable = stand.getComponent("minecraft:equippable");
    if (!equippable) {
      stand.remove();
      return false;
    }
    equippable.setEquipment(entry.slot, stack);
    return true;
  } catch (e) {
    console.warn(`[backrooms] armor stand failed @ ${x},${y},${z}: ${e}`);
    return false;
  }
}
