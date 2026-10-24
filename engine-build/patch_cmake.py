"""Butterscotch の Web 版を、JSPI ではなく Asyncify で組み立てるように CMakeLists.txt を書き換える。

JSPI は新しいブラウザ（Chrome 137 以降、Safari 27 以降など）にしかないため、
それより古いブラウザでも動く「互換エンジン」を作るのに使う。

使い方: python patch_cmake.py path/to/Butterscotch/CMakeLists.txt
"""

import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")

# JSPI の代わりに Asyncify を使う。待つ処理の途中の情報を退避する場所は大きめに取る
patched = source.replace(
    '"-sJSPI"',
    '"-sASYNCIFY=1"\n                "-sASYNCIFY_STACK_SIZE=4194304"',
)
# JSPI 用の書き出し指定は Asyncify では使わない
patched = re.sub(r'\s*"-sJSPI_EXPORTS=\[[^\]]*\]"', "", patched)

if patched == source or "-sJSPI" in patched or "-sASYNCIFY=1" not in patched:
    sys.exit("CMakeLists.txt の JSPI の設定が見つからない、または置き換えられませんでした")

path.write_text(patched, encoding="utf-8")
print("CMakeLists.txt: JSPI を Asyncify に置き換えました")
