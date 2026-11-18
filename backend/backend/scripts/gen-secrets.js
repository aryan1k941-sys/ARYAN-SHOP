'use strict';
const c = require('node:crypto');
console.log('# Paste into backend/.env  (keep secret, never commit)');
console.log('JWT_SECRET=' + c.randomBytes(48).toString('base64url'));
console.log('SECRETS_KEY=' + c.randomBytes(32).toString('base64'));
console.log('\n# IMPORTANT: if you change SECRETS_KEY later, stored supplier/gateway/Telegram credentials can no longer be decrypted - re-enter them.');
