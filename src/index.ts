/**
 * 仅 HTTP Range 探测 APK 的 AndroidManifest.xml，无需下载整个文件。
 *
 * 快路径：AndroidManifest.xml 是 zip 第 0 个 entry 时（支付宝、QQ、绝大多数
 *        官方 APK 成立），单次 Range 拉头部约 60KB 就够。
 * 慢路径：fallback 到 EOCD + 中央目录扫描找 manifest 的真实 LFH 偏移
 *        （微信的 manifest 排在 resources.arsc 后面，需走这条）。
 *
 * 流程：
 *   1. HEAD 拿总大小 + 头部 2KB 读 LFH[0]
 *   2. 若第 0 个 entry 名 = AndroidManifest.xml → 走快路径
 *   3. 否则取末尾 16KB 找 EOCD，从 CD offset 流式扫到 manifest entry
 *   4. Range [lfhOff .. +compSize] 拉数据 → inflate → AXML parse
 *
 * Range 不被服务器支持时立即抛错——绝不盲下整个 APK。
 */
import zlib from "node:zlib";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import { parseManifest, type ManifestNode } from "./axml-parser.ts";

export type { ManifestNode };

export interface ApkManifestInfo {
  package: string;
  versionName: string;
  versionCode: number;
  /** APK 文件总大小（字节），来自 HEAD 响应的 content-length。 */
  apkSize: number;
  /** 本次探测实际下载的字节数（HEAD + 所有 Range 响应累加）。 */
  downloadedSize: number;
  /** 完整 AndroidManifest.xml 解析树（含 _children 与所有属性）。 */
  manifest: ManifestNode;
}

// ── ZIP Local File Header (LFH) 字段偏移 ────────────────────────────────
// 参见 https://en.wikipedia.org/wiki/ZIP_(file_format)#Local_file_header
const LFH_SIGNATURE = 0x04034b50; // 'PK\x03\x04'
const LFH_COMP_SIZE = 18; // u32 压缩大小
const LFH_NAME_LEN = 26; // u16 文件名长度
const LFH_EXTRA_LEN = 28; // u16 额外字段长度
const LFH_NAME_OFF = 30; // 文件名起始偏移
const LFH_FIXED_SIZE = 30; // 固定头部大小

// ── ZIP Central Directory (CD) 字段偏移 ──────────────────────────────────
// 参见 https://en.wikipedia.org/wiki/ZIP_(file_format)#Central_directory_file_header
const CD_SIGNATURE = 0x02014b50; // 'PK\x01\x02'
const CD_COMP_SIZE = 20; // u32 压缩大小
const CD_NAME_LEN = 28; // u16 文件名长度
const CD_EXTRA_LEN = 30; // u16 额外字段长度
const CD_COMMENT_LEN = 32; // u16 注释长度
const CD_LFH_OFFSET = 42; // u32 对应 LFH 偏移
const CD_FIXED_SIZE = 46; // 固定头大小

// ── End of Central Directory (EOCD) 字段偏移 ─────────────────────────────
const EOCD_SIGNATURE = 0x06054b50; // 'PK\x05\x06'
const EOCD_CD_OFFSET = 16; // u32 CD 起始偏移
const EOCD_FIXED_SIZE = 22; // 固定头大小

// ── 探测参数 ─────────────────────────────────────────────────────────────
const HEAD_FETCH_BYTES = 2048; // 快路径首次 Range 拉取的字节数
const EOCD_FETCH_BYTES = 16384; // 慢路径从末尾向前拉的字节数
const CD_CHUNK_BYTES = 64 * 1024; // 慢路径扫描 CD 时每次 Range 拉取的字节数
const MANIFEST_ENTRY = "AndroidManifest.xml";

const HTTP_HEADERS = { "User-Agent": "AlipayClient/1.0" };

/**
 * keep-alive 连接池。一次 probeManifestVersion 调用会发 2~6 个 HTTP 请求，
 * 若每请求都重做 TCP+TLS 握手，单次耗时轻松到 5s+（其中 TLS 就 1s+）。
 * 复用 Agent 让 DNS+TCP+TLS 只握一次，后续 Range 请求走已建的连接。
 *
 * 直接用 node:https/http 而非内置 fetch，是为了在 Node 18 LTS 上稳定运行
 * （fetch 的 dispatcher 选项在 18.x 各 patch 版本里行为不一）。
 */
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });

/** 将当前请求的所有响应 body 累积为 Buffer。 */
function drainBody(res: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

/** 给 url 选合适的 keep-alive Agent。 */
function agentFor(url: URL): https.Agent | http.Agent {
  return url.protocol === "https:" ? httpsAgent : httpAgent;
}

/** 发一个 HTTP 请求，返回 {status, headers, body}。 */
function httpRequest(
  url: URL,
  method: "GET" | "HEAD",
  extraHeaders: Record<string, string> = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(
      {
        method,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: { ...HTTP_HEADERS, ...extraHeaders },
        agent: agentFor(url),
      },
      (res) => {
        drainBody(res).then((body) =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 内部贯穿快/慢路径的下载统计上下文。 */
interface ProbeContext {
  url: URL;
  downloaded: number;
  total: number;
}

// ── HTTP 工具 ────────────────────────────────────────────────────────────

async function fetchRange(
  ctx: ProbeContext,
  start: number,
  end: number,
): Promise<Buffer> {
  const { status, body } = await httpRequest(ctx.url, "GET", {
    Range: `bytes=${start}-${end - 1}`,
  });
  if (status !== 206) {
    throw new Error(`server does not support Range (status=${status})`);
  }
  ctx.downloaded += body.length;
  return body;
}

async function fetchTotalSize(ctx: ProbeContext): Promise<number> {
  const { status, headers } = await httpRequest(ctx.url, "HEAD");
  if (status >= 400) throw new Error(`HEAD failed (status=${status})`);
  const len = Number(headers["content-length"]);
  if (!len) throw new Error("content-length missing");
  ctx.total = len;
  return len;
}

// ── 从 manifest buffer 拼装最终结果 ──────────────────────────────────────

interface ManifestCore {
  package: string;
  versionName: string;
  versionCode: number;
  manifest: ManifestNode;
}

function parseManifestCore(raw: Buffer): ManifestCore {
  // ManifestNode 的类型签名是动态键集合，所以这里直接断言为带显式字段的子集。
  const m = parseManifest(raw) as ManifestNode & {
    package: string;
    "android:versionName": string;
    "android:versionCode": number;
  };
  return {
    package: m.package,
    versionName: m["android:versionName"],
    versionCode: m["android:versionCode"],
    manifest: m,
  };
}

function buildResult(
  core: ManifestCore,
  ctx: ProbeContext,
): ApkManifestInfo {
  return {
    ...core,
    apkSize: ctx.total,
    downloadedSize: ctx.downloaded,
  };
}

// ── 快路径：AndroidManifest.xml 是 zip 第 0 个 entry ─────────────────────

class FastPathMissError extends Error {
  constructor() {
    super("fast-path miss");
    this.name = "FastPathMissError";
  }
}

async function probeFast(ctx: ProbeContext): Promise<ApkManifestInfo> {
  const head = await fetchRange(ctx, 0, HEAD_FETCH_BYTES);
  const nameLen = head.readUInt16LE(LFH_NAME_LEN);
  const name = head.subarray(LFH_NAME_OFF, LFH_NAME_OFF + nameLen).toString("utf8");
  if (name !== MANIFEST_ENTRY) {
    throw new FastPathMissError(); // 调用方走慢路径
  }

  const compSize = head.readUInt32LE(LFH_COMP_SIZE);
  const extraLen = head.readUInt16LE(LFH_EXTRA_LEN);
  const dataStart = LFH_NAME_OFF + nameLen + extraLen;
  const dataEnd = dataStart + compSize;

  // 头部已包含全部压缩数据则就地解；否则续拉剩余字节。
  let comp: Buffer;
  if (HEAD_FETCH_BYTES >= dataEnd) {
    comp = head.subarray(dataStart, dataEnd);
  } else {
    const rest = await fetchRange(ctx, HEAD_FETCH_BYTES, dataEnd);
    comp = Buffer.concat([head.subarray(dataStart, HEAD_FETCH_BYTES), rest]);
  }
  const manifestRaw = zlib.inflateRawSync(comp);

  // 快路径若未发 HEAD，顺便补一次。
  if (ctx.total === 0) await fetchTotalSize(ctx);

  return buildResult(parseManifestCore(manifestRaw), ctx);
}

// ── 慢路径：扫 EOCD + CD 找 manifest 真实偏移 ───────────────────────────

interface CdEntry {
  lfhOff: number;
  compSize: number;
  nameLen: number;
  extraLen: number;
  commentLen: number;
}

/** 在中央目录 buf 中从 p 处读取一个 CD entry 字段，不读 name/extra/comment。 */
function readCdEntry(buf: Buffer, p: number): CdEntry {
  return {
    lfhOff: buf.readUInt32LE(p + CD_LFH_OFFSET),
    compSize: buf.readUInt32LE(p + CD_COMP_SIZE),
    nameLen: buf.readUInt16LE(p + CD_NAME_LEN),
    extraLen: buf.readUInt16LE(p + CD_EXTRA_LEN),
    commentLen: buf.readUInt16LE(p + CD_COMMENT_LEN),
  };
}

function findEocd(tail: Buffer): number {
  for (let i = tail.length - EOCD_FIXED_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * 在中央目录里流式扫描寻找 MANIFEST_ENTRY。
 * 用一个可变长 `buf` + `readCursor` 配合 fetchRange 翻页 64KB。
 */
async function findManifestInCd(ctx: ProbeContext, cdOff: number): Promise<CdEntry> {
  let buf = await fetchRange(ctx, cdOff, cdOff + CD_CHUNK_BYTES);
  let readCursor = CD_CHUNK_BYTES;
  let p = 0;

  /** 保证 buf 至少包含 [p, p + need) 范围；不够就再拉一块。 */
  const ensure = async (need: number): Promise<void> => {
    while (p + need > buf.length) {
      const more = await fetchRange(ctx, cdOff + readCursor, cdOff + readCursor + CD_CHUNK_BYTES);
      buf = Buffer.concat([buf, more]);
      readCursor += CD_CHUNK_BYTES;
    }
  };

  while (p + CD_FIXED_SIZE <= buf.length) {
    await ensure(CD_FIXED_SIZE);
    if (buf.readUInt32LE(p) !== CD_SIGNATURE) break;

    const entry = readCdEntry(buf, p);
    const entryTotalLen =
      CD_FIXED_SIZE + entry.nameLen + entry.extraLen + entry.commentLen;
    await ensure(entryTotalLen);
    const name = buf
      .subarray(p + CD_FIXED_SIZE, p + CD_FIXED_SIZE + entry.nameLen)
      .toString("utf8");

    if (name === MANIFEST_ENTRY) return entry;
    p += entryTotalLen;
  }

  throw new Error("AndroidManifest.xml not in CD");
}

/** 拉指定 LFH 偏移处的压缩数据并解压。 */
async function fetchAndInflate(
  ctx: ProbeContext,
  lfhOff: number,
  nameLen: number,
  extraLen: number,
  compSize: number,
): Promise<Buffer> {
  // 拉满 LFH 头 + 文件名 + extra + 压缩数据，多留 64B 防御边界。
  const end =
    lfhOff + LFH_FIXED_SIZE + nameLen + extraLen + compSize + 64;
  const lfhBuf = await fetchRange(ctx, lfhOff, end);
  if (lfhBuf.length < LFH_FIXED_SIZE || lfhBuf.readUInt32LE(0) !== LFH_SIGNATURE) {
    throw new Error(`invalid LFH at offset ${lfhOff}`);
  }
  // 用 LFH 里本地的 nameLen/extraLen（CD 里的可能不一致）
  const localNameLen = lfhBuf.readUInt16LE(LFH_NAME_LEN);
  const localExtraLen = lfhBuf.readUInt16LE(LFH_EXTRA_LEN);
  const dataStart = LFH_FIXED_SIZE + localNameLen + localExtraLen;
  return zlib.inflateRawSync(lfhBuf.subarray(dataStart, dataStart + compSize));
}

async function probeSlow(ctx: ProbeContext): Promise<ApkManifestInfo> {
  const total = await fetchTotalSize(ctx);
  const tail = await fetchRange(ctx, total - EOCD_FETCH_BYTES, total);

  const eocd = findEocd(tail);
  if (eocd < 0) throw new Error("EOCD not found in last 16KB");

  const cdOff = tail.readUInt32LE(eocd + EOCD_CD_OFFSET);
  const entry = await findManifestInCd(ctx, cdOff);
  const manifestRaw = await fetchAndInflate(
    ctx,
    entry.lfhOff,
    entry.nameLen,
    entry.extraLen,
    entry.compSize,
  );

  return buildResult(parseManifestCore(manifestRaw), ctx);
}

// ── 对外主入口 ───────────────────────────────────────────────────────────

/**
 * 探测 APK 的 AndroidManifest 返回 package / versionName / versionCode / 原始 manifest 树。
 * 仅通过 HTTP Range 下载头部几 KB 到几百 KB，不下整个 APK。
 * 服务器不支持 Range 时立即抛错，绝不体面降级为整包下载。
 *
 * @example
 *   import { probeManifestVersion } from "@tofarfar/package-manifest";
 *   const info = await probeManifestVersion("https://example.com/app.apk");
 *   // {
 *   //   package: "com.x.y",
 *   //   versionName: "1.0",
 *   //   versionCode: 1,
 *   //   apkSize: 247000000,
 *   //   downloadedSize: 56700,
 *   //   manifest: { _name: "manifest", "android:versionName": "1.0", ... }
 *   // }
 */
export async function probeManifestVersion(apkUrl: string): Promise<ApkManifestInfo> {
  const ctx: ProbeContext = { url: new URL(apkUrl), downloaded: 0, total: 0 };
  try {
    return await probeFast(ctx);
  } catch (e) {
    if (e instanceof FastPathMissError) return await probeSlow(ctx);
    throw e;
  }
}

export default probeManifestVersion;
