

# 🚀 NovaNotes -- A Lightweight, Local-First Notion Alternative

NovaNotes is a **browser-based note‑taking app** that runs entirely on your machine. No cloud, no lag, no subscription. Your notes are stored in your browser's IndexedDB and can be **automatically backed up to a folder on your computer** -- and optionally synced to **GitHub** for version control and remote access.

---

## ✨ Features

- **Local‑first** -- All data stays in your browser; you own it.

- **Rich text editing** -- Bold, italic, lists, checklists, code blocks, tables, images, and more.

- **Markdown support** -- Toggle between WYSIWYG and raw Markdown.

- **Organize with folders** -- Drag & drop pages into folders.

- **Fast search** -- Find notes instantly.

- **Dark / Light theme** -- Toggle with one click.

- **Paste from ChatGPT** -- Formatting preserved, including code blocks.

- **Export to folder** -- Save all notes as JSON files on your computer.

- **Git integration** -- Automatically commit and push changes to GitHub (optional, with a manual override).

---

## 📋 Prerequisites

Make sure you have the following installed:

- **Node.js** (v14 or later) -- [Download](https://nodejs.org)

- **Git** -- [Download](https://git-scm.com)

- A modern **Chromium‑based browser** (Chrome, Edge, Brave) -- the File System Access API is required for folder export.

---

## 🛠️ Installation

1\. **Clone the repository**  

   ```bash

   git clone https://github.com/Meetkhurana04/Notion-alternative.git

   cd Notion-alternative

   ```

2\. **Install dependencies** (for the Git watcher)  

   ```bash

   npm install chokidar

   ```

   This installs the file‑watching library needed for auto‑commits.

3\. **Optional: Set up a GitHub remote** (if you want to push to your own repo)  

   - Create a repository on GitHub (do **not** initialise with a README).

   - Link your local repo:

     ```bash

     git remote add origin https://github.com/yourusername/your-repo.git

     git branch -M main

     git push -u origin main

     ```

---

## 🚀 Running NovaNotes

You have two ways to run the app:

### A) One‑click launch (recommended)

Double‑click the **`run.bat`** file (Windows) -- it will:

- Start the Git watcher in the background.

- Open the app in **Google Chrome**.

If you prefer another browser, edit `run.bat` and change `start chrome` to `start brave` or `start msedge`.

### B) Manual start

1\. **Start a local web server** (required for the folder picker to work)  

   ```bash

   npx live-server

   ```

   or  

   ```bash

   python -m http.server

   ```

2\. Open `http://localhost:8080` (or the port shown) in your browser.

3\. In a separate terminal, start the Git watcher:

   ```bash

   node git-watcher.js

   ```

---

## 📝 How to Use NovaNotes

### Creating your first note

- Click **"New Page"** in the sidebar.

- Start typing -- the editor is ready.

- Use the toolbar to format text, insert images, tables, etc.

### Organising with folders

- Click **"New Folder"**, give it a name.

- Drag & drop pages into folders.

- Double‑click a folder name to rename it.

### Exporting notes to your computer

1\. Click the **folder icon** (`Export to Folder`) in the sidebar.

2\. Select your project's `data/` folder (or any folder you like).

3\. All notes are saved as JSON files inside that folder.

4\. **After this, every change you make will automatically update the corresponding JSON file** -- you only need to select the folder once.

### Changing the export folder

If you want to switch to a different folder, click the **"Change Folder"** button (the one with the sync icon). It will always show the folder picker.

---

## 🔄 Git Synchronization

NovaNotes can automatically commit and push changes to GitHub whenever you modify a note. This is handled by a small Node.js script (`git-watcher.js`) that watches your `data/` folder.

### How it works

- When you **export notes to a folder**, they are written as individual JSON files (e.g., `nn_abc123_my_note.json`).

- The watcher detects any change in that folder and, after a short pause (5 seconds by default), runs:

  ```bash

  git add data/

  git commit -m "Auto-sync notes"

  git push

  ```

### Controlling auto‑sync

- **Auto‑sync is OFF by default**. To enable it, you need to create a flag file inside your `data` folder.  

  The easiest way is to use the **auto‑sync toggle button** (if you added it).  

  If you haven't added the button, you can manually create an empty file named `.auto-sync` inside your `data` folder.

- When the flag file exists, the watcher will commit after every change (debounced).

- To disable auto‑sync, delete the `.auto-sync` file.

### Force commit (manual override)

Even if auto‑sync is off, you can trigger an immediate commit & push by clicking the **"Force Commit"** button (rocket icon) in the sidebar. This creates a temporary `force-commit.flag` file, which the watcher detects and acts upon immediately -- then deletes the flag.

### ⚠️ Current status of auto‑commit

The auto‑commit functionality is **currently disabled by default** (the watcher's debounce is set to an extremely high value so it never triggers automatically). You have two choices:

1\. **Use manual commits only** -- click the rocket button whenever you want to push your changes.

2\. **Enable auto‑commit** -- in `git-watcher.js`, change `debounceDelay` to a sensible value (e.g., `5000` for 5 seconds) and ensure the `.auto-sync` flag exists in your `data` folder.

Future versions will include a proper UI toggle and more refined control.

---

## ❗ Troubleshooting

### The folder picker doesn't appear / `showDirectoryPicker is not a function`

- **Cause**: The page was opened directly with the `file://` protocol, or your browser doesn't support the File System Access API.

- **Fix**: Always serve the app via a local web server (use `npx live-server` or the provided `run.bat`).  

  Use Chrome, Edge, or Brave (latest versions).

### Notes are not being saved to the `data/` folder

- **Cause**: You haven't granted folder permission, or the handle is pointing to an invalid folder.

- **Fix**: Click **"Change Folder"** and select your project's `data/` folder again. After that, auto‑export will work.

### Git push fails / asks for credentials

- **Cause**: Git remote is not set up, or credentials are missing.

- **Fix**:  

  - Run `git push` manually once -- it will prompt for your username and password/token.  

  - Use a **personal access token** instead of a password.  

  - If you have SSH keys set up, change the remote to the SSH URL.

### The "Force Commit" button does nothing

- **Cause**: The folder handle is missing (you haven't exported to a folder yet).

- **Fix**: First click **"Export to Folder"** and select your `data` folder. Then the force commit button will work.

### Changes are committed but not pushed

- The watcher's `git push` command may fail if you are offline or the remote is unreachable. Check the terminal output for errors.

---

## 🧪 Future Improvements

- A proper UI toggle for auto‑sync (instead of a manual flag file).

- Support for multiple export formats (Markdown, plain text).

- Image handling (store images as files, not just Base64 inside JSON).

- Collaborative editing (maybe?).

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

**Happy note‑taking!**  

If you encounter any issues, feel free to open an issue on GitHub.