/** CLI 的真实独立子进程；fetch 包装只保留实际 HTTP 观察。 */
import {assertScenarioWorkspace,capture,validateEvaluatorCli,record} from './verify_collaboration_skill';
const [input,phase,...args]=process.argv.slice(2);
try{const workspace=assertScenarioWorkspace(input!);validateEvaluatorCli(args);if(!['setup','evaluator','controller_probe'].includes(phase!))throw Error('INVALID_PHASE');
 const result=await capture(workspace,phase!,async()=>{const {run}=await import('../apps/cli/src/index');return run([...args,'--workspace',workspace,'--json']);});
 if(result.body!==null)console.log(JSON.stringify(result.body));process.exit(result.exitCode);
}catch(error){console.error(String(error));process.exit(1);}
