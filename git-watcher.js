const chokidar = require('chokidar');
const { exec } = require('child_process');
const path = require('path');

const dataFolder = path.join(__dirname, 'data');
const gitRepo = __dirname; // assumes .git is in root

const watcher = chokidar.watch(dataFolder, {
    persistent: true,
    ignoreInitial: true
});

let timeout = null;
const debounceDelay = 5000; // 5 seconds after last change

watcher.on('all', (event, filePath) => {
    console.log(`Change detected: ${event} ${filePath}`);
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
        console.log('Committing changes...');
        exec('git add data/', { cwd: gitRepo }, (err, stdout, stderr) => {
            if (err) return console.error('git add error:', err);
            exec('git commit -m "Auto-sync notes"', { cwd: gitRepo }, (err, stdout, stderr) => {
                if (err && !err.message.includes('nothing to commit')) {
                    console.error('git commit error:', err);
                } else {
                    console.log('Committed, pushing...');
                    exec('git push', { cwd: gitRepo }, (err, stdout, stderr) => {
                        if (err) console.error('git push error:', err);
                        else console.log('Push successful');
                    });
                }
            });
        });
    }, debounceDelay);
});

console.log('Watching data folder for changes...');