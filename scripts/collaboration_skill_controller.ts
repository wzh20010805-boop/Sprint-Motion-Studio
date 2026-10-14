/** ROOT ONLY: 不属于 evaluator 工具投影；同账户文件系统不是物理权限隔离。 */
import {privilegedReviewSetup,finalizeScenarioControls,prepareSkillScenario,verifySkillScenarioOutcome} from './verify_collaboration_skill';
if(import.meta.main){const [command,arg,...rest]=process.argv.slice(2);try{let value:unknown;
 if(command==='review-setup')value=await privilegedReviewSetup(arg!);
 else if(command==='seal')value=await finalizeScenarioControls(arg!);
 else if(command==='prepare')value=await prepareSkillScenario(arg!);
 else if(command==='verify')value=await verifySkillScenarioOutcome(arg!,rest[0]!);
 else throw Error('ROOT ONLY: prepare NAME | review-setup WORKSPACE | seal WORKSPACE | verify NAME WORKSPACE');
 console.log(JSON.stringify(value));}catch(e){console.error(String(e));process.exit(1);}}
