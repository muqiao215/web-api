# Prompt Factory

`prompt_factory` 是一个独立的提示词源/变换/构建项目，目标不是替代现有 bot，而是把提示词资产、元提示词组合逻辑、导出物和桥接路径从 bot 内部抽出来，形成一个可重复构建的统一工程。

当前 MVP 已经支持两条实际可用的构建线：

- `local_repos`
  从本地源仓库重建统一提示词池：
  `ai-image-prompts-skill.J5v2Vt`、`BestPrompts.tmp`、`stable-diffusion-prompt-templates.ASMlaX`、`prompt-pack.tmp`、`awesome-gpt-image-2-prompts`、`sources/manual_gpt_prompts.json`
- `runtime_bridge`
  直接桥接当前已验证在跑的
  `telegram_gpt_image_bot/state/prompt_pool.json`
  以保留现有 8900 条运行时资产与旧来源分布

## 目录

- `adapters/`：源适配器，负责把不同 repo / runtime JSON 读成统一记录
- `sources/`：源注册表；当前由 `sources/source_registry.json` 声明可同步上游
- `taxonomies/`：平台/分类映射
- `transforms/`：组合层说明；当前已实现 Toloka keyword composer
- `rules/`：导出与过滤策略约定
- `builds/`：构建产物
- `state/`：本地同步/构建/发布状态，默认不入 git
- `bridges/`：bot 消费路径与迁移说明
- `tests/`：schema/build/export smoke tests

## 统一记录

统一 prompt 记录包含这些核心字段：

- `id`：稳定记录 ID，供 used-index 持久跟踪
- `canonical_id`：按规范化 prompt 文本生成的去重 ID
- `source` / `source_id` / `number`
- `prompt` / `title`
- `source_kind`：`direct` / `atomic` / `composed`
- `platform_tags` / `model_tags` / `category_tags`
- `quality_tier`
- `selection_score`
- `quality`
  含 `ornate_score`、`human_related`、`requires_reference`
- `metadata`
  保留源侧上下文、adapter 信息、模板路径、base prompt 等

## 现在就能跑

在新 monorepo 里执行：

```bash
uv run --project packages/prompt-factory \
  prompt-factory build --profile all
```

如果工作区根不是当前仓库的上一级目录，可以显式指定：

```bash
uv run --project packages/prompt-factory \
  prompt-factory build --profile all --workspace-root /your/workspace/root
```

默认会生成到当前包目录下的 `builds/`：

- `builds/local_repos/unified/prompt_pool.json`
- `builds/local_repos/providers/gpt/prompt_pool.json`
- `builds/local_repos/providers/banana/banana_prompts.json`
- `builds/runtime_bridge/unified/prompt_pool.json`
- `builds/runtime_bridge/providers/gpt/prompt_pool.json`
- `builds/runtime_bridge/providers/banana/banana_prompts.json`
- `builds/*/indices/used_prompt_ids.seed.json`

现在除了 `build`，还支持 3 个持久化命令：

```bash
uv run --project packages/prompt-factory \
  prompt-factory sync

uv run --project packages/prompt-factory \
  prompt-factory diff --profile local_repos

uv run --project packages/prompt-factory \
  prompt-factory promote --profile local_repos
```

含义分别是：

- `sync`
  - 对 git 源做 `fetch + ff-only` 更新
  - 对 file snapshot 源记录 `sha256/size/mtime`
  - 脏工作树不会强拉，会标记为 `blocked`
- `diff`
  - 默认优先比较“当前 build”与“已 promote 的 stable”
  - 如果还没 stable，则回退比较“上一次 build”
  - `--baseline previous` 会读取 `state/build_snapshots/<profile>/...` 里的不可变归档，而不是被覆盖的 live build
  - 输出 prompt 增减、source_count delta、source revision 变化
- `promote`
  - 把当前 profile 的 build 复制到 `builds/promoted/<profile>/`
  - 作为后续消费者应优先读取的稳定版本

cron 友好的状态文件会写到 `state/`：

- `state/source_state.json`
- `state/last_sync_status.json`
- `state/build_history.jsonl`
- `state/build_snapshots/<profile>/<build-id>/manifest.json`
- `state/last_build_status.json`
- `state/last_diff_status.json`
- `state/last_promote_status.json`

每次 `build` 仍会覆盖 `builds/<profile>/` 下的 live 输出，但会同时把 manifest 与 provider export 复制一份到 `state/build_snapshots/`。这让定时任务可以安全做 `diff --baseline previous`，不会因为 live 文件被新 build 覆盖而失去上一轮证据。

`local_repos` 现在已经会把 `prompt-pack.tmp` 作为真实 source adapter 处理：

- 优先读取 repo 内本地 CSV 导出
- 如果 repo 只有 README，则从 README 里的 Google Sheet 链接推导 CSV 地址再抓取

这样 `hoppycat-prompt-pack` 不再只能通过 `runtime_bridge` 带出。

`awesome-gpt-image-2-prompts` 也已接入本地 source adapter：

- 读取默认英文 `README.md`
- 按 `## section -> ### Case -> Prompt code block` 抽取 case prompt
- 人物/人像 prompt 会保留进统一库和 GPT 导出，只在生成侧需要时再筛

`manual_gpt` 用来保存你在对话里临时收集后人工去噪的 GPT prompt：

- 数据文件：[sources/manual_gpt_prompts.json](sources/manual_gpt_prompts.json)
- 适合存放从聊天、社媒、测试记录中拣出来的高质量 prompt
- 会去掉账号名、序号、JSON 壳、图片尺寸尾巴这类噪音
- 人物/人像 prompt 也会正常入库；是否在生成链路里筛掉，交给后续消费侧处理

## 设计取舍

- 不做服务端，不搞“大框架剧场”，先把可复用 build pipeline 落地
- 保留 provider-specific export，避免后续 bot/API/showcase 再各自重新清洗
- 整理入库阶段不丢 prompt，只记录 `human_related / requires_reference` 等质量标记
- 生成侧是否过滤人物/参考图依赖 prompt，交给后续导出/消费链路决定
- `runtime_bridge` 解决“今天就能接上现有运行时”；`local_repos` 解决“以后能从源仓库重建”
- `sync` 只允许 fast-forward，不替你解决源仓库的本地脏改动
- `promote` 把“最新 build”和“稳定可消费版本”分开，避免上游脏更新直接进生产

## 后续桥接

见 [bridges/README.md](bridges/README.md)。
