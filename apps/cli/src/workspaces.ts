import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface WorkspaceResolutionOptions {
 repositoryRoot:string;
 distributionRoot?:string|null;
 explicit?:string;
 env?:Record<string,string|undefined>;
}
export interface WorkspaceRegistry {
 schema_version:1;
 current:string|null;
 workspaces:Array<{name:string;path:string}>;
}
export interface WorkspaceServiceStatus {
 status:'stopped'|'stale'|'invalid'|'unreachable'|'running';
 pid?:number;
 url?:string;
}
export class WorkspaceError extends Error {
 constructor(public code:string,message:string){super(`${code}: ${message}`);}
}

export function normalizeWorkspacePath(input:string):string {
 const path=resolve(input);
 return existsSync(path)&&statSync(path).isDirectory()?realpathSync(path):path;
}
const pathKey=(value:string)=>process.platform==='win32'?normalizeWorkspacePath(value).toLowerCase():normalizeWorkspacePath(value);
export function sameWorkspacePath(left:string,right:string):boolean {return pathKey(left)===pathKey(right);}
const nameKey=(value:string)=>value.toLowerCase();
function userRoot(options:WorkspaceResolutionOptions) {
 const env=options.env??process.env;
 return join(env.LOCALAPPDATA??env.HOME??options.distributionRoot??options.repositoryRoot,'SpriteMotionStudio');
}
export function workspaceRegistryPath(options:WorkspaceResolutionOptions):string {
 return options.distributionRoot?join(userRoot(options),'workspaces.json'):join(resolve(options.repositoryRoot),'.sfs','workspaces.json');
}
function canonicalDefault(options:WorkspaceResolutionOptions):string {
 return normalizeWorkspacePath(options.distributionRoot?join(userRoot(options),'workspaces','default'):join(resolve(options.repositoryRoot),'workspaces','default'));
}
function validName(name:unknown):name is string {
 return typeof name==='string'&&name.length>0&&name.length<=64&&name===name.trim()&&!/[\\/\x00-\x1f]/.test(name);
}
function validAbsolute(path:unknown):path is string {
 return typeof path==='string'&&path.length>0&&isAbsolute(path)&&!path.includes('\0');
}
export function loadWorkspaceRegistry(options:WorkspaceResolutionOptions):WorkspaceRegistry {
 const path=workspaceRegistryPath(options);
 if(!existsSync(path))return {schema_version:1,current:null,workspaces:[]};
 try {
  const value=JSON.parse(readFileSync(path,'utf8'));
  if(!value||value.schema_version!==1||!(value.current===null||validAbsolute(value.current))||!Array.isArray(value.workspaces))throw new Error('登记结构不正确');
  const names=new Set<string>(),paths=new Set<string>();
  for(const entry of value.workspaces){
   if(!entry||!validName(entry.name)||!validAbsolute(entry.path)||names.has(nameKey(entry.name))||paths.has(pathKey(entry.path)))throw new Error('工作区名称或路径重复、无效');
   names.add(nameKey(entry.name));paths.add(pathKey(entry.path));
  }
  return {schema_version:1,current:value.current,workspaces:value.workspaces.map((entry:{name:string;path:string})=>({name:entry.name,path:normalizeWorkspacePath(entry.path)}))};
 }catch(error){throw new WorkspaceError('WORKSPACE_REGISTRY_INVALID',`工作区登记无法读取：${path}；${(error as Error).message}`);}
}
function existingDirectory(directory:string):string {
 const path=resolve(directory);
 if(!existsSync(path)||!statSync(path).isDirectory())throw new WorkspaceError('WORKSPACE_NOT_FOUND',`工作区目录不存在：${path}`);
 return realpathSync(path);
}
export function resolveWorkspace(options:WorkspaceResolutionOptions):string {
 if(options.explicit!==undefined){
  if(!options.explicit.trim())throw new WorkspaceError('INVALID_ARGUMENT','工作区路径不能为空');
  return normalizeWorkspacePath(options.explicit);
 }
 const environment=(options.env??process.env).SFS_WORKSPACE;
 if(environment?.trim())return normalizeWorkspacePath(environment);
 const selected=loadWorkspaceRegistry(options).current;
 return selected?existingDirectory(selected):canonicalDefault(options);
}
function saveRegistry(options:WorkspaceResolutionOptions,registry:WorkspaceRegistry) {
 const path=workspaceRegistryPath(options),temporary=`${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
 mkdirSync(dirname(path),{recursive:true});
 try {
  writeFileSync(temporary,JSON.stringify(registry,null,2)+'\n',{flag:'wx'});
  renameSync(temporary,path);
 }finally {if(existsSync(temporary))unlinkSync(temporary);}
}
function updateRegistry<T>(options:WorkspaceResolutionOptions,update:(registry:WorkspaceRegistry)=>T):T {
 const path=workspaceRegistryPath(options),lockPath=path+'.lock',owner=crypto.randomUUID();
 mkdirSync(dirname(path),{recursive:true});
 let descriptor:number;
 try {descriptor=openSync(lockPath,'wx',0o600);}
 catch(error){
  if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  throw new WorkspaceError('WORKSPACE_REGISTRY_LOCKED',`另一进程正在更新工作区登记，请稍后重试。若持续出现，请由登记所有者核查 ${lockPath} 的进程归属；不会自动删除未知锁。`);
 }
 try {
  writeFileSync(descriptor,JSON.stringify({instance_id:owner,pid:process.pid}));
  return update(loadWorkspaceRegistry(options));
 }finally {
  closeSync(descriptor);
  let owned=false;
  try {const lock=JSON.parse(readFileSync(lockPath,'utf8'));owned=lock.instance_id===owner&&lock.pid===process.pid;}catch{/* 未知锁不得自动移除。 */}
  if(owned)unlinkSync(lockPath);
 }
}
export function registerWorkspace(options:WorkspaceResolutionOptions,name:string,directory:string):string {
 if(!validName(name))throw new WorkspaceError('INVALID_ARGUMENT','名称须为1到64个字符，不能含路径分隔符或控制字符');
 const path=existingDirectory(directory);
 return updateRegistry(options,registry=>{
  const sameName=registry.workspaces.find(entry=>nameKey(entry.name)===nameKey(name));
  if(sameName){
   if(pathKey(sameName.path)!==pathKey(path))throw new WorkspaceError('WORKSPACE_NAME_CONFLICT',`名称已经用于另一工作区：${name}`);
   return path;
  }
  const samePath=registry.workspaces.find(entry=>pathKey(entry.path)===pathKey(path));
  if(samePath)throw new WorkspaceError('WORKSPACE_ALREADY_REGISTERED',`此目录已登记为 ${samePath.name}`);
  registry.workspaces.push({name,path});saveRegistry(options,registry);return path;
 });
}
export function selectWorkspace(options:WorkspaceResolutionOptions,selection:{name?:string;directory?:string}):string {
 if(Boolean(selection.name)===Boolean(selection.directory))throw new WorkspaceError('INVALID_ARGUMENT','请选择名称或目录中的一种');
 return updateRegistry(options,registry=>{
  const entry=selection.name?registry.workspaces.find(entry=>nameKey(entry.name)===nameKey(selection.name!)):null;
  if(selection.name&&!entry)throw new WorkspaceError('WORKSPACE_NOT_FOUND',`未登记工作区：${selection.name}`);
  const selected=existingDirectory(selection.directory??entry!.path);
  registry.current=selected;saveRegistry(options,registry);return selected;
 });
}

/** 只读服务身份探测；不返回服务令牌，不访问审核私有描述文件。 */
async function inspectService(workspace:string):Promise<WorkspaceServiceStatus> {
 const path=join(workspace,'.sfs','service.json');
 if(!existsSync(path))return {status:'stopped'};
 let info:any;
 try {
  info=JSON.parse(readFileSync(path,'utf8'));
  if(!Number.isSafeInteger(info.pid)||info.pid<=0||!validAbsolute(info.workspace)||pathKey(info.workspace)!==pathKey(workspace)||typeof info.instance_id!=='string'||!info.instance_id||typeof info.url!=='string'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url))return {status:'invalid'};
  const port=Number(new URL(info.url).port);if(port<1||port>65535)return {status:'invalid'};
 }catch{return {status:'invalid'};}
 try {process.kill(info.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code!=='EPERM')return {status:'stale'};}
 try {
  const response=await fetch(`${info.url}/api/health`,{signal:AbortSignal.timeout(1000)}),health=await response.json() as any;
  if(response.ok&&health.ok===true&&health.pid===info.pid&&health.instance_id===info.instance_id)return {status:'running',pid:info.pid,url:info.url};
 }catch{/* 无法匹配当前服务身份时，不公布历史端口。 */}
 return {status:'unreachable'};
}
export async function listWorkspaces(options:WorkspaceResolutionOptions) {
 const registry=loadWorkspaceRegistry(options),current=resolveWorkspace(options),defaultPath=canonicalDefault(options);
 const entries=registry.workspaces.map(entry=>({...entry,registered:true}));
 const appendHint=(name:string,path:string)=>{
  if(entries.some(entry=>pathKey(entry.path)===pathKey(path)))return;
  let label=name,index=1;while(entries.some(entry=>nameKey(entry.name)===nameKey(label)))label=`@${name}-${index++}`;
  entries.push({name:label,path,registered:false});
 };
 appendHint('default',defaultPath);appendHint('selected',current);
 return {current,registry:workspaceRegistryPath(options),entries:await Promise.all(entries.map(async entry=>({...entry,current:pathKey(entry.path)===pathKey(current),default:pathKey(entry.path)===pathKey(defaultPath),exists:existsSync(entry.path),service:await inspectService(entry.path)})))};
}
