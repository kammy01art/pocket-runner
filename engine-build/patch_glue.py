"""エンジンの JavaScript 部分（butterscotch.mjs）の、保存領域への書き込み方を変える。

位置を指定して書き足す代わりに、ファイル全体を読み直して丸ごと書き直す。
Safari では位置を指定した書き込みが容量を多く数えて失敗することがあり（WebKit bug 320355）、
iPhone でセーブが残らなかったため。engine/butterscotch.mjs にも同じ変更を入れている。

使い方: python patch_glue.py path/to/butterscotch.mjs
"""

import sys
from pathlib import Path

ORIGINAL = (
    'async write(buffer,options={at:0}){let writable=await this.handle.createWritable({keepExistingData:true});'
    'await writable.write({type:"write",position:options.at,data:buffer});await writable.close();return buffer.length}'
    'async truncate(size){let writable=await this.handle.createWritable({keepExistingData:true});'
    'await writable.truncate(size);await writable.close()}'
)
REPLACEMENT = (
    'async write(buffer,options={at:0}){/* Pocket Runner: Safari で位置指定の書き込みが失敗することがあるため、ファイル全体を書き直す */'
    'let data=buffer.slice();let old=new Uint8Array(await (await this.handle.getFile()).arrayBuffer());let at=options.at;'
    'let next=new Uint8Array(Math.max(old.length,at+data.length));next.set(old);next.set(data,at);'
    'let writable=await this.handle.createWritable();await writable.write(next);await writable.close();return data.length}'
    'async truncate(size){let old=new Uint8Array(await (await this.handle.getFile()).arrayBuffer());'
    'let next=new Uint8Array(size);next.set(old.subarray(0,Math.min(size,old.length)));'
    'let writable=await this.handle.createWritable();await writable.write(next);await writable.close()}'
)

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
count = source.count(ORIGINAL)
if count != 1:
    sys.exit(f"書き込み処理が {count} か所見つかりました（1か所のはず）。エンジンの版が変わった可能性があります")

path.write_text(source.replace(ORIGINAL, REPLACEMENT), encoding="utf-8")
print("butterscotch.mjs: 保存領域への書き込み方を変えました")
