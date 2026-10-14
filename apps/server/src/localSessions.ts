import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ActorContext } from '@framebaker/shared';

export class LocalAuthError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}
export function equalLocalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
let instance = '', makerToken = '';
const reviewers = new Map<string, ActorContext>();
const actors = new WeakMap<Request, ActorContext>();
let makerActors = new WeakSet<ActorContext>();

/** 只在取得工作区锁后初始化；重启不恢复任何审核凭据。 */
export function initializeLocalSessions(instanceId: string, token: string) {
  instance = instanceId; makerToken = token; reviewers.clear(); makerActors=new WeakSet();
}
export function clearLocalSessions(instanceId: string) {
  if (instance === instanceId) { instance = ''; makerToken = ''; reviewers.clear(); }
}
export function issueReviewerSession(instanceId: string): string {
  if (!instance || instance !== instanceId) throw new LocalAuthError('BOOTSTRAP_INSTANCE_MISMATCH', 403);
  if (reviewers.size >= 1024) throw new LocalAuthError('BOOTSTRAP_CAPACITY', 503);
  const secret = randomBytes(32).toString('hex');
  reviewers.set(secret, Object.freeze({ session_id: `${instance}:reviewer:${randomBytes(16).toString('hex')}`, role: 'reviewer' }));
  return secret;
}
export function validateLocalAuthority(request: Request, authority: string) {
  const url = new URL(request.url);
  if (url.host !== authority || (request.headers.get('host') ?? url.host) !== authority ||
      (request.headers.has('origin') && request.headers.get('origin') !== `http://${authority}`)) {
    throw new LocalAuthError('INVALID_ORIGIN', 403);
  }
}
/** 有效审核 Cookie 优先；失效 Cookie 不能提升制作凭据。 */
export function authenticateLocalRequest(request: Request, authority: string): ActorContext {
  validateLocalAuthority(request, authority);
  const cookies = new Map((request.headers.get('cookie') ?? '').split(';').map(part => {
    const pos = part.indexOf('='); return [part.slice(0, pos).trim(), part.slice(pos + 1).trim()];
  }));
  const reviewer = reviewers.get(cookies.get('sfs_reviewer') ?? '');
  let actor = reviewer;
  if (!actor && instance && (equalLocalSecret(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '', makerToken) ||
      equalLocalSecret(cookies.get('sfs_token') ?? '', makerToken))) {
    actor = Object.freeze({ session_id: `${instance}:maker`, role: 'maker' });
  }
  if (!actor) throw new LocalAuthError('UNAUTHORIZED', 401);
  if(actor.role==='maker')makerActors.add(actor);
  actors.set(request, actor);
  return actor;
}
/** Adapter 只读取服务绑定的上下文，不读取 body/header 的角色声明。 */
export function getRequestActor(request: Request): ActorContext {
  const actor = actors.get(request);
  if (!actor) throw new LocalAuthError('UNAUTHORIZED', 401);
  return actor;
}
export function requireRole(actor: ActorContext, role: 'maker' | 'reviewer'): void {
  if (actor.role !== 'reviewer' && (role !== 'maker' || actor.role !== 'maker')) throw new LocalAuthError('ROLE_FORBIDDEN', 403);
}

/** 审核写入要求本实例签发且仍有效的对象；客户端复制角色/会话字符串不能授权。 */
export function requireCurrentReviewer(actor: ActorContext): void {
  if (!instance || actor?.role !== 'reviewer' || ![...reviewers.values()].includes(actor)) throw new LocalAuthError('ROLE_FORBIDDEN', 403);
}

/** 恢复也要求当前实例实际认证对象，字符串角色不构成授权。 */
export function requireCurrentMaker(actor:ActorContext):void {if(actor?.role==='reviewer')return requireCurrentReviewer(actor);if(!instance||!makerActors.has(actor))throw new LocalAuthError('ROLE_FORBIDDEN',403);}
