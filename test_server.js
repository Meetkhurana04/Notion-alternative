/* Self-check for server.js — run: node test_server.js
   Uses a throwaway temp repo; never touches your real data/.
   Guards the data-safety rules: never delete a file, newest version wins,
   stale tabs can't overwrite, push never commits a deletion. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-test-'));
const data = path.join(root, 'data');
fs.mkdirSync(data);
process.env.NOVA_ROOT = root; // must be set before requiring server.js
const { safeName, readAllData, savePage, gitPush } = require('./server.js');

const write = (name, obj) => fs.writeFileSync(path.join(data, name), JSON.stringify(obj));
const read = name => JSON.parse(fs.readFileSync(path.join(data, name), 'utf8'));
const files = () => fs.readdirSync(data).sort();
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });

(async () => {
    // filename sanitization: no path traversal
    assert.strictEqual(safeName('nn_abc', 'My Note'), 'nn_abc_my_note.json');
    for (const n of [safeName('../../etc/passwd', 'x'), safeName('nn_x', '../../secret')])
        assert.ok(!n.includes('/') && !n.includes('..'), 'traversal: ' + n);

    // Two files for one id (the old title-typing race): newest wins, fuller one on a tie.
    write('nn_a_untitled.json', { id: 'nn_a', title: '', content: '', updatedAt: 100 });
    write('nn_a_rest_api.json', { id: 'nn_a', title: 'REST API', content: 'big', updatedAt: 200 });
    write('_folders.json', []);
    let { pages } = await readAllData();
    assert.strictEqual(pages.length, 1);
    assert.strictEqual(pages[0].title, 'REST API');

    // Stale tab (based on v100) can't overwrite v200.
    const stale = await savePage({ id: 'nn_a', title: 'old', content: '', updatedAt: 300 }, 100);
    assert.strictEqual(stale.code, 409);
    assert.strictEqual(read('nn_a_rest_api.json').content, 'big');

    // Normal save goes into the winner file even with a new title: no file deleted, none added.
    const before = files();
    const ok = await savePage({ id: 'nn_a', title: 'Renamed', content: 'bigger', updatedAt: 400 }, 200);
    assert.strictEqual(ok.code, 200);
    assert.deepStrictEqual(files(), before);
    assert.strictEqual(read('nn_a_rest_api.json').content, 'bigger');
    assert.ok(read('nn_a_untitled.json'), 'sibling file must be left untouched');

    // Delete = tombstone: hidden from the app, file still on disk.
    await savePage({ id: 'nn_a', title: 'Renamed', content: 'bigger', deleted: true, updatedAt: 500 }, 400);
    ({ pages } = await readAllData());
    assert.strictEqual(pages.length, 0);
    assert.deepStrictEqual(files(), before);

    // Push never commits a deletion, even if a file vanished from disk.
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    write('nn_b_keep.json', { id: 'nn_b', title: 'keep', updatedAt: 1 });
    git('add', '.'); git('commit', '-qm', 'init');
    fs.unlinkSync(path.join(data, 'nn_b_keep.json'));                       // accidental loss
    write('nn_c_new.json', { id: 'nn_c', title: 'new', updatedAt: 1 });     // real new note
    const r = await gitPush(); // no remote -> push fails, but the commit is what we check
    assert.ok(/push failed/i.test(r.message), r.message);
    const committed = git('show', '--name-status', '--format=', 'HEAD');
    assert.ok(/A\s+data\/nn_c_new\.json/.test(committed), committed);
    assert.ok(!/^D/m.test(committed), 'push committed a deletion:\n' + committed);
    assert.ok(git('ls-files', 'data/nn_b_keep.json').trim(), 'deleted file must stay tracked');

    fs.rmSync(root, { recursive: true, force: true }); // temp dir only
    console.log('ok — no deletes, newest wins, stale saves rejected, push never commits removals');
})().catch(e => { console.error(e); process.exit(1); });
