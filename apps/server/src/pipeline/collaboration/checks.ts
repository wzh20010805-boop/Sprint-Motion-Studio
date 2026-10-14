import type {CandidateCheckReport} from '@framebaker/shared';
import {join} from 'node:path';
import {db,STORAGE_ROOT,uid} from '../../db';
import {runImageWorker} from '../masks';
import {candidateDirectory,readCandidate,readCandidateManifest,verifyCandidateFiles} from './candidates';
import {operationJson} from './operations';

export async function checkCandidate(id:string):Promise<CandidateCheckReport> {
  const record=readCandidate(id),manifest=readCandidateManifest(id),checkId=uid();
  const report:CandidateCheckReport={id:checkId,candidate_id:id,content_hash:record.content_hash,manifest_sha256:record.manifest_sha256,checked_frame_count:0,blocking_errors:[],warnings:[]};
  const expected=manifest.brief.ordered_source_frame_ids;
  if(manifest.frames.length!==expected.length||manifest.coverage.length!==expected.length||new Set(manifest.frames.map(f=>f.frame_id)).size!==expected.length||manifest.frames.some((f,i)=>f.sequence_index!==i||f.source_frame_id!==expected[i]||manifest.coverage[i]?.frame_id!==f.frame_id||manifest.coverage[i]?.source_frame_id!==f.source_frame_id))report.blocking_errors.push({code:'SOURCE_COVERAGE_MISMATCH'});
  const {grid,output,alignment}=manifest;
  if(grid.margin!==output.margin||grid.gap!==output.gap||grid.columns!==Math.floor((output.max_texture-2*output.margin+output.gap)/(alignment.canvas.width+output.gap))||grid.rows!==Math.floor((output.max_texture-2*output.margin+output.gap)/(alignment.canvas.height+output.gap)))report.blocking_errors.push({code:'SHEET_LAYOUT_MISMATCH'});
  const result=await runImageWorker({action:'check_candidate',directory:candidateDirectory(id),manifest},join(STORAGE_ROOT,'candidate-checks',checkId));
  report.checked_frame_count=result.checked_frame_count;report.blocking_errors.push(...result.blocking_errors);report.warnings.push(...result.warnings);
  try {readCandidateManifest(id);verifyCandidateFiles(id,manifest);}catch(error){report.blocking_errors.push({code:'CANDIDATE_FILE_CHANGED',detail:String(error)});}
  db.query('UPDATE candidates SET technical_check_id=?,technical_check_json=? WHERE id=?').run(checkId,operationJson(report),id);
  return report;
}
