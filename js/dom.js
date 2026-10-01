// dom.js —— 全局 DOM 引用（最先加载，供其它脚本以全局变量访问）
const $ = (id) => document.getElementById(id);

const connBadge = $('connBadge');
const logEl = $('log');
const logToggle = $('logToggle');

// 第 1 页：角色
const btnCreate = $('btnCreate');
const btnJoin = $('btnJoin');
const encToggle = $('encToggle');
const btnPreShare = $('btnPreShare');
const preShareStatus = $('preShareStatus');

// 第 2 页：信令
const backSignal = document.querySelector('[data-back="page-role"]');
const offererView = $('offererView');
const answererView = $('answererView');
const offerOut = $('offerOut');
const copyOffer = $('copyOffer');
const showOfferQR = $('showOfferQR');
const answerIn = $('answerIn');
const btnSetAnswer = $('btnSetAnswer');
const scanAnswer = $('scanAnswer');
const offerIn = $('offerIn');
const btnProcessOffer = $('btnProcessOffer');
const scanOffer = $('scanOffer');
const answerOutWrap = $('answerOutWrap');
const answerOut = $('answerOut');
const copyAnswer = $('copyAnswer');
const showAnswerQR = $('showAnswerQR');

// 第 3 页：功能中心
const backHub = document.querySelector('[data-back="page-hub"]');
const hubStatus = $('hubStatus');
const featChat = $('feat-chat');
const featCall = $('feat-call');
const featScreen = $('feat-screen');
const featClip = $('feat-clip');
const btnDisconnect = $('btnDisconnect');

// 第 4 页：聊天 / 文件
const backChat = document.querySelector('[data-back="page-chat"]');
const chatMessages = $('chatMessages');
const chatInput = $('chatInput');
const chatSend = $('chatSend');
const chatMic = $('chatMic');
const btnFile = $('btnFile');
const fileInput = $('fileInput');
const btnClearChat = $('btnClearChat');
const chatDrop = $('chatDrop');
const chatCap = $('chatCap');

// 第 5 页：通话
const backCall = document.querySelector('[data-back="page-call"]');
const callStart = $('callStart');
const callJoin = $('callJoin');
const callReject = $('callReject');
const callMute = $('callMute');        // 静音（扬声器：我听到的远端声音）
const callMicMute = $('callMicMute');  // 闭麦（麦克风：我发出的声音）
const callEnd = $('callEnd');
const callState = $('callState');
const remoteAudio = $('remoteAudio');
const audioPrimer = $('audioPrimer'); // 静音播放本地麦克风流，强制 Safari 激活采集

// 第 6 页：屏幕监看
const backScreen = document.querySelector('[data-back="page-screen"]');
const screenStart = $('screenStart');
const screenStop = $('screenStop');
const screenFps = $('screenFps');
const screenFpsCustom = $('screenFpsCustom');
const screenBitrate = $('screenBitrate');
const screenMode = $('screenMode');
const screenLocal = $('screenLocal');
const screenSendStats = $('screenSendStats');
const screenWatchWrap = $('screenWatchWrap');
const screenWatchStage = $('screenWatchStage');
const screenWatchVideo = $('screenWatchVideo');
const screenFsPortrait = $('screenFsPortrait');
const screenFsLandscape = $('screenFsLandscape');
const screenFsReset = $('screenFsReset');
const screenFsExit = $('screenFsExit');
const screenStatus = $('screenStatus');
const screenStats = $('screenStats');
const screenShareWrap = $('screenShareWrap');

// 第 7 页：剪贴板同步
const backClip = document.querySelector('[data-back="page-clip"]');
const clipLocal = $('clipLocal');
const clipSend = $('clipSend');
const clipRemote = $('clipRemote');
const clipCopy = $('clipCopy');
const clipAuto = $('clipAuto');

// 第 8 页：设备测试
const btnTest = $('btnTest');
const backTest = document.querySelector('#page-test .back-btn');
const testCam = $('testCam');
const testCamBtn = $('testCamBtn');
const testCamStatus = $('testCamStatus');
const testMicBtn = $('testMicBtn');
const testMeter = $('testMeter');
const testMicStatus = $('testMicStatus');
const testAudio = $('testAudio');

// 模态 / 浮层
const qrFullscreen = $('qrFullscreen');
const qrFullscreenInner = $('qrFullscreenInner');
const scanModal = $('scanModal');
const scanVideo = $('scanVideo');
const scanCanvas = $('scanCanvas');
const scanClose = $('scanClose');
const scanStatus = $('scanStatus');
const toastEl = $('toast');
