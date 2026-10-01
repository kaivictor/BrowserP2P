// config.js —— 常量与全局可变状态（经典脚本，顶层声明即为全局）

// ---------- 常量 ----------
const STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];
const DC_LABEL = 'fileTransfer';
const MAX_PAYLOAD = 64000;            // 单分块净荷上限（< 64KB）默认值
// 保存对话框需用户手势，若被浏览器拦截：低于此阈值的小文件直接走经典下载；
// 高于此阈值的大文件仍提示「选择保存位置」以避免整文件占满内存。
const DIRECT_DOWNLOAD_MAX = 256 * 1024 * 1024;
let CHUNK = MAX_PAYLOAD;              // 实际分块大小（按 maxMessageSize 自适应）
const TAG_PLAIN = 0x01;              // 明文数据帧
const TAG_ENC = 0x02;                // 加密数据帧
const ENC_HEADER = 17;               // tag(1)+idx(4)+fileId(4)+iv(8)
const BUFFER_THRESHOLD = 16 * 1024 * 1024; // 背压阈值 16MB

// IndexedDB 断点续传
const DB_NAME = 'bsTransfer';
const STORE_META = 'meta';
const STORE_CHUNK = 'chunks';
const LOCAL_HISTORY_KEY = 'bsHistory';
const MAX_LOG = 200;

// 聊天记录容量上限（超出提示清空），用于“消息框有容量大小”
const CHAT_CAP_BYTES = 32 * 1024 * 1024; // 32MB
var chatBytes = 0; // 当前聊天记录估算体积（文字字节 + 语音 blob 大小）

const hasSubtle = !!(window.crypto && window.crypto.subtle);
const hasFSAccess = (typeof window.showSaveFilePicker === 'function');
let streamingMode = hasFSAccess;

// ---------- 可变状态 ----------
var pc = null, dc = null, role = null;
var sessionFingerprint = null;
var encryptionEnabled = false;
var encRawKey = null, encKey = null;
const incoming = new Map();           // fileId -> 接收状态
const activeSends = new Map();        // fileId -> {file, totalChunks}
var myFileIdCounter = (Math.random() * 0x7fffffff) | 0;

// 实时通话（虚拟电话）：音频走同一条 RTCPeerConnection 的音频轨道
var audioTransceiver = null, localStream = null, micTrack = null, calling = false;

// 屏幕共享
var screenStream = null, screenSender = null, screenTransceiver = null;
var pendingScreenStream = null;   // 身份页“先选好要共享的屏幕”暂存的预览流，连接成功后自动共享
