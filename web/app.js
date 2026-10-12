/**
 * dropsend 手机端。
 *
 * 几个关键设计，都是被真实使用场景逼出来的：
 *
 * 1. **分片位图存 IndexedDB**：iOS Safari 在锁屏/切后台时会掐断上传，
 *    而且页面可能被回收。把"哪些块已经传成功"持久化，回来才能接着传，
 *    而不是从 0 重来。
 * 2. **并发有上限并会退让**：一块一块传太慢，全并发又会把手机 WiFi 打爆；
 *    连续失败时自动降并发、降分片大小。
 * 3. **文件夹靠 webkitRelativePath**：浏览器只在选择文件夹时给出相对路径，
 *    拖拽时不给，所以拖拽进来的文件只能平铺——这点在界面上如实说明。
 * 4. **下载走分片拼装**：这样服务器能给出准确进度与校验，
 *    也能在失败时只重传缺的那几块。
 */

const API = {
  pairInfo: '/api/pair/info',
  session: '/api/session',
  events: '/api/events',
  status: '/api/system/status',
  transfers: '/api/transfers',
  commit: '/api/transfers/commit',
  push: '/api/push',
  clipboard: '/api/clipboard',
  clipboardPull: '/api/clipboard/pull',
  clipboardPublish: '/api/clipboard/publish',
};

const CHUNK_MIN = 512 * 1024;
const CHUNK_MAX = 8 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 3;
const DOWNLOAD_CONCURRENCY = 3;
const MAX_RETRY = 4;

// --- DOM -------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const dom = {
  gate: $('gate'),
  gateSub: $('gate-sub'),
  gateError: $('gate-error'),
  pairForm: $('pair-form'),
  pin: $('pin'),
  pairBtn: $('pair-btn'),
  pairHint: $('pair-hint'),
  retryPair: $('retry-pair'),
  app: $('app'),
  pcName: $('pc-name'),
  linkState: $('link-state'),
  linkDot: $('link-dot'),
  banner: $('banner'),
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  dirInput: $('dir-input'),
  cameraInput: $('camera-input'),
  pickFiles: $('pick-files'),
  pickDir: $('pick-dir'),
  pickCamera: $('pick-camera'),
  receiveList: $('receive-list'),
  receiveEmpty: $('receive-empty'),
  reloadReceive: $('reload-receive'),
  saveAll: $('save-all'),
  saveAllLabel: $('save-all-label'),
  textOut: $('text-out'),
  sendText: $('send-text'),
  pasteBtn: $('paste-btn'),
  pullPcClip: $('pull-pc-clip'),
  textList: $('text-list'),
  textEmpty: $('text-empty'),
  taskList: $('task-list'),
  taskEmpty: $('task-empty'),
  refreshBtn: $('refresh-btn'),
  unpair: $('unpair'),
  footerInfo: $('footer-info'),
  toast: $('toast'),
};

// --- 小工具 ----------------------------------------------------------------

function toast(message, ms = 2200) {
  dom.toast.textContent = message;
  dom.toast.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => dom.toast.classList.add('hidden'), ms);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function percent(done, total) {
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((done / total) * 100));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });

  let payload = null;
  const text = await response.text();
  if (text) { try { payload = JSON.parse(text); } catch { payload = { error: text }; } }

  if (!response.ok) {
    // 会话过期（默认 24 小时）或电脑重启后会话失效：直接回到配对界面，
    // 而不是让用户对着一个永远失败的界面点来点去。
    if (response.status === 401 && !path.startsWith(API.session) && !path.startsWith(API.pairInfo)) {
      handleSessionLost(payload?.error);
    }

    const error = new Error(payload?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload?.code;
    error.payload = payload;
    throw error;
  }
  return payload;
}

let sessionLostHandled = false;

/** 会话失效：停掉事件流、回到配对门，并说明原因。 */
function handleSessionLost(message) {
  if (sessionLostHandled) return;
  sessionLostHandled = true;

  state.paired = false;
  state.events?.close();
  state.events = null;

  dom.app.classList.add('hidden');
  dom.gate.classList.remove('hidden');
  dom.pairForm.classList.add('hidden');
  dom.retryPair.classList.remove('hidden');
  dom.gateSub.textContent = '与电脑的连接已失效';
  showGateError(
    `${message ?? '会话已过期'}。请在电脑上确认 dropsend 仍在运行，然后重新扫码或刷新本页。`,
  );
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- IndexedDB：断点续传的位图 ---------------------------------------------

const DB_NAME = 'dropsend';
const STORE = 'uploads';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* 隐私模式下 IndexedDB 可能不可用，退化为不续传 */ }
}

async function idbGet(key) {
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value;
  } catch { return undefined; }
}

async function idbDelete(key) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    db.close();
  } catch { /* 忽略 */ }
}

// --- 应用状态 --------------------------------------------------------------

const state = {
  paired: false,
  pcName: '电脑',
  pushTransfers: [],
  activeTasks: new Map(),
  events: null,
  clipboardEntries: [],
  banner: '',
};

// ===========================================================================
// 配对
// ===========================================================================

function tokenFromHash() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  return new URLSearchParams(hash).get('t') ?? '';
}

function showGateError(message) {
  dom.gateError.textContent = message;
  dom.gateError.classList.remove('hidden');
}

async function bootstrap() {
  const token = tokenFromHash();

  // 已经有会话就直接进主界面。
  try {
    await api(API.status);
    enterApp();
    return;
  } catch { /* 需要配对 */ }

  let info;
  try {
    info = await api(API.pairInfo);
  } catch (error) {
    dom.gateSub.textContent = '无法连接电脑';
    showGateError(`请确认电脑上的 dropsend 仍在运行，且手机与电脑在同一 WiFi。（${error.message}）`);
    dom.retryPair.classList.remove('hidden');
    return;
  }

  if (!info.active) {
    dom.gateSub.textContent = '电脑上的配对窗口已关闭';
    showGateError('请在电脑上重新执行 drop serve（或按 R 刷新配对），然后重新扫码。');
    dom.retryPair.classList.remove('hidden');
    return;
  }

  if (!token) {
    dom.gateSub.textContent = '请输入电脑上显示的 PIN';
    dom.pairHint.textContent = '没有扫码？直接用浏览器访问电脑显示的地址即可。';
  } else {
    dom.gateSub.textContent = '扫描成功，请输入电脑上显示的 PIN';
  }

  dom.pairForm.classList.remove('hidden');
  dom.pin.focus();

  dom.pairForm.onsubmit = async (event) => {
    event.preventDefault();
    const pin = dom.pin.value.trim();
    if (pin.length < 4) { showGateError('请输入完整的 PIN'); return; }

    dom.pairBtn.disabled = true;
    dom.pairBtn.textContent = '连接中…';
    try {
      await api(API.session, { method: 'POST', body: JSON.stringify({ pin, token }) });
      // 配对成功后清掉地址栏里的令牌，避免留在浏览器历史里。
      history.replaceState(null, '', location.pathname);
      dom.gateError.classList.add('hidden');
      enterApp();
    } catch (error) {
      showGateError(error.message);
      dom.pin.value = '';
      dom.pin.focus();
    } finally {
      dom.pairBtn.disabled = false;
      dom.pairBtn.textContent = '连接电脑';
    }
  };
}

function enterApp() {
  state.paired = true;
  dom.gate.classList.add('hidden');
  dom.app.classList.remove('hidden');
  setLink(true, '已连接');
  startEvents();
  void refreshAll();
}

function setLink(online, text) {
  dom.linkDot.className = `dot ${online ? 'online' : 'offline'}`;
  dom.linkState.textContent = text;
}

async function refreshAll() {
  await Promise.all([loadStatus(), loadPushTransfers(), loadClipboard()]);
}

async function loadStatus() {
  try {
    const status = await api(API.status);
    state.pcName = status.hostName || '电脑';
    dom.pcName.textContent = state.pcName;
    dom.footerInfo.textContent = `${status.hostName} · 接收目录 ${status.recvDir}`;
    setLink(true, status.connectedDevices > 0 ? '已连接' : '已连接');
    if (!status.clipboardSync) setBanner('电脑端未开启剪贴板同步：文本会保存在网页里，但不会自动写入电脑剪贴板。');
    else setBanner('');
  } catch (error) {
    if (error.status === 401) { location.reload(); return; }
    setLink(false, '连接中断');
  }
}

function setBanner(message) {
  if (!message) { dom.banner.classList.add('hidden'); return; }
  dom.banner.textContent = message;
  dom.banner.classList.remove('hidden');
}

// ===========================================================================
// SSE：实时进度
// ===========================================================================

function startEvents() {
  if (state.events) state.events.close();
  const source = new EventSource(API.events);
  state.events = source;

  source.addEventListener('open', () => setLink(true, '已连接'));
  source.addEventListener('error', () => setLink(false, '重连中…'));

  source.addEventListener('progress', (event) => {
    const data = JSON.parse(event.data);
    applyProgress(data);
  });

  source.addEventListener('transfer.updated', (event) => {
    const data = JSON.parse(event.data);
    upsertTaskRow(data.transfer);
  });

  source.addEventListener('push.created', () => { void loadPushTransfers(); });
  source.addEventListener('push.completed', (event) => {
    const data = JSON.parse(event.data);
    toast(`手机已收完：${data.name}`);
    void loadPushTransfers();
  });
  source.addEventListener('transfer.completed', (event) => {
    const data = JSON.parse(event.data);
    toast(`电脑已收到：${data.name}`);
  });
  source.addEventListener('clipboard.created', (event) => {
    const data = JSON.parse(event.data);
    if (data.entry?.direction === 'to-phone') {
      state.clipboardEntries.unshift(data.entry);
      renderClipboard();
      toast('收到电脑发来的文本');
      void tryAutoCopy(data.entry.text);
    }
  });
  source.addEventListener('resync', () => { void refreshAll(); });
  source.addEventListener('session.opened', () => { void loadStatus(); });
}

async function tryAutoCopy(text) {
  // 自动写剪贴板在 iOS 上通常被拒（非用户手势），失败就只提示。
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到手机剪贴板');
  } catch {
    toast('收到新文本，点“复制”即可');
  }
}

// ===========================================================================
// 上传：手机 -> 电脑
// ===========================================================================

function chooseChunkSize(size) {
  if (size <= 8 * 1024 * 1024) return CHUNK_MIN;
  if (size <= 128 * 1024 * 1024) return 2 * 1024 * 1024;
  return CHUNK_MAX;
}

/** 从 File 列表构造清单；文件夹会带上相对路径。 */
function buildManifest(files) {
  const list = [];
  const emptyDirs = new Set();

  for (const file of files) {
    const relative = file.webkitRelativePath || file.relativePath || '';
    const relPath = relative || file.name;

    list.push({ file, relPath, size: file.size });

    // 记录中间目录，服务器需要它们来还原空文件夹。
    if (relative.includes('/')) {
      const parts = relative.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        emptyDirs.add(parts.slice(0, i).join('/'));
      }
    }
  }

  const origin = files.some((f) => (f.webkitRelativePath || '').includes('/')) ? 'folder' : (files.length > 1 ? 'files' : 'file');
  let folderName = '';
  if (origin === 'folder') {
    const first = files.find((f) => (f.webkitRelativePath || '').includes('/'));
    folderName = (first?.webkitRelativePath || '').split('/')[0] ?? 'folder';
  }

  return { list, origin, folderName, emptyDirs: [...emptyDirs] };
}

async function uploadFiles(files) {
  if (!files || files.length === 0) return;

  const { list, origin, folderName, emptyDirs } = buildManifest(files);
  const totalBytes = list.reduce((sum, item) => sum + item.size, 0);
  const displayName = origin === 'folder' ? folderName : (list.length === 1 ? list[0].file.name : `${list.length} 个文件`);

  const taskId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const task = {
    id: taskId,
    direction: 'upload',
    name: displayName,
    totalBytes,
    doneBytes: 0,
    status: 'active',
    error: '',
  };
  state.activeTasks.set(taskId, task);
  renderTasks();

  try {
    // 先探测是否有可续传的同名任务（同一批次、同样的文件清单）。
    const fingerprint = `${origin}:${folderName}:${list.map((i) => `${i.relPath}:${i.size}`).join('|')}`;
    const saved = await idbGet(fingerprint);

    let created;
    if (saved?.transferId) {
      try {
        const existing = await api(`${API.transfers}/${saved.transferId}`);
        if (existing.transfer?.status === 'active') {
          created = { transferId: saved.transferId, files: existing.received.map((p, index) => ({
            ...p,
            index,
            relPath: existing.transfer.files[index]?.relPath ?? list[index]?.relPath,
            size: list[index]?.size ?? 0,
            chunkSize: 0,
            chunkCount: 0,
            received: p.received,
          })) };
          toast('发现未传完的任务，正在接着传…');
        }
      } catch { /* 续传失败就重开一个任务 */ }
    }

    if (!created) {
      created = await api(API.transfers, {
        method: 'POST',
        body: JSON.stringify({
          origin,
          folderName,
          emptyDirs,
          files: list.map((item) => ({
            relPath: item.relPath,
            size: item.size,
            chunkSize: chooseChunkSize(item.size),
          })),
        }),
      });
      await idbPut(fingerprint, { transferId: created.transferId, createdAt: Date.now() });
    }

    task.transferId = created.transferId;

    const layout = created.files ?? [];
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      const info = layout[index] ?? {};
      const chunkSize = info.chunkSize || chooseChunkSize(item.size);
      const chunkCount = info.chunkCount || Math.max(1, Math.ceil(item.size / chunkSize));
      const already = new Set(info.received ?? []);

      await uploadOneFile({
        transferId: created.transferId,
        partIndex: index,
        file: item.file,
        chunkSize,
        chunkCount,
        already,
        onProgress: (bytes) => {
          task.doneBytes += bytes;
          renderTasks();
        },
      });

      await api(API.commit, {
        method: 'POST',
        body: JSON.stringify({ transferId: created.transferId, partIndex: index }),
      });
    }

    const finished = await api(`${API.transfers}/${created.transferId}/complete`, { method: 'POST', body: '{}' });
    task.status = 'done';
    task.doneBytes = task.totalBytes;
    renderTasks();
    await idbDelete(fingerprint);
    toast(`已发送到电脑：${finished.transfer?.name ?? displayName}`);
    void loadStatus();
  } catch (error) {
    task.status = 'failed';
    task.error = error.message;
    renderTasks();
    toast(`发送失败：${error.message}`, 4000);
  }
}

async function uploadOneFile(options) {
  const { transferId, partIndex, file, chunkSize, chunkCount, already, onProgress } = options;

  const queue = [];
  for (let index = 0; index < chunkCount; index += 1) {
    if (!already.has(index)) queue.push(index);
  }
  if (queue.length === 0) return;

  let cursor = 0;
  let concurrency = UPLOAD_CONCURRENCY;
  let consecutiveFailures = 0;

  const worker = async () => {
    while (cursor < queue.length) {
      const myIndex = queue[cursor];
      cursor += 1;

      const start = myIndex * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const blob = file.slice(start, end);

      let attempt = 0;
      for (;;) {
        try {
          const response = await fetch(`/api/transfers/${transferId}/chunks/${myIndex}?part=${partIndex}`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob,
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error ?? `HTTP ${response.status}`);
          }
          const payload = await response.json();
          // 服务端说是重复块，说明之前已经传成功过，不重复计数。
          if (!payload.duplicate) onProgress(end - start);
          consecutiveFailures = 0;
          break;
        } catch (error) {
          attempt += 1;
          consecutiveFailures += 1;

          // 连续失败说明链路不稳：降低并发，避免越传越糟。
          if (consecutiveFailures >= 3 && concurrency > 1) {
            concurrency = Math.max(1, concurrency - 1);
          }
          if (attempt > MAX_RETRY) throw new Error(`分片 ${myIndex} 重试 ${MAX_RETRY} 次仍失败：${error.message}`);
          await sleep(Math.min(4000, 400 * 2 ** attempt));
        }
      }
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, queue.length); i += 1) workers.push(worker());
  await Promise.all(workers);
}

// ===========================================================================
// 下载：电脑 -> 手机
// ===========================================================================

async function loadPushTransfers() {
  try {
    const data = await api(API.transfers);
    state.pushTransfers = (data.transfers ?? []).filter((t) => t.kind === 'push');
    renderPushTransfers();
  } catch (error) {
    if (error.status !== 401) setLink(false, '连接中断');
  }
}

function renderPushTransfers() {
  const items = state.pushTransfers.filter((t) => t.files?.length);
  dom.receiveEmpty.classList.toggle('hidden', items.length > 0);
  dom.receiveList.innerHTML = '';

  for (const transfer of items) {
    for (const file of transfer.files) {
      const li = document.createElement('li');

      // receivedChunks 是"已确认收到的分片数"，乘分片大小即为已收字节（末尾分片略小，忽略不计）。
      const confirmedBytes = Math.min(
        transfer.totalBytes,
        (transfer.receivedChunks ?? 0) * (transfer.chunkSize ?? CHUNK_MAX),
      );
      const done = transfer.status === 'done';
      const pct = done ? 100 : percent(confirmedBytes, transfer.totalBytes);

      li.innerHTML = `
        <div class="item-head">
          <span class="item-name">${escapeHtml(file.name)}</span>
          <span class="badge ${done ? 'done' : 'active'}">${done ? '已收完' : formatBytes(file.size)}</span>
        </div>
        <div class="progress ${done ? 'done' : ''}"><span style="width:${done ? 100 : pct}%"></span></div>
        <div class="item-actions">
          <button class="btn btn-primary" data-action="download">下载到手机</button>
          <a class="btn" href="${file.url}" download>直接保存</a>
        </div>
      `;

      li.querySelector('[data-action="download"]').onclick = (event) =>
        downloadFile(transfer, file, event.currentTarget);
      dom.receiveList.appendChild(li);
    }
  }
}

/**
 * 下载一个文件并按分片确认。
 *
 * @param button 单个文件的按钮；传 null 表示处于"全部下载"流程，
 *               此时不碰按钮文字，失败也不弹 toast（由调用方统一汇报）。
 */
async function downloadFile(transfer, file, button) {
  const chunkSize = transfer.chunkSize ?? CHUNK_MAX;
  const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));

  if (button) {
    button.disabled = true;
    button.textContent = '0%';
  }

  try {
    const buffer = new Uint8Array(file.size);
    let cursor = 0;
    let completed = 0;

    const worker = async () => {
      while (cursor < chunkCount) {
        const myIndex = cursor;
        cursor += 1;

        let attempt = 0;
        for (;;) {
          try {
            const response = await fetch(
              `/api/transfers/${transfer.id}/chunks/${myIndex}?file=${file.index}`,
              { credentials: 'same-origin' },
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const chunk = new Uint8Array(await response.arrayBuffer());

            const offset = myIndex * chunkSize;
            buffer.set(chunk, offset);

            // 明确确认：只有真的写进内存了才算"收到"。
            await api(`/api/push/${transfer.id}/chunks/${myIndex}/confirm?file=${file.index}`, {
              method: 'POST',
              body: JSON.stringify({ bytes: chunk.length }),
            });

            completed += 1;
            if (button) button.textContent = `${percent(completed * chunkSize, file.size)}%`;
            break;
          } catch (error) {
            attempt += 1;
            if (attempt > MAX_RETRY) throw new Error(`第 ${myIndex} 块下载失败：${error.message}`);
            await sleep(400 * 2 ** attempt);
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, chunkCount) }, () => worker()),
    );

    await saveToDevice(buffer, file.name);

    if (button) {
      button.textContent = '已保存';
      toast(`已保存：${file.name}`);
      void loadPushTransfers();
    }
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = '下载到手机';
      toast(`下载失败：${error.message}`, 4000);
    }
    throw error;
  }
}

/**
 * 全部下载：把当前所有未收完的推送文件依次拉下来。
 *
 * 存在的理由：电脑一次推 22 个文件时，一个个点"下载到手机"太折磨人。
 * 顺序下载而不是并发——手机同时弹几十个保存框会直接卡死，
 * 而且移动浏览器对并发下载本来就有严格限制。
 */
async function saveAll() {
  const pending = [];
  for (const transfer of state.pushTransfers) {
    if (transfer.status === 'done') continue;
    for (const file of transfer.files ?? []) pending.push({ transfer, file });
  }

  if (pending.length === 0) {
    toast('没有需要下载的文件');
    return;
  }

  const totalBytes = pending.reduce((sum, item) => sum + item.file.size, 0);

  // iOS 上每次保存都要用户确认，所以先问一次，免得点下去才发现要确认几十次。
  const go = window.confirm(
    `即将下载 ${pending.length} 个文件（共 ${formatBytes(totalBytes)}）。\n\n` +
      '期间请保持本页面在前台，不要锁屏或切换到别的应用，否则传输会中断。\n\n' +
      '手机上可能会为每个文件弹出一次保存确认，需要你依次确认。',
  );
  if (!go) return;

  dom.saveAll.disabled = true;
  const failures = [];
  let ok = 0;

  for (let index = 0; index < pending.length; index += 1) {
    const { transfer, file } = pending[index];
    dom.saveAllLabel.textContent = `下载中 ${index + 1}/${pending.length}`;

    try {
      await downloadFile(transfer, file, null);
      ok += 1;
    } catch {
      failures.push(file.name);
    }

    // 让出一次事件循环，保证按钮文字能刷新出来。
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  dom.saveAll.disabled = false;
  dom.saveAllLabel.textContent = '全部下载到手机';

  if (failures.length === 0) {
    toast(`已全部保存（${ok} 个文件）`);
  } else {
    toast(`${ok} 个成功，${failures.length} 个失败：${failures.slice(0, 3).join('、')}`, 6000);
  }
  void loadPushTransfers();
}

async function saveToDevice(bytes, fileName) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });

  // 支持 File System Access API 时直接落盘，能省一份内存。
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: fileName });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      // 其他错误退回 anchor 方案。
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ===========================================================================
// 文本互传
// ===========================================================================

async function sendTextToPc() {
  const text = dom.textOut.value;
  if (!text.trim()) { toast('请先输入文字'); return; }

  dom.sendText.disabled = true;
  try {
    const result = await api(API.clipboard, { method: 'POST', body: JSON.stringify({ text, direction: 'to-pc' }) });
    dom.textOut.value = '';
    toast(result.entry?.writtenToSystem ? '已发送，电脑上可直接粘贴' : '已发送到电脑（网页里可查看）');
  } catch (error) {
    toast(`发送失败：${error.message}`);
  } finally {
    dom.sendText.disabled = false;
  }
}

async function loadClipboard() {
  try {
    const data = await api(`${API.clipboard}?limit=30`);
    state.clipboardEntries = (data.entries ?? []).filter((e) => e.direction === 'to-phone');
    renderClipboard();
  } catch { /* 忽略：下次刷新会重试 */ }
}

function renderClipboard() {
  const items = state.clipboardEntries;
  dom.textEmpty.classList.toggle('hidden', items.length > 0);
  dom.textList.innerHTML = '';

  for (const entry of items) {
    const li = document.createElement('li');
    const preview = entry.text.length > 400 ? `${entry.text.slice(0, 400)}…` : entry.text;

    li.innerHTML = `
      <div class="item-head">
        <span class="item-meta">${new Date(entry.createdAt).toLocaleString()}</span>
        <button class="link-btn" data-action="copy">复制</button>
      </div>
      <pre class="text-content">${escapeHtml(preview)}</pre>
    `;

    li.querySelector('[data-action="copy"]').onclick = async () => {
      try {
        await navigator.clipboard.writeText(entry.text);
        toast('已复制');
      } catch {
        // 剪贴板 API 被拒时，把内容放回输入框让用户手动复制。
        dom.textOut.value = entry.text;
        dom.textOut.focus();
        toast('请长按输入框内容手动复制');
      }
    };

    dom.textList.appendChild(li);
  }
}

// ===========================================================================
// 任务列表
// ===========================================================================

function upsertTaskRow(transfer) {
  if (!transfer) return;
  // 服务器侧的任务也显示出来（例如电脑推送的进度）。
  const existing = state.activeTasks.get(transfer.id);
  const task = existing ?? {
    id: transfer.id,
    direction: 'server',
    name: transfer.name,
    totalBytes: transfer.totalBytes,
    doneBytes: transfer.doneBytes,
    status: transfer.status,
    error: transfer.error ?? '',
  };
  if (existing) {
    existing.status = transfer.status;
    existing.doneBytes = transfer.doneBytes;
    existing.totalBytes = transfer.totalBytes;
  }
  state.activeTasks.set(transfer.id, task);
  renderTasks();
}

function applyProgress(data) {
  const task = state.activeTasks.get(data.id) ?? {
    id: data.id,
    direction: data.kind === 'push' ? 'download' : 'upload',
    name: data.name,
    totalBytes: data.totalBytes,
    doneBytes: 0,
    status: 'active',
    error: '',
  };
  task.totalBytes = data.totalBytes;
  if (task.direction !== 'upload') task.doneBytes = data.doneBytes;
  state.activeTasks.set(data.id, task);
  renderTasks();
}

function renderTasks() {
  const tasks = [...state.activeTasks.values()];
  dom.taskEmpty.classList.toggle('hidden', tasks.length > 0);
  dom.taskList.innerHTML = '';

  for (const task of tasks) {
    const li = document.createElement('li');
    const pct = task.status === 'done' ? 100 : percent(task.doneBytes, task.totalBytes);
    const badgeClass = task.status === 'done' ? 'done' : task.status === 'failed' ? 'failed' : 'active';
    const label = { active: '传输中', done: '已完成', failed: '失败' }[task.status] ?? task.status;

    li.innerHTML = `
      <div class="item-head">
        <span class="item-name">${escapeHtml(task.name)}</span>
        <span class="badge ${badgeClass}">${label}</span>
      </div>
      <div class="progress ${task.status === 'done' ? 'done' : task.status === 'failed' ? 'failed' : ''}">
        <span style="width:${pct}%"></span>
      </div>
      <div class="item-meta">
        ${formatBytes(task.doneBytes)} / ${formatBytes(task.totalBytes)} · ${pct}%
        ${task.error ? ` · <span style="color:var(--danger)">${escapeHtml(task.error)}</span>` : ''}
      </div>
    `;
    dom.taskList.appendChild(li);
  }
}

// ===========================================================================
// 事件绑定与启动
// ===========================================================================

function bindUi() {
  dom.pickFiles.onclick = () => dom.fileInput.click();
  dom.pickDir.onclick = () => dom.dirInput.click();
  dom.pickCamera.onclick = () => dom.cameraInput.click();
  dom.dropzone.onclick = () => dom.fileInput.click();

  dom.fileInput.onchange = (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    void uploadFiles(files);
  };
  dom.dirInput.onchange = (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    void uploadFiles(files);
  };
  dom.cameraInput.onchange = (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    void uploadFiles(files);
  };

  // 拖拽：浏览器不给相对路径，所以只能平铺放入。
  for (const type of ['dragenter', 'dragover']) {
    dom.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dom.dropzone.classList.add('dragover');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dom.dropzone.addEventListener(type, () => dom.dropzone.classList.remove('dragover'));
  }
  dom.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) void uploadFiles(files);
  });

  dom.sendText.onclick = () => void sendTextToPc();

  dom.pasteBtn.onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      dom.textOut.value = text;
      toast('已读取手机剪贴板');
    } catch {
      toast('浏览器不允许读取剪贴板，请手动粘贴');
    }
  };

  dom.pullPcClip.onclick = async () => {
    dom.pullPcClip.disabled = true;
    try {
      const result = await api(API.clipboardPull);
      if (!result.text) { toast(result.error ?? '电脑剪贴板是空的'); return; }
      await api(API.clipboardPublish, { method: 'POST', body: JSON.stringify({ text: result.text }) });
      state.clipboardEntries.unshift({
        id: `local_${Date.now()}`,
        direction: 'to-phone',
        text: result.text,
        createdAt: Date.now(),
      });
      renderClipboard();
      toast('已取回电脑剪贴板');
    } catch (error) {
      toast(`读取失败：${error.message}`);
    } finally {
      dom.pullPcClip.disabled = false;
    }
  };

  dom.reloadReceive.onclick = () => void loadPushTransfers();
  dom.saveAll.onclick = () => void saveAll();
  dom.refreshBtn.onclick = () => { void refreshAll(); toast('已刷新'); };

  dom.unpair.onclick = async () => {
    try { await api(API.session, { method: 'DELETE' }); } catch { /* 忽略 */ }
    location.reload();
  };

  dom.retryPair.onclick = () => location.reload();

  // 回到前台时补一次状态，并重新连 SSE（手机切后台常会断）。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.paired) return;
    void refreshAll();
    if (!state.events || state.events.readyState === EventSource.CLOSED) startEvents();
  });
}

bindUi();
void bootstrap();
