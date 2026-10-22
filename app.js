import createModule from './engine/butterscotch.mjs';
import { openZipEntry, readZipEntries } from './zip.js';

const $ = (id) => document.getElementById(id);

// ===== ログ =====

const logEl = $('log');

function log(message, kind = 'info') {
  const line = document.createElement('span');
  if (kind === 'error') line.className = 'error';
  line.textContent = `${message}\n`;
  logEl.append(line);
  // 長くなりすぎないよう古い行から捨てる
  while (logEl.childNodes.length > 1000) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
  (kind === 'error' ? console.error : console.log)(message);
}

// ===== 動作環境のチェック =====

function checkEnvironment() {
  const checks = [
    {
      label: 'WebAssembly JSPI',
      ok: typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function',
      note: 'Chrome 137以降、Safari 27以降、Firefox 153以降が必要です',
    },
    {
      label: 'ブラウザ内の保存領域（OPFS）',
      ok: window.isSecureContext && typeof navigator.storage?.getDirectory === 'function',
      note: 'HTTPSのページで開く必要があります',
    },
    {
      label: 'WebGL 2',
      ok: !!document.createElement('canvas').getContext('webgl2'),
      note: 'このブラウザでは画面を描けません',
    },
  ];

  const list = $('env');
  list.replaceChildren(...checks.map((c) => {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : 'ng';
    li.innerHTML = '<span class="mark"></span><span class="label"></span><span class="note"></span>';
    li.querySelector('.mark').textContent = c.ok ? '✓' : '✗';
    li.querySelector('.label').textContent = c.label;
    if (!c.ok) li.querySelector('.note').textContent = c.note;
    return li;
  }));
  return checks.every((c) => c.ok);
}

// ===== 保存領域（OPFS）の読み書き =====
// エンジンは OPFS のルートを /butterscotch として扱うので、
// ゲームは games/<id>/、セーブは saves/<id>/ に置く（公式ランチャーと同じ配置）。

async function gamesDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('games', { create: true });
}

async function listGames() {
  const dir = await gamesDir();
  const ids = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory') continue;
    // data.win は最後に書き込むので、これがあれば取り込みが完了している
    try {
      await handle.getFileHandle('data.win');
      ids.push(name);
    } catch {
      // 途中で止まった取り込み。一覧には出さない
    }
  }
  return ids.sort();
}

async function deleteGame(id) {
  const dir = await gamesDir();
  await dir.removeEntry(id, { recursive: true });
}

async function getFileHandleDeep(dir, path) {
  const parts = path.split('/');
  const fileName = parts.pop();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir.getFileHandle(fileName, { create: true });
}

function toGameId(name) {
  return name.trim().replace(/[^\w.-]+/g, '_') || 'game';
}

const SKIPPED_FILES = /\.(exe|dll)$/i;

// entries: { path, size, read: () => Promise<Blob | ReadableStream> } の配列
async function importGame(id, entries) {
  entries = entries.filter((e) => !SKIPPED_FILES.test(e.path));
  const dataWin = entries.find((e) => e.path.toLowerCase() === 'data.win');
  if (!dataWin) throw new Error('data.win が見つかりませんでした。ゲームのフォルダを選んでいるか確認してください。');
  // data.win を最後にして、途中で止まっても「取り込み済み」に見えないようにする
  entries = [...entries.filter((e) => e !== dataWin), dataWin];

  const games = await gamesDir();
  await games.removeEntry(id, { recursive: true }).catch(() => {});
  const dir = await games.getDirectoryHandle(id, { create: true });

  const total = entries.reduce((sum, e) => sum + e.size, 0);
  let done = 0;
  showProgress(0, '準備中…');
  for (const entry of entries) {
    // エンジンは小文字の data.win を探すので、名前をそろえて保存する
    const handle = await getFileHandleDeep(dir, entry === dataWin ? 'data.win' : entry.path);
    const writable = await handle.createWritable();
    const data = await entry.read();
    if (data instanceof ReadableStream) {
      await data.pipeTo(writable); // 書き終わると自動で閉じる
    } else {
      await writable.write(data);
      await writable.close();
    }
    done += entry.size;
    showProgress(done / total, `${entry.path}（${formatBytes(done)} / ${formatBytes(total)}）`);
  }

  // ブラウザが容量不足のときに勝手に消さないよう頼んでおく
  await navigator.storage.persist?.();
  log(`取り込み完了: ${id}（${entries.length} ファイル、${formatBytes(total)}）`);
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

function showProgress(ratio, text) {
  $('import-progress').hidden = false;
  $('import-bar').style.width = `${Math.round(ratio * 100)}%`;
  $('import-text').textContent = text;
}

// ===== 取り込みの入口 =====

// loadGame: { id, entries } を返す関数（ZIP は中身の一覧を読むのに少し時間がかかる）
async function runImport(loadGame) {
  setBusy(true);
  try {
    showProgress(0, 'ファイルを確認しています…');
    const { id, entries } = await loadGame();
    await importGame(id, entries);
    showProgress(1, '取り込みが完了しました');
  } catch (e) {
    log(String(e?.message ?? e), 'error');
    showProgress(0, `取り込みに失敗しました: ${e?.message ?? e}`);
  } finally {
    setBusy(false);
    await renderGames();
  }
}

$('folder-input').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length === 0) return;
  // webkitRelativePath は「選んだフォルダ名/ファイル名」になっている
  const folderName = files[0].webkitRelativePath.split('/')[0];
  await runImport(async () => ({
    id: toGameId(folderName),
    entries: files.map((file) => ({
      path: file.webkitRelativePath.split('/').slice(1).join('/'),
      size: file.size,
      read: async () => file,
    })),
  }));
});

$('zip-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  await runImport(async () => {
    // Mac で作った ZIP に入る管理用ファイルは除く
    const all = (await readZipEntries(file)).filter((e) => !/(^|\/)(__MACOSX\/|\._)/.test(e.name));
    // data.win があるフォルダをゲームのフォルダとみなす（ZIP の中でフォルダに入っていてもよい）
    const dataWin = all.find((e) => /(^|\/)data\.win$/i.test(e.name));
    if (!dataWin) throw new Error('ZIP の中に data.win が見つかりませんでした。ゲームのフォルダを ZIP にまとめたか確認してください。');
    const root = dataWin.name.slice(0, -'data.win'.length);
    // ゲームの名前は、ZIP の中のフォルダ名（なければ ZIP のファイル名）から付ける
    const name = root ? root.split('/').at(-2) : file.name.replace(/\.zip$/i, '');
    return {
      id: toGameId(name),
      entries: all.filter((e) => e.name.startsWith(root)).map((e) => ({
        path: e.name.slice(root.length),
        size: e.size,
        read: () => openZipEntry(file, e),
      })),
    };
  });
});

// 開発用サーバー（devserver.py）が PC のゲームフォルダを配信しているときだけ使える
async function setupDevImport() {
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return;
  let listing;
  try {
    const res = await fetch('/__devgame/list.json');
    if (!res.ok) return;
    listing = await res.json();
  } catch {
    return;
  }
  const button = $('dev-import');
  button.textContent = `開発用：PCの「${listing.name}」から取り込む`;
  button.hidden = false;
  button.addEventListener('click', () => runImport(async () => ({
    id: toGameId(listing.name),
    entries: listing.files.map((f) => ({
      path: f.path,
      size: f.size,
      read: async () => {
        const res = await fetch(`/__devgame/${f.path.split('/').map(encodeURIComponent).join('/')}`);
        if (!res.ok) throw new Error(`${f.path} を読めませんでした（${res.status}）`);
        return res.blob();
      },
    })),
  })));
}

// ===== 取り込み済みゲームの一覧 =====

let busy = false;

function setBusy(value) {
  busy = value;
  document.querySelectorAll('.menu button, .menu input').forEach((el) => { el.disabled = value; });
}

async function renderGames() {
  const ids = await listGames();
  $('no-games').hidden = ids.length > 0;
  $('games').replaceChildren(...ids.map((id) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="name"></span>
      <button class="button small" type="button" data-action="play">遊ぶ</button>
      <button class="button small danger" type="button" data-action="delete">削除</button>`;
    li.querySelector('.name').textContent = id;
    li.querySelector('[data-action="play"]').addEventListener('click', () => play(id));

    // 押し間違いで消えないよう、2回押したときだけ削除する（セーブデータは残す）
    const del = li.querySelector('[data-action="delete"]');
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'もう一度押すと削除';
        setTimeout(() => { armed = false; del.textContent = '削除'; }, 3000);
        return;
      }
      await deleteGame(id);
      log(`削除しました: ${id}`);
      await renderGames();
    });
    return li;
  }));
  if (busy) setBusy(true);
}

// ===== エンジンの起動 =====

// エンジンの不具合への応急処置（2026-10-18 の更新 #621 で入ったもの）:
// uFogColor の精度が頂点シェーダー（highp）とフラグメントシェーダー（mediump）で食い違い、
// WebGL ではシェーダーの組み立てに失敗して画面が真っ黒になる。両方を highp にそろえて渡す。
// エンジン側で直ったら消してよい。
const originalShaderSource = WebGL2RenderingContext.prototype.shaderSource;
WebGL2RenderingContext.prototype.shaderSource = function (shader, source) {
  const patched = source.replace('uniform vec4 uFogColor;', 'uniform highp vec4 uFogColor;');
  return originalShaderSource.call(this, shader, patched);
};

let enginePromise = null;
let engineBroken = false;
let running = null; // 動いている間のエンジン

function loadEngine() {
  enginePromise ??= (async () => {
    log('エンジンを読み込んでいます…');
    const Module = await createModule({
      print: (text) => log(text),
      printErr: (text) => log(text, 'error'),
    });
    const rc = await Module._mountOpfs();
    if (rc !== 0) throw new Error('保存領域（OPFS）を割り当てられませんでした');
    return Module;
  })();
  return enginePromise;
}

async function play(id) {
  if (engineBroken) {
    // エンジンが異常終了したあとは作り直す必要があるので、ページごと読み込み直す
    location.reload();
    return;
  }

  $('menu').hidden = true;
  $('player').hidden = false;
  $('game-menu').hidden = true;
  $('game-menu-title').textContent = id;
  $('player-status').textContent = `${id} を起動しています…`;

  let argv = 0;
  let pointers = [];
  let Module;
  try {
    Module = await loadEngine();
    const args = [`butterscotch/games/${id}/data.win`, '--save-folder', `butterscotch/saves/${id}`];
    pointers = args.map((arg) => Module.stringToNewUTF8(arg));
    argv = Module._malloc(4 * (pointers.length + 1));
    pointers.forEach((p, i) => Module.setValue(argv + i * 4, p, '*'));
    Module.setValue(argv + pointers.length * 4, 0, '*');

    running = Module;
    $('player-status').textContent = id;
    if (!useTouch) $('canvas').focus();
    const code = await Module._startRunner(pointers.length, argv);
    log(`ゲームが終了しました（コード ${code}）`);
  } catch (e) {
    engineBroken = true;
    if (e?.name === 'ExitStatus') {
      log(`ゲームが終了しました（コード ${e.status}）`);
    } else {
      log(`エラーで止まりました: ${e?.message ?? e}`, 'error');
      $('log-panel').open = true;
    }
  } finally {
    running = null;
    releaseAllKeys();
    if (Module && !engineBroken) {
      pointers.forEach((p) => Module._free(p));
      if (argv) Module._free(argv);
    }
    $('player').hidden = true;
    $('menu').hidden = false;
  }
}

$('quit').addEventListener('click', () => {
  running?._requestRunnerExit();
});

// ゲーム中のメニュー（タッチ操作のとき）。開いているあいだもゲームは止まらない
$('open-menu').addEventListener('click', () => {
  releaseAllKeys();
  $('game-menu').hidden = false;
});
$('resume').addEventListener('click', () => {
  $('game-menu').hidden = true;
});
$('quit-from-menu').addEventListener('click', () => {
  $('game-menu').hidden = true;
  running?._requestRunnerExit();
});

// ゲーム画面の縦横比をレイアウトに伝える（エンジンが canvas の大きさを決める）
const canvas = $('canvas');
new MutationObserver(() => {
  if (canvas.width && canvas.height) {
    $('player').style.setProperty('--game-aspect', `${canvas.width} / ${canvas.height}`);
  }
}).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });

// 音はユーザー操作のあとでないと鳴らせない。操作のたびに止まっていないか確かめて鳴らし始める
function unlockAudio() {
  for (const device of window.miniaudio?.devices ?? []) {
    if (device?.webaudio && device.webaudio.state !== 'running') device.webaudio.resume().catch(() => {});
  }
}

// ===== キーボード入力 =====
// エンジンは Windows の仮想キーコードを受け取る

const KEY_CODES = {
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Enter: 13, NumpadEnter: 13, Space: 32, Escape: 27, Backspace: 8, Tab: 9,
  ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, Insert: 45, Delete: 46,
};

function toKeyCode(code) {
  if (code in KEY_CODES) return KEY_CODES[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].charCodeAt(0);
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1].charCodeAt(0);
  if ((m = /^F([1-9]|1[0-2])$/.exec(code))) return 111 + Number(m[1]);
  return null;
}

// 1フレームより短く押して離すと、ゲームによっては押されたことに気づかない。
// （アンダーテイルは30fpsなので1フレーム約33ms）最低これだけは押したままにする。
const MIN_HOLD_MS = 80;

const pressed = new Map(); // キー → 押し始めた時刻
const pendingReleases = new Map(); // キー → 離すのを待っているタイマー

function pressKey(key) {
  if (pendingReleases.has(key)) {
    clearTimeout(pendingReleases.get(key));
    pendingReleases.delete(key);
    running?._onKeyUp(key);
  }
  if (pressed.has(key)) return;
  pressed.set(key, performance.now());
  running?._onKeyDown(key);
}

function releaseKey(key) {
  const since = pressed.get(key);
  if (since === undefined) return;
  pressed.delete(key);
  const wait = MIN_HOLD_MS - (performance.now() - since);
  if (wait <= 0) {
    running?._onKeyUp(key);
    return;
  }
  pendingReleases.set(key, setTimeout(() => {
    pendingReleases.delete(key);
    running?._onKeyUp(key);
  }, wait));
}

// 別のウィンドウに移ったときにキーが押しっぱなしにならないようにする
function releaseAllKeys() {
  for (const timer of pendingReleases.values()) clearTimeout(timer);
  for (const key of new Set([...pressed.keys(), ...pendingReleases.keys()])) running?._onKeyUp(key);
  pressed.clear();
  pendingReleases.clear();
  resetTouchControls();
}

window.addEventListener('keydown', (event) => {
  if (!running) return;
  const key = toKeyCode(event.code);
  if (key === null) return;
  // F5（再読み込み）や F12（開発ツール）はブラウザに任せる
  if (!/^F\d+$/.test(event.code)) event.preventDefault();
  unlockAudio();
  if (!event.repeat) pressKey(key);
});

window.addEventListener('keyup', (event) => {
  const key = toKeyCode(event.code);
  if (key !== null) releaseKey(key);
});
window.addEventListener('blur', releaseAllKeys);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseAllKeys();
});

// ===== タッチ操作 =====
// 指で触れる端末では画面にボタンを出す。PC で確かめるときは URL に ?touch を付ける

const useTouch = new URLSearchParams(location.search).has('touch') || matchMedia('(any-pointer: coarse)').matches;
$('player').classList.toggle('touch', useTouch);
$('player').addEventListener('contextmenu', (event) => event.preventDefault());

function capturePointer(element, event) {
  // 指がボタンの外に出ても、離すまでは同じボタンの操作として扱う
  try {
    element.setPointerCapture(event.pointerId);
  } catch {
    // 合成イベントなどでは失敗することがある。その場合は普通に動かす
  }
}

function buzz() {
  navigator.vibrate?.(8); // Android のみ。iPhone のブラウザは振動に対応していない
}

// --- 十字キー ---
// 指を離さずに滑らせて方向を変えられる。真ん中付近は「どこも押していない」扱い。

const DIRECTION_KEYS = { up: 38, right: 39, down: 40, left: 37 };
const DIRECTION_ANGLES = { right: 0, down: 90, left: 180, up: 270 };
// 上下左右それぞれの真上から ±30° は1方向だけ、そのあいだの30°は斜め（2方向）
const DIRECTION_REACH = 60;
const DEAD_ZONE = 0.12; // 十字キーの幅に対する、真ん中の反応しない範囲

const dpad = $('dpad');
const dpadCross = dpad.querySelector('.dpad-cross');
let dpadPointer = null;
let dpadDirections = new Set();

function directionsAt(event) {
  const rect = dpadCross.getBoundingClientRect();
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  if (Math.hypot(dx, dy) < rect.width * DEAD_ZONE) return new Set();
  const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; // 0° が右、90° が下
  const directions = new Set();
  for (const [name, center] of Object.entries(DIRECTION_ANGLES)) {
    const distance = Math.abs(((angle - center + 540) % 360) - 180);
    if (distance < DIRECTION_REACH) directions.add(name);
  }
  return directions;
}

function setDpadDirections(next) {
  for (const name of dpadDirections) if (!next.has(name)) releaseKey(DIRECTION_KEYS[name]);
  for (const name of next) if (!dpadDirections.has(name)) pressKey(DIRECTION_KEYS[name]);
  if (next.size > dpadDirections.size) buzz();
  dpadDirections = next;
  for (const arm of dpad.querySelectorAll('.arm')) arm.classList.toggle('on', next.has(arm.dataset.dir));
}

dpad.addEventListener('pointerdown', (event) => {
  if (!running || dpadPointer !== null) return;
  dpadPointer = event.pointerId;
  capturePointer(dpad, event);
  setDpadDirections(directionsAt(event));
});
dpad.addEventListener('pointermove', (event) => {
  if (event.pointerId === dpadPointer) setDpadDirections(directionsAt(event));
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  dpad.addEventListener(type, (event) => {
    if (event.pointerId !== dpadPointer) return;
    dpadPointer = null;
    setDpadDirections(new Set());
    unlockAudio();
  });
}

// --- Z / X / C ボタン ---

const buttonPointers = new Map(); // ボタン → 押している指

for (const button of document.querySelectorAll('.pad-btn')) {
  const key = Number(button.dataset.key);
  button.addEventListener('pointerdown', (event) => {
    if (!running || buttonPointers.has(button)) return;
    buttonPointers.set(button, event.pointerId);
    capturePointer(button, event);
    button.classList.add('on');
    pressKey(key);
    buzz();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, (event) => {
      if (buttonPointers.get(button) !== event.pointerId) return;
      buttonPointers.delete(button);
      button.classList.remove('on');
      releaseKey(key);
      unlockAudio();
    });
  }
}

// 見た目と「押している指」の記録だけを消す（キーを離す処理は releaseAllKeys が行う）
function resetTouchControls() {
  dpadPointer = null;
  dpadDirections = new Set();
  buttonPointers.clear();
  document.querySelectorAll('.controls .on').forEach((el) => el.classList.remove('on'));
}

// ===== はじめに =====

// スマホのブラウザはフォルダごと選べないので、ZIP だけにする
$('folder-button').hidden = useTouch;

if (checkEnvironment()) {
  await renderGames();
  await setupDevImport();
} else {
  log('このブラウザでは動かせません。動作環境を確認してください。', 'error');
  $('zip-input').disabled = true;
  $('folder-input').disabled = true;
}
