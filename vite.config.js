import { defineConfig, loadEnv } from 'vite';
import museHandler from './api/muse.js';
import r2UploadHandler from './api/r2-upload.js';

function mountApi(server, route, handler) {
  server.middlewares.use(route, (req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      req.body = raw;
      const wrappedRes = {
        status(code) {
          res.statusCode = code;
          return this;
        },
        json(obj) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(obj));
        }
      };
      handler(req, wrappedRes);
    });
  });
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  Object.assign(process.env, env);

  return {
    plugins: [
      {
        name: 'local-api-middlewares',
        configureServer(server) {
          mountApi(server, '/api/muse', museHandler);
          mountApi(server, '/api/r2-upload', r2UploadHandler);
        }
      }
    ]
  };
});
