// test.js —— 设备测试页：摄像头测试 + 麦克风测试（录音/停止/播放循环）
// 依赖全局：goPage / log（nav,utils）、ensureAudioUnlock / getAudioCtx / encodeWav / audioPrimer（webrtc,dom）
// 注意：本机 Safari 无 MediaRecorder（iOS<14），故麦克风完全照 chat 页 startVoiceWav 的 Web Audio 路径实现。

// ---------- 摄像头 ----------
let testCamStream = null;
function toggleTestCam() {
  if (testCamStream) {
    testCamStream.getTracks().forEach((t) => t.stop());
    testCamStream = null;
    testCam.srcObject = null;
    testCamBtn.textContent = '📷 打开摄像头';
    testCamStatus.textContent = '摄像头已关闭。';
    return;
  }
  navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    .then((stream) => {
      testCamStream = stream;
      testCam.srcObject = stream;
      testCamBtn.textContent = '🛑 关闭摄像头';
      const t = stream.getVideoTracks()[0];
      testCamStatus.textContent = '摄像头已打开：' + (t ? t.label : '默认') + '。';
    })
    .catch((e) => { log('打开摄像头失败：' + e.message, 'warn'); testCamStatus.textContent = '打开失败：' + e.message; });
}

// ---------- 麦克风（复刻 chat.startVoiceWav 的 Web Audio 路径）----------
// 关键：iOS 会把 AudioContext 挂起且静音 Web Audio 输入，必须由用户手势内 ensureAudioUnlock + 把麦克风流
// 挂到静音播放的媒体元素（audioPrimer video）来激活；ScriptProcessor 必须直接连到 destination 才触发回调。
let testMicState = 'idle';   // idle -> recording -> stopped -> playing -> idle
let testMicStream = null;
let testWavCtx = null, testWavSrc = null, testWavNode = null;
let testWavChunks = [], testWavRate = 16000, testWavPeak = 0, testRecFrames = 0;
let testMicBlob = null, testMicUrl = null;

function onTestMicBtn() {
  if (testMicState === 'idle') {
    ensureAudioUnlock(); // 手势内解锁音频会话
    testWavCtx = getAudioCtx();
    if (!testWavCtx) { log('此浏览器不支持 Web Audio，无法录音。', 'warn'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(async (stream) => {
        testMicStream = stream;
        const tr = stream.getAudioTracks()[0];
        testWavChunks = []; testWavPeak = 0; testRecFrames = 0;
        // iOS 激活采集：把麦克风流挂到“静音播放”(audioPrimer muted=true)的媒体元素，
        // 与通话路径(一直正常)一致——这是本机(无 MediaRecorder)能采到真实声音的配置。
        if (typeof audioPrimer !== 'undefined' && audioPrimer) {
          try { audioPrimer.srcObject = stream; audioPrimer.muted = true; const pp = audioPrimer.play(); if (pp && pp.catch) pp.catch((er) => log('primer 播放被拒: ' + er.message, 'warn')); } catch (e) {}
        }
        if (testWavCtx.state === 'suspended') { try { await testWavCtx.resume(); } catch (e) {} }
        testWavSrc = testWavCtx.createMediaStreamSource(stream);
        testWavNode = testWavCtx.createScriptProcessor(4096, 1, 1);
        testWavNode.onaudioprocess = (e) => {
          if (testMicState !== 'recording') return;
          testRecFrames++;
          const d = e.inputBuffer.getChannelData(0);
          testWavChunks.push(new Float32Array(d));
          let pk = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; }
          if (pk > testWavPeak) testWavPeak = pk;
          if (testMeter) testMeter.style.width = Math.min(100, Math.round(pk * 140)) + '%';
        };
        testWavSrc.connect(testWavNode);
        testWavNode.connect(testWavCtx.destination);
        testMicState = 'recording';
        testMicBtn.textContent = '⏹ 结束录音';
        testMicStatus.textContent = '录音中… 麦克风: ' + (tr ? tr.label : '默认') + ' track=' + (tr ? tr.readyState : '?') + ' ctx=' + testWavCtx.state;
        setTimeout(() => {
          if (testMicState === 'recording')
            testMicStatus.textContent = '诊断: track=' + (tr ? tr.readyState : '?') + ' ctx=' + testWavCtx.state + ' 帧=' + testRecFrames + ' 峰值=' + testWavPeak.toFixed(4) + (testRecFrames > 0 ? '（有数据✅）' : '（仍0帧，未激活❌）');
        }, 2000);
      })
      .catch((e) => log('麦克风权限被拒绝：' + e.message, 'warn'));
  } else if (testMicState === 'recording') {
    testMicState = 'stopped';
    try { if (testWavNode) testWavNode.disconnect(); } catch (e) {}
    try { if (testWavSrc) testWavSrc.disconnect(); } catch (e) {}
    if (testMicStream) {
      if (typeof audioPrimer !== 'undefined' && audioPrimer && audioPrimer.srcObject === testMicStream) audioPrimer.srcObject = null;
      testMicStream.getTracks().forEach((t) => t.stop()); testMicStream = null;
    }
    if (testMeter) testMeter.style.width = '0%';
    const rate = testWavCtx ? testWavCtx.sampleRate : 16000;
    let kb = '0 KB';
    if (testWavChunks.length) {
      testMicBlob = encodeWav(testWavChunks, rate);
      if (testMicUrl) { try { URL.revokeObjectURL(testMicUrl); } catch (e) {} }
      testMicUrl = URL.createObjectURL(testMicBlob);
      kb = (testMicBlob.size / 1024).toFixed(1) + ' KB';
    }
    testWavChunks = [];
    testMicBtn.textContent = '▶ 播放';
    testMicStatus.textContent = '已停止：' + kb + '（峰值 ' + testWavPeak.toFixed(4) + (testWavPeak > 0.001 ? '，录到声音！' : '，未录到声音') + '）。点“播放”试听。';
  } else if (testMicState === 'stopped') {
    if (!testMicUrl) return;
    if (typeof getAudioCtx === 'function') { const c = getAudioCtx(); if (c && c.state === 'suspended') c.resume().catch(() => {}); }
    ensureAudioUnlock();
    testAudio.src = testMicUrl;
    testAudio.play().catch((e) => log('播放失败：' + e.message, 'warn'));
    testMicState = 'playing';
    testMicBtn.textContent = '⏹ 停止播放';
    testMicStatus.textContent = '播放中…';
  } else if (testMicState === 'playing') {
    testAudio.pause();
    testAudio.currentTime = 0;
    testMicState = 'idle';
    testMicBtn.textContent = '🎤 开始录音';
    testMicStatus.textContent = '未录音。';
  }
}

function stopTestDevices() {
  if (testCamStream) { testCamStream.getTracks().forEach((t) => t.stop()); testCamStream = null; testCam.srcObject = null; testCamBtn.textContent = '📷 打开摄像头'; }
  if (testMicState === 'recording') {
    testMicState = 'stopped';
    try { if (testWavNode) testWavNode.disconnect(); } catch (e) {}
    try { if (testWavSrc) testWavSrc.disconnect(); } catch (e) {}
  }
  if (testMicStream) {
    if (typeof audioPrimer !== 'undefined' && audioPrimer && audioPrimer.srcObject === testMicStream) audioPrimer.srcObject = null;
    testMicStream.getTracks().forEach((t) => t.stop()); testMicStream = null;
  }
  if (testAudio) testAudio.pause();
  if (testMeter) testMeter.style.width = '0%';
  testWavChunks = [];
  testMicState = 'idle';
  testMicBtn.textContent = '🎤 开始录音';
  testMicStatus.textContent = '未录音。';
}

// ---------- 初始化绑定 ----------
if (btnTest) btnTest.addEventListener('click', () => goPage('page-test'));
if (testCamBtn) testCamBtn.addEventListener('click', toggleTestCam);
if (testMicBtn) testMicBtn.addEventListener('click', onTestMicBtn);
if (backTest) backTest.addEventListener('click', stopTestDevices);
if (testAudio) testAudio.addEventListener('ended', () => { testMicState = 'idle'; testMicBtn.textContent = '🎤 开始录音'; testMicStatus.textContent = '未录音。'; });
