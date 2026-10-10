import { beforeAll, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const windowsTest = process.platform === "win32" ? test : test.skip;
const powershell = join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
let worker: string;

beforeAll(async () => {
  if (process.platform !== "win32") return;
  const directory = join(import.meta.dir, "../../fixtures/generated/background-window", crypto.randomUUID());
  await mkdir(directory, { recursive: true });
  worker = join(directory, "no-console-worker.exe");
  const build = Bun.spawn([process.execPath, "build", join(import.meta.dir, "../fixtures/background-window-worker.ts"), "--compile", "--windows-hide-console", "--outfile", worker], { windowsHide: true, stdout: "ignore", stderr: "pipe" });
  const [code, error] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  expect(code, error).toBe(0);
}, 30000);

function windowProbe(output: string): string[] {
  const script = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NativeConsole { [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Startup { public uint cb; public IntPtr reserved,desktop,title; public uint x,y,width,height,cols,rows,fill,flags; public ushort show,reservedSize; public IntPtr reservedPtr,input,output,error; } [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern void GetStartupInfoW(out Startup info); public static bool HiddenRequested() { Startup info; GetStartupInfoW(out info); return (info.flags & 1) != 0 && info.show == 0; } [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }'
$result = @{ visible = [NativeConsole]::IsWindowVisible([NativeConsole]::GetConsoleWindow()); hidden_requested = [NativeConsole]::HiddenRequested(); pid = $PID } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText('${output.replaceAll("'", "''")}', $result)
Write-Output $result
`;
  return [powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

for (const [name, runner] of [["完整抽帧命令", "pipeline"], ["兼容任务命令", "legacy"]] as const) {
  windowsTest(`${name}在 Windows 显式隐藏后台控制台`, async () => {
    const directory = join(import.meta.dir, "../../fixtures/generated/background-window", crypto.randomUUID());
    await mkdir(directory, { recursive: true });
    const output = join(directory, "console.json");
    // 无控制台的桌面宿主不应让后台工具创建可见控制台。
    const child = spawn(worker, [runner, ...windowProbe(output)], {
      detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let error = "";
    child.stdout!.resume();
    child.stderr!.on("data", chunk => error += chunk);
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    expect(code, error).toBe(0);
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(report.pid).toBeGreaterThan(0);
    expect(report.hidden_requested).toBeTrue();
    expect(report.visible).toBeFalse();
  }, 15000);
}
