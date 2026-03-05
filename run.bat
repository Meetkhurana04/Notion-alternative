@echo off
echo Starting NovaNotes...

:: Start the Git watcher in a background window
start /B node git-watcher.js

:: Open the app in Chrome
start chrome "%~dp0index.html"

echo NovaNotes is running!