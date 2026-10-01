// utils.js —— 通用工具函数（依赖 dom.js 的全局 DOM 引用）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

function log(msg, level) {
  const t = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'lv-' + (level || 'info');
  line.textContent = `[${t}] ${msg}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
  // 同时输出到浏览器控制台，便于通话/连接等浮窗场景下排查（浮窗会遮挡 DOM 日志面板）
  if (level === 'err') console.error('[BrowerShare] ' + msg);
  else if (level === 'warn') console.warn('[BrowerShare] ' + msg);
  else console.log('[BrowerShare] ' + msg);
}
// 带子功能标签的日志：tag 形如 'Canvas裁切' / 'ABR' / 'WebRTC'，输出自动加 [tag] 前缀。
// logT 内部仍调用 log（不递归），故 log 本体保持原样。
function logT(tag, msg, level) { log('[' + tag + '] ' + msg, level); }

function setBadge(text, kind) {
  connBadge.textContent = text;
  connBadge.className = 'badge badge-' + kind;
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  void toastEl.offsetWidth; // 触发重排，确保过渡生效
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => { if (!toastEl.classList.contains('show')) toastEl.textContent = ''; }, 300);
  }, 1500);
}

// ---------- base64 ----------
function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
// URL 安全的 base64（无填充），比标准 base64 更紧凑、可直接放进链接/二维码
function bytesToBase64url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlToBytes(b64u) {
  let s = b64u.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return base64ToBytes(s);
}

// ---------- 信令载荷压缩 / 解压 ----------
// 主压缩：自研 LZ77 + 哈夫曼（js/lzh.js），纯 JS、零浏览器依赖，所有浏览器（含旧 Safari）均可压可解。
// 旧码兼容：仍可解码浏览器原生 gzip / deflate-raw（flag '1' / '2'），但新码一律用 '3'（lzh）。
const hasCompression =
  (typeof CompressionStream === 'function') && (typeof DecompressionStream === 'function');
// 自研压缩；无收益时返回 null，调用方回退明文
async function deflateBytes(bytes) {
  const r = compressLZ77Huffman(bytes);
  if (!r) throw new Error('LZH 无收益，回退明文');
  return r;
}
// algo: 'lzh'（自研，全平台可用）或 'gzip' / 'deflate-raw'（浏览器原生，仅旧码兼容）
async function inflateBytes(bytes, algo) {
  if (algo === 'lzh' || algo == null) return decompressLZ77Huffman(bytes);
  const ds = new DecompressionStream(algo === 'deflate-raw' ? 'deflate-raw' : 'gzip');
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
async function encodePayload(obj) {
  if (obj.s) obj.s = obj.s.replace(/\r\n/g, '\n'); // 折叠 SDP 换行
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  // 自研压缩优先（全平台可用）
  try { return '3' + bytesToBase64url(await deflateBytes(bytes)); }
  catch (e) { logT('加密', '压缩失败，回退明文：' + e.message, 'warn'); }
  return '0' + bytesToBase64url(bytes);
}
// SDP 字段压缩（自研 LZH，全平台可用；无收益回退明文）。返回 { z, c }，c='lzh' 表示已压缩
async function encodeSdpField(sdp) {
  const bytes = new TextEncoder().encode(sdp);
  try { return { z: bytesToBase64url(await deflateBytes(bytes)), c: 'lzh' }; }
  catch (e) { logT('加密', 'SDP 压缩失败，回退明文：' + e.message, 'warn'); }
  return { z: bytesToBase64url(bytes), c: 0 };
}
async function decodePayload(code) {
  code = code.trim();
  const flag = code[0];
  const body = code.slice(1);
  let bytes;
  if (flag === '3') {
    // 自研 LZH：全平台可解，不依赖浏览器原生 API
    bytes = await inflateBytes(base64urlToBytes(body), 'lzh');
  } else if (flag === '2' || flag === '1') {
    // 旧码：浏览器原生 gzip / deflate-raw，旧 Safari 不支持时给出清晰提示
    if (!hasCompression) {
      throw new Error('当前浏览器不支持解压该会话码，请用新版 Safari（16.4+）或让对方关闭压缩后重新生成');
    }
    bytes = await inflateBytes(base64urlToBytes(body), flag === '2' ? 'deflate-raw' : 'gzip');
  } else {
    bytes = base64urlToBytes(body);
  }
  const obj = JSON.parse(new TextDecoder().decode(bytes));
  if (obj.s) obj.s = obj.s.replace(/\n/g, '\r\n'); // 还原 SDP 换行
  return obj;
}

// ---------- 文本加解密（聊天） ----------
async function encryptText(str) {
  if (!(encryptionEnabled && encKey)) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, new TextEncoder().encode(str));
  return { iv: bytesToBase64(iv), d: bytesToBase64(new Uint8Array(ct)) };
}
async function decryptText(obj) {
  if (!obj || !encKey) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(obj.iv) }, encKey, base64ToBytes(obj.d));
    return new TextDecoder().decode(pt);
  } catch (e) { return null; }
}

// ---------- Blob -> 字节（兼容无 Blob.arrayBuffer 的旧浏览器） ----------
async function blobToBytes(blob) {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = () => reject(fr.error || new Error('FileReader 读取失败'));
    fr.readAsArrayBuffer(blob);
  });
}

// ---------- 哈希 ----------
async function sha256OfBlob(blob) {
  const ab = await blobToBytes(blob);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', ab)));
}
function hex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
