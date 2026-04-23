//! SSE 流桥接 —— StreamResponse 转 axum Body
//!
//! StreamResponse 已输出 SSE 格式字节，直接管道输出即可。

use axum::{
    body::Body,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use futures::StreamExt;

use crate::openai_adapter::StreamResponse;

/// SSE 响应体包装器
pub struct SseBody {
    inner: StreamResponse,
}

impl SseBody {
    pub fn new(stream: StreamResponse) -> Self {
        Self { inner: stream }
    }
}

impl IntoResponse for SseBody {
    fn into_response(self) -> Response {
        // StreamResponse 已经输出 SSE 格式的字节，直接转换为 axum Body
        let body = Body::from_stream(self.inner.map(|result| {
            result.map_err(|e| {
                log::error!(target: "http::response", "SSE stream error: {}", e);
                std::io::Error::other(e.to_string())
            })
        }));

        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/event-stream"),
                (header::CACHE_CONTROL, "no-cache"),
                (header::CONNECTION, "keep-alive"),
            ],
            body,
        )
            .into_response()
    }
}
