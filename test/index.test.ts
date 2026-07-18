import test from "node:test";
import assert from "node:assert/strict";
import { probeManifestVersion } from "../dist/index.js";

test("支付宝 APK", async () => {
  const r = await probeManifestVersion(
    "https://t.alipayobjects.com/L1/71/100/and/alipay_wap_main.apk",
  );
  console.log(
    r.versionName,
    ((r.downloadedSize * 100) / r.apkSize).toFixed(2) + "%",
  );
  assert.equal(r.package, "com.eg.android.AlipayGphone");
  assert.ok(r.versionName);
  assert.ok(r.versionCode > 0);
  assert.ok(r.apkSize > 100_000_000, "apkSize should be >100MB");
  assert.ok(r.downloadedSize < 200_000, "downloadedSize should be <200KB");
  assert.equal(r.manifest._name, "manifest");
  assert.ok(r.manifest._children && r.manifest._children.length > 0);
});

test("微信 APK（走慢路径）", async () => {
  const r = await probeManifestVersion(
    "https://dldir1v6.qq.com/weixin/android/weixin8076android3140_0x28004c30_arm64.apk",
  );
  console.log(
    r.versionName,
    ((r.downloadedSize * 100) / r.apkSize).toFixed(2) + "%",
  );
  assert.equal(r.package, "com.tencent.mm");
  assert.ok(r.versionName);
  assert.ok(r.versionCode > 0);
  assert.ok(r.apkSize > 100_000_000);
  assert.ok(r.downloadedSize < 500_000, "downloadedSize should be <500KB");
  assert.equal(r.manifest._name, "manifest");
});

test("QQ APK（从 mobileConfig.json 取 x64Link）", async () => {
  const cfg = (await fetch(
    "https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/mobileConfig.json",
  ).then((r) => r.json())) as { android: { x64Link: string } };
  const url = cfg.android.x64Link;
  assert.ok(url, "mobileConfig.json 应该返回 android.x64Link");
  const r = await probeManifestVersion(url);
  console.log(
    r.versionName,
    ((r.downloadedSize * 100) / r.apkSize).toFixed(2) + "%",
  );
  assert.equal(r.package, "com.tencent.mobileqq");
  assert.ok(r.versionName);
  assert.ok(r.versionCode > 0);
  assert.ok(r.apkSize > 100_000_000);
  assert.ok(r.downloadedSize < 200_000);
  assert.equal(r.manifest._name, "manifest");
});

test("微信键盘 APK（manifest 不在第 0 个，走慢路径扫 CD）", async () => {
  const r = await probeManifestVersion(
    "https://download.z.weixin.qq.com/app/android/3.5.2/wxkb_1258.apk",
  );
  console.log(
    r.versionName,
    ((r.downloadedSize * 100) / r.apkSize).toFixed(2) + "%",
  );
  assert.equal(r.package, "com.tencent.wetype");
  assert.ok(r.versionName);
  assert.ok(r.versionCode > 0);
  assert.ok(r.apkSize > 100_000_000);
  assert.ok(r.downloadedSize < 500_000, "downloadedSize should be <500KB");
  assert.equal(r.manifest._name, "manifest");
});
