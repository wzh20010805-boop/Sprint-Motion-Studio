import type {CandidateFrame,DraftFrame,ContentToken,Page,ReviewIssuePage,WorkContext} from '@framebaker/shared';
import {existsSync} from 'node:fs';
import {db} from '../../db';
import {PipelineError} from '../service';
import {fileHash} from '../alignment';
import {readDraftContent} from './drafts';
import {readCandidate,readCandidateManifest,candidateFilePath} from './candidates';
import {candidateFiles} from './candidateIdentity';
import {readReviewState} from './reviews';
import {collaborationHash} from './operations';
import {readTaskRecord} from './store';
function page<T>(items:T[],identity:unknown,token:ContentToken,cursor?:string,limit=32):Page<T> {
 if(!Number.isSafeInteger(limit)||limit<1||limit>300||cursor!==undefined&&(typeof cursor!=='string'||cursor.length>1024))throw new PipelineError('INVALID_PAGE','分页参数无效');
 const binding=collaborationHash(identity);let offset=0;
 if(cursor){try{const saved=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(saved.binding!==binding||!Number.isSafeInteger(saved.offset)||saved.offset<0||saved.offset>=items.length)throw Error();offset=saved.offset;}catch{throw new PipelineError('PAGE_CONFLICT','分页身份已改变或游标不属于该内容，请重新读取首页',409);}}
 const end=Math.min(offset+limit,items.length);
 return {items:items.slice(offset,end),total:items.length,next_cursor:end<items.length?Buffer.from(JSON.stringify({binding,offset:end})).toString('base64url'):null,complete:end===items.length,content_token:token};
}
export function listFrames(context:WorkContext,cursor?:string,limit=32):Page<DraftFrame> {const d=readDraftContent(context);return page(d.frames,{kind:'draft',context,token:d.token},d.token,cursor,limit);}
export function listCandidateFrames(id:string,cursor?:string,limit=32):Page<CandidateFrame> {const m=readCandidateManifest(id);return page(m.frames,{kind:'candidate',id,content_hash:m.content_hash},m.content_token,cursor,limit);}
export function listReviewIssues(id:string,cursor?:string,limit=32):ReviewIssuePage {const m=readCandidateManifest(id),review=readReviewState(id);return {...page(review.issues,{kind:'issues',id,content_hash:m.content_hash,review_revision:review.review_revision},m.content_token,cursor,limit),review_revision:review.review_revision};}
export function inspectTask(id:string){const task=readTaskRecord(id),brief=db.query('SELECT brief_json FROM task_briefs WHERE task_id=? AND version=?').get(id,task.brief_version) as {brief_json:string};return {task,brief:JSON.parse(brief.brief_json),candidate_ids:(db.query('SELECT id FROM candidates WHERE task_id=? ORDER BY created_at,id').all(id) as {id:string}[]).map(c=>c.id)};}
export function inspectCandidate(id:string){const record=readCandidate(id),manifest=readCandidateManifest(id),row=db.query('SELECT technical_check_json,self_check_json FROM candidates WHERE id=?').get(id) as {technical_check_json:string|null;self_check_json:string|null};return {record,manifest,technical_check:row.technical_check_json?JSON.parse(row.technical_check_json):null,self_check:row.self_check_json?JSON.parse(row.self_check_json):null};}
/** HTTP 只交付固定清单明确列出的文件；目录内其他文件也不可读取。 */
export function immutableCandidateFile(id:string,file:string):string {const m=readCandidateManifest(id),record=readCandidate(id),entry=file==='manifest.json'?{file,sha256:record.manifest_sha256}:candidateFiles(m).find(x=>x.file===file);if(!entry)throw new PipelineError('CANDIDATE_FILE_NOT_FOUND','文件不在固定清单中',404);const path=candidateFilePath(id,file);if(!existsSync(path)||fileHash(path)!==entry.sha256)throw new PipelineError('CANDIDATE_FILE_CHANGED','固定文件字节已变化',409);return path;}
