#!/bin/bash
# Double-click this file (or run ./run.command) to start NovaNotes on macOS.
cd "$(dirname "$0")"
echo "Starting NovaNotes server..."
# Open the browser once the server is up.
( sleep 1; open "http://localhost:4000" ) &
node server.js
