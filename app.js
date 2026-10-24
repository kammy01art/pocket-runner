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

// 次のコマまでの待ち時間を、画面の書き換えの合図（requestAnimationFrame）にそろえる。
// エンジンはタイマーで待つので、そのままだと 120Hz などの画面の書き換えとずれて
// コマの間隔がまばらになり、かくかくして見える。
const VSYNC_TOLERANCE_MS = 4; // 予定よりこの分だけ早くても、その書き換えで次のコマに進む
let frameCount = 0; // なめらかさ（1秒あたりのコマ数）を出すために数える
let lastVsync = 0; // 最後に書き換えの合図が来た時刻

function sleepUntilVsync(ms) {
  frameCount++;
  return new Promise((resolve) => {
    // 合図がしばらく来ていない（画面が隠れているなど）ときは、タイマーだけで待つ
    if (performance.now() - lastVsync > 250) {
      requestAnimationFrame((now) => {
        lastVsync = now;
      });
      setTimeout(resolve, ms);
      return;
    }
    const wake = performance.now() + ms;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const onFrame = (now) => {
      lastVsync = now;
      if (done) return;
      if (now >= wake - VSYNC_TOLERANCE_MS) finish();
      else requestAnimationFrame(onFrame);
    };
    // 近くまではタイマーで寝て、最後だけ書き換えの合図で起きる
    setTimeout(() => requestAnimationFrame(onFrame), Math.max(0, ms - 12));
    // 途中で合図が止まっても、ゲームが止まったままにならないようにする
    setTimeout(finish, ms + 250);
  });
}

function loadEngine() {
  enginePromise ??= (async () => {
    log('エンジンを読み込んでいます…');
    const Module = await createModule({
      print: (text) => log(text),
      printErr: (text) => log(text, 'error'),
      // エンジンの「待つ」処理だけを差し替えて読み込む
      instantiateWasm(imports, receiveInstance) {
        if (typeof WebAssembly.Suspending === 'function') {
          imports.env.emscripten_sleep = new WebAssembly.Suspending(sleepUntilVsync);
        }
        const url = new URL('./engine/butterscotch.wasm', import.meta.url);
        WebAssembly.instantiateStreaming(fetch(url), imports)
          .then(({ instance }) => receiveInstance(instance))
          .catch((e) => log(`エンジンを読み込めませんでした: ${e?.message ?? e}`, 'error'));
        return {};
      },
    });
    const rc = await Module._mountOpfs();
    if (rc !== 0) throw new Error('保存領域（OPFS）を割り当てられませんでした');
    return Module;
  })();
  return enginePromise;
}

// アンダーテイルは本来、パソコンの言語が日本語なら日本語で始まる。
// エンジンはいつも「英語」と答えるので、初めて遊ぶときだけ言語設定を先に書いておく。
// （ゲームの「せってい」で言語を変えると、このファイルが書き換わってそちらが優先される）
async function presetLanguage(id) {
  if (!/undertale/i.test(id) || !navigator.language.toLowerCase().startsWith('ja')) return;
  const saves = await (await navigator.storage.getDirectory()).getDirectoryHandle('saves', { create: true });
  const dir = await saves.getDirectoryHandle(id, { create: true });
  try {
    await dir.getFileHandle('config.ini');
    return; // 設定がすでにある
  } catch {
    // まだない（初めて遊ぶ）
  }
  const writable = await (await dir.getFileHandle('config.ini', { create: true })).createWritable();
  await writable.write('[General]\nlang="ja"\n');
  await writable.close();
  log('言語を日本語にしました（ゲームの「せってい」で変えられます）');
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
  currentGame = id;

  let argv = 0;
  let pointers = [];
  let Module;
  try {
    Module = await loadEngine();
    await presetLanguage(id);
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
let fpsTimer = 0;
let currentGame = null; // 遊んでいるゲーム（セーブの置き場所の名前）

// 最後にセーブした時刻を出す（セーブできているかを確かめるため）。
// アンダーテイルはセーブポイントで file0 に記録するので、あればその時刻、なければいちばん新しいファイルの時刻を出す
async function showSaveInfo() {
  const info = $('save-info');
  info.textContent = '';
  if (!currentGame) return;
  let latest = null;
  let file0 = null;
  try {
    const saves = await (await navigator.storage.getDirectory()).getDirectoryHandle('saves');
    const dir = await saves.getDirectoryHandle(currentGame);
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      const time = (await handle.getFile()).lastModified;
      if (name === 'file0') file0 = time;
      latest = Math.max(latest ?? 0, time);
    }
  } catch {
    // まだセーブの置き場所がない
  }
  const format = (time) => new Date(time).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (file0) info.textContent = `さいごに セーブした じかん: ${format(file0)}`;
  else if (latest) info.textContent = `さいごの きろく: ${format(latest)}（セーブポイントでは まだ セーブしていません）`;
  else info.textContent = 'まだ セーブしていません';
}

$('open-menu').addEventListener('click', () => {
  releaseAllKeys();
  $('open-menu').blur(); // フォーカスが残ると、ゲーム中の Enter や Space でまた押されてしまう
  $('game-menu').hidden = false;
  showSaveInfo();
  // メニューを開いているあいだ、1秒あたりのコマ数を出す（なめらかさの目安）
  let last = frameCount;
  $('fps').textContent = '';
  clearInterval(fpsTimer);
  fpsTimer = setInterval(() => {
    $('fps').textContent = `${frameCount - last}fps`;
    last = frameCount;
  }, 1000);
});
$('resume').addEventListener('click', () => {
  $('game-menu').hidden = true;
  clearInterval(fpsTimer);
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
  if (event.repeat) return;
  pressKey(key);
  showKey(key, true);
});

window.addEventListener('keyup', (event) => {
  const key = toKeyCode(event.code);
  if (key === null) return;
  releaseKey(key);
  showKey(key, false);
});

// キーボードで押したキーも、画面の操作部分に映して見せる（PC で見た目を確かめやすくするため）
const BUTTON_VISUALS = { 90: '.pad-btn[data-key="90"]', 88: '.pad-btn[data-key="88"]', 67: '.pad-btn[data-key="67"]' };
const ARROW_DIRECTIONS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
const keyboardDirections = new Set();

function showKey(key, on) {
  if (key in ARROW_DIRECTIONS) {
    keyboardDirections[on ? 'add' : 'delete'](ARROW_DIRECTIONS[key]);
    if (movePointer === null) showMove(keyboardDirections);
    return;
  }
  const selector = BUTTON_VISUALS[key];
  if (selector) document.querySelector(`.controls ${selector}`)?.classList.toggle('on', on);
}
window.addEventListener('blur', releaseAllKeys);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseAllKeys();
});

// ===== タッチ操作 =====
// 指で触れる端末では画面にボタンを出す。PC で確かめるときは URL に ?touch を付ける

const useTouch = new URLSearchParams(location.search).has('touch') || matchMedia('(any-pointer: coarse)').matches;
$('player').addEventListener('contextmenu', (event) => event.preventDefault());

// --- 表示の切り替え（PC） ---
// スマホでは画面いっぱいにタッチ操作を出す。PC では iPhone 15 Pro の大きさの枠で
// 「横持ち」「縦持ち」を再現するか、ゲーム画面だけを大きく出すかを選べる（選んだものは覚えておく）。
// 遊ぶときは横持ちが多い想定なので、最初は横持ち。

const VIEWS = ['landscape', 'portrait', 'plain'];
const VIEW_STORAGE_KEY = 'pocket-runner:view:v2'; // 最初の表示を横持ちに変えたので、前の記録は使わない

function setView(view) {
  const player = $('player');
  player.dataset.view = view;
  player.classList.toggle('touch', view !== 'plain');
  player.classList.toggle('framed', view !== 'plain');
  for (const button of document.querySelectorAll('.view-switch button')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
  fitDevice();
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // 保存できなくても表示は切り替わる
  }
}

// 枠（実寸 393×852）がウィンドウに収まるように、縮める割合を決める。大きくはしない
const DEVICE_SIZE = { portrait: [393, 852], landscape: [852, 393] };
const deviceArea = document.querySelector('.device-area');

function fitDevice() {
  const size = DEVICE_SIZE[$('player').dataset.view];
  if (!size) return;
  const style = getComputedStyle(deviceArea);
  const width = deviceArea.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = deviceArea.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const scale = Math.max(0.1, Math.min(1, width / size[0], height / size[1]));
  $('player').style.setProperty('--device-scale', scale.toFixed(3));
}
new ResizeObserver(fitDevice).observe(deviceArea);

// --- 画面の向き（スマホ） ---
// 端末を傾けても縦持ち・横持ちが勝手に切り替わらないよう、ゲーム中のメニューで選んだ向きに固定する。
// 選んだ向きと端末の向きが違うときは、本体ごと 90° 回して表示する（寝ころんで遊ぶときなど）。

const LAYOUTS = ['landscape', 'landscape-flip', 'portrait'];
const LAYOUT_STORAGE_KEY = 'pocket-runner:layout';
let layout = 'landscape';
let rotation = 0; // 本体を回している角度（時計回りが正）

function applyLayout() {
  if (!useTouch) return;
  const width = deviceArea.clientWidth;
  const height = deviceArea.clientHeight;
  if (!width || !height) return;
  const osLandscape = width > height;
  // 端末を横にしたとき、OS がどちらに画面を回したか（90: 左に倒した、270: 右に倒した）
  const osAngle = ((screen.orientation?.angle ?? window.orientation ?? 0) + 360) % 360;
  if (layout === 'portrait') {
    // 縦持ちは、端末の上側がいつも画面の上になるように戻す
    rotation = osLandscape ? (osAngle === 270 ? 90 : -90) : 0;
  } else {
    rotation = osLandscape ? 0 : layout === 'landscape-flip' ? -90 : 90;
  }
  const player = $('player');
  player.dataset.rotate = String(rotation);
  player.style.setProperty('--area-w', `${width}px`);
  player.style.setProperty('--area-h', `${height}px`);
}

function setLayout(next) {
  releaseAllKeys();
  layout = next;
  for (const button of document.querySelectorAll('.sheet-option[data-layout]')) {
    button.setAttribute('aria-pressed', String(button.dataset.layout === next));
  }
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, next);
  } catch {
    // 保存できなくても切り替わる
  }
  applyLayout();
}

if (useTouch) {
  $('player').classList.add('touch', 'touch-device');
  $('layout-setting').hidden = false;
  let saved = null;
  try {
    saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
  } catch {
    // 読めなければ横持ちから
  }
  layout = LAYOUTS.includes(saved) ? saved : 'landscape';
  for (const button of document.querySelectorAll('.sheet-option[data-layout]')) {
    button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
    button.addEventListener('click', () => setLayout(button.dataset.layout));
  }
  new ResizeObserver(applyLayout).observe(deviceArea);
  window.addEventListener('resize', applyLayout);
  screen.orientation?.addEventListener('change', applyLayout);
  window.addEventListener('orientationchange', applyLayout);
} else {
  let saved = null;
  try {
    saved = localStorage.getItem(VIEW_STORAGE_KEY);
  } catch {
    // 読めなければ横持ちから
  }
  setView(VIEWS.includes(saved) ? saved : 'landscape');
  for (const button of document.querySelectorAll('.view-switch button')) {
    button.addEventListener('click', () => {
      setView(button.dataset.view);
      button.blur(); // フォーカスが残ると、ゲーム中の Enter や Space でまた押されてしまう
    });
  }
}

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

// --- 移動（十字キー / スティック） ---
// どちらも、左側のどこに触れても、十字キー（スティック）の真ん中から指への向きで移動する。
// 指を離さずに向きを変えられる。どちらを使うかは、ゲーム中のメニューで切り替えられる（選んだものは覚えておく）。

const DIRECTION_KEYS = { up: 38, right: 39, down: 40, left: 37 };
const DIRECTION_ANGLES = { right: 0, down: 90, left: 180, up: 270 };
// 上下左右それぞれの真上から ±30° は1方向だけ、そのあいだの30°は斜め（2方向）
const DIRECTION_REACH = 60;
// 真ん中の反応しない範囲（十字キー・スティックの半径に対する割合）
const DEAD_ZONE = { dpad: 0.24, stick: 0.2 };

const MOVE_MODES = ['dpad', 'stick'];
const MOVE_STORAGE_KEY = 'pocket-runner:move';

const moveZones = { dpad: $('dpad'), stick: $('stick') };
const stickWell = moveZones.stick.querySelector('.well');
const stickCap = moveZones.stick.querySelector('.stick-cap');
let moveMode = 'dpad';
let movePointer = null;
let moveDirections = new Set();

function setMoveMode(mode) {
  releaseAllKeys();
  moveMode = mode;
  $('player').dataset.move = mode;
  for (const button of document.querySelectorAll('[data-move]')) {
    if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(button.dataset.move === mode));
  }
  try {
    localStorage.setItem(MOVE_STORAGE_KEY, mode);
  } catch {
    // 保存できなくても切り替わる
  }
}

function directionsFor(dx, dy, deadZone) {
  if (Math.hypot(dx, dy) < deadZone) return new Set();
  const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; // 0° が右、90° が下
  const directions = new Set();
  for (const [name, center] of Object.entries(DIRECTION_ANGLES)) {
    const distance = Math.abs(((angle - center + 540) % 360) - 180);
    if (distance < DIRECTION_REACH) directions.add(name);
  }
  return directions;
}

function setMoveDirections(next) {
  for (const name of moveDirections) if (!next.has(name)) releaseKey(DIRECTION_KEYS[name]);
  for (const name of next) if (!moveDirections.has(name)) pressKey(DIRECTION_KEYS[name]);
  if (next.size > moveDirections.size) buzz();
  moveDirections = next;
}

// スティックのキャップを、くぼみの中で動かす。dx, dy は真ん中からのずれ（画面上の px）
function moveCap(dx, dy) {
  // PC の枠は縮めて表示しているので、画面上の px を本体の中の px に直す
  const scale = stickWell.getBoundingClientRect().width / stickWell.offsetWidth || 1;
  const limit = (stickWell.offsetWidth - stickCap.offsetWidth) / 2;
  let x = dx / scale;
  let y = dy / scale;
  const length = Math.hypot(x, y);
  if (length > limit) {
    x = (x / length) * Math.max(limit, 0);
    y = (y / length) * Math.max(limit, 0);
  }
  stickWell.style.setProperty('--hx', `${x}px`);
  stickWell.style.setProperty('--hy', `${y}px`);
}

// 押している向きを見た目に映す（十字キーはその腕が沈み、スティックはその向きに倒れる）
function showMove(directions) {
  for (const press of moveZones.dpad.querySelectorAll('.press')) {
    press.classList.toggle('on', directions.has(press.dataset.dir));
  }
  const x = (directions.has('right') ? 1 : 0) - (directions.has('left') ? 1 : 0);
  const y = (directions.has('down') ? 1 : 0) - (directions.has('up') ? 1 : 0);
  if (movePointer === null) moveCap(x * 1000, y * 1000);
}

function updateMove(event) {
  const center = moveZones[moveMode].querySelector(moveMode === 'dpad' ? '.dpad-svg' : '.well').getBoundingClientRect();
  const sx = event.clientX - (center.left + center.width / 2);
  const sy = event.clientY - (center.top + center.height / 2);
  // 本体を回して表示しているときは、画面上の向きを本体の上での向きに直す
  const [dx, dy] = rotation === 90 ? [sy, -sx] : rotation === -90 ? [-sy, sx] : [sx, sy];
  const directions = directionsFor(dx, dy, (center.width / 2) * DEAD_ZONE[moveMode]);
  setMoveDirections(directions);
  if (moveMode === 'stick') moveCap(dx, dy);
  else showMove(directions);
}

for (const [mode, zone] of Object.entries(moveZones)) {
  zone.addEventListener('pointerdown', (event) => {
    if (!running || movePointer !== null || mode !== moveMode) return;
    event.preventDefault(); // PC でマウスで押したとき、フォーカスが移らないようにする
    movePointer = event.pointerId;
    capturePointer(zone, event);
    zone.classList.add('active');
    updateMove(event);
  });
  zone.addEventListener('pointermove', (event) => {
    if (event.pointerId === movePointer) updateMove(event);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    zone.addEventListener(type, (event) => {
      if (event.pointerId !== movePointer) return;
      movePointer = null;
      zone.classList.remove('active');
      setMoveDirections(new Set());
      showMove(new Set());
      unlockAudio();
    });
  }
}

for (const button of document.querySelectorAll('.sheet-option[data-move]')) {
  button.addEventListener('click', () => setMoveMode(button.dataset.move));
}

// --- Z / X / C ボタン ---

const buttonPointers = new Map(); // ボタン → 押している指

for (const button of document.querySelectorAll('.pad-btn')) {
  const key = Number(button.dataset.key);
  button.addEventListener('pointerdown', (event) => {
    if (!running || buttonPointers.has(button)) return;
    event.preventDefault(); // PC でマウスで押したとき、フォーカスが移らないようにする
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
  movePointer = null;
  moveDirections = new Set();
  keyboardDirections.clear();
  for (const zone of Object.values(moveZones)) zone.classList.remove('active');
  stickWell.style.setProperty('--hx', '0px');
  stickWell.style.setProperty('--hy', '0px');
  buttonPointers.clear();
  document.querySelectorAll('.controls .on').forEach((el) => el.classList.remove('on'));
}

{
  let saved = null;
  try {
    saved = localStorage.getItem(MOVE_STORAGE_KEY);
  } catch {
    // 読めなければ十字キー
  }
  setMoveMode(MOVE_MODES.includes(saved) ? saved : 'dpad');
}

// ===== 画面の拡大を止める =====
// iPhone はピンチやダブルタップで画面を拡大でき、ゲーム中に拡大されると戻せなくなる。
// 拡大の操作を止め、それでも拡大されてしまったら元の倍率に戻す。

for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (event) => {
  if (event.touches.length > 1) event.preventDefault();
}, { passive: false });
document.addEventListener('dblclick', (event) => event.preventDefault(), { passive: false });

function resetZoom() {
  const meta = document.querySelector('meta[name="viewport"]');
  const content = meta.content;
  // viewport の設定を書き換えると、iPhone は倍率を元に戻す
  meta.content = `${content}, minimum-scale=1`;
  setTimeout(() => {
    meta.content = content;
  }, 100);
}
window.visualViewport?.addEventListener('resize', () => {
  if (window.visualViewport.scale > 1.01) resetZoom();
});

// ===== はじめに =====

// スマホのブラウザはフォルダごと選べないので、ZIP だけにする
$('folder-button').hidden = useTouch;

// オフラインでも開けるように、アプリのファイルを端末に保存しておく（sw.js）。
// 開発中（localhost）は古いファイルが使われて紛らわしいので、?sw を付けたときだけ使う。
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && (!isLocal || new URLSearchParams(location.search).has('sw'))) {
  navigator.serviceWorker.register('./sw.js').catch((e) => log(`オフライン用の準備に失敗しました: ${e?.message ?? e}`, 'error'));
}

if (checkEnvironment()) {
  await renderGames();
  await setupDevImport();
} else {
  log('このブラウザでは動かせません。動作環境を確認してください。', 'error');
  $('zip-input').disabled = true;
  $('folder-input').disabled = true;
}
