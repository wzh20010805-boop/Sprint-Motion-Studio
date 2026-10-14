# 人工反馈与局部返工

读取一次当前 `inspect_task`、该候选的审核状态和 `list_review_issues` 完整分页。只修明确问题，并保留用户已经调整的制作副本。重复进入问题列表时复用未变的审核 revision；发现 revision 冲突或收到新反馈才刷新。

审核状态入口是当前服务 `GET /api/v1/collaboration/candidates/<candidate ID>/review-state`。它给出选定状态、审核 revision、接受代次及待交付 operation；`get_review_artifacts` 是制作参考，不等于此人工审核状态。

`start_rework` 需要 task、parent_candidate、当前 base_content 和新 request_key。相同意图重试复用这些原始输入；它返回返工制作基础。固定 parent 继续可回看，实际修改针对制作副本。`edit_mask` 一次发送该帧所需的完整 strokes，绑定当前 `base_mask_version`、内容 token 和项目 revision；坐标来自工具的源／最终画布映射。映射缺失或源图原本缺像素时提出具体阻断，不猜坐标补画。

根据真实修改创建 child candidate，再执行检查、计划、观察。`compare_candidates` 给出影响范围；`record_issue_repair` 按当前 `base_review_revision` 关联 child 和修复说明，它不表示问题已由人通过。

局部修改至少考虑真实受影响帧、衔接邻帧与循环边界；时序／顺序改变需要新的播放验收；公共画布／比例／角色预设改变可能影响多个动作。优先使用工具影响报告，未知依赖明确报告。

内容完全相同且来自真实祖先观察的样本可复用：`evidence_candidate_id` 指向原证据候选，frame 内容身份及观察内容保持一致。源图或 Alpha 看过不代表最终合成 PNG 看过。人工批准继承由审核规则和用户操作决定，AI 不写人工批准。

提交新版时给用户：修改内容、受影响与未覆盖范围、最终 PNG／播放预览、仍需确认的帧和播放状态。最后的动作自然度、角色完整性由用户逐帧及连续播放确认。
