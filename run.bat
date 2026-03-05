@echo off
echo Starting NovaNotes...

:: Start the Git watcher in a background window
start /B node git-watcher.js

:: Open the app in the default browser
start index.html

echo NovaNotes is running!