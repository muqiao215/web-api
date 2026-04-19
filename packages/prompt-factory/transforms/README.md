# Transforms

当前变换层只做一件已经被现有 bot 证明有用的事：

- 以 Toloka `prompt` 为 base
- 以 `uid_to_keywords.csv` 的 keyword set 作为原子风格扩展
- 生成 `source_kind=composed` 的二次 prompt

MVP 有意保持窄：

- 不引入 DSL
- 不做多阶段 prompt 编译器
- 不在这里实现 provider 调度

后续若要支持 Banana/Gemini 专属重写、showcase 描述文案、API 入参模板，可以继续往这一层加新的纯函数变换。
