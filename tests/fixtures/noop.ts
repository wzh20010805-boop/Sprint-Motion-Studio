// 跨平台命令夹具：确认结构化业务参数保留顺序，不依赖 POSIX 命令。
const expected = ["hero", "--output", "/tmp/unused.png", "--model", "v1", "--fast", "mode"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  console.error("业务参数未按顺序传递", process.argv.slice(2));
  process.exit(7);
}
