"""開発用のローカルサーバー。

アプリのファイルを http://localhost:<port>/ で配信する。
--game-dir を渡すと、そのフォルダのゲームデータを /__devgame/ からも読めるようにする
（PC での動作確認用。ネット上には置かない）。
127.0.0.1 にだけ公開するので、ほかの端末からは見えない。

使い方:
    python devserver.py --port 8765 --game-dir "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Undertale"
"""

import argparse
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DEV_PREFIX = "/__devgame/"
SKIPPED_EXTENSIONS = (".exe", ".dll")


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
        ".md": "text/plain; charset=utf-8",
    }

    def __init__(self, *args, game_dir=None, **kwargs):
        self.game_dir = game_dir
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path.startswith(DEV_PREFIX):
            self.serve_dev_game(path[len(DEV_PREFIX):])
            return
        super().do_GET()

    def serve_dev_game(self, relative_path):
        if not self.game_dir:
            self.send_error(404, "--game-dir is not set")
            return

        if relative_path == "list.json":
            files = []
            for dir_path, _, names in os.walk(self.game_dir):
                for name in sorted(names):
                    if name.lower().endswith(SKIPPED_EXTENSIONS):
                        continue
                    full_path = os.path.join(dir_path, name)
                    files.append({
                        "path": os.path.relpath(full_path, self.game_dir).replace(os.sep, "/"),
                        "size": os.path.getsize(full_path),
                    })
            name = os.path.basename(os.path.normpath(self.game_dir))
            self.send_bytes(json.dumps({"name": name, "files": files}).encode(), "application/json")
            return

        # ゲームフォルダの外を読ませない
        root = os.path.realpath(self.game_dir)
        full_path = os.path.realpath(os.path.join(root, relative_path))
        if os.path.commonpath([root, full_path]) != root or not os.path.isfile(full_path):
            self.send_error(404)
            return
        with open(full_path, "rb") as f:
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(os.fstat(f.fileno()).st_size))
            self.end_headers()
            self.copyfile(f, self.wfile)

    def send_bytes(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # 作業中に古いファイルが使われないよう、キャッシュさせない
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--game-dir", help="開発用に配信するゲームフォルダ")
    args = parser.parse_args()

    if args.game_dir and not os.path.isdir(args.game_dir):
        parser.error(f"フォルダが見つかりません: {args.game_dir}")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, game_dir=args.game_dir))
    print(f"Serving {APP_DIR} at http://localhost:{args.port}/", flush=True)
    if args.game_dir:
        print(f"Dev game folder: {args.game_dir}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
