import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
};

export function serve(snapshotDir: string, port: number, open: boolean): void {
  const snapshot = path.resolve(snapshotDir);
  if (!fs.existsSync(path.join(snapshot, 'meta.json'))) {
    throw new Error(`No snapshot in ${snapshot}. Run "sf-access-docs extract --target-org <alias>" first.`);
  }
  // dist/cli.js sits next to ui-dist/ in the package; in dev (src/cli) it is two levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiDir = [path.join(here, '..', 'ui-dist'), path.join(here, '..', '..', 'ui-dist')].find((d) => fs.existsSync(d));
  if (!uiDir) throw new Error('UI is not built. Run "npm run build" in the sf-access-docs repo.');

  const send = (res: http.ServerResponse, file: string) => {
    res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  };

  http
    .createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      const root = url.startsWith('/snapshot/') ? snapshot : uiDir;
      const rel = url.startsWith('/snapshot/') ? url.slice('/snapshot/'.length) : url;
      const file = path.join(root, rel);
      if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(res, file);
      // A missing snapshot file is a real 404; only app routes fall back to index.html.
      if (url.startsWith('/snapshot/')) {
        res.statusCode = 404;
        return res.end();
      }
      send(res, path.join(uiDir, 'index.html'));
    })
    .listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`;
      process.stderr.write(`Serving ${snapshot}\n  ${url}\n`);
      if (open) exec(process.platform === 'win32' ? `start "" ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`);
    });
}
