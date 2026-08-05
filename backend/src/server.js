import { app } from './app.js';
import { config } from './config.js';
import { getDb } from './db/connection.js';

// Initialize JSON database
getDb();

const port = config.port;

app.listen(port, config.host, () => {
  console.log(`Local AI assistant server running on http://${config.host}:${port}`);
  console.log(`Default model: ${config.defaultModel} | Embed model: ${config.embeddingModel}`);
});
