# Codex OpenViking Memory

[English](README.md) · [安装说明](docs/setup.md) · [工作机制](docs/architecture.md) · [安全说明](SECURITY.md)

一个优先面向 Windows 的 Codex 与 OpenViking 记忆桥接工具：模型提出简短摘要，由真人选择，只把选中的摘要提交到知识库。**0.1.0** 是首个版本，已有自动化测试；尚未验证全新真实用户环境中的完整安装与入库流程。

模型负责理解当前真人消息是否具有长期价值，本机 hook 负责确认与提交边界。只读 MCP 提供八个受限工具，不暴露写入工具。捕获载荷是获批摘要，不是聊天转录。

## 使用条件

- Node.js 22 或更高版本，无 npm 运行时依赖。
- Windows 与 PowerShell 7（`pwsh`），用于安装与 DPAPI 凭据保护。
- 已部署的 OpenViking 服务，以及对应账号和用户的普通 `user` 凭据；安装器不部署服务端。
- Codex 客户端支持本地插件、`UserPromptSubmit` / `Stop` hook、本地 stdio MCP，以及模型调用本地命令。
- 如需可选择的原生确认卡片，客户端还需提供问答/输入工具。该工具由客户端提供，本项目不能保证每种客户端和模式都有。缺少工具时可用精确文字确认。

## 安装与启用

```powershell
git clone https://github.com/daizhonggeng/codex-openviking-memory.git
cd codex-openviking-memory
pwsh -File ./scripts/install.ps1 `
  -ServerUrl https://memory.example.com `
  -Account example-account `
  -User example-user
```

在本机隐藏输入框中输入普通用户的 API key，不要把凭据放进命令行、聊天、仓库或 issue。默认数据目录为 `%LOCALAPPDATA%/CodexOpenVikingMemory`，位于源码目录之外。可通过 `-WriteUrl` 单独指定写入源站；默认与 `-ServerUrl` 相同。

安装器会生成本地 marketplace/plugin、MCP 配置片段和模型规则片段。**安装完成不等于客户端已经启用。** 按安装输出的位置添加本地 marketplace 并启用插件，再导入 MCP 配置，按客户端需要重载会话。确认两个 hook 事件与只读 MCP 都可用。安装器不会静默修改现有 Codex 配置或 `AGENTS.md`。

完整配置、凭据与离线安装选项见[安装说明](docs/setup.md)。hook 响应会动态注入记忆审查规则；生成的 `AGENTS.fragment.md` 是辅助材料，不假设它已成为全局指令。

## 保存流程

1. 真人发送普通消息，模型结合上下文判断是否值得长期保存；没有候选时正常回答。
2. 对有价值的事实、偏好、近期目标或可复用经验，模型写出最小摘要 JSON，调用 `propose`。
3. 候选在本机加密保存。模型展示工具返回的真实编号与摘要，客户端有原生问答工具时通过它收集选择。
4. 真人明确选择受支持的保存回复，或单独发送 `保存候选 ID` / `save candidate ID`，将 `ID` 换成真实编号。
5. `UserPromptSubmit` 识别真人确认；`Stop` 通过受限传输执行固定版本的上游捕获脚本，提交获批批次。
6. 查询 `status`，并通过只读 MCP 核对提取与读回结果，再声称记忆已可用。

普通求助、引用文字、工具输出或模型自己生成的“保存”都不是授权。hook 只识别严格的确认格式，不替模型做语义判断。原生问答卡片需要客户端以受支持的格式把真人回复交给 hook；无法接入时，应让真人发送精确文字确认，不模拟点击，也不自动批准。

## 常用命令

以下 `$config` 指安装器生成的 `config.json`，`$cli` 指安装后的 `runtime/bin/cli.mjs`，请使用安装输出的真实路径。源码目录内也可使用 `node ./bin/cli.mjs`。

```powershell
node $cli --help
node $cli doctor --config $config
node $cli propose --config $config --input ./candidate.json
node $cli status --config $config --id ACTUAL_CANDIDATE_ID
node $cli mcp --config $config
```

候选输入只包含三个字段：

```json
{
  "summary": "用户偏好简洁答复，并明确说明验证结果。",
  "kind": "preference",
  "source": "current-human-statement"
}
```

`kind` 可选 `profile`、`preference`、`current`、`knowledge`。示例不是安装者的个人事实。候选输入文件在加密前包含明文，应放在源码目录之外并在不再需要时自行移除。更多见[命令说明](docs/commands.md)。

## 只读查询

MCP 工具包括 `health`、`find`、`search`、`read`、`list`、`tree`、`grep`、`glob`，限于配置用户的原生 memories 与 `resources/personal-context/`。`search` 固定使用无 `session_id` 的 `mode="list"`。不提供 `remember`、捕获、整段会话上传或通用写入工具。本机限制不能替代服务端权限控制。

## 验证与许可

运行 `node --test` 执行测试，运行 `npm run verify:vendor` 校验上游文件哈希。测试使用临时目录和模拟网络；Windows 安装冒烟测试覆盖离线新装与已有配置保留，不使用真实凭据。它们不能证明某个客户端的 hook/卡片兼容性或真实服务端提取成功。见[测试说明](docs/testing.md)与[发布检查表](docs/releasing.md)。

本项目采用 [AGPL-3.0-only](LICENSE)，包含固定在 `v0.5.1.1` 的 [OpenViking](https://github.com/volcengine/OpenViking) Codex memory 示例的有限子集，文件保持原样。来源、固定 tree 与哈希见 [NOTICE](NOTICE) 和 [vendor 说明](vendor/README.md)。分发时保留许可证与对应源码，修改后通过网络提供服务时还应履行 AGPL 的源码提供义务。
