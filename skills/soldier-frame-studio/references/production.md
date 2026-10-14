# 新动作与批量制作

同批次保持工作区不变，复用一个角色项目和已确认角色预设，每个动作使用独立 axis/task。MCP 以实际 `inspect_capabilities` 和工具定义为准，不按旧文档的“九工具”限制。CLI 参数复杂时用 JSON 文件，避免反复试拼字段；`schema --name task_brief|alignment|candidate_manifest` 按需要各查询一次。

| 阶段 | 已实现入口 | 可继续的证据 |
| --- | --- | --- |
| 项目与动作 | `create_project`、`create_action`、`inspect_project` | 返回的项目、axis、源／clip ID；完整序列身份 |
| 视频导入 | CLI `import video --project ID --file PATH`；小输入可用 `import_source` | 服务验证的源身份与媒体信息 |
| 完整视频抽帧 | `extract_source`；CLI `source extract --project ID --clip ID --request-key KEY --wait` | 原 operation 成功及完整 source-frame 映射 |
| PNG 导入 | `import_images`；CLI `import images --project ID --axis ID --directory DIR --file options.json` | 保存的顺序、明确 timing、完整帧数 |
| 整段抠图 | CLI `matte --project ID --clip ID --wait`，或 `--frames ID,ID`；`submit_pipeline` 用已验证 recipe | job 实际计算结果；遮罩未人工批准仍可制作协作候选 |
| 对齐与制作状态 | `get_review_artifacts`、`save_alignment`；当前 draft 含内容 token | 公共配置、全部帧、当前内容基础与遮罩版本 |
| 任务要求 | `create_task`；CLI `task create --file task-input.json` | task ID、固定要求／来源；needs_input 缺项已解决 |
| 固定候选 | `create_candidate`；CLI `candidate create --file candidate-input.json --wait` | 原 operation 成功及 candidate ID／清单路径 |
| 检查与提交 | `check_candidate` → `get_candidate_samples` → `record_sample_observations` → `submit_candidate` | 全帧技术报告、唯一计划、完整真实观察记录、内容 hash 匹配 |

这些入口仍需实际工具定义中的参数；表中 CLI 示例只列关键参数。大文件使用已鉴权 CLI multipart；当前 stdio/JSON 单消息1MiB，inline 总量上限786432个 base64字符／589824解码字节，multipart 128MiB。不要把长视频或大 PNG 批次编码进 MCP 消息。

视频导入后直接复用返回的媒体信息，不重复运行媒体探测。完整抽帧与 matting 是不同阶段；已存在成功抽帧结果就直接进入抠图。已有 Alpha 的 PNG 使用导入遮罩，不机械地再抠一次。

`task-input.json` 的最小形状是：

```json
{
  "request_key": "为这次创建保存的唯一标识",
  "brief": {
    "context": {"project_id": "实际返回的ID", "axis_id": "实际返回的ID"},
    "source_id": "实际返回的源ID",
    "goal": {"value": "用户原话目标", "origin": "user"}
  }
}
```

创建前需要已保存 alignment，PNG 还需要已确认 timing。服务会验证来源字节并补齐可推导值；明确的循环要求、输出限制及 sampling_limit 应随 brief 保存，不能只写在说明里。`needs_input` 是缺项清单；复用返回的输入与请求标识补齐一次，不逐条询问用户技术参数。成功创建后重放原请求使用原标识和原输入，参数变化是新意图。

对齐沿用 `q=s*(p-r)+c+d` 的源坐标规则。统一角色尺寸、画布和锚点，保留动作本身的起伏。站姿可使用稳定地面根；跳跃、倒地和夸张手势需要动作级根轨迹。完整技术检查发现越界时修公共画布／轨迹，不通过删帧或单独缩小异常帧掩盖问题。非像素角色保留其原画风和柔边，不自动改成像素风。

制作会话通过工具返回的 token 写入，例如 candidate 输入包含 `project_id`、`axis_id`、`task_id`、`base_content:{revision,hash}`、`request_key`。内容 token 和审核 revision 是两种身份。MCP `get_review_artifacts` 提供制作参考；完整 draft 由当前共享服务的 `GET /api/v1/collaboration/draft?project_id=...&axis_id=...` 提供。使用已连接客户端，保持凭据私密。

首次查询固定候选时保留完整 manifest；之后计划和帧 ID 从它映射。观察字段按真实计划填写 `candidate_id`、`content_hash`、`plan_hash`、`frame_id`、`frame_content_hash`、`viewed`、`result`（`ok/issue/uncertain`）、`explanation`、`evidence_source` 和 `evidence_candidate_id`。同一候选的已写观察不可随意改写；内容修复产生新候选。未看到最终像素时保留 `viewed:false/result:uncertain` 并清楚报告，不能假造视觉通过。
