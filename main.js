const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session, shell, dialog } = require('electron');

// Высота «хрома» окна (вкладки + панель навигации) — должна совпадать с renderer/style.css
const CHROME_H = 84;
const COLORS = ['#e5484d', '#f76b15', '#f5b90a', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f'];
const SESSION_COOKIE_TTL = 400 * 24 * 3600; // сек: «сессионные» куки живут как постоянные

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let chromeUA = '';
let overlayOpen = false;
let store = { instances: [], activeId: null, settings: { idleMinutes: 30 } };
const runtime = new Map(); // id -> { view, title, favicon, loading, lastActive, mem }
const preparedSessions = new Set();

/* ---------------- хранилище ---------------- */

const dataFile = () => path.join(app.getPath('userData'), 'instances.json');

function loadStore() {
  try {
    const d = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    store = {
      instances: Array.isArray(d.instances) ? d.instances : [],
      activeId: d.activeId || null,
      settings: { idleMinutes: 30, ...(d.settings || {}) },
    };
  } catch {}
}

let saveTimer = null;
function saveStore(now = false) {
  const write = () => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
      fs.writeFileSync(dataFile(), JSON.stringify(store, null, 2));
    } catch (e) {
      console.error('save failed', e);
    }
  };
  if (now) {
    if (saveTimer) clearTimeout(saveTimer);
    return write();
  }
  if (!saveTimer) saveTimer = setTimeout(write, 500);
}

const getInst = (id) => store.instances.find((i) => i.id === id);
const partitionOf = (id) => `persist:inst-${id}`;

/* ---------------- сессии ---------------- */

function prepareSession(id) {
  const ses = session.fromPartition(partitionOf(id));
  if (preparedSessions.has(id)) return ses;
  preparedSessions.add(id);
  ses.setUserAgent(chromeUA);

  // Сессионные куки (без срока жизни) в обычном браузере теряются при закрытии.
  // Для оркестратора авторизация должна переживать перезапуск экземпляра —
  // превращаем их в постоянные.
  ses.cookies.on('changed', (_e, cookie, cause, removed) => {
    if (removed || !cookie.session || cause !== 'explicit') return;
    const host = cookie.domain.replace(/^\./, '');
    const details = {
      url: `http${cookie.secure ? 's' : ''}://${host}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: Math.floor(Date.now() / 1000) + SESSION_COOKIE_TTL,
    };
    if (!cookie.hostOnly) details.domain = cookie.domain;
    ses.cookies.set(details).catch(() => {});
  });

  // Загрузки — как в обычном браузере (диалог «Сохранить как»), без доп. логики.
  return ses;
}

async function flushSession(id) {
  try {
    const ses = session.fromPartition(partitionOf(id));
    ses.flushStorageData();
    await ses.cookies.flushStore();
  } catch {}
}

/* ---------------- экземпляры ---------------- */

function normalizeInput(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/^(https?|file|about|chrome|devtools):/i.test(t)) return t;
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /^[^\s/]+\.[^\s/.]{2,}(:\d+)?([/?#].*)?$/.test(t)) return 'https://' + t;
  return 'https://www.google.com/search?q=' + encodeURIComponent(t);
}

function layoutViews() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  const bounds = { x: 0, y: CHROME_H, width: w, height: Math.max(0, h - CHROME_H) };
  for (const rt of runtime.values()) rt.view.setBounds(bounds);
}

function startInstance(id) {
  if (runtime.has(id)) return runtime.get(id);
  const inst = getInst(id);
  if (!inst || !win) return null;
  prepareSession(id);

  const view = new WebContentsView({
    webPreferences: {
      partition: partitionOf(id),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  const wc = view.webContents;
  wc.setUserAgent(chromeUA);
  const rt = { view, title: '', favicon: '', loading: false, lastActive: Date.now(), mem: 0 };
  runtime.set(id, rt);
  win.contentView.addChildView(view);
  view.setVisible(false);
  layoutViews();

  const alive = () => runtime.get(id) === rt && !wc.isDestroyed();
  const touch = () => alive() && sendState();

  wc.on('page-title-updated', (_e, title) => { rt.title = title; touch(); });
  wc.on('page-favicon-updated', (_e, icons) => { rt.favicon = icons[0] || ''; touch(); });
  wc.on('did-start-loading', () => { rt.loading = true; touch(); });
  wc.on('did-stop-loading', () => { rt.loading = false; touch(); });
  const onNav = (_e, url) => {
    if (!alive()) return;
    if (/^https?:|^file:/i.test(url)) { inst.url = url; saveStore(); }
    touch();
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('render-process-gone', () => { rt.loading = false; touch(); });
  wc.on('before-input-event', (e, input) => handleShortcut(e, input));

  // target=_blank и window.open: обычные ссылки открываем в этом же экземпляре,
  // всплывающие окна (OAuth и т.п.) — отдельным окном той же сессии.
  wc.setWindowOpenHandler(({ url, features, disposition }) => {
    if (disposition === 'new-window' && features) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, parent: win },
      };
    }
    if (/^https?:/i.test(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => {
    child.webContents.setUserAgent(chromeUA);
    child.setMenu(null);
  });

  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL) {
      items.push({ label: 'Открыть ссылку здесь', click: () => wc.loadURL(p.linkURL) });
      items.push({ label: 'Копировать адрес ссылки', click: () => require('electron').clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' });
    } else if (p.selectionText) {
      items.push({ role: 'copy', label: 'Копировать' });
    } else {
      items.push(
        { label: 'Назад', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Вперёд', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Обновить', click: () => wc.reload() },
      );
    }
    items.push({ type: 'separator' }, { label: 'Просмотреть код', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  const start = inst.url && /^https?:|^file:/i.test(inst.url) ? inst.url : 'about:blank';
  wc.loadURL(start).catch(() => {});
  inst.running = true;
  saveStore();
  return rt;
}

async function stopInstance(id, { keepFlag = false } = {}) {
  const rt = runtime.get(id);
  const inst = getInst(id);
  if (inst && !keepFlag) inst.running = false;
  if (rt) {
    const wc = rt.view.webContents;
    await flushSession(id);
    runtime.delete(id);
    try { win.contentView.removeChildView(rt.view); } catch {}
    try { if (!wc.isDestroyed()) wc.close(); } catch {}
    await flushSession(id);
  }
  saveStore();
  sendState();
}

function selectInstance(id) {
  const inst = getInst(id);
  if (!inst) return;
  if (!runtime.has(id)) startInstance(id);
  store.activeId = id;
  const rt = runtime.get(id);
  rt.lastActive = Date.now();
  applyVisibility();
  rt.view.webContents.focus();
  saveStore();
  sendState();
}

function applyVisibility() {
  for (const [id, rt] of runtime) {
    rt.view.setVisible(id === store.activeId && !overlayOpen);
  }
}

async function deleteInstance(id) {
  const idx = store.instances.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const ses = session.fromPartition(partitionOf(id));
  await stopInstance(id);
  try {
    await ses.clearStorageData();
    await ses.clearCache();
  } catch {}
  store.instances.splice(idx, 1);
  preparedSessions.delete(id);
  if (store.activeId === id) {
    const next = store.instances[Math.min(idx, store.instances.length - 1)];
    store.activeId = next ? next.id : null;
    if (next) selectInstance(next.id);
  }
  saveStore(true);
  sendState();
  // Папку раздела удаляем «на хвосте» — Chromium может ещё держать файлы.
  const dir = path.join(app.getPath('userData'), 'Partitions', `inst-${id}`);
  setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 1500);
}

/* ---------------- состояние для UI ---------------- */

function activeRt() {
  return store.activeId ? runtime.get(store.activeId) : null;
}

function snapshot() {
  return {
    activeId: store.activeId,
    settings: store.settings,
    instances: store.instances.map((i) => {
      const rt = runtime.get(i.id);
      const wc = rt && !rt.view.webContents.isDestroyed() ? rt.view.webContents : null;
      const url = wc ? wc.getURL() : i.url || '';
      return {
        id: i.id,
        name: i.name,
        color: i.color,
        running: !!rt,
        title: rt ? rt.title : '',
        favicon: rt ? rt.favicon : '',
        loading: rt ? rt.loading : false,
        url: url === 'about:blank' ? '' : url,
        canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
        canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
        mem: rt ? rt.mem : 0,
      };
    }),
  };
}

function sendState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
}

function updateMemory() {
  const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, m.memory.workingSetSize]));
  for (const rt of runtime.values()) {
    const pid = rt.view.webContents.getOSProcessId();
    rt.mem = byPid.get(pid) || 0; // КБ
  }
  sendState();
}

function hibernateIdle() {
  const mins = store.settings.idleMinutes;
  if (!mins || mins <= 0) return;
  const limit = Date.now() - mins * 60000;
  for (const [id, rt] of runtime) {
    if (id === store.activeId) continue;
    if (rt.lastActive < limit && !rt.view.webContents.isCurrentlyAudible()) stopInstance(id);
  }
}

/* ---------------- горячие клавиши ---------------- */

function handleShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  const k = input.key.toLowerCase();
  const ctrl = input.control || input.meta;
  const rt = activeRt();
  const wc = rt && rt.view.webContents;
  const done = (fn) => { event.preventDefault(); fn(); };

  if (ctrl && k === 'l' || input.alt && k === 'd') return done(() => win.webContents.send('focus-url'));
  if (ctrl && k === 't') return done(() => win.webContents.send('new-request'));
  if (k === 'f5' || (ctrl && k === 'r')) return done(() => wc && (input.shift ? wc.reloadIgnoringCache() : wc.reload()));
  if (input.alt && k === 'arrowleft') return done(() => wc && wc.navigationHistory.goBack());
  if (input.alt && k === 'arrowright') return done(() => wc && wc.navigationHistory.goForward());
  if (k === 'f12' || (ctrl && input.shift && k === 'i')) return done(() => wc && wc.openDevTools({ mode: 'detach' }));
  if (ctrl && k === 'tab') {
    return done(() => {
      const n = store.instances.length;
      if (!n) return;
      const cur = store.instances.findIndex((i) => i.id === store.activeId);
      selectInstance(store.instances[(cur + (input.shift ? n - 1 : 1)) % n].id);
    });
  }
  if (ctrl && /^[1-9]$/.test(k)) {
    const inst = store.instances[Number(k) - 1];
    if (inst) return done(() => selectInstance(inst.id));
  }
}

/* ---------------- IPC ---------------- */

ipcMain.handle('get-state', () => snapshot());

ipcMain.handle('create', (_e, { name, url }) => {
  const id = crypto.randomBytes(5).toString('hex');
  const inst = {
    id,
    name: (name || '').trim() || `Экземпляр ${store.instances.length + 1}`,
    color: COLORS[store.instances.length % COLORS.length],
    url: normalizeInput(url),
    running: true,
  };
  store.instances.push(inst);
  selectInstance(id);
  return id;
});

ipcMain.on('select', (_e, id) => selectInstance(id));
ipcMain.on('rename', (_e, { id, name }) => {
  const inst = getInst(id);
  if (inst && name && name.trim()) { inst.name = name.trim(); saveStore(); sendState(); }
});
ipcMain.on('toggle', (_e, id) => {
  if (runtime.has(id)) {
    stopInstance(id);
  } else {
    selectInstance(id);
  }
});
ipcMain.on('overlay', (_e, open) => { overlayOpen = !!open; applyVisibility(); });
ipcMain.on('navigate', (_e, text) => {
  const rt = activeRt();
  const url = normalizeInput(text);
  if (rt && url) rt.view.webContents.loadURL(url).catch(() => {});
  if (rt) rt.view.webContents.focus();
});
ipcMain.on('nav', (_e, action) => {
  const rt = activeRt();
  if (!rt) return;
  const wc = rt.view.webContents;
  if (action === 'back') wc.navigationHistory.goBack();
  else if (action === 'forward') wc.navigationHistory.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'stop') wc.stop();
  else if (action === 'devtools') wc.openDevTools({ mode: 'detach' });
});
ipcMain.on('set-settings', (_e, s) => {
  const m = Math.max(0, Math.floor(Number(s.idleMinutes) || 0));
  store.settings.idleMinutes = m;
  saveStore();
  sendState();
});
ipcMain.on('hibernate-others', () => {
  for (const id of [...runtime.keys()]) if (id !== store.activeId) stopInstance(id);
});

async function confirm(message, detail, yes) {
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: [yes, 'Отмена'], defaultId: 1, cancelId: 1, message, detail,
  });
  return r.response === 0;
}

ipcMain.on('tab-menu', (_e, id) => {
  const inst = getInst(id);
  if (!inst) return;
  const running = runtime.has(id);
  const ses = () => session.fromPartition(partitionOf(id));
  Menu.buildFromTemplate([
    { label: 'Переименовать…', click: () => win.webContents.send('rename-request', id) },
    { label: running ? 'Выключить (освободить память)' : 'Запустить', click: () => (running ? stopInstance(id) : selectInstance(id)) },
    { label: 'Обновить страницу', enabled: running, click: () => runtime.get(id)?.view.webContents.reload() },
    { type: 'separator' },
    {
      label: 'Очистить кэш',
      click: async () => { await ses().clearCache(); await ses().clearCodeCaches({}); },
    },
    {
      label: 'Выйти из аккаунтов (очистить все данные сайтов)…',
      click: async () => {
        if (!(await confirm(`Очистить данные «${inst.name}»?`, 'Будут удалены куки, localStorage, IndexedDB, кэш. Авторизации в этом экземпляре пропадут.', 'Очистить'))) return;
        await ses().clearStorageData();
        await ses().clearCache();
        runtime.get(id)?.view.webContents.reload();
      },
    },
    { type: 'separator' },
    {
      label: 'Удалить экземпляр…',
      click: async () => {
        if (await confirm(`Удалить «${inst.name}»?`, 'Экземпляр и все его данные (куки, кэш, локальные файлы) будут удалены безвозвратно.', 'Удалить')) deleteInstance(id);
      },
    },
  ]).popup({ window: win });
});

/* ---------------- окно ---------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1f2023',
    title: 'Instance Browser',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('resize', layoutViews);
  win.on('maximize', layoutViews);
  win.on('unmaximize', layoutViews);
  win.on('enter-full-screen', layoutViews);
  win.on('leave-full-screen', layoutViews);
  win.webContents.on('before-input-event', (e, input) => handleShortcut(e, input));
  win.on('closed', () => { win = null; });

  win.webContents.once('did-finish-load', () => {
    // Восстанавливаем экземпляры, которые были запущены при прошлом выходе.
    for (const inst of store.instances) if (inst.running) startInstance(inst.id);
    if (!getInst(store.activeId)) store.activeId = store.instances[0]?.id || null;
    if (store.activeId) selectInstance(store.activeId);
    sendState();
  });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  chromeUA = session.defaultSession.getUserAgent()
    .replace(/\s?Electron\/\S+/, '')
    .replace(new RegExp(`\\s?${app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\S+`), '');
  Menu.setApplicationMenu(null);
  loadStore();
  createWindow();
  setInterval(updateMemory, 5000);
  setInterval(hibernateIdle, 60000);
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  saveStore(true);
  Promise.all([...runtime.keys()].map(flushSession)).finally(() => app.exit(0));
});

app.on('window-all-closed', () => app.quit());
