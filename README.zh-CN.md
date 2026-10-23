# Codex OpenViking Memory

[English](README.md) · [安装说明](docs/setup.md) · [目录模板](docs/template.md) · [工作机制](docs/architecture.md) · [安全说明](SECURITY.md)

一个支持 macOS 与 Windows 的 Codex 与 OpenViking 记忆桥接工具：模型提出简短摘要，由真人选择，只把选中的摘要提交到知识库。**0.2.0** 新增 macOS 原生 Keychain 凭据存储与纯净的个人知识目录模板，同时保留 Windows DPAPI 支持。

模型负责理解当前真人消息是否具有长期价值，本机 hook 负责确认与提交边界。只读 MCP 提供八个受限工具，不暴露写入工具。捕获载荷是获批摘要，不是聊天转录。

## 使用条件

- Node.js 22 或更高版本，无 npm 运行时依赖。
- macOS 原生 Keychain，或 Windows 与 PowerShell 7（`pwsh`）/DPAPI。统一安装器按系统选择实现；暂不支持 Linux 安装。
- 已部署的 OpenViking 服务，以及对应账号和用户的普通 `user` 凭据；安装器不部署服务端。
- Codex 客户端支持本地插件、`UserPromptSubmit` / `Stop` hook、本地 stdio MCP，以及模型调用本地命令。
- 如需可选择的原生确认卡片，客户端还需提供问答/输入工具。该工具由客户端提供，本项目不能保证每种客户端和模式都有。缺少工具时可用精确文字确认。

## 安装与启用

```text
git clone https://github.com/daizhonggeng/codex-openviking-memory.git
cd codex-openviking-memory
node scripts/install.mjs --server-url https://memory.example.com --account example-account --user example-user
```

在本机隐藏输入框中输入普通用户的 API key，不要把凭据放进命令行、聊天、仓库或 issue。API key 和本地 vault key 使用 macOS Keychain 或 Windows DPAPI 保存。数据目录位于源码之外：macOS 默认 `~/Library/Application Support/CodexOpenVikingMemory`，Windows 默认 `%LOCALAPPDATA%/CodexOpenVikingMemory`。可用 `--write-url` 单独指定写入源站，默认与 `--server-url` 相同。

安装器会生成本地 marketplace/plugin、MCP 配置片段和模型规则片段。**安装完成不等于客户端已经启用。** 按安装输出的位置添加本地 marketplace 并启用插件，再导入 MCP 配置，按客户端需要重载会话。确认两个 hook 事件与只读 MCP 都可用。安装器不会静默修改现有 Codex 配置或 `AGENTS.md`。

完整配置、凭据与离线安装选项见[安装说明](docs/setup.md)。hook 响应会动态注入记忆审查规则；生成的 `AGENTS.fragment.md` 是辅助材料，不假设它已成为全局指令。

## 个人知识目录模板

两个平台的安装器都会从 `templates/personal-context/` 初始化数据目录内的 `knowledge/`，已有文件会保留。模板延续此前个人知识空间的通用组织方式：三份核心档案 `PROFILE.md`、`PREFERENCES.md`、`CURRENT.md`，编号主题目录、记录指南与六份空白记录模板。它只提供导航结构，不包含任何用户事实。

本地目录与远端知识分开处理。`template map` 描述本地相对路径如何对应 `viking://user/<user>/resources/personal-context/`；经确认的原生短记忆仍在 `viking://user/<user>/memories/`。初始化和映射不会创建远端资源、上传文件或写入记忆，也不增加 Git 知识保存或同步。详见[目录模板说明](docs/template.md)。

## 保存流程

1. 真人发送普通消息，模型结合上下文判断是否值得长期保存；没有候选时正常回答。
2. 对有价值的事实、偏好、近期目标或可复用经验，模型写出最小摘要 JSON，调用 `propose`。
3. 候选在本机加密保存。模型展示工具返回的真实编号与摘要，客户端有原生问答工具时通过它收集选择。
4. 真人明确选择受支持的保存回复，或单独发送 `保存候选 ID` / `save candidate ID`，将 `ID` 换成真实编号。
5. `UserPromptSubmit` 识别真人确认；`Stop` 通过受限传输执行固定版本的上游捕获脚本，提交获批批次。
6. 查询 `status`，并通过只读 MCP 核对提取与读回结果，再声称记忆已可用。

普通求助、引用文字、工具输出或模型自己生成的“保存”都不是授权。hook 只识别严格的确认格式，不替模型做语义判断。原生问答卡片需要客户端以受支持的格式把真人回复交给 hook；无法接入时，应让真人发送精确文字确认，不模拟点击，也不自动批准。

## 常用命令

以下命令可在两个平台的源码目录中运行。请将 `CONFIG_PATH` 替换为安装器生成的 `config.json` 真实路径。使用安装后的副本时，将 `./bin/cli.mjs` 换成安装输出的 `runtime/bin/cli.mjs` 绝对路径，并保留路径引号。

```text
node ./bin/cli.mjs --help
node ./bin/cli.mjs doctor --config "CONFIG_PATH"
node ./bin/cli.mjs propose --config "CONFIG_PATH" --input "CANDIDATE_JSON_PATH"
node ./bin/cli.mjs status --config "CONFIG_PATH" --id ACTUAL_CANDIDATE_ID
node ./bin/cli.mjs mcp --config "CONFIG_PATH"
node ./bin/cli.mjs template init --config "CONFIG_PATH"
node ./bin/cli.mjs template map --config "CONFIG_PATH"
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

运行 `node --test` 执行测试，运行 `npm run verify:vendor` 校验上游文件哈希。测试使用临时目录、模拟网络与合成凭据，原生平台测试覆盖 Windows DPAPI 与 macOS Keychain 安装；macOS 测试需要真实 macOS runner。CI 配置面向 Linux、Windows、macOS 的 Node.js 22/24，配置存在不代表某次运行已经通过。测试不能证明客户端 hook/卡片兼容性或真实服务端提取成功。见[测试说明](docs/testing.md)与[发布检查表](docs/releasing.md)。

本项目采用 [AGPL-3.0-only](LICENSE)，包含固定在 `v0.5.1.1` 的 [OpenViking](https://github.com/volcengine/OpenViking) Codex memory 示例的有限子集，文件保持原样。来源、固定 tree 与哈希见 [NOTICE](NOTICE) 和 [vendor 说明](vendor/README.md)。分发时保留许可证与对应源码，修改后通过网络提供服务时还应履行 AGPL 的源码提供义务。
