#!/usr/bin/env node
/**
 * 参照整合性と、仕様書15章の禁止事項の機械チェック。
 *
 *   node tools/validate.cjs
 *
 * 型チェックは 別の道具（公開していない）が担当する。
 * ここは「型は合っているが仕様に反している」ものだけを見る。両方通して初めて実機に持っていく。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BP = path.join(ROOT, "BackroomsBP");
const RP = path.join(ROOT, "BackroomsRP");

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

// INTERFACES.md で確定させた値。ここを変えるときは仕様書15章の禁止事項を読み直すこと
const UUIDS = {
  "BackroomsBP/manifest.json": {
    header: "33e04264-5682-492a-a834-50b194f7a591",
    modules: ["54505d18-df62-43f8-8691-d77027ec96d6", "0cfa6b33-876a-461a-be0c-5864a6613e3f"],
  },
  "BackroomsRP/manifest.json": {
    header: "406b5429-07c4-4582-8e67-3a1fb9fdc994",
    modules: ["18507937-6c9f-47ff-9917-ed71d6a25085"],
  },
};
// 最初の5種はテクスチャのショートネームが backrooms_<名前> と決まっている
const ORIGINAL_BLOCKS = ["wall", "floor", "ceiling", "light", "exit_door"];
const SHORTNAMES = ORIGINAL_BLOCKS.map((b) => `backrooms_${b}`);
// v0.3.0 の小物13種（設計書 2.1）。ID は以後固定
const DECOR_BLOCKS = [
  "outlet",
  "switch",
  "exit_sign",
  "ceiling_vent",
  "ceiling_stained",
  "ceiling_missing",
  "floor_stained",
  "floor_wet",
  "light_flicker",
  "light_dead",
  "desk",
  "office_chair",
  "graffiti",
];
// v0.4.0 のマニラルーム（INTERFACES.md 8章）。ID は以後固定
const MANILA_BLOCKS = ["manila_wall", "manila_border", "manila_light"];
// v0.5.0 の Level 1（INTERFACES.md 9.2）。ID は以後固定
const L1_BLOCKS = ["l1_wall", "l1_floor", "l1_ceiling", "l1_light", "l1_rebar", "l1_puddle"];
const BLOCKS = [...ORIGINAL_BLOCKS, ...DECOR_BLOCKS, ...MANILA_BLOCKS, ...L1_BLOCKS];
const INDESTRUCTIBLE = [
  "l1_floor",
  "l1_ceiling",
  "l1_light",
  "l1_puddle",
  "manila_light",
  "floor",
  "ceiling",
  "light",
  "exit_door",
  "ceiling_vent",
  "ceiling_stained",
  "ceiling_missing",
  "floor_stained",
  "floor_wet",
  "light_flicker",
  "light_dead",
];
/** 壊せる（destructible_by_mining がオブジェクト）。壁の0.8秒は別に見る */
const BREAKABLE = ["wall", "outlet", "switch", "exit_sign", "desk", "office_chair", "graffiti", "manila_wall", "manila_border", "l1_wall", "l1_rebar"];
/** 光量。書かれていないブロックは 0 か無しであること */
const LIGHT = { light: 13, exit_door: 5, light_flicker: 13, exit_sign: 3, manila_light: 12, l1_light: 13 };
// 依頼者の判断で足したエンティティ（2026-09-27・README 9節）。出すのは scripts/entities.js だけ
const ENTITIES = ["shadow", "hound", "smiler"];

// ---- 小道具 ----

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    err(`JSON が壊れている: ${path.relative(ROOT, p)} — ${e.message}`);
    return null;
  }
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, "/");
}

// ---- 1. 存在確認 ----

function checkPresence() {
  const required = [
    "BackroomsBP/manifest.json",
    "BackroomsBP/dimension/level0.json",
    "BackroomsBP/dimension/level1.json",
    "BackroomsBP/scripts/layout1.js",
    "BackroomsBP/scripts/generator1.js",
    "BackroomsBP/scripts/selftest.js",
    "BackroomsRP/fogs/level1.json",
    "BackroomsRP/fogs/level1_dusk.json",
    "BackroomsRP/fogs/level1_night.json",
    "BackroomsBP/items/noclip.json",
    "BackroomsBP/items/almond_water.json",
    "BackroomsBP/recipes/noclip.json",
    "BackroomsBP/scripts/main.js",
    "BackroomsBP/scripts/config.js",
    "BackroomsBP/scripts/rng.js",
    "BackroomsBP/scripts/layout.js",
    "BackroomsBP/scripts/generator.js",
    "BackroomsBP/scripts/scheduler.js",
    "BackroomsBP/scripts/relics.js",
    "BackroomsBP/scripts/portal.js",
    "BackroomsBP/scripts/commands.js",
    "BackroomsBP/scripts/entities.js",
    "BackroomsRP/manifest.json",
    "BackroomsRP/textures/terrain_texture.json",
    "BackroomsRP/textures/item_texture.json",
    ...ENTITIES.map((e) => `BackroomsBP/entities/${e}.json`),
    ...ENTITIES.map((e) => `BackroomsRP/entity/${e}.entity.json`),
    "BackroomsRP/fogs/level0.json",
    "BackroomsRP/fogs/level0_dusk.json", // v0.5.0 時刻で差し替える霧（config.js の FOG_PHASES）
    "BackroomsRP/fogs/level0_night.json",
    "BackroomsBP/pack_icon.png",
    "BackroomsRP/pack_icon.png",
    "BackroomsRP/sounds/sound_definitions.json",
    "BackroomsRP/texts/languages.json",
    "BackroomsRP/texts/en_US.lang",
    "BackroomsRP/texts/ja_JP.lang",
    ...BLOCKS.map((b) => `BackroomsBP/blocks/${b}.json`),
    ...ORIGINAL_BLOCKS.map((b) => `BackroomsRP/textures/blocks/${b}.png`),
  ];
  for (const r of required) {
    if (!fs.existsSync(path.join(ROOT, r))) err(`必須ファイルが無い: ${r}`);
  }
  // ハム音は ogg でも wav でも可（生成環境依存・INTERFACES.md 担当A）
  const hum = ["sounds/backrooms/hum.ogg", "sounds/backrooms/hum.wav"].map((s) => path.join(RP, s));
  if (!hum.some((p) => fs.existsSync(p))) err("必須ファイルが無い: BackroomsRP/sounds/backrooms/hum.(ogg|wav)");
}

// ---- 2. JSON がすべて妥当か ----

function checkJsonSyntax() {
  for (const p of [...walk(BP), ...walk(RP)]) {
    if (p.endsWith(".json")) readJson(p);
  }
}

// ---- 3. manifest（UUID固定・beta禁止）----

function checkManifests() {
  for (const [relPath, want] of Object.entries(UUIDS)) {
    const p = path.join(ROOT, relPath);
    if (!fs.existsSync(p)) continue;
    const m = readJson(p);
    if (!m) continue;

    if (m.header?.uuid !== want.header) {
      err(`${relPath}: header UUID が INTERFACES.md と違う（更新のたびに変えると別パック扱いになり既存ワールドのブロックが失われる・15章）`);
    }
    const got = (m.modules || []).map((x) => x.uuid);
    for (const u of want.modules) {
      if (!got.includes(u)) err(`${relPath}: module UUID ${u} が無い`);
    }

    const raw = fs.readFileSync(p, "utf8");
    if (/"version"\s*:\s*"beta"/.test(raw)) {
      err(`${relPath}: "version": "beta" が書かれている。ワールドの実績が恒久的に無効化される（15章）`);
    }
    const mev = m.header?.min_engine_version;
    if (!Array.isArray(mev) || mev[0] !== 1 || mev[1] !== 26 || mev[2] < 50) {
      err(`${relPath}: min_engine_version が [1,26,50] 以上でない（現在: ${JSON.stringify(mev)}）`);
    }
  }

  // BP の依存に @minecraft/server が正式版で入っているか
  const bp = readJson(path.join(BP, "manifest.json"));
  if (bp) {
    const dep = (bp.dependencies || []).find((d) => d.module_name === "@minecraft/server");
    if (!dep) err("BackroomsBP/manifest.json: @minecraft/server の依存が無い");
    else if (dep.version !== "2.10.0") {
      err(`BackroomsBP/manifest.json: @minecraft/server の版が 2.10.0 でない（${dep.version}）。検証キットの型チェックが別版で走る`);
    }
    const script = (bp.modules || []).find((x) => x.type === "script");
    if (!script) err("BackroomsBP/manifest.json: script モジュールが無い");
    else if (script.entry !== "scripts/main.js") err(`BackroomsBP/manifest.json: script entry が scripts/main.js でない（${script.entry}）`);
  }
}

// ---- 4. ブロック定義（破壊可否・テクスチャ参照・geometry と material_instances の同居）----

function checkBlocks() {
  const terrain = readJson(path.join(RP, "textures/terrain_texture.json"));
  const known = terrain ? Object.keys(terrain.texture_data || {}) : [];
  for (const sn of SHORTNAMES) {
    if (terrain && !known.includes(sn)) err(`terrain_texture.json にショートネーム ${sn} が無い`);
  }
  // ショートネームが指す PNG が実在するか
  if (terrain) {
    for (const [sn, def] of Object.entries(terrain.texture_data || {})) {
      const t = def.textures;
      const list = typeof t === "string" ? [t] : Array.isArray(t) ? t : [];
      for (const rp of list) {
        const abs = path.join(RP, `${rp}.png`);
        if (!fs.existsSync(abs)) err(`terrain_texture.json の ${sn} が指す ${rp}.png が無い`);
      }
    }
  }

  for (const b of BLOCKS) {
    const p = path.join(BP, `blocks/${b}.json`);
    if (!fs.existsSync(p)) continue;
    const j = readJson(p);
    if (!j) continue;
    const def = j["minecraft:block"];
    if (!def) {
      err(`blocks/${b}.json: minecraft:block が無い`);
      continue;
    }
    const id = def.description?.identifier;
    if (id !== `backrooms:${b}`) err(`blocks/${b}.json: identifier が backrooms:${b} でない（${id}）`);

    const c = def.components || {};
    // 1.21.80 以降、片方だけ使う場合も両方必要（仕様書5章）
    if (!("minecraft:geometry" in c)) err(`blocks/${b}.json: minecraft:geometry が無い（1.21.80 以降は material_instances と両方必要）`);
    if (!("minecraft:material_instances" in c)) err(`blocks/${b}.json: minecraft:material_instances が無い`);

    // minecraft:icon は文字列形式（配列形式は廃止）
    if ("minecraft:icon" in c && typeof c["minecraft:icon"] !== "string") {
      err(`blocks/${b}.json: minecraft:icon は文字列形式で書く（配列形式は廃止）`);
    }

    // クリエイティブメニュー。minecraft:creative_category は 1.19.60 以前の旧形式で現行では効かない
    if ("minecraft:creative_category" in c) {
      err(`blocks/${b}.json: minecraft:creative_category は旧形式。description.menu_category を使う`);
    }
    const mc = def.description?.menu_category;
    if (!mc?.category) err(`blocks/${b}.json: description.menu_category が無い。クリエイティブメニューに出ない`);
    // group は名前空間接頭辞が無いと実機ログにエラーが出る（ユーザーの ContentLog に実例あり）
    if (mc?.group && !mc.group.includes(":")) {
      err(`blocks/${b}.json: menu_category.group "${mc.group}" に名前空間接頭辞が無い`);
    }

    // 破壊可否（仕様書 5.2/5.3/5.4/5.5 と Q-3、設計書 2.1）
    if (INDESTRUCTIBLE.includes(b)) {
      if (c["minecraft:destructible_by_mining"] !== false) {
        err(`blocks/${b}.json: destructible_by_mining が false で明示されていない。既定挙動に頼らない（Q-3）`);
      }
      if (c["minecraft:destructible_by_explosion"] !== false) {
        err(`blocks/${b}.json: destructible_by_explosion が false で明示されていない（Q-3）`);
      }
    } else if (BREAKABLE.includes(b)) {
      const d = c["minecraft:destructible_by_mining"];
      if (!d || typeof d !== "object") err(`blocks/${b}.json: 壊せるブロックなのに destructible_by_mining がオブジェクトでない`);
      else if (b === "wall" && d.seconds_to_destroy !== 0.8) err("blocks/wall.json: 壁は素手で0.8秒（5.1）");
    }

    // 光量（5.4 / 5.5 / 設計書 2.1）
    const le = c["minecraft:light_emission"] ?? 0;
    if (le !== (LIGHT[b] ?? 0)) err(`blocks/${b}.json: light_emission が ${LIGHT[b] ?? 0} でない（${le}）`);

    // 参照しているテクスチャが terrain_texture.json にあるか。permutations の中の差し替えも見る
    const instances = [c["minecraft:material_instances"], ...(def.permutations || []).map((p) => p.components?.["minecraft:material_instances"])];
    for (const mi of instances) {
      if (!mi || !terrain) continue;
      for (const inst of Object.values(mi)) {
        const tex = typeof inst === "object" ? inst.texture : inst;
        if (typeof tex === "string" && !known.includes(tex)) {
          err(`blocks/${b}.json: texture "${tex}" が terrain_texture.json に無い`);
        }
      }
    }

    // カスタムの形なら、その geometry が RP の models/blocks にあるか
    const geo = c["minecraft:geometry"];
    const geoId = typeof geo === "string" ? geo : geo?.identifier;
    if (typeof geoId === "string" && !geoId.startsWith("minecraft:geometry.") && !blockGeometries().has(geoId)) {
      err(`blocks/${b}.json: geometry ${geoId} が BackroomsRP/models/blocks に無い`);
    }

    // permutations の条件が参照する状態が、states か traits で宣言されているか。
    // 宣言の無い状態を条件に書くと、その permutation は黙って一度も当たらない
    const declared = new Set(Object.keys(def.description?.states || {}));
    for (const trait of Object.values(def.description?.traits || {})) {
      for (const s of trait.enabled_states || []) declared.add(s);
    }
    for (const p of def.permutations || []) {
      for (const m of String(p.condition || "").matchAll(/block_state\(\s*'([^']+)'\s*\)/g)) {
        if (!declared.has(m[1])) err(`blocks/${b}.json: permutation の条件が宣言の無い状態 ${m[1]} を見ている`);
      }
    }
  }

  // 点滅する蛍光灯（flipbook）。atlas_tile が terrain_texture.json に無いと動かない
  const fbPath = path.join(RP, "textures/flipbook_textures.json");
  if (fs.existsSync(fbPath)) {
    for (const f of readJson(fbPath) || []) {
      if (!known.includes(f.atlas_tile)) err(`flipbook_textures.json: atlas_tile ${f.atlas_tile} が terrain_texture.json に無い`);
      if (!fs.existsSync(path.join(RP, `${f.flipbook_texture}.png`))) err(`flipbook_textures.json: ${f.flipbook_texture}.png が無い`);
    }
  } else {
    err("必須ファイルが無い: BackroomsRP/textures/flipbook_textures.json（点滅する蛍光灯）");
  }
}

// ---- 5. 仕様書15章の禁止事項をソースで機械チェック ----

/** config.js の TUNING に書かれた既定値 */
function tuningDefault(key) {
  const src = fs.readFileSync(path.join(BP, "scripts/config.js"), "utf8");
  const m = src.match(new RegExp(`\\b${key}\\s*:\\s*(\\d+)`));
  if (!m) err(`config.js の TUNING に ${key} が無い`);
  return m ? Number(m[1]) : NaN;
}

function scriptFiles() {
  return walk(path.join(BP, "scripts")).filter((p) => p.endsWith(".js"));
}

/**
 * コメントを空白に潰す（行番号と桁を保つため長さは変えない）。
 * これを通さずに正規表現で数えると、禁止事項を説明したコメント自体が違反として数えられる。
 * 文字列リテラルの中の // や /* は潰さない。
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null; // 開いている引用符
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function checkForbidden() {
  const files = scriptFiles();
  let intervalCount = 0;
  const dpKeys = new Set();

  for (const p of files) {
    const src = stripComments(fs.readFileSync(p, "utf8"));
    const name = path.basename(p);

    // Math.random() は seed 採番の1箇所（rng.js）だけ許す
    const randoms = src.match(/Math\.random\s*\(/g) || [];
    if (randoms.length) {
      if (name === "rng.js" && randoms.length === 1) {
        // seed の採番。地形生成ではない
      } else {
        err(`${rel(p)}: Math.random() を使っている（${randoms.length}箇所）。決定論性 FR-4 が壊れる（15章）`);
      }
    }

    // fill コマンド経由のブロック設置
    if (/runCommand\s*\(\s*[`'"]\s*fill\b/.test(src) || /runCommand\s*\(\s*[`'"]setblock\b/i.test(src)) {
      err(`${rel(p)}: runCommand で fill/setblock している。fillBlocks を使う（15章）`);
    }

    // runInterval の本数（アドオン全体で2本まで・10章）
    intervalCount += (src.match(/system\.runInterval\s*\(/g) || []).length;

    // fillBlocks に ignoreChunkBoundErrors が付いているか（7.4）。
    // オプションを定数にまとめている場合があるので、その定数名も「付いている」とみなす
    const optConsts = [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{[^}]*ignoreChunkBoundErrors/g)].map(
      (m) => m[1]
    );
    for (const m of src.matchAll(/fillBlocks\s*\(/g)) {
      const tail = src.slice(m.index, m.index + 600);
      const ok = /ignoreChunkBoundErrors/.test(tail) || optConsts.some((c) => new RegExp(`\\b${c}\\b`).test(tail));
      if (!ok) {
        const line = src.slice(0, m.index).split("\n").length;
        err(`${rel(p)}:${line}: fillBlocks に ignoreChunkBoundErrors が付いていない（7.4）`);
      }
    }

    // dynamic property のキー（許すのは seed と entry だけ・10章）
    for (const m of src.matchAll(/(?:set|get)DynamicProperty\s*\(\s*["'`]([^"'`]+)["'`]/g)) dpKeys.add(m[1]);
    for (const m of src.matchAll(/(?:set|get)DynamicProperty\s*\(\s*(DP_[A-Z_]+)/g)) dpKeys.add(m[1]);

    // ticking area の作りっぱなし
    if (/createTickingArea/.test(src) && !/removeTickingArea/.test(src)) {
      err(`${rel(p)}: createTickingArea があるのに removeTickingArea が無い。チャンク割当を食い潰す（8.2）`);
    }
    // テレポート前の await 省略（15章が名指しで禁止）
    if (/createTickingArea/.test(src) && !/await\s+[\w.]*createTickingArea/.test(src)) {
      err(`${rel(p)}: createTickingArea を await していない。プレイヤーが虚空に落ちる（15章）`);
    }

    // カスタムディメンションへのリスポーン設定（8.4 でやらないと決めている）
    if (/setSpawnPoint\s*\(/.test(src) && /level0|DIM_ID/.test(src)) {
      warn(`${rel(p)}: setSpawnPoint を呼んでいる。Level 0 を指していないか確認すること（8.4 / FR-18）`);
    }
  }

  if (intervalCount > 2) {
    err(`system.runInterval が ${intervalCount} 本ある。アドオン全体で2本（生成用・環境音用）まで（10章 / 15章）`);
  }

  const allowed = new Set(["backrooms:seed", "backrooms:entry", "backrooms:walked", "DP_SEED", "DP_ENTRY", "DP_WALKED"]); // walked は v0.5.0（INTERFACES.md 9.3）
  for (const k of dpKeys) {
    if (!allowed.has(k)) {
      err(`dynamic property のキー "${k}" は許可されていない。永続化は seed と entry のみ（10章 / 15章）`);
    }
  }

  // フォグの解除が実装されているか（15章が名指しで禁止）
  const all = files.map((p) => stripComments(fs.readFileSync(p, "utf8"))).join("\n");
  if (/fogSettings/.test(all) && !/fogSettings\s*\.\s*remove/.test(all) && !/fog\s+@s\s+remove/.test(all)) {
    err("フォグの解除処理が見当たらない。フォグはワールドセーブをまたいで永続する（9.1 / 15章）");
  }
  // 帰還コマンド（閉じ込め事故の最終手段・8.3 が「必ず実装する」としている）
  if (!/backrooms:leave|"leave"|'leave'/.test(all)) {
    err("強制帰還コマンドが見当たらない。閉じ込め事故の最終手段として必ず実装する（8.3 / FR-20）");
  }
  // 出現率のハードコード（FR-19 / 15章）
  for (const p of files) {
    if (path.basename(p) === "config.js") continue;
    const src = stripComments(fs.readFileSync(p, "utf8"));
    // 「% 100」は百分率の基数でもあるので、対応する SALT を使っている行に限って疑う。
    // 値は config.js の TUNING の既定値から読む（既定値を変えてもこのチェックが追従する）
    const rates = [
      ["LANDMARK_RATE", tuningDefault("LANDMARK_RATE"), "SALT.LM_ORIGIN"],
      ["RELIC_RATE", tuningDefault("RELIC_RATE"), "SALT.RELIC"],
      ["EXIT_RATE", tuningDefault("EXIT_RATE"), "SALT.EXIT"],
    ];
    src.split("\n").forEach((line, i) => {
      for (const [key, val, salt] of rates) {
        if (line.includes(salt) && new RegExp(`%\\s*${val}\\b`).test(line)) {
          warn(`${rel(p)}:${i + 1}: ${val} が直書きされている。${key} は TUNING から読むこと（FR-19 / 15章）`);
        }
      }
    });
  }
}

// ---- 6. 表示文字（日本語と ASCII 以外は豆腐になる）----

// 許すのは ASCII、ひらがな、カタカナ、漢字、、。ー のみ。
// JIS X 0208 に入っていても Minecraft のフォントには無い記号が多い（実機で確認済みの罠）
const ALLOWED = /[\u0020-\u007E\u3001\u3002\u30FC\u3041-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;

function checkGlyphs() {
  const targets = [
    ...walk(path.join(RP, "texts")).filter((p) => p.endsWith(".lang")),
    ...scriptFiles(),
  ];
  for (const p of targets) {
    const src = fs.readFileSync(p, "utf8");
    const isLang = p.endsWith(".lang");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      // スクリプトは文字列リテラルの中だけ見る。コメントの記号は画面に出ない
      const texts = isLang
        ? [line.split("=").slice(1).join("=")]
        : [...line.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
      for (const t of texts) {
        for (const ch of t) {
          if (ch === "\\" || ch === "\n" || ch === "\t" || ch === "\r") continue;
          if (!ALLOWED.test(ch)) {
            err(`${rel(p)}:${i + 1}: 表示文字に "${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}) がある。Minecraft のフォントでは豆腐(□)になる`);
          }
        }
      }
    });
  }
}

// ---- 7. lang キー ----

function checkLang() {
  const need = [
    ...BLOCKS.map((b) => `tile.backrooms:${b}.name`),
    "item.backrooms:noclip.name",
    "item.backrooms:almond_water.name",
    ...ENTITIES.map((e) => `entity.backrooms:${e}.name`),
    ...ENTITIES.map((e) => `item.spawn_egg.entity.backrooms:${e}.name`),
  ];
  for (const f of ["en_US.lang", "ja_JP.lang"]) {
    const p = path.join(RP, "texts", f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    for (const k of need) {
      if (!src.includes(k + "=")) err(`texts/${f}: キー ${k} が無い`);
    }
  }
}

// ---- 8. フォグ・音の定義 ----

function checkRpDefs() {
  const fog = readJson(path.join(RP, "fogs/level0.json"));
  if (fog) {
    const s = fog["minecraft:fog_settings"];
    const air = s?.distance?.air;
    if (s?.description?.identifier !== "backrooms:level0_fog") err("fogs/level0.json: identifier が backrooms:level0_fog でない");
    if (air?.render_distance_type !== "fixed") {
      err('fogs/level0.json: render_distance_type が "fixed" でない。描画距離の大きい環境で虚空が見える（7.5 / 9.1）');
    }
    if (air?.fog_end !== 24.0) warn(`fogs/level0.json: fog_end が 24 でない（${air?.fog_end}）。GEN_RADIUS を変えたなら 7.5 の計算をやり直したか確認`);
  }

  const snd = readJson(path.join(RP, "sounds/sound_definitions.json"));
  if (snd) {
    const d = snd.sound_definitions?.["backrooms:ambient.hum"];
    if (!d) err("sound_definitions.json: backrooms:ambient.hum が無い");
    else {
      const name = d.sounds?.[0]?.name || d.sounds?.[0];
      if (typeof name === "string") {
        const ok = [".ogg", ".wav", ""].some((ext) => fs.existsSync(path.join(RP, name + ext)));
        if (!ok) err(`sound_definitions.json: ${name} に対応する音声ファイルが無い`);
      }
    }
  }
}

// ---- 9. アイテムのアイコン・エンティティの参照 ----

/** RP の dir 以下の JSON から、key の下にある定義名を集める（geometry・animation・render controller） */
/** RP の dir 以下の JSON から [名前, 定義] を集める（geometry・animation・controller） */
function defined(dir, pick) {
  const out = new Map();
  for (const p of walk(path.join(RP, dir)).filter((f) => f.endsWith(".json"))) {
    const j = readJson(p);
    if (j) for (const [name, def] of pick(j)) out.set(name, def);
  }
  return out;
}

/** geometry の identifier -> ボーン名の集合 */
const pickGeometries = (j) =>
  (j["minecraft:geometry"] || []).map((g) => [g.description?.identifier, new Set((g.bones || []).map((b) => b.name))]);

let blockGeoCache;
function blockGeometries() {
  return (blockGeoCache ??= defined("models/blocks", pickGeometries));
}

function checkItemsAndEntities() {
  // アイテムのアイコン。ショートネームが item_texture.json に無いと紫黒の市松模様になる
  const itemTex = readJson(path.join(RP, "textures/item_texture.json"));
  const itemKeys = itemTex ? itemTex.texture_data || {} : {};
  for (const p of walk(path.join(BP, "items")).filter((f) => f.endsWith(".json"))) {
    const icon = readJson(p)?.["minecraft:item"]?.components?.["minecraft:icon"];
    if (typeof icon !== "string") continue;
    const def = itemKeys[icon];
    if (!def) err(`${rel(p)}: minecraft:icon "${icon}" が item_texture.json に無い`);
    else if (!fs.existsSync(path.join(RP, `${def.textures}.png`))) err(`item_texture.json の ${icon} が指す ${def.textures}.png が無い`);
  }

  const geometries = defined("models/entity", pickGeometries);
  const animations = defined("animations", (j) => Object.entries(j.animations || {}));
  const animControllers = defined("animation_controllers", (j) => Object.entries(j.animation_controllers || {}));
  const controllers = defined("render_controllers", (j) => Object.entries(j.render_controllers || {}));

  for (const name of ENTITIES) {
    const id = `backrooms:${name}`;
    const bp = readJson(path.join(BP, `entities/${name}.json`))?.["minecraft:entity"];
    const rp = readJson(path.join(RP, `entity/${name}.entity.json`))?.["minecraft:client_entity"]?.description;
    if (!bp || !rp) continue; // 存在確認で拾っている
    if (bp.description?.identifier !== id) err(`entities/${name}.json: identifier が ${id} でない`);
    if (rp.identifier !== id) err(`entity/${name}.entity.json: identifier が ${id} でない`);

    // entities.js は family "backrooms" で自分のエンティティを拾う。
    // monster を付けると portal.js の「湧いたモンスターは消す」に掛かり、出した瞬間に消える
    const family = bp.components?.["minecraft:type_family"]?.family || [];
    if (!family.includes("backrooms")) err(`entities/${name}.json: family に backrooms が無い。entities.js が管理できない`);
    if (family.includes("monster")) err(`entities/${name}.json: family に monster がある。portal.js のモンスター消去で出た瞬間に消える`);

    // 書き方を間違えても実機では黙って効かないだけの部品（v0.4.0 の統合で実際に見つけた2つ）。部品群の中も見る
    for (const comps of [bp.components || {}, ...Object.values(bp.component_groups || {})]) {
      const avoid = comps["minecraft:behavior.avoid_mob_type"];
      if (avoid && !Array.isArray(avoid.entity_types)) err(`entities/${name}.json: behavior.avoid_mob_type の相手は entity_types に書く（無いと何からも逃げない）`);
      const triggers = comps["minecraft:damage_sensor"]?.triggers;
      for (const t of Array.isArray(triggers) ? triggers : triggers ? [triggers] : []) {
        if ("deals_damage" in t && typeof t.deals_damage !== "string") err(`entities/${name}.json: damage_sensor の deals_damage は "yes" / "no" の文字列で書く`);
      }
    }

    for (const g of Object.values(rp.geometry || {})) if (!geometries.has(g)) err(`entity/${name}.entity.json: geometry ${g} が models/entity に無い`);
    for (const t of Object.values(rp.textures || {})) if (!fs.existsSync(path.join(RP, `${t}.png`))) err(`entity/${name}.entity.json: テクスチャ ${t}.png が無い`);
    // アニメーションが動かすボーンがモデルに無いと、その部品だけ黙って動かない（1文字違いで起きる）
    const bones = new Set();
    for (const g of Object.values(rp.geometry || {})) for (const b of geometries.get(g) || []) bones.add(b);
    for (const [short, a] of Object.entries(rp.animations || {})) {
      if (animations.has(a)) {
        for (const bone of Object.keys(animations.get(a).bones || {})) {
          if (!bones.has(bone)) err(`entity/${name}.entity.json: ${short}（${a}）が動かすボーン ${bone} がモデルに無い`);
        }
      } else if (animControllers.has(a)) {
        // コントローラの状態が使う短縮名は、このエンティティの animations の中から引かれる
        for (const [state, def] of Object.entries(animControllers.get(a).states || {})) {
          for (const x of def.animations || []) {
            const key = typeof x === "string" ? x : Object.keys(x)[0];
            if (!(key in rp.animations)) err(`entity/${name}.entity.json: ${a} の状態 ${state} が使う ${key} が animations に無い`);
          }
        }
      } else {
        err(`entity/${name}.entity.json: ${short} の ${a} が animations にも animation_controllers にも無い`);
      }
    }
    for (const c of rp.render_controllers || []) {
      const key = typeof c === "string" ? c : Object.keys(c)[0];
      if (!controllers.has(key)) err(`entity/${name}.entity.json: render controller ${key} が render_controllers に無い`);
    }
    // scripts.animate が animations に無い短縮名を指すと、その行だけ黙って効かない
    for (const s of rp.scripts?.animate || []) {
      const key = typeof s === "string" ? s : Object.keys(s)[0];
      if (!(key in (rp.animations || {}))) err(`entity/${name}.entity.json: scripts.animate の ${key} が animations に無い`);
    }
  }
}

// ---- 実行 ----

checkPresence();
checkJsonSyntax();
checkManifests();
checkBlocks();
checkForbidden();
checkGlyphs();
checkLang();
checkRpDefs();
checkItemsAndEntities();

for (const w of warns) console.log(`[warn] ${w}`);
for (const e of errors) console.log(`[NG]   ${e}`);
console.log("");
console.log(`警告 ${warns.length} 件 / エラー ${errors.length} 件`);
if (errors.length) {
  console.log("実機に持っていく前に、エラーを全部つぶすこと。");
  process.exit(1);
}
console.log("参照整合性と禁止事項のチェックは通過。公式の型定義との型チェックは別の道具で行う。");
