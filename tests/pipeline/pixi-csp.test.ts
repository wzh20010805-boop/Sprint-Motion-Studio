import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { createHash } from "node:crypto";
import { app } from "../../apps/server/src/app";

test("实际自托管 Pixi 脚本可在禁止动态代码生成的 CSP 环境通过渲染器检查", async () => {
  const response = await app.handle(new Request("http://localhost/pixi.min.js"));
  expect(response.status).toBe(200);
  const context = createContext({ console, navigator: { userAgent: "CSP 测试" }, setTimeout, clearTimeout, performance, URL, Blob, EventTarget, Event }, { codeGeneration: { strings: false, wasm: false } });
  runInContext(await response.text(), context);
  expect(() => runInContext('new Function("return 1")', context)).toThrow();
  expect(() => runInContext("PIXI.AbstractRenderer.prototype._unsafeEvalCheck.call({})", context)).not.toThrow();
});

test("普通与 gzip Pixi 响应内容一致，且条件缓存分别可重验证", async () => {
  const plain = await app.handle(new Request("http://localhost/pixi.min.js"));
  const gzip = await app.handle(new Request("http://localhost/pixi.min.js", { headers: { "Accept-Encoding": "gzip" } }));
  expect(gzip.headers.get("Content-Encoding")).toBe("gzip");
  const plainBytes = new Uint8Array(await plain.arrayBuffer());
  const gzipBytes = Bun.gunzipSync(new Uint8Array(await gzip.arrayBuffer()));
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  expect(digest(gzipBytes)).toBe(digest(plainBytes));
  expect(gzip.headers.get("ETag")).not.toBe(plain.headers.get("ETag"));
  for (const response of [plain, gzip]) {
    const revalidated = await app.handle(new Request("http://localhost/pixi.min.js", { headers: { "If-None-Match": response.headers.get("ETag")!, ...(response === gzip ? { "Accept-Encoding": "gzip" } : {}) } }));
    expect(revalidated.status).toBe(304);
  }
});
