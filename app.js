'use strict';
// TOEIC ランダム出題ツール（Excel版 TOEIC_Random_v2 の Web 移植）
// データは GitHub リポジトリの data/records.json に保存する。

const DATA_PATH = 'data/records.json';
const DEFAULT_REPO = 'akaasap168-commits/TOEIC';
const LS = { cfg: 'toeic.cfg', pending: 'toeic.pending', cache: 'toeic.cache' };

let data = null;      // records.json の中身
let sha = null;       // GitHub 上のファイルの sha（更新時に必要）
let cfg = loadCfg();
let saveQueue = Promise.resolve();

// ---------------------------------------------------------------- 設定
function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(LS.cfg)) || {}; } catch (e) {}
  // GitHub Pages で開いた場合は URL からリポジトリを推定
  if (!c.repo && location.hostname.endsWith('.github.io')) {
    const repo = location.pathname.split('/')[1];
    if (repo) c.repo = location.hostname.split('.')[0] + '/' + repo;
  }
  c.repo = c.repo || DEFAULT_REPO;
  c.branch = c.branch || 'main';
  return c;
}
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }

// ---------------------------------------------------------------- ユーティリティ
const $ = s => document.querySelector(s);
const key = (part, q) => part + '#' + q;
const pad = n => String(n).padStart(2, '0');
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function newSid() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
}
function setStatus(msg, cls) { const s = $('#syncStatus'); s.textContent = msg; s.className = 'status ' + (cls || ''); }
function b64encode(str) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

// tools/import_xlsm.py と同じ形式（配列の要素を1行ずつ）で書き出す
function serialize(d) {
  const one = o => (o && typeof o === 'object')
    ? '{' + Object.entries(o).map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v)).join(', ') + '}'
    : JSON.stringify(o);
  const lines = (arr, ind) => arr.map(o => ind + one(o)).join(',\n');
  const sess = d.sessions.map(s => `  {"id": ${one(s.id)}, ${s.title ? `"title": ${one(s.title)}, ` : ''}"items": [\n${lines(s.items, '    ')}\n  ]}`).join(',\n');
  return '{\n' +
    `"settings": {"mode": ${one(d.settings.mode)}, "parts": [\n${lines(d.settings.parts, '  ')}\n]},\n` +
    `"activeSession": ${one(d.activeSession || '')},\n` +
    `"done": ${d.done.length ? `[\n${lines(d.done, '  ')}\n]` : '[]'},\n` +
    `"sessions": [\n${sess}\n]\n}\n`;
}

// ---------------------------------------------------------------- GitHub 読み書き
function apiUrl() { return `https://api.github.com/repos/${cfg.repo}/contents/${DATA_PATH}`; }
function apiHeaders() {
  const h = { Accept: 'application/vnd.github+json' };
  if (cfg.token) h.Authorization = 'Bearer ' + cfg.token;
  return h;
}
async function fetchRemote() {
  const res = await fetch(`${apiUrl()}?ref=${encodeURIComponent(cfg.branch)}&t=${Date.now()}`, { headers: apiHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`GitHub から読み込めません (${res.status})`);
  const j = await res.json();
  return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
}
async function putRemote(message) {
  const res = await fetch(apiUrl(), {
    method: 'PUT', headers: apiHeaders(),
    body: JSON.stringify({ message, content: b64encode(serialize(data)), sha, branch: cfg.branch }),
  });
  if (res.status === 409 || res.status === 422) return 'conflict';
  if (!res.ok) throw new Error(`GitHub への保存に失敗 (${res.status})`);
  sha = (await res.json()).content.sha;
  return 'ok';
}

async function load() {
  setStatus('読み込み中…');
  const pending = lsGet(LS.pending);
  try {
    if (cfg.repo) {
      const r = await fetchRemote();
      data = r.data; sha = r.sha;
    } else {
      const res = await fetch(DATA_PATH, { cache: 'no-store' });
      if (!res.ok) throw new Error('records.json を読み込めません');
      data = await res.json();
    }
    lsSet(LS.cache, JSON.stringify(data));
  } catch (e) {
    const cached = lsGet(LS.cache);
    if (!cached && !pending) { setStatus(e.message, 'err'); $('#currentQ').textContent = '記録を読み込めませんでした。設定タブで GitHub リポジトリを指定してください。'; showTab('settings'); return; }
    data = JSON.parse(cached || pending);
    toast(e.message + '（このブラウザの保存データを表示中）');
  }
  if (pending) { data = JSON.parse(pending); }
  normalize();
  applyExternalDone();
  render();
  updateStatus();
  // トークン設定前などに溜まった未同期の変更があれば自動で送る
  if (pending && cfg.repo && cfg.token && sha) {
    saveQueue = saveQueue.then(() => pushWithRetry(null, 'sync: 未同期の変更を反映'));
  }
}

function updateStatus() {
  if (lsGet(LS.pending)) setStatus('未同期の変更あり', 'warn');
  else if (!cfg.repo) setStatus('ローカル表示（GitHub 未設定）', 'warn');
  else if (!cfg.token) setStatus('読み取り専用（トークン未設定）', 'warn');
  else setStatus('GitHub と同期済み', 'ok');
}

// 変更を加えて保存する。競合時は GitHub の最新を取り直して同じ変更をやり直す。
function mutate(fn, message) {
  fn(data);
  render();
  lsSet(LS.pending, JSON.stringify(data));
  saveQueue = saveQueue.then(() => pushWithRetry(fn, message));
  return saveQueue;
}
async function pushWithRetry(fn, message) {
  if (!cfg.repo || !cfg.token) { updateStatus(); return; }
  setStatus('保存中…');
  try {
    let r = await putRemote(message);
    if (r === 'conflict') {
      const remote = await fetchRemote();
      sha = remote.sha;
      // 通常の操作は GitHub の最新に同じ変更をやり直す。未同期分の一括送信（fn なし）は手元の内容で上書き
      if (fn) { data = remote.data; normalize(); fn(data); applyExternalDone(); }
      r = await putRemote(message);
      if (r === 'conflict') throw new Error('他の端末と競合しました。再読み込みしてください');
      render();
    }
    lsSet(LS.pending, null);
    lsSet(LS.cache, JSON.stringify(data));
    updateStatus();
  } catch (e) {
    setStatus('未同期の変更あり', 'warn');
    toast(e.message + '（「今すぐ同期」で再送できます）');
  }
}
async function syncNow() {
  if (!lsGet(LS.pending)) { await load(); toast('最新の記録を読み込みました'); return; }
  if (!cfg.token) { toast('トークンを設定してください'); return; }
  // 保留中の内容で上書きする（sha は最新を取得）
  try { sha = (await fetchRemote()).sha; } catch (e) { toast(e.message); return; }
  saveQueue = saveQueue.then(() => pushWithRetry(null, 'sync: 未同期の変更を反映'));
  await saveQueue;
}

// ---------------------------------------------------------------- データ操作
function normalize() {
  data.settings = data.settings || { parts: [], mode: '全体シャッフル' };
  data.sessions = data.sessions || [];
  data.done = data.done || [];
  data.activeSession = data.activeSession || '';
}
function activeSession() { return data.sessions.find(s => s.id === data.activeSession) || null; }
function currentIndex(s) { return s ? s.items.findIndex(i => !i.done) : -1; }
function doneSet() { return new Set(data.done.map(d => key(d.part, d.q))); }

// 「やった登録」済みの問題が未完了セッションに残っていたら自動で飛ばす
function applyExternalDone(d = data) {
  const set = new Set(d.done.map(x => key(x.part, x.q)));
  const date = {}; d.done.forEach(x => { date[key(x.part, x.q)] = x.date; });
  d.sessions.forEach(s => s.items.forEach(i => {
    if (!i.done && set.has(key(i.part, i.q))) { i.done = true; i.external = true; i.date = date[key(i.part, i.q)] || today(); }
  }));
}

// Fisher-Yates シャッフル
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 同じパートが3問以上連続しないように出題順を作る（Excel版 ShuffleNoTriple と同じ貪欲法）
// 常に「残数が最も多いパート（直前2問と同じパートは除く）」を選び、同数はランダム。
function shuffleNoTriple(list) {
  const buckets = new Map();
  list.forEach(x => { if (!buckets.has(x.part)) buckets.set(x.part, []); buckets.get(x.part).push(x); });
  const names = [...buckets.keys()];
  const out = []; let last1 = null, last2 = null;
  while (out.length < list.length) {
    const forbid = last1 !== null && last1 === last2 ? last1 : null;
    const pickFrom = allowForbid => {
      let max = -1, best = [];
      names.forEach(n => {
        const c = buckets.get(n).length;
        if (c === 0 || (!allowForbid && n === forbid)) return;
        if (c > max) { max = c; best = [n]; } else if (c === max) best.push(n);
      });
      return best;
    };
    let best = pickFrom(false);
    if (best.length === 0) best = pickFrom(true);   // そのパートしか残っていない場合はやむを得ず許可
    const chosen = best[Math.floor(Math.random() * best.length)];
    out.push(buckets.get(chosen).shift());
    last2 = last1; last1 = chosen;
  }
  return out;
}

function newSession() {
  const cur = activeSession();
  if (cur && currentIndex(cur) >= 0 &&
      !confirm('現在のセッションはまだ途中です。\n新しいセッションを始めますか？\n\n（途中のセッションには「セッション再開」でいつでも戻れます）')) return;
  const excl = doneSet();
  const { parts, mode } = data.settings;
  let list = [];
  parts.forEach(p => {
    let chunk = [];
    for (let q = 1; q <= p.count; q++) if (!excl.has(key(p.name, q))) chunk.push({ part: p.name, q });
    if (mode === 'パート順シャッフル') chunk = shuffle(chunk);
    list = list.concat(chunk);
  });
  if (mode !== 'パート順シャッフル') list = shuffleNoTriple(list);
  if (list.length === 0) { alert('出題できる問題がありません（すべて「やった登録」済みです）。'); return; }
  let id = newSid();
  for (let n = 2; data.sessions.some(s => s.id === id); n++) id = newSid() + '-' + n;
  const skipped = excl.size ? `（やった登録済み ${parts.reduce((a, p) => a + p.count, 0) - list.length} 問を除外）` : '';
  mutate(d => {
    d.sessions.push({ id, items: list.map((x, i) => ({ seq: i + 1, part: x.part, q: x.q, done: false })) });
    d.activeSession = id;
  }, `session: 新規セッション ${id}`);
  showTab('main');
  toast(`新規セッション ${id} を開始しました${skipped}`);
}

function markDone() {
  const s = activeSession(); const idx = currentIndex(s);
  if (idx < 0) return;
  const it = s.items[idx];
  const sid = s.id, seq = it.seq, date = today();
  mutate(d => {
    const ss = d.sessions.find(x => x.id === sid);
    const t = ss && ss.items.find(x => x.seq === seq && !x.done);
    if (t) { t.done = true; t.date = date; }
  }, `record: ${it.part} 第${it.q}問 やった`);
}

function undoLast() {
  const s = activeSession(); if (!s) return;
  const end = currentIndex(s) < 0 ? s.items.length : currentIndex(s);
  let idx = -1;
  for (let i = end - 1; i >= 0; i--) if (s.items[i].done && !s.items[i].external) { idx = i; break; }
  if (idx < 0) { toast('取り消せる記録がありません'); return; }
  const it = s.items[idx], sid = s.id, seq = it.seq;
  mutate(d => {
    const t = d.sessions.find(x => x.id === sid).items.find(x => x.seq === seq);
    t.done = false; delete t.date;
  }, `undo: ${it.part} 第${it.q}問`);
  toast(`${it.part} 第${it.q}問 の記録を取り消しました`);
}

function resumeSession(id) {
  mutate(d => { d.activeSession = id; }, `session: ${id} を再開`);
  $('#resumeList').classList.add('hidden');
  showTab('main');
  const s = activeSession();
  toast(`セッション ${id} を再開しました（残り ${s.items.filter(i => !i.done).length} 問）`);
}

function toggleExternal(part, q) {
  const k = key(part, q);
  const exists = data.done.some(d => key(d.part, d.q) === k);
  const note = $('#doneNote').value.trim();
  const date = today();
  mutate(d => {
    if (exists) {
      d.done = d.done.filter(x => key(x.part, x.q) !== k);
      d.sessions.forEach(s => s.items.forEach(i => {
        if (i.external && key(i.part, i.q) === k) { i.done = false; delete i.external; delete i.date; }
      }));
    } else if (!d.done.some(x => key(x.part, x.q) === k)) {
      const e = { part, q, date }; if (note) e.note = note;
      d.done.push(e);
      applyExternalDone(d);
    }
  }, `done: ${part} 第${q}問 ${exists ? '登録解除' : 'やった登録'}`);
}

function clearDone() {
  if (!data.done.length) return;
  if (!confirm(`「やった登録」${data.done.length} 件をすべてクリアします。\n（記録タブのセッション履歴はそのまま残ります）\nよろしいですか？`)) return;
  mutate(d => { d.done = []; }, 'done: すべてクリア');
}

function saveSettings() {
  const rows = [...document.querySelectorAll('#partsTable tbody tr')];
  const parts = [];
  for (const [i, tr] of rows.entries()) {
    const name = tr.querySelector('.pname').value.trim();
    const count = Number(tr.querySelector('.pcount').value);
    if (!name) continue;
    if (!Number.isInteger(count) || count < 1) { alert(`${i + 1} 行目の問題数が正しくありません。`); return; }
    if (parts.some(p => p.name === name)) { alert(`パート名「${name}」が重複しています。`); return; }
    parts.push({ name, count });
  }
  if (!parts.length) { alert('パートと問題数を入力してください。'); return; }
  const mode = $('#modeSelect').value;
  mutate(d => { d.settings = { parts, mode }; }, 'settings: 出題設定を変更');
  toast('設定を保存しました（次の新規セッションから反映）');
}

// ---------------------------------------------------------------- 描画
function render() {
  if (!data) return;
  renderMain(); renderDone(); renderLog(); renderSettings();
}

function renderMain() {
  const s = activeSession();
  const btn = $('#btnDone');
  if (!s) {
    $('#currentQ').textContent = '「新規セッション開始」を押してください';
    $('#sessionInfo').textContent = ''; $('#progressText').textContent = '';
    $('#progressBar').style.width = '0'; btn.disabled = true; return;
  }
  const idx = currentIndex(s);
  const done = s.items.filter(i => i.done).length, total = s.items.length;
  $('#currentQ').textContent = idx < 0 ? '★ セッション完了！おつかれさまでした ★' : `${s.items[idx].part} － 第${s.items[idx].q}問`;
  $('#currentQ').classList.toggle('complete', idx < 0);
  $('#sessionInfo').textContent = `セッション ${sessionLabel(s)}`;
  $('#progressText').textContent = `${done} / ${total} 問 完了`;
  $('#progressBar').style.width = (total ? done / total * 100 : 0) + '%';
  btn.disabled = idx < 0;
}

function renderDone() {
  const set = doneSet();
  const s = activeSession();
  const inSess = new Set(s ? s.items.filter(i => i.done && !i.external).map(i => key(i.part, i.q)) : []);
  $('#doneGrid').innerHTML = data.settings.parts.map(p => {
    let cells = '';
    for (let q = 1; q <= p.count; q++) {
      const k = key(p.name, q);
      const cls = set.has(k) ? 'on' : inSess.has(k) ? 'sess' : '';
      const title = set.has(k) ? 'やった登録済み（クリックで解除）' : inSess.has(k) ? '現在のセッションで実施済み' : 'クリックでやった登録';
      cells += `<button class="qcell ${cls}" data-part="${esc(p.name)}" data-q="${q}" title="${title}">${q}</button>`;
    }
    const n = [...set].filter(k => k.startsWith(p.name + '#')).length;
    return `<div class="part-row"><div class="part-name">${esc(p.name)} <span class="muted">${n}/${p.count}</span></div><div class="cells">${cells}</div></div>`;
  }).join('') + `<p class="muted legend"><span class="qcell on"></span>やった登録済み <span class="qcell sess"></span>現在のセッションで実施済み</p>`;
  $('#btnClearDone').disabled = !data.done.length;
}

function sessionLabel(s) { return s.title ? `${s.title}（${s.id}）` : s.id; }

function renameSession(id) {
  const s = data.sessions.find(x => x.id === id); if (!s) return;
  const title = prompt('セッションの名前（空欄で名前なし）', s.title || '');
  if (title === null) return;
  const t = title.trim();
  mutate(d => {
    const ss = d.sessions.find(x => x.id === id); if (!ss) return;
    if (t) ss.title = t; else delete ss.title;
  }, `session: ${id} の名前を「${t || 'なし'}」に変更`);
}

function deleteSession(id) {
  const s = data.sessions.find(x => x.id === id); if (!s) return;
  const done = s.items.filter(i => i.done).length;
  if (!confirm(`セッション「${sessionLabel(s)}」を削除します。\n（${done} / ${s.items.length} 問の記録も消えます）\n\nこの操作は元に戻せません。よろしいですか？`)) return;
  mutate(d => {
    d.sessions = d.sessions.filter(x => x.id !== id);
    if (d.activeSession === id) d.activeSession = '';
  }, `session: ${id} を削除`);
  toast('セッションを削除しました');
}

function renderLog() {
  const sessions = [...data.sessions].reverse();
  const open = new Set([...document.querySelectorAll('#logList details[open]')].map(e => e.dataset.id));
  $('#logList').innerHTML = sessions.map(s => {
    const done = s.items.filter(i => i.done).length, total = s.items.length;
    const ext = s.items.filter(i => i.external).length;
    const dates = s.items.filter(i => i.date).map(i => i.date).sort();
    const range = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} 〜 ${dates[dates.length - 1]}`) : '未着手';
    const active = s.id === data.activeSession;
    const rows = s.items.map(i => `<tr class="${i.done ? '' : 'todo'}"><td>${i.seq}</td><td>${esc(i.part)}</td><td>第${i.q}問</td><td>${i.done ? (i.external ? 'やった（アプリ外）' : 'やった') : '—'}</td><td>${i.date || ''}</td></tr>`).join('');
    return `<details class="card" data-id="${esc(s.id)}"${open.has(s.id) ? ' open' : ''}>
      <summary><b>${esc(s.title || s.id)}</b> ${active ? '<span class="badge">進行中</span>' : ''} ${done >= total ? '<span class="badge done">完了</span>' : ''}
        <span class="muted">${s.title ? esc(s.id) + ' ・ ' : ''}${done} / ${total} 問${ext ? `（うちアプリ外 ${ext}）` : ''} ・ ${range}</span></summary>
      <div class="row">
        ${!active && done < total ? `<button class="resume" data-id="${esc(s.id)}">このセッションを再開</button>` : ''}
        <button class="rename" data-id="${esc(s.id)}">名前を付ける</button>
        <button class="delete danger" data-id="${esc(s.id)}">削除</button>
      </div>
      <table class="items"><thead><tr><th>#</th><th>パート</th><th>問題</th><th>状態</th><th>日付</th></tr></thead><tbody>${rows}</tbody></table>
    </details>`;
  }).join('') || '<p class="muted">まだ記録がありません。</p>';
}

function renderSettings() {
  const tb = $('#partsTable tbody');
  if (document.activeElement && tb.contains(document.activeElement)) return;  // 入力中は描き直さない
  tb.innerHTML = data.settings.parts.map(partRow).join('');
  $('#modeSelect').value = data.settings.mode;
  $('#repoInput').value = cfg.repo || '';
  $('#branchInput').value = cfg.branch || 'main';
  $('#tokenInput').value = cfg.token ? '••••••••' : '';
}
function partRow(p) {
  return `<tr><td><input class="pname" value="${esc(p.name)}"></td><td><input class="pcount" type="number" min="1" value="${p.count}"></td><td><button class="del" title="削除">×</button></td></tr>`;
}

function renderResumeList() {
  const box = $('#resumeList');
  const list = data.sessions.map(s => ({ id: s.id, label: sessionLabel(s), remain: s.items.filter(i => !i.done).length })).filter(x => x.remain > 0);
  if (!list.length) { box.classList.add('hidden'); toast('再開できる未完了セッションはありません'); return; }
  box.innerHTML = '<h2>再開するセッション</h2>' + list.reverse().map(x =>
    `<button class="resume" data-id="${esc(x.id)}">${esc(x.label)}（残り ${x.remain} 問）${x.id === data.activeSession ? ' ← 現在' : ''}</button>`).join('');
  box.classList.remove('hidden');
}

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
}

// ---------------------------------------------------------------- イベント
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#btnDone').addEventListener('click', markDone);
$('#btnUndo').addEventListener('click', undoLast);
$('#btnNew').addEventListener('click', newSession);
$('#btnResume').addEventListener('click', renderResumeList);
$('#btnClearDone').addEventListener('click', clearDone);
$('#btnSaveSettings').addEventListener('click', saveSettings);
$('#btnAddPart').addEventListener('click', () => $('#partsTable tbody').insertAdjacentHTML('beforeend', partRow({ name: '', count: 1 })));
$('#partsTable').addEventListener('click', e => { if (e.target.classList.contains('del')) e.target.closest('tr').remove(); });
$('#doneGrid').addEventListener('click', e => {
  const b = e.target.closest('.qcell[data-part]'); if (b) toggleExternal(b.dataset.part, Number(b.dataset.q));
});
document.addEventListener('click', e => {
  const b = e.target.closest('button.resume, button.rename, button.delete'); if (!b) return;
  if (b.classList.contains('resume')) resumeSession(b.dataset.id);
  else if (b.classList.contains('rename')) renameSession(b.dataset.id);
  else deleteSession(b.dataset.id);
});
$('#btnSaveGh').addEventListener('click', () => {
  const repo = $('#repoInput').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  const tok = $('#tokenInput').value.trim();
  cfg = { repo, branch: $('#branchInput').value.trim() || 'main', token: tok === '••••••••' ? cfg.token : tok };
  lsSet(LS.cfg, JSON.stringify(cfg));
  load();
});
$('#btnSync').addEventListener('click', syncNow);
$('#btnDownload').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([serialize(data)], { type: 'application/json' }));
  a.download = 'records.json'; a.click();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && $('#tab-main').classList.contains('active') && document.activeElement === document.body) markDone();
});

load();
