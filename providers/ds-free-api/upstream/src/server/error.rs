//! HTTP 错误响应格式 —— OpenAI 兼容错误 JSON
//!
//! 将适配器错误映射为标准 OpenAI 错误响应格式。

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::fmt;

use crate::openai_adapter::OpenAIAdapterError;

/// OpenAI 兼容错误响应体
#[derive(Debug, Serialize)]
pub struct OpenAIErrorBody {
    error: OpenAIErrorDetail,
}

#[derive(Debug, Serialize)]
struct OpenAIErrorDetail {
    message: String,
    #[serde(rename = "type")]
    error_type: &'static str,
    code: &'static str,
}

/// 服务器层错误类型
#[derive(Debug)]
pub enum ServerError {
    /// 适配器错误
    Adapter(OpenAIAdapterError),
    /// 未授权（无效 API token）
    Unauthorized,
    /// 模型不存在
    NotFound(String),
}

impl fmt::Display for ServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Adapter(e) => write!(f, "{}", e),
            Self::Unauthorized => write!(f, "invalid api token"),
            Self::NotFound(id) => write!(f, "模型 '{}' 不存在", id),
        }
    }
}

impl From<OpenAIAdapterError> for ServerError {
    fn from(e: OpenAIAdapterError) -> Self {
        Self::Adapter(e)
    }
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        let (status, error_type, code) = match &self {
            Self::Adapter(e) => {
                let status = StatusCode::from_u16(e.status_code())
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                let (error_type, code) = match e {
                    OpenAIAdapterError::BadRequest(_) => ("invalid_request_error", "bad_request"),
                    OpenAIAdapterError::Overloaded => ("server_error", "overloaded"),
                    OpenAIAdapterError::ProviderError(_) => ("server_error", "provider_error"),
                    OpenAIAdapterError::Internal(_) => ("server_error", "internal_error"),
                };
                (status, error_type, code)
            }
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "authentication_error",
                "invalid_api_token",
            ),
            Self::NotFound(_) => (
                StatusCode::NOT_FOUND,
                "invalid_request_error",
                "model_not_found",
            ),
        };

        let body = OpenAIErrorBody {
            error: OpenAIErrorDetail {
                message: self.to_string(),
                error_type,
                code,
            },
        };

        log::debug!(target: "http::response", "{} error: {}", status, body.error.message);

        (status, Json(body)).into_response()
    }
}
