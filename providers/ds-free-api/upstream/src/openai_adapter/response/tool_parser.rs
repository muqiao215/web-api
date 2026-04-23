//! 工具调用解析 —— 滑动窗口检测 XML <tool_calls>，转换为结构化 tool_calls
//!
//! 算法核心：
//! - Detecting 状态：维护固定宽度 W 的扫描缓冲区，新 chunk 到来时
//!   先追加到缓冲区，扫描 `<tool_calls>`，未找到则释放超出 W 的安全部分
//! - CollectingXml 状态：检测到 `<tool_calls>` 后收集 XML 直到 `</tool_calls>`
//! - Done 状态：工具调用已发出，截断后续内容（防幻觉）

use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

use futures::Stream;
use pin_project_lite::pin_project;

use log::debug;

use crate::openai_adapter::OpenAIAdapterError;
use crate::openai_adapter::types::{
    ChatCompletionChunk, ChunkChoice, Delta, FunctionCall, ToolCall,
};

static CALL_ID_COUNTER: AtomicU64 = AtomicU64::new(1);
const MAX_XML_BUF_LEN: usize = 64 * 1024;

/// `<tool_calls>` 标记
const TAG_START: &str = "<tool_calls>";
/// `</tool_calls>` 闭合标记
const TAG_END: &str = "</tool_calls>";
/// 标记字节长度
const TAG_LEN: usize = TAG_START.len(); // 12
/// 滑动扫描窗口大小 = 标记长度 + 安全余量
/// 保证大 chunk 到来时不会将 `<tool_calls>` 前缀挤出窗口
const W: usize = TAG_LEN + 7; // 19

fn next_call_id() -> String {
    let n = CALL_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("call_{:016x}", n)
}

/// 返回不超过 `max` 的最大 UTF-8 字符边界偏移
fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// 解析 `<tool_calls>...</tool_calls>` 中的 JSON 数组，返回结构化 ToolCall 列表
///
/// 标签内格式为 JSON 数组：
/// `<tool_calls>[{"name": "get_weather", "arguments": {"city": "北京"}}]</tool_calls>`
pub fn parse_tool_calls(xml: &str) -> Option<(Vec<ToolCall>, String)> {
    let start = xml.find(TAG_START)?;
    let after_start = start + TAG_START.len();

    // 闭合标签可选：有则截断尾部幻觉，无则取到末尾
    let (end, inner_end) = match xml.find(TAG_END) {
        Some(pos) => (pos + TAG_END.len(), pos),
        None => (xml.len(), xml.len()),
    };
    let inner = &xml[after_start..inner_end];

    // 找到第一个 [ 和最后一个 ] 来提取 JSON 数组，容许标签内有非 JSON 文本
    let arr_start = inner.find('[')?;
    let arr_end = inner.rfind(']')? + 1;
    let json_str = &inner[arr_start..arr_end];

    let arr: Vec<serde_json::Value> = serde_json::from_str(json_str).ok()?;
    let mut calls = Vec::new();
    for item in arr {
        let name = item.get("name")?.as_str()?.to_string();
        let arguments = match item.get("arguments") {
            Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "{}".into()),
            None => "{}".into(),
        };
        calls.push(ToolCall {
            id: next_call_id(),
            ty: "function".to_string(),
            function: Some(FunctionCall { name, arguments }),
            custom: None,
            index: calls.len() as u32,
        });
    }

    if calls.is_empty() {
        return None;
    }

    let remaining = xml[..start].to_string() + &xml[end..];
    Some((calls, remaining))
}

fn make_end_chunk(model: &str, delta: Delta, finish_reason: &'static str) -> ChatCompletionChunk {
    ChatCompletionChunk {
        id: "chatcmpl-end".to_string(),
        object: "chat.completion.chunk",
        created: 0,
        model: model.to_string(),
        choices: vec![ChunkChoice {
            index: 0,
            delta,
            finish_reason: Some(finish_reason),
            logprobs: None,
        }],
        usage: None,
        service_tier: None,
        system_fingerprint: None,
    }
}

#[derive(Debug)]
enum ToolParseState {
    /// 滑动窗口扫描：累积内容，W 宽度窗口检测 `<tool_calls>`
    Detecting {
        /// 累积缓冲区：保留尾部 W 个字节用于标记检测
        buffer: String,
    },
    /// 检测到 `<tool_calls>`，收集 XML 直到 `</tool_calls>`
    CollectingXml(String),
    /// 工具调用已发出，截断后续内容
    Done,
}

pin_project! {
    #[allow(unused_doc_comments)]
    /// 在 content delta 中检测并解析 XML <tool_calls> 的流转换器
    ///
    /// 使用固定宽度 W 的滑动窗口：新内容进入缓冲区，扫描后再释放安全部分，
    /// 确保 `<tool_calls>` 碎片不会溢出窗口。检测到标记后收集完整 XML，
    /// 解析为结构化 tool_calls 并发出。
    pub struct ToolCallStream<S> {
        #[pin]
        inner: S,
        state: ToolParseState,
        model: String,
        finish_emitted: bool,
    }
}

impl<S> ToolCallStream<S> {
    /// 创建工具调用解析流
    pub fn new(inner: S, model: String) -> Self {
        Self {
            inner,
            state: ToolParseState::Detecting {
                buffer: String::new(),
            },
            model,
            finish_emitted: false,
        }
    }
}

impl<S> Stream for ToolCallStream<S>
where
    S: Stream<Item = Result<ChatCompletionChunk, OpenAIAdapterError>>,
{
    type Item = Result<ChatCompletionChunk, OpenAIAdapterError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let mut this = self.project();

        loop {
            match this.inner.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(mut chunk))) => {
                    let choice = match chunk.choices.first_mut() {
                        Some(c) => c,
                        None => return Poll::Ready(Some(Ok(chunk))),
                    };

                    if let Some(content) = choice.delta.content.take() {
                        if content.is_empty() {
                            choice.delta.content = Some(content);
                            return Poll::Ready(Some(Ok(chunk)));
                        }

                        match &mut this.state {
                            ToolParseState::Detecting { buffer } => {
                                buffer.push_str(&content);

                                // 扫描缓冲区是否包含 <tool_calls>
                                if let Some(pos) = buffer.find(TAG_START) {
                                    debug!(
                                        target: "adapter",
                                        "tool_parser 检测到 <tool_calls>，缓冲区大小={}",
                                        buffer.len()
                                    );
                                    let before = buffer[..pos].to_string();
                                    let rest = std::mem::take(buffer)[pos..].to_string();

                                    // 检查闭合标签是否也在缓冲区中
                                    if let Some(end_pos) = rest.find(TAG_END) {
                                        let end_abs = end_pos + TAG_END.len();
                                        let collected = &rest[..end_abs];

                                        if let Some((calls, _)) = parse_tool_calls(collected) {
                                            debug!(
                                                target: "adapter",
                                                "tool_parser 解析出 {} 个工具调用",
                                                calls.len()
                                            );
                                            choice.delta.content = if before.is_empty() {
                                                None
                                            } else {
                                                Some(before)
                                            };
                                            choice.delta.tool_calls = Some(calls);
                                            if choice.finish_reason == Some("stop") {
                                                choice.finish_reason = Some("tool_calls");
                                            }
                                            *this.state = ToolParseState::Done;
                                        } else {
                                            debug!(
                                                target: "adapter",
                                                "tool_parser 解析失败，回退纯文本"
                                            );
                                            choice.delta.content = Some(format!("{before}{rest}"));
                                            *this.state = ToolParseState::Detecting {
                                                buffer: String::new(),
                                            };
                                        }
                                        return Poll::Ready(Some(Ok(chunk)));
                                    }

                                    // 无闭合标签，进入收集状态
                                    if before.is_empty() {
                                        *this.state = ToolParseState::CollectingXml(rest);
                                        continue; // 无前导文本，吞掉此 chunk
                                    }
                                    choice.delta.content = Some(before);
                                    *this.state = ToolParseState::CollectingXml(rest);
                                    return Poll::Ready(Some(Ok(chunk)));
                                } else {
                                    // 无标记，安全释放超出窗口的部分
                                    let safe =
                                        floor_char_boundary(buffer, buffer.len().saturating_sub(W));
                                    if safe > 0 {
                                        choice.delta.content = Some(buffer[..safe].to_string());
                                        buffer.drain(..safe);
                                        return Poll::Ready(Some(Ok(chunk)));
                                    }
                                    // 内容在扫描窗口内，暂不释放
                                    continue;
                                }
                            }

                            ToolParseState::CollectingXml(buf) => {
                                buf.push_str(&content);
                                if buf.len() > MAX_XML_BUF_LEN {
                                    debug!(
                                        target: "adapter",
                                        "tool_parser 缓冲超限，回退纯文本"
                                    );
                                    let flushed = std::mem::take(buf);
                                    *this.state = ToolParseState::Detecting {
                                        buffer: String::new(),
                                    };
                                    choice.delta.content = Some(flushed);
                                    return Poll::Ready(Some(Ok(chunk)));
                                }
                                if let Some(end_pos) = buf.find(TAG_END) {
                                    let end_abs = end_pos + TAG_END.len();
                                    let collected = buf[..end_abs].to_string();
                                    let tail = buf.split_off(end_abs);

                                    if let Some((calls, _)) = parse_tool_calls(&collected) {
                                        debug!(
                                            target: "adapter",
                                            "tool_parser 解析出 {} 个工具调用",
                                            calls.len()
                                        );
                                        // 闭合标签之后的内容是模型幻觉（如继续生成多轮对话），丢弃
                                        choice.delta.content = None;
                                        choice.delta.tool_calls = Some(calls);
                                        if choice.finish_reason == Some("stop") {
                                            choice.finish_reason = Some("tool_calls");
                                        }
                                        *this.state = ToolParseState::Done;
                                    } else {
                                        debug!(
                                            target: "adapter",
                                            "tool_parser 解析失败，回退纯文本"
                                        );
                                        let mut flushed = collected;
                                        flushed.push_str(&tail);
                                        choice.delta.content = Some(flushed);
                                        *this.state = ToolParseState::Detecting {
                                            buffer: String::new(),
                                        };
                                    }
                                    return Poll::Ready(Some(Ok(chunk)));
                                }
                                // XML 未闭合，继续收集
                                continue;
                            }

                            ToolParseState::Done => {
                                // 已解析 tool_calls，丢弃后续幻觉内容，主动关闭流
                                if !*this.finish_emitted {
                                    *this.finish_emitted = true;
                                    let chunk =
                                        make_end_chunk(this.model, Delta::default(), "tool_calls");
                                    return Poll::Ready(Some(Ok(chunk)));
                                }
                                return Poll::Ready(None);
                            }
                        }
                    } else {
                        // 无 content 的 delta（finish_reason、role、reasoning 等）
                        match &mut this.state {
                            ToolParseState::Detecting { buffer } => {
                                if choice.finish_reason.is_some() {
                                    // finish chunk，冲刷剩余缓冲
                                    if !buffer.is_empty() {
                                        choice.delta.content = Some(std::mem::take(buffer));
                                    }
                                    return Poll::Ready(Some(Ok(chunk)));
                                }
                                // 非 finish（role、reasoning 等），直接透传
                                return Poll::Ready(Some(Ok(chunk)));
                            }

                            ToolParseState::CollectingXml(buf) => {
                                if choice.finish_reason.is_some() {
                                    // finish 到达，尝试解析（闭合标签可选）
                                    let flushed = std::mem::take(buf);
                                    if let Some((calls, _)) = parse_tool_calls(&flushed) {
                                        debug!(
                                            target: "adapter",
                                            "tool_parser 流结束时解析出 {} 个工具调用",
                                            calls.len()
                                        );
                                        choice.delta.tool_calls = Some(calls);
                                        if choice.finish_reason == Some("stop") {
                                            choice.finish_reason = Some("tool_calls");
                                        }
                                    } else {
                                        debug!(
                                            target: "adapter",
                                            "tool_parser 流结束但解析失败，回退纯文本"
                                        );
                                        choice.delta.content = Some(flushed);
                                    }
                                    *this.state = ToolParseState::Done;
                                    return Poll::Ready(Some(Ok(chunk)));
                                }
                                // 非 finish（如 reasoning），透传
                                return Poll::Ready(Some(Ok(chunk)));
                            }

                            ToolParseState::Done => {
                                // 已解析 tool_calls，主动关闭流
                                if !*this.finish_emitted {
                                    *this.finish_emitted = true;
                                    let chunk =
                                        make_end_chunk(this.model, Delta::default(), "tool_calls");
                                    return Poll::Ready(Some(Ok(chunk)));
                                }
                                return Poll::Ready(None);
                            }
                        }
                    }
                }
                Poll::Ready(Some(Err(e))) => return Poll::Ready(Some(Err(e))),
                Poll::Ready(None) => {
                    // 流结束，冲刷残留缓冲
                    match std::mem::replace(this.state, ToolParseState::Done) {
                        ToolParseState::Detecting { buffer } => {
                            if !buffer.is_empty() {
                                let chunk = make_end_chunk(
                                    this.model,
                                    Delta {
                                        content: Some(buffer),
                                        ..Default::default()
                                    },
                                    "stop",
                                );
                                return Poll::Ready(Some(Ok(chunk)));
                            }
                            return Poll::Ready(None);
                        }
                        ToolParseState::CollectingXml(buf) => {
                            // 流结束，尝试解析（闭合标签可选）
                            if let Some((calls, _)) = parse_tool_calls(&buf) {
                                debug!(
                                    target: "adapter",
                                    "tool_parser 流结束时解析出 {} 个工具调用",
                                    calls.len()
                                );
                                let chunk = make_end_chunk(
                                    this.model,
                                    Delta {
                                        tool_calls: Some(calls),
                                        ..Default::default()
                                    },
                                    "tool_calls",
                                );
                                return Poll::Ready(Some(Ok(chunk)));
                            } else {
                                debug!(
                                    target: "adapter",
                                    "tool_parser 流结束但解析失败，回退纯文本"
                                );
                                let chunk = make_end_chunk(
                                    this.model,
                                    Delta {
                                        content: Some(buf),
                                        ..Default::default()
                                    },
                                    "stop",
                                );
                                return Poll::Ready(Some(Ok(chunk)));
                            }
                        }
                        ToolParseState::Done => return Poll::Ready(None),
                    }
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_tool_calls() {
        let xml =
            r#"<tool_calls>[{"name": "get_weather", "arguments": {"city": "北京"}}]</tool_calls>"#;
        let (calls, remaining) = parse_tool_calls(xml).unwrap();
        assert!(remaining.is_empty());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.as_ref().unwrap().name, "get_weather");
        assert_eq!(
            calls[0].function.as_ref().unwrap().arguments,
            r#"{"city":"北京"}"#
        );
    }

    #[test]
    fn parse_json_with_surrounding_text() {
        // 模型可能在 JSON 前后加废话
        let xml = r#"<tool_calls>
以下是工具调用：
[{"name": "f", "arguments": {}}]
</tool_calls>"#;
        let (calls, _remaining) = parse_tool_calls(xml).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.as_ref().unwrap().name, "f");
    }

    #[test]
    fn parse_json_multiple_tools() {
        let xml = r#"<tool_calls>[{"name": "get_weather", "arguments": {}}, {"name": "get_time", "arguments": {"tz": "bj"}}]</tool_calls>"#;
        let (calls, remaining) = parse_tool_calls(xml).unwrap();
        assert!(remaining.is_empty());
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].index, 0);
        assert_eq!(calls[0].function.as_ref().unwrap().name, "get_weather");
        assert_eq!(calls[1].index, 1);
        assert_eq!(calls[1].function.as_ref().unwrap().name, "get_time");
    }

    #[test]
    fn parse_json_with_trailing_text() {
        let xml =
            r#"<tool_calls>[{"name": "get_weather", "arguments": {}}]</tool_calls> trailing text"#;
        let (calls, remaining) = parse_tool_calls(xml).unwrap();
        assert_eq!(remaining, " trailing text");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.as_ref().unwrap().name, "get_weather");
    }
}
