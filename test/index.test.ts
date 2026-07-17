import test from "node:test";
import assert from "node:assert/strict";
import { probeManifestVersion } from "../dist/index.js";

test("支付宝 APK", async () => {
  const r = await probeManifestVersion(
    "https://t.alipayobjects.com/L1/71/100/and/alipay_wap_main.apk",
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
  assert.equal(r.package, "com.tencent.mm");
  assert.ok(r.versionName);
  assert.ok(r.versionCode > 0);
  assert.ok(r.apkSize > 100_000_000);
  assert.ok(r.downloadedSize < 500_000, "downloadedSize should be <500KB");
  assert.equal(r.manifest._name, "manifest");
});

test("QQ APK", async () => {
  const r = await probeManifestVersion(
    "https://downv6.qq.com/qqweb/QQ_1/android_apk/9.3.25_a9d86b4594ac6bcb.apk",
  );
  assert.equal(r.package, "com.tencent.mobileqq");
  assert.ok(r.versionName);
  assert.ok(r.versionCode > 0);
  assert.ok(r.apkSize > 100_000_000);
  assert.ok(r.downloadedSize < 200_000);
  assert.equal(r.manifest._name, "manifest");
});
