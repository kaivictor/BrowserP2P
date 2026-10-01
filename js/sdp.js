// sdp.js —— SDP 解析/瘦身/重建 + 候选二进制打包 + 音频编解码限制

function restrictAudioCodec() {
  try {
    const caps = RTCRtpReceiver.getCapabilities('audio');
    if (caps && caps.codecs) {
      const opus = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/opus');
      if (opus.length && audioTransceiver) audioTransceiver.setCodecPreferences(opus);
    }
  } catch (e) { /* 不支持则忽略，保留默认 */ }
}

function parseSdpBasic(sdp) {
  const ufrag = (sdp.match(/a=ice-ufrag:(\S+)/) || [])[1];
  const pwd = (sdp.match(/a=ice-pwd:(\S+)/) || [])[1];
  const fm = sdp.match(/a=fingerprint:sha-256 (\S+)/i);
  const fpB64 = fm && fpColonToB64url(fm[1]); // DTLS 指纹压成 32 字节（base64url）
  const cands = []; const seen = new Set();
  sdp.split(/\r\n|\n/).forEach((line) => {
    if (line.indexOf('a=candidate:') === 0 && !seen.has(line)) { seen.add(line); cands.push(line); } // 去重
  });
  return { ufrag, pwd, fpB64, cands: filterCandidates(cands) };
}

// DTLS 指纹：带冒号十六进制(95) ⇄ 32 字节 base64url(~44)
function fpColonToB64url(hexColon) {
  const h = hexColon.replace(/:/g, '');
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  return bytesToBase64url(b);
}
function fpB64urlToColon(b64u) {
  const bytes = base64urlToBytes(b64u);
  let s = '';
  for (let i = 0; i < bytes.length; i++) { if (i) s += ':'; s += bytes[i].toString(16).padStart(2, '0').toUpperCase(); }
  return s;
}

// 候选瘦身：host 按地址族各留 1 个（保 LAN 直连），srflx/relay 各留 1 个（保 NAT 穿透）
function filterCandidates(cands) {
  const keep = []; const seen = new Set();
  let hostV4 = false, hostV6 = false, srflx = false, relay = false;
  for (const c of cands) {
    if (seen.has(c)) continue; seen.add(c);
    const type = (c.match(/typ (\S+)/) || [])[1];
    if (type === 'host') {
      const addr = c.split(' ')[4];
      const isV4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(addr);
      if (isV4) { if (!hostV4) { hostV4 = true; keep.push(c); } }
      else { if (!hostV6) { hostV6 = true; keep.push(c); } }
    } else if (type === 'srflx' || type === 'prflx') {
      if (!srflx) { srflx = true; keep.push(c); }
    } else if (type === 'relay') {
      if (!relay) { relay = true; keep.push(c); }
    }
  }
  return keep;
}

// 取浏览器真实生成的 SDP，剔除候选行、指纹行、可选 extmap/rtcp-fb/rtcp-rsize
function extractSdp(sdp) {
  return sdp.split(/\r\n|\n/).filter((line) => {
    if (line.indexOf('a=candidate:') === 0) return false;
    if (/^a=fingerprint:/i.test(line)) return false;
    if (line.indexOf('a=extmap:') === 0) return false;
    if (line.indexOf('a=rtcp-fb:') === 0) return false;
    if (line === 'a=rtcp-rsize') return false;
    return true;
  }).join('\r\n');
}
// 解码时把 DTLS 指纹（冒号十六进制）回填到每个媒体段的 a=ice-pwd 之后
function injectFingerprint(sdp, fpColon) {
  const line = 'a=fingerprint:sha-256 ' + fpColon;
  return sdp.replace(/a=ice-pwd:[^\r\n]*/g, (m) => m + '\r\n' + line);
}

// ---------- 候选二进制打包 ----------
function ipv6ToBytes(addr) {
  const parts = addr.split(':');
  const head = [], tail = [];
  let i = 0;
  for (; i < parts.length && parts[i] !== ''; i++) head.push(parts[i]);
  for (let j = parts.length - 1; j > i; j--) tail.unshift(parts[j]);
  const missing = 8 - head.length - tail.length;
  const groups = head.concat(new Array(missing < 0 ? 0 : missing).fill('0'), tail);
  const bytes = [];
  for (const g of groups) { const v = parseInt(g || '0', 16); bytes.push((v >> 8) & 0xff, v & 0xff); }
  return bytes;
}
function encAddr(out, addr) {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(addr)) {
    out.push(0);
    for (const x of addr.split('.')) out.push((+x) & 0xff);
  } else if (/^[0-9a-fA-F:]+$/.test(addr) && addr.indexOf(':') >= 0) {
    out.push(1);
    for (const b of ipv6ToBytes(addr)) out.push(b);
  } else {
    const ab = Array.from(new TextEncoder().encode(addr));
    out.push(2); out.push(ab.length & 0xff); for (const b of ab) out.push(b);
  }
}
function decAddr(bytes, i) {
  const type = bytes[i++];
  let addr;
  if (type === 0) { addr = bytes[i++] + '.' + bytes[i++] + '.' + bytes[i++] + '.' + bytes[i++]; }
  else if (type === 1) {
    addr = '';
    for (let j = 0; j < 8; j++) { if (j) addr += ':'; const v = (bytes[i++] << 8) | bytes[i++]; addr += v.toString(16).padStart(4, '0'); }
  } else { const len = bytes[i++]; addr = ''; for (let j = 0; j < len; j++) addr += String.fromCharCode(bytes[i++]); }
  return [addr, i];
}
function packCandidates(cands) {
  const out = [cands.length & 0xff];
  for (const c of cands) {
    const m = c.match(/^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)(?: raddr (\S+) rport (\d+))?/);
    if (!m) continue;
    const [, foundation, comp, trans, prio, addr, port, ctype, raddr, rport] = m;
    let flag = 0;
    if (trans === 'tcp') flag |= 1;
    const ct = { host: 0, srflx: 1, prflx: 2, relay: 3 }[ctype] || 0;
    flag |= (ct << 2);
    if (raddr) flag |= 0x20; // 带 raddr/rport
    out.push(flag);
    out.push((+comp) & 0xff);
    const p = +prio >>> 0;
    out.push((p >>> 24) & 0xff, (p >>> 16) & 0xff, (p >>> 8) & 0xff, p & 0xff);
    const pt = +port;
    out.push((pt >>> 8) & 0xff, pt & 0xff);
    const fb = Array.from(new TextEncoder().encode(foundation));
    out.push(fb.length); for (const b of fb) out.push(b);
    encAddr(out, addr);
    if (raddr) {
      const rp = +rport;
      out.push((rp >>> 8) & 0xff, rp & 0xff);
      encAddr(out, raddr);
    }
  }
  return new Uint8Array(out);
}
function unpackCandidates(bytes) {
  let i = 0;
  const count = bytes[i++];
  const cands = [];
  for (let k = 0; k < count; k++) {
    const flag = bytes[i++];
    const comp = bytes[i++];
    const prio = ((bytes[i++] << 24) | (bytes[i++] << 16) | (bytes[i++] << 8) | bytes[i++]) >>> 0;
    const port = ((bytes[i++] << 8) | bytes[i++]) >>> 0;
    const fLen = bytes[i++];
    let foundation = ''; for (let j = 0; j < fLen; j++) foundation += String.fromCharCode(bytes[i++]);
    const trans = (flag & 1) ? 'tcp' : 'udp';
    const [addr, i2] = decAddr(bytes, i); i = i2;
    const ctype = ['host', 'srflx', 'prflx', 'relay'][(flag >> 2) & 3];
    let line = 'a=candidate:' + foundation + ' ' + comp + ' ' + trans + ' ' + prio + ' ' + addr + ' ' + port + ' typ ' + ctype;
    if (flag & 0x20) {
      const rport = ((bytes[i++] << 8) | bytes[i++]) >>> 0;
      const [raddr, i3] = decAddr(bytes, i); i = i3;
      line += ' raddr ' + raddr + ' rport ' + rport;
    }
    cands.push(line);
  }
  return cands;
}

// 解码：新格式用真实 SDP（z 字段，deflate 压缩、无候选/无指纹）还原并回填指纹；
// 候选单独走 addIceCandidate；旧格式（整段 SDP 在 s）直接返回以兼容。
async function decodeSdp(payload) {
  if (payload.z && payload.f && payload.cd) {
    const cands = unpackCandidates(base64urlToBytes(payload.cd));
    // c 为算法名字符串表示压缩；c=0/undefined 处理见下
    const compressed = !!payload.c;
    const algo = (typeof payload.c === 'string' && payload.c) ? payload.c : 'deflate-raw';
    if (compressed && algo !== 'lzh' && !hasCompression) {
      throw new Error('对方发来的会话码经过压缩，但当前浏览器（Safari < 16.4）不支持解压，请让对方关闭压缩后重新生成');
    }
    const bytes = compressed
      ? await inflateBytes(base64urlToBytes(payload.z), algo)
      : base64urlToBytes(payload.z);
    const sdp = injectFingerprint(new TextDecoder().decode(bytes), fpB64urlToColon(payload.f));
    return { sdp, cands };
  }
  return { sdp: payload.s, cands: [] }; // 旧码兼容
}
async function addRemoteCandidates(pc, cands) {
  for (const c of cands) {
    try { await pc.addIceCandidate({ candidate: c, sdpMid: '0', sdpMLineIndex: 0 }); }
    catch (e) { console.error('[addIceCandidate 失败] 候选：' + c, e); }
  }
}
