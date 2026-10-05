/* Self-check for server.js — run: node test_server.js
   Guards the one security-sensitive bit: filename sanitization must never
   let a page id/title escape the data/ folder via path traversal. */
'use strict';
const assert = require('assert');
const { safeName } = require('./server.js');

// Normal case keeps the id and a slugged title.
assert.strictEqual(safeName('nn_abc123_def', 'My Note'), 'nn_abc123_def_my_note.json');

// Path traversal in id must be stripped to nothing dangerous.
const evil = safeName('../../etc/passwd', 'x');
assert.ok(!evil.includes('/') && !evil.includes('..'), 'id traversal not neutralized: ' + evil);

// Traversal / slashes in title must not survive either.
const evil2 = safeName('nn_x', '../../../secret');
assert.ok(!evil2.includes('/') && !evil2.includes('..'), 'title traversal not neutralized: ' + evil2);

// Empty title still yields a valid filename.
assert.strictEqual(safeName('nn_x', ''), 'nn_x_untitled.json');

console.log('ok — server safeName sanitization holds');
