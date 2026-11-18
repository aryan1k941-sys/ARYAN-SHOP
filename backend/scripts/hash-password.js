'use strict';
// Usage: npm run hash-password -- "YourStrongPassword"   -> value for ADMIN_LOCAL_PASSWORD_HASH (only needed with ADMIN_AUTH=local)
const { hashPassword } = require('../src/lib');
const pw = process.argv[2];
if (!pw || pw.length < 10) { console.error('Provide a password of at least 10 characters:  npm run hash-password -- "your password"'); process.exit(1); }
hashPassword(pw).then((h) => console.log("ADMIN_LOCAL_PASSWORD_HASH='" + h + "'"));
