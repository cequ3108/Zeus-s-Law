const { openDatabase, resolveDbPath } = require('../src/db');
const { backupDatabase } = require('../src/backup');

const db = openDatabase(resolveDbPath());

backupDatabase(db)
  .then((dest) => {
    console.log(`已備份到 ${dest}`);
  })
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
