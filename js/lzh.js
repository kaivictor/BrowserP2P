// ---------- 自研压缩：LZ77 + 哈夫曼（纯 JS，零浏览器依赖） ----------
// 不依赖 CompressionStream / DecompressionStream，所有浏览器（含旧 Safari）均可压可解。
// 格式：字节对齐的表头 + 比特流。
//   表头： [version:1][llCount:2][llCount 个码长字节][distCount:1][distCount 个码长字节]
//   比特流：规范哈夫曼编码的 LL 符号流（0..255 字面量 / 256 结束 / 257..285 长度），
//           长度/距离符号后跟各自的扩展位（小端写入，编解码一致即可）。
//
// 说明：这里是“自研的 LZ77 + Huffman”实现，编解码两端都是本工程代码，因此
// 比特序（统一 MSB-first）与扩展位的写法只要两端一致即可，不必与标准 DEFLATE 完全一致。

// DEFLATE 长度码表（257..285）：[基准长度, 扩展位数]
const LEN_CODES = [
  [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0],
  [11, 1], [13, 1], [15, 1], [17, 1],
  [19, 2], [23, 2], [27, 2], [31, 2],
  [35, 3], [43, 3], [51, 3], [59, 3],
  [67, 4], [83, 4], [99, 4], [115, 4],
  [131, 5], [163, 5], [195, 5], [227, 5], [258, 0]
];
// DEFLATE 距离码表（0..29）：[基准距离, 扩展位数]
const DIST_CODES = [
  [1, 0], [2, 0], [3, 0], [4, 0],
  [5, 1], [7, 1], [9, 2], [13, 2],
  [17, 3], [25, 3], [33, 4], [49, 4],
  [65, 5], [97, 5], [129, 6], [193, 6],
  [257, 7], [385, 7], [513, 8], [769, 8],
  [1025, 9], [1537, 9], [2049, 10], [3073, 10],
  [4097, 11], [6145, 11], [8193, 12], [12289, 12], [16385, 13], [24577, 13]
];

const MIN_MATCH = 3, MAX_MATCH = 258, WSIZE = 32768;

function lenCode(len) {
  for (let ci = LEN_CODES.length - 1; ci >= 0; ci--) {
    if (len >= LEN_CODES[ci][0]) return [ci, LEN_CODES[ci][0], LEN_CODES[ci][1]];
  }
  return [0, 3, 0];
}
function distCode(dist) {
  for (let di = DIST_CODES.length - 1; di >= 0; di--) {
    if (dist >= DIST_CODES[di][0]) return [di, DIST_CODES[di][0], DIST_CODES[di][1]];
  }
  return [0, 1, 0];
}

// ---------- 比特流 ----------
class BitWriter {
  constructor() { this.buf = []; this.cur = 0; this.nbits = 0; }
  writeBit(b) {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.nbits === 8) { this.buf.push(this.cur); this.cur = 0; this.nbits = 0; }
  }
  writeBits(value, n) { for (let i = n - 1; i >= 0; i--) this.writeBit((value >> i) & 1); }
  writeByte(b) { this.flush(); this.buf.push(b & 0xff); }
  flush() { if (this.nbits > 0) { this.cur <<= (8 - this.nbits); this.buf.push(this.cur); this.cur = 0; this.nbits = 0; } }
  bytes() { return new Uint8Array(this.buf); }
}
class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; this.bit = 0; }
  readBit() {
    if (this.bit > 7) { this.pos++; this.bit = 0; }
    const v = (this.buf[this.pos] >> (7 - this.bit)) & 1;
    this.bit++;
    return v;
  }
  readBits(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.readBit(); return v; }
  readByte() { return this.readBits(8); }
  // 逐位解码哈夫曼：读到第 l 位时若落在 [firstCode, firstCode+count-1] 即命中
  decodeOne(t) {
    let cur = 0;
    for (let l = 1; l <= t.maxLen; l++) {
      cur = (cur << 1) | this.readBit();
      if (t.count[l] && cur >= t.firstCode[l] && cur <= t.firstCode[l] + t.count[l] - 1) {
        return t.syms[l][cur - t.firstCode[l]];
      }
    }
    throw new Error('哈夫曼解码失败：码流损坏');
  }
}

// ---------- Huffman（由频率生成码长，再生成规范码） ----------
function buildLengths(freqs) {
  const n = freqs.length;
  const lengths = new Array(n).fill(0);
  const sym = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) sym.push(i);
  if (sym.length === 0) return lengths;
  if (sym.length === 1) { lengths[sym[0]] = 1; return lengths; }
  const nodes = sym.map((i) => ({ freq: freqs[i], sym: i, left: null, right: null }));
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.freq - b.freq);
    const a = nodes.shift(), b = nodes.shift();
    nodes.push({ freq: a.freq + b.freq, sym: -1, left: a, right: b });
  }
  const root = nodes[0];
  (function depth(node, d) {
    if (node.sym >= 0) { lengths[node.sym] = d; return; }
    depth(node.left, d + 1); depth(node.right, d + 1);
  })(root, 0);
  return lengths;
}
function buildCanonical(lengths, alphabetSize) {
  let maxLen = 0;
  for (let i = 0; i < alphabetSize; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
  const codeOf = new Array(alphabetSize).fill(0);
  const lenOf = lengths.slice();
  const firstCode = {}, count = {}, syms = {};
  let code = 0;
  for (let l = 1; l <= maxLen; l++) {
    let idx = 0;
    const list = [];
    for (let s = 0; s < alphabetSize; s++) {
      if (lengths[s] === l) { list.push(s); codeOf[s] = code + idx; idx++; }
    }
    if (idx > 0) { firstCode[l] = code; count[l] = idx; syms[l] = list; code += idx; }
    code <<= 1;
  }
  return { maxLen, firstCode, count, syms, codeOf, lenOf };
}

// ---------- LZ77（哈希链） ----------
function lz77Compress(data) {
  const n = data.length;
  const tokens = [];
  if (n === 0) return tokens;
  const head = new Int32Array(65536).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hashAt = (i) => ((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2]) & 0xffff;
  const insert = (p) => { if (p + MIN_MATCH <= n) { const h = hashAt(p); prev[p] = head[h]; head[h] = p; } };
  let pos = 0;
  while (pos < n) {
    let bestLen = 0, bestDist = 0;
    if (pos + MIN_MATCH <= n) {
      const h = hashAt(pos);
      let cand = head[h];
      const maxLen = Math.min(MAX_MATCH, n - pos);
      while (cand >= 0 && pos - cand <= WSIZE) {
        if (data[cand] === data[pos] && data[cand + 1] === data[pos + 1] && data[cand + 2] === data[pos + 2]) {
          let len = 3;
          while (len < maxLen && data[cand + len] === data[pos + len]) len++;
          if (len > bestLen) { bestLen = len; bestDist = pos - cand; }
        }
        cand = prev[cand];
      }
    }
    if (bestLen >= MIN_MATCH) {
      tokens.push({ len: bestLen, dist: bestDist });
      for (let k = 0; k < bestLen; k++) insert(pos + k);
      pos += bestLen;
    } else {
      tokens.push({ lit: data[pos] });
      insert(pos);
      pos++;
    }
  }
  return tokens;
}

// ---------- 对外接口 ----------
function compressLZ77Huffman(data) {
  const tokens = lz77Compress(data);
  const llFreq = new Array(286).fill(0);
  const distFreq = new Array(30).fill(0);
  llFreq[256] = 1; // 结束符号
  for (const t of tokens) {
    if (t.lit !== undefined) llFreq[t.lit]++;
    else { llFreq[257 + lenCode(t.len)[0]]++; distFreq[distCode(t.dist)[0]]++; }
  }
  const llLen = buildLengths(llFreq);
  const distLen = buildLengths(distFreq);
  let maxL = 0;
  for (let i = 0; i < llLen.length; i++) if (llLen[i] > maxL) maxL = llLen[i];
  for (let i = 0; i < distLen.length; i++) if (distLen[i] > maxL) maxL = distLen[i];
  if (maxL > 15) return null; // 病态输入：哈夫曼码过长，降级为明文（调用方回退）
  const llT = buildCanonical(llLen, 286);
  const distT = buildCanonical(distLen, 30);
  const bw = new BitWriter();
  bw.writeByte(1); // version
  bw.writeByte(286 & 0xff); bw.writeByte((286 >> 8) & 0xff);
  // LL 码长以 4 位 nibble 打包（256 种码长 ≤15，足够），减半表头开销
  for (let i = 0; i < 286; i += 2) {
    const hi = llLen[i] & 0xf;
    const lo = (i + 1 < 286 ? llLen[i + 1] : 0) & 0xf;
    bw.writeByte((hi << 4) | lo);
  }
  bw.writeByte(30);
  for (let i = 0; i < 30; i += 2) {
    const hi = distLen[i] & 0xf;
    const lo = (i + 1 < 30 ? distLen[i + 1] : 0) & 0xf;
    bw.writeByte((hi << 4) | lo);
  }
  for (const t of tokens) {
    if (t.lit !== undefined) {
      bw.writeBits(llT.codeOf[t.lit], llT.lenOf[t.lit]);
    } else {
      const [ci, base, eb] = lenCode(t.len);
      bw.writeBits(llT.codeOf[257 + ci], llT.lenOf[257 + ci]);
      if (eb > 0) bw.writeBits(t.len - base, eb);
      const [di, dbase, deb] = distCode(t.dist);
      bw.writeBits(distT.codeOf[di], distT.lenOf[di]);
      if (deb > 0) bw.writeBits(t.dist - dbase, deb);
    }
  }
  bw.writeBits(llT.codeOf[256], llT.lenOf[256]);
  bw.flush();
  const out = bw.bytes();
  return out.length >= data.length ? null : out; // 无收益则回退明文
}

function decompressLZ77Huffman(buf) {
  const br = new BitReader(buf);
  br.readByte(); // version
  const llCount = br.readByte() | (br.readByte() << 8);
  const llLen = new Array(llCount).fill(0);
  for (let i = 0; i < llCount; i += 2) {
    const b = br.readByte();
    llLen[i] = (b >> 4) & 0xf;
    if (i + 1 < llCount) llLen[i + 1] = b & 0xf;
  }
  const distCount = br.readByte();
  const distLen = new Array(distCount).fill(0);
  for (let i = 0; i < distCount; i += 2) {
    const b = br.readByte();
    distLen[i] = (b >> 4) & 0xf;
    if (i + 1 < distCount) distLen[i + 1] = b & 0xf;
  }
  const llT = buildCanonical(llLen, llCount);
  const distT = buildCanonical(distLen, distCount);
  const out = [];
  while (true) {
    const sym = br.decodeOne(llT);
    if (sym === 256) break;
    if (sym < 256) { out.push(sym); continue; }
    const ci = sym - 257;
    const base = LEN_CODES[ci][0], eb = LEN_CODES[ci][1];
    const len = base + (eb > 0 ? br.readBits(eb) : 0);
    const di = br.decodeOne(distT);
    const dbase = DIST_CODES[di][0], deb = DIST_CODES[di][1];
    const dist = dbase + (deb > 0 ? br.readBits(deb) : 0);
    const start = out.length - dist;
    for (let i = 0; i < len; i++) out.push(out[start + i]);
  }
  return new Uint8Array(out);
}

// 浏览器（经典脚本）暴露到全局；Node 下导出供测试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { compressLZ77Huffman, decompressLZ77Huffman };
}
