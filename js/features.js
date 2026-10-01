// features.js —— 二维码 / 扫码 / 屏幕共享 / 剪贴板同步 / 聊天容量 / 复制提示

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
    log('当前环境不支持摄像头（需 HTTPS/localhost 安全上下文），请改用粘贴。', 'warn');
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
    catch (e2) { log('无法访问摄像头：' + e2.message, 'err'); closeScanner(); return; }
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
    log('已获得摄像头权限（用于扫码，并帮助 WebRTC 在局域网暴露真实本地 IP）。', 'ok');
  } catch (e) {
    log('未授予摄像头权限：扫码时再申请，不影响文件传输与通话。', 'warn');
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
  try { document.execCommand('copy'); onCopied(okMsg); } catch (e) { log('复制失败，请手动复制。', 'warn'); }
  ta.remove();
}
function onCopied(okMsg) {
  toast('已复制');
  if (okMsg) log(okMsg, 'ok');
}

// ---------- 屏幕共享（带内重协商，复用已建立的 DataChannel） ----------
// 关键点：首次共享用 addTrack 触发一次重协商；之后复用同一 transceiver（replaceTrack），
// 不再新增 m 行、也不再重复重协商，可“暂停→恢复”且不会累积多条视频轨道。

// 记录用户设置的屏幕共享帧率/码率，作为下次默认值（localStorage 持久化）
const SCREEN_PROFILE_KEY = 'bsScreenProfile';
function saveScreenProfile() {
  try {
    const fps = parseInt(screenFps.value, 10);
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
    if (p && typeof p.fps === 'number' && screenFps.querySelector('option[value="' + p.fps + '"]')) {
      screenFps.value = String(p.fps);
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
let abrBitrateStep = 0, abrFpsStep = 0; // 阶梯步数（每步 5%）
let abrWatchScale = 1;  // 监看端屏幕更小 -> 降分辨率下发（>=1）
let abrZoomBoost = 1;   // 监看端缩放 -> 提高下发分辨率，使放大区更清晰（>1）
// 由阶梯步数推算当前码率/帧率/分辨率缩放（取整、设下限）
function screenAbrCurrent() {
  let bitrate, fps, resSteps;
  if (abrMode === 'smooth') {
    bitrate = abrBaseBitrate * Math.pow(0.95, abrBitrateStep);
    fps = abrBaseFps * Math.pow(0.95, Math.floor(abrBitrateStep / 2)); // 每降10%码率->降5%帧率
    resSteps = Math.floor(abrBitrateStep / 4);                        // 每降20%码率->降10%分辨率
  } else {
    fps = abrBaseFps * Math.pow(0.95, abrFpsStep);
    bitrate = abrBaseBitrate * Math.pow(0.95, Math.floor(abrFpsStep / 2)); // 每降10%帧率->降5%码率
    resSteps = Math.floor(abrFpsStep / 4);                            // 每降20%帧率->降10%分辨率
  }
  bitrate = Math.max(300, Math.round(bitrate));
  fps = Math.max(5, Math.round(fps));
  const resScale = Math.pow(1 / 0.9, resSteps); // 分辨率降10%/步 -> scaleResolutionDownBy 增大
  return { bitrate, fps, resScale };
}
async function applyScreenAbr() {
  if (!screenTransceiver || !screenTransceiver.sender) return;
  const cur = screenAbrCurrent();
  // 最终下发缩放 = 分辨率阶梯缩放 × 监看端分辨率缩放 ÷ 缩放放大系数（放大时更清晰，下限1即不超采集分辨率）
  let scale = cur.resScale * abrWatchScale / abrZoomBoost;
  scale = Math.max(1, Math.round(scale * 100) / 100);
  try {
    const p = screenTransceiver.sender.getParameters();
    if (!p.encodings) p.encodings = [{}];
    p.encodings[0].maxBitrate = cur.bitrate * 1000;
    p.encodings[0].maxFramerate = cur.fps;
    p.encodings[0].scaleResolutionDownBy = scale;
    await screenTransceiver.sender.setParameters(p);
  } catch (e) { log('ABR 应用失败：' + e.message, 'warn'); }
  log('屏幕自适应 → ' + cur.fps + 'fps / ' + cur.bitrate + 'kbps / 下发分辨率×' + (1 / scale).toFixed(2) +
    '（' + (abrMode === 'smooth' ? '流畅优先' : '清晰优先') + (abrBitrateStep + abrFpsStep ? '，已降' + (abrBitrateStep + abrFpsStep) + '档' : '') + '）', 'info');
}
// 收到监看端指令：卡顿降一档 / 恢复升一档
function onScreenAbr(msg) {
  if (!screenTransceiver) return;
  if (msg.dir === 'down') {
    if (abrMode === 'smooth') { if (abrBitrateStep < 40) abrBitrateStep++; }
    else { if (abrFpsStep < 40) abrFpsStep++; }
  } else {
    if (abrMode === 'smooth') abrBitrateStep = Math.max(0, abrBitrateStep - 1);
    else abrFpsStep = Math.max(0, abrFpsStep - 1);
  }
  applyScreenAbr();
}
// 收到监看端屏幕分辨率/缩放：按监看端分辨率自适应下发，并按缩放提升清晰度
function onScreenWatchInfo(msg) {
  abrZoomBoost = (msg && msg.zoom > 0) ? msg.zoom : 1;
  abrWatchScale = 1;
  try {
    const t = screenTransceiver.sender.track;
    const s = t ? t.getSettings() : null;
    if (s && s.width && s.height && msg && msg.w && msg.h) {
      const ratio = Math.min(s.width / msg.w, s.height / msg.h);
      if (ratio > 1.05) abrWatchScale = ratio; // 监看屏更小 -> 降分辨率下发，省带宽
    }
  } catch (e) {}
  applyScreenAbr();
}

async function startScreenShare() {
  if (!pc || (pc.connectionState !== 'connected' && pc.connectionState !== 'connecting')) {
    log('连接未建立，无法共享屏幕。', 'err'); return;
  }
  const fps = parseInt(screenFps.value, 10) || 10;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
  } catch (e) { log('屏幕共享被取消或失败：' + e.message, 'warn'); return; }
  await beginScreenShare(stream);
}
// 用给定流开始/接续屏幕共享（手动点“开始共享”与“连接后自动共享”共用）
async function beginScreenShare(stream) {
  if (!pc || (pc.connectionState !== 'connected' && pc.connectionState !== 'connecting')) {
    log('连接未建立，无法共享屏幕。', 'err'); return;
  }
  const fps = parseInt(screenFps.value, 10) || 10;
  const kbps = parseInt(screenBitrate.value, 10) || 1500;
  saveScreenProfile(); // 记录本次实际使用的帧率/码率/模式，作为下次默认
  // 初始化自适应基线（阶梯归零）
  abrMode = (screenMode && screenMode.value) ? screenMode.value : 'smooth';
  abrBaseFps = fps; abrBaseBitrate = kbps;
  abrBitrateStep = 0; abrFpsStep = 0; abrWatchScale = 1; abrZoomBoost = 1;
  screenStream = stream;
  const track = stream.getVideoTracks()[0];
  if (screenTransceiver) {
    try { await screenTransceiver.sender.replaceTrack(track); } catch (e) { log('接入屏幕轨道失败：' + e.message, 'err'); return; }
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
  log('已开始屏幕共享（' + fps + 'fps / ' + kbps + 'kbps）。', 'ok');
}
// 身份页“先选好要共享的屏幕”：提前捕获并暂存，连接成功后自动 beginScreenShare
async function pickScreenBeforeConnect() {
  if (pendingScreenStream) {
    pendingScreenStream.getTracks().forEach((t) => t.stop());
    pendingScreenStream = null;
    preShareStatus.textContent = '';
    btnPreShare.textContent = '🖥️ 先选好要共享的屏幕（连接后自动共享）';
    log('已取消预选屏幕。', 'info');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10 }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
    });
  } catch (e) { log('屏幕预选被取消或失败：' + e.message, 'warn'); return; }
  pendingScreenStream = stream;
  const name = stream.getVideoTracks()[0].label || '屏幕';
  preShareStatus.textContent = '已选好：' + name + '，连接后将自动共享给对方。';
  btnPreShare.textContent = '✕ 取消预选屏幕（' + name + '）';
  log('已预选共享屏幕：' + name + '（连接后自动开始）。', 'ok');
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (pendingScreenStream !== stream) return;
    pendingScreenStream = null;
    preShareStatus.textContent = '';
    btnPreShare.textContent = '🖥️ 先选好要共享的屏幕（连接后自动共享）';
    log('预选的屏幕共享已停止（画面被关闭）。', 'info');
  });
}
async function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  if (screenTransceiver) { try { await screenTransceiver.sender.replaceTrack(null); } catch (e) {} }
  screenSender = null;
  screenStart.classList.remove('hidden');
  screenStop.classList.add('hidden');
  screenLocal.classList.add('hidden'); screenLocal.srcObject = null;
  stopScreenSendMonitor(); // 停止发送端统计
  abrBitrateStep = 0; abrFpsStep = 0; abrWatchScale = 1; abrZoomBoost = 1;
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'screen-stop' }));
  log('已停止屏幕共享（可再次开始，无需重新协商）。', 'info');
}
// 通过 DataChannel 在已连接的两端之间重新协商（无需再次带外交换）
async function reneg() {
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'sdp-offer', sdp: pc.localDescription.sdp }));
  } catch (e) { log('屏幕共享重协商失败：' + e.message, 'err'); }
}
async function onSdpOffer(msg) {
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceComplete(pc);
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'sdp-answer', sdp: pc.localDescription.sdp }));
  } catch (e) { log('处理屏幕协商失败：' + e.message, 'err'); }
}
async function onSdpAnswer(msg) {
  try { await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); }
  catch (e) { log('屏幕协商应答失败：' + e.message, 'err'); }
}
function onScreenStart() {
  goPage('page-screen');
  screenShareWrap.classList.add('hidden');
  screenWatchWrap.classList.remove('hidden');
  if (typeof szReset === 'function') szReset();
  if (typeof playWatchVideo === 'function') playWatchVideo(); // 面板可见后补播，避免隐藏态 play 被忽略
  szStartQualityMonitor(); // 启动监看画质检测（花屏自愈）
  sendWatchInfo(); // 上报本机屏幕分辨率/缩放，发送端据此自适应下发分辨率
  // 黑屏诊断：5s 后若仍无画面，给出提示（多为隐藏态 play 被忽略或协商未就绪）
  setTimeout(() => {
    if (screenWatchVideo.srcObject && screenWatchVideo.readyState < 2 && !screenWatchWrap.classList.contains('hidden')) {
      log('监看画面仍未出帧，可尝试双击画面或重进全屏以触发播放。', 'warn');
    }
  }, 5000);
  screenStatus.textContent = '对方正在共享屏幕，等待画面…';
  toast('对方开始共享屏幕，已为你打开监看页');
  log('对方开始共享屏幕，已为你打开监看页。', 'info');
}
// 监看端上报：本机屏幕分辨率 + 当前缩放。发送端据此降分辨率下发（省带宽）并按缩放提升清晰度。
function sendWatchInfo() {
  try {
    if (!dc || dc.readyState !== 'open') return;
    const zoom = (typeof szScale === 'number' && szScale > 0) ? szScale : 1;
    dc.send(JSON.stringify({ type: 'screen-watch-info', w: window.screen.width, h: window.screen.height, zoom }));
  } catch (e) {}
}
function onScreenStop() {
  szStopQualityMonitor(); // 停止画质检测
  screenWatchWrap.classList.add('hidden');
  // 对方停止共享后，恢复本端“开始共享”入口（onScreenStart 曾为“观看时不可分享”而隐藏它）
  if (!screenStream) screenShareWrap.classList.remove('hidden');
  // 若监看页正处于全屏，对方结束共享后自动退出全屏
  if (typeof exitScreenFs === 'function') exitScreenFs();
  if (typeof szReset === 'function') szReset();
  try { screenWatchVideo.pause(); } catch (e) {} // 停止解码，节省资源
  screenStatus.textContent = '对方已停止共享。'; if (screenStats) screenStats.textContent = '';
  log('对方停止了屏幕共享。', 'info');
}

// ---------- 发送端统计：screenLocal 上方显示“发出去”的分辨率/码率/帧率 ----------
let szSendTimer = null, szSendBase = false, szSendLastBytes = 0, szSendLastEncoded = 0, szSendLastTs = 0;
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
  let txt = '发送：';
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
  // 花屏：出现新损坏帧；或丢包突增且仍在出帧（P 帧依赖丢失数据）；或出帧停滞（解码卡死）
  const bad = dC > 0 || (dL >= 10 && dD > 0) || (dD === 0 && decoded > 0);
  if (bad) {
    szGoodStreak = 0;
    if (Date.now() - szLastReqAt > 1500) {
      szLastReqAt = Date.now();
      if (screenStatus) screenStatus.textContent = '检测到画面异常，正在自适应降级并请求关键帧…';
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'screen-request-keyframe' })); // 真损坏：关键帧自愈
        dc.send(JSON.stringify({ type: 'screen-abr', dir: 'down' }));  // 卡顿：降一档（阶梯下降）
      }
      log('检测到屏幕画面异常（损坏帧+' + dC + '，丢包+' + dL + '，出帧+' + dD + '），已请求降级并修复关键帧。', 'warn');
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
  if (!screenTransceiver || !screenTransceiver.sender) { log('收到关键帧请求，但当前未共享屏幕。', 'warn'); return; }
  const sender = screenTransceiver.sender;
  try { if (typeof sender.requestKeyFrame === 'function') { sender.requestKeyFrame(); log('已请求编码器发送关键帧。', 'info'); return; } }
  catch (e) { log('requestKeyFrame 失败：' + e.message, 'warn'); }
  // 兜底：通过调整编码参数尝试触发 IDR（部分实现有效）
  try {
    const p = sender.getParameters();
    if (p.encodings && p.encodings[0]) {
      const saved = p.encodings[0].maxBitrate;
      p.encodings[0].maxBitrate = Math.max(saved || 2000000, 4000000);
      await sender.setParameters(p);
      if (saved) { p.encodings[0].maxBitrate = saved; await sender.setParameters(p); }
      log('已通过编码参数调整请求关键帧（兜底）。', 'info');
    }
  } catch (e2) { log('关键帧兜底失败：' + e2.message, 'warn'); }
}

// ---------- 剪贴板同步 ----------
let clipLastSeen = '';   // 已处理（发送/接收）的剪贴板内容，用于去重并防止两端自动回环
let clipAutoTimer = null;

// auto=true 表示由“自动监听”触发（静默、不打扰式 toast）；presetText 为自动监听读到的真实剪贴板内容
async function sendClipboard(auto, presetText) {
  const text = (presetText != null) ? presetText : clipLocal.value;
  if (!text) { if (!auto) toast('没有可同步的内容'); return; }
  if (!dc || dc.readyState !== 'open') { if (!auto) log('连接未建立，无法同步。', 'err'); return; }
  dc.send(JSON.stringify({ type: 'clipboard', text, auto: !!auto }));
  clipLastSeen = text;
  if (!auto) toast('已同步给对方');
  log((auto ? '（自动）' : '') + '已同步剪贴板给对方。', 'ok');
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
  log('收到对方' + (msg.auto ? '（自动）' : '') + '同步的剪贴板内容。', 'info');
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
  log('已开启剪贴板自动监听：本机复制内容会自动发给对方。', 'ok');
}
function stopClipAuto() {
  if (clipAutoTimer) { clearInterval(clipAutoTimer); clipAutoTimer = null; }
  log('已关闭剪贴板自动监听。', 'info');
}

// ---------- 聊天容量 ----------
function updateChatCap() {
  if (!chatCap) return;
  const pct = Math.min(100, (chatBytes / CHAT_CAP_BYTES) * 100);
  chatCap.textContent = '记录 ' + formatBytes(chatBytes) + ' / ' + formatBytes(CHAT_CAP_BYTES);
  chatCap.style.color = pct > 90 ? 'var(--danger)' : (pct > 70 ? '#f5c451' : 'var(--text-dim)');
}
