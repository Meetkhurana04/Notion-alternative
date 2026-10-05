/* ============================================
   NovaNotes - local server (Node stdlib only)
   Serves the app on http://localhost:4000 and makes the
   data/ folder the single source of truth:
     GET  /api/data    -> all pages + folders read fresh from data/
     POST /api/save     -> write one page into data/
     POST /api/delete   -> remove a page's file(s) from data/
     POST /api/folders  -> write data/_folders.json
     POST /api/push     -> git add data/ && commit && push (normal, not -f)
   Idle cost is ~0% CPU: it only works when the browser calls it.
   ============================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PORT = 4000;

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

// Page id -> safe filename. Mirrors the browser's naming so files stay stable.
function safeName(id, title) {
    const sid = String(id).replace(/[^a-zA-Z0-9_]/g, '');
    const st = String(title || 'untitled').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 50);
    return `${sid}_${st}.json`;
}

function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => { data += c; if (data.length > 50 * 1024 * 1024) req.destroy(); });
        req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

async function readAllData() {
    const pages = [];
    let folders = [];
    let names = [];
    try { names = await fsp.readdir(DATA); } catch (e) { return { pages, folders }; }
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        let txt;
        try { txt = await fsp.readFile(path.join(DATA, name), 'utf8'); } catch (e) { continue; }
        if (name === '_folders.json') {
            try { const f = JSON.parse(txt); if (Array.isArray(f)) folders = f; } catch (e) {}
            continue;
        }
        if (!name.startsWith('nn_')) continue;
        try {
            const p = JSON.parse(txt);
            if (p && p.id && !p.deleted) pages.push(p);
        } catch (e) { /* skip corrupt file, don't fail the whole load */ }
    }
    return { pages, folders };
}

// Remove every data/<id>_*.json so renames don't leave duplicates.
async function removePageFiles(id) {
    const sid = String(id).replace(/[^a-zA-Z0-9_]/g, '');
    if (!sid) return;
    let names = [];
    try { names = await fsp.readdir(DATA); } catch (e) { return; }
    for (const name of names) {
        if (name.startsWith(sid + '_') && name.endsWith('.json')) {
            try { await fsp.unlink(path.join(DATA, name)); } catch (e) {}
        }
    }
}

function git(args) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code || 1) : 0, out: (stdout || '') + (stderr || '') });
        });
    });
}

async function gitPush() {
    await git(['add', 'data/']);
    const status = await git(['status', '--porcelain']);
    if (!status.out.trim()) return { ok: true, message: 'Nothing to commit — already up to date.' };
    const commit = await git(['commit', '-m', 'Update notes (NovaNotes)']);
    if (commit.code !== 0 && !/nothing to commit/i.test(commit.out)) {
        return { ok: false, message: 'Commit failed:\n' + commit.out };
    }
    const push = await git(['push']);
    if (push.code !== 0) return { ok: false, message: 'Push failed:\n' + push.out };
    return { ok: true, message: 'Pushed to git.' };
}

async function serveStatic(req, res) {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); } // path-traversal guard
    try {
        const stat = await fsp.stat(filePath);
        if (stat.isDirectory()) { res.writeHead(403); return res.end('Forbidden'); }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    } catch (e) {
        res.writeHead(404); res.end('Not found');
    }
}

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/data' && req.method === 'GET') {
            return sendJson(res, 200, await readAllData());
        }
        if (url === '/api/save' && req.method === 'POST') {
            const page = await readBody(req);
            if (!page || !page.id) return sendJson(res, 400, { ok: false, message: 'missing id' });
            await removePageFiles(page.id);
            if (!page.deleted) {
                await fsp.writeFile(path.join(DATA, safeName(page.id, page.title)), JSON.stringify(page, null, 2));
            }
            return sendJson(res, 200, { ok: true });
        }
        if (url === '/api/delete' && req.method === 'POST') {
            const { id } = await readBody(req);
            if (!id) return sendJson(res, 400, { ok: false, message: 'missing id' });
            await removePageFiles(id);
            return sendJson(res, 200, { ok: true });
        }
        if (url === '/api/folders' && req.method === 'POST') {
            const folders = await readBody(req);
            if (!Array.isArray(folders)) return sendJson(res, 400, { ok: false, message: 'expected array' });
            await fsp.writeFile(path.join(DATA, '_folders.json'), JSON.stringify(folders, null, 2));
            return sendJson(res, 200, { ok: true });
        }
        if (url === '/api/push' && req.method === 'POST') {
            return sendJson(res, 200, await gitPush());
        }
        return serveStatic(req, res);
    } catch (e) {
        sendJson(res, 500, { ok: false, message: String(e && e.message || e) });
    }
});

// 127.0.0.1 only — never exposed to the network.
if (require.main === module) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`NovaNotes running at http://localhost:${PORT}  (Ctrl+C to stop)`);
    });
}

module.exports = { safeName, readAllData, removePageFiles };
