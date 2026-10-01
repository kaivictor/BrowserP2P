// ui.js —— 事件绑定 / 角色流程 / 初始化（最后加载，依赖前面所有脚本）

function startAsOfferer() {
  role = 'offerer';
  goPage('page-signal');
  offererView.classList.remove('hidden');
  answererView.classList.add('hidden');
  setBadge('等待对方', 'pending');
  log('正在生成会话码…', 'info');
  createOffer().then(() => log('会话码已生成，请发给对方。', 'ok')).catch((e) => log('生成失败：' + e.message, 'err'));
}
function startAsAnswerer() {
  role = 'answerer';
  goPage('page-signal');
  answererView.classList.remove('hidden');
  offererView.classList.add('hidden');
  setBadge('等待会话码', 'pending');
  log('请在上方粘贴对方的会话码。', 'info');
}
async function handleProcessOffer() {
  const code = offerIn.value.trim();
  if (!code) { alert('请先粘贴或扫描对方的会话码。'); return; }
  try { await processOffer(code); log('应答码已生成，请发回给对方。', 'ok'); }
  catch (e) { log('处理会话码失败：' + e.message, 'err'); }
}
async function handleSetAnswer() {
  const code = answerIn.value.trim();
  if (!code) { alert('请先粘贴或扫描对方的应答码。'); return; }
  processAnswer(code).catch((e) => log('连接失败：' + e.message, 'err'));
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
  log('已断开连接。', 'warn');
}
function clearChat() {
  chatMessages.innerHTML = ''; chatBytes = 0; updateChatCap();
  log('已清空聊天与传输记录显示。', 'info');
}

function initUI() {
  if (!hasSubtle) {
    encToggle.checked = false; encToggle.disabled = true;
    encToggle.parentElement.title = '当前非安全上下文（需 HTTPS/localhost），可选 AES-GCM（文件/聊天）与校验和不可用；传输仍由 WebRTC DTLS-SRTP 加密，复制粘贴信令不受影响。';
  }
  if (!hasFSAccess) {
    streamingMode = false;
    log('当前浏览器不支持 File System Access API（需 Chrome/Edge 且 HTTPS/localhost），大文件将退回“内存拼装后下载”，可能内存溢出。', 'warn');
  }

  bindBackButtons();

  btnCreate.addEventListener('click', startAsOfferer);
  btnJoin.addEventListener('click', startAsAnswerer);
  btnDisconnect.addEventListener('click', disconnect);

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
  chatSend.addEventListener('click', () => sendText().catch((e) => log('发送失败：' + e.message, 'err')));
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText().catch((e) => log('发送失败：' + e.message, 'err')); } });
  chatMic.addEventListener('click', () => { if (recording) stopVoice(); else startVoice().catch((e) => log('录音启动失败：' + e.message, 'err')); });
  if (!voiceSupported && !wavSupported) { chatMic.disabled = true; chatMic.title = '当前浏览器不支持语音录制'; chatMic.classList.add('disabled'); chatMic.textContent = '🎤 录音(不支持)'; }
  btnClearChat.addEventListener('click', clearChat);

  // 通话
  callStart.addEventListener('click', () => initiateCall().catch((e) => log('通话启动失败：' + e.message, 'err')));
  callJoin.addEventListener('click', () => joinCall().catch((e) => log('加入失败：' + e.message, 'err')));
  callReject.addEventListener('click', rejectCall);
  callMute.addEventListener('click', toggleMute);
  callMicMute.addEventListener('click', toggleMicMute);
  callEnd.addEventListener('click', endCall);

  // 屏幕监看
  screenStart.addEventListener('click', () => startScreenShare().catch((e) => log('屏幕共享失败：' + e.message, 'err')));
  screenStop.addEventListener('click', () => stopScreenShare().catch((e) => log('停止共享失败：' + e.message, 'err')));
  screenFps.addEventListener('change', saveScreenProfile);
  screenBitrate.addEventListener('change', saveScreenProfile);
  screenMode.addEventListener('change', () => {
    saveScreenProfile();
    if (typeof applyScreenAbr === 'function' && screenTransceiver) { abrMode = screenMode.value; applyScreenAbr(); }
  });
  // 监看端分辨率/缩放变化：防抖上报发送端，自适应下发分辨率
  let szWatchInfoTimer = null;
  window.addEventListener('resize', () => { clearTimeout(szWatchInfoTimer); szWatchInfoTimer = setTimeout(() => { if (typeof sendWatchInfo === 'function') sendWatchInfo(); }, 400); });
  btnPreShare.addEventListener('click', () => pickScreenBeforeConnect().catch((e) => log('预选屏幕失败：' + e.message, 'err')));

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
  log('就绪。请选择角色开始。安全上下文：' + (hasSubtle ? '是（AES-GCM 可用）' : '否（AES-GCM 不可用，传输仍 DTLS-SRTP 加密）'), 'info');
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
  }).catch((e) => log('无法进入全屏：' + e.message, 'warn'));
}
function exitScreenFs() { fsExit().catch(() => {}); }
function syncScreenFsButtons() {
  const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  screenFsExit.classList.toggle('hidden', !fs);
  screenFsPortrait.classList.toggle('hidden', fs);
  screenFsLandscape.classList.toggle('hidden', fs);
}

// ---------- 屏幕监看：缩放 / 平移（Ctrl+滚轮、双指捏合、拖拽） ----------
let szScale = 1, szTx = 0, szTy = 0;
let szPanning = null; // 鼠标 / 单指拖拽平移状态
let szPinch = null;   // 双指捏合状态（记录起始距离与起始 scale）
let szPinchEndedAt = 0; // 捏合结束时刻：结束后短时间内忽略单指平移，防两指不同时离开导致画面漂移
function szPinchJustEnded() { return Date.now() - szPinchEndedAt < 300; }
function szApply() {
  screenWatchVideo.style.transformOrigin = '0 0';
  screenWatchVideo.style.transform = 'translate(' + szTx + 'px,' + szTy + 'px) scale(' + szScale + ')';
  screenFsReset.classList.toggle('hidden', szScale <= 1);
}
function szReset() { szScale = 1; szTx = 0; szTy = 0; szApply(); }
function szClamp(s) { return Math.min(8, Math.max(1, s)); }
// 平移钳制：让缩放后的视频框始终覆盖舞台（scale=1 时强制 tx=ty=0 居中），
// 既避免把画面拖飞，也消除“捏合缩小回 scale=1 却残留偏移→卡在左上角”的问题。
function szClampPan() {
  if (!(document.fullscreenElement === screenWatchStage || document.webkitFullscreenElement === screenWatchStage)) return;
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
  if (typeof sendWatchInfo === 'function') { clearTimeout(szWatchInfoTimer); szWatchInfoTimer = setTimeout(sendWatchInfo, 400); } // 缩放后提升下发清晰度
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
});
window.addEventListener('mouseup', () => { szPanning = null; });
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
  }
}, { passive: false });
function szTouchEnd(e) {
  if (szPinch && e.touches.length < 2) { szPinch = null; szPinchEndedAt = Date.now(); } // 捏合结束→记时刻，触发防抖
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

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
else initUI();
