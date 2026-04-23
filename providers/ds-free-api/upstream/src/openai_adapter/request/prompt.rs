//! Prompt 构建 —— 将 OpenAI messages 转换为 ChatML 格式字符串
//!
//! 若请求包含工具定义或行为指令，会以独立的 `<|im_start|>reminder` 块
//! 插入到 `<|im_start|>assistant` 之前，确保工具上下文始终紧邻模型生成位置。

use super::tools::ToolContext;
use crate::openai_adapter::types::{ChatCompletionRequest, ContentPart, Message, MessageContent};

const IM_START: &str = "<|im_start|>";
const IM_END: &str = "<|im_end|>";

/// 构建 ChatML 格式的 prompt 字符串
pub fn build(req: &ChatCompletionRequest, tool_ctx: &ToolContext) -> String {
    let mut parts: Vec<String> = req.messages.iter().map(format_message).collect();

    let extra_blocks: Vec<&str> = [
        tool_ctx.defs_text.as_deref(),
        tool_ctx.instruction_text.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect();

    if !extra_blocks.is_empty() {
        let extra = extra_blocks.join("\n\n");
        parts.push(format!("{IM_START}reminder\n{extra}\n{IM_END}"));
    }

    parts.push(format!("{IM_START}assistant"));
    parts.join("\n")
}

fn format_message(msg: &Message) -> String {
    let body = match msg.role.as_str() {
        "assistant" => format_assistant(msg),
        "tool" => format_tool(msg),
        "function" => format_function(msg),
        _ => format_generic(msg),
    };
    format!("{IM_START}{}\n{}\n{IM_END}", msg.role, body)
}

fn format_generic(msg: &Message) -> String {
    let mut parts = Vec::new();
    if let Some(name) = &msg.name {
        parts.push(format!("(name: {name})"));
    }
    if let Some(content) = &msg.content {
        parts.push(format_content(content));
    }
    parts.join("\n")
}

fn format_assistant(msg: &Message) -> String {
    let mut parts = Vec::new();
    if let Some(content) = &msg.content {
        parts.push(format_content(content));
    }
    if let Some(tool_calls) = &msg.tool_calls {
        let items: Vec<String> = tool_calls
            .iter()
            .filter_map(|tc| {
                tc.function.as_ref().map(|func| {
                    let args = serde_json::from_str::<serde_json::Value>(&func.arguments)
                        .unwrap_or(serde_json::Value::Null);
                    format!(
                        "{{\"name\": {}, \"arguments\": {}}}",
                        serde_json::to_string(&func.name).unwrap_or_else(|_| "\"\"".into()),
                        serde_json::to_string(&args).unwrap_or_else(|_| "null".into()),
                    )
                })
            })
            .collect();
        parts.push(format!(
            "<tool_calls>\n[{}]\n</tool_calls>",
            items.join(", ")
        ));
    }
    if let Some(fc) = &msg.function_call {
        let args = serde_json::from_str::<serde_json::Value>(&fc.arguments)
            .unwrap_or(serde_json::Value::Null);
        let item = format!(
            "{{\"name\": {}, \"arguments\": {}}}",
            serde_json::to_string(&fc.name).unwrap_or_else(|_| "\"\"".into()),
            serde_json::to_string(&args).unwrap_or_else(|_| "null".into()),
        );
        parts.push(format!("<tool_calls>\n[{item}]\n</tool_calls>"));
    }
    if let Some(refusal) = &msg.refusal {
        parts.push(format!("(refusal: {refusal})"));
    }
    parts.join("\n")
}

fn format_tool(msg: &Message) -> String {
    let mut parts = Vec::new();
    if let Some(id) = &msg.tool_call_id {
        parts.push(format!("(tool_call_id: {id})"));
    }
    if let Some(content) = &msg.content {
        parts.push(format_content(content));
    }
    parts.join("\n")
}

fn format_function(msg: &Message) -> String {
    let mut parts = Vec::new();
    if let Some(name) = &msg.name {
        parts.push(format!("(name: {name})"));
    }
    if let Some(content) = &msg.content {
        parts.push(format_content(content));
    }
    parts.join("\n")
}

fn format_content(content: &MessageContent) -> String {
    match content {
        MessageContent::Text(text) => text.clone(),
        MessageContent::Parts(parts) => {
            parts.iter().map(format_part).collect::<Vec<_>>().join("\n")
        }
    }
}

fn format_part(part: &ContentPart) -> String {
    match part.ty.as_str() {
        "text" => part.text.clone().unwrap_or_default(),
        "refusal" => part.refusal.clone().unwrap_or_default(),
        "image_url" => {
            let detail = part
                .image_url
                .as_ref()
                .and_then(|i| i.detail.as_deref())
                .unwrap_or("auto");
            format!("[图片: detail={detail}]")
        }
        "input_audio" => {
            let fmt = part
                .input_audio
                .as_ref()
                .map(|a| a.format.as_str())
                .unwrap_or("unknown");
            format!("[音频: format={fmt}]")
        }
        "file" => {
            let filename = part
                .file
                .as_ref()
                .and_then(|f| f.filename.as_deref())
                .unwrap_or("unknown");
            format!("[文件: filename={filename}]")
        }
        _ => format!("[未支持的内容类型: {}]", part.ty),
    }
}
