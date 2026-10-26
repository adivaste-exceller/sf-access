import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// Dev only: serve the extracted snapshot at /snapshot/* (SNAPSHOT_DIR, default ./snapshot).
function snapshotServer(): Plugin {
  return {
    name: 'snapshot-server',
    configureServer(server) {
      const dir = path.resolve(process.env.SNAPSHOT_DIR ?? 'snapshot');
      server.middlewares.use('/snapshot', (req, res, next) => {
        const file = path.join(dir, decodeURIComponent((req.url ?? '/').split('?')[0]!));
        if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader('content-type', 'application/json');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: 'ui',
  plugins: [react(), snapshotServer()],
  build: { outDir: '../ui-dist', emptyOutDir: true },
});
