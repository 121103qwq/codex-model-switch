# Codex Model Switch

用一个脚本切换 Codex 的模型接口，并恢复切换前的配置。端点、Key 和模型名放在一个配置文件里。

适用于 Windows 版 Codex，要求 Node.js 22 或更新版本。先正常登录并打开一次 Codex，让它生成模型目录缓存。第三方端点需要支持 Responses API。

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

关闭 Codex，执行切换，再重新打开 Codex：

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

脚本保留原来的官方 provider 标识和 ChatGPT 登录。模型请求先到本机转发程序：`router-custom` 使用配置中的第三方端点与 Key，官方 GPT 请求继续走原来的官方接口。第三方请求不会携带 ChatGPT 的认证头。

转发程序就在同一个 `switch.mjs` 中，无额外依赖。开启时隐藏启动，并在 Windows 登录时自动启动。关闭时恢复原配置，同时移除本脚本创建的启动入口。这个最简版随 Windows 登录启动，没有额外的 Codex 进程守护。

原配置、运行副本和本地凭据保存在 `%USERPROFILE%\.codex\simple-model-switch`。设置了 `CODEX_HOME` 时，改用该目录。`off` 恢复的是切换前的配置；如果切换前已有其他路由器，也会恢复到它。

`config.json` 已加入 `.gitignore`。请只提交配置模板，不要强制提交真实 Key。运行目录还包含一份本地 Key 副本，同样不要上传。

## 范围

- 模型选项使用 64,000 token 上下文、文本输入和 `high` 推理档位。端点需接受相应参数与工具调用格式；服务商兼容性需自行验证。
- 原来的 MCP、登录文件和其他配置不被替换。恢复会保留之后新增的无关设置；若本脚本管理的设置被手动更改，会停止恢复并提示，避免覆盖。
- `on` 只做本机启动检查，不发送付费模型请求。当前已通过 18 项隔离测试，包含实际运行 Windows 启动入口，未用真实服务商 Key 做桌面端验收。
- Windows 登录启动依赖 Windows Script Host。后台进程被安全软件拦截或退出时，`status` 会显示未运行，可查明原因后再次执行 `on`。

配置字段参考：[OpenAI Docs](https://developers.openai.com/codex/config-reference/)。
