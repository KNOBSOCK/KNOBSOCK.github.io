"""Local static preview with GitHub Pages-style extensionless HTML routes."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path):
        translated = super().translate_path(path)
        candidate = Path(translated)
        if not candidate.is_file() and not candidate.suffix:
            html = candidate.with_suffix('.html')
            if html.is_file():
                return str(html)
        return translated

if __name__ == '__main__':
    print('KNOBSOCK preview: http://127.0.0.1:4173', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 4173), Handler).serve_forever()
