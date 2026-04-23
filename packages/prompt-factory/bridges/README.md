# Bridge Path

这个项目目前不反向改 bot 代码，但已经把桥接面做成兼容文件。

补充：`local_repos` 现在已直接包含 `hoppycat-prompt-pack`，因此不再需要依赖 `runtime_bridge` 才把 HoppyCat 带进统一池。

## `telegram_gpt_image_bot`

当前 bot 把 prompt pool 路径写死在：

- `telegram_gpt_image_bot/state/prompt_pool.json`

所以后续最小迁移有两种：

1. 给 bot 增加环境变量覆盖，例如：
   `TELEGRAM_GPT_PROMPT_POOL_PATH=<workspace-root>/prompt_factory/builds/local_repos/providers/gpt/prompt_pool.json`
2. 或者由外部同步脚本把 `prompt_factory` 导出文件复制/链接到 bot 期望路径

本项目已经输出兼容 schema：

- `builds/*/providers/gpt/prompt_pool.json`

这里的 `providers/gpt/prompt_pool.json` 现在应理解为：

- 面向 GPT 图像链路的 **专属 prompt 池**
- 不是 unified 全量图像 prompt 的简单镜像
- 默认只包含明确标注为 GPT 专属模型的 prompt

## `telegram_canvas_bot`

当前 Banana 已支持本地 prompt pool 路径列表：

- `TELEGRAM_BANANA_LOCAL_PROMPT_POOL_PATHS`

因此可以直接把它指向：

```bash
TELEGRAM_BANANA_LOCAL_PROMPT_POOL_PATHS=<workspace-root>/prompt_factory/builds/local_repos/providers/gpt/prompt_pool.json
```

如果想更贴近 Banana 当前缓存结构，也可以改读：

- `builds/*/providers/banana/banana_prompts.json`

## used-index 友好点

- 统一记录 `id` 稳定，可直接给现有 `used_prompt_ids` 机制复用
- 每个 profile 都会输出：
  `builds/<profile>/indices/used_prompt_ids.seed.json`
- 后续 bot 若切到统一项目，只要继续沿用 `used_prompt_ids` 列表即可，不必重建消费侧状态模型
