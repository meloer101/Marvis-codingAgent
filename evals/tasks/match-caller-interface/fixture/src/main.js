import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 8080);
createServer().listen(port, () => console.log(`edge-gateway listening on :${port}`));
