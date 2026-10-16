import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const desktopTest = process.platform === "win32" ? test : test.skip;
desktopTest("设置页统一保存五组配置，部分失败如实报告，草稿及已保存配置逐次撤销", async () => {
  const repo = resolve(import.meta.dir, "../..");
  const evidence = join(repo, "fixtures/generated/settings-page-commands", crypto.randomUUID());
  mkdirSync(evidence, { recursive: true });
  const source = (path: string) => JSON.stringify(join(repo, path).replaceAll("\\", "/"));
  const fixture = join(evidence, "fixture.tsx");
  writeFileSync(fixture, `import {createElement as h} from ${source("apps/web/node_modules/react")};
import {createRoot} from ${source("apps/web/node_modules/react-dom/client")};
import SettingsPage from ${source("apps/web/src/components/SettingsPage.tsx")};
import {editingCommands} from ${source("apps/web/src/editingCommands.ts")};
(window as any).fixtureCommands={state:()=>editingCommands.getSnapshot(),run:async(command:any)=>{try{return {ok:await editingCommands.execute(command)}}catch(error){return {ok:false,error:(error as Error).message}}}};
createRoot(document.getElementById('root')!).render(h(SettingsPage));`);
  const build = await Bun.build({ entrypoints: [fixture], target: "browser", outdir: join(evidence, "build") });
  expect(build.success, build.logs.join("\n")).toBeTrue();
  const settings: Record<string, any> = {
    genProviders: [{ id: "provider", name: "provider-original", type: "api", cliBin: "", cliPromptArg: "", cliOutputArg: "", cliModelArg: "", cliReferenceArg: "", cliExtraArgs: "", apiBaseUrl: "https://fixture.invalid", apiKey: "", imageModels: ["image-model"], videoModels: [], textModels: ["text-model"], imageSize: "", videoSize: "" }],
    matting: { cliBin: "mat-original", cliInputArg: "", cliOutputArg: "", cliModelArg: "", model: "u2net" },
    imageLayers: { apiBaseUrl: "https://fixture.invalid", apiKey: "", model: "layer-original" },
    queueConcurrency: 2,
    promptEnhancers: [{ id: "enhancer", name: "enhancer-original", providerId: "provider", model: "text-model" }],
    theme: "untouched-theme", lang: "untouched-language",
  };
  const writes: string[] = [];
  let failGroup: string | null = null;
  let failRefresh = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<html lang="zh-CN"><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
    if (path === "/fixture.js") return new Response(Bun.file(build.outputs[0]!.path));
    if (path === "/styles.css") return new Response(Bun.file(join(repo, "apps/web/src/styles.css")));
    if (path === "/api/settings" && request.method === "GET") return Response.json(settings);
    if (path.startsWith("/api/settings/") && request.method === "PUT") {
      const key = path.split("/").at(-1)!;
      if (key === failGroup) return new Response("SAVE_FAILED_FIXTURE", { status: 409 });
      settings[key] = (await request.json() as { value: unknown }).value;
      writes.push(key);
      return Response.json({ ok: true });
    }
    if (path === "/api/config") return failRefresh ? new Response("REFRESH_FAILED_FIXTURE", { status: 503 }) : Response.json({ gen: { providers: settings.genProviders }, matting: { engine: "none", model: settings.matting.model, modelCached: true }, imageLayers: { configured: false, model: settings.imageLayers.model }, queueConcurrency: settings.queueConcurrency, promptEnhancers: settings.promptEnhancers });
    if (path === "/api/doctor") return Response.json({ checks: [] });
    if (path === "/test/failure") { failGroup = (await request.json() as { group: string | null }).group; return Response.json({ ok: true }); }
    if (path === "/test/refresh-failure") { failRefresh = (await request.json() as { failed: boolean }).failed; return Response.json({ ok: true }); }
    // 测试证据只返回非敏感名称及写入的分组名，不包含连接凭证。
    if (path === "/test/state") return Response.json({ writes, queue: settings.queueConcurrency, provider: settings.genProviders[0].name, mat: settings.matting.cliBin, layer: settings.imageLayers.model, enhancer: settings.promptEnhancers[0].name, preferencesUntouched: settings.theme === "untouched-theme" && settings.lang === "untouched-language" });
    return Response.json({});
  } });
  const runner = join(evidence, "check.cjs");
  writeFileSync(runner, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(join(evidence, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});const js=s=>w.webContents.executeJavaScript(s);const pause=ms=>new Promise(r=>setTimeout(r,ms));const until=async s=>{for(let i=0;i<150;i++){if(await js(s))return;await pause(40);}throw Error('Timed out: '+s);};
const edit=async(selector,value)=>{await js('(()=>{const input='+selector+';Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(String(value))+');input.dispatchEvent(new Event("input",{bubbles:true}));})()');await pause(50);};const state=()=>js('fetch("/test/state").then(r=>r.json())');const command=name=>js('fixtureCommands.run('+JSON.stringify(name)+')');const failure=group=>js('fetch("/test/failure",{method:"POST",body:JSON.stringify({group:'+JSON.stringify(group)+'})})');
try{await w.loadURL(${JSON.stringify(server.url.toString())});await until('!!window.fixtureCommands && !fixtureCommands.state().busy && document.querySelectorAll(".provider-name").length===2');assert.equal(await js('fixtureCommands.state().label'),'设置');
await edit('document.querySelectorAll(".provider-name")[0]','provider-new');await edit('document.querySelector("input[placeholder*=mymatte]")','mat-new');await edit('document.querySelector("input[placeholder=Qwen-Image-Layered]")','layer-new');await edit('document.querySelector("input[type=number]")',4);await edit('document.querySelectorAll(".provider-name")[1]','enhancer-new');
assert.equal((await command('save')).ok,true);let saved=await state();assert.deepEqual(saved.writes,['genProviders','matting','imageLayers','queueConcurrency','promptEnhancers']);assert.equal(saved.enhancer,'enhancer-new');assert.equal(await js('fixtureCommands.state().dirty'),false);
for(let i=0;i<5;i++)assert.equal((await command('undo')).ok,true);let restored=await state();assert.equal(restored.provider,'provider-original');assert.equal(restored.mat,'mat-original');assert.equal(restored.layer,'layer-original');assert.equal(restored.queue,2);assert.equal(restored.enhancer,'enhancer-original');
await edit('document.querySelector("input[type=number]")',5);await js('[...document.querySelectorAll("button")].find(button=>button.textContent.includes("保存并发设置")).click()');await until('!fixtureCommands.state().busy && document.querySelector("input[type=number]").value==="5"');assert.equal((await state()).queue,5);assert.equal((await command('undo')).ok,true);assert.equal((await state()).queue,2);
await edit('document.querySelectorAll(".provider-name")[0]','provider-partial');await edit('document.querySelector("input[placeholder*=mymatte]")','mat-partial');await failure('matting');assert.equal((await command('save')).ok,false);assert.equal(await js('fixtureCommands.state().result'),'failed');let partial=await state();assert.equal(partial.provider,'provider-partial');assert.equal(partial.mat,'mat-original');const beforeRetry=partial.writes.length;await failure(null);assert.equal((await command('save')).ok,true);assert.deepEqual((await state()).writes.slice(beforeRetry),['matting']);assert.equal((await command('undo')).ok,true);assert.equal((await command('undo')).ok,true);
const beforeInvalid=(await state()).writes.length;await edit('document.querySelectorAll(".provider-name")[0]','invalid-pending');await edit('document.querySelector("input[type=number]")',0);assert.equal((await command('save')).ok,false);assert.equal((await state()).writes.length,beforeInvalid);assert.equal((await command('undo')).ok,true);assert.equal((await command('undo')).ok,true);
await edit('document.querySelector("input[type=number]")',7);assert.equal((await command('save')).ok,true);await failure('queueConcurrency');assert.equal((await command('undo')).ok,false);assert.equal(await js('document.querySelector("input[type=number]").value'),'7');assert.equal(await js('fixtureCommands.state().canUndo'),true);await failure(null);assert.equal((await command('undo')).ok,true);assert.equal((await state()).queue,2);assert.equal((await state()).preferencesUntouched,true);assert.ok((await state()).writes.every(key=>['genProviders','matting','imageLayers','queueConcurrency','promptEnhancers'].includes(key)));
await edit('document.querySelector("input[type=number]")',9);await js('fetch("/test/refresh-failure",{method:"POST",body:JSON.stringify({failed:true})})');assert.equal((await command('save')).ok,false);assert.equal((await state()).queue,9);assert.equal(await js('fixtureCommands.state().canSave'),true,'failed refresh must remain retryable');const savedBeforeRefreshRetry=(await state()).writes.length;await js('fetch("/test/refresh-failure",{method:"POST",body:JSON.stringify({failed:false})})');assert.equal((await command('save')).ok,true);assert.equal((await state()).writes.length,savedBeforeRefreshRetry,'refresh retry must not repeat persisted writes');assert.equal((await command('undo')).ok,true);assert.equal((await state()).queue,2);
fs.writeFileSync(${JSON.stringify(join(evidence, "result.json"))},JSON.stringify({ok:true,groups:5,partialFailureHandled:true,persistedUndo:true}));app.exit(0);
}catch(error){fs.writeFileSync(${JSON.stringify(join(evidence, "result.json"))},JSON.stringify({ok:false,error:error.stack}));app.exit(1);}});`);
  try {
    const child = Bun.spawn([join(repo, "probes/desktop/node_modules/electron/dist/electron.exe"), runner], { cwd: repo, windowsHide: true, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const result = existsSync(join(evidence, "result.json")) ? readFileSync(join(evidence, "result.json"), "utf8") : "Electron did not write a result";
    expect(code, `${result}\n${stdout}\n${stderr}\n${evidence}`).toBe(0);
    expect(JSON.parse(result).ok).toBeTrue();
  } finally { await server.stop(true); }
}, 60000);
