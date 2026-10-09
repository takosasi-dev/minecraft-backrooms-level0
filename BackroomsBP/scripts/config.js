/**
 * 調整定数の一元化（仕様書 FR-19 / 10章）
 *
 * 体験が単調に寄った／騒がしくなったときは、このファイルだけを触る。
 * 同じ値を他のファイルに書かないこと（15章の禁止事項）。
 */

// ---- 識別子（Phase 0/1 で確定。以後変更しない = 15章の禁止事項）----
export const DIM_ID = "backrooms:level0";
export const B_WALL = "backrooms:wall";
export const B_FLOOR = "backrooms:floor";
export const B_CEILING = "backrooms:ceiling";
export const B_LIGHT = "backrooms:light";
export const B_EXIT = "backrooms:exit_door";
export const I_NOCLIP = "backrooms:noclip";
export const FOG_ID = "backrooms:level0_fog";
export const FOG_TAG = "backrooms";
/**
 * 時刻で差し替える霧（v0.5.0）。統合版の霧の色は時刻で暗くなり、ディメンションごとに時刻を止める手段が無いので、
 * 夜ほど明るく薄い霧に差し替えて打ち消す（依頼者の判断で地上の時刻は触らない）。
 * [この時刻から, 霧]。getTimeOfDay() は 0 = 日の出、6000 = 正午、12000 = 日没、18000 = 真夜中。
 * 暗さが残る・明るすぎるなら RP の fogs/level0_dusk.json・level0_night.json の色と境目を実機で合わせる
 */
export const FOG_PHASES = [
  [0, FOG_ID],
  [12000, "backrooms:level0_fog_dusk"],
  [13000, "backrooms:level0_fog_night"],
  [23000, "backrooms:level0_fog_dusk"],
];
export const SND_HUM = "backrooms:ambient.hum";
export const DP_SEED = "backrooms:seed";
export const DP_ENTRY = "backrooms:entry";

// エンティティ。仕様書1章・15章は「出さない」と確定していたが、依頼者の判断で足した（2026-09-27・README 9節）
export const E_SHADOW = "backrooms:shadow";
export const E_HOUND = "backrooms:hound";
export const E_SMILER = "backrooms:smiler";
/** 3体に共通の family。バニラの monster ではないので portal.js のモンスター消去には掛からない */
export const E_FAMILY = "backrooms";

// 小物（v0.3.0・設計書 docs/superpowers/specs/2026-09-27-level0-detailing-design.md 2章）
export const B_OUTLET = "backrooms:outlet";
export const B_SWITCH = "backrooms:switch";
export const B_EXIT_SIGN = "backrooms:exit_sign";
export const B_CEIL_VENT = "backrooms:ceiling_vent";
export const B_CEIL_STAINED = "backrooms:ceiling_stained";
export const B_CEIL_MISSING = "backrooms:ceiling_missing";
export const B_FLOOR_STAINED = "backrooms:floor_stained";
export const B_FLOOR_WET = "backrooms:floor_wet";
export const B_LIGHT_FLICKER = "backrooms:light_flicker";
export const B_LIGHT_DEAD = "backrooms:light_dead";
export const B_DESK = "backrooms:desk";
export const B_CHAIR = "backrooms:office_chair";
export const B_GRAFFITI = "backrooms:graffiti";
/** 小物の表が向く方角（"north" | "east" | "south" | "west"）。壁の小物は、その反対側に壁がある */
export const S_FACING = "minecraft:cardinal_direction";
/** 誘導灯の矢印。0 左 / 1 右 / 2 なし */
export const S_ARROW = "backrooms:arrow";
/** 落書きの図柄。0 矢印 / 1 正の字 / 2 手形 / 3 渦巻き / 4 ×印 / 5 数字の羅列 */
export const S_DESIGN = "backrooms:design";
/** 点滅する蛍光灯のコマ割りの種類。0..2（flipbook は全ブロック共通の時計なので、3通りに分けてブロックごとにずらす。最終レビューで足した） */
export const S_PHASE = "backrooms:phase";

// マニラルーム（v0.4.0・Backrooms Wiki の Level 0 の「The Manila Room」。INTERFACES.md 8章）
export const B_MANILA_WALL = "backrooms:manila_wall";
export const B_MANILA_BORDER = "backrooms:manila_border";
export const B_MANILA_LIGHT = "backrooms:manila_light";

// アーモンドウォーター（v0.4.0）。仕様書1章は「追加しない」だったが、依頼者の判断で足した（README 9節）
export const I_ALMOND = "backrooms:almond_water";

// ---- 座標系（6.1）----
export const CELL = 16; // 1セル = 16ブロック = 1チャンク
export const TILE = 2; // 1タイル = 2ブロック
export const TPC = 8; // 1セル = 8x8 タイル

// 縦構造（6.1）。Y=0 床 / Y=1..5 空間 / Y=6 天井。
// 仕様書は頭上3ブロック（Y=4 天井）だが、依頼者の判断で2ブロック上げた（2026-09-27・README 9節）。
// 生成・着地・救出はすべてこの定数から高さを読むので、変えるならここだけでよい
export const Y_FLOOR = 0;
export const Y_AIR_MIN = 1;
export const Y_AIR_MAX = 5;
export const Y_CEIL = 6;

// ---- 調整定数（10章。ここが FR-19 の本体）----
export const TUNING = {
  /** ランドマーク出現率。N セルに1つ（6.7）。v0.3.0 で種類が 4 → 7 に増えたので 200 から上げた（設計書 3.2） */
  LANDMARK_RATE: 150,
  /** 遺留品出現率。N セルに1つ（6.8） */
  RELIC_RATE: 50,
  /** 出口ドア出現率。N セルに1つ（8.3） */
  EXIT_RATE: 100,
  /**
   * 壁セグメント本数の下限・上限（6.3 / 6.4。被覆率 25〜35% が目標）。
   * tools/test_layout.mjs で実測して決めた値。4/7 と 2/8 では平均 35.5% で目標を外れ、
   * この 4/6 と 2/7 の組で平均 30.1%（最小13% / 最大52%）に入る。
   * ばらつきが小さい組み合わせを選んである（薄すぎると体育館、濃すぎると迷路になる）。
   */
  SEGMENT_COUNT_MIN: 4,
  SEGMENT_COUNT_MAX: 6,
  /** 壁セグメント長の下限・上限（タイル単位）。8以上にするなら 6.3 のリングを5x5へ */
  SEGMENT_LEN_MIN: 2,
  SEGMENT_LEN_MAX: 7,
  /** 蛍光灯の配置率（%）。タイル単位（6.6） */
  LIGHT_RATE: 12,
  /** 拠点セルの蛍光灯配置率（%）（6.9） */
  HOME_LIGHT_RATE: 50,
  /** 生成半径（セル数）。変えたら 7.5 のフォグ距離を計算し直すこと */
  GEN_RADIUS: 2,
  /** 巨大空間ランドマークの天井（Y=20）の照明率（%）。通常より低くして広さを出す（6.7） */
  ATRIUM_LIGHT_RATE: 6,
  /** 巨大空間ランドマークの柱の本数（6.7 の「柱を数本だけ」） */
  ATRIUM_PILLAR_MIN: 3,
  ATRIUM_PILLAR_MAX: 6,
  /** 大部屋バリアントのセグメント本数 */
  BIG_COUNT_MIN: 1,
  BIG_COUNT_MAX: 2,
  /** 密集区画バリアントのセグメント本数 */
  DENSE_COUNT_MIN: 8,
  DENSE_COUNT_MAX: 10,
  /**
   * エンティティの出現率（%）。ENTITY_CHECK_TICKS ごとに Level 0 のプレイヤー1人ずつ判定する。
   * 近くに同じ種類がいる間は判定しない。0 にするとその種類は出なくなる（既にいるものは残る）。
   * フェイスリング（ID は shadow）4% で平均およそ4分に1回、ハウンド 2% で8分に1回。
   * スマイラーは暗区画にいる間だけ判定するので高めにしてある（暗区画に入って平均40秒）
   */
  SHADOW_CHANCE: 4,
  HOUND_CHANCE: 2,
  SMILER_CHANCE: 25,
  /** 壁セグメントの形の割合（%）。残りが天井までの壁。戸口は長さ3タイル以上のときだけ */
  WALL_LOW_RATE: 10,
  WALL_GAP_RATE: 10,
  WALL_DOOR_RATE: 10,
  /** 壁の小物。1セルあたり 0〜N 個 */
  DECOR_OUTLET_MAX: 2,
  DECOR_SWITCH_MAX: 1,
  /** 誘導灯。N セルに1つ（暗区画には置かない） */
  EXIT_SIGN_RATE: 8,
  /** 天井の小物。通気口は MIN〜MAX 個、水ジミは 0〜MAX 枚、外れたタイルは N セルに1枚 */
  CEIL_VENT_MIN: 1,
  CEIL_VENT_MAX: 2,
  CEIL_STAIN_MAX: 3,
  CEIL_MISSING_RATE: 3,
  /** 床の小物。シミは 0〜MAX か所、濡れたカーペットは N セルに1つ */
  FLOOR_STAIN_MAX: 3,
  FLOOR_WET_RATE: 6,
  /** 蛍光灯のうち点滅するもの・切れたものの割合（%）。拠点は対象外 */
  LIGHT_FLICKER_RATE: 10,
  LIGHT_DEAD_RATE: 10,
  /** 壁の落書きの遺留品の枚数（設計書 3.4）。遺留品のタイルから3タイル以内の壁に置く */
  GRAFFITI_MIN: 1,
  GRAFFITI_MAX: 3,
  /** マニラルームの中にこれだけ（秒）続けていると、元の世界へ帰れる（Wiki の「長く留まると出られる」） */
  MANILA_STAY_SECONDS: 30,
  /**
   * Level 0 を延べこれだけ（ブロック）歩くと、暗転してマニラルームへ移される（v0.5.0・Wiki の出口2「延べ 100 km」）。
   * 100 km は遊べないので縮めた。歩き 4.3 m/s でおよそ12分。0 で無効
   */
  MANILA_WALK_BLOCKS: 3000,
  // ---- Level 1（v0.5.0・INTERFACES.md 9章。担当Ⓐが値を決めて書き換えてよい）----
  /** 上り階段（Level 0 へ戻る）。N セルに1つ。Level 1 の拠点セルには必ずある */
  L1_STAIRS_RATE: 40,
  /** 物資の箱。N セルに1つ */
  L1_CRATE_RATE: 12,
  /** 蛍光灯の配置率（%）。タイル単位 */
  L1_LIGHT_RATE: 10,
  /** 水たまり。1セルあたり 0〜N か所 */
  L1_PUDDLE_MAX: 3,
  /**
   * セルの種類の割合（%）。倉庫の広間・廊下の順で、残りが普通の部屋。上り階段のセル（L1_STAIRS_RATE）が先に決まる。
   * 広間どうしの境目は壁が無いので、広間が隣り合うと柱の並ぶ広い倉庫になる（Wiki の「広大」）
   */
  L1_HALL_RATE: 45,
  L1_CORRIDOR_RATE: 25,
  /** セルの境目の壁に開ける戸口の数（広間どうし・拠点の境目は壁ごと無い） */
  L1_DOOR_MIN: 1,
  L1_DOOR_MAX: 2,
  /** 普通の部屋の戸口の数 */
  L1_ROOM_DOOR_MIN: 1,
  L1_ROOM_DOOR_MAX: 2,
  /** 拠点セルの蛍光灯の配置率（%）。着地点の真上には必ず1本 */
  L1_HOME_LIGHT_RATE: 30,
  /** 壁のタイルのうち鉄筋が剥き出しのものの割合（%） */
  L1_REBAR_RATE: 15,
  /** 壁の粗雑な絵。1セルあたり 0〜N 枚（拠点には描かない） */
  L1_GRAFFITI_MAX: 1,
};

// ---- 実行時に変更される可能性のある運用値（16.1 の出現率コマンド）----
/** TUNING をその場で書き換える。リロードで既定値に戻る（16.1） */
export function setTuning(key, value) {
  if (!(key in TUNING)) return false;
  TUNING[key] = value;
  return true;
}

// ---- 生成トリガ（7.1）----
/** グローバルタイマーの間隔（tick）。0.5秒 */
export const TICK_INTERVAL = 10;
/** エンティティの出現判定の間隔（tick）。10秒。判定はグローバルタイマーに相乗りする */
export const ENTITY_CHECK_TICKS = 200;

// ---- ランドマーク（6.7）----
export const LM_ATRIUM = 0;
export const LM_DARK = 1;
export const LM_WATER = 2;
export const LM_STAIRS = 3;
// v0.3.0 で足した3種（設計書 3.2）。種類は hash % LM_KINDS で選ぶ
export const LM_CORRIDOR = 4;
export const LM_PILLARS = 5;
export const LM_ROOMS = 6;
// v0.4.0 で足した（INTERFACES.md 8章）。中は安全地帯で、長く留まると帰れる
export const LM_MANILA = 7;
// v0.5.0（INTERFACES.md 9章）。床に穴が開いたセル。飛び降りると Level 1 へ（Wiki の Level 0 出口3）
export const LM_PIT = 8;
export const LM_KINDS = 9;

/** wallMask の値（壁の形・設計書 3.1） */
export const W_NONE = 0; // 無し
export const W_FULL = 1; // 天井まで
export const W_LOW = 2; // 腰の高さ（Y_AIR_MIN の1ブロック。跳び越えられる）
export const W_GAP = 3; // 天井に届かない（上に1ブロックの隙間）
export const W_DOOR = 4; // 戸口（鴨居だけ。Y_AIR_MIN+3 から天井-1）

/**
 * 種別ごとの占有セル数と、通常の壁セグメントを使うか。
 * 廊下は向き rot 1 のとき w/h が入れ替わる（1x3）。原点探索が ±2 セルなので、どの種類も最大3セルまで
 */
export const LM_SPEC = {
  [LM_ATRIUM]: { w: 2, h: 2, normalWalls: false, ceilY: 20 },
  [LM_DARK]: { w: 3, h: 3, normalWalls: true, ceilY: Y_CEIL },
  [LM_WATER]: { w: 2, h: 2, normalWalls: false, ceilY: Y_CEIL },
  [LM_STAIRS]: { w: 1, h: 1, normalWalls: false, ceilY: Y_CEIL, topY: 15 },
  [LM_CORRIDOR]: { w: 3, h: 1, normalWalls: false, ceilY: Y_CEIL },
  [LM_PILLARS]: { w: 2, h: 2, normalWalls: false, ceilY: Y_CEIL },
  [LM_ROOMS]: { w: 2, h: 2, normalWalls: false, ceilY: Y_CEIL },
  [LM_MANILA]: { w: 1, h: 1, normalWalls: false, ceilY: Y_CEIL },
  [LM_PIT]: { w: 1, h: 1, normalWalls: true, ceilY: Y_CEIL },
};

// ---- 遺留品（6.8）----
export const RELIC_CAMP = 0;
export const RELIC_CHEST = 1;
export const RELIC_SIGN = 2;
export const RELIC_GEAR = 3;
// v0.3.0 で足した3種（設計書 3.4）
export const RELIC_OFFICE = 4;
export const RELIC_DIARY = 5;
export const RELIC_GRAFFITI = 6;
export const RELIC_KINDS = 7;

/**
 * 装備の遺留品（6.8 / Q-13）の置き方。
 * true  = アーマースタンドに着せる（額縁がカスタムブロック壁に付くか未検証のため既定）
 * false = チェストに1点だけ入れる（仕様書 Q-13 が指示するフォールバック）
 * どちらもドロップアイテムではないので時間経過で消えない。
 */
export const RELIC_GEAR_USE_ARMOR_STAND = true;

// ---- 拠点（6.9）----
export const HOME_CX = 0;
export const HOME_CZ = 0;
/** 入場座標。拠点セル中央（8.2） */
export const HOME_SPAWN = { x: 8.5, y: 1, z: 8.5 };
/** 拠点の出口ドア座標（6.9） */
export const HOME_EXIT = { x: 2, y: 1, z: 2 };

// ---- 環境音（9.2）----
/** ハム音素材の長さ（tick）。tools/gen_hum.py の生成長と必ず一致させること */
export const HUM_LEN_TICKS = 200; // 10.0秒
/** 再生間隔。素材長より短くしてクロスフェードさせる（9.2） */
export const HUM_REPLAY_TICKS = HUM_LEN_TICKS - 10; // 9.5秒
export const HUM_VOLUME = 0.8;

// ---- 演出（8.1）----
export const FADE = {
  fadeColor: { red: 0, green: 0, blue: 0 },
  fadeTime: { fadeInTime: 0.6, holdTime: 0.8, fadeOutTime: 0.8 },
};
/** フェードが暗転しきるまでの待ち（tick）。8.1 の 0.6 秒 */
export const FADE_HOLD_TICKS = 12;

// ---- Level 1（v0.5.0・Backrooms Wiki の Level 1「The Habitable Zone」。INTERFACES.md 9章）----
// 識別子は以後固定。ブロックの ID は担当Ⓐがこの節に足してよい（他の担当はこの節を触らない）
export const DIM1_ID = "backrooms:level1";
export const B1_WALL = "backrooms:l1_wall"; // コンクリートの壁
export const B1_FLOOR = "backrooms:l1_floor"; // コンクリートの床。セル中央の床が完了の判定点（7.3 と同じ）
export const B1_CEIL = "backrooms:l1_ceiling";
export const B1_LIGHT = "backrooms:l1_light";
export const B1_REBAR = "backrooms:l1_rebar"; // 鉄筋が剥き出しになった壁
export const B1_PUDDLE = "backrooms:l1_puddle"; // 結露の水たまり（床の模様違い）
/** 縦構造。倉庫なので Level 0 より高い。Y=0 床 / Y=1..8 空間 / Y=9 天井 */
export const Y1_FLOOR = 0;
export const Y1_AIR_MIN = 1;
export const Y1_AIR_MAX = 8;
export const Y1_CEIL = 9;
/** Level 1 の拠点セル（Level 0 の穴から落ちるとここに着く）。上り階段が必ずある */
export const L1_HOME_CX = 0;
export const L1_HOME_CZ = 0;
export const L1_SPAWN = { x: 8.5, y: 1, z: 8.5 };
/** Level 1 の霧。Level 0 と同じく時刻で差し替える（FOG_PHASES と同じ境目） */
export const FOG1_PHASES = [
  [0, "backrooms:level1_fog"],
  [12000, "backrooms:level1_fog_dusk"],
  [13000, "backrooms:level1_fog_night"],
  [23000, "backrooms:level1_fog_dusk"],
];
