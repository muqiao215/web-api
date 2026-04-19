# Prompt Factory

`prompt_factory` 是一个独立的提示词源/变换/构建项目，目标不是替代现有 bot，而是把提示词资产、元提示词组合逻辑、导出物和桥接路径从 bot 内部抽出来，形成一个可重复构建的统一工程。

当前 MVP 已经支持两条实际可用的构建线：

- `local_repos`
  从本地源仓库重建统一提示词池：
  `ai-image-prompts-skill.J5v2Vt`、`BestPrompts.tmp`、`stable-diffusion-prompt-templates.ASMlaX`、`prompt-pack.tmp`、`awesome-gpt-image-2-prompts`
- `runtime_bridge`
  直接桥接当前已验证在跑的
  `/root/.ductor/workspace/telegram_gpt_image_bot/state/prompt_pool.json`
  以保留现有 8900 条运行时资产与旧来源分布

## 目录

- `adapters/`：源适配器，负责把不同 repo / runtime JSON 读成统一记录
- `taxonomies/`：平台/分类映射
- `transforms/`：组合层说明；当前已实现 Toloka keyword composer
- `rules/`：导出与过滤策略约定
- `builds/`：构建产物
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
uv run --project /root/.ductor/workspace/web_capability_api/packages/prompt-factory \
  prompt-factory build --profile all
```

如果工作区根不是 `/root/.ductor/workspace`，可以显式指定：

```bash
uv run --project /root/.ductor/workspace/web_capability_api/packages/prompt-factory \
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

`local_repos` 现在已经会把 `prompt-pack.tmp` 作为真实 source adapter 处理：

- 优先读取 repo 内本地 CSV 导出
- 如果 repo 只有 README，则从 README 里的 Google Sheet 链接推导 CSV 地址再抓取

这样 `hoppycat-prompt-pack` 不再只能通过 `runtime_bridge` 带出。

`awesome-gpt-image-2-prompts` 也已接入本地 source adapter：

- 读取默认英文 `README.md`
- 按 `## section -> ### Case -> Prompt code block` 抽取 case prompt
- 默认仍遵守工程过滤策略，所以人物/人像 prompt 不会进入默认 GPT 池

## 设计取舍

- 不做服务端，不搞“大框架剧场”，先把可复用 build pipeline 落地
- 保留 provider-specific export，避免后续 bot/API/showcase 再各自重新清洗
- 默认过滤人物/人像与 reference-required prompt；如需放开，可用 CLI 开关
- `runtime_bridge` 解决“今天就能接上现有运行时”；`local_repos` 解决“以后能从源仓库重建”

## 后续桥接

见 [bridges/README.md](bridges/README.md)。
