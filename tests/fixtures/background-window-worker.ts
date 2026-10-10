import { runPipelineCommand } from "../../apps/server/src/pipeline/probe";
import { runCmd } from "../../apps/server/src/jobs/run";

const [runner, ...argv] = process.argv.slice(2);
if (runner === "pipeline") await runPipelineCommand(argv);
else await runCmd(argv);
