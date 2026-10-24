# 互換エンジン（JSPI を使わない Asyncify 版の Butterscotch）を組み立てて engine/compat/ に置く。
# JSPI がない少し古いブラウザ（古めの Android の Chrome、Samsung Internet、iOS 26 など）でも動かすため。
#
# 必要なもの:
#   - emsdk（https://github.com/emscripten-core/emsdk を取得して `emsdk install latest` と `emsdk activate latest` 済み）
#   - cmake と ninja が入った Python の venv（`python -m venv buildenv` → `buildenv\Scripts\pip install cmake ninja`）
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File engine-build\build_compat.ps1 -Emsdk <emsdk のフォルダ> -BuildEnv <venv のフォルダ>

param(
  [Parameter(Mandatory = $true)] [string] $Emsdk,
  [Parameter(Mandatory = $true)] [string] $BuildEnv,
  # engine/ の JSPI 版と同じソースから組み立てる
  [string] $Commit = '38e4a16d9b280292fcd411bb5bb6029cf252dc43',
  [string] $WorkDir = (Join-Path $env:TEMP 'pocket-runner-compat')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# emcc などを使えるようにし、cmake と ninja を探せるようにする
& (Join-Path $Emsdk 'emsdk_env.ps1') | Out-Null
$env:PATH = "$(Join-Path $BuildEnv 'Scripts');$env:PATH"

New-Item -ItemType Directory -Force $WorkDir | Out-Null
$src = Join-Path $WorkDir 'butterscotch'
if (-not (Test-Path $src)) {
  git clone --quiet https://github.com/ButterscotchRunner/Butterscotch.git $src
  if ($LASTEXITCODE -ne 0) { throw 'Butterscotch のソースを取得できませんでした' }
}
# 前回の書き換えを消してから、指定の版にそろえる
git -C $src checkout --quiet --force $Commit
if ($LASTEXITCODE -ne 0) { throw "Butterscotch の $Commit に切り替えられませんでした" }

python (Join-Path $PSScriptRoot 'patch_cmake.py') (Join-Path $src 'CMakeLists.txt')
if ($LASTEXITCODE -ne 0) { throw 'CMakeLists.txt を書き換えられませんでした' }

$build = Join-Path $WorkDir 'build'
emcmake cmake -S $src -B $build -G Ninja -DPLATFORM=web -DBACKEND=web -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE -ne 0) { throw 'cmake の設定に失敗しました' }
cmake --build $build
if ($LASTEXITCODE -ne 0) { throw '組み立てに失敗しました' }

python (Join-Path $PSScriptRoot 'patch_glue.py') (Join-Path $build 'butterscotch.mjs')
if ($LASTEXITCODE -ne 0) { throw 'butterscotch.mjs を書き換えられませんでした' }

$out = Join-Path $root 'engine\compat'
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $build 'butterscotch.mjs'), (Join-Path $build 'butterscotch.wasm') $out -Force
Get-ChildItem $out | Format-Table Name, Length
