# engine

Butterscotch（GameMaker: Studio ランナーのオープンソース再実装）の WebAssembly 版ビルドです。
このフォルダのファイルには手を加えていません。

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
