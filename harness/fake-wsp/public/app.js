/* Fake WSP — imitates the real portal's behaviour (Vaadin-like): no hrefs, navigation by clicking,
   table rows select on click, Back/Enter buttons, downloads through a hidden iframe. */
(function () {
  'use strict';

  const view = document.getElementById('view');
  const dl = document.getElementById('dl');
  let data = null; // /api/tree

  const MODULES = [
    ['Student files', '/StudentFiles'],
    ["Student's schedule", '/StudentSchedule'],
    ['Attendance mark', '/AttendanceMark'],
    ["Student's Journal", '/StudentJournal'],
    ['Transcript', '/Transcript'],
    ['Student exam schedule', '/StudentExamSchedule'],
    ['Registration for disciplines', '/Registration'],
    ['News', '/News'],
  ];

  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const vButton = (caption, onClick, disabled) =>
    h(
      'div',
      { class: 'v-button v-widget' + (disabled ? ' v-disabled' : ''), role: 'button', tabindex: '0', onclick: () => !disabled && onClick() },
      h('span', { class: 'v-button-wrap' }, h('span', { class: 'v-button-caption' }, caption)),
    );

  function go(path) {
    if (location.pathname !== path) history.pushState({}, '', path);
    render();
  }
  window.addEventListener('popstate', render);
  document.querySelector('.home-icon').addEventListener('click', () => go('/'));
  for (const flag of document.querySelectorAll('.flag')) flag.addEventListener('click', () => (document.documentElement.lang = flag.dataset.lang));

  // ---------- Desktop ----------
  function renderDesktop() {
    view.replaceChildren(
      h('h2', { class: 'v-caption' }, 'Desktop'),
      h('div', { class: 'desktop' }, MODULES.map(([label, path]) => vButton(label, () => go(path)))),
    );
  }

  // ---------- Student files (folder browser) ----------
  const fs = { stack: [], selected: -1 }; // stack of indices: [school, instructor, course]

  function level() {
    const [s, i, c] = fs.stack;
    if (fs.stack.length === 0) return { kind: 'school', rows: data.schools.map((x) => ({ name: x.name, folder: true })) };
    if (fs.stack.length === 1) return { kind: 'instructor', rows: data.schools[s].instructors.map((x) => ({ name: x.name, folder: true })) };
    if (fs.stack.length === 2) return { kind: 'course', rows: data.schools[s].instructors[i].courses.map((x) => ({ name: x.name, folder: true })) };
    const instr = data.schools[s].instructors[i];
    const course = instr.courses[c];
    return {
      kind: 'file',
      rows: course.files.map((f) => ({ name: f.name, folder: false, modified: f.modified, size: f.size, url: fileUrl(instr.name, course.name, f.name) })),
    };
  }
  function fileUrl(instr, course, name) {
    return '/files/' + [instr, course, name].map(encodeURIComponent).join('/');
  }
  function pathLabel() {
    const names = [];
    const [s, i, c] = fs.stack;
    if (s !== undefined) names.push(data.schools[s].name);
    if (i !== undefined) names.push(data.schools[s].instructors[i].name);
    if (c !== undefined) names.push(data.schools[s].instructors[i].courses[c].name);
    return names.length ? names.join(' / ') : 'All schools';
  }
  function download(url) {
    dl.src = url; // Content-Disposition: attachment -> browser download, page stays put
  }
  function enter() {
    const lv = level();
    const row = lv.rows[fs.selected];
    if (!row) return;
    if (row.folder) {
      fs.stack.push(fs.selected);
      fs.selected = -1;
      renderFiles();
    } else download(row.url);
  }
  function back() {
    if (!fs.stack.length) return;
    fs.selected = fs.stack.pop();
    renderFiles();
  }
  function renderFiles() {
    const lv = level();
    const rows = lv.rows.map((row, idx) =>
      h(
        'tr',
        {
          class: 'v-table-row' + (idx === fs.selected ? ' v-selected' : ''),
          onclick: () => {
            fs.selected = idx;
            for (const tr of view.querySelectorAll('tr.v-table-row')) tr.classList.toggle('v-selected', tr.rowIndex - 1 === idx);
            if (!row.folder) download(row.url);
          },
        },
        h('td', { class: 'v-table-cell-content' }, h('div', { class: 'v-table-cell-wrapper' }, row.name)),
        h('td', { class: 'v-table-cell-content' }, h('div', { class: 'v-table-cell-wrapper' }, row.folder ? 'Folder' : 'File')),
        h('td', { class: 'v-table-cell-content' }, h('div', { class: 'v-table-cell-wrapper' }, row.folder ? '' : (row.size ? row.size + ' B' : ''))),
        h('td', { class: 'v-table-cell-content' }, h('div', { class: 'v-table-cell-wrapper' }, row.modified || '')),
      ),
    );
    view.replaceChildren(
      h('h2', { class: 'v-caption' }, 'Student files'),
      h('div', { class: 'toolbar' }, vButton('Back', back, fs.stack.length === 0), vButton('Enter', enter), h('span', { class: 'path v-label' }, pathLabel())),
      h(
        'div',
        { class: 'v-table' },
        h(
          'table',
          { class: 'v-table-table' },
          h('thead', null, h('tr', { class: 'v-table-header' }, ['Name', 'Type', 'Size', 'Modified'].map((t) => h('td', null, t)))),
          h('tbody', null, rows.length ? rows : h('tr', null, h('td', { class: 'empty', colspan: '4' }, 'Empty folder'))),
        ),
      ),
      h('p', { class: 'v-label', style: 'color:#6b7a8a;margin-top:8px' }, 'Select a row, then press Enter to open a folder. Files download when opened.'),
    );
  }

  // ---------- Schedule ----------
  const sched = { year: null, term: null };
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const HOURS = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
  function renderSchedule() {
    const s = data.schedule;
    sched.year = sched.year || s.default.year;
    sched.term = sched.term || s.default.term;
    const classes = s.classes[sched.year + '/' + sched.term] || [];
    const yearSel = h('select', { id: 'year', onchange: (e) => ((sched.year = e.target.value), renderSchedule()) }, s.years.map((y) => h('option', { value: y, ...(y === sched.year ? { selected: '' } : {}) }, y)));
    const termSel = h('select', { id: 'term', onchange: (e) => ((sched.term = e.target.value), renderSchedule()) }, s.terms.map((t) => h('option', { value: t, ...(t === sched.term ? { selected: '' } : {}) }, t)));
    const grid = h(
      'table',
      { class: 'schedule' },
      h('thead', null, h('tr', null, h('th', null, 'Time'), DAYS.map((d) => h('th', null, d)))),
      h(
        'tbody',
        null,
        HOURS.map((hour) =>
          h(
            'tr',
            null,
            h('td', { class: 'time' }, hour),
            DAYS.map((day) =>
              h('td', null, classes.filter((c) => c.day === day && c.start === hour).map((c) => h('div', { class: 'lesson' }, c.text))),
            ),
          ),
        ),
      ),
    );
    view.replaceChildren(
      h('h2', { class: 'v-caption' }, "Student's schedule"),
      h('div', { class: 'selectors' }, h('label', { for: 'year' }, 'Year'), yearSel, h('label', { for: 'term' }, 'Term'), termSel, h('span', { class: 'v-label' }, classes.length ? `${classes.length} lessons per week` : 'No lessons in this term')),
      grid,
    );
  }

  // ---------- News ----------
  function renderNews() {
    view.replaceChildren(
      h('h2', { class: 'v-caption' }, 'News'),
      data.news.map((n) => h('div', { class: 'news-item' }, h('div', { class: 'news-date' }, n.date), h('div', { class: 'news-title' }, n.title), h('div', { class: 'news-body' }, n.body))),
    );
  }

  // ---------- Chat (stand-in for Telegram Web) ----------
  const chat = { active: null, filter: '' };
  async function renderChat() {
    const chats = await (await fetch('/api/chat')).json();
    chat.active = chat.active || chats[0].id;
    const current = chats.find((c) => c.id === chat.active) || chats[0];
    const list = chats
      .filter((c) => c.name.toLowerCase().includes(chat.filter.toLowerCase()))
      .map((c) =>
        h(
          'div',
          { class: 'chat-row' + (c.id === current.id ? ' active' : ''), onclick: () => ((chat.active = c.id), renderChat()) },
          h('div', { class: 'chat-name' }, c.name),
          h('div', { class: 'chat-last' }, c.messages.length ? c.messages[c.messages.length - 1].text : ''),
        ),
      );
    const search = h('input', { type: 'search', placeholder: 'Search', value: chat.filter, oninput: (e) => ((chat.filter = e.target.value), renderChat()) });
    const messages = h('div', { class: 'messages' }, current.messages.map((m) => h('div', { class: 'msg' + (m.from === 'me' ? ' out' : '') }, h('div', { class: 'meta' }, `${m.from} · ${m.time}`), h('div', null, m.text))));
    const ta = h('textarea', { rows: '2', placeholder: 'Write a message…', 'aria-label': 'Message' });
    const send = async () => {
      const text = ta.value.trim();
      if (!text) return;
      await fetch(`/api/chat/${current.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      ta.value = '';
      await renderChat();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    });
    view.replaceChildren(
      h('h2', { class: 'v-caption' }, 'Messenger'),
      h(
        'div',
        { class: 'chat' },
        h('div', { class: 'chat-left' }, h('div', { class: 'chat-search' }, search), h('div', { class: 'chat-list' }, list)),
        h(
          'div',
          { class: 'chat-right' },
          h('div', { class: 'chat-header' }, current.name, h('small', null, `${current.members} members`)),
          messages,
          h('div', { class: 'composer' }, ta, vButton('Send', send)),
        ),
      ),
    );
    messages.scrollTop = messages.scrollHeight;
    if (chat.filter) search.focus();
  }

  function renderStub(title) {
    view.replaceChildren(h('h2', { class: 'v-caption' }, title), h('p', { class: 'v-label' }, 'This module is not part of the harness.'), vButton('Back to Desktop', () => go('/')));
  }

  function render() {
    if (!data) return;
    const p = location.pathname.replace(/\/+$/, '') || '/';
    if (p === '/') return renderDesktop();
    if (p === '/StudentFiles') return renderFiles();
    if (p === '/StudentSchedule') return renderSchedule();
    if (p === '/News') return renderNews();
    if (p === '/chat') return void renderChat();
    const mod = MODULES.find(([, path]) => path === p);
    return renderStub(mod ? mod[0] : 'Not found');
  }

  fetch('/api/tree')
    .then((r) => r.json())
    .then((t) => {
      data = t;
      render();
    });
})();
