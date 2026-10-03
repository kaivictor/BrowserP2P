// ui.js —— 事件绑定 / 角色流程 / 初始化（最后加载，依赖前面所有脚本）
logT('监看', '[ui.js] 已加载 v=60', 'info'); // 自证：日志首行显示此版本，说明手机跑的是新版；若看不到这行=旧缓存

function startAsOfferer() {
  role = 'offerer';
  goPage('page-signal');
  offererView.classList.remove('hidden');
  answererView.classList.add('hidden');
  setBadge('等待对方', 'pending');
  logT('信令', '正在生成会话码…', 'info');
  createOffer().then(() => logT('信令', '会话码已生成，请发给对方。', 'ok')).catch((e) => logT('信令', '生成失败：' + e.message, 'err'));
}
function startAsAnswerer() {
  role = 'answerer';
  goPage('page-signal');
  answererView.classList.remove('hidden');
  offererView.classList.add('hidden');
  setBadge('等待会话码', 'pending');
  logT('信令', '请在上方粘贴对方的会话码。', 'info');
}
async function handleProcessOffer() {
  const code = offerIn.value.trim();
  if (!code) { alert('请先粘贴或扫描对方的会话码。'); return; }
  try { await processOffer(code); logT('信令', '应答码已生成，请发回给对方。', 'ok'); }
  catch (e) { logT('信令', '处理会话码失败：' + e.message, 'err'); }
}
async function handleSetAnswer() {
  const code = answerIn.value.trim();
  if (!code) { alert('请先粘贴或扫描对方的应答码。'); return; }
  processAnswer(code).catch((e) => logT('信令', '连接失败：' + e.message, 'err'));
}
function disconnect() {
  try { if (dc) dc.close(); } catch (e) {}
  try { if (pc) pc.close(); } catch (e) {}
  pc = null; dc = null; role = null; audioTransceiver = null; calling = false;
  if (pendingScreenStream) { try { pendingScreenStream.getTracks().forEach((t) => t.stop()); } catch (e) {} pendingScreenStream = null; }
  screenStream = null; screenSender = null; screenTransceiver = null;
  if (preShareStatus) preShareStatus.textContent = '';
  if (btnPreShare) btnPreShare.textContent = '🖥️ 先选好要共享的屏幕（连接后自动共享）';
  setBadge('未连接', 'off');
  chatMessages.innerHTML = ''; chatBytes = 0; updateChatCap();
  offererView.classList.add('hidden'); answererView.classList.add('hidden'); answerOutWrap.classList.add('hidden');
  copyOffer.classList.add('hidden'); showOfferQR.classList.add('hidden');
  copyAnswer.classList.add('hidden'); showAnswerQR.classList.add('hidden');
  offerOut.value = ''; answerOut.value = ''; offerIn.value = ''; answerIn.value = '';
  screenWatchWrap.classList.add('hidden');
  try { screenWatchVideo.pause(); screenWatchVideo.srcObject = null; } catch (e) {} // 清空残留画面，避免下次连接显示冻结/黑帧
  goPage('page-role');
  if (typeof refreshConnectedNav === 'function') refreshConnectedNav();
  logT('信令', '已断开连接。', 'warn');
}
function clearChat() {
  chatMessages.innerHTML = ''; chatBytes = 0; updateChatCap();
  logT('UI', '已清空聊天与传输记录显示。', 'info');
}

function initUI() {
  if (!hasSubtle) {
    encToggle.checked = false; encToggle.disabled = true;
    encToggle.parentElement.title = '当前非安全上下文（需 HTTPS/localhost），可选 AES-GCM（文件/聊天）与校验和不可用；传输仍由 WebRTC DTLS-SRTP 加密，复制粘贴信令不受影响。';
  }
  if (!hasFSAccess) {
    streamingMode = false;
    logT('UI', '当前浏览器不支持 File System Access API（需 Chrome/Edge 且 HTTPS/localhost），大文件将退回“内存拼装后下载”，可能内存溢出。', 'warn');
  }

  bindBackButtons();

  btnCreate.addEventListener('click', startAsOfferer);
  btnJoin.addEventListener('click', startAsAnswerer);
  btnDisconnect.addEventListener('click', disconnect);
  connBadge.addEventListener('click', checkConnectionNow); // 点击右上角连接状态：立即互发心跳探测

  // 功能中心：进入对应功能页
  featChat.addEventListener('click', () => goPage('page-chat'));
  featCall.addEventListener('click', () => goPage('page-call'));
  featScreen.addEventListener('click', () => goPage('page-screen'));
  featClip.addEventListener('click', () => goPage('page-clip'));

  // 复制 / 二维码
  copyOffer.addEventListener('click', () => copyText(offerOut.value, '会话码已复制'));
  copyAnswer.addEventListener('click', () => copyText(answerOut.value, '应答码已复制'));
  showOfferQR.addEventListener('click', () => showQRFullscreen(offerOut.value, 4));
  showAnswerQR.addEventListener('click', () => showQRFullscreen(answerOut.value, 4));
  qrFullscreen.addEventListener('click', (e) => { if (e.target === qrFullscreen) hideQRFullscreen(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !qrFullscreen.classList.contains('hidden')) hideQRFullscreen(); });

  // 扫码
  scanAnswer.addEventListener('click', () => openScanner((val) => { answerIn.value = val; }));
  scanOffer.addEventListener('click', () => openScanner((val) => { offerIn.value = val; handleProcessOffer(); }));
  btnProcessOffer.addEventListener('click', handleProcessOffer);
  btnSetAnswer.addEventListener('click', handleSetAnswer);
  scanClose.addEventListener('click', closeScanner);

  // 文件选择 / 拖拽（聊天页即传输入口）
  btnFile.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files.length) { sendFiles(fileInput.files); fileInput.value = ''; } });
  ['dragenter', 'dragover'].forEach((ev) => chatDrop.addEventListener(ev, (e) => { e.preventDefault(); chatDrop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => chatDrop.addEventListener(ev, (e) => { e.preventDefault(); chatDrop.classList.remove('drag'); }));
  chatDrop.addEventListener('drop', (e) => { const files = e.dataTransfer && e.dataTransfer.files; if (files && files.length) sendFiles(files); });

  // 聊天
  chatSend.addEventListener('click', () => sendText().catch((e) => logT('UI', '发送失败：' + e.message, 'err')));
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText().catch((e) => logT('UI', '发送失败：' + e.message, 'err')); } });
  chatMic.addEventListener('click', () => { if (recording) stopVoice(); else startVoice().catch((e) => logT('UI', '录音启动失败：' + e.message, 'err')); });
  if (!voiceSupported && !wavSupported) { chatMic.disabled = true; chatMic.title = '当前浏览器不支持语音录制'; chatMic.classList.add('disabled'); chatMic.textContent = '🎤 录音(不支持)'; }
  btnClearChat.addEventListener('click', clearChat);

  // 通话
  callStart.addEventListener('click', () => initiateCall().catch((e) => logT('UI', '通话启动失败：' + e.message, 'err')));
  callJoin.addEventListener('click', () => joinCall().catch((e) => logT('UI', '加入失败：' + e.message, 'err')));
  callReject.addEventListener('click', rejectCall);
  callMute.addEventListener('click', toggleMute);
  callMicMute.addEventListener('click', toggleMicMute);
  callEnd.addEventListener('click', endCall);

  // 屏幕监看
  screenStart.addEventListener('click', () => startScreenShare().catch((e) => logT('UI', '屏幕共享失败：' + e.message, 'err')));
  screenStop.addEventListener('click', () => stopScreenShare().catch((e) => logT('UI', '停止共享失败：' + e.message, 'err')));
  screenFps.addEventListener('change', () => {
    const isCustom = screenFps.value === 'custom';
    screenFpsCustom.classList.toggle('hidden', !isCustom);
    saveScreenProfile();
  });
  screenBitrate.addEventListener('change', saveScreenProfile);
  screenFpsCustom.addEventListener('change', saveScreenProfile);
  screenMode.addEventListener('change', () => {
    saveScreenProfile();
    if (typeof applyScreenAbr === 'function' && screenTransceiver) { abrMode = screenMode.value; applyScreenAbr(); }
  });
  // 监看端分辨率/缩放变化：防抖上报发送端，自适应下发分辨率（szWatchInfoTimer/szLastWatchSent 已提到文件顶层声明，供 szZoomAt/szTouchEnd 共用）
  window.addEventListener('resize', () => { clearTimeout(szWatchInfoTimer); szWatchInfoTimer = setTimeout(() => { if (typeof sendWatchInfo === 'function') sendWatchInfo(); }, 400); });
  btnPreShare.addEventListener('click', () => pickScreenBeforeConnect().catch((e) => logT('UI', '预选屏幕失败：' + e.message, 'err')));

  // 屏幕监看：全屏（竖屏 / 横屏）/ 退出
  screenFsPortrait.addEventListener('click', () => enterScreenFs('portrait'));
  screenFsLandscape.addEventListener('click', () => enterScreenFs('landscape'));
  screenFsReset.addEventListener('click', szReset);
  screenFsExit.addEventListener('click', exitScreenFs);
  document.addEventListener('fullscreenchange', syncScreenFsButtons);
  document.addEventListener('webkitfullscreenchange', syncScreenFsButtons);

  // 剪贴板同步
  clipSend.addEventListener('click', () => sendClipboard(false));
  clipCopy.addEventListener('click', () => copyText(clipRemote.value, '已复制对方内容'));
  clipAuto.addEventListener('change', () => { clipAuto.checked ? startClipAuto() : stopClipAuto(); });

  // 日志折叠
  logToggle.addEventListener('click', () => {
    const collapsed = logEl.classList.toggle('collapsed');
    logToggle.textContent = collapsed ? '展开' : '收起';
  });

  // 任意用户交互都尝试解锁远端音频播放（浏览器要求带声播放须有粘性激活）
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach((ev) =>
    document.addEventListener(ev, unlockRemoteAudio, { passive: true }));

  preRequestCamera();
  updateChatCap();
  logT('UI', '就绪。请选择角色开始。安全上下文：' + (hasSubtle ? '是（AES-GCM 可用）' : '否（AES-GCM 不可用，传输仍 DTLS-SRTP 加密）'), 'info');
}

// ---------- 屏幕监看全屏 ----------
function fsRequest(el) {
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  return Promise.reject(new Error('当前浏览器不支持全屏'));
}
function fsExit() {
  if (document.fullscreenElement && document.exitFullscreen) return document.exitFullscreen();
  if (document.webkitFullscreenElement && document.webkitExitFullscreen) return document.webkitExitFullscreen();
  return Promise.resolve();
}
// mode: 'portrait' | 'landscape'，尽力锁定方向（iOS Safari 不支持方向锁，try/catch 忽略）
function enterScreenFs(mode) {
  fsRequest(screenWatchStage).then(() => {
    if (mode && screen.orientation && screen.orientation.lock) {
      screen.orientation.lock(mode === 'landscape' ? 'landscape-primary' : 'portrait-primary').catch(() => {});
    }
    if (typeof sendWatchInfo === 'function') sendWatchInfo(); // 全屏后按监看屏分辨率自适应下发
  }).catch((e) => logT('全屏', '无法进入全屏：' + e.message, 'warn'));
}
function exitScreenFs() { fsExit().catch(() => {}); }
function syncScreenFsButtons() {
  const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  screenFsExit.classList.toggle('hidden', !fs);
  screenFsPortrait.classList.toggle('hidden', fs);
  screenFsLandscape.classList.toggle('hidden', fs);
  if (typeof sendWatchInfo === 'function') sendWatchInfo(); // 全屏切换后按实际显示区域重新自适应分辨率
}

// ---------- 屏幕监看：缩放 / 平移（Ctrl+滚轮、双指捏合、拖拽） ----------
let szScale = 1, szTx = 0, szTy = 0;
// Canvas 裁切（发送端勾选控制；监看端仅做显示）
let szCropEnabled = false;  // 复选框：发送端是否启用 Canvas 裁切传输（仅传监看端放大的局部）
let szCropRxActive = false; // 接收侧：发送端是否正在裁切传输（收到 screen-crop 置位；置位后本地按 fit 显示，避免二次放大）
let szCropRxReady = false;  // 接收侧：发送端是否已启用 Canvas 裁切（收到 screen-crop.enabled 置位；仅此时才向其上报裁切矩形）
let szSrcW = 0, szSrcH = 0; // 全屏源分辨率缓存：把缩放/平移换算成裁切矩形用（裁切态不能取视频实际宽高，因为那已是局部）
const szCropChk = document.getElementById('szCropChk');
const szCropRow = document.getElementById('szCropRow');
let szWatchInfoTimer = null, szLastWatchSent = 0; // 必须在顶层声明：szZoomAt/szTouchEnd 是顶层函数，访问不到 initUI 内部的 let
let szLastScaleLogT = 0; // 监看端缩放日志节流：每 500ms 最多打一条，避免捏合时刷屏
let szPanning = null; // 鼠标 / 单指拖拽平移状态
let szPinch = null;   // 双指捏合状态（记录起始距离与起始 scale）
let szPinchEndedAt = 0; // 捏合结束时刻：结束后短时间内忽略单指平移，防两指不同时离开导致画面漂移
function szPinchJustEnded() { return Date.now() - szPinchEndedAt < 300; }
function szApply() {
  screenWatchVideo.style.transformOrigin = '0 0';
  if (szCropRxActive) {
    // 发送端正在裁切传输局部，收到的本就是局部画面：按原始比例铺满即可，绝不再做本地放大（否则二次放大）
    screenWatchVideo.style.transform = 'none';
  } else {
    screenWatchVideo.style.transform = 'translate(' + szTx + 'px,' + szTy + 'px) scale(' + szScale + ')';
  }
  screenFsReset.classList.toggle('hidden', szScale <= 1);
  // 仅在非裁切态记录全屏源分辨率（裁切态视频实际宽高已是局部，不能用作换算基准）
  if (!szCropRxActive && screenWatchVideo.videoWidth) { szSrcW = screenWatchVideo.videoWidth; szSrcH = screenWatchVideo.videoHeight; }
}
// 由当前缩放/平移算出“全屏源归一化矩形”：发给发送端用于 Canvas 裁切。
// 仅在 szScale>1（已放大查看局部）时有意义，否则返回 null（发送端按全屏传）。
function szGetCropRect() {
  if (szScale <= 1) return null;
  const cw = screenWatchStage.clientWidth, ch = screenWatchStage.clientHeight;
  // 非裁切态：直接读视频实际宽高（实时、可靠，避免缓存 szSrcW 未就绪导致永远算不出矩形）；
  // 裁切态：收到的已是局部画面，videoWidth 不再是全屏，必须用缓存的全屏分辨率 szSrcW/szSrcH。
  const srcW = szCropRxActive ? szSrcW : (screenWatchVideo.videoWidth || szSrcW);
  const srcH = szCropRxActive ? szSrcH : (screenWatchVideo.videoHeight || szSrcH);
  if (!srcW || !srcH || !cw || !ch) return null;
  // object-fit: fill 基矩形（引入 Canvas 前默认即 fill：内容铺满舞台，无 letterbox 偏移，bx=by=0）
  const dw = cw, dh = ch;
  const bx = 0, by = 0;
  // 逆变换：舞台坐标 → 元素局部 → 源归一（transform=translate(szTx,szTy) scale(szScale), origin 0,0）
  const l0x = (0 - szTx) / szScale, l1x = (cw - szTx) / szScale;
  const l0y = (0 - szTy) / szScale, l1y = (ch - szTy) / szScale;
  let x = ((Math.min(l0x, l1x) - bx) / dw);
  let y = ((Math.min(l0y, l1y) - by) / dh);
  let w = ((Math.max(l0x, l1x) - bx) / dw) - x;
  let h = ((Math.max(l0y, l1y) - by) / dh) - y;
  x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y));
  w = Math.min(1 - x, Math.max(0.05, w)); h = Math.min(1 - y, Math.max(0.05, h));
  return { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) };
}
// 接收侧：发送端告知“我正在/已停止裁切”。置位后本地按 fit 显示，避免二次放大。
function szSetCropRx(on) { szCropRxActive = !!on; szApply(); }
function szReset() { szScale = 1; szTx = 0; szTy = 0; szApply(); if (szCropRxReady && typeof sendWatchInfo === 'function') sendWatchInfo(); }
function szClamp(s) { return Math.min(8, Math.max(1, s)); }
// 平移钳制：让缩放后的视频框始终覆盖舞台（scale=1 时强制 tx=ty=0 居中），
// 既避免把画面拖飞，也消除“捏合缩小回 scale=1 却残留偏移→卡在左上角”的问题。
function szClampPan() {
  // 普通页面态与全屏态都钳制：放大后始终让视频盖住舞台。
  // 左移时右边不离开右边界(szTx >= 宽-sw)、右移时左边不离开左边界(szTx <= 0)，上下同理，防止拖出空白。
  const r = screenWatchStage.getBoundingClientRect();
  const sw = r.width * szScale, sh = r.height * szScale;
  szTx = Math.min(0, Math.max(r.width - sw, szTx));
  szTy = Math.min(0, Math.max(r.height - sh, szTy));
}
// 围绕“视频元素自身实时坐标”缩放：用 getBoundingClientRect 反推内容坐标，
// 与 transform 处于同一坐标系，彻底避免“舞台坐标 vs 视频原点”不一致导致的左上漂移。
function szZoomAt(clientX, clientY, factor) {
  const ns = szClamp(szScale * factor);
  if (ns === szScale) return;
  const r = screenWatchVideo.getBoundingClientRect(); // 当前已变换的视觉矩形
  szTx += (clientX - r.left) * (1 - ns / szScale);
  szTy += (clientY - r.top) * (1 - ns / szScale);
  szScale = ns; szClampPan(); szApply();
  if (Date.now() - szLastScaleLogT >= 500) { szLastScaleLogT = Date.now(); logT('Canvas裁切', '监看端缩放 szScale → ' + szScale.toFixed(2), 'info'); }
  if (typeof sendWatchInfo === 'function') {
    const now = Date.now(), minGap = 300;
    if (now - szLastWatchSent >= minGap) { szLastWatchSent = now; sendWatchInfo(szScale); } // 捏合中：每 300ms 领先上报，边捏边变清晰
    else { clearTimeout(szWatchInfoTimer); szWatchInfoTimer = setTimeout(() => { szLastWatchSent = Date.now(); sendWatchInfo(szScale); }, minGap - (now - szLastWatchSent)); } //  trailing：停手前补最后一次
  }
}
// 平移中按节流重新上报：仅平移（szScale 不变）也会改变放大局部，必须重新发送 crop，发送端才能更新裁切区域
function szReportPanThrottled() {
  if (!szCropRxReady) return; // 仅平移不改变发送端任何状态（除非启用 Canvas 裁切需更新局部）；未启用则不报、不打日志
  if (typeof sendWatchInfo !== 'function') return;
  const now = Date.now(), minGap = 200;
  if (now - szLastWatchSent >= minGap) { szLastWatchSent = now; sendWatchInfo(); }
  else { clearTimeout(szWatchInfoTimer); szWatchInfoTimer = setTimeout(() => { szLastWatchSent = Date.now(); sendWatchInfo(); }, minGap - (now - szLastWatchSent)); }
}
function szPinchInfo(e) {
  const ax = e.touches[0].clientX, ay = e.touches[0].clientY;
  const bx = e.touches[1].clientX, by = e.touches[1].clientY;
  return { d: Math.hypot(ax - bx, ay - by), mx: (ax + bx) / 2, my: (ay + by) / 2 };
}
// Ctrl+滚轮（触控板双指捏合也会被浏览器映射为带 ctrlKey 的 wheel）：基于鼠标位置缩放
screenWatchStage.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return; // 非 Ctrl+滚轮不拦截，避免影响正常滚动
  e.preventDefault();
  szZoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
// 拦截 iOS Safari 的原生捏合 / 双击缩放手势（touchmove 的 preventDefault 拦不住 gesture*）
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) =>
  screenWatchStage.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
// 鼠标拖拽平移（仅在已放大时）
screenWatchStage.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || szScale <= 1 || e.target.closest('button')) return;
  szPanning = { x: e.clientX, y: e.clientY, tx: szTx, ty: szTy };
});
window.addEventListener('mousemove', (e) => {
  if (!szPanning) return;
  szTx = szPanning.tx + (e.clientX - szPanning.x);
  szTy = szPanning.ty + (e.clientY - szPanning.y);
  szClampPan(); szApply();
  szReportPanThrottled(); // 平移中节流上报新局部，发送端实时更新裁切
});
window.addEventListener('mouseup', () => { if (szPanning) { szPanning = null; if (szCropRxReady && typeof sendWatchInfo === 'function') sendWatchInfo(); } });
// 触摸：双指捏合缩放（捏合中点即平移焦点）+ 单指拖拽平移
screenWatchStage.addEventListener('touchstart', (e) => {
  if (e.target.closest('button')) return;
  if (e.touches.length === 2) {
    const info = szPinchInfo(e);
    szPinch = { d0: info.d, scale0: szScale };
  } else if (e.touches.length === 1 && szScale > 1) {
    if (szPinchJustEnded()) return; // 捏合刚结束，忽略残留单指，避免漂移
    szPanning = { x: e.touches[0].clientX, y: e.touches[0].clientY, tx: szTx, ty: szTy };
  }
}, { passive: false });
screenWatchStage.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && szPinch) {
    e.preventDefault();
    const info = szPinchInfo(e);
    if (info.d <= 0) return;
    const ns = szClamp(szPinch.scale0 * (info.d / szPinch.d0));
    szZoomAt(info.mx, info.my, ns / szScale); // 围绕当前中点缩放，手指移动即自然平移
  } else if (e.touches.length === 1 && szPanning) {
    if (szPinchJustEnded()) { szPanning = null; return; } // 防抖：捏合残留不要触发平移
    e.preventDefault();
    szTx = szPanning.tx + (e.touches[0].clientX - szPanning.x);
    szTy = szPanning.ty + (e.touches[0].clientY - szPanning.y);
    szClampPan(); szApply();
    szReportPanThrottled(); // 单指平移中节流上报新局部
  }
}, { passive: false });
function szTouchEnd(e) {
  if (szPinch && e.touches.length < 2) {
    szPinch = null; szPinchEndedAt = Date.now(); // 捏合结束→记时刻，触发防抖
    clearTimeout(szWatchInfoTimer); // 松手即上报最终 zoom，避免切后台后 setTimeout 被节流（曾延迟 ~2.5 分钟）
    if (typeof sendWatchInfo === 'function') sendWatchInfo();
  }
  if (e.touches.length === 0) szPanning = null;
}
screenWatchStage.addEventListener('touchend', szTouchEnd);
screenWatchStage.addEventListener('touchcancel', szTouchEnd);
// 鼠标双击复位
screenWatchStage.addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  szReset();
});
szReset(); // 初始化（隐藏复位按钮）

// Canvas 裁切开关：发送端控制。勾选后，当监看端放大查看局部时，发送端用 Canvas 仅裁切该局部传输（更清晰）。
// 监看端勾选本框无效（裁切由发送端决定）；切换时若正在共享且监看端已放大，立即让发送端重新评估（szEvaluateCrop 在 features.js，按 szAmSender 守卫）。
if (szCropChk) {
  szCropEnabled = szCropChk.checked;
  szCropChk.addEventListener('change', () => {
    szCropEnabled = szCropChk.checked;
    logT('监看', 'Canvas 裁切开关=' + szCropEnabled, 'info');
    if (typeof szEvaluateCrop === 'function') szEvaluateCrop();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
else initUI();
