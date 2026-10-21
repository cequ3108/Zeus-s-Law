const fs = require('fs');
const path = require('path');

function backupDirectory(env = process.env) {
  if (env.BACKUP_DIR) return env.BACKUP_DIR;
  if (env.DATA_DIR) return path.join(env.DATA_DIR, 'backups');
  return path.join(__dirname, '..', 'backups');
}

async function backupDatabase(db, dir = backupDirectory()) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `zeus-${stamp}.db`);
  await db.backup(dest);
  return dest;
}

module.exports = { backupDirectory, backupDatabase };
