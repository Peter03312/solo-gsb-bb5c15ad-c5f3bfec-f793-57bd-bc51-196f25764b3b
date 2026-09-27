'use strict';

const path = require('node:path');
const { openDatabase } = require('./db');
const { buildApp } = require('./app');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'draws.db');

const db = openDatabase(dbPath);
const app = buildApp(db);

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  app.close()
    .then(() => {
      db.close();
      process.exit(0);
    })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
