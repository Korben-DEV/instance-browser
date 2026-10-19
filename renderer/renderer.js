const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs');
const urlEl = $('url');
let state = { instances: [], activeId: null, settings: {} };
let lastUrlShown = null;

function host(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function render() {
  const { instances, activeId } = state;
  tabsEl.replaceChildren();
  for (const inst of instances) {
    const tab = el('div', 'tab' + (inst.id === activeId ? ' active' : '') + (inst.running ? '' : ' stopped') + (inst.loading ? ' loading' : ''));
    tab.title = `${inst.name}${inst.title ? ' — ' + inst.title : ''}${inst.running ? (inst.mem ? `\nПамять: ${Math.round(inst.mem / 1024)} МБ` : '') : '\nВыключен'}`;

    const bar = el('div', 'bar');
    bar.style.background = inst.color;
    tab.append(bar);

    const icon = el('div', 'icon');
    if (inst.favicon && inst.running) {
      const img = document.createElement('img');
      img.src = inst.favicon;
      img.onerror = () => { icon.replaceChildren(dot(inst)); };
      icon.append(img);
    } else {
      icon.append(dot(inst));
    }

    const text = el('div', 'text');
    text.append(el('div', 'label', inst.name), el('div', 'sub', inst.running ? host(inst.url) || 'пустая страница' : 'выключен'));

    const power = el('button', 'power', inst.running ? '⏻' : '▶');
    power.title = inst.running ? 'Выключить (освободить память, сессия сохранится)' : 'Запустить';
    power.onclick = (e) => { e.stopPropagation(); window.api.toggle(inst.id); };

    tab.append(icon, text, power);
    tab.onclick = () => window.api.select(inst.id);
    tab.onauxclick = (e) => { if (e.button === 1) window.api.toggle(inst.id); };
    tab.oncontextmenu = (e) => { e.preventDefault(); window.api.tabMenu(inst.id); };
    tab.ondblclick = () => openRename(inst.id);
    tabsEl.append(tab);
  }

  const active = instances.find((i) => i.id === activeId);
  $('back').disabled = !(active && active.canGoBack);
  $('forward').disabled = !(active && active.canGoForward);
  $('reload').disabled = !(active && active.running);
  $('reload').textContent = active && active.loading ? '✕' : '⟳';
  $('reload').dataset.mode = active && active.loading ? 'stop' : 'reload';

  const shown = active && active.running ? active.url : '';
  if (document.activeElement !== urlEl && shown !== lastUrlShown) urlEl.value = shown;
  lastUrlShown = shown;
  urlEl.disabled = !(active && active.running);

  const total = instances.reduce((s, i) => s + (i.mem || 0), 0);
  const running = instances.filter((i) => i.running).length;
  $('mem').textContent = instances.length ? `${running}/${instances.length} активно · ${Math.round(total / 1024)} МБ` : '';

  const empty = $('empty');
  if (!instances.length) {
    empty.hidden = false;
    empty.replaceChildren(el('h2', '', 'Нет экземпляров'),
      el('p', '', 'Каждый экземпляр — отдельный профиль браузера со своими куками, кэшем и локальными данными. Создайте экземпляры, чтобы работать на одном сайте под разными аккаунтами одновременно.'));
    const b = el('button', 'primary', 'Создать экземпляр');
    b.onclick = openCreate;
    empty.append(b);
  } else if (active && !active.running) {
    empty.hidden = false;
    empty.replaceChildren(el('h2', '', `«${active.name}» выключен`), el('p', '', 'Сессии и авторизации сохранены на диске и будут доступны после запуска.'));
    const b = el('button', 'primary', 'Запустить');
    b.onclick = () => window.api.select(active.id);
    empty.append(b);
  } else {
    empty.hidden = true;
  }
}

function dot(inst) {
  const d = el('div', 'dot');
  d.style.background = inst.color;
  return d;
}

/* ---- модальное окно ---- */
const modal = $('modal');
let onSubmit = null;

function openModal({ title, ok, name, showName = true, showUrl = false, showIdle = false, idle = 0, submit }) {
  $('modalTitle').textContent = title;
  $('modalOk').textContent = ok;
  $('fName').parentElement.hidden = !showName;
  $('rowUrl').hidden = !showUrl;
  $('rowIdle').hidden = !showIdle;
  $('hibernateNow').hidden = !showIdle;
  $('fName').value = name || '';
  $('fUrl').value = '';
  $('fIdle').value = idle;
  onSubmit = submit;
  window.api.overlay(true);
  modal.showModal();
  if (showName) { $('fName').focus(); $('fName').select(); }
}

modal.addEventListener('close', () => window.api.overlay(false));
$('modalCancel').onclick = () => { onSubmit = null; modal.close(); };
$('modalForm').addEventListener('submit', () => {
  const fn = onSubmit;
  onSubmit = null;
  if (fn) fn({ name: $('fName').value, url: $('fUrl').value, idle: $('fIdle').value });
});
$('hibernateNow').onclick = () => window.api.hibernateOthers();

function openCreate() {
  openModal({
    title: 'Новый экземпляр', ok: 'Создать', showUrl: true,
    name: `Экземпляр ${state.instances.length + 1}`,
    submit: ({ name, url }) => window.api.create({ name, url }).then(() => { if (!url.trim()) setTimeout(() => urlEl.focus(), 50); }),
  });
}

function openRename(id) {
  const inst = state.instances.find((i) => i.id === id);
  if (!inst) return;
  openModal({ title: 'Переименовать экземпляр', ok: 'Сохранить', name: inst.name, submit: ({ name }) => window.api.rename(id, name) });
}

function openSettings() {
  openModal({
    title: 'Управление памятью', ok: 'Сохранить', showName: false, showIdle: true,
    idle: state.settings.idleMinutes || 0,
    submit: ({ idle }) => window.api.setSettings({ idleMinutes: idle }),
  });
}

/* ---- события ---- */
$('newTab').onclick = openCreate;
$('settings').onclick = openSettings;
$('back').onclick = () => window.api.nav('back');
$('forward').onclick = () => window.api.nav('forward');
$('reload').onclick = () => window.api.nav($('reload').dataset.mode === 'stop' ? 'stop' : 'reload');
urlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') window.api.navigate(urlEl.value);
  if (e.key === 'Escape') { lastUrlShown = null; urlEl.blur(); render(); }
});
urlEl.addEventListener('focus', () => urlEl.select());

window.api.onState((s) => { state = s; render(); });
window.api.onRenameRequest(openRename);
window.api.onFocusUrl(() => { urlEl.focus(); urlEl.select(); });
window.api.onNewRequest(openCreate);
window.api.getState().then((s) => { state = s; render(); });
