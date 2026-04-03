# code-cli 升级路径

> 更新时间：2026-04-02
>
> 参考对象：`claude-code-haha`
>
> 当前策略：优先把 `code-cli` 收口成“可交付的轻量 Skill Runtime CLI”，而不是直接追完整 Claude Code 产品形态。

## 1. 目标收敛

当前升级不追求一次性补齐 `TUI / MCP / Multi-Agent / Remote Bridge / LSP`。

这一阶段的目标是：

- 让 `ccode` 继续保持轻量 CLI 形态。
- 让 `skills` / `skill:create` / `Skill` 工具真正可用。
- 让 skill 的配置、加载、上下文绑定、运行时行为和测试链路一致。
- 把后续升级路径写清楚，避免项目继续“只长能力，不收口产品面”。

## 2. 当前进度

### Phase 0：CLI 基础骨架

状态：已完成

- 基础 agent loop、tool registry、workspace sandbox 已具备。
- `run` / `chat` / `session` / `trace` 等核心命令已接通。
- 会话持久化、resume/retry/continue 等交互能力已经落地。

### Phase 1：工具能力扩展

状态：已完成

- 已覆盖 `fs / git / search / ast / deps / test` 等主要本地工具域。
- 离线 eval、trace replay、mock provider 已形成基本回归链路。
- 当前 CLI 已具备“在本地代码仓内完成真实读写与分析”的基础能力。

### Phase 2：Skill Runtime 收口

状态：本轮已完成主体实现

- `Skill` 工具已从固定枚举改为自由字符串名称，支持项目级和用户级 skills。
- skills 默认按规则可用，只有显式 feature flag 禁用或 `enabled: false` 时不可用。
- `ToolContext` 已向 skill 暴露 `messages` 和 `currentUserInput`。
- bundled skills 已接入按技能的智能上下文提取：
  - `simplify` / `explain` / `test`：优先抽取主代码块
  - `debug`：提取问题描述、代码块、错误信息
  - `remember`：提取最新用户输入
  - `skillify`：提取最近会话并裁剪长度
- 模板系统已支持：
  - `{{name}}`
  - `{{#if arg}}...{{/if}}`
- shell 插值默认关闭，仅 `skill_shell_execution` 开启时允许执行。
- `skills` 命令只展示当前可调用 skills。
- `skill:create` 现在生成的是可解析、可运行、与当前模板能力一致的 `SKILL.md` 模板。

### Phase 3：验证与文档

状态：已完成

- Skill feature flags、loader、runtime、CLI 行为的单元测试已补齐。
- README 已补充 skill 使用方式、目录约定、feature flags 和 shell 策略。
- 新增了 bundled skill 与 project skill 的 eval case。
- 完整 `build + unit + eval + replay` 已在当前工作区稳定通过。

## 3. 与 claude-code-haha 的差距

下面这些能力当前仍然是“明确未开始”或“有意延后”：

- React/Ink TUI 与屏幕系统
- MCP client / plugin / remote bridge
- Multi-agent / team / worktree / schedule
- LSP 管理、diff 引擎、复杂权限与遥测体系

这不是缺失，而是当前阶段的有意取舍。

现阶段更合理的目标不是“照搬 Claude Code”，而是先把 `code-cli` 做成：

1. 本地可用
2. 行为稳定
3. skill 机制清晰
4. 便于继续长高级能力

## 4. 下一阶段建议

### Stage A：Skill Runtime 加固

优先级：最高

- 已完成：
  - `allowedTools` 阻断提示已带上 active skill 名称与来源。
  - skill 执行已补 `invoke / resolve / render / activate / clear` trace 事件。
  - CLI 已补 user skill 场景与 `skills --verbose` 元数据展示。
  - 新增 `trace summary` 与 `skill:inspect` 命令，补齐 trace/skill 的可观察性。
  - 仓库已内置多份 project skill 样例，便于演示与继续扩展。
  - 新增 `skill:doctor`，可以校验模板语法、未知工具、未声明占位符与解析失败。
  - 新增 `skill:install`，可以把 bundled skill 落地成 project/user skill，或从本地目录安装 skill。
  - 新增 `skill:export`，可以把 bundled/project/user skill 导出成可分享目录，并与 `skill:install` 组成闭环。
- 下一步：
  - 继续补更多 project/user skill 回归样本。
  - 明确 skill prompt 规范，避免 prompt 能力继续野生扩张。
  - 考虑加入 skill registry/index 或 manifest，支持更清晰的分享元数据。

### Stage B：CLI 产品化

优先级：高

- 把 `skills`、`tools`、`session` 输出做得更稳定、更易扫描。
- 收口配置项，减少“定义存在但行为不一致”的情况。
- 整理用户级目录、项目级目录、导出/分享 skill 的工作流。

### Stage C：受控引入高级能力

优先级：中

- 先引入最小 MCP 接口，而不是完整 bridge。
- 如果确实需要并发协作，再评估单独的 agent/worktree 模式。
- TUI 放在 CLI 行为稳定之后，不建议现在提前开工。

## 5. 推荐升级顺序

建议按下面顺序继续推进：

1. 完成 Skill Runtime 验证收尾，确保 `build + unit + eval + replay` 稳定通过。
2. 增补 3 到 5 个真实 project skill 示例，验证模板边界和加载规则。
3. 收口 trace/skills 输出，让 skills 成为更易观察的正式公开能力。
4. 给 skills 增加最小 manifest/registry 流，再评估 MCP 或更强交互壳。

## 6. 完成定义

这轮升级可以视为完成，当下面几项同时成立：

- `skills` 列表只展示真实可用项。
- `skill:create` 生成的模板可以直接被 loader 解析。
- bundled / project / user 三类 skills 都有回归覆盖。
- `Skill` 调用后不会把上下文污染到后续 turn。
- shell 插值默认关闭且可通过显式开关启用。
- README、eval、测试与源码行为一致。

## 7. 结论

`code-cli` 当前最合适的路线，不是直接变成另一个 Claude Code，而是先把“CLI + Skill Runtime”这一层做厚、做稳、做清楚。

如果这一层站稳，后续无论往 `MCP`、`TUI` 还是 `Multi-Agent` 走，成本都会低很多。
