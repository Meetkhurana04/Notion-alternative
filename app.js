/* ============================================
   NovaNotes - Complete Application Logic
   Local-first, lag-free Notion alternative
   ============================================ */

(function() {
    'use strict';

    // ============ DATABASE (IndexedDB + LocalStorage hybrid) ============
    const DB_NAME = 'NovaNotes';
    const DB_VERSION = 2;
    const STORE_PAGES = 'pages';
    const STORE_FOLDERS = 'folders';
    const STORE_IMAGES = 'images';

    let db = null;
    let currentPageId = null;
    let saveTimer = null;
    let isMarkdownMode = false;
    let contextMenuTarget = null;
    let allPages = [];
    let allFolders = [];

    // ============ FILE SYSTEM HANDLE FOR EXPORT ============
    let dataFolderHandle = null;

    async function getDataFolderHandle() {
        if (dataFolderHandle) return dataFolderHandle;
        try {
            dataFolderHandle = await window.showDirectoryPicker({
                id: 'nova-data-folder',
                mode: 'readwrite'
            });
            return dataFolderHandle;
        } catch {
            return null;
        }
    }

    async function exportPageToFolder(page) {
        const dir = await getDataFolderHandle();
        if (!dir) return;
        const fileName = `${page.id}.json`;
        try {
            const fileHandle = await dir.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(page, null, 2));
            await writable.close();
        } catch (err) {
            console.error('Export to folder failed:', err);
        }
    }

    async function exportAllToFolder() {
        const dir = await getDataFolderHandle();
        if (!dir) return;
        for (const page of allPages) {
            await exportPageToFolder(page);
        }
        // Also save folders list
        try {
            const foldersFile = await dir.getFileHandle('_folders.json', { create: true });
            const fw = await foldersFile.createWritable();
            await fw.write(JSON.stringify(allFolders, null, 2));
            await fw.close();
        } catch (err) {
            console.error('Export folders failed:', err);
        }
    }

    // ============ INIT ============
    async function init() {
        await openDatabase();
        await loadData();
        renderPageTree();
        setupEventListeners();
        loadTheme();
        populateEmojiPicker();
        applySidebarState();
        initGitSync(); // Ask for folder permission once

        // Load last opened page
        const lastPage = localStorage.getItem('nova_lastPage');
        if (lastPage && allPages.find(p => p.id === lastPage)) {
            openPage(lastPage);
        }
    }

    // ============ GIT SYNC INIT ============
    async function initGitSync() {
        // Just request the folder handle silently – user can click "Export to Folder" later
        // or we can auto-request on first save. We'll do it on demand.
    }

    // ============ INDEXEDDB ============
    function openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_PAGES)) {
                    const pageStore = db.createObjectStore(STORE_PAGES, { keyPath: 'id' });
                    pageStore.createIndex('folderId', 'folderId', { unique: false });
                    pageStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
                    db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(STORE_IMAGES)) {
                    db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
                }
            };

            request.onsuccess = (e) => {
                db = e.target.result;
                resolve();
            };

            request.onerror = (e) => {
                console.error('DB Error:', e);
                reject(e);
            };
        });
    }

    function dbTransaction(storeName, mode = 'readonly') {
        const tx = db.transaction(storeName, mode);
        return tx.objectStore(storeName);
    }

    function dbGetAll(storeName) {
        return new Promise((resolve, reject) => {
            const store = dbTransaction(storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function dbGet(storeName, key) {
        return new Promise((resolve, reject) => {
            const store = dbTransaction(storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function dbPut(storeName, data) {
        return new Promise((resolve, reject) => {
            const store = dbTransaction(storeName, 'readwrite');
            const request = store.put(data);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function dbDelete(storeName, key) {
        return new Promise((resolve, reject) => {
            const store = dbTransaction(storeName, 'readwrite');
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // ============ DATA OPERATIONS ============
    async function loadData() {
        allPages = await dbGetAll(STORE_PAGES);
        allFolders = await dbGetAll(STORE_FOLDERS);
        // Sort by updated
        allPages.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        allFolders.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }

    function generateId() {
        return 'nn_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
    }

    async function createPage(folderId = null, title = '') {
        const page = {
            id: generateId(),
            title: title || 'Untitled',
            content: '',
            icon: '📄',
            folderId: folderId,
            coverImage: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await dbPut(STORE_PAGES, page);
        allPages.unshift(page);
        renderPageTree();
        openPage(page.id);
        return page;
    }

    async function createFolder(name = '') {
        const folder = {
            id: generateId(),
            name: name || 'New Folder',
            parentId: null,
            createdAt: Date.now(),
            collapsed: false
        };
        await dbPut(STORE_FOLDERS, folder);
        allFolders.push(folder);
        renderPageTree();
        return folder;
    }

    async function savePage(pageId, updates) {
        const page = allPages.find(p => p.id === pageId);
        if (!page) return;
        Object.assign(page, updates, { updatedAt: Date.now() });
        try {
            await dbPut(STORE_PAGES, page);
            updateSaveStatus('Saved');
            // Auto-export to folder if handle exists
            if (dataFolderHandle) {
                await exportPageToFolder(page);
            }
        } catch (err) {
            console.error('Save failed:', err);
            updateSaveStatus('Save error!');
        }
    }

    async function deletePage(pageId) {
        await dbDelete(STORE_PAGES, pageId);
        allPages = allPages.filter(p => p.id !== pageId);
        renderPageTree();
        if (currentPageId === pageId) {
            currentPageId = null;
            showWelcome();
        }
    }

    async function deleteFolder(folderId) {
        // Delete all pages in folder
        const pagesInFolder = allPages.filter(p => p.folderId === folderId);
        for (const p of pagesInFolder) {
            await dbDelete(STORE_PAGES, p.id);
        }
        allPages = allPages.filter(p => p.folderId !== folderId);
        await dbDelete(STORE_FOLDERS, folderId);
        allFolders = allFolders.filter(f => f.id !== folderId);
        renderPageTree();
        if (currentPageId && pagesInFolder.find(p => p.id === currentPageId)) {
            currentPageId = null;
            showWelcome();
        }
    }

    async function duplicatePage(pageId) {
        const original = allPages.find(p => p.id === pageId);
        if (!original) return;
        const copy = {
            ...original,
            id: generateId(),
            title: original.title + ' (Copy)',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await dbPut(STORE_PAGES, copy);
        allPages.unshift(copy);
        renderPageTree();
        openPage(copy.id);
    }

    // ============ IMAGE HANDLING ============
    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async function storeImage(base64Data) {
        const id = generateId();
        await dbPut(STORE_IMAGES, { id, data: base64Data, createdAt: Date.now() });
        return id;
    }

    async function insertImageFromFile(file) {
        const base64 = await fileToBase64(file);
        const editor = document.getElementById('editorBody');
        const img = document.createElement('img');
        img.src = base64;
        img.style.maxWidth = '100%';
        img.setAttribute('data-local', 'true');

        const selection = window.getSelection();
        if (selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
            const range = selection.getRangeAt(0);
            range.deleteContents();
            range.insertNode(img);
            range.collapse(false);
        } else {
            editor.appendChild(img);
        }

        triggerSave();
    }

    // ============ UI RENDERING ============
    function renderPageTree() {
        const tree = document.getElementById('pageTree');
        const searchTerm = document.getElementById('searchInput').value.toLowerCase();
        tree.innerHTML = '';

        let filteredPages = allPages;
        let filteredFolders = allFolders;

        if (searchTerm) {
            filteredPages = allPages.filter(p =>
                p.title.toLowerCase().includes(searchTerm) ||
                (p.content && p.content.toLowerCase().includes(searchTerm))
            );
            filteredFolders = allFolders.filter(f =>
                f.name.toLowerCase().includes(searchTerm) ||
                filteredPages.some(p => p.folderId === f.id)
            );
        }

        filteredFolders.forEach(folder => {
            const folderEl = createFolderElement(folder);
            const children = filteredPages.filter(p => p.folderId === folder.id);
            const childContainer = folderEl.querySelector('.tree-folder-children');

            children.forEach(page => {
                childContainer.appendChild(createPageElement(page));
            });

            tree.appendChild(folderEl);
        });

        const rootPages = filteredPages.filter(p => !p.folderId);
        rootPages.forEach(page => {
            tree.appendChild(createPageElement(page));
        });
    }

    function createFolderElement(folder) {
        const div = document.createElement('div');
        div.className = 'tree-folder';
        div.dataset.folderId = folder.id;

        const isCollapsed = folder.collapsed;

        div.innerHTML = `
            <div class="tree-item tree-folder-item" data-folder-id="${folder.id}">
                <span class="tree-folder-toggle ${isCollapsed ? 'collapsed' : ''}">
                    <i class="fas fa-chevron-down"></i>
                </span>
                <span class="tree-icon">📁</span>
                <span class="tree-label">${escapeHtml(folder.name)}</span>
                <span class="tree-actions">
                    <button title="Add page" data-add-to-folder="${folder.id}"><i class="fas fa-plus"></i></button>
                    <button title="Delete folder" data-delete-folder="${folder.id}"><i class="fas fa-trash"></i></button>
                </span>
            </div>
            <div class="tree-folder-children" style="${isCollapsed ? 'display:none;' : ''}"></div>
        `;

        const toggle = div.querySelector('.tree-folder-toggle');
        toggle.addEventListener('click', async (e) => {
            e.stopPropagation();
            const children = div.querySelector('.tree-folder-children');
            const isNowCollapsed = children.style.display !== 'none';
            children.style.display = isNowCollapsed ? 'none' : 'block';
            toggle.classList.toggle('collapsed', isNowCollapsed);
            folder.collapsed = isNowCollapsed;
            await dbPut(STORE_FOLDERS, folder);
        });

        const label = div.querySelector('.tree-label');
        label.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'text';
            input.value = folder.name;
            input.style.cssText = 'background:var(--bg-input);border:1px solid var(--accent);color:var(--text-primary);padding:2px 6px;border-radius:4px;font-size:13px;width:100%;outline:none;';
            label.replaceWith(input);
            input.focus();
            input.select();

            const finish = async () => {
                folder.name = input.value.trim() || 'Untitled Folder';
                await dbPut(STORE_FOLDERS, folder);
                const idx = allFolders.findIndex(f => f.id === folder.id);
                if (idx >= 0) allFolders[idx] = folder;
                renderPageTree();
            };

            input.addEventListener('blur', finish);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') finish();
                if (ev.key === 'Escape') renderPageTree();
            });
        });

        div.querySelector(`[data-add-to-folder]`).addEventListener('click', (e) => {
            e.stopPropagation();
            createPage(folder.id);
        });

        div.querySelector(`[data-delete-folder]`).addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`Delete folder "${folder.name}" and all its pages?`)) {
                deleteFolder(folder.id);
            }
        });

        return div;
    }

    function createPageElement(page) {
        const div = document.createElement('div');
        div.className = `tree-item ${page.id === currentPageId ? 'active' : ''}`;
        div.dataset.pageId = page.id;
        div.draggable = true;

        div.innerHTML = `
            <span class="tree-icon">${page.icon || '📄'}</span>
            <span class="tree-label">${escapeHtml(page.title || 'Untitled')}</span>
            <span class="tree-actions">
                <button title="More" data-context-page="${page.id}"><i class="fas fa-ellipsis-h"></i></button>
            </span>
        `;

        div.addEventListener('click', () => openPage(page.id));

        div.querySelector('[data-context-page]').addEventListener('click', (e) => {
            e.stopPropagation();
            showContextMenu(e, page.id);
        });

        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(e, page.id);
        });

        div.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', page.id);
            div.classList.add('dragging');
        });

        div.addEventListener('dragend', () => {
            div.classList.remove('dragging');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });

        return div;
    }

    // ============ PAGE OPERATIONS ============
    async function openPage(pageId) {
        if (currentPageId) {
            await saveCurrentPage();
        }

        const page = allPages.find(p => p.id === pageId);
        if (!page) return;

        currentPageId = pageId;
        localStorage.setItem('nova_lastPage', pageId);

        document.getElementById('welcomeScreen').style.display = 'none';
        document.getElementById('editorScreen').style.display = 'flex';

        document.getElementById('pageTitleInput').value = page.title || '';
        document.getElementById('pageIconPicker').textContent = page.icon || '📄';

        if (page.coverImage) {
            document.getElementById('coverImage').src = page.coverImage;
            document.getElementById('coverImageContainer').style.display = 'block';
        } else {
            document.getElementById('coverImageContainer').style.display = 'none';
        }

        const editor = document.getElementById('editorBody');
        editor.innerHTML = page.content || '';

        processCodeBlocks(editor);

        const meta = document.getElementById('pageMeta');
        const created = new Date(page.createdAt).toLocaleDateString('en-IN', {
            day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        meta.textContent = `Created: ${created}`;

        updateBreadcrumb(page);
        updateWordCount();

        document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));
        const activeItem = document.querySelector(`[data-page-id="${pageId}"]`);
        if (activeItem) activeItem.classList.add('active');

        if (isMarkdownMode) {
            document.getElementById('markdownInput').value = htmlToMarkdown(page.content || '');
            updateMarkdownPreview();
        }

        updateSaveStatus('Saved');
    }

    function showWelcome() {
        document.getElementById('welcomeScreen').style.display = 'flex';
        document.getElementById('editorScreen').style.display = 'none';
        currentPageId = null;
        localStorage.removeItem('nova_lastPage');
    }

    async function saveCurrentPage() {
        if (!currentPageId) return;

        const title = document.getElementById('pageTitleInput').value;
        const content = document.getElementById('editorBody').innerHTML;
        const icon = document.getElementById('pageIconPicker').textContent;
        const coverImg = document.getElementById('coverImage').src;
        const hasCover = document.getElementById('coverImageContainer').style.display !== 'none';

        await savePage(currentPageId, {
            title,
            content,
            icon,
            coverImage: hasCover ? coverImg : null
        });

        const page = allPages.find(p => p.id === currentPageId);
        if (page) {
            const treeLabel = document.querySelector(`[data-page-id="${currentPageId}"] .tree-label`);
            if (treeLabel) treeLabel.textContent = title || 'Untitled';
            const treeIcon = document.querySelector(`[data-page-id="${currentPageId}"] .tree-icon`);
            if (treeIcon) treeIcon.textContent = icon;
        }
    }

    function triggerSave() {
        updateSaveStatus('Saving...');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveCurrentPage();
        }, 500);
    }

    function updateSaveStatus(status) {
        const el = document.getElementById('saveStatus');
        el.textContent = status;
        if (status === 'Saved') {
            const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            document.getElementById('lastSaved').textContent = `at ${now}`;
        }
    }

    function updateWordCount() {
        const editor = document.getElementById('editorBody');
        const text = editor.innerText || '';
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        const chars = text.length;
        document.getElementById('wordCount').textContent = `${words} words`;
        document.getElementById('charCount').textContent = `${chars} chars`;
    }

    function updateBreadcrumb(page) {
        const bc = document.getElementById('breadcrumb');
        let html = '<span onclick="document.getElementById(\'welcomeScreen\').style.display=\'flex\';document.getElementById(\'editorScreen\').style.display=\'none\';">Home</span>';

        if (page.folderId) {
            const folder = allFolders.find(f => f.id === page.folderId);
            if (folder) {
                html += `<span class="sep">/</span><span>${escapeHtml(folder.name)}</span>`;
            }
        }

        html += `<span class="sep">/</span><span>${escapeHtml(page.title || 'Untitled')}</span>`;
        bc.innerHTML = html;
    }

    // ============ TOOLBAR COMMANDS ============
    function executeCommand(command) {
        const editor = document.getElementById('editorBody');
        editor.focus();

        switch (command) {
            case 'bold':
                document.execCommand('bold');
                break;
            case 'italic':
                document.execCommand('italic');
                break;
            case 'underline':
                document.execCommand('underline');
                break;
            case 'strikeThrough':
                document.execCommand('strikeThrough');
                break;

            case 'highlight': {
                const color = document.getElementById('highlightColor').value;
                const selection = window.getSelection();
                if (selection.rangeCount > 0 && !selection.isCollapsed) {
                    const range = selection.getRangeAt(0);
                    const mark = document.createElement('mark');
                    mark.style.backgroundColor = color;
                    mark.style.color = 'inherit';
                    range.surroundContents(mark);
                }
                break;
            }

            case 'textColor': {
                const color = document.getElementById('textColor').value;
                document.execCommand('foreColor', false, color);
                break;
            }

            case 'insertUnorderedList':
                document.execCommand('insertUnorderedList');
                break;
            case 'insertOrderedList':
                document.execCommand('insertOrderedList');
                break;

            case 'toggleChecklist':
                insertChecklist();
                break;

            case 'toggleCode':
                insertCodeBlock();
                break;

            case 'insertQuote':
                insertBlockquote();
                break;

            case 'insertDivider':
                insertDivider();
                break;

            case 'insertTable':
                document.getElementById('tableModal').style.display = 'flex';
                break;

            case 'insertImage':
                document.getElementById('imageInput').click();
                break;

            case 'createLink': {
                const url = prompt('Enter URL:');
                if (url) {
                    document.execCommand('createLink', false, url);
                }
                break;
            }

            case 'addCover':
                document.getElementById('coverInput').click();
                break;

            case 'undo':
                document.execCommand('undo');
                break;
            case 'redo':
                document.execCommand('redo');
                break;

            case 'toggleMarkdown':
                toggleMarkdownMode();
                break;

            case 'exportPage':
                exportCurrentPage();
                break;

            case 'deletePage':
                if (currentPageId && confirm('Delete this page?')) {
                    deletePage(currentPageId);
                }
                break;
        }

        triggerSave();
    }

    // ============ SPECIAL INSERTIONS ============
    function insertChecklist() {
        const editor = document.getElementById('editorBody');
        const div = document.createElement('div');
        div.className = 'checklist-item';
        div.innerHTML = `
            <input type="checkbox" onchange="this.parentElement.classList.toggle('checked', this.checked)">
            <span class="checklist-text" contenteditable="true">Todo item</span>
        `;
        insertAtCursor(div);
    }

    function insertCodeBlock() {
        const editor = document.getElementById('editorBody');
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';
        wrapper.contentEditable = 'false';

        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.contentEditable = 'true';
        code.textContent = '// Your code here';
        pre.appendChild(code);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-code-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.onclick = (e) => {
            e.preventDefault();
            navigator.clipboard.writeText(code.textContent);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => copyBtn.textContent = 'Copy', 1500);
        };

        wrapper.appendChild(copyBtn);
        wrapper.appendChild(pre);
        insertAtCursor(wrapper);

        const p = document.createElement('p');
        p.innerHTML = '<br>';
        wrapper.after(p);

        code.focus();
    }

    function insertBlockquote() {
        const selection = window.getSelection();
        const bq = document.createElement('blockquote');

        if (selection.rangeCount > 0 && !selection.isCollapsed) {
            const range = selection.getRangeAt(0);
            bq.appendChild(range.extractContents());
            range.insertNode(bq);
        } else {
            bq.innerHTML = 'Quote text here...';
            insertAtCursor(bq);
        }
    }

    function insertDivider() {
        const hr = document.createElement('hr');
        hr.className = 'nova-divider';
        insertAtCursor(hr);

        const p = document.createElement('p');
        p.innerHTML = '<br>';
        hr.after(p);
    }

    function insertTable(rows, cols) {
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        for (let j = 0; j < cols; j++) {
            const th = document.createElement('th');
            th.textContent = `Header ${j + 1}`;
            th.contentEditable = 'true';
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (let i = 0; i < rows - 1; i++) {
            const tr = document.createElement('tr');
            for (let j = 0; j < cols; j++) {
                const td = document.createElement('td');
                td.textContent = '';
                td.contentEditable = 'true';
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);

        insertAtCursor(table);
    }

    function insertAtCursor(element) {
        const editor = document.getElementById('editorBody');
        const selection = window.getSelection();

        if (selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
            const range = selection.getRangeAt(0);
            range.deleteContents();
            range.insertNode(element);
            range.setStartAfter(element);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        } else {
            editor.appendChild(element);
        }
    }

    function applyHeading(value) {
        if (value) {
            document.execCommand('formatBlock', false, value);
        } else {
            document.execCommand('formatBlock', false, 'p');
        }
        triggerSave();
    }

    // ============ PASTE HANDLING ============
    function handlePaste(e) {
        const editor = document.getElementById('editorBody');
        const clipboardData = e.clipboardData || window.clipboardData;

        const items = clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                e.preventDefault();
                const file = items[i].getAsFile();
                insertImageFromFile(file);
                return;
            }
        }

        const html = clipboardData.getData('text/html');
        if (html && html.trim()) {
            e.preventDefault();
            const cleaned = cleanPastedHtml(html);
            insertHtmlAtCursor(cleaned);
            triggerSave();

            setTimeout(() => {
                processCodeBlocks(editor);
                highlightAllCodeBlocks(editor);
            }, 100);
            return;
        }

        const text = clipboardData.getData('text/plain');
        if (text) {
            if (hasMarkdownPatterns(text)) {
                e.preventDefault();
                const htmlFromMd = renderMarkdown(text);
                insertHtmlAtCursor(htmlFromMd);
                triggerSave();
                setTimeout(() => {
                    processCodeBlocks(editor);
                    highlightAllCodeBlocks(editor);
                }, 100);
                return;
            }
        }
    }

    function hasMarkdownPatterns(text) {
        const patterns = [
            /^#{1,6}\s/m,
            /\*\*[^*]+\*\*/,
            /```[\s\S]*?```/,
            /^\s*[-*+]\s/m,
            /^\s*\d+\.\s/m,
            /^\s*>\s/m,
            /\[.+\]\(.+\)/,
            /^\|.+\|$/m
        ];
        let matches = 0;
        patterns.forEach(p => { if (p.test(text)) matches++; });
        return matches >= 2;
    }

    function cleanPastedHtml(html) {
        const temp = document.createElement('div');
        temp.innerHTML = html;

        const unwanted = temp.querySelectorAll('script, style, meta, link, head, title, svg.icon');
        unwanted.forEach(el => el.remove());

        temp.querySelectorAll('[style]').forEach(el => {
            const style = el.getAttribute('style');
            const keepStyles = [];
            if (style.includes('font-weight') && (style.includes('bold') || style.includes('700'))) {
                keepStyles.push('font-weight:bold');
            }
            if (style.includes('font-style') && style.includes('italic')) {
                keepStyles.push('font-style:italic');
            }
            if (style.includes('text-decoration') && style.includes('underline')) {
                keepStyles.push('text-decoration:underline');
            }
            if (style.includes('text-decoration') && style.includes('line-through')) {
                keepStyles.push('text-decoration:line-through');
            }
            if (style.includes('background-color') || style.includes('background:')) {
                const bgMatch = style.match(/background(?:-color)?:\s*([^;]+)/);
                if (bgMatch) {
                    keepStyles.push(`background-color:${bgMatch[1].trim()}`);
                }
            }
            if (style.includes('color:') && !style.includes('background-color')) {
                const colorMatch = style.match(/(?:^|;)\s*color:\s*([^;]+)/);
                if (colorMatch) {
                    keepStyles.push(`color:${colorMatch[1].trim()}`);
                }
            }

            if (keepStyles.length > 0) {
                el.setAttribute('style', keepStyles.join(';'));
            } else {
                el.removeAttribute('style');
            }
        });

        temp.querySelectorAll('[class]').forEach(el => {
            const cls = el.getAttribute('class');
            if (!cls.includes('language-') && !cls.includes('hljs') && !cls.includes('code')) {
                el.removeAttribute('class');
            }
        });

        temp.querySelectorAll('span').forEach(span => {
            if (!span.getAttribute('style') && !span.getAttribute('class')) {
                span.replaceWith(...span.childNodes);
            }
        });

        return DOMPurify.sanitize(temp.innerHTML, {
            ADD_TAGS: ['mark', 'pre', 'code', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'img', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'p', 'div', 'span', 'strong', 'em', 'b', 'i', 'u', 'a', 's', 'del', 'sub', 'sup'],
            ADD_ATTR: ['style', 'class', 'href', 'src', 'alt', 'target', 'contenteditable', 'data-local', 'data-language'],
            ALLOW_DATA_ATTR: true
        });
    }

    function insertHtmlAtCursor(html) {
        const selection = window.getSelection();
        const editor = document.getElementById('editorBody');

        if (selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
            const range = selection.getRangeAt(0);
            range.deleteContents();

            const temp = document.createElement('div');
            temp.innerHTML = html;

            const frag = document.createDocumentFragment();
            let lastNode;
            while (temp.firstChild) {
                lastNode = frag.appendChild(temp.firstChild);
            }

            range.insertNode(frag);

            if (lastNode) {
                range.setStartAfter(lastNode);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        } else {
            editor.innerHTML += html;
        }
    }

    function processCodeBlocks(container) {
        container.querySelectorAll('pre').forEach(pre => {
            if (pre.parentElement && pre.parentElement.classList.contains('code-block-wrapper')) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'code-block-wrapper';
            wrapper.contentEditable = 'false';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-code-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.onclick = (e) => {
                e.preventDefault();
                const code = pre.querySelector('code') || pre;
                navigator.clipboard.writeText(code.textContent);
                copyBtn.textContent = 'Copied!';
                setTimeout(() => copyBtn.textContent = 'Copy', 1500);
            };

            const code = pre.querySelector('code');
            if (code) {
                const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
                if (langClass) {
                    const langLabel = document.createElement('span');
                    langLabel.className = 'code-lang-label';
                    langLabel.textContent = langClass.replace('language-', '');
                    wrapper.appendChild(langLabel);
                }
                code.contentEditable = 'true';
            } else {
                pre.contentEditable = 'true';
            }

            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(copyBtn);
            wrapper.appendChild(pre);
        });
    }

    function highlightAllCodeBlocks(container) {
        if (typeof hljs === 'undefined') return;
        container.querySelectorAll('pre code').forEach(block => {
            if (!block.classList.contains('hljs')) {
                hljs.highlightElement(block);
            }
        });
    }

    function toggleMarkdownMode() {
        isMarkdownMode = !isMarkdownMode;
        const editorWrapper = document.getElementById('editorWrapper');
        const mdEditor = document.getElementById('markdownEditor');
        const btn = document.getElementById('btnToggleMarkdown');

        if (isMarkdownMode) {
            editorWrapper.style.display = 'none';
            mdEditor.style.display = 'grid';
            btn.classList.add('active');

            const html = document.getElementById('editorBody').innerHTML;
            document.getElementById('markdownInput').value = htmlToMarkdown(html);
            updateMarkdownPreview();
        } else {
            editorWrapper.style.display = 'block';
            mdEditor.style.display = 'none';
            btn.classList.remove('active');

            const md = document.getElementById('markdownInput').value;
            const html = renderMarkdown(md);
            document.getElementById('editorBody').innerHTML = html;
            processCodeBlocks(document.getElementById('editorBody'));
            highlightAllCodeBlocks(document.getElementById('editorBody'));
            triggerSave();
        }
    }

    function renderMarkdown(md) {
        if (typeof marked === 'undefined') return escapeHtml(md).replace(/\n/g, '<br>');

        marked.setOptions({
            highlight: function(code, lang) {
                if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                    return hljs.highlight(code, { language: lang }).value;
                }
                return code;
            },
            breaks: true,
            gfm: true
        });

        const html = marked.parse(md);
        return DOMPurify.sanitize(html, {
            ADD_TAGS: ['mark', 'pre', 'code', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'img'],
            ADD_ATTR: ['class', 'style', 'href', 'src', 'alt']
        });
    }

    function htmlToMarkdown(html) {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        let md = '';

        function processNode(node, indent = '') {
            if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent;
            }

            if (node.nodeType !== Node.ELEMENT_NODE) return '';

            const tag = node.tagName.toLowerCase();
            const children = Array.from(node.childNodes).map(c => processNode(c, indent)).join('');

            switch (tag) {
                case 'h1': return `\n# ${children}\n`;
                case 'h2': return `\n## ${children}\n`;
                case 'h3': return `\n### ${children}\n`;
                case 'h4': return `\n#### ${children}\n`;
                case 'p': return `\n${children}\n`;
                case 'br': return '\n';
                case 'strong': case 'b': return `**${children}**`;
                case 'em': case 'i': return `*${children}*`;
                case 'u': return `<u>${children}</u>`;
                case 's': case 'del': return `~~${children}~~`;
                case 'code':
                    if (node.parentElement && node.parentElement.tagName === 'PRE') return children;
                    return `\`${children}\``;
                case 'pre': {
                    const codeEl = node.querySelector('code');
                    const lang = codeEl ? (Array.from(codeEl.classList).find(c => c.startsWith('language-')) || '').replace('language-', '') : '';
                    const codeText = codeEl ? codeEl.textContent : node.textContent;
                    return `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n`;
                }
                case 'blockquote': return `\n> ${children.trim().replace(/\n/g, '\n> ')}\n`;
                case 'ul': return '\n' + Array.from(node.children).map(li => `- ${processNode(li, indent)}`).join('\n') + '\n';
                case 'ol': return '\n' + Array.from(node.children).map((li, i) => `${i + 1}. ${processNode(li, indent)}`).join('\n') + '\n';
                case 'li': return children.trim();
                case 'a': return `[${children}](${node.getAttribute('href') || ''})`;
                case 'img': return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
                case 'hr': return '\n---\n';
                case 'table': return '\n' + tableToMarkdown(node) + '\n';
                case 'mark': return `==${children}==`;
                case 'div':
                    if (node.classList.contains('code-block-wrapper')) {
                        const pre = node.querySelector('pre');
                        return pre ? processNode(pre, indent) : children;
                    }
                    return children;
                default: return children;
            }
        }

        function tableToMarkdown(table) {
            const rows = Array.from(table.querySelectorAll('tr'));
            if (rows.length === 0) return '';

            let md = '';
            rows.forEach((row, i) => {
                const cells = Array.from(row.querySelectorAll('th, td'));
                md += '| ' + cells.map(c => c.textContent.trim()).join(' | ') + ' |\n';
                if (i === 0) {
                    md += '| ' + cells.map(() => '---').join(' | ') + ' |\n';
                }
            });
            return md;
        }

        Array.from(temp.childNodes).forEach(node => {
            md += processNode(node);
        });

        return md.replace(/\n{3,}/g, '\n\n').trim();
    }

    function updateMarkdownPreview() {
        const md = document.getElementById('markdownInput').value;
        const html = renderMarkdown(md);
        document.getElementById('markdownPreview').innerHTML = html;

        document.querySelectorAll('#markdownPreview pre code').forEach(block => {
            if (typeof hljs !== 'undefined') {
                hljs.highlightElement(block);
            }
        });
    }

    // ============ THEME ============
    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('nova_theme', next);

        const icon = document.querySelector('#btnThemeToggle i');
        icon.className = next === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    }

    function loadTheme() {
        const theme = localStorage.getItem('nova_theme') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);
        const icon = document.querySelector('#btnThemeToggle i');
        icon.className = theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    }

    // ============ SIDEBAR ============
    function toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.toggle('collapsed');
        localStorage.setItem('nova_sidebarCollapsed', sidebar.classList.contains('collapsed'));

        const icon = document.querySelector('#sidebarToggle i');
        if (sidebar.classList.contains('collapsed')) {
            icon.className = 'fas fa-chevron-right';
        } else {
            icon.className = 'fas fa-chevron-left';
        }
    }

    function applySidebarState() {
        const collapsed = localStorage.getItem('nova_sidebarCollapsed') === 'true';
        const sidebar = document.getElementById('sidebar');
        if (collapsed) {
            sidebar.classList.add('collapsed');
            document.querySelector('#sidebarToggle i').className = 'fas fa-chevron-right';
        }
    }

    // ============ CONTEXT MENU ============
    function showContextMenu(e, pageId) {
        e.preventDefault();
        contextMenuTarget = pageId;
        const menu = document.getElementById('contextMenu');
        menu.style.display = 'block';
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';

        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = (window.innerWidth - rect.width - 10) + 'px';
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = (window.innerHeight - rect.height - 10) + 'px';
        }
    }

    function hideContextMenu() {
        document.getElementById('contextMenu').style.display = 'none';
        contextMenuTarget = null;
    }

    async function handleContextAction(action) {
        if (!contextMenuTarget) return;

        switch (action) {
            case 'rename': {
                const page = allPages.find(p => p.id === contextMenuTarget);
                if (!page) break;
                const newName = prompt('Rename page:', page.title);
                if (newName !== null) {
                    page.title = newName;
                    await savePage(page.id, { title: newName });
                    renderPageTree();
                    if (currentPageId === page.id) {
                        document.getElementById('pageTitleInput').value = newName;
                    }
                }
                break;
            }
            case 'duplicate':
                await duplicatePage(contextMenuTarget);
                break;
            case 'move': {
                const page = allPages.find(p => p.id === contextMenuTarget);
                if (!page) break;
                const folderNames = allFolders.map(f => f.name);
                const folderChoice = prompt(
                    `Move to folder:\n${folderNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nEnter number (or 0 for root):`
                );
                if (folderChoice !== null) {
                    const idx = parseInt(folderChoice) - 1;
                    page.folderId = idx >= 0 && idx < allFolders.length ? allFolders[idx].id : null;
                    await savePage(page.id, { folderId: page.folderId });
                    renderPageTree();
                }
                break;
            }
            case 'export':
                exportPage(contextMenuTarget);
                break;
            case 'delete':
                if (confirm('Delete this page?')) {
                    await deletePage(contextMenuTarget);
                }
                break;
        }

        hideContextMenu();
    }

    // ============ EXPORT / IMPORT ============
    function exportCurrentPage() {
        if (currentPageId) exportPage(currentPageId);
    }

    function exportPage(pageId) {
        const page = allPages.find(p => p.id === pageId);
        if (!page) return;

        const data = {
            type: 'NovaNotes_Page',
            version: 1,
            page: page
        };

        downloadJson(data, `${page.title || 'untitled'}.json`);
    }

    async function exportAllData() {
        const pages = await dbGetAll(STORE_PAGES);
        const folders = await dbGetAll(STORE_FOLDERS);

        const data = {
            type: 'NovaNotes_Backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            folders: folders,
            pages: pages
        };

        downloadJson(data, `NovaNotes_backup_${new Date().toISOString().split('T')[0]}.json`);
    }

    async function importData(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);

            if (data.type === 'NovaNotes_Backup') {
                if (data.folders) {
                    for (const folder of data.folders) {
                        await dbPut(STORE_FOLDERS, folder);
                    }
                }
                if (data.pages) {
                    for (const page of data.pages) {
                        await dbPut(STORE_PAGES, page);
                    }
                }
            } else if (data.type === 'NovaNotes_Page') {
                data.page.id = generateId();
                await dbPut(STORE_PAGES, data.page);
            } else {
                alert('Invalid file format');
                return;
            }

            await loadData();
            renderPageTree();
            alert('Import successful!');
        } catch (err) {
            alert('Import failed: ' + err.message);
        }
    }

    function downloadJson(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ============ EMOJI PICKER ============
    function populateEmojiPicker() {
        const emojis = ['📄','📝','📋','📌','📎','📁','📂','📚','📖','📗','📘','📙','📓','📔','📒','📕','📏','📐','✏️','🖊️','🖋️','✒️','🔍','💡','⭐','🌟','✨','💫','🔥','❤️','💙','💚','💛','💜','🧡','🤍','🖤','💎','🎯','🎨','🎭','🎬','🎵','🎶','🎸','🎮','🕹️','🎲','🏆','🥇','🚀','✈️','🌍','🌎','🌏','🏠','🏢','🏗️','⚡','💻','🖥️','📱','⌨️','🖱️','💾','📀','🔧','🔨','⚙️','🔩','🧲','🧪','🧬','🔬','🔭','📡','🛠️','⚗️','💊','🩺','🧮','📊','📈','📉','🗂️','🗃️','🗄️','🗑️','🔒','🔓','🔑','🗝️','🔐','✅','❌','⚠️','🚫','💤','🔔','📣','🧠','👁️','👤','👥','🤖','👾','🐛','🦋','🌱','🌲','🌸','🍎','☕','🍕'];

        const grid = document.getElementById('emojiGrid');
        grid.innerHTML = '';
        emojis.forEach(emoji => {
            const span = document.createElement('span');
            span.textContent = emoji;
            span.addEventListener('click', () => {
                document.getElementById('pageIconPicker').textContent = emoji;
                document.getElementById('emojiModal').style.display = 'none';
                triggerSave();
                renderPageTree();
            });
            grid.appendChild(span);
        });
    }

    // ============ DRAG & DROP ON EDITOR ============
    function handleEditorDrop(e) {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            e.preventDefault();
            for (let i = 0; i < files.length; i++) {
                if (files[i].type.startsWith('image/')) {
                    insertImageFromFile(files[i]);
                }
            }
        }
    }

    // ============ FOLDER DRAG & DROP ============
    function setupTreeDragDrop() {
        const tree = document.getElementById('pageTree');

        tree.addEventListener('dragover', (e) => {
            e.preventDefault();
            const target = e.target.closest('.tree-item');
            if (target) {
                document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
                const folderItem = target.closest('.tree-folder');
                if (folderItem) {
                    target.classList.add('drag-over');
                }
            }
        });

        tree.addEventListener('drop', async (e) => {
            e.preventDefault();
            const pageId = e.dataTransfer.getData('text/plain');
            if (!pageId) return;

            const target = e.target.closest('.tree-folder');
            const folderId = target ? target.dataset.folderId : null;

            const page = allPages.find(p => p.id === pageId);
            if (page) {
                page.folderId = folderId;
                await savePage(page.id, { folderId });
                renderPageTree();
            }

            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });
    }

    // ============ KEYBOARD SHORTCUTS ============
    function handleKeyboard(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveCurrentPage();
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
            e.preventDefault();
            createPage();
        }

        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
            e.preventDefault();
            const name = prompt('Folder name:');
            if (name) createFolder(name);
        }

        if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
            e.preventDefault();
            toggleSidebar();
        }

        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
            hideContextMenu();
        }

        if (e.key === 'Tab') {
            const selection = window.getSelection();
            if (selection.anchorNode) {
                const codeBlock = selection.anchorNode.closest ? selection.anchorNode.closest('code, pre') : null;
                const parentCodeBlock = selection.anchorNode.parentElement ? selection.anchorNode.parentElement.closest('code, pre') : null;
                if (codeBlock || parentCodeBlock) {
                    e.preventDefault();
                    document.execCommand('insertText', false, '    ');
                }
            }
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ============ EVENT LISTENERS ============
    function setupEventListeners() {
        document.getElementById('btnExportToFolder').addEventListener('click', async () => {
            try {
                await exportAllToFolder();
                alert('All notes exported to data folder!');
            } catch (err) {
                console.error('Export failed:', err);
                alert('Export cancelled or failed.');
            }
        });

        document.getElementById('sidebarToggle').addEventListener('click', toggleSidebar);
        document.getElementById('btnNewPage').addEventListener('click', () => createPage());
        document.getElementById('btnNewFolder').addEventListener('click', () => {
            const name = prompt('Folder name:');
            if (name) createFolder(name);
        });

        document.getElementById('searchInput').addEventListener('input', () => {
            renderPageTree();
        });

        document.getElementById('btnWelcomeNew').addEventListener('click', () => createPage());

        document.getElementById('btnThemeToggle').addEventListener('click', toggleTheme);

        document.getElementById('btnExportAll').addEventListener('click', exportAllData);
        document.getElementById('btnImportData').addEventListener('click', () => {
            document.getElementById('fileImport').click();
        });
        document.getElementById('fileImport').addEventListener('change', (e) => {
            if (e.target.files[0]) {
                importData(e.target.files[0]);
                e.target.value = '';
            }
        });

        document.getElementById('pageTitleInput').addEventListener('input', () => {
            triggerSave();
            const page = allPages.find(p => p.id === currentPageId);
            if (page) updateBreadcrumb({ ...page, title: document.getElementById('pageTitleInput').value });
        });

        document.getElementById('pageIconPicker').addEventListener('click', () => {
            document.getElementById('emojiModal').style.display = 'flex';
        });

        const editor = document.getElementById('editorBody');

        editor.addEventListener('input', () => {
            triggerSave();
            updateWordCount();
        });

        editor.addEventListener('paste', handlePaste);

        editor.addEventListener('drop', handleEditorDrop);
        editor.addEventListener('dragover', (e) => e.preventDefault());

        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const selection = window.getSelection();
                const node = selection.anchorNode;
                const checklistItem = node && (node.closest ? node.closest('.checklist-item') : (node.parentElement ? node.parentElement.closest('.checklist-item') : null));

                if (checklistItem) {
                    e.preventDefault();
                    const newItem = document.createElement('div');
                    newItem.className = 'checklist-item';
                    newItem.innerHTML = `
                        <input type="checkbox" onchange="this.parentElement.classList.toggle('checked', this.checked)">
                        <span class="checklist-text" contenteditable="true"></span>
                    `;
                    checklistItem.after(newItem);
                    newItem.querySelector('.checklist-text').focus();
                }
            }
        });

        document.querySelectorAll('.tool-btn[data-command]').forEach(btn => {
            btn.addEventListener('click', () => {
                executeCommand(btn.dataset.command);
            });
        });

        document.getElementById('headingSelect').addEventListener('change', (e) => {
            applyHeading(e.target.value);
            e.target.value = '';
        });

        document.getElementById('imageInput').addEventListener('change', (e) => {
            if (e.target.files[0]) {
                insertImageFromFile(e.target.files[0]);
                e.target.value = '';
            }
        });

        document.getElementById('coverInput').addEventListener('change', async (e) => {
            if (e.target.files[0]) {
                const base64 = await fileToBase64(e.target.files[0]);
                document.getElementById('coverImage').src = base64;
                document.getElementById('coverImageContainer').style.display = 'block';
                triggerSave();
                e.target.value = '';
            }
        });

        document.getElementById('btnRemoveCover').addEventListener('click', () => {
            document.getElementById('coverImageContainer').style.display = 'none';
            document.getElementById('coverImage').src = '';
            triggerSave();
        });

        document.getElementById('btnInsertTable').addEventListener('click', () => {
            const rows = parseInt(document.getElementById('tableRows').value) || 3;
            const cols = parseInt(document.getElementById('tableCols').value) || 3;
            insertTable(rows, cols);
            document.getElementById('tableModal').style.display = 'none';
            triggerSave();
        });

        document.querySelectorAll('[data-close]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById(btn.dataset.close).style.display = 'none';
            });
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) overlay.style.display = 'none';
            });
        });

        document.querySelectorAll('.context-item[data-action]').forEach(item => {
            item.addEventListener('click', () => {
                handleContextAction(item.dataset.action);
            });
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.context-menu') && !e.target.closest('[data-context-page]')) {
                hideContextMenu();
            }
        });

        document.addEventListener('keydown', handleKeyboard);

        document.getElementById('markdownInput').addEventListener('input', () => {
            updateMarkdownPreview();
            triggerSave();
        });

        setupTreeDragDrop();

        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) {
                document.getElementById('sidebar').classList.remove('mobile-open');
            }
        });

        window.addEventListener('beforeunload', () => {
            if (currentPageId) {
                saveCurrentPage();
            }
        });

        editor.addEventListener('click', (e) => {
            if (e.target.type === 'checkbox') {
                const item = e.target.closest('.checklist-item');
                if (item) {
                    item.classList.toggle('checked', e.target.checked);
                    triggerSave();
                }
            }
        });

        if (window.innerWidth <= 768) {
            const mobileToggle = document.createElement('button');
            mobileToggle.innerHTML = '<i class="fas fa-bars"></i>';
            mobileToggle.style.cssText = 'position:fixed;top:10px;left:10px;z-index:300;background:var(--accent);color:#fff;border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;box-shadow:var(--shadow-md);display:flex;align-items:center;justify-content:center;font-size:18px;';
            mobileToggle.addEventListener('click', () => {
                document.getElementById('sidebar').classList.toggle('mobile-open');
            });
            document.body.appendChild(mobileToggle);
        }
    }

    document.addEventListener('DOMContentLoaded', init);
})();