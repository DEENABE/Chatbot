import { app } from './app.js';
import { config } from './config.js';
import { getDb } from './db/connection.js';

// Initialize JSON database
getDb();

const port = config.port;

app.listen(port, () => {
  console.log(`Local AI assistant server running on http://localhost:${port}`);
  console.log(`Default model: ${config.defaultModel} | Embed model: ${config.embeddingModel}`);
});
