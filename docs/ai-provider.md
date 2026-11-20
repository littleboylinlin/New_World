# AI 服务商接入

从 `src/ai-provider` 导入 `ai` 和 TypeScript 类型。桌面版和 Web 版使用相同的接口。应用内调用走这个接口，外部工具继续走 [本地 v1 协议](../AI_INTEGRATION.md)。

## 配置与凭据

- 用 `listPresets()` 获取可编辑的配置副本。预设包含 OpenAI 两种协议、Anthropic、Gemini、DeepSeek、OpenRouter 和 Ollama。所有配置字段均可手动编辑。
- 用 `getConfig()` 读配置，`saveProfile({ id?, config, credentials?, rememberCredentials? })` 创建或替换一套配置。凭据字段省略时保留，`null` 清除。改变 Base URL 的 origin 时为新地址重新提供凭据。使用 `deleteProfile(id)` 删除配置。
- 桌面版由主进程发请求，密钥使用 Electron `safeStorage` 经系统保护后保存。Web 配置按站点保存在 IndexedDB。Web 的 `rememberCredentials` 按配置保存，新配置默认为 `false`。启用后密钥存入该站点的 IndexedDB，关闭后移回当前页面内存。设置页应说明勾选后站点脚本可读取密钥。Web 使用浏览器直连，Anthropic 官方接口支持显式启用 `anthropicDirectBrowserAccess`。
- 用 `setRouting({ defaultProfileId, byFeature })` 保存绑定。内置功能为 `ask`、`polish`、`proofread`、`bookSummary`，扩展功能使用 `extension:<name>`，例如 `extension:translate`。按照显式 `profileId`、功能绑定、默认配置解析。功能绑定为 `null` 时停用。删除配置时将引用它的绑定置空。
- 用 `exportConfig()` 获取可序列化的版本化文件内容。导出包含配置和绑定。API Key 经 `credentials.apiKey` 写入，自定义敏感请求头用 `{ name, secretRef }` 配合 `credentials.headerSecrets`，这两类密钥值都在导出范围之外。Base URL、路径、普通请求头和额外 JSON 是可导出的字段。导入接受解析后的 JSON，返回新配置和重映射后的绑定。调用 `setRouting` 后绑定生效。

## 调用和停止

```ts
import { ai } from './ai-provider'

const run = ai.generate({
  feature: 'polish',
  messages: [{ role: 'user', text: selection }],
  generation: { temperature: 0.3 },
})

stopButton.onclick = () => run.cancel()

for await (const event of run.events) {
  if (event.type === 'delta') appendText(event.text)
  if (event.type === 'done') setText(event.text)
  if (event.type === 'error') showAiError(event.error)
}
```

迭代 `run.events` 时开始请求。一个运行只消费一次，退出迭代会释放连接。流式输出在终态前发送 `delta`，`done.text` 包含完整文本。非流式请求直接进入终态。每次运行以 `done`、`cancelled` 或 `error` 结束。取消会中断本机请求及重试等待。

调用中的 `generation` 按字段覆盖配置中的 `generation`，`stream` 也可单次覆盖。已填参数映射为对应协议字段，空参数省略。Anthropic Messages 必须提供 `maxOutputTokens` 或额外 JSON 中的 `max_tokens`。额外 JSON 递归合并对象，数组整体替换。模型、消息和流式字段以调用为准。

默认路径附加在 Base URL 的前缀后。以 `/` 开头的覆盖路径从同源根路径解析，也可传同源完整 URL。路径可包含查询参数及 `{model}`。Gemini 的流式路径单独覆盖。认证参数最后写入请求。请求限于配置的 origin，重定向交由用户更新配置地址。

默认开启流式、每次尝试超时 120 秒、额外重试 0 次。开启重试后，输出文本前的临时故障可重试，服务端提供的 `Retry-After` 会参与等待。调用层不写请求日志或遥测。

## 连接测试和模型列表

- `testConnection({ profileId }, { stream })` 测已保存的配置。也可传 `{ draft, credentials, reuseCredentialsFrom }` 测草稿。可选的 `reuseCredentialsFrom` 只复用同源已保存的凭据。测试发送一次最小 `ping`，读取到的状态码和上游错误正文在 `httpStatus` 和 `rawErrorBody` 原样返回。
- `listModels(target, cursor?)` 使用相同的目标参数。成功返回 `{ models, nextCursor? }`，将模型的 `id` 填入配置即可，手填模型可直接用于生成。
- 错误有稳定的 `code`，包括 `unauthorized`、`forbidden`、`timeout`、`rate_limited` 和 `quota_exceeded`。浏览器拦截响应时，状态码和正文不可读。测试连接的 `cors` 表示有可达性证据的疑似跨域拦截。证据不足时使用 `network`，并在适用时附上 `corsPossible`。

## 长文分段和章节摘要

- `splitText({ feature, profileId?, text, reservedPromptTokens?, reservedOutputTokens? })` 按配置的 `contextTokens` 做本地分段。返回文本、原文 UTF-16 偏移 `[start, end)` 和估算 token 数。用 UTF-8 字节数保守估算，优先保留段落、句子和字素边界。预留输出默认使用该协议实际配置的最大输出 token 数。调用方知道本次提示词和输出预算时可显式传入。
- 整本总结逐章调用 `prepareChapterSummary({ ...splitRequest, promptVersion })`。命中直接用 `summary`。未命中时将返回的 `route` 和每段提示词传给 `generate`，得到完整单章摘要后调用 `saveChapterSummary(cacheToken, summary)`。如配置在分段后改变，`generate` 返回 `profile_changed`，重新准备该章。如果提示词包含章节标题，把标题计入传给准备接口的文本。
- 缓存按章节文本 SHA-256、实际模型与服务端点、提示词版本匹配。修改总结提示词或分段合并规则时更新 `promptVersion`。两端均在独立的本地 IndexedDB 保存摘要，作品备份范围仍以作品库为准。调用 `clearSummaryCache()` 清空摘要并使此前发出的写入凭据失效。
