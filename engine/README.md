# engine

Butterscotch（GameMaker: Studio ランナーのオープンソース再実装）の WebAssembly 版ビルドです。

## 元のビルドからの変更

`butterscotch.mjs` の1か所だけ変えています（`Pocket Runner: Safari` で検索すると見つかります）。

- ブラウザの保存領域へファイルを書くとき（`FileSystemAsyncAccessHandle` の `write` と `truncate`）、
  位置を指定して書き足す代わりに、ファイル全体を読み直して丸ごと書き直す。
  Safari では位置を指定した書き込みが容量を多く数えて失敗することがあり（WebKit bug 320355）、
  iPhone でセーブが残らなかったため。書き込むデータは待つ前にコピーし、途中でメモリが動いても壊れないようにしている。

`butterscotch.wasm` は元のままです。

## 互換エンジン（`compat/`）

JSPI がない少し古いブラウザ（古めの Android の Chrome、Samsung Internet、iOS 26 など）用に、
同じソース（上のコミット）を JSPI ではなく Asyncify で組み立てたものです。JSPI 版より少し大きく、少しゆっくりです。
アプリは JSPI があれば `engine/`、なければ `engine/compat/` を自動で使います（URL に `?engine=compat` を付けると互換エンジンを試せます）。

組み立て方は `engine-build/build_compat.ps1` を参照してください。

- `engine-build/patch_cmake.py`: CMakeLists.txt の `-sJSPI` を `-sASYNCIFY=1`（と大きめの `ASYNCIFY_STACK_SIZE`）に置き換える
- `engine-build/patch_glue.py`: 組み立てた `butterscotch.mjs` に、上と同じ書き込み方の変更を入れる

互換エンジンは中の名前が縮められているため、「待つ」処理を画面の書き換えにそろえる工夫（`app.js` の `sleepUntilVsync`）は使っていません。

- 入手元: https://nightly.link/ButterscotchRunner/Butterscotch/workflows/build/main/butterscotch-web.zip
- ソースコード: https://github.com/ButterscotchRunner/Butterscotch
- 取得時点の main の最新コミット: `38e4a16d9b280292fcd411bb5bb6029cf252dc43`（2026-10-21）
- ライセンス: AGPL-3.0（`LICENSE` を参照）

## アプリから使っている入口

| 関数 | 役割 |
| --- | --- |
| `_mountOpfs()` | ブラウザの保存領域（OPFS）を `/butterscotch` に割り当てる |
| `_startRunner(argc, argv)` | ゲームを起動する。終了するまで Promise が解決しない |
| `_requestRunnerExit()` | ゲームの終了を頼む |
| `_onKeyDown(code)` / `_onKeyUp(code)` | キー入力を伝える（Windows の仮想キーコード） |

起動時の引数は公式ランチャーと同じ形にしています。

```
butterscotch/games/<id>/data.win --save-folder butterscotch/saves/<id>
```
