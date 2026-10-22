// ZIP ファイルの中身を読む（外部ライブラリなし）。
// 圧縮なし（store）と deflate に対応。4GB を超える ZIP（Zip64）とパスワード付きには対応しない。
// 展開はブラウザ標準の DecompressionStream に任せ、ファイル全体をメモリに載せずに少しずつ流す。

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// ZIP に入っているファイルの一覧を返す（フォルダの項目は除く）
export async function readZipEntries(file) {
  // 一覧の場所は末尾に書かれている。後ろにコメント（最大 64KB）が付いていることがあるので、その分も読む
  const tailSize = Math.min(file.size, 22 + 0xffff);
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('ZIP ファイルとして読めませんでした。');

  const count = tail.getUint16(end + 10, true);
  const directorySize = tail.getUint32(end + 12, true);
  const directoryOffset = tail.getUint32(end + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error('4GB を超える大きな ZIP には対応していません。');
  }

  const directory = new DataView(await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (directory.getUint32(p, true) !== CENTRAL_DIRECTORY_HEADER) throw new Error('ZIP の中身の一覧が壊れています。');
    const flags = directory.getUint16(p + 8, true);
    const nameLength = directory.getUint16(p + 28, true);
    const extraLength = directory.getUint16(p + 30, true);
    const commentLength = directory.getUint16(p + 32, true);
    // ファイル名が UTF-8 だと印が付いていなければ、日本語版 Windows の Shift_JIS とみなす（英数字だけなら同じ）
    const decoder = new TextDecoder(flags & 0x800 ? 'utf-8' : 'shift_jis');
    const name = decoder.decode(new Uint8Array(directory.buffer, p + 46, nameLength)).replaceAll('\\', '/');
    const entry = {
      name,
      method: directory.getUint16(p + 10, true),
      compressedSize: directory.getUint32(p + 20, true),
      size: directory.getUint32(p + 24, true),
      localOffset: directory.getUint32(p + 42, true),
      encrypted: (flags & 0x1) !== 0,
    };
    p += 46 + nameLength + extraLength + commentLength;
    if (!name.endsWith('/')) entries.push(entry);
  }
  return entries;
}

// ZIP の中の1ファイルを、展開しながら読める ReadableStream として返す
export async function openZipEntry(file, entry) {
  if (entry.encrypted) throw new Error(`${entry.name} はパスワード付きのため読めません。`);

  // 中身の直前にある見出しは、一覧とは長さが違うことがあるので読み直して開始位置を求める
  const header = new DataView(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  if (header.getUint32(0, true) !== LOCAL_FILE_HEADER) throw new Error(`${entry.name} の位置が壊れています。`);
  const start = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const data = file.slice(start, start + entry.compressedSize).stream();

  if (entry.method === METHOD_STORE) return data;
  if (entry.method === METHOD_DEFLATE) return data.pipeThrough(new DecompressionStream('deflate-raw'));
  throw new Error(`${entry.name} は対応していない圧縮方式（${entry.method}）です。`);
}
