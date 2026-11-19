import { defineConfig, loadEnv } from 'vite';
import museHandler from './api/muse.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  Object.assign(process.env, env);

  return {
    plugins: [
      {
        name: 'local-api-muse',
        configureServer(server) {
          server.middlewares.use('/api/muse', (req, res) => {
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
              museHandler(req, wrappedRes);
            });
          });
        }
      }
    ]
  };
});
