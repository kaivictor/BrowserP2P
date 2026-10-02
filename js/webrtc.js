// webrtc.js —— 连接 / 信令 / DataChannel 消息（文件传输、聊天、通话）

// 把候选行解析成 “地址:端口(类型)” 摘要，用于日志展示目标地址
function candidateTargets(cands) {
  if (!cands || !cands.length) return '';
  const out = [];
  for (const c of cands) {
    const m = c.match(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ (\S+)/);
    if (m) out.push(m[1] + ':' + m[2] + '(' + m[3] + ')');
  }
  return out.join(', ');
}
// 取当前连接实际选定的 ICE 候选对（本端/对端地址）
function getSelectedPair() {
  try {
    let ice = null;
    if (pc.sctp && pc.sctp.transport) ice = pc.sctp.transport.iceTransport;
    else {
      const tr = pc.getTransceivers().find((x) => x.receiver && x.receiver.transport);
      if (tr) ice = tr.receiver.transport.iceTransport;
    }
    if (ice && typeof ice.getSelectedCandidatePair === 'function') return ice.getSelectedCandidatePair();
  } catch (e) { /* 忽略 */ }
  return null;
}

function waitIceComplete(connection, timeoutMs) {
  return new Promise((resolve) => {
    if (connection.iceGatheringState === 'complete') return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; connection.removeEventListener('icegatheringstatechange', check); resolve(); } };
    const check = () => { if (connection.iceGatheringState === 'complete') finish(); };
    connection.addEventListener('icegatheringstatechange', check);
    setTimeout(finish, timeoutMs || 3500);
  });
}

function onConnectionStateChange() {
  const s = pc.connectionState;
  logT('WebRTC', '连接状态：' + s, s === 'connected' ? 'ok' : 'info');
  // 连接建立后，若用户还开着二维码全屏，自动关闭
  if (s === 'connected') {
    const pair = getSelectedPair();
    if (pair && pair.remote) {
      const r = pair.remote, l = pair.local;
      const ra = (r.ip != null ? r.ip : r.address), rp = r.port, rt = (r.type || r.candidateType);
      const la = (l && (l.ip != null ? l.ip : l.address)), lp = l && l.port, lt = (l && (l.type || l.candidateType));
      logT('WebRTC', '连接成功，对端地址：' + ra + ':' + rp + '（' + rt + '） ← 本端 ' + la + ':' + lp + '（' + lt + '）', 'ok');
    } else {
      logT('WebRTC', '连接成功（已建立 DataChannel）。', 'ok');
    }
    if (!qrFullscreen.classList.contains('hidden')) hideQRFullscreen();
    // 若身份页已“先选好要共享的屏幕”，连接建立后自动开始共享
    if (pendingScreenStream) {
      const ps = pendingScreenStream; pendingScreenStream = null;
      goPage('page-screen');
      beginScreenShare(ps).catch((e) => logT('WebRTC', '连接后自动共享失败：' + e.message, 'err'));
    }
  } else if (s === 'disconnected' || s === 'failed' || s === 'closed') {
    // 连接断开（对端离开/网络异常）：隐藏“进入功能中心”按钮
    if (typeof refreshConnectedNav === 'function') refreshConnectedNav();
  }
}

async function createOffer() {
  encryptionEnabled = encToggle.checked && hasSubtle;
  if (encToggle.checked && !hasSubtle) logT('WebRTC', '当前非安全上下文，AES-GCM 不可用，已自动关闭加密。', 'warn');
  sessionFingerprint = uuid();
  if (encryptionEnabled) encRawKey = crypto.getRandomValues(new Uint8Array(32));
  pc = new RTCPeerConnection({ iceServers: STUN });
  logT('WebRTC', '尝试连接：STUN 服务器 ' + STUN.map((s) => s.urls).join('、'), 'info');
  dc = pc.createDataChannel(DC_LABEL, { ordered: true });
  dc.binaryType = 'arraybuffer';
  setupDataChannel(dc);
  audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  restrictAudioCodec();
  pc.ontrack = onRemoteTrack;
  pc.onconnectionstatechange = onConnectionStateChange;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceComplete(pc);

  const info = parseSdpBasic(pc.localDescription.sdp);
  const sdpTrim = extractSdp(pc.localDescription.sdp);
  const sdpField = await encodeSdpField(sdpTrim);
  const payload = {
    t: 'offer', f: info.fpB64,
    z: sdpField.z, c: sdpField.c,
    cd: bytesToBase64url(packCandidates(info.cands)), fp: sessionFingerprint
  };
  if (encryptionEnabled) payload.enc = { k: bytesToBase64(encRawKey) };
  offerOut.value = await encodePayload(payload);
  copyOffer.classList.remove('hidden');
  showOfferQR.classList.remove('hidden');
}

async function processOffer(code) {
  const payload = await decodePayload(code);
  role = 'answerer';
  sessionFingerprint = payload.fp;
  if (payload.enc && hasSubtle) {
    encryptionEnabled = true;
    encRawKey = base64ToBytes(payload.enc.k);
    encKey = await crypto.subtle.importKey('raw', encRawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } else {
    encryptionEnabled = false; encKey = null;
    if (payload.enc && !hasSubtle) logT('WebRTC', '收到加密会话但当前环境不支持，将按明文接收。', 'warn');
  }
  pc = new RTCPeerConnection({ iceServers: STUN });
  pc.ondatachannel = (e) => { dc = e.channel; dc.binaryType = 'arraybuffer'; setupDataChannel(dc); };
  pc.onconnectionstatechange = onConnectionStateChange;
  pc.ontrack = onRemoteTrack;

  const { sdp: offerSdp, cands: offerCands } = await decodeSdp(payload);
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await addRemoteCandidates(pc, offerCands);
    logT('WebRTC', '尝试连接：对方候选地址 ' + (candidateTargets(offerCands) || '(无)') + '（STUN ' + STUN.map((s) => s.urls).join('、') + '）', 'info');
  } catch (e) {
    console.error('[SDP 重建失败·Offer] 解析用的 SDP：\n' + offerSdp.split('\r\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
    console.error('[SDP 重建失败·Offer] 原始 payload：', payload);
    throw e;
  }
  const aTs = pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
  if (aTs) { audioTransceiver = aTs; aTs.direction = 'sendrecv'; restrictAudioCodec(); }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceComplete(pc);

  const infoA = parseSdpBasic(pc.localDescription.sdp);
  const ansField = await encodeSdpField(extractSdp(pc.localDescription.sdp));
  const ans = {
    t: 'answer', f: infoA.fpB64,
    z: ansField.z, c: ansField.c,
    cd: bytesToBase64url(packCandidates(infoA.cands)), fp: sessionFingerprint
  };
  if (payload.enc) ans.enc = payload.enc;
  answerOut.value = await encodePayload(ans);
  answerOutWrap.classList.remove('hidden');
  copyAnswer.classList.remove('hidden');
  showAnswerQR.classList.remove('hidden');
}

async function processAnswer(code) {
  const payload = await decodePayload(code);
  if (payload.fp !== sessionFingerprint) logT('WebRTC', '⚠️ 应答指纹不匹配！', 'warn');
  if (payload.enc && hasSubtle && !encKey) {
    encryptionEnabled = true;
    encRawKey = base64ToBytes(payload.enc.k);
    encKey = await crypto.subtle.importKey('raw', encRawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  const { sdp: answerSdp, cands: answerCands } = await decodeSdp(payload);
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await addRemoteCandidates(pc, answerCands);
    logT('WebRTC', '尝试连接：对方候选地址 ' + (candidateTargets(answerCands) || '(无)') + '（STUN ' + STUN.map((s) => s.urls).join('、') + '）', 'info');
  } catch (e) {
    console.error('[SDP 重建失败·Answer] 解析用的 SDP：\n' + answerSdp.split('\r\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
    console.error('[SDP 重建失败·Answer] 原始 payload：', payload);
    throw e;
  }
  logT('WebRTC', '已设置应答，等待 DataChannel 建立…', 'info');
}

function setupDataChannel(channel) {
  channel.onopen = () => {
    const max = (channel.maxMessageSize && channel.maxMessageSize > 0) ? channel.maxMessageSize : 65536;
    const overhead = encryptionEnabled ? (ENC_HEADER + 16) : 9;
    CHUNK = Math.max(1024, Math.min(MAX_PAYLOAD, max - overhead - 64));
    logT('WebRTC', 'DataChannel 已建立（maxMessageSize=' + max + '，分块=' + CHUNK + '）。', 'ok');
    setBadge('已连接', 'on');
    channel.send(JSON.stringify({ type: 'fp', value: sessionFingerprint }));
    if (typeof onChannelOpen === 'function') onChannelOpen();
    if (typeof setWakeConnected === 'function') setWakeConnected(true); // 连接建立即保持屏幕常亮，避免息屏断连
  };
  channel.onclose = () => { setBadge('已断开', 'off'); logT('WebRTC', 'DataChannel 已关闭。', 'warn'); if (typeof refreshConnectedNav === 'function') refreshConnectedNav(); if (typeof setWakeConnected === 'function') setWakeConnected(false); };
  channel.onmessage = handleMessage;
}

// ---------- 消息分发 ----------
function handleMessage(e) {
  if (typeof e.data === 'string') {
    let msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
    switch (msg.type) {
      case 'fp':
        if (msg.value !== sessionFingerprint) { logT('WebRTC', '⚠️ 会话指纹不匹配，疑似中间人攻击，已关闭通道！', 'err'); dc.close(); }
        else logT('WebRTC', '会话指纹校验通过 ✓', 'ok');
        break;
      case 'file-meta': onFileMeta(msg); break;
      case 'file-complete': onFileComplete(msg); break;
      case 'chat': onChat(msg); break;
      case 'resume-request': onResumeRequest(msg); break;
      case 'call-invite': onCallInvite(); break;
      case 'call-join': onCallJoin(); break;
      case 'call-reject': onCallReject(); break;
      case 'call-end': onCallEnd(); break;
      // 屏幕共享 / 剪贴板（实现见 features.js）
      case 'sdp-offer': onSdpOffer(msg); break;
      case 'sdp-answer': onSdpAnswer(msg); break;
      case 'screen-start': onScreenStart(); break;
      case 'screen-stop': onScreenStop(); break;
      case 'screen-request-keyframe': onScreenRequestKeyframe(); break;
      case 'screen-abr': onScreenAbr(msg); break;
      case 'screen-watch-info': onScreenWatchInfo(msg); break;
      case 'screen-crop': onScreenCrop(msg); break; // 发送端告知“正在/已停止 Canvas 裁切”，监看端据此切换显示
      case 'clipboard': onClipboard(msg); break;
    }
  } else {
    handleBinary(e.data);
  }
}

// ---------- 接收：文件元信息 / 完成 / 补传 ----------
function onFileMeta(msg) {
  if (msg.chat) { onChatVoiceMeta(msg); return; }
  const cs = msg.chunkSize || MAX_PAYLOAD;
  const total = Math.ceil(msg.size / cs) || 1;
  if (streamingMode && hasFSAccess) {
    const rec = {
      fileId: msg.fileId, meta: msg, chunkSize: cs, totalChunks: total,
      streaming: true, receivedFlags: new Array(total), receivedCount: 0, receivedBytes: 0,
      writer: null, handle: null, buffer: null, needsSave: false, closed: false, pendingFinalize: false, item: null
    };
    incoming.set(msg.fileId, rec);
    rec.item = makeTransferItem({ name: '📥 ' + msg.name, size: msg.size });
    updateTransferStatus(rec.item, '接收中…（流式写盘）', null);
    openSaveForRec(rec).catch(() => {
      if (rec.meta.size <= DIRECT_DOWNLOAD_MAX) { rec.classicFallback = true; logT('文件', '保存位置选择被浏览器拦截（需用户手势）；小文件将自动下载到默认位置。', 'warn'); }
      else { rec.needsSave = true; addSaveButton(rec); updateTransferStatus(rec.item, '请点击「选择保存位置」', 'warn'); logT('文件', '大文件需要选择保存位置：' + msg.name, 'warn'); }
    });
    logT('文件', '收到文件元信息（流式写盘）：' + msg.name + ' (' + formatBytes(msg.size) + ')', 'info');
    return;
  }
  const rec = { fileId: msg.fileId, meta: msg, chunkSize: cs, chunks: new Array(total), received: 0, receivedBytes: 0, item: null };
  incoming.set(msg.fileId, rec);
  rec.item = makeTransferItem({ name: '📥 ' + msg.name, size: msg.size });
  updateTransferStatus(rec.item, '接收中…', null);
  idbSaveMeta(rec);
  logT('文件', '收到文件元信息：' + msg.name + ' (' + formatBytes(msg.size) + ')', 'info');
}

function onFileComplete(msg) {
  const rec = incoming.get(msg.fileId);
  if (!rec) return;
  if (rec.streaming) {
    if (rec.receivedCount === rec.totalChunks) {
      if (rec.classicFallback) doClassicFromBuffer(rec);
      else finalizeStreaming(rec);
    } else requestMissing(rec, rec.totalChunks, (i) => !rec.receivedFlags[i], msg.fileId);
    return;
  }
  if (rec.received === rec.chunks.length) {
    if (rec.chat) assembleChatVoice(msg.fileId);
    else assembleFile(msg.fileId);
  } else {
    const missing = [];
    for (let i = 0; i < rec.chunks.length; i++) if (!rec.chunks[i]) missing.push(i);
    logT('文件', '缺失 ' + missing.length + ' 个分块，向对方请求补传…', 'warn');
    dc.send(JSON.stringify({ type: 'resume-request', fileId: msg.fileId, missing }));
  }
}

function requestMissing(rec, total, isMissing, fileId) {
  const missing = [];
  for (let i = 0; i < total; i++) if (isMissing(i)) missing.push(i);
  if (!missing.length) return;
  logT('文件', '缺失 ' + missing.length + ' 个分块，向对方请求补传…', 'warn');
  dc.send(JSON.stringify({ type: 'resume-request', fileId, missing }));
}

async function onResumeRequest(msg) {
  const send = activeSends.get(msg.fileId);
  if (!send) { logT('文件', '收到补传请求，但本地无该文件记录。', 'warn'); return; }
  logT('文件', '收到补传请求，补传 ' + msg.missing.length + ' 个分块…', 'info');
  for (const i of msg.missing) {
    while (dc.bufferedAmount > BUFFER_THRESHOLD) await sleep(15);
    const chunk = await readChunk(send.file, i);
    const frame = await buildFrame(msg.fileId, i, chunk);
    dc.send(frame);
  }
  logT('文件', '补传完成。', 'ok');
}

async function handleBinary(buf) {
  const dv = new DataView(buf);
  const tag = dv.getUint8(0);
  const chunkIndex = dv.getUint32(1, false);
  const fileId = dv.getUint32(5, false);
  let payload;
  if (tag === TAG_PLAIN) {
    payload = new Uint8Array(buf, 9);
  } else if (tag === TAG_ENC) {
    if (!encKey) { logT('文件', '收到加密分块但本地无密钥，已忽略。', 'err'); return; }
    const ivRandom = new Uint8Array(buf, 9, 8);
    const ct = new Uint8Array(buf, ENC_HEADER);
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setUint32(0, chunkIndex, false);
    iv.set(ivRandom, 4);
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, encKey, ct);
      payload = new Uint8Array(plain);
    } catch (err) { logT('文件', '分块解密失败：' + err.message, 'err'); return; }
  } else return;
  const rec = incoming.get(fileId);
  if (!rec) { logT('文件', '收到未知 fileId 的分块，已忽略。', 'warn'); return; }

  if (rec.streaming) {
    if (!rec.receivedFlags[chunkIndex]) {
      rec.receivedFlags[chunkIndex] = true;
      rec.receivedCount++;
      rec.receivedBytes += payload.length;
      if (rec.writer) { try { await rec.writer.write(payload); } catch (e) { logT('文件', '写入磁盘失败：' + e.message, 'err'); } }
      else (rec.buffer || (rec.buffer = new Array(rec.totalChunks)))[chunkIndex] = payload;
      updateTransferProgress(rec.item, rec.receivedBytes, rec.meta.size);
    }
    if (rec.receivedCount === rec.totalChunks) {
      if (rec.classicFallback) await doClassicFromBuffer(rec);
      else await finalizeStreaming(rec);
    }
    return;
  }

  if (!rec.chunks[chunkIndex]) {
    rec.chunks[chunkIndex] = payload;
    rec.received++;
    rec.receivedBytes += payload.length;
    updateTransferProgress(rec.item || rec.chatBubble, rec.receivedBytes, rec.meta.size);
    if (!rec.chat) idbSaveChunk(fileId, chunkIndex, payload);
  }
  if (rec.received === rec.chunks.length) {
    if (rec.chat) assembleChatVoice(fileId);
    else assembleFile(fileId);
  }
}

// ---------- 发送 ----------
function nextFileId() { return (myFileIdCounter = (myFileIdCounter + 1) >>> 0); }

async function readChunk(file, index) {
  const start = index * CHUNK;
  const slice = file.slice(start, start + CHUNK);
  return await blobToBytes(slice);
}

async function buildFrame(fileId, chunkIndex, payloadBytes) {
  if (encryptionEnabled && encKey) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setUint32(0, chunkIndex, false);
    crypto.getRandomValues(iv.subarray(4));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, payloadBytes);
    const out = new Uint8Array(ENC_HEADER + ct.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, TAG_ENC);
    dv.setUint32(1, chunkIndex, false);
    dv.setUint32(5, fileId, false);
    out.set(iv.subarray(4), 9);
    out.set(new Uint8Array(ct), ENC_HEADER);
    return out.buffer;
  }
  const out = new Uint8Array(9 + payloadBytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, TAG_PLAIN);
  dv.setUint32(1, chunkIndex, false);
  dv.setUint32(5, fileId, false);
  out.set(payloadBytes, 9);
  return out.buffer;
}

async function sendFiles(fileList) {
  if (!dc || dc.readyState !== 'open') { const m = 'DataChannel 尚未就绪，无法发送（请确认连接状态为“已连接”）。'; logT('文件', m, 'err'); alert(m); return; }
  logT('文件', '开始发送 ' + fileList.length + ' 个文件…', 'info');
  for (const file of fileList) {
    try { await sendFile(file); }
    catch (e) { logT('文件', '发送失败：' + e.message, 'err'); }
  }
}

async function sendFile(file) {
  const fileId = nextFileId();
  const totalChunks = Math.ceil(file.size / CHUNK) || 1;
  const item = makeTransferItem({ name: '📤 ' + file.name, size: file.size });
  updateTransferStatus(item, '准备中…', null);
  activeSends.set(fileId, { file, totalChunks });
  logT('文件', '发送文件：' + file.name + ' (' + formatBytes(file.size) + ', ' + totalChunks + ' 分块)', 'info');
  let hashHex = null;
  if (hasSubtle) { try { hashHex = await sha256OfBlob(file); } catch (e) { logT('文件', '校验和计算失败：' + e.message, 'warn'); } }
  try {
    dc.send(JSON.stringify({ type: 'file-meta', fileId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream', hash: hashHex, chunkSize: CHUNK }));
  } catch (e) { logT('文件', '发送元信息失败：' + e.message, 'err'); throw e; }
  let sent = 0;
  for (let i = 0; i < totalChunks; i++) {
    while (dc.bufferedAmount > BUFFER_THRESHOLD) await sleep(15);
    const chunk = await readChunk(file, i);
    const frame = await buildFrame(fileId, i, chunk);
    try { dc.send(frame); }
    catch (e) { logT('文件', '分块 #' + i + ' 发送失败：' + e.message + '（可能超过单条消息上限）', 'err'); throw e; }
    sent += chunk.length;
    updateTransferProgress(item, sent, file.size);
    if (i % 8 === 0) await sleep(0);
  }
  dc.send(JSON.stringify({ type: 'file-complete', fileId, totalChunks, hash: hashHex }));
  updateTransferStatus(item, '已发送 ✓', 'ok');
  logT('文件', '已发送：' + file.name, 'ok');
}

// ---------- 聊天（文字 + 语音） ----------
function scrollChat() { chatMessages.scrollTop = chatMessages.scrollHeight; }
function addChatBubble(side) {
  const el = document.createElement('div');
  el.className = 'chat-msg ' + (side === 'me' ? 'me' : 'them');
  const body = document.createElement('div'); body.className = 'chat-body';
  const meta = document.createElement('div'); meta.className = 'chat-meta';
  meta.textContent = new Date().toLocaleTimeString();
  el.appendChild(body); el.appendChild(meta);
  chatMessages.appendChild(el); scrollChat();
  return { el, body, meta };
}
function appendChatText(side, text) {
  const b = addChatBubble(side);
  const p = document.createElement('div'); p.className = 'chat-text';
  p.textContent = text; b.body.appendChild(p);
  return b;
}
function appendChatAudio(side, url) {
  const b = addChatBubble(side);
  const a = document.createElement('audio'); a.controls = true; a.src = url;
  b.body.appendChild(a);
  return b;
}

async function onChat(msg) {
  if (msg.kind !== 'text') return;
  let text = msg.text;
  if (msg.enc && encKey) text = await decryptText(msg.enc);
  if (text == null) { logT('聊天', '收到无法解密的聊天消息，已忽略。', 'warn'); return; }
  appendChatText('them', text);
  chatBytes += new Blob([text]).size; updateChatCap();
}
async function sendText() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!dc || dc.readyState !== 'open') { logT('聊天', 'DataChannel 未就绪，无法发送消息。', 'err'); return; }
  appendChatText('me', text);
  chatBytes += new Blob([text]).size; updateChatCap();
  chatInput.value = '';
  let enc = null;
  if (encryptionEnabled && encKey) { try { enc = await encryptText(text); } catch (e) {} }
  dc.send(JSON.stringify({ type: 'chat', kind: 'text', id: uuid(), ts: Date.now(), enc, text: enc ? undefined : text }));
}

// ---------- 语音消息 ----------
// 录音策略：优先用 MediaRecorder（WebRTC 媒体引擎，各平台都能拿到真实声音，且接收方兼容性最好）；
// 仅当浏览器无 MediaRecorder（如本机 iOS<14）时，回退到 Web Audio 采集 PCM 并手动编码 WAV。
// 两条路径都依赖 audioPrimer（muted=true 的 <video>）播放麦克风流来激活 iOS 采集管线——
// 这是本机（无 MediaRecorder）能采到真实声音的关键，切勿改成 muted=false/volume=0。
const voiceSupported = (typeof MediaRecorder === 'function');
const ACtor = window.AudioContext || window.webkitAudioContext;
const wavSupported = !!ACtor;
// ---------- iOS 音频解锁 ----------
// iOS Safari 的音频会话默认被挂起：麦克风即便 track 为 live，也不会向 WebRTC / Web Audio
// 投递采样，且不报错（正是“轨道 live 但录不到声音”的根因）。需在用户手势内创建/恢复 AudioContext
// 并播放一段静音来“解锁”音频会话，之后 WebRTC 发送端与 Web Audio 录制才能拿到真实采样。
// 使用单例 AudioContext：首次在用户手势内创建并 resume，后续复用（避免多个挂起上下文）。
let sharedAudioCtx = null, audioUnlocked = false;
function getAudioCtx() {
  if (!sharedAudioCtx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (C) { try { sharedAudioCtx = new C(); } catch (e) {} }
  }
  if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume().catch(() => {});
  return sharedAudioCtx;
}
function ensureAudioUnlock() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (!audioUnlocked) {
    audioUnlocked = true;
    try {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination);
      if (src.start) src.start(0);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      logT('语音', '已尝试解锁 iOS 音频会话（静音探测）。', 'info');
    } catch (e) { logT('语音', '解锁音频会话失败：' + e.message, 'warn'); }
  }
}
document.addEventListener('touchend', ensureAudioUnlock);
document.addEventListener('click', ensureAudioUnlock);
let recording = false;
// —— MediaRecorder 路径 ——
let mediaRecorder = null, recChunks = [], recStream = null;
// —— WAV 降级路径 ——
let wavCtx = null, wavSource = null, wavNode = null, wavChunks = [], wavStream = null, wavPeak = 0;
function pickVoiceMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const m of cands) if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
function setRecUI(on) { chatMic.textContent = on ? '⏹ 停止' : '🎤 录音'; chatMic.classList.toggle('recording', on); }
async function startVoice() {
  ensureAudioUnlock();
  if (recording) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { logT('语音', '当前环境不支持麦克风（需 HTTPS/localhost）。', 'warn'); return; }
  // iOS 会静音 Web Audio 输入，故在 iOS 上优先用 MediaRecorder（WebRTC 媒体引擎，能拿到真实声音）；
  // 其它浏览器保持 WAV 优先，以保证旧 Safari 接收方也能播放。
  const ios = isIOS();
  if (ios && voiceSupported) {
    startVoiceMedia();
  } else if (wavSupported) {
    startVoiceWav();
  } else if (voiceSupported) {
    startVoiceMedia();
  } else {
    logT('语音', '当前浏览器不支持语音录制（无 MediaRecorder 且不支持 Web Audio）。', 'warn');
  }
}
// MediaRecorder 路径（iOS 优先）：走 WebRTC 媒体引擎采集，iOS 不会静音。
// 关键：iOS 必须把麦克风流挂到“正在播放（静音）”的媒体元素才会真正采集；
// 且 MediaRecorder 要用 timeslice 才能稳定产出数据（否则常为空）。
async function startVoiceMedia() {
  try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { logT('语音', '麦克风权限被拒绝：' + e.message, 'warn'); return; }
  const tr = recStream.getAudioTracks()[0];
  logT('语音', '录音已获取麦克风：' + (tr ? tr.label : '无') + '，readyState=' + (tr ? tr.readyState : '?'), 'info');
  // iOS 激活采集：挂到“正在播放且非静音”的媒体元素（muted=false+volume=0，无回放但 iOS 视为在播放）
  if (audioPrimer) {
    try {
      audioPrimer.srcObject = recStream; audioPrimer.muted = true;
      const pp = audioPrimer.play();
      if (pp && pp.catch) pp.catch((er) => logT('语音', '录音激活元素播放被拒：' + er.message, 'warn'));
    } catch (e) {}
  }
  recChunks = [];
  const mime = pickVoiceMime();
  try { mediaRecorder = mime ? new MediaRecorder(recStream, { mimeType: mime }) : new MediaRecorder(recStream); }
  catch (e) { logT('语音', '无法创建录音器：' + e.message, 'err'); if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; } return; }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = onVoiceStop;
  // iOS 上用 timeslice 才能稳定产出数据（否则常为空）
  try { mediaRecorder.start(200); } catch (e) { try { mediaRecorder.start(); } catch (e2) { logT('语音', '录音启动失败：' + e2.message, 'err'); return; } }
  recording = true; setRecUI(true); logT('语音', '开始录音（MediaRecorder）…', 'info');
}
function stopVoice() {
  if (voiceSupported && mediaRecorder && recording) mediaRecorder.stop();
  else if (wavSupported && recording) stopVoiceWav();
}
function onVoiceStop() {
  recording = false; setRecUI(false);
  if (recStream) {
    if (audioPrimer && audioPrimer.srcObject === recStream) audioPrimer.srcObject = null;
    recStream.getTracks().forEach((t) => t.stop()); recStream = null;
  }
  const blob = new Blob(recChunks, { type: (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm' });
  recChunks = [];
  finalizeVoice(blob);
}
// WAV 降级：Web Audio 采集 + 手动编码 WAV（兼容无 MediaRecorder 的旧浏览器）
async function startVoiceWav() {
  wavCtx = getAudioCtx();
  if (!wavCtx) { logT('语音', '当前浏览器不支持 Web Audio，无法录音。', 'warn'); return; }
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(async (stream) => {
      wavStream = stream; wavChunks = []; wavPeak = 0;
      const tr = stream.getAudioTracks()[0];
      logT('语音', '录音已获取麦克风：' + (tr ? tr.label : '无') + '，readyState=' + (tr ? tr.readyState : '?') + '，muted=' + (tr ? tr.muted : '?'), 'info');
      // iOS 需把本地流接到“正在播放且非静音”的媒体元素才能激活 Web Audio 采集；
      // muted=true 不会切到录音会话，故用 muted=false + volume=0（无 audible 回放，但 iOS 视为在播放）。
      if (audioPrimer) {
        try {
          audioPrimer.srcObject = stream; audioPrimer.muted = true;
          const pp = audioPrimer.play();
          if (pp && pp.then) pp.then(() => {}).catch((er) => logT('语音', '录音激活元素播放被拒：' + er.message, 'warn'));
        } catch (e) {}
      }
      if (wavCtx.state === 'suspended') { try { await wavCtx.resume(); } catch (e) {} }
      wavSource = wavCtx.createMediaStreamSource(stream);
      // ScriptProcessorNode 在旧 Safari 也受支持；必须连到 destination 才会触发 onaudioprocess（输出保持静音，不会回放麦克风）
      wavNode = wavCtx.createScriptProcessor(4096, 1, 1);
      wavNode.onaudioprocess = (e) => {
        if (!recording) return;
        const d = e.inputBuffer.getChannelData(0);
        wavChunks.push(new Float32Array(d));
        let pk = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; }
        if (pk > wavPeak) wavPeak = pk;
      };
      wavSource.connect(wavNode); wavNode.connect(wavCtx.destination);
      recording = true; setRecUI(true); logT('语音', '开始录音…', 'info');
      // 1 秒后无需停止即可观察是否有数据流入（峰值 >0 代表麦克风真的在出声）
      setTimeout(() => { if (recording) logT('语音', '录音进行中·采样峰值（≈0=静音）：' + wavPeak.toFixed(4), wavPeak > 0.001 ? 'ok' : 'warn'); }, 1000);
    })
    .catch((e) => { logT('语音', '麦克风权限被拒绝：' + e.message, 'warn'); });
}
function stopVoiceWav() {
  recording = false; setRecUI(false);
  logT('语音', '录音采样峰值（≈0 表示未真正采集到声音）：' + wavPeak.toFixed(4), wavPeak > 0.001 ? 'ok' : 'warn');
  const rate = wavCtx ? wavCtx.sampleRate : 16000;
  try { if (wavSource) wavSource.disconnect(); } catch (e) {}
  try { if (wavNode) wavNode.disconnect(); } catch (e) {}
  // 注意：wavCtx 为单例 AudioContext，不要 close，否则下次录音无法复用
  if (wavStream) {
    if (audioPrimer && audioPrimer.srcObject === wavStream) audioPrimer.srcObject = null;
    wavStream.getTracks().forEach((t) => t.stop()); wavStream = null;
  }
  if (!wavChunks.length) { logT('语音', '录音过短，已忽略。', 'warn'); return; }
  const blob = encodeWav(wavChunks, rate);
  wavChunks = [];
  finalizeVoice(blob);
}
// 将 Float32 PCM 片段编码为 16bit 单声道 WAV
function encodeWav(chunks, sampleRate) {
  let len = 0; for (const c of chunks) len += c.length;
  const samples = new Float32Array(len); let off = 0;
  for (const c of chunks) { samples.set(c, off); off += c.length; }
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer); let p = 0;
  const wstr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); };
  const u32 = (v) => { view.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { view.setUint16(p, v, true); p += 2; };
  wstr('RIFF'); u32(36 + dataSize); wstr('WAVE');
  wstr('fmt '); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16);
  wstr('data'); u32(dataSize);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true); p += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}
function finalizeVoice(blob) {
  if (!blob || blob.size < 200) { logT('语音', '录音过短，已忽略。', 'warn'); return; }
  const ext = blob.type.indexOf('wav') >= 0 ? 'wav' : (blob.type.indexOf('mp4') >= 0 ? 'm4a' : 'webm');
  const name = 'voice-' + Date.now() + '.' + ext;
  appendChatAudio('me', URL.createObjectURL(blob));
  chatBytes += blob.size; updateChatCap();
  sendChatVoice(blob, name).catch((e) => logT('语音', '语音发送失败：' + e.message, 'err'));
}
async function sendChatVoice(blob, name) {
  if (!dc || dc.readyState !== 'open') { logT('语音', 'DataChannel 未就绪，无法发送语音。', 'err'); return; }
  const fileId = nextFileId();
  const totalChunks = Math.ceil(blob.size / CHUNK) || 1;
  activeSends.set(fileId, { file: blob, totalChunks });
  let hashHex = null;
  if (hasSubtle) { try { hashHex = await sha256OfBlob(blob); } catch (e) {} }
  dc.send(JSON.stringify({ type: 'file-meta', fileId, name, size: blob.size, mime: blob.type || 'audio/webm', hash: hashHex, chunkSize: CHUNK, chat: true }));
  let sent = 0;
  for (let i = 0; i < totalChunks; i++) {
    while (dc.bufferedAmount > BUFFER_THRESHOLD) await sleep(15);
    const chunk = await readChunk(blob, i);
    const frame = await buildFrame(fileId, i, chunk);
    try { dc.send(frame); }
    catch (e) { logT('语音', '语音分块 #' + i + ' 发送失败：' + e.message, 'err'); return; }
    sent += chunk.length;
    if (i % 16 === 0) await sleep(0);
  }
  dc.send(JSON.stringify({ type: 'file-complete', fileId, totalChunks, hash: hashHex, chat: true }));
  logT('语音', '语音已发送（' + formatBytes(blob.size) + '）', 'ok');
}
function onChatVoiceMeta(msg) {
  const cs = msg.chunkSize || MAX_PAYLOAD;
  const total = Math.ceil(msg.size / cs) || 1;
  const rec = { fileId: msg.fileId, meta: msg, chunkSize: cs, chunks: new Array(total), received: 0, receivedBytes: 0, chat: true, completed: false, chatBubble: null };
  incoming.set(msg.fileId, rec);
  const b = addChatBubble('them');
  const bar = document.createElement('div'); bar.className = 'chat-bar';
  const fill = document.createElement('div'); fill.className = 'chat-fill'; bar.appendChild(fill);
  const state = document.createElement('div'); state.className = 'chat-state'; state.textContent = '接收中…';
  b.body.appendChild(bar); b.body.appendChild(state);
  rec.chatBubble = { el: b.el, body: b.body, meta: b.meta, fill, prog: state, state };
  logT('语音', '收到语音消息：' + msg.name + ' (' + formatBytes(msg.size) + ')', 'info');
}
async function assembleChatVoice(fileId) {
  const rec = incoming.get(fileId);
  if (!rec || rec.completed) return;
  rec.completed = true;
  for (let i = 0; i < rec.chunks.length; i++) if (!rec.chunks[i]) { logT('语音', '语音分块缺失，等待补传…', 'warn'); return; }
  const blob = new Blob(rec.chunks, { type: rec.meta.mime || 'audio/webm' });
  let ok = true;
  if (rec.meta.hash && hasSubtle) { try { const h = await sha256OfBlob(blob); ok = (h === rec.meta.hash); } catch (e) {} }
  rec.chatBubble.body.innerHTML = '';
  const a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(blob);
  rec.chatBubble.body.appendChild(a);
  chatBytes += blob.size; updateChatCap();
  rec.chatBubble.state.textContent = ok ? '✓' : '校验失败';
  scrollChat();
  logT('语音', '语音消息已就绪' + (ok ? ' ✓' : '（校验失败）'), ok ? 'ok' : 'err');
}

// ---------- 实时通话 ----------
function unlockRemoteAudio() {
  if (!remoteAudio || !remoteAudio.srcObject) return;
  if (!calling) return;
  if (!remoteAudio.paused) return;
  remoteAudio.muted = false;
  remoteAudio.play().catch(() => {});
}
// 安全播放监看视频：静音 + 捕获 play() 异常（隐藏态下部分浏览器会忽略 play，需显示后重试）
function playWatchVideo() {
  if (!screenWatchVideo.srcObject) return;
  screenWatchVideo.muted = true;
  const p = screenWatchVideo.play();
  if (p && p.catch) p.catch(() => {});
}
// 切后台再回来：浏览器会冻结视频最后一帧、不再重绘（连接/消息不受影响），
// 重新挂载 srcObject 并 play 以强制恢复监看画面渲染。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!screenWatchVideo.srcObject) return;
  const stream = screenWatchVideo.srcObject;
  screenWatchVideo.srcObject = null;
  requestAnimationFrame(() => {
    screenWatchVideo.srcObject = stream; // 重新挂载，触发媒体源重新获取与重绘
    playWatchVideo();
  });
  logT('WebRTC', '已从后台返回，正在恢复监看画面…', 'info');
});
function onRemoteTrack(e) {
  if (e.track && e.track.kind === 'audio') {
    remoteAudio.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    unlockRemoteAudio();
  } else if (e.track && e.track.kind === 'video') {
    const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    screenWatchVideo.srcObject = stream;
    screenWatchVideo.muted = true; // 确保满足自动播放策略，避免黑屏
    playWatchVideo();
    // 媒体就绪 / 可播放时再补一次 play（隐藏态 play 被忽略的常见黑屏根因）
    screenWatchVideo.addEventListener('loadedmetadata', playWatchVideo, { once: true });
    screenWatchVideo.addEventListener('canplay', playWatchVideo, { once: true });
    screenWatchVideo.addEventListener('playing', () => { screenStatus.textContent = '正在监看对方的屏幕…'; }, { once: true });
    screenWatchWrap.classList.remove('hidden');
    screenStatus.textContent = '正在监看对方的屏幕…';
  }
}
function setCallState(text, live) {
  callState.textContent = text;
  callState.className = 'call-state' + (live ? ' live' : '');
}
async function activateMic() {
  ensureAudioUnlock();
  if (!dc || dc.readyState !== 'open') { logT('通话', 'DataChannel 未就绪，无法通话。', 'err'); return false; }
  if (!audioTransceiver) { logT('通话', '本连接未协商音频轨道，无法通话。', 'err'); return false; }
  if (calling) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { logT('通话', '当前环境不支持麦克风（需 HTTPS/localhost）。', 'warn'); return false; }
  // 旧 Safari 对 echoCancellation/noiseSuppression/autoGainControl 等高级约束支持不稳，
  // 直接用最兼容的 { audio: true } 获取，避免返回“空转/静音”轨道。
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) { logT('通话', '麦克风权限被拒绝或不可用：' + e.message, 'warn'); return false; }
  micTrack = localStream.getAudioTracks()[0];
  if (!micTrack) { logT('通话', 'getUserMedia 返回了空音频轨道，无法通话。', 'err'); return false; }
  logT('通话', '已获取麦克风：' + (micTrack.label || '默认') + '，轨道数=' + localStream.getAudioTracks().length + '，readyState=' + micTrack.readyState + '，muted=' + micTrack.muted, 'info');
  // 关键：Safari 需把麦克风流接到一个静音且正在播放的 <audio> 元素，采集管线才会真正启动，
  // 否则不显示麦克风标志、也不向 WebRTC 发送端投递采样（且不报错）。
  if (audioPrimer) {
    try {
      audioPrimer.srcObject = localStream; audioPrimer.muted = true;
      const pp = audioPrimer.play();
      if (pp && pp.then) pp.then(() => logT('通话', '麦克风激活元素已开始播放（采集应已激活）。', 'info')).catch((er) => logT('通话', '麦克风激活元素播放被拒：' + er.message, 'warn'));
      else logT('通话', '麦克风激活元素已开始播放（同步）。', 'info');
    }
    catch (e) { logT('通话', '麦克风激活元素播放失败：' + e.message, 'warn'); }
  }
  try { await audioTransceiver.sender.replaceTrack(micTrack); }
  catch (e) { logT('通话', '接入麦克风失败：' + e.message, 'err'); return false; }
  // 旧 Safari 在 addTransceiver 时无轨道、后续 replaceTrack 不重协商，会导致 m=audio 没有 a=ssrc，
  // 对方收不到声音且不报错。主动触发一次重协商，让 SDP 携带发送轨道。
  if (typeof reneg === 'function') {
    try { await reneg(); logT('通话', '通话音频重协商完成（已带上发送轨道）。', 'ok'); }
    catch (e) { logT('通话', '通话音频重协商失败：' + e.message, 'warn'); }
  }
  calling = true;
  // 进入通话：仅解除 disabled 不够，还必须移除 hidden，否则按钮一直不可见
  callMicMute.classList.remove('hidden'); callMute.classList.remove('hidden'); callEnd.classList.remove('hidden');
  callMicMute.disabled = false; callMute.disabled = false; callEnd.disabled = false;
  // 重置静音/闭麦状态为未静音
  callMicMute.textContent = '🎙 闭麦';
  if (remoteAudio) remoteAudio.muted = false;
  callMute.textContent = '🔇 静音';
  unlockRemoteAudio();
  logT('通话', '已接入麦克风（通话中）。', 'ok');
  return true;
}
async function initiateCall() {
  ensureAudioUnlock();
  if (!dc || dc.readyState !== 'open') { logT('通话', 'DataChannel 未就绪，无法发起通话。', 'err'); return; }
  if (calling) return;
  const ok = await activateMic();
  if (!ok) return;
  callStart.classList.add('hidden'); callJoin.classList.add('hidden'); callReject.classList.add('hidden');
  setCallState('等待对方接听…', true);
  sendCall('call-invite');
  logT('通话', '已发起通话，等待对方加入…', 'ok');
}
async function joinCall() {
  ensureAudioUnlock();
  if (calling) return;
  const ok = await activateMic();
  if (!ok) return;
  callStart.classList.add('hidden'); callJoin.classList.add('hidden'); callReject.classList.add('hidden');
  setCallState('通话中…', true);
  sendCall('call-join');
  logT('通话', '已加入通话。', 'ok');
}
function rejectCall() {
  callStart.classList.remove('hidden'); callJoin.classList.add('hidden'); callReject.classList.add('hidden');
  setCallState('未通话', false);
  sendCall('call-reject');
  logT('通话', '已拒绝通话。', 'info');
}
function endCall() {
  if (audioTransceiver && audioTransceiver.sender) audioTransceiver.sender.replaceTrack(null).catch(() => {});
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  if (audioPrimer) audioPrimer.srcObject = null;
  micTrack = null; calling = false;
  callStart.classList.remove('hidden'); callStart.disabled = false;
  callJoin.classList.add('hidden'); callReject.classList.add('hidden');
  callMute.disabled = true; callEnd.disabled = true;
  callMute.classList.add('hidden'); callEnd.classList.add('hidden');
  callMicMute.classList.add('hidden'); callMicMute.disabled = true;
  callMute.textContent = '🔇 静音'; callMicMute.textContent = '🎙 闭麦';
  setCallState('已结束', false);
  sendCall('call-end');
  logT('通话', '已结束通话。', 'info');
}
function stopCallLocal() {
  if (audioTransceiver && audioTransceiver.sender) audioTransceiver.sender.replaceTrack(null).catch(() => {});
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  if (audioPrimer) audioPrimer.srcObject = null;
  micTrack = null; calling = false;
  callStart.classList.remove('hidden'); callStart.disabled = false;
  callJoin.classList.add('hidden'); callReject.classList.add('hidden');
  callMute.disabled = true; callEnd.disabled = true;
  callMute.classList.add('hidden'); callEnd.classList.add('hidden');
  callMicMute.classList.add('hidden'); callMicMute.disabled = true;
  callMute.textContent = '🔇 静音'; callMicMute.textContent = '🎙 闭麦';
}
function sendCall(type) {
  if (dc && dc.readyState === 'open') { try { dc.send(JSON.stringify({ type })); } catch (e) {} }
}
function onCallInvite() {
  if (calling) { sendCall('call-join'); setCallState('通话中…', true); return; }
  goPage('page-call');
  callStart.classList.add('hidden');
  callJoin.classList.remove('hidden');
  callReject.classList.remove('hidden');
  setCallState('📞 对方发起通话，是否加入？', true);
  logT('通话', '收到通话邀请，可选择加入或拒绝。', 'info');
}
function onCallJoin() { setCallState('通话中…', true); logT('通话', '对方已加入，通话中。', 'ok'); }
function onCallReject() { stopCallLocal(); setCallState('对方拒绝通话', false); logT('通话', '对方拒绝了通话。', 'warn'); }
function onCallEnd() { stopCallLocal(); setCallState('对方已结束通话', false); logT('通话', '对方结束了通话。', 'info'); }
// 静音：控制“扬声器”（我听到的远端声音），而非麦克风
function toggleMute() {
  if (!remoteAudio) return;
  remoteAudio.muted = !remoteAudio.muted;
  callMute.textContent = remoteAudio.muted ? '🔊 取消静音' : '🔇 静音';
  setCallState(remoteAudio.muted ? '已静音（扬声器）' : '通话中…', true);
}
// 闭麦：控制“麦克风”（我发出的声音）
function toggleMicMute() {
  if (!micTrack) return;
  micTrack.enabled = !micTrack.enabled;
  callMicMute.textContent = micTrack.enabled ? '🎙 闭麦' : '🔇 已闭麦';
  setCallState(micTrack.enabled ? '通话中…' : '已闭麦（麦克风）', true);
}

// ---------- 接收组装 / 下载 ----------
async function assembleFile(fileId) {
  const rec = incoming.get(fileId);
  if (!rec || rec.completed) return;
  rec.completed = true;
  for (let i = 0; i < rec.chunks.length; i++) if (!rec.chunks[i]) { logT('文件', '分块缺失，等待补传…', 'warn'); return; }
  const blob = new Blob(rec.chunks, { type: rec.meta.mime || 'application/octet-stream' });
  let ok = true;
  if (rec.meta.hash && hasSubtle) {
    try {
      const h = await sha256OfBlob(blob);
      ok = (h === rec.meta.hash);
      logT('文件', ok ? ('校验通过 ✓ ' + rec.meta.name) : ('⚠️ 校验失败！' + rec.meta.name), ok ? 'ok' : 'err');
      rec.item.hash.textContent = 'SHA-256: ' + h;
    } catch (e) {}
  }
  triggerDownload(blob, rec.meta.name);
  updateTransferStatus(rec.item, ok ? '已完成 ✓' : '校验失败', ok ? 'ok' : 'err');
  idbMarkDone(fileId, ok);
}
// iOS / iPadOS 的 Safari 不支持 <a download> 属性，点击会在“当前标签页”打开文件，
// 导致单页应用被替换、返回即离开应用。这类环境改为新开标签页打开，保留应用页面。
function isIOS() {
  const ua = navigator.userAgent;
  return /iP(ad|hone|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  if (isIOS()) a.target = '_blank';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- 流式写盘 ----------
async function openSaveForRec(rec) {
  if (rec.writer) { await flushBuffer(rec); if (rec.pendingFinalize) await finalizeStreaming(rec); return; }
  const handle = await window.showSaveFilePicker({ suggestedName: rec.meta.name || 'received-file' }).catch(() => null);
  if (!handle) throw new Error('未选择保存位置');
  rec.handle = handle;
  rec.writer = await handle.createWritable();
  rec.needsSave = false;
  await flushBuffer(rec);
  if (rec.pendingFinalize) await finalizeStreaming(rec);
}
async function flushBuffer(rec) {
  if (!rec.buffer) return;
  for (let i = 0; i < rec.totalChunks; i++) {
    const p = rec.buffer[i];
    if (p) { try { await rec.writer.write(p); } catch (e) { logT('文件', '写入磁盘失败：' + e.message, 'err'); } rec.buffer[i] = null; }
  }
  rec.buffer = null;
}
function addSaveButton(rec) {
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm';
  btn.textContent = '📁 点击选择保存位置';
  btn.style.marginTop = '8px';
  btn.addEventListener('click', () => {
    btn.disabled = true; btn.textContent = '请在对话框中选择…';
    openSaveForRec(rec).then(() => { btn.remove(); }).catch((e) => { btn.disabled = false; btn.textContent = '📁 点击选择保存位置'; logT('文件', '未选择保存位置：' + e.message, 'warn'); });
  });
  rec.item.el.appendChild(btn);
}
async function finalizeStreaming(rec) {
  if (rec.closed) return;
  if (!rec.writer) { rec.pendingFinalize = true; return; }
  rec.closed = true;
  try { await rec.writer.close(); } catch (e) { logT('文件', '关闭文件失败：' + e.message, 'err'); }
  updateTransferStatus(rec.item, '已保存到磁盘 ✓', 'ok');
  logT('文件', '已保存到磁盘：' + rec.meta.name, 'ok');
  if (rec.meta.hash && hasSubtle && rec.handle) {
    try {
      const file = await rec.handle.getFile();
      const h = await hashStream(file);
      const ok = (h === rec.meta.hash);
      rec.item.hash.textContent = 'SHA-256: ' + h + (ok ? ' ✓' : ' ✗ 不匹配');
      updateTransferStatus(rec.item, ok ? '已保存 ✓（校验通过）' : '已保存（校验失败）', ok ? 'ok' : 'err');
      logT('文件', ok ? '流式校验通过 ✓ ' + rec.meta.name : '⚠️ 流式校验失败！' + rec.meta.name, ok ? 'ok' : 'err');
    } catch (e) { logT('文件', '校验失败：' + e.message, 'warn'); }
  }
  idbMarkDone(rec.fileId, true);
}
async function doClassicFromBuffer(rec) {
  if (rec.closed) return;
  rec.closed = true;
  const parts = [];
  for (let i = 0; i < rec.totalChunks; i++) if (rec.buffer[i]) parts.push(rec.buffer[i]);
  rec.buffer = null;
  const blob = new Blob(parts);
  triggerDownload(blob, rec.meta.name);
  updateTransferStatus(rec.item, '已下载 ✓', 'ok');
  logT('文件', '已下载（经典模式）：' + rec.meta.name + ' (' + formatBytes(rec.meta.size) + ')', 'ok');
  if (rec.meta.hash && hasSubtle) {
    try {
      const h = await hashStream(blob);
      const ok = (h === rec.meta.hash);
      rec.item.hash.textContent = 'SHA-256: ' + h + (ok ? ' ✓' : ' ✗ 不匹配');
      updateTransferStatus(rec.item, ok ? '已下载 ✓（校验通过）' : '已下载（校验失败）', ok ? 'ok' : 'err');
      logT('文件', ok ? '校验通过 ✓ ' + rec.meta.name : '⚠️ 校验失败！' + rec.meta.name, ok ? 'ok' : 'err');
    } catch (e) { logT('文件', '校验失败：' + e.message, 'warn'); }
  }
  idbMarkDone(rec.fileId, false);
}
function createSHA256() {
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  let H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const buf = new Uint8Array(64); let bufLen = 0, total = 0;
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  function process(block) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) w[i] = (block[i*4]<<24)|(block[i*4+1]<<16)|(block[i*4+2]<<8)|block[i*4+3];
    for (let i = 16; i < 64; i++) { const s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3); const s1 = rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10); w[i] = (w[i-16]+s0+w[i-7]+s1)|0; }
    let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6)^rotr(e,11)^rotr(e,25); const ch = (e&f)^((~e)&g); const t1 = (h+S1+ch+w[i]+K[i])|0;
      const S0 = rotr(a,2)^rotr(a,13)^rotr(a,22); const maj = (a&b)^(a&c)^(b&c); const t2 = (S0+maj)|0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0; H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
  }
  function update(chunk) { total += chunk.length; let off = 0; while (off < chunk.length) { const take = Math.min(64 - bufLen, chunk.length - off); buf.set(chunk.subarray(off, off + take), bufLen); bufLen += take; off += take; if (bufLen === 64) { process(buf); bufLen = 0; } } }
  function digest() {
    const bitLen = total * 8; buf[bufLen++] = 0x80;
    if (bufLen > 56) { while (bufLen < 64) buf[bufLen++] = 0; process(buf); bufLen = 0; }
    while (bufLen < 56) buf[bufLen++] = 0;
    const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    buf[56]=(hi>>>24)&0xff; buf[57]=(hi>>>16)&0xff; buf[58]=(hi>>>8)&0xff; buf[59]=hi&0xff;
    buf[60]=(lo>>>24)&0xff; buf[61]=(lo>>>16)&0xff; buf[62]=(lo>>>8)&0xff; buf[63]=lo&0xff;
    process(buf);
    return Array.from(H).map((x) => ('00000000' + (x>>>0).toString(16)).slice(-8)).join('');
  }
  return { update, digest };
}
async function hashStream(file) {
  const h = createSHA256();
  const reader = file.stream().getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) h.update(value); }
  return h.digest();
}

// ---------- 传输列表 UI（渲染进聊天窗口 chatMessages） ----------
function makeTransferItem(meta) {
  // 以聊天气泡形式放进 chatMessages，发送方靠右(me)、接收方靠左(them)
  const side = meta.side || (/^📤/.test(meta.name || '') ? 'me' : 'them');
  const b = addChatBubble(side);
  const el = document.createElement('div');
  el.className = 't-item';
  el.innerHTML =
    '<div class="t-head"><span class="t-name"></span><span class="t-size"></span></div>' +
    '<div class="t-bar"><div class="t-fill"></div></div>' +
    '<div class="t-meta"><span class="t-prog"></span><span class="t-state"></span></div>' +
    '<div class="t-hash"></div>';
  el.querySelector('.t-name').textContent = meta.name;
  el.querySelector('.t-size').textContent = formatBytes(meta.size);
  b.body.appendChild(el);
  return { el, fill: el.querySelector('.t-fill'), prog: el.querySelector('.t-prog'), state: el.querySelector('.t-state'), hash: el.querySelector('.t-hash') };
}
function updateTransferProgress(item, bytes, total) {
  const pct = total ? Math.min(100, (bytes / total) * 100) : 0;
  item.fill.style.width = pct + '%';
  item.prog.textContent = formatBytes(bytes) + ' / ' + formatBytes(total) + ' (' + pct.toFixed(1) + '%)';
}
function updateTransferStatus(item, text, kind) {
  item.state.textContent = text;
  item.state.className = 't-state' + (kind ? ' t-status-' + kind : '');
}

// ---------- IndexedDB 持久化（断点续传） ----------
const STORE = 'transfers';
let _db = null;
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'fileId' }); };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
function idbSaveMeta(rec) {
  return openDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ fileId: rec.fileId, meta: rec.meta, chunks: {}, receivedCount: 0, totalChunks: rec.chunks.length, status: 'receiving', updatedAt: Date.now() });
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  }));
}
function idbSaveChunk(fileId, index, buf) {
  return openDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    const get = os.get(fileId);
    get.onsuccess = () => { const rec = get.result; if (!rec) return; rec.chunks[index] = buf; rec.receivedCount = Object.keys(rec.chunks).length; rec.updatedAt = Date.now(); os.put(rec); };
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  }));
}
function idbMarkDone(fileId, ok) {
  return openDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    const get = os.get(fileId);
    get.onsuccess = () => { const rec = get.result; if (!rec) return; rec.status = ok ? 'done' : 'failed'; os.put(rec); };
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  }));
}
function idbGetAll() {
  return openDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  }));
}
async function loadHistory() {
  // 聊天页的历史传输列表已移除，这里不再渲染（保留空函数以免其它调用点报错）
}
