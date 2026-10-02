//! Provider usage quotas for the Agent Dashboard.

use serde::{Deserialize, Serialize};

pub mod parsers;

/// Window length of a five-hour limit, in seconds.
pub const FIVE_HOURS: u64 = 18_000;
/// Window length of a weekly limit, in seconds.
pub const WEEK: u64 = 604_800;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Claude,
    Codex,
    OpencodeGo,
    Grok,
}

impl Provider {
    /// Display order everywhere.
    pub const ALL: [Provider; 4] = [
        Provider::Claude,
        Provider::Codex,
        Provider::OpencodeGo,
        Provider::Grok,
    ];
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::OpencodeGo => "opencodeGo",
            Provider::Grok => "grok",
        })
    }
}

/// One usage limit of a Provider. `resets_at` is epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
    pub duration_secs: Option<u64>,
}
