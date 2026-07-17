/**
 * axml-parser.ts
 *
 * Android binary XML (AXML) 解析器。
 * 仅 7.8KB 单文件，零第三方依赖。
 *
 * 来源：移植自 `androguard-js` 项目的 `src/axml/index.js`
 *   https://github.com/SQU4NCH/androguard-js/blob/master/src/axml/index.js
 * （于 2026-07-17 拷过来并改写为 TypeScript，逻辑保持不变）
 *
 * 仅用 axml 子模块；不引入 androguard-js 整包（其会拖入 18MB 的 sql.js WASM 依赖）。
 */

// Android binary XML chunk types
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_NAMESPACE = 0x0100;
const RES_XML_END_NAMESPACE = 0x0101;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;
const RES_XML_CDATA = 0x0104;
const RES_XML_RESOURCE_MAP = 0x0180;

// ResValue data types
const TYPE_NULL = 0x00;
const TYPE_REFERENCE = 0x01;
const TYPE_ATTRIBUTE = 0x02;
const TYPE_STRING = 0x03;
const TYPE_FLOAT = 0x04;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;
const TYPE_COLOR_ARGB8 = 0x1c;
const TYPE_COLOR_RGB8 = 0x1d;

// String pool flags
const UTF8_FLAG = 0x00000100;

// ── 类型 ────────────────────────────────────────────────────────────────────

interface AttributeMap {
  [key: string]: string | number | boolean | null;
}

interface XmlNode {
  name: string;
  ns: string | null;
  attrs: AttributeMap;
  children: Array<XmlNode | { text: string }>;
  _line: number;
}

interface ParseResult {
  root: XmlNode | null;
  strings: string[];
  namespaces: Record<string, string>;
}

type ManifestNode = {
  _name: string;
} & AttributeMap & {
    _children?: Array<ManifestNode | { text: string }>;
  };

export type { ManifestNode };

// ── String pool ──────────────────────────────────────────────────────────────

function readStringPool(buf: Buffer, chunkStart: number): string[] {
  const stringCount = buf.readUInt32LE(chunkStart + 8);
  const flags = buf.readUInt32LE(chunkStart + 16);
  const stringsStart = buf.readUInt32LE(chunkStart + 20);
  // stylesStart at +24 (unused here)

  const isUtf8 = (flags & UTF8_FLAG) !== 0;
  const offBase = chunkStart + 28;
  const dataBase = chunkStart + stringsStart;

  const strings: string[] = [];
  for (let i = 0; i < stringCount; i++) {
    const off = buf.readUInt32LE(offBase + i * 4);
    strings.push(
      isUtf8
        ? readUtf8String(buf, dataBase + off)
        : readUtf16String(buf, dataBase + off),
    );
  }
  return strings;
}

function readUtf8String(buf: Buffer, off: number): string {
  const byteLen = buf[off + 1]!;
  return buf.slice(off + 2, off + 2 + byteLen).toString("utf8");
}

function readUtf16String(buf: Buffer, off: number): string {
  const charLen = buf.readUInt16LE(off);
  let s = "";
  for (let i = 0; i < charLen; i++) {
    s += String.fromCharCode(buf.readUInt16LE(off + 2 + i * 2));
  }
  return s;
}

// ── ResValue → JS value ──────────────────────────────────────────────────────

function resolveValue(
  dataType: number,
  data: number,
  strings: string[],
): string | number | boolean | null {
  switch (dataType) {
    case TYPE_NULL:
      return null;
    case TYPE_STRING:
      return strings[data] || null;
    case TYPE_REFERENCE:
      return `@0x${data.toString(16).padStart(8, "0")}`;
    case TYPE_ATTRIBUTE:
      return `?0x${data.toString(16).padStart(8, "0")}`;
    case TYPE_INT_DEC:
      return data | 0;
    case TYPE_INT_HEX:
      return `0x${(data >>> 0).toString(16)}`;
    case TYPE_INT_BOOLEAN:
      return data !== 0;
    case TYPE_FLOAT: {
      const fb = Buffer.allocUnsafe(4);
      fb.writeUInt32LE(data);
      return fb.readFloatLE(0);
    }
    case TYPE_COLOR_ARGB8:
      return `#${(data >>> 0).toString(16).padStart(8, "0")}`;
    case TYPE_COLOR_RGB8:
      return `#${(data & 0xffffff).toString(16).padStart(6, "0")}`;
    default:
      return `0x${(data >>> 0).toString(16)}`;
  }
}

// ── XML parser ────────────────────────────────────────────────────────────────

/**
 * 解析 Android binary XML (AXML) buffer，返回 JSON 兼容的对象树。
 */
export function parse(buf: Buffer): ParseResult {
  const fileType = buf.readUInt16LE(0);
  if (fileType !== RES_XML_TYPE) {
    throw new Error(
      `Not an Android binary XML file (type: 0x${fileType.toString(16)})`,
    );
  }
  const fileSize = buf.readUInt32LE(4);

  let strings: string[] = [];
  const resourceIds: number[] = [];
  const nsStack: Array<{ prefix: string; uri: string }> = [];
  const nsMap: Record<string, string> = {};
  const nodeStack: XmlNode[] = [];
  let root: XmlNode | null = null;

  let pos = 8; // skip the outer RES_XML_TYPE header

  while (pos < fileSize && pos < buf.length) {
    const chunkType = buf.readUInt16LE(pos);
    const chunkSize = buf.readUInt32LE(pos + 4);

    if (chunkSize === 0) break;

    switch (chunkType) {
      case RES_STRING_POOL_TYPE:
        strings = readStringPool(buf, pos);
        break;

      case RES_XML_RESOURCE_MAP: {
        const count = (chunkSize - 8) / 4;
        for (let i = 0; i < count; i++) {
          resourceIds.push(buf.readUInt32LE(pos + 8 + i * 4));
        }
        break;
      }

      case RES_XML_START_NAMESPACE: {
        const prefix = strings[buf.readUInt32LE(pos + 16)] || "";
        const uri = strings[buf.readUInt32LE(pos + 20)] || "";
        nsStack.push({ prefix, uri });
        nsMap[uri] = prefix;
        break;
      }

      case RES_XML_END_NAMESPACE:
        nsStack.pop();
        break;

      case RES_XML_START_ELEMENT: {
        const lineNo = buf.readUInt32LE(pos + 8);
        const nsIdx = buf.readInt32LE(pos + 16);
        const nameIdx = buf.readUInt32LE(pos + 20);
        const attrStart = buf.readUInt16LE(pos + 24);
        const attrSize = buf.readUInt16LE(pos + 26);
        const attrCount = buf.readUInt16LE(pos + 28);

        const ns: string | null = nsIdx >= 0 ? strings[nsIdx] ?? null : null;
        const name = strings[nameIdx] || "";

        const attrs: AttributeMap = {};
        const attrBase = pos + 16 + attrStart;
        for (let i = 0; i < attrCount; i++) {
          const a = attrBase + i * attrSize;
          const aNsIdx = buf.readInt32LE(a);
          const aName = strings[buf.readUInt32LE(a + 4)] || "";
          const valDataType = buf.readUInt8(a + 15);
          const valData = buf.readUInt32LE(a + 16);

          const aNsStr = aNsIdx >= 0 ? strings[aNsIdx] : undefined;
          const attrKey =
            aNsStr ? `${nsMap[aNsStr] || aNsStr}:${aName}` : aName;

          attrs[attrKey] = resolveValue(valDataType, valData, strings);
        }

        const node: XmlNode = { name, ns, attrs, children: [], _line: lineNo };
        const top = nodeStack[nodeStack.length - 1];
        if (top) {
          top.children.push(node);
        } else {
          root = node;
        }
        nodeStack.push(node);
        break;
      }

      case RES_XML_END_ELEMENT:
        nodeStack.pop();
        break;

      case RES_XML_CDATA: {
        const dataIdx = buf.readInt32LE(pos + 16);
        const text = dataIdx >= 0 ? strings[dataIdx] : "";
        const top = nodeStack[nodeStack.length - 1];
        if (top && text) {
          top.children.push({ text });
        }
        break;
      }
    }

    pos += chunkSize;
  }

  return { root, strings, namespaces: Object.assign({}, nsMap) };
}

function flattenManifest(node: XmlNode): ManifestNode {
  const obj: ManifestNode = { _name: node.name, ...node.attrs };
  if (node.children && node.children.length > 0) {
    obj._children = node.children.map((c) =>
      "name" in c ? flattenManifest(c) : c,
    );
  }
  return obj;
}

/**
 * 解析二进制 XML 并从根元素返回简单的属性映射。
 * 适合快速读取 AndroidManifest.xml。
 */
export function parseManifest(buf: Buffer): ManifestNode {
  const { root } = parse(buf);
  if (!root || root.name !== "manifest") {
    throw new Error("Not an AndroidManifest.xml");
  }
  return flattenManifest(root);
}
