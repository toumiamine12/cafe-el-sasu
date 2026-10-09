import { openDb } from './server/db.js';
import { createApp } from './server/app.js';

const port = process.env.PORT || 3000;
createApp(openDb(process.env.DB_FILE)).listen(port, () => console.log(`Café el Sasu läuft auf http://localhost:${port}`));
