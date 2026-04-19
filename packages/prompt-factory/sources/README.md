# Sources

当前工程把“源”分成两类：

- 原始 repo/数据源
  - `ai-image-prompts-skill.J5v2Vt`
  - `BestPrompts.tmp`
  - `stable-diffusion-prompt-templates.ASMlaX`
  - `prompt-pack.tmp`
- 运行时桥接源
  - `telegram_gpt_image_bot/state/prompt_pool.json`

`prompt-pack.tmp` 已有 direct adapter：

- repo 内若存在 CSV 导出，则直接本地 ingest
- repo 内若只有 README，则从 README 中的 Google Sheet 链接推导 CSV 地址

这保证 `local_repos` 可以独立产出 `hoppycat-prompt-pack`。
