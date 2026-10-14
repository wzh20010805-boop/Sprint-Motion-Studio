import type {WorkContext} from '@framebaker/shared';
import {db} from '../../db';
import {getProject,PipelineError} from '../service';

/** changedPresetHash 是新公共配置投影的 SHA256；当前项目全局共享，未知旧绑定也列入。 */
export function affectedActionsForPreset(projectId:string,changedPresetHash:string):WorkContext[] {
 if(!/^[a-f0-9]{64}$/.test(changedPresetHash))throw new PipelineError('INVALID_PRESET_HASH','公共预设身份必须是 SHA256');
 getProject(projectId);
 // 不读取要求存在主轨帧的 alignmentState：尚未配置的动作也受项目预设影响。
 return (db.query('SELECT id FROM animation_axes WHERE project_id=? ORDER BY idx,id').all(projectId) as Array<{id:string}>)
  .map(axis=>({project_id:projectId,axis_id:axis.id}));
}
