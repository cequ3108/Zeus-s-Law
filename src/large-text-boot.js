const crypto = require('crypto');

const BOOT_SCRIPT = 'try{if(localStorage.getItem("zeus-large-text")==="1")document.documentElement.classList.add("large-text")}catch(e){}';

function contentSecurityPolicy() {
  const hash = crypto.createHash('sha256').update(BOOT_SCRIPT).digest('base64');
  return `default-src 'self'; script-src 'self' 'sha256-${hash}'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'`;
}

module.exports = { BOOT_SCRIPT, contentSecurityPolicy };
