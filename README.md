# @tofarfar/package-manifest

仅 HTTP Range 探测 APK 的 `AndroidManifest.xml`，无需下载整个文件，就能拿到 `package` / `versionName` / `versionCode` / 完整 manifest 树，以及 APK 总体积与本次实际下载字节数。

实测：对 260 MB 的支付宝 APK 只下载约 **58 KB**（占比 0.022%）；对 266 MB 的微信 APK 走 fallback 路径也只下载约 **164 KB**（0.062%）；QQ 410 MB → 51 KB（0.013%）。

Server 不支持 Range 时立即抛错，绝不体面降级为整包下载。

## 使用

```ts
import { probeManifestVersion } from "@tofarfar/package-manifest";

const info = await probeManifestVersion("https://example.com/app.apk");
// {
//   package: "com.x.y",
//   versionName: "1.0",
//   versionCode: 1,
//   apkSize: 259809169,        // APK 文件总体积（字节，来自 HEAD content-length）
//   downloadedSize: 58010,     // 本次探测实际下载字节数
//   manifest: {                // 完整 AndroidManifest.xml 解析树
//     _name: "manifest",
//     "android:versionName": "1.0",
//     "android:versionCode": 1,
//     _children: [ ... ]
//   }
// }
```

`manifest` 字段是经 `parseManifest` 解析后的完整树状结构（`ManifestNode`），包含根元素的所有属性以及 `_children` 子节点数组。如需对这个树做进一步字段提取，请直接读 `info.manifest`。

## 原理

APK 是 zip。`AndroidManifest.xml` 在绝大多数官方打包结果中是 zip 第 0 个 entry（LFH_off=0），所以单次 Range 拉头部约 60KB 就够。

少数 APK（如微信）把 `resources.arsc` 放到第 0 个位置，则 fallback 到扫 EOCD + 中央目录，找到 manifest 的真实 LFH 偏移再 Range 拉数据。

Range 不被服务器支持时立即抛 `Error`，绝不盲下整个 APK。

## 测试

```bash
npm run build && node --test
```

## 为什么不用 `fetch`

Node 内置的 `fetch`（基于 undici）在每次发起请求时**默认不复用 TCP/TLS 连接**——一次 `probeManifestVersion` 调用要发 2~6 个 HTTP 请求（HEAD + 多次 Range），每次都重做 DNS + TCP 三次握手 + TLS 握手，单个 TLS 握手通常 1s+，整体耗时轻松到 5s+，且并发场景下会瞬间打满 socket。

要让内置 `fetch` 复用连接，需通过 `dispatcher` 选项传入 undici `Agent`，但这会引入两个问题：

1. **依赖路径脆弱**：`undici` 未作为独立包暴露，`Agent` 类型来自 `undici-types`，跨 Node 版本（18 → 20 → 22 → 24）的内置版本行为存在细微差异。
2. **Node 18 LTS 兼容性**：`fetch` 在 v18.0.0 起加入但需 `--experimental-fetch`；v18.17+ 默认启用，但 `dispatcher` 选项直到 **v18.18.0** 才稳定。若目标运行环境为 v18.15/v18.16，行为可能不一致。

`node:https.Agent({ keepAlive: true })` 是自 Node 0.x 就存在的 LTS 长期稳定 API，跨 18/20/22/24 行为完全一致。本库用它建立 keep-alive 连接池，让 TLS 只握一次，后续 Range 请求直接复用同一连接——实测对支付宝将探测总耗时从 5.2s 降到 3.5s（-32%），QQ 从 4.6s 降到 3.4s（-25%）。
