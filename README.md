# Codex Model Switch

用一个脚本切换 Codex 的模型接口，并恢复切换前的配置。端点、Key 和模型名放在一个配置文件里。

适用于 Windows 版 Codex，要求 Node.js 22.13 或更新版本。先正常登录并打开一次 Codex，让它生成模型目录缓存。第三方端点需要支持 Responses API。

## 使用

先复制配置模板：

```powershell
Copy-Item config.example.json config.json
```

修改 `config.json` 中的三个字段：

```json
{
  "endpoint": "https://api.example.com/v1",
  "api_key": "YOUR_API_KEY",
  "model": "YOUR_MODEL_ID",
  "port": 18766
}
```

| 字段 | 填什么 |
| --- | --- |
| `endpoint` | 服务商的 API 基础地址，通常以 `/v1` 结尾，不要加 `/responses` |
| `api_key` | 这个端点对应的 API Key |
| `model` | 服务商提供的模型 ID |
| `port` | 本机转发端口，通常保持默认值即可 |

完全退出 Codex 桌面端、CLI 和使用相同配置目录的 IDE 扩展，再执行切换。迁移期间不要打开这些程序；命令完成后再重新打开：

```powershell
node switch.mjs on
```

恢复时，同样先关闭 Codex，执行下面的命令，再重新打开：

```powershell
node switch.mjs off
```

查看状态：

```powershell
node switch.mjs status
```

更换端点、Key 或模型时，先执行 `off`，修改 `config.json`，再执行 `on`。重复执行 `on` 会复用当前配置，并在后台进程已退出时重新启动它。

## 工作方式

原供应商为 `openai`（包括未填写 `model_provider` 的默认配置）时，脚本会切换为 `openai_http`，显示名称为 `OpenAI HTTP`，并保留 ChatGPT 登录。原供应商已是 `openai_http` 时，继续使用它。

切换请求先到本机转发程序：`router-custom` 使用配置中的端点与 Key，官方 GPT 请求继续走切换前的官方接口。第三方请求不会携带 ChatGPT 的认证头。配置文件中的端点也可以是 OpenAI 官方 API。

转发程序就在同一个 `switch.mjs` 中，无额外依赖。开启时隐藏启动，并在 Windows 登录时自动启动。关闭时恢复原配置，同时移除本脚本创建的启动入口。这个最简版随 Windows 登录启动，没有额外的 Codex 进程守护。

原配置、运行副本和本地凭据保存在 `%USERPROFILE%\.codex\simple-model-switch`。设置了 `CODEX_HOME` 时，改用该目录。`off` 恢复的是切换前的配置；如果切换前已有其他路由器，也会恢复到它。

`config.json` 已加入 `.gitignore`。请只提交配置模板，不要强制提交真实 Key。运行目录还包含一份本地 Key 副本，同样不要上传。

## 对话供应商迁移

原供应商为 `openai` 时，`on` 会把所有标记为 `openai` 的本地 Codex 对话迁移到 `openai_http`，包括正常对话和归档对话。迁移同步更新 `state_*.sqlite` 中的供应商字段，以及 `sessions`、`archived_sessions` 内 JSONL 文件的 `session_meta` 字段。旧日志未写供应商时，按 `openai` 处理。自定义 `sqlite_home` 也受支持。

迁移保留对话 ID、标题、置顶、归档状态和消息正文。原本属于其他供应商的对话不改标记。这里的标记是供应商字段，不是侧栏分组；迁移也不会强制更换每个对话已选的模型。需要使用配置中的模型时，在对话内选择对应的 Custom API 模型。

脚本在运行目录保存 `migration-*.json` 迁移清单。`off` 按清单还原本次迁移的旧对话，保留后来追加的消息、标题修改和归档移动。启用后新建的对话不在清单内，会保留 `openai_http` 标记；原本就是 `openai_http` 的对话也不会被批量改回。

如果受迁移影响的对话后来被手动换成其他供应商，`off` 会停止并提示冲突。处理中断后，先完全退出 Codex，再执行 `off` 恢复。不要删除运行目录中的配置备份和迁移清单，其中可能包含私有对话元数据，不要上传。

本功能处理本地 Codex 对话，不迁移 ChatGPT 云端聊天。运行期间必须保持 Codex 关闭，避免正在运行的会话把内存中的旧标记写回。

## 范围

- 模型选项使用 64,000 token 上下文、文本输入和 `high` 推理档位。端点需接受相应参数与工具调用格式；服务商兼容性需自行验证。
- 原来的 MCP、登录文件和其他配置不被替换。恢复会保留之后新增的无关设置；若本脚本管理的设置被手动更改，会停止恢复并提示，避免覆盖。
- `on` 不发送付费模型请求。已验证原有 18 项检查、16 项迁移检查和 3 项桌面版自带 app-server 检查，包括迁移前后按供应商列出正常及归档对话。未用真实服务商 Key 做桌面推理、连接器或远程控制验收。
- Windows 登录启动依赖 Windows Script Host。后台进程被安全软件拦截或退出时，`status` 会显示未运行，可查明原因后再次执行 `on`。

配置字段参考：[OpenAI Docs](https://developers.openai.com/codex/config-reference/)。
