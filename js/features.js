// features.js —— 二维码 / 扫码 / 屏幕共享 / 剪贴板同步 / 聊天容量 / 复制提示
logT('屏幕共享', '[features.js] 已加载 v=76', 'info'); // 自证：日志首行显示此版本，说明手机跑的是新版；若看不到这行=旧缓存

// ---------- 二维码（自动分块） ----------
const CHUNK_MAGIC = '~BS1~';   // 分块二维码魔标，区别于完整单张载荷
const CHUNK_MAX = 500;         // 每张二维码最多约 500 字节，密度低、手机相机 0.x 秒可识别

function renderQR(container, text, cellSize) {
  cellSize = cellSize || 4;
  try {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    // 用 createImgTag 输出 GIF <img> 而非内联 SVG：
    // 移动端 Safari 对“无 width/height 属性的内联 SVG + height:auto”会塌成 0 高度（整片黑），
    // <img> 在所有浏览器尺寸行为一致，彻底规避该问题。
    container.innerHTML = qr.createImgTag(cellSize, 4);
  } catch (e) {
    container.innerHTML = '<p style="color:#f87272;font-size:12px;max-width:160px">内容过大无法生成二维码，请改用复制粘贴。</p>';
  }
}

// 按 UTF-8 字节安全切片，保证每张分块不超过 CHUNK_MAX 字节
function splitBytes(text, maxBytes) {
  const bytes = new TextEncoder().encode(text);
  const out = [];
  for (let i = 0; i < bytes.length; i += maxBytes) {
    out.push(new TextDecoder().decode(bytes.subarray(i, i + maxBytes)));
  }
  if (out.length === 0) out.push('');
  return out;
}

// 生成单张 GIF 数据 URL（用于同位置循环切换）
function qrDataURL(text, cellSize) {
  try {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(cellSize || 6, 4);
  } catch (e) { return null; }
}

let qrCycleTimer = null;
// 全屏展示二维码：载荷小则单张；大则拆成多张小二维码，在同一位置用 GIF 循环自动切换。
// targetChunks 指定时（如建立连接的二维码固定拆 4 块），按字节均分成该数量的块，每块更小、更易扫。
function showQRFullscreen(text, targetChunks) {
  if (!text) return;
  if (qrCycleTimer) { clearInterval(qrCycleTimer); qrCycleTimer = null; }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes <= CHUNK_MAX && !targetChunks) {
    qrFullscreenInner.innerHTML = '';
    renderQR(qrFullscreenInner, text, 8);
    qrFullscreen.classList.remove('hidden');
    return;
  }
  const k = Math.random().toString(36).slice(2, 8);
  let parts, n;
  if (targetChunks && targetChunks > 1) {
    // 固定切成 targetChunks 块（按字节均分），每块更小、更易扫
    const per = Math.max(1, Math.ceil(bytes / targetChunks));
    parts = splitBytes(text, per);
  } else {
    parts = splitBytes(text, CHUNK_MAX);
  }
  n = parts.length;
  const envs = parts.map((d, i) => CHUNK_MAGIC + JSON.stringify({ k, i, n, d }));
  const urls = envs.map((e) => qrDataURL(e, 6)).filter(Boolean);
  if (urls.length === 0) {
    qrFullscreenInner.innerHTML = '<p style="color:#f87272;font-size:12px;max-width:160px">内容过大无法生成二维码，请改用复制粘贴。</p>';
    qrFullscreen.classList.remove('hidden');
    return;
  }
  qrFullscreenInner.innerHTML =
    '<p class="qr-multi-tip">载荷较大，已自动拆分为 ' + n + ' 张二维码，并在同一位置循环切换（约每帧 0.6s）。接收方相机保持开启对准即可，无需手动操作。</p>' +
    '<div class="qr-multi-box"><img id="qrCycleImg" alt="二维码"></div>' +
    '<div class="qr-multi-cap" id="qrCycleCap"></div>';
  const img = $('qrCycleImg');
  const cap = $('qrCycleCap');
  let idx = 0;
  const paint = () => { img.src = urls[idx]; cap.textContent = '第 ' + (idx + 1) + ' / ' + n + ' 张（自动切换）'; };
  paint();
  if (urls.length > 1) qrCycleTimer = setInterval(() => { idx = (idx + 1) % urls.length; paint(); }, 600);
  qrFullscreen.classList.remove('hidden');
}
function hideQRFullscreen() {
  if (qrCycleTimer) { clearInterval(qrCycleTimer); qrCycleTimer = null; }
  qrFullscreen.classList.add('hidden');
  qrFullscreenInner.innerHTML = '';
}

// ---------- 扫码（分块感知，自动连续扫描） ----------
let scanStream = null, scanRAF = null, scanActive = false, scanCb = null, scanChunks = null;
async function openScanner(cb) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    logT('二维码', '当前环境不支持摄像头（需 HTTPS/localhost 安全上下文），请改用粘贴。', 'warn');
    return;
  }
  scanCb = cb; scanActive = true;
  scanChunks = { k: null, n: 0, received: 0, parts: [] };
  if (scanStatus) scanStatus.textContent = '';
  scanModal.classList.remove('hidden');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    try { scanStream = await navigator.mediaDevices.getUserMedia({ video: true }); }
    catch (e2) { logT('二维码', '无法访问摄像头：' + e2.message, 'err'); closeScanner(); return; }
  }
  scanVideo.srcObject = scanStream;
  try { await scanVideo.play(); } catch (e) {}
  scanLoop();
}
async function preRequestCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    logT('二维码', '已获得摄像头权限（用于扫码，并帮助 WebRTC 在局域网暴露真实本地 IP）。', 'ok');
  } catch (e) {
    logT('二维码', '未授予摄像头权限：扫码时再申请，不影响文件传输与通话。', 'warn');
  }
}
function scanLoop() {
  if (!scanActive) return;
  if (scanVideo.readyState >= 2 && scanVideo.videoWidth) {
    const w = scanVideo.videoWidth, h = scanVideo.videoHeight;
    scanCanvas.width = w; scanCanvas.height = h;
    const ctx = scanCanvas.getContext('2d');
    ctx.drawImage(scanVideo, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const code = jsQR(img.data, w, h);
    if (code && code.data) {
      const val = code.data.trim();
      if (handleScanned(val)) return; // 已完成（已关闭并回调）
    }
  }
  scanRAF = requestAnimationFrame(scanLoop);
}
// 返回 true：本次扫码流程结束（已关闭相机并回调）；false：分块尚未集齐，相机保持开启继续扫描
function handleScanned(val) {
  if (val.startsWith(CHUNK_MAGIC)) {
    let obj;
    try { obj = JSON.parse(val.slice(CHUNK_MAGIC.length)); } catch (e) { return false; }
    const buf = scanChunks;
    if (buf.k === null) { buf.k = obj.k; buf.n = obj.n; }
    if (obj.k !== buf.k) return false; // 其它会话的分块，忽略
    if (buf.parts[obj.i] === undefined) { buf.parts[obj.i] = obj.d; buf.received++; }
    if (scanStatus) scanStatus.textContent = '已自动扫描 ' + buf.received + ' / ' + buf.n + ' 张，请继续对准下一张…';
    if (buf.received >= buf.n && buf.parts.every((p) => p !== undefined)) {
      const full = buf.parts.join('');
      closeScanner();
      scanCb(full);
      return true;
    }
    return false; // 集齐前不关相机，自动等待下一张
  }
  // 完整单张二维码
  closeScanner();
  scanCb(val);
  return true;
}
function closeScanner() {
  scanActive = false;
  if (scanRAF) cancelAnimationFrame(scanRAF);
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  scanModal.classList.add('hidden');
  scanVideo.srcObject = null;
}

// ---------- 复制提示 ----------
function copyText(text, okMsg) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => onCopied(okMsg)).catch(() => fallbackCopy(text, okMsg));
  } else fallbackCopy(text, okMsg);
}
function fallbackCopy(text, okMsg) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); onCopied(okMsg); } catch (e) { logT('复制', '复制失败，请手动复制。', 'warn'); }
  ta.remove();
}
function onCopied(okMsg) {
  toast('已复制');
  if (okMsg) logT('复制', okMsg, 'ok');
}

// ---------- 屏幕共享（带内重协商，复用已建立的 DataChannel） ----------
// 关键点：首次共享用 addTrack 触发一次重协商；之后复用同一 transceiver（replaceTrack），
// 不再新增 m 行、也不再重复重协商，可“暂停→恢复”且不会累积多条视频轨道。

// 记录用户设置的屏幕共享帧率/码率，作为下次默认值（localStorage 持久化）
const SCREEN_PROFILE_KEY = 'bsScreenProfile';
// 取“有效帧率”：选“自定义”时读 screenFpsCustom 输入框，否则读下拉值
function getScreenFps() {
  if (screenFps.value === 'custom') {
    const v = parseInt(screenFpsCustom.value, 10);
    return (isNaN(v) || v < 1) ? 10 : v;
  }
  const v = parseInt(screenFps.value, 10);
  return isNaN(v) ? 10 : v;
}
function saveScreenProfile() {
  try {
    const fps = getScreenFps();
    const kbps = parseInt(screenBitrate.value, 10);
    const mode = (screenMode && screenMode.value) ? screenMode.value : 'smooth';
    localStorage.setItem(SCREEN_PROFILE_KEY, JSON.stringify({
      fps: isNaN(fps) ? null : fps,
      kbps: isNaN(kbps) ? null : kbps,
      mode
    }));
  } catch (e) {}
}
function loadScreenProfile() {
  try {
    const raw = localStorage.getItem(SCREEN_PROFILE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p && typeof p.fps === 'number') {
      if (screenFps.querySelector('option[value="' + p.fps + '"]')) {
        screenFps.value = String(p.fps);
      } else {
        screenFps.value = 'custom';
        if (screenFpsCustom) { screenFpsCustom.value = String(p.fps); screenFpsCustom.classList.remove('hidden'); }
      }
    }
    if (p && typeof p.kbps === 'number') {
      screenBitrate.value = String(p.kbps);
    }
    if (p && p.mode && screenMode && screenMode.querySelector('option[value="' + p.mode + '"]')) {
      screenMode.value = p.mode;
    }
  } catch (e) {}
}
loadScreenProfile(); // 启动时恢复上次设置的默认值

// ---------- 屏幕共享自适应（ABR）：流畅优先 / 清晰度优先 ----------
// 状态保存在“发送端”。监看端检测到卡顿/恢复后，通过 DataChannel 下发 dir:down/up 指令。
let abrMode = 'smooth';          // 'smooth'(降码率优先) | 'clear'(降帧率优先)
let abrBaseBitrate = 1500, abrBaseFps = 10;
let abrDegrade = 1.0;       // 统一衰减系数：1.0(满档) → 0.95 → 0.90 → 0.85 → …（弱网降、恢复升）
const ABR_DEGRADE_STEP = 0.05, ABR_DEGRADE_MIN = 0.5, ABR_DEGRADE_MAX = 1.0;
let abrWatchScale = 1;  // 监看端屏幕更小 -> 降分辨率下发（>=1，即分辨率的“上限”基准）
let abrZoomBoost = 1;   // 监看端缩放 -> 提高下发分辨率，使放大区更清晰（>1）
let szLastWatchZoom = 1, szWatchRetryTimer = null, szWatchActive = false; // 断线缓存最新 zoom 并定时重试补发；仅在监看中才上报
let szLastAbrKey = ''; // 降频：屏幕自适应按内容去重，仅 fps/码率/分辨率/衰减真正变化才打
let _lastWatchKey = ''; // 防止监看端上报日志刷屏：仅在屏/缩放变化时打印
// Canvas 裁切（发送端按监看端放大的局部裁切传输）
let szAmSender = false;     // 本端是否正在作为发送端共享屏幕（仅此时才裁切，避免监看端误触发）
let szLastWatchCrop = null; // 最近一次监看端上报的裁切矩形（归一化）
let szCropCanvas = null, szCropCtx = null, szCropRaf = 0, szCropOn = false, szCropStream = null, szCropRect = null;
let szLastCropReqKey = ''; // 区域日志节流：仅区域变化时打四角坐标，避免平移中刷屏
function szIsCropEnabled() { return (typeof szCropEnabled !== 'undefined') ? !!szCropEnabled : false; }
// 通知监看端“我正在/已停止裁切”，让其切换显示（避免二次放大）
function szNotifyCrop(on) {
  try { if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'screen-crop', on: !!on })); } catch (e) {}
}
// 用 Canvas 仅裁切监看端放大的局部并替换发送轨道（更清晰、省带宽）；裁切矩形变化时逐帧重算
function szEnableCrop(rect) {
  if (!szAmSender || !screenLocal || !screenTransceiver) return;
  szCropRect = rect;
  if (!szCropCanvas) { szCropCanvas = document.createElement('canvas'); szCropCtx = szCropCanvas.getContext('2d', { alpha: false }); }
  if (!szCropOn) {
    szCropOn = true;
    const fps = Math.max(1, Math.min(30, getScreenFps()));
    const loop = () => {
      if (!szCropOn || !szCropRect) return;
      if (screenLocal.videoWidth) {
        const sw = screenLocal.videoWidth, sh = screenLocal.videoHeight;
        const sx = Math.min(sw - 1, Math.max(0, Math.floor(szCropRect.x * sw)));
        const sy = Math.min(sh - 1, Math.max(0, Math.floor(szCropRect.y * sh)));
        const cw = Math.min(sw - sx, Math.max(2, Math.floor(szCropRect.w * sw)));
        const ch = Math.min(sh - sy, Math.max(2, Math.floor(szCropRect.h * sh)));
        if (szCropCanvas.width !== cw || szCropCanvas.height !== ch) { szCropCanvas.width = cw; szCropCanvas.height = ch; }
        try { szCropCtx.drawImage(screenLocal, sx, sy, cw, ch, 0, 0, cw, ch); } catch (e) {}
      }
      szCropRaf = requestAnimationFrame(loop);
    };
    loop();
  }
  if (!szCropStream) {
    const fps = Math.max(1, Math.min(30, getScreenFps()));
    szCropStream = szCropCanvas.captureStream(fps);
    szCropStream.getVideoTracks()[0].addEventListener('ended', () => { szCropOn = false; });
    screenTransceiver.sender.replaceTrack(szCropStream.getVideoTracks()[0])
      .then(() => logT('Canvas裁切', '已启用 Canvas 裁切传输（局部=监看端放大区域）。', 'info'))
      .catch((e) => logT('Canvas裁切', 'Canvas 裁切替换轨道失败：' + e.message, 'warn'));
  }
  szNotifyCrop(true);
}
function szDisableCrop() {
  if (!szAmSender) return;
  szCropOn = false;
  if (szCropRaf) { cancelAnimationFrame(szCropRaf); szCropRaf = 0; }
  szCropRect = null;
  const restore = () => {
    if (szCropStream) { try { szCropStream.getTracks().forEach((t) => t.stop()); } catch (e) {} szCropStream = null; }
  };
  if (screenTransceiver && screenStream) {
    const orig = screenStream.getVideoTracks()[0];
    screenTransceiver.sender.replaceTrack(orig).then(restore).catch(restore);
  } else restore();
  szNotifyCrop(false);
}
// 依据发送端开关 + 最近裁切矩形，决定是否裁切
function szEvaluateCrop() {
  if (!szAmSender) return;
  if (szIsCropEnabled() && szLastWatchCrop && szLastWatchCrop.w > 0 && szLastWatchCrop.h > 0) szEnableCrop(szLastWatchCrop);
  else szDisableCrop();
}
// 接收侧（监看端）收到发送端“正在/已停止裁切”通知
function onScreenCrop(msg) { if (typeof szSetCropRx === 'function') szSetCropRx(!!(msg && msg.on)); }
// 由统一衰减系数 D 推算当前码率/帧率/分辨率缩放：applied = 上限 × D
function screenAbrCurrent() {
  const D = abrDegrade;
  let fps, bitrate;
  if (D >= ABR_DEGRADE_MAX) {
    // 满档：帧率/码率放开到用户设定上限，动态内容可跑满
    fps = abrBaseFps;
    bitrate = abrBaseBitrate;
  } else {
    // 降档：以“发送端实际达到”的值（szActual*）为上限锚点，再乘 D，
    // 这样即便画面静止、实际只有 10fps，弱网卡顿也会真正从 10 往下压（而非相对用户设定值空降）
    const ceilFps = szActualFps > 0 ? szActualFps : abrBaseFps;
    const ceilBit = szActualBitrate > 0 ? szActualBitrate : abrBaseBitrate;
    fps = ceilFps * D;
    bitrate = ceilBit * D;
  }
  bitrate = Math.max(300, Math.round(bitrate));
  fps = Math.max(5, Math.round(fps));
  // 分辨率：上限=基于监看端屏幕分辨率（abrWatchScale），再按 D 降：scaleResolutionDownBy = (1/D)·上限
  const resScale = 1 / D;
  return { bitrate, fps, resScale };
}
// 所有对 screenTransceiver.sender 的 setParameters 必须串行：同一 sender 并发 setParameters 会让 Chromium 的
// transaction 错乱（报 “getParameters() needs to be called before setParameters()”），且每次都必须重新 getParameters
// 取最新参数对象（复用已被消费的 transaction 对象也会失败）。统一经此队列串行化并每次刷新参数。
let szParamChain = Promise.resolve();
function szSetSenderParams(mutate) {
  const sender = screenTransceiver && screenTransceiver.sender;
  if (!sender) return Promise.resolve();
  const run = async () => {
    const p = sender.getParameters();
    if (!p.encodings) p.encodings = [{}];
    mutate(p);
    await sender.setParameters(p);
  };
  szParamChain = szParamChain.catch(() => {}).then(run); // 一次失败不影响后续排队
  return szParamChain;
}
async function applyScreenAbr() {
  if (!screenTransceiver || !screenTransceiver.sender) return;
  const cur = screenAbrCurrent();
  // 最终下发缩放 = (1/D) × 监看端分辨率缩放 ÷ 缩放放大系数（放大时更清晰，下限1即不超采集分辨率）
  let scale = cur.resScale * abrWatchScale / abrZoomBoost;
  scale = Math.max(1, Math.round(scale * 100) / 100);
  try {
    await szSetSenderParams(p => {
      p.encodings[0].maxBitrate = cur.bitrate * 1000;
      p.encodings[0].maxFramerate = cur.fps;
      p.encodings[0].scaleResolutionDownBy = scale;
    });
  } catch (e) { logT('ABR', 'ABR 应用失败：' + e.message, 'warn'); }
  const _abrKey = cur.fps + '/' + cur.bitrate + '/' + (1 / scale).toFixed(2) + '/' + abrDegrade.toFixed(2);
  if (_abrKey !== szLastAbrKey) { szLastAbrKey = _abrKey; logT('ABR', '屏幕自适应 → ' + cur.fps + 'fps / ' + cur.bitrate + 'kbps / 下发分辨率×' + (1 / scale).toFixed(2) +
    '（衰减×' + abrDegrade.toFixed(2) + (abrDegrade < ABR_DEGRADE_MAX ? '，弱网降档' : '，满档') + '）', 'info'); }
}
// 收到监看端上报的裁切矩形（其放大查看的局部）：发送端若已开启“Canvas 裁切”，则按此裁切传输，否则发送全屏。
// 由 onScreenWatchInfo 与 onScreenAbr 共用——监看端的 crop 经 screen-watch-info 上报，卡顿降档（screen-abr）也顺带刷新，故两处都应用。
function applyWatchCrop(msg) {
  if (msg && msg.crop) {
    szLastWatchCrop = msg.crop;
    const r = msg.crop;
    const key = r.x.toFixed(3) + ',' + r.y.toFixed(3) + ',' + r.w.toFixed(3) + ',' + r.h.toFixed(3);
    if (key !== szLastCropReqKey) { // 仅在区域变化时打，避免平移中刷屏
      szLastCropReqKey = key;
      const sw = (screenLocal && screenLocal.videoWidth) ? screenLocal.videoWidth : 0;
      const sh = (screenLocal && screenLocal.videoHeight) ? screenLocal.videoHeight : 0;
      const x1 = Math.round(r.x * sw), y1 = Math.round(r.y * sh);
      const x2 = Math.round((r.x + r.w) * sw), y2 = Math.round(r.y * sh);
      const x3 = Math.round(r.x * sw), y3 = Math.round((r.y + r.h) * sh);
      const x4 = Math.round((r.x + r.w) * sw), y4 = Math.round((r.y + r.h) * sh);
      logT('Canvas裁切', '监看端要求区域 源 ' + sw + '×' + sh +
        ' 归一(x,y,w,h)=' + r.x + ',' + r.y + ',' + r.w + ',' + r.h +
        ' | 左上(' + x1 + ',' + y1 + ') 右上(' + x2 + ',' + y2 + ') 左下(' + x3 + ',' + y3 + ') 右下(' + x4 + ',' + y4 + ')', 'info');
    }
  } else {
    szLastWatchCrop = null;
    if (szLastCropReqKey) { szLastCropReqKey = ''; logT('Canvas裁切', '监看端取消局部要求，恢复全屏传输。', 'info'); }
  }
  szEvaluateCrop();
}
// 收到监看端指令：卡顿降一档 / 恢复升一档（统一衰减系数 D）
function onScreenAbr(msg) {
  if (!screenTransceiver) return;
  if (msg.dir === 'down') {
    abrDegrade = Math.max(ABR_DEGRADE_MIN, abrDegrade - ABR_DEGRADE_STEP);
  } else {
    abrDegrade = Math.min(ABR_DEGRADE_MAX, abrDegrade + ABR_DEGRADE_STEP);
  }
  applyScreenAbr();
  // 注意：卡顿降档消息(screen-abr)只带 dir，不带 crop。裁切区域由 screen-watch-info 单独驱动，
  // 这里绝不能调用 applyWatchCrop，否则会把已生效的局部要求当成“无 crop”而取消（回归 bug）。
}
// 收到监看端屏幕分辨率/缩放：按监看端分辨率自适应下发，并按缩放提升清晰度
function onScreenWatchInfo(msg) {
  abrZoomBoost = (msg && msg.zoom > 0) ? msg.zoom : 1;
  abrWatchScale = 1;
  try {
    const t = screenTransceiver.sender.track;
    const s = t ? t.getSettings() : null;
    if (s && s.width && s.height && msg && msg.w && msg.h) {
      const ratio = Math.max(s.width / msg.w, s.height / msg.h); // 用 max 适配方向：保证两维都放得下，避免横屏方向锁后误降分辨率
      if (ratio > 1.05) abrWatchScale = ratio; // 监看屏更小 -> 降分辨率下发，省带宽
    }
  } catch (e) {}
  const key = (msg ? msg.w : 0) + 'x' + (msg ? msg.h : 0) + 'z' + Math.round(abrZoomBoost * 100);
  if (key !== _lastWatchKey) {
    _lastWatchKey = key;
    logT('监看', '监看端上报 屏=' + (msg ? msg.w : '?') + '×' + (msg ? msg.h : '?') + ' 缩放×' + abrZoomBoost.toFixed(2) +
      ' → 自适应基准 abrWatchScale=' + abrWatchScale.toFixed(2) + '（下发上限=' + (1 / abrWatchScale).toFixed(2) + '×源）', 'info');
  }
  applyScreenAbr();
  applyWatchCrop(msg); // 关键：监看端把裁切矩形放在 screen-watch-info 里上报，必须在这里应用（之前只在 screen-abr 里读，导致区域从未生效）
}

async function startScreenShare() {
  if (!pc || (pc.connectionState !== 'connected' && pc.connectionState !== 'connecting')) {
    logT('屏幕共享', '连接未建立，无法共享屏幕。', 'err'); return;
  }
  const fps = getScreenFps();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps } }, // 不写死宽高，按显示器原生分辨率采集（2K/4K 均可，由 ABR 按监看端屏幕/缩放再调整）
      audio: false
    });
  } catch (e) { logT('屏幕共享', '屏幕共享被取消或失败：' + e.message, 'warn'); return; }
  await beginScreenShare(stream);
}
// 用给定流开始/接续屏幕共享（手动点“开始共享”与“连接后自动共享”共用）
async function beginScreenShare(stream) {
  if (!pc || (pc.connectionState !== 'connected' && pc.connectionState !== 'connecting')) {
    logT('屏幕共享', '连接未建立，无法共享屏幕。', 'err'); return;
  }
  const fps = getScreenFps();
  const kbps = parseInt(screenBitrate.value, 10) || 1500;
  saveScreenProfile(); // 记录本次实际使用的帧率/码率/模式，作为下次默认
  // 初始化自适应基线（阶梯归零）
  abrMode = (screenMode && screenMode.value) ? screenMode.value : 'smooth';
  abrBaseFps = fps; abrBaseBitrate = kbps;
  abrDegrade = ABR_DEGRADE_MAX; // 满档（衰减系数=1.0），弱网降、恢复升
  abrWatchScale = 1; abrZoomBoost = 1;
  szAmSender = true; // 标记本端为发送端，仅此时才允许 Canvas 裁切
  const szCropR = document.getElementById('szCropRow'); if (szCropR) szCropR.classList.add('hidden'); // 开始共享后隐藏“Canvas 裁切”开关
  szLastWatchCrop = null; szDisableCrop(); // 复位裁切（尚未收到监看端放大指令，先按全屏）
  screenStream = stream;
  const track = stream.getVideoTracks()[0];
  if (screenTransceiver) {
    try { await screenTransceiver.sender.replaceTrack(track); } catch (e) { logT('屏幕共享', '接入屏幕轨道失败：' + e.message, 'err'); return; }
  } else {
    screenSender = pc.addTrack(track, stream);
    screenTransceiver = pc.getTransceivers().find((t) => t.sender === screenSender);
    await reneg(); // 仅首次需要重协商
  }
  await applyScreenAbr(); // 应用基线码率/帧率/分辨率（含监看端自适应）
  startScreenSendMonitor(); // 发送端统计：screenLocal 上方显示发出去的分辨率/码率/帧率
  screenStart.classList.add('hidden');
  screenStop.classList.remove('hidden');
  screenLocal.srcObject = stream;
  screenLocal.classList.remove('hidden');
  track.addEventListener('ended', () => stopScreenShare());
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'screen-start' }));
  logT('屏幕共享', '已开始屏幕共享（' + fps + 'fps / ' + kbps + 'kbps）。', 'ok');
}
// 身份页“先选好要共享的屏幕”：提前捕获并暂存，连接成功后自动 beginScreenShare
async function pickScreenBeforeConnect() {
  if (pendingScreenStream) {
    pendingScreenStream.getTracks().forEach((t) => t.stop());
    pendingScreenStream = null;
    preShareStatus.textContent = '';
    btnPreShare.textContent = '🖥️ 先选好要共享的屏幕（连接后自动共享）';
    logT('屏幕共享', '已取消预选屏幕。', 'info');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10 } }, audio: false // 同上，按原生分辨率采集，避免把源钉死在 1080p
    });
  } catch (e) { logT('屏幕共享', '屏幕预选被取消或失败：' + e.message, 'warn'); return; }
  pendingScreenStream = stream;
  const name = stream.getVideoTracks()[0].label || '屏幕';
  preShareStatus.textContent = '已选好：' + name + '，连接后将自动共享给对方。';
  btnPreShare.textContent = '✕ 取消预选屏幕（' + name + '）';
  logT('屏幕共享', '已预选共享屏幕：' + name + '（连接后自动开始）。', 'ok');
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (pendingScreenStream !== stream) return;
    pendingScreenStream = null;
    preShareStatus.textContent = '';
    btnPreShare.textContent = '🖥️ 先选好要共享的屏幕（连接后自动共享）';
    logT('屏幕共享', '预选的屏幕共享已停止（画面被关闭）。', 'info');
  });
}
async function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  if (screenTransceiver) { try { await screenTransceiver.sender.replaceTrack(null); } catch (e) {} }
  screenSender = null;
  szAmSender = false; // 退出发送端，禁止裁切
  szDisableCrop();    // 停止裁切循环并恢复（若仍被引用）
  const szCropR = document.getElementById('szCropRow'); if (szCropR) szCropR.classList.remove('hidden'); // 停止共享后恢复显示“Canvas 裁切”开关
  screenStart.classList.remove('hidden');
  screenStop.classList.add('hidden');
  screenLocal.classList.add('hidden'); screenLocal.srcObject = null;
  stopScreenSendMonitor(); // 停止发送端统计
  abrDegrade = ABR_DEGRADE_MAX; abrWatchScale = 1; abrZoomBoost = 1; // 复位为满档
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'screen-stop' }));
  logT('屏幕共享', '已停止屏幕共享（可再次开始，无需重新协商）。', 'info');
}
// 通过 DataChannel 在已连接的两端之间重新协商（无需再次带外交换）
async function reneg() {
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'sdp-offer', sdp: pc.localDescription.sdp }));
  } catch (e) { logT('屏幕共享', '屏幕共享重协商失败：' + e.message, 'err'); }
}
async function onSdpOffer(msg) {
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceComplete(pc);
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'sdp-answer', sdp: pc.localDescription.sdp }));
  } catch (e) { logT('屏幕共享', '处理屏幕协商失败：' + e.message, 'err'); }
}
async function onSdpAnswer(msg) {
  try { await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); }
  catch (e) { logT('屏幕共享', '屏幕协商应答失败：' + e.message, 'err'); }
}
// ---------- 监看端防休眠（Screen Wake Lock API） ----------
// 监看期间保持屏幕常亮，避免监控中被系统息屏。浏览器不支持时静默跳过（如 Firefox、非 HTTPS 环境）。
let screenWakeLock = null;
async function requestScreenWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    screenWakeLock = await navigator.wakeLock.request('screen');
    screenWakeLock.addEventListener('release', () => { screenWakeLock = null; }, { once: true });
    logT('屏幕共享', '已开启防休眠（屏幕常亮）。', 'info');
  } catch (e) { screenWakeLock = null; logT('屏幕共享', '防休眠请求失败：' + e.message, 'warn'); }
}
function releaseScreenWakeLock() {
  if (screenWakeLock) { try { screenWakeLock.release(); } catch (e) {} screenWakeLock = null; }
}
// 页面切回前台时重新申请：wake lock 在页面隐藏时会被浏览器自动释放
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !screenWatchWrap.classList.contains('hidden')) requestScreenWakeLock();
});
function onScreenStart() {
  goPage('page-screen');
  screenShareWrap.classList.add('hidden');
  screenWatchWrap.classList.remove('hidden');
  if (typeof szSetCropRx === 'function') szSetCropRx(false); // 进入监看先按全屏显示，待发送端裁切后再切 fit
  if (typeof szReset === 'function') szReset();
  if (typeof playWatchVideo === 'function') playWatchVideo(); // 面板可见后补播，避免隐藏态 play 被忽略
  szWatchActive = true; // 标记监看中，通道重开后自动补发 watch-info
  szStartQualityMonitor(); // 启动监看画质检测（花屏自愈）
  sendWatchInfo(); // 上报本机屏幕分辨率/缩放，发送端据此自适应下发分辨率
  requestScreenWakeLock(); // 监看期间保持屏幕常亮
  // 黑屏诊断：5s 后若仍无画面，给出提示（多为隐藏态 play 被忽略或协商未就绪）
  setTimeout(() => {
    if (screenWatchVideo.srcObject && screenWatchVideo.readyState < 2 && !screenWatchWrap.classList.contains('hidden')) {
      logT('屏幕共享', '监看画面仍未出帧，可尝试双击画面或重进全屏以触发播放。', 'warn');
    }
  }, 5000);
  screenStatus.textContent = '对方正在共享屏幕，等待画面…';
  toast('对方开始共享屏幕，已为你打开监看页');
  logT('屏幕共享', '对方开始共享屏幕，已为你打开监看页。', 'info');
}
// 监看端上报：本机屏幕分辨率 + 当前缩放。发送端据此降分辨率下发（省带宽）并按缩放提升清晰度。
function sendWatchInfo(zoom) {
  const z = (typeof zoom === 'number' && zoom > 0) ? zoom : ((typeof szScale === 'number' && szScale > 0) ? szScale : 1);
  szLastWatchZoom = z; // 缓存最新值，断线/未就绪时也保留，重连或重试时补发
  if (!szWatchActive) return; // 未进入监看会话（启动期/未连接/已退出）不上报，也不打 warn、不起重试定时器；进入会话后首报由 onScreenStart 触发
  try {
    if (!dc || dc.readyState !== 'open') { logT('监看', '上报跳过：dc 未就绪（state=' + (dc ? dc.readyState : 'null') + '），将重试', 'warn'); scheduleWatchRetry(); return; } // 断线不丢：缓存并定时补发
    // 上报本机显示器分辨率作为“可显示上限”：无论面板大小/全屏/横屏，都按显示器实际尺寸，
    // 不会因面板小就降分辨率；横屏方向锁后 window.screen 宽高互换由接收侧用 max 适配。
    const dpr = window.devicePixelRatio || 1; // 用物理像素，规避系统显示缩放（如 150% 缩放下 CSS 像素仅 1280，乘 DPR 才回到真实 1080p）
    logT('监看', '上报监看端 zoom=' + z.toFixed(2), 'info');
    // crop：监看端放大查看局部时，算出全屏源归一化矩形一并上报；发送端开启“Canvas 裁切”才会用，否则按全屏传。始终上报（不依赖本端复选框，裁切由发送端决定）。
    const crop = (typeof szGetCropRect === 'function') ? szGetCropRect() : null;
    if (!crop && z > 1) {
      logT('监看', '监看端裁切矩形为 null：szScale=' + z.toFixed(2) +
        ' videoW=' + (screenWatchVideo ? screenWatchVideo.videoWidth : '?') +
        ' videoH=' + (screenWatchVideo ? screenWatchVideo.videoHeight : '?') +
        ' stage=' + (screenWatchStage ? screenWatchStage.clientWidth : '?') + '×' + (screenWatchStage ? screenWatchStage.clientHeight : '?') +
        ' cropRx=' + szCropRxActive, 'warn');
    }
    const payload = { type: 'screen-watch-info', w: Math.round(window.screen.width * dpr), h: Math.round(window.screen.height * dpr), zoom: z };
    if (crop) payload.crop = crop;
    dc.send(JSON.stringify(payload));
    stopWatchRetry();
  } catch (e) { logT('监看', '上报异常：' + e.message, 'warn'); scheduleWatchRetry(); }
}
// dc 暂不可用时，每 500ms 重试补发最新 zoom（最多 ~20s），避免上报被断线吞掉
function scheduleWatchRetry() {
  if (szWatchRetryTimer) return;
  let attempt = 0;
  szWatchRetryTimer = setInterval(() => {
    attempt++;
    if (dc && dc.readyState === 'open') { stopWatchRetry(); sendWatchInfo(szLastWatchZoom); }
    else if (attempt >= 40) { stopWatchRetry(); logT('监看', '上报重试超时（dc 仍不可用），已放弃本次 zoom 上报。', 'warn'); }
  }, 500);
}
function stopWatchRetry() { if (szWatchRetryTimer) { clearInterval(szWatchRetryTimer); szWatchRetryTimer = null; } }
function onScreenStop() {
  szWatchActive = false; stopWatchRetry(); // 退出监看，停止上报重试
  szStopQualityMonitor(); // 停止画质检测
  if (typeof szSetCropRx === 'function') szSetCropRx(false); // 恢复全屏显示
  screenWatchWrap.classList.add('hidden');
  // 对方停止共享后，恢复本端“开始共享”入口（onScreenStart 曾为“观看时不可分享”而隐藏它）
  if (!screenStream) screenShareWrap.classList.remove('hidden');
  // 若监看页正处于全屏，对方结束共享后自动退出全屏
  if (typeof exitScreenFs === 'function') exitScreenFs();
  if (typeof szReset === 'function') szReset();
  try { screenWatchVideo.pause(); } catch (e) {} // 停止解码，节省资源
  releaseScreenWakeLock(); // 结束监看，解除防休眠
  screenStatus.textContent = '对方已停止共享。'; if (screenStats) screenStats.textContent = '';
  logT('监看', '对方停止了屏幕共享。', 'info');
}

// ---------- 发送端统计：screenLocal 上方显示“发出去”的分辨率/码率/帧率 ----------
let szSendTimer = null, szSendBase = false, szSendLastBytes = 0, szSendLastEncoded = 0, szSendLastTs = 0;
let szActualFps = 0, szActualBitrate = 0; // 发送端实际达到的帧率/码率（供 ABR 以实际为基准降档）
function startScreenSendMonitor() {
  stopScreenSendMonitor();
  szSendBase = false; szSendLastBytes = 0; szSendLastEncoded = 0; szSendLastTs = 0;
  szSendTimer = setInterval(szSendTick, 1000);
}
function stopScreenSendMonitor() {
  if (szSendTimer) { clearInterval(szSendTimer); szSendTimer = null; }
  if (screenSendStats) screenSendStats.textContent = '';
}
async function szSendTick() {
  if (!pc || pc.connectionState !== 'connected') return;
  if (!screenTransceiver || !screenTransceiver.sender) return;
  let stats; try { stats = await pc.getStats(); } catch (e) { return; }
  let bytes = 0, encoded = 0, fw = 0, fh = 0, fps = 0, found = false;
  stats.forEach((r) => {
    if (r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
      found = true;
      if (typeof r.bytesSent === 'number') bytes += r.bytesSent;
      if (typeof r.framesEncoded === 'number') encoded += r.framesEncoded;
      if (typeof r.frameWidth === 'number') fw = r.frameWidth;   // 实际编码(已降采样)分辨率
      if (typeof r.frameHeight === 'number') fh = r.frameHeight;
      if (typeof r.framesPerSecond === 'number') fps = r.framesPerSecond;
    }
  });
  if (!found) return;
  if (!fw && screenLocal.videoWidth) fw = screenLocal.videoWidth;
  if (!fh && screenLocal.videoHeight) fh = screenLocal.videoHeight;
  const now = Date.now();
  if (!szSendBase) { szSendBase = true; szSendLastBytes = bytes; szSendLastEncoded = encoded; szSendLastTs = now; return; }
  const dt = (now - szSendLastTs) / 1000;
  const bitrateKbps = (dt > 0) ? ((bytes - szSendLastBytes) * 8) / dt / 1000 : 0;
  const fpsCalc = (dt > 0) ? (encoded - szSendLastEncoded) / dt : 0;
  szSendLastBytes = bytes; szSendLastEncoded = encoded; szSendLastTs = now;
  szActualFps = (fps || fpsCalc);      // 记录“发出去”的实际帧率（供 ABR 降档基准）
  szActualBitrate = bitrateKbps;        // 记录“发出去”的实际码率（供 ABR 降档基准）
  const cap = screenAbrCurrent();       // 编码器当前天花板（弱网降档后会低于用户设定）
  const mw = screenLocal.videoWidth, mh = screenLocal.videoHeight; // 采集源原生分辨率 = 可下发最大分辨率
  let txt = '上限 ';
  if (mw && mh) txt += mw + '×' + mh + ' · ';
  txt += cap.fps + 'fps · ' + Math.round(cap.bitrate) + 'kbps ｜ 发送：';
  if (fw && fh) txt += fw + '×' + fh + ' · ';
  txt += Math.round(bitrateKbps) + ' kbps · ' + Math.round(fps || fpsCalc) + ' fps';
  if (screenSendStats) screenSendStats.textContent = txt;
}

// ---------- 监看画质检测与花屏自愈 ----------
// 接收端周期性拉取 WebRTC 入站统计：framesCorrupted（Chrome 直报损坏帧）、packetsLost（丢包）、
// framesDecoded（出帧是否停滞）。发现损坏帧/丢包突增/出帧停滞即判定“花屏/卡死”，通过 DataChannel
// 让发送端重发关键帧（IDR）——这是 WebRTC 层面唯一能真正修复解码花屏的手段。
let szMonitorTimer = null, szBaseReady = false, szLastCorrupt = 0, szLastLost = 0, szLastDecoded = 0, szLastReqAt = 0;
let szLastBytes = 0, szLastRecv = 0, szLastTs = 0;
let szGoodStreak = 0, szLastUpAt = 0;
function szStartQualityMonitor() {
  szStopQualityMonitor();
  szBaseReady = false; szLastCorrupt = 0; szLastLost = 0; szLastDecoded = 0; szGoodStreak = 0;
  szLastBytes = 0; szLastRecv = 0; szLastTs = 0;
  szMonitorTimer = setInterval(szQualityTick, 1000);
}
function szStopQualityMonitor() { if (szMonitorTimer) { clearInterval(szMonitorTimer); szMonitorTimer = null; } }
async function szQualityTick() {
  if (!pc || pc.connectionState !== 'connected') return;
  let stats; try { stats = await pc.getStats(); } catch (e) { return; }
  const now = Date.now();
  let corrupt = 0, lost = 0, decoded = 0, found = false;
  let bytes = 0, recv = 0, fw = 0, fh = 0, fps = 0, rttMs = null;
  stats.forEach((r) => {
    if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
      found = true;
      if (typeof r.framesCorrupted === 'number') corrupt += r.framesCorrupted;
      if (typeof r.packetsLost === 'number') lost += r.packetsLost;
      if (typeof r.framesDecoded === 'number') decoded += r.framesDecoded;
      if (typeof r.bytesReceived === 'number') bytes += r.bytesReceived;
      if (typeof r.packetsReceived === 'number') recv += r.packetsReceived;
      if (typeof r.frameWidth === 'number') fw = r.frameWidth;
      if (typeof r.frameHeight === 'number') fh = r.frameHeight;
      if (typeof r.framesPerSecond === 'number') fps = r.framesPerSecond;
    } else if (r.type === 'remote-inbound-rtp') {
      if (typeof r.roundTripTime === 'number' && rttMs === null) rttMs = r.roundTripTime * 1000;
    } else if (r.type === 'candidate-pair' && (r.state === 'succeeded' || r.nominated) && typeof r.currentRoundTripTime === 'number') {
      if (rttMs === null) rttMs = r.currentRoundTripTime * 1000;
    }
  });
  if (!found) return;
  if (!fw && screenWatchVideo.videoWidth) fw = screenWatchVideo.videoWidth;
  if (!fh && screenWatchVideo.videoHeight) fh = screenWatchVideo.videoHeight;
  if (!szBaseReady) {
    szBaseReady = true; szLastCorrupt = corrupt; szLastLost = lost; szLastDecoded = decoded;
    szLastBytes = bytes; szLastRecv = recv; szLastTs = now;
    return;
  }
  const dt = (now - szLastTs) / 1000;
  const bitrateKbps = (dt > 0) ? ((bytes - szLastBytes) * 8) / dt / 1000 : 0;
  const fpsCalc = (dt > 0) ? (decoded - szLastDecoded) / dt : 0;
  const dR = recv - szLastRecv; // RTP 收包增量；出帧停滞但收包仍在=真解码卡死，否则只是源端静止/暂停，不算异常
  szLastBytes = bytes; szLastRecv = recv; szLastTs = now;
  const dC = corrupt - szLastCorrupt, dL = lost - szLastLost, dD = decoded - szLastDecoded;
  szLastCorrupt = corrupt; szLastLost = lost; szLastDecoded = decoded;
  // 统计小字：分辨率 / 码率 / 帧率 / 丢包比例 / 延迟
  const totalPkts = recv + lost;
  const lossPct = totalPkts > 0 ? (lost / totalPkts * 100) : 0;
  let statTxt = '';
  if (fw && fh) statTxt += fw + '×' + fh + ' · ';
  statTxt += Math.round(bitrateKbps) + ' kbps · ' + Math.round(fps || fpsCalc) + ' fps';
  if (totalPkts > 0) statTxt += ' · 丢包 ' + lossPct.toFixed(1) + '%';
  if (rttMs !== null) statTxt += ' · 延迟 ' + Math.round(rttMs) + ' ms';
  if (screenStats) screenStats.textContent = statTxt;
  // 花屏：出现新损坏帧；或丢包突增且仍在出帧（P 帧依赖丢失数据）；或 RTP 仍在到达但解码不出帧（解码卡死）
  const bad = dC > 0 || (dL >= 10 && dD > 0) || (dD === 0 && dR > 0 && decoded > 0);
  if (bad) {
    szGoodStreak = 0;
    if (Date.now() - szLastReqAt > 1500) {
      szLastReqAt = Date.now();
      if (screenStatus) screenStatus.textContent = '检测到画面异常，正在自适应降级并请求关键帧…';
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'screen-request-keyframe' })); // 真损坏：关键帧自愈
        dc.send(JSON.stringify({ type: 'screen-abr', dir: 'down' }));  // 卡顿：降一档（阶梯下降）
      }
      logT('屏幕共享', '检测到屏幕画面异常（损坏帧+' + dC + '，丢包+' + dL + '，出帧+' + dD + '），已请求降级并修复关键帧。', 'warn');
    }
  } else {
    // 持续良好（6s）后阶梯回升一档，恢复网络后的清晰度/流畅度
    szGoodStreak++;
    if (szGoodStreak >= 6 && Date.now() - szLastUpAt > 3000) {
      szLastUpAt = Date.now(); szGoodStreak = 0;
      if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'screen-abr', dir: 'up' }));
    }
  }
}
// 发送端：收到关键帧请求后，向编码器申请 IDR 帧（优先 requestKeyFrame，无则参数/重协商兜底）
async function onScreenRequestKeyframe() {
  if (!screenTransceiver || !screenTransceiver.sender) { logT('屏幕共享', '收到关键帧请求，但当前未共享屏幕。', 'warn'); return; }
  const sender = screenTransceiver.sender;
  try { if (typeof sender.requestKeyFrame === 'function') { sender.requestKeyFrame(); logT('屏幕共享', '已请求编码器发送关键帧。', 'info'); return; } }
  catch (e) { logT('屏幕共享', 'requestKeyFrame 失败：' + e.message, 'warn'); }
  // 兜底：通过调整编码参数尝试触发 IDR（部分实现无 requestKeyFrame 时有效）。临时抬高 maxBitrate，
  // 随后的 applyScreenAbr 会经同一队列把码率恢复为当前档位，无需此处手动还原；只调用一次 setParameters 避免事务复用报错。
  try {
    await szSetSenderParams(p => {
      if (p.encodings && p.encodings[0]) p.encodings[0].maxBitrate = Math.max(p.encodings[0].maxBitrate || 2000000, 4000000);
    });
    logT('屏幕共享', '已通过编码参数调整请求关键帧（兜底）。', 'info');
  } catch (e2) { logT('屏幕共享', '关键帧兜底失败：' + e2.message, 'warn'); }
}

// ---------- 剪贴板同步 ----------
let clipLastSeen = '';   // 已处理（发送/接收）的剪贴板内容，用于去重并防止两端自动回环
let clipAutoTimer = null;

// auto=true 表示由“自动监听”触发（静默、不打扰式 toast）；presetText 为自动监听读到的真实剪贴板内容
async function sendClipboard(auto, presetText) {
  const text = (presetText != null) ? presetText : clipLocal.value;
  if (!text) { if (!auto) toast('没有可同步的内容'); return; }
  if (!dc || dc.readyState !== 'open') { if (!auto) logT('剪贴板', '连接未建立，无法同步。', 'err'); return; }
  dc.send(JSON.stringify({ type: 'clipboard', text, auto: !!auto }));
  clipLastSeen = text;
  if (!auto) toast('已同步给对方');
  logT('剪贴板', (auto ? '（自动）' : '') + '已同步剪贴板给对方。', 'ok');
}
function onClipboard(msg) {
  const text = msg.text || '';
  clipRemote.value = text;
  // 标记已处理，避免本端自动监听把“刚写进剪贴板的内容”当成新复制回传给对方，形成回环
  clipLastSeen = text;
  if (navigator.clipboard && navigator.clipboard.writeText && text) {
    navigator.clipboard.writeText(text)
      .then(() => toast('收到并自动复制到本机剪贴板'))
      .catch(() => toast('收到对方剪贴板（点“复制对方内容”手动复制）'));
  } else {
    toast('收到对方剪贴板（点“复制对方内容”手动复制）');
  }
  logT('剪贴板', '收到对方' + (msg.auto ? '（自动）' : '') + '同步的剪贴板内容。', 'info');
}

// 自动监听：本机剪贴板变化时自动发给对方（手动“同步给对方”按钮保留）
async function pollClipboard() {
  if (!dc || dc.readyState !== 'open') return;
  if (!navigator.clipboard || !navigator.clipboard.readText) return;
  let text = '';
  try { text = await navigator.clipboard.readText(); }
  catch (e) { return; }   // 无权限 / 页面未聚焦等，静默跳过本轮
  if (!text || text === clipLastSeen) return;
  clipLastSeen = text;
  clipLocal.value = text;   // 让“本机内容”框同步反映刚复制的内容（也避免 clipLastSeen 与文本框不一致导致重复发送）
  sendClipboard(true, text);
}
function startClipAuto() {
  if (clipAutoTimer) return;
  clipAutoTimer = setInterval(pollClipboard, 1200);
  logT('剪贴板', '已开启剪贴板自动监听：本机复制内容会自动发给对方。', 'ok');
}
function stopClipAuto() {
  if (clipAutoTimer) { clearInterval(clipAutoTimer); clipAutoTimer = null; }
  logT('剪贴板', '已关闭剪贴板自动监听。', 'info');
}

// ---------- 聊天容量 ----------
function updateChatCap() {
  if (!chatCap) return;
  const pct = Math.min(100, (chatBytes / CHAT_CAP_BYTES) * 100);
  chatCap.textContent = '记录 ' + formatBytes(chatBytes) + ' / ' + formatBytes(CHAT_CAP_BYTES);
  chatCap.style.color = pct > 90 ? 'var(--danger)' : (pct > 70 ? '#f5c451' : 'var(--text-dim)');
}
