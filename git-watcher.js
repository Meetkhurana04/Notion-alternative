const chokidar = require('chokidar');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const dataFolder = path.join(__dirname, 'data');
const gitRepo = __dirname;
const autoSyncFlag = path.join(dataFolder, '.auto-sync');
const forceCommitFlag = path.join(dataFolder, 'force-commit.flag');

// Function to run git add, commit, push
function runGitCommands() {
    console.log('Running git commands...');
    exec('git add data/', { cwd: gitRepo }, (err, stdout, stderr) => {
        if (err) return console.error('git add error:', err);
        exec('git commit -m "Auto-sync notes"', { cwd: gitRepo }, (err, stdout, stderr) => {
            if (err && !err.message.includes('nothing to commit')) {
                console.error('git commit error:', err);
            } else {
                console.log('Committed, pushing...');
                exec('git push -f', { cwd: gitRepo }, (err, stdout, stderr) => {
                    if (err) console.error('git push error:', err);
                    else console.log('Force Push successful');
                });
            }
        });
    });
}

// Watcher for normal changes (with debounce, respects .auto-sync flag)
const normalWatcher = chokidar.watch(dataFolder, {
    persistent: true,
    ignoreInitial: true,
    ignored: [forceCommitFlag] // ignore the force flag to avoid interfering
});

let timeout = null;
const debounceDelay = 5000000; // change to 30000 if you want 30 seconds

normalWatcher.on('all', (event, filePath) => {
    // Skip the force flag (already ignored) and the auto-sync flag
    if (filePath === autoSyncFlag || filePath === forceCommitFlag) return;

    // console.log(`Change detected: ${event} ${filePath}`);
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
        // Check if auto-sync is enabled
        if (!fs.existsSync(autoSyncFlag)) {
            console.log('Auto-sync is disabled (flag missing). Skipping commit.');
            return;
        }
        runGitCommands();
    }, debounceDelay);
});

// Separate watcher for the force-commit flag – runs immediately
const forceWatcher = chokidar.watch(dataFolder, {
    persistent: true,
    ignoreInitial: true,
    ignored: [forceCommitFlag, /\.crswap$/]   // ignore .crswap files too
});

forceWatcher.on('add', () => {
    console.log('Force commit requested!');
    // Run git commands immediately
    runGitCommands();
    // Delete the flag file so it doesn't trigger again
    fs.unlink(forceCommitFlag, (err) => {
        if (err) console.error('Failed to delete force-commit flag:', err);
        else console.log('Force-commit flag removed.');
    });
});

console.log('Watching data folder for changes...');