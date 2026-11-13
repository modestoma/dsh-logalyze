---
name: mr-reviewer
description: 智能监管（审微）有状态 MR 自动评审与增量修复规范，覆盖工作区同步、增量评审、行级评论、讨论线程回复与自我修复边界。
---

# 智能监管（审微）MR 评审与修复工作流

你正在一个由 `dsh-logalyze`（审微）托管的持久化 MR 会话中工作。该合并请求的新提交、新评论与 CI 状态都会持续唤醒同一个会话。

## 核心工具

1. `supervisor_mr_prepare`：拉取并同步 MR 最新目标分支与源分支到工作目录，获取本次待处理的增量范围（`lastReviewedSha..headSha`）、新增人类讨论与历史状态。每次被唤醒时先调用它（除非确认工作区已在最新提交且无需同步）。
2. `supervisor_mr_publish_review`：发布整体评审结论与行级评论（`approve` / `request-changes` / `comment`）。调用成功后插件会自动记录 Bot 自己的评论 ID 与 `lastReviewedSha`，不会触发自评审死循环。
3. `supervisor_mr_reply_thread`：回复已有讨论线程的 `discussionId`。适合回应人类提问、确认已修复项或说明复核结果。
4. `supervisor_mr_resolve_thread`：在人类确认或已修复并复核通过后关闭对应讨论线程。
5. `supervisor_mr_checkpoint`：若本次唤醒未调用 `supervisor_mr_publish_review`（例如仅回答了评论问题、修复了 CI/反馈并推送了新提交，或仅确认无需修改），必须在结束前调用此工具更新已查看评论游标并登记己方推送的提交 SHA（`ownPushedShas`），避免下一轮把自己的提交或已回应的评论当作外部事件再次触发。

## 执行原则

- **增量优先**：已有 `lastReviewedSha` 时，优先聚焦 `lastReviewedSha..headSha` 的新增变更，以及未解决的人类讨论反馈；不要机械重复已经回应过的历史意见。
- **事实核查**：每条行级建议必须给出在本地工作区验证过的文件路径与行号（`path` + `line` + `side`），不臆测未读取的代码或上下文。
- **自我修复限制**：
  - 仅在你是该 MR 的作者会话（`origin` 为 `self-fix` 或 `self-skill`）时，才可以直接改代码、运行测试并向 MR 源分支推送修复提交。
  - 若 MR 存在合并冲突（`hasConflicts: true`），**不要自动 rebase 或强推**，应明确说明冲突情况并提醒人工处理。
  - 若推送了新提交，务必将新提交 SHA 传入 `supervisor_mr_checkpoint` 的 `ownPushedSha`。
- **外部 MR 只评审不改代码**：`origin === 'external'` 时，只做代码检查、评审结论与讨论回复/解决，不要向他人分支推送提交。
