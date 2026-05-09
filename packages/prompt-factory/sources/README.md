# Sources

当前工程把“源”分成两类：

- 原始 repo/数据源
  - `ai-image-prompts-skill.J5v2Vt`
  - `BestPrompts.tmp`
  - `stable-diffusion-prompt-templates.ASMlaX`
  - `prompt-pack.tmp`
  - `awesome-gpt-image-2-prompts`
  - `manual_gpt_prompts.json`
- 运行时桥接源
  - `telegram_gpt_image_bot/state/prompt_pool.json`

治理语义：`local_repos` 是主线，`manual_gpt_prompts.json` 是人工精选层，`runtime_bridge` 只用于迁移/对照/调试；稳定消费者只应读取 `builds/promoted/local_repos/`。

真正的同步注册表在 [source_registry.json](source_registry.json)。

字段约定：

- `source_id`：CLI / manifest / state 文件里的稳定标识
- `sync_mode`
  - `git_repo`
  - `file_snapshot`
- `workspace_path`：相对 workspace root 的路径
- `origin_url` / `branch`：仅 git 源需要
- `governance_role`：说明源在构建治理中的角色

当前 `sync` 不会替你处理脏工作树；如果源 repo 有本地修改，会标记成 `blocked`，等你决定是保留改动还是先清理。

`prompt-pack.tmp` 已有 direct adapter：

- repo 内若存在 CSV 导出，则直接本地 ingest
- repo 内若只有 README，则从 README 中的 Google Sheet 链接推导 CSV 地址

这保证 `local_repos` 可以独立产出 `hoppycat-prompt-pack`。

`awesome-gpt-image-2-prompts` 当前走 Markdown adapter：

- 只读取默认英文 `README.md`
- 以 section/case/prompt code block 为抽取边界
- 保留 case 链接与作者链接到 `metadata`
- 透传 `upstream_revision`、`upstream_author`、`upstream_license`、`upstream_url`

`manual_gpt_prompts.json` 是人工收集/去噪后的 GPT prompt 源：

- 适合保存从对话、社媒、测试记录里临时挑出来的 prompt
- 不保留账号噪音、排名号、JSON 外壳、图片尺寸尾巴、无意义重复质量词
- 人物类 prompt 也正常保存；是否过滤留给后续生成链路
- 可选维护 `upstream_revision` / `upstream_author` / `upstream_license` / `upstream_created_at` / `upstream_url`；未提供 revision 时使用源文件 sha256
