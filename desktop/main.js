/* NovaNotes desktop shell (Electron).
   Runs the exact same server.js inside the app — storage logic is unchanged.
   Only adds: GitHub login (device flow), pick/create a repo, clone it locally,
   then point server.js at that clone. */
'use strict';
const { app, BrowserWindow, ipcMain, shell, safeStorage, Menu, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// GitHub → Settings → Developer settings → OAuth Apps → New. Tick "Enable Device Flow".
// Paste the Client ID here. No client secret is needed (and none should ship in an app).
const CLIENT_ID = process.env.NOVA_GITHUB_CLIENT_ID || 'Ov23liClQFupoA0qRZ3f';
const PORT = 4100; // fixed so the page origin (and its IndexedDB/theme) survives restarts; 4000 stays free for run.command

const CONFIG = path.join(app.getPath('userData'), 'config.json'); // { repo, dir, name, email }
const TOKEN = path.join(app.getPath('userData'), 'token.bin');    // encrypted by the OS keychain

let win;

const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; } };
const readToken = () => { try { return safeStorage.decryptString(fs.readFileSync(TOKEN)); } catch { return null; } };

function git(args, cwd) {
    return new Promise((resolve, reject) => execFile('git', args, { cwd }, (err, out, errOut) =>
        err ? reject(new Error((errOut || err.message).trim())) : resolve(out.trim())));
}

async function gh(token, method, url, body) {
    const r = await fetch('https://api.github.com' + url, {
        method, body: body && JSON.stringify(body),
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'NovaNotes' },
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || 'GitHub error ' + r.status);
    return j;
}

async function ghForm(url, body) {
    const r = await fetch(url, { method: 'POST', body: JSON.stringify(body),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
    return r.json();
}

// Every git process (ours and server.js's push) inherits this env: auth header +
// commit identity. The token never gets written into .git/config.
function useGitEnv(token, cfg) {
    Object.assign(process.env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64'),
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: cfg.name, GIT_AUTHOR_EMAIL: cfg.email,
        GIT_COMMITTER_NAME: cfg.name, GIT_COMMITTER_EMAIL: cfg.email,
    });
}

function startNotes(cfg, token) {
    useGitEnv(token, cfg);
    process.env.NOVA_ROOT = cfg.dir; // read by server.js at require time
    const { server } = require('../server.js');
    server.once('error', e => { dialog.showErrorBox('NovaNotes', `Port ${PORT} is busy: ${e.message}`); app.quit(); });
    server.listen(PORT, '127.0.0.1', () => win.loadURL(`http://127.0.0.1:${PORT}`));
}

// ---------- setup screen IPC ----------
let session = null; // { token, login, name, email } during setup

ipcMain.handle('login', async (e) => {
    const d = await ghForm('https://github.com/login/device/code', { client_id: CLIENT_ID, scope: 'repo' });
    if (!d.device_code) throw new Error(d.error_description || 'GitHub login failed — is CLIENT_ID set and Device Flow enabled?');
    e.sender.send('code', { code: d.user_code, url: d.verification_uri });
    shell.openExternal(d.verification_uri);
    let wait = (d.interval || 5) * 1000;
    for (const end = Date.now() + d.expires_in * 1000; Date.now() < end;) {
        await new Promise(r => setTimeout(r, wait));
        const t = await ghForm('https://github.com/login/oauth/access_token',
            { client_id: CLIENT_ID, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        if (t.access_token) {
            const u = await gh(t.access_token, 'GET', '/user');
            session = { token: t.access_token, login: u.login, name: u.name || u.login,
                email: `${u.id}+${u.login}@users.noreply.github.com` };
            fs.writeFileSync(TOKEN, safeStorage.encryptString(t.access_token));
            return u.login;
        }
        if (t.error === 'slow_down') wait += 5000;
        else if (t.error !== 'authorization_pending') throw new Error(t.error_description || t.error);
    }
    throw new Error('Login code expired. Try again.');
});

ipcMain.handle('repos', async () =>
    (await gh(session.token, 'GET', '/user/repos?per_page=100&sort=updated&affiliation=owner'))
        .map(r => ({ name: r.full_name, private: r.private })));

ipcMain.handle('useRepo', async (_, name, create) => {
    let full = name;
    if (create) full = (await gh(session.token, 'POST', '/user/repos',
        { name, private: true, auto_init: true, description: 'My NovaNotes notes' })).full_name;
    useGitEnv(session.token, session);
    const dir = path.join(app.getPath('documents'), 'NovaNotes', full.split('/')[1]);
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await git(['clone', `https://github.com/${full}.git`, dir]);
    }
    return finish(full, dir);
});

// Repo already cloned on this computer (e.g. the old run.command folder) → use it in place.
ipcMain.handle('useFolder', async () => {
    const pick = await dialog.showOpenDialog(win, { properties: ['openDirectory'], message: 'Pick the repo folder that has data/ inside' });
    if (pick.canceled) return null;
    const dir = pick.filePaths[0];
    const remote = await git(['remote', 'get-url', 'origin'], dir).catch(() => '');
    const m = remote.match(/github\.com[:/](.+?)(\.git)?$/);
    if (!m) throw new Error('That folder is not a git repo with a GitHub "origin" remote.');
    return finish(m[1], dir);
});

function finish(repo, dir) {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const cfg = { repo, dir, name: session.name, email: session.email };
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
    startNotes(cfg, session.token);
    return repo;
}

function signOut() {
    fs.rmSync(CONFIG, { force: true });
    fs.rmSync(TOKEN, { force: true }); // only app settings; notes on disk and GitHub are untouched
    app.relaunch();
    app.exit();
}

app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        process.platform === 'darwin' ? { role: 'appMenu' } : { role: 'fileMenu' },
        { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
        { label: 'Account', submenu: [
            { label: 'Show notes folder', click: () => { const c = readConfig(); if (c) shell.openPath(c.dir); } },
            { label: 'Switch account / repo…', click: signOut },
        ] },
    ]));

    win = new BrowserWindow({ width: 1300, height: 850, title: 'NovaNotes',
        webPreferences: { preload: path.join(__dirname, 'preload.js') } });
    // Note links open in the real browser; only our own pages open in-app.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith('file:')) return { action: 'allow' };
        shell.openExternal(url);
        return { action: 'deny' };
    });

    if (!(await git(['--version']).catch(() => null))) {
        dialog.showErrorBox('NovaNotes needs git', process.platform === 'darwin'
            ? 'Run "xcode-select --install" in Terminal, then reopen NovaNotes.'
            : 'Install Git from https://git-scm.com, then reopen NovaNotes.');
        return app.quit();
    }

    const cfg = readConfig(), token = readToken();
    if (cfg && token && fs.existsSync(cfg.dir)) startNotes(cfg, token);
    else win.loadFile(path.join(__dirname, 'setup.html'));
});

app.on('window-all-closed', () => app.quit());
