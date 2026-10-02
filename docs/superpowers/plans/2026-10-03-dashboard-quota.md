# Dashboard Quota Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth "Quota" column to the Agent Dashboard showing used percent and time-to-reset of each Window for Claude, Codex, OpenCode Go and Grok.

**Architecture:** A pure Rust module `src-tauri/src/quota/` reads each CLI's stored credential (read-only), calls the Provider's undocumented usage endpoint with `reqwest`, and classifies the response into a `QuotaOutcome`; one stateless Tauri command `quota_fetch(provider)` exposes it. The frontend owns scheduling (fetch only while the dashboard is mounted), keeps per-Provider entries in a small zustand store, and renders `QuotaColumn` after the four bucket columns.

**Tech Stack:** Rust (Tauri v2, tokio, serde, reqwest + rustls, chrono), React 19 + TypeScript, zustand 5, Vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-10-03-dashboard-quota-design.md`

## Global Constraints

- Credentials are read-only: never refresh, write or rotate a token; never launch a CLI (ADR 0002).
- Never log a token or a response body. The only log line is `tracing::info!("quota {provider}: {}", outcome.log_line())`.
- Every request: `GET`, `Authorization: Bearer <token>`, `Accept: application/json`, 10 s timeout, no cookie store.
- All quota JSON crossing IPC is camelCase: Rust types use `#[serde(rename_all = "camelCase")]`; the outcome enum is tagged `kind` with camelCase tags and camelCase fields.
- Timestamps crossing IPC are epoch **milliseconds** (`i64` in Rust, `number` in TS). Window length is `durationSecs` (whole seconds, `u64`, rounded).
- Provider ids on the wire: `"claude" | "codex" | "opencodeGo" | "grok"`. Display order everywhere: Claude, Codex, OpenCode Go, Grok.
- Display names: `Claude`, `Codex`, `OpenCode Go`, `Grok`. CLI names (for "run <cli>"): `claude`, `codex`, `opencode`, `grok`. Agent icon ids: `claude`, `codex`, `opencode`, `grok`.
- Percent is used percent, clamped to 0…100, never converted to remaining. A JSON boolean is never a number.
- Provider-side conditions are `QuotaOutcome`s, never `AppError`. `quota_fetch` always returns `Ok`.
- Fixed copy: `not signed in`, `sign-in expired — run <cli>` (em dash), `no Go subscription`, `rate limited`, `unreadable response`, `Keychain access denied`, `network error`, `HTTP <status>`.
- Rust tests live in `#[cfg(test)] mod tests` at the bottom of each module (repo convention). Run from `src-tauri/`.
- Frontend tests use `toBeTruthy()` / `toBeNull()` (repo convention, no jest-dom matchers) and mock IPC with `vi.mock("../lib/ipc", …)`.

## Review Focus

1. Opening and closing the dashboard quickly, or pressing Refresh repeatedly, must not start a second fetch for a Provider already in flight (store test in Task 5).
2. `invoke` rejecting (command missing, not running under Tauri) must leave the entry as a `problem`, never stuck in-flight with a spinner forever (store test in Task 5).
3. A response body or token must never reach the log line, even when it contains a secret (`log_line` test in Task 3).
4. A credential file that exists but has an empty token, or only an API key, is "not signed in", not an HTTP 401 (credentials test in Task 2).
5. The Quota column must stay visible when search or filters hide every agent card (dashboard test in Task 6).

---

### Task 1: Rust quota types, date parsing and response parsers

**Files:**
- Modify: `src-tauri/Cargo.toml` (dependencies)
- Modify: `src-tauri/src/lib.rs:1-10` (add `pub mod quota;`)
- Create: `src-tauri/src/quota/mod.rs`
- Create: `src-tauri/src/quota/parsers.rs`

**Interfaces:**
- Produces (in `quota/mod.rs`):
  - `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")] pub enum Provider { Claude, Codex, OpencodeGo, Grok }` with `pub const ALL: [Provider; 4]` and `impl std::fmt::Display` printing the wire id (`claude`, `codex`, `opencodeGo`, `grok`).
  - `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub struct QuotaWindow { pub label: String, pub used_percent: f64, pub resets_at: Option<i64>, pub duration_secs: Option<u64> }`
  - `pub const FIVE_HOURS: u64 = 18_000; pub const WEEK: u64 = 604_800;`
- Produces (in `quota/parsers.rs`):
  - `pub fn parse_date(v: &serde_json::Value) -> Option<i64>` — epoch ms.
  - `pub fn duration_label(secs: Option<u64>) -> String`
  - `pub fn parse(provider: Provider, body: &[u8]) -> Vec<QuotaWindow>`

- [ ] **Step 1: Add dependencies and module skeleton**

In `src-tauri/Cargo.toml` `[dependencies]` add:

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
chrono = { version = "0.4", default-features = false, features = ["std", "clock"] }
```

Add `pub mod quota;` to `src-tauri/src/lib.rs` (alphabetical, after `pub mod machines;`). Create `quota/mod.rs` with the types above and `pub mod parsers;`.

Run: `cd src-tauri && cargo build`
Expected: builds (reqwest/rustls compile alongside Tauri).

- [ ] **Step 2: Write the failing tests** at the bottom of `src-tauri/src/quota/parsers.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::{Provider, QuotaWindow, FIVE_HOURS, WEEK};
    use serde_json::json;

    fn w(label: &str, pct: f64, resets_at: Option<i64>, duration_secs: Option<u64>) -> QuotaWindow {
        QuotaWindow { label: label.into(), used_percent: pct, resets_at, duration_secs }
    }
    fn win(p: Provider, s: &str) -> Vec<QuotaWindow> {
        parse(p, s.as_bytes())
    }

    // Dates

    #[test]
    fn dates_iso_with_six_fraction_digits_and_offset() {
        assert_eq!(parse_date(&json!("2026-09-17T14:00:00.551304+00:00")), Some(1_789_653_600_551));
    }
    #[test]
    fn dates_iso_millis_zulu_no_fraction_and_non_utc() {
        assert_eq!(parse_date(&json!("2026-09-17T17:23:46.966Z")), Some(1_789_665_826_966));
        assert_eq!(parse_date(&json!("2026-09-22T02:00:00+00:00")), Some(1_790_042_400_000));
        assert_eq!(parse_date(&json!("2026-09-17T21:00:00+07:00")), Some(1_789_653_600_000));
    }
    #[test]
    fn dates_epoch_seconds_millis_and_numeric_strings() {
        assert_eq!(parse_date(&json!(1_790_250_529)), Some(1_790_250_529_000));
        assert_eq!(parse_date(&json!(1_790_250_529_000_i64)), Some(1_790_250_529_000));
        assert_eq!(parse_date(&json!("1790250529")), Some(1_790_250_529_000));
    }
    #[test]
    fn dates_garbage_is_none() {
        assert_eq!(parse_date(&json!("soon")), None);
        assert_eq!(parse_date(&json!("")), None);
        assert_eq!(parse_date(&json!(null)), None);
        assert_eq!(parse_date(&json!(true)), None);
    }

    // Claude

    const CLAUDE: &str = r#"
    {"five_hour":{"utilization":16.0,"resets_at":"2026-09-17T14:00:00.996301+00:00"},
     "seven_day":{"utilization":28.0,"resets_at":"2026-09-22T02:00:00.996324+00:00"},
     "seven_day_opus":null,
     "extra_usage":{"is_enabled":false,"utilization":null},
     "limits":[
      {"kind":"session","group":"session","percent":19,"severity":"normal","resets_at":"2026-09-17T14:00:00+00:00","scope":null,"is_active":false},
      {"kind":"weekly_all","group":"weekly","percent":28,"severity":"normal","resets_at":"2026-09-22T02:00:00+00:00","scope":null,"is_active":true},
      {"kind":"weekly_scoped","group":"weekly","percent":10,"severity":"normal","resets_at":"2026-09-22T01:59:59+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}
     ]}"#;

    #[test]
    fn claude_reads_limits_including_per_model_weeks() {
        assert_eq!(win(Provider::Claude, CLAUDE), vec![
            w("5h", 19.0, Some(1_789_653_600_000), Some(FIVE_HOURS)),
            w("week", 28.0, Some(1_790_042_400_000), Some(WEEK)),
            w("week · Fable", 10.0, Some(1_790_042_399_000), Some(WEEK)),
        ]);
    }
    #[test]
    fn claude_skips_unknown_kinds_and_scoped_without_model_name() {
        let s = r#"{"limits":[
          {"kind":"session","percent":5,"resets_at":null},
          {"kind":"daily_mystery","percent":50,"resets_at":null},
          {"kind":"weekly_scoped","percent":7,"resets_at":null,"scope":{"model":null}}]}"#;
        assert_eq!(win(Provider::Claude, s), vec![w("5h", 5.0, None, Some(FIVE_HOURS))]);
    }
    #[test]
    fn claude_falls_back_to_older_shape() {
        let s = r#"{"five_hour":{"utilization":16.0,"resets_at":"2026-09-17T14:00:00.996301+00:00"},
                    "seven_day":{"used_percentage":28.0,"resets_at":"2026-09-22T02:00:00.996324+00:00"}}"#;
        assert_eq!(win(Provider::Claude, s), vec![
            w("5h", 16.0, Some(1_789_653_600_996), Some(FIVE_HOURS)),
            w("week", 28.0, Some(1_790_042_400_996), Some(WEEK)),
        ]);
    }

    // Codex

    #[test]
    fn codex_reads_plan_window_and_ignores_additional_limits() {
        let s = r#"{"plan_type":"prolite","rate_limit":{"allowed":true,"limit_reached":false,
          "primary_window":{"used_percent":0,"limit_window_seconds":604800,"reset_after_seconds":602704,"reset_at":1790250529},
          "secondary_window":null},
          "additional_rate_limits":[{"limit_name":"GPT-5.3-Codex-Spark","rate_limit":{
          "primary_window":{"used_percent":40,"limit_window_seconds":18000,"reset_at":1789665826}}}]}"#;
        assert_eq!(win(Provider::Codex, s), vec![w("week", 0.0, Some(1_790_250_529_000), Some(WEEK))]);
    }
    #[test]
    fn codex_reads_both_windows() {
        let s = r#"{"rate_limit":{
          "primary_window":{"used_percent":42.5,"limit_window_seconds":18000,"reset_at":1789665826},
          "secondary_window":{"used_percent":12,"limit_window_seconds":604800,"reset_at":1790250529}}}"#;
        assert_eq!(win(Provider::Codex, s), vec![
            w("5h", 42.5, Some(1_789_665_826_000), Some(FIVE_HOURS)),
            w("week", 12.0, Some(1_790_250_529_000), Some(WEEK)),
        ]);
    }
    #[test]
    fn codex_keeps_any_window_length() {
        let s = r#"{"rate_limit":{
          "primary_window":{"used_percent":1,"limit_window_seconds":10800,"reset_at":1789665826},
          "secondary_window":{"used_percent":2,"reset_at":1790250529}}}"#;
        let got = win(Provider::Codex, s);
        assert_eq!(got.iter().map(|w| w.duration_secs).collect::<Vec<_>>(), vec![Some(10_800), None]);
        assert_eq!(got.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(), vec!["3h", "limit"]);
    }
    #[test]
    fn duration_labels() {
        assert_eq!(duration_label(Some(18_000)), "5h");
        assert_eq!(duration_label(Some(604_800)), "week");
        assert_eq!(duration_label(Some(172_800)), "2d");
        assert_eq!(duration_label(Some(10_800)), "3h");
        assert_eq!(duration_label(Some(5_400)), "90m");
        assert_eq!(duration_label(None), "limit");
    }

    // OpenCode Go

    #[test]
    fn opencode_reads_rolling_weekly_monthly() {
        let s = r#"{"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"2026-09-17T17:23:46.000Z"},
                  "weekly":{"status":"ok","percent":19,"resetsAt":"2026-09-21T00:00:00.000Z"},
                  "monthly":{"status":"rate-limited","percent":100,"resetsAt":"2026-10-17T01:46:02.000Z"}}}"#;
        assert_eq!(win(Provider::OpencodeGo, s), vec![
            w("5h", 0.0, Some(1_789_665_826_000), Some(FIVE_HOURS)),
            w("week", 19.0, Some(1_789_948_800_000), Some(WEEK)),
            w("month", 100.0, Some(1_792_201_562_000), None),
        ]);
    }

    // Grok

    #[test]
    fn grok_reads_weekly_credit_period() {
        let s = r#"{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-09-13T01:30:30.900554+00:00","end":"2026-09-20T01:30:30+00:00"},
          "creditUsagePercent":100.0,"onDemandCap":{"val":0},"isUnifiedBillingUser":true,
          "billingPeriodStart":"2026-09-13T01:30:30.900554+00:00","billingPeriodEnd":"2026-09-20T01:30:30.900554+00:00"}}"#;
        // Length from the period's own start to end, rounded to whole seconds.
        assert_eq!(win(Provider::Grok, s), vec![w("week", 100.0, Some(1_789_867_830_000), Some(604_799))]);
    }
    #[test]
    fn grok_without_percent_but_with_period_is_zero() {
        let s = r#"{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_MONTHLY","end":"2026-09-20T01:30:30+00:00"}}}"#;
        assert_eq!(win(Provider::Grok, s), vec![w("month", 0.0, Some(1_789_867_830_000), None)]);
    }
    #[test]
    fn grok_with_period_but_malformed_percent_has_no_window() {
        for bad in ["true", "null", "\"100\""] {
            let s = format!(r#"{{"config":{{"currentPeriod":{{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-09-20T01:30:30+00:00"}},"creditUsagePercent":{bad}}}}}"#);
            assert_eq!(win(Provider::Grok, &s), vec![], "{bad}");
        }
    }
    #[test]
    fn grok_falls_back_to_billing_period() {
        assert_eq!(
            win(Provider::Grok, r#"{"creditUsagePercent":3,"billingPeriodEnd":"2026-09-20T01:30:30Z"}"#),
            vec![w("period", 3.0, Some(1_789_867_830_000), None)]
        );
        let s = r#"{"creditUsagePercent":3,"billingPeriodStart":"2026-09-13T01:30:30Z","billingPeriodEnd":"2026-09-20T01:30:30Z"}"#;
        assert_eq!(win(Provider::Grok, s)[0].duration_secs, Some(WEEK));
    }
    #[test]
    fn grok_with_neither_percent_nor_period_has_no_window() {
        assert_eq!(win(Provider::Grok, r#"{"config":{"prepaidBalance":{"val":0}}}"#), vec![]);
    }

    // Shared

    #[test]
    fn percent_is_clamped_and_booleans_are_not_numbers() {
        let s = r#"{"usage":{"rolling":{"percent":130,"resetsAt":null},
                  "weekly":{"percent":-4,"resetsAt":null},
                  "monthly":{"percent":true,"resetsAt":null}}}"#;
        assert_eq!(win(Provider::OpencodeGo, s), vec![
            w("5h", 100.0, None, Some(FIVE_HOURS)),
            w("week", 0.0, None, Some(WEEK)),
        ]);
    }
    #[test]
    fn unreadable_bodies_have_no_windows() {
        for p in Provider::ALL {
            assert_eq!(win(p, "<html>"), vec![], "{p}");
            assert_eq!(win(p, "{}"), vec![], "{p}");
        }
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test quota::parsers`
Expected: compile errors (`parse`, `parse_date`, `duration_label` not defined).

- [ ] **Step 4: Implement `parse_date`, `duration_label`, `parse` in `parsers.rs`**

- Numbers come only from `Value::Number` (`as_f64`), which excludes booleans; clamp percent with `.clamp(0.0, 100.0)`.
- `parse_date`: number → ms if `> 1e10` else seconds × 1000; string → numeric string as number, else `chrono::DateTime::parse_from_rfc3339(..).timestamp_millis()`; anything else `None`.
- `duration_label`: 18000 → `5h`, 604800 → `week`, divisible by 86400 → `{n}d`, by 3600 → `{n}h`, else `{n/60}m`; `None` → `limit`.
- Body that is not JSON → empty vec. Per-provider rules exactly as in the spec's "Providers" section (Grok: look under `config`, else top level; percent absent + `currentPeriod` present → 0; percent present but not a number → no window; duration from `currentPeriod.start/end`, else `billingPeriodStart/End`, `((end_ms - start_ms) as f64 / 1000.0).round() as u64`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test quota::parsers`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/quota
git commit -m "feat(quota): Rust types and response parsers for four Providers"
```

---

### Task 2: Rust credentials and requests

**Files:**
- Create: `src-tauri/src/quota/credentials.rs`
- Create: `src-tauri/src/quota/requests.rs`
- Modify: `src-tauri/src/quota/mod.rs` (add `pub mod credentials; pub mod requests;` and `QuotaOutcome`)

**Interfaces:**
- Consumes: `Provider` (Task 1).
- Produces (in `quota/mod.rs`) — the outcome type, used by Tasks 2–3:

  ```rust
  #[derive(Debug, Clone, PartialEq, Serialize)]
  #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
  pub enum QuotaOutcome {
      Ok { windows: Vec<QuotaWindow>, fetched_at: i64 },
      NotSignedIn,
      SignInExpired,
      NoSubscription,
      RateLimited { until: i64 },
      Failed { reason: String },
  }
  ```
- Produces (in `credentials.rs`):
  - `#[derive(Debug, Clone, PartialEq)] pub struct Credential { pub token: String, pub account_id: Option<String> }`
  - `pub fn parse(provider: Provider, data: &[u8]) -> Option<Credential>` — `None` = not signed in; empty token = `None`.
  - `pub fn file_path(provider: Provider, home: &std::path::Path) -> Option<std::path::PathBuf>` — `None` for Claude.
  - `pub fn keychain_result(exit_code: Option<i32>, stdout: &[u8]) -> Result<Credential, QuotaOutcome>` — 0 → `parse(Claude, stdout)` or `NotSignedIn`; 44 → `NotSignedIn`; anything else (including `None` from a signal/timeout) → `Failed { reason: "Keychain access denied" }`.
  - `pub async fn read(provider: Provider) -> Result<Credential, QuotaOutcome>` — files under `$HOME` (missing/unparsable → `NotSignedIn`); Claude runs `/usr/bin/security find-generic-password -s "Claude Code-credentials" -w` with `tokio::process::Command`, stderr to `Stdio::null()`, wrapped in `tokio::time::timeout(30 s)`, then `keychain_result`.
- Produces (in `requests.rs`):
  - `pub struct Request { pub url: &'static str, pub headers: Vec<(&'static str, String)> }`
  - `pub fn request(provider: Provider, cred: &Credential) -> Request` — headers always include `Authorization` and `Accept`.

- [ ] **Step 1: Write the failing tests**

Bottom of `credentials.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::{Provider, QuotaOutcome};
    use std::path::{Path, PathBuf};

    fn cred(token: &str, account: Option<&str>) -> Option<Credential> {
        Some(Credential { token: token.into(), account_id: account.map(Into::into) })
    }
    fn p(provider: Provider, s: &str) -> Option<Credential> {
        parse(provider, s.as_bytes())
    }

    #[test]
    fn claude_reads_access_token_from_keychain_json() {
        assert_eq!(p(Provider::Claude, r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat","refreshToken":"r","expiresAt":1}}"#), cred("sk-ant-oat", None));
    }
    #[test]
    fn codex_reads_token_and_account() {
        assert_eq!(p(Provider::Codex, r#"{"auth_mode":"chatgpt","tokens":{"access_token":"eyJ","account_id":"acct-1","refresh_token":"r"}}"#), cred("eyJ", Some("acct-1")));
        assert_eq!(p(Provider::Codex, r#"{"tokens":{"access_token":"eyJ"}}"#), cred("eyJ", None));
    }
    #[test]
    fn codex_with_api_key_only_is_not_signed_in() {
        assert_eq!(p(Provider::Codex, r#"{"OPENAI_API_KEY":"sk-proj"}"#), None);
    }
    #[test]
    fn opencode_reads_only_the_go_key() {
        assert_eq!(p(Provider::OpencodeGo, r#"{"nvidia":{"type":"api","key":"nv"},"opencode-go":{"type":"api","key":"go-key"}}"#), cred("go-key", None));
        assert_eq!(p(Provider::OpencodeGo, r#"{"nvidia":{"type":"api","key":"nv"}}"#), None);
    }
    #[test]
    fn grok_prefers_xai_issuer_with_id_suffix() {
        let s = r#"{"https://other.example":{"key":"other","user_id":"u0"},
                    "https://auth.x.ai::b1a0":{"key":"xai","user_id":"u1"}}"#;
        assert_eq!(p(Provider::Grok, s), cred("xai", Some("u1")));
    }
    #[test]
    fn grok_falls_back_to_another_issuer_in_sorted_order() {
        assert_eq!(p(Provider::Grok, r#"{"https://other.example":{"key":"other"}}"#), cred("other", None));
        assert_eq!(p(Provider::Grok, r#"{"https://b.example":{"key":"b"},"https://a.example":{"key":"a"}}"#), cred("a", None));
    }
    #[test]
    fn empty_tokens_and_malformed_files_are_not_signed_in() {
        assert_eq!(p(Provider::Claude, r#"{"claudeAiOauth":{"accessToken":""}}"#), None);
        assert_eq!(p(Provider::Codex, "not json"), None);
        assert_eq!(p(Provider::Grok, "[]"), None);
    }
    #[test]
    fn file_paths() {
        let home = Path::new("/Users/me");
        assert_eq!(file_path(Provider::Claude, home), None);
        assert_eq!(file_path(Provider::Codex, home), Some(PathBuf::from("/Users/me/.codex/auth.json")));
        assert_eq!(file_path(Provider::OpencodeGo, home), Some(PathBuf::from("/Users/me/.local/share/opencode/auth.json")));
        assert_eq!(file_path(Provider::Grok, home), Some(PathBuf::from("/Users/me/.grok/auth.json")));
    }
    #[test]
    fn keychain_exit_codes() {
        let json = br#"{"claudeAiOauth":{"accessToken":"t"}}"#;
        assert_eq!(keychain_result(Some(0), json), Ok(Credential { token: "t".into(), account_id: None }));
        assert_eq!(keychain_result(Some(0), b"garbage"), Err(QuotaOutcome::NotSignedIn));
        assert_eq!(keychain_result(Some(44), b""), Err(QuotaOutcome::NotSignedIn));
        let denied = Err(QuotaOutcome::Failed { reason: "Keychain access denied".into() });
        assert_eq!(keychain_result(Some(1), b""), denied);
        assert_eq!(keychain_result(None, b""), denied);
    }
}
```

Bottom of `requests.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::{credentials::Credential, Provider};

    fn c(token: &str, account: Option<&str>) -> Credential {
        Credential { token: token.into(), account_id: account.map(Into::into) }
    }
    fn h<'a>(r: &'a Request, name: &str) -> Option<&'a str> {
        r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    #[test]
    fn claude() {
        let r = request(Provider::Claude, &c("t", None));
        assert_eq!(r.url, "https://api.anthropic.com/api/oauth/usage");
        assert_eq!(h(&r, "Authorization"), Some("Bearer t"));
        assert_eq!(h(&r, "Accept"), Some("application/json"));
        assert_eq!(h(&r, "anthropic-beta"), Some("oauth-2025-04-20"));
        assert_eq!(h(&r, "User-Agent"), Some("claude-code/2.1.0"));
    }
    #[test]
    fn codex_sends_account_when_present() {
        let r = request(Provider::Codex, &c("t", Some("acct")));
        assert_eq!(r.url, "https://chatgpt.com/backend-api/wham/usage");
        assert_eq!(h(&r, "Authorization"), Some("Bearer t"));
        assert_eq!(h(&r, "User-Agent"), Some("codex-cli"));
        assert_eq!(h(&r, "OpenAI-Beta"), Some("codex-1"));
        assert_eq!(h(&r, "originator"), Some("Codex Desktop"));
        assert_eq!(h(&r, "ChatGPT-Account-Id"), Some("acct"));
        assert_eq!(h(&request(Provider::Codex, &c("t", None)), "ChatGPT-Account-Id"), None);
    }
    #[test]
    fn opencode_go() {
        let r = request(Provider::OpencodeGo, &c("k", None));
        assert_eq!(r.url, "https://opencode.ai/zen/go/v1/usage");
        assert_eq!(h(&r, "Authorization"), Some("Bearer k"));
    }
    #[test]
    fn grok_sends_user_when_present() {
        let r = request(Provider::Grok, &c("k", Some("u1")));
        assert_eq!(r.url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
        assert_eq!(h(&r, "Authorization"), Some("Bearer k"));
        assert_eq!(h(&r, "X-XAI-Token-Auth"), Some("xai-grok-cli"));
        assert_eq!(h(&r, "Accept"), Some("application/json"));
        assert_eq!(h(&r, "x-userid"), Some("u1"));
        assert_eq!(h(&request(Provider::Grok, &c("k", None)), "x-userid"), None);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test quota::credentials quota::requests`
Expected: compile errors (items not defined). (Run the two filters as two commands if cargo rejects two filters.)

- [ ] **Step 3: Implement `QuotaOutcome`, `credentials.rs` and `requests.rs`** per the Interfaces block.

Grok issuer choice: iterate keys sorted; first key equal to `https://auth.x.ai` or starting with `https://auth.x.ai::` that has a non-empty `key` wins; otherwise the first sorted key with a non-empty `key`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test quota::`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/quota
git commit -m "feat(quota): read CLI credentials read-only and build usage requests"
```

---

### Task 3: Rust outcome classification, fetch, and the `quota_fetch` command

**Files:**
- Create: `src-tauri/src/quota/outcome.rs`
- Modify: `src-tauri/src/quota/mod.rs` (add `pub mod outcome;` and `pub async fn fetch`)
- Modify: `src-tauri/src/commands.rs` (append command)
- Modify: `src-tauri/src/lib.rs:25-53` (register `commands::quota_fetch` after `commands::system_fonts`)

**Interfaces:**
- Consumes: `Provider`, `QuotaWindow`, `QuotaOutcome`, `parsers::parse`, `credentials::read`, `requests::request`.
- Produces:
  - `pub fn classify(provider: Provider, status: u16, body: &[u8], retry_after: Option<&str>, now_ms: i64) -> QuotaOutcome` in `outcome.rs`.
  - `impl QuotaOutcome { pub fn log_line(&self) -> String }` in `outcome.rs`: `ok, <n> window(s)` · `not signed in` · `sign-in expired` · `no subscription` · `rate limited until <ms>` · `failed: <reason>`.
  - `pub async fn fetch(provider: Provider) -> QuotaOutcome` in `mod.rs`.
  - `#[tauri::command] pub async fn quota_fetch(provider: crate::quota::Provider) -> Result<crate::quota::QuotaOutcome, AppError>` in `commands.rs`, always `Ok(crate::quota::fetch(provider).await)`.

- [ ] **Step 1: Write the failing tests** at the bottom of `outcome.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::{Provider, QuotaOutcome, QuotaWindow, WEEK};

    const NOW: i64 = 1_789_650_000_000;
    fn cl(p: Provider, status: u16, body: &str, retry_after: Option<&str>) -> QuotaOutcome {
        classify(p, status, body.as_bytes(), retry_after, NOW)
    }

    #[test]
    fn ok_200_with_windows() {
        assert_eq!(
            cl(Provider::OpencodeGo, 200, r#"{"usage":{"weekly":{"percent":19,"resetsAt":null}}}"#, None),
            QuotaOutcome::Ok {
                windows: vec![QuotaWindow { label: "week".into(), used_percent: 19.0, resets_at: None, duration_secs: Some(WEEK) }],
                fetched_at: NOW,
            }
        );
    }
    #[test]
    fn ok_200_with_nothing_readable_fails() {
        assert_eq!(cl(Provider::Claude, 200, "{}", None), QuotaOutcome::Failed { reason: "unreadable response".into() });
    }
    #[test]
    fn unauthorized_is_expired_sign_in() {
        for p in Provider::ALL {
            assert_eq!(cl(p, 401, "", None), QuotaOutcome::SignInExpired, "{p}");
            assert_eq!(cl(p, 403, "", None), QuotaOutcome::SignInExpired, "{p}");
        }
    }
    #[test]
    fn opencode_without_go_subscription() {
        let body = r#"{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}"#;
        assert_eq!(cl(Provider::OpencodeGo, 403, body, None), QuotaOutcome::NoSubscription);
        assert_eq!(cl(Provider::Grok, 403, body, None), QuotaOutcome::SignInExpired);
    }
    #[test]
    fn rate_limited_honours_retry_after() {
        assert_eq!(cl(Provider::Claude, 429, "", Some("120")), QuotaOutcome::RateLimited { until: NOW + 120_000 });
    }
    #[test]
    fn rate_limited_defaults_and_caps() {
        let default = QuotaOutcome::RateLimited { until: NOW + 15 * 60_000 };
        assert_eq!(cl(Provider::Claude, 429, "", None), default);
        assert_eq!(cl(Provider::Claude, 429, "", Some("Wed, 21 Oct 2026 07:28:00 GMT")), default);
        assert_eq!(cl(Provider::Claude, 429, "", Some("0")), default);
        assert_eq!(cl(Provider::Claude, 429, "", Some("86400")), QuotaOutcome::RateLimited { until: NOW + 60 * 60_000 });
    }
    #[test]
    fn other_status_fails_with_it() {
        assert_eq!(cl(Provider::Codex, 500, "", None), QuotaOutcome::Failed { reason: "HTTP 500".into() });
        assert_eq!(cl(Provider::Grok, 404, "", None), QuotaOutcome::Failed { reason: "HTTP 404".into() });
    }
    #[test]
    fn log_lines_carry_nothing_from_the_body() {
        let ent = r#"{"type":"error","error":{"type":"EntitlementError","message":"token sk-abc123"}}"#;
        assert_eq!(cl(Provider::Grok, 500, "sk-abc123", None).log_line(), "failed: HTTP 500");
        assert_eq!(cl(Provider::Claude, 200, "sk-abc123", None).log_line(), "failed: unreadable response");
        assert_eq!(cl(Provider::OpencodeGo, 403, ent, None).log_line(), "no subscription");
        assert_eq!(cl(Provider::Claude, 401, "", None).log_line(), "sign-in expired");
        assert_eq!(cl(Provider::OpencodeGo, 200, r#"{"usage":{"weekly":{"percent":19}}}"#, None).log_line(), "ok, 1 window(s)");
        assert_eq!(cl(Provider::Claude, 429, "", None).log_line(), format!("rate limited until {}", NOW + 15 * 60_000));
        assert_eq!(QuotaOutcome::NotSignedIn.log_line(), "not signed in");
    }
    #[test]
    fn serializes_camel_case_tagged() {
        let ok = QuotaOutcome::Ok {
            windows: vec![QuotaWindow { label: "5h".into(), used_percent: 19.0, resets_at: Some(1), duration_secs: Some(18_000) }],
            fetched_at: 2,
        };
        assert_eq!(serde_json::to_value(&ok).unwrap(), serde_json::json!({
            "kind": "ok", "fetchedAt": 2,
            "windows": [{"label": "5h", "usedPercent": 19.0, "resetsAt": 1, "durationSecs": 18000}]
        }));
        assert_eq!(serde_json::to_value(QuotaOutcome::NotSignedIn).unwrap(), serde_json::json!({"kind": "notSignedIn"}));
        assert_eq!(serde_json::to_value(QuotaOutcome::RateLimited { until: 5 }).unwrap(), serde_json::json!({"kind": "rateLimited", "until": 5}));
        assert_eq!(serde_json::from_value::<Provider>(serde_json::json!("opencodeGo")).unwrap(), Provider::OpencodeGo);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test quota::outcome`
Expected: compile errors (`classify`, `log_line` not defined).

- [ ] **Step 3: Implement `classify` and `log_line`** per the spec's classify table. Retry-After: parse as positive integer seconds; missing, non-numeric or `0` → 900 s; cap 3600 s.

- [ ] **Step 4: Implement `fetch(provider)` in `mod.rs`**

`credentials::read` (an `Err` outcome is returned as is) → `requests::request` → `reqwest::Client::builder().timeout(Duration::from_secs(10)).build()` → `GET` with the headers → status, `Retry-After` header, body bytes → `classify(.., chrono::Utc::now().timestamp_millis())`. Any `reqwest` error (connect, timeout, body read) → `Failed { reason: "network error" }`. Before returning, log exactly `tracing::info!("quota {provider}: {}", outcome.log_line())`.

- [ ] **Step 5: Add the command and register it**

Append `quota_fetch` to `commands.rs` (signature in Interfaces) and add `commands::quota_fetch,` after `commands::system_fonts,` in `lib.rs`.

- [ ] **Step 6: Run tests and build**

Run: `cd src-tauri && cargo test quota:: && cargo build`
Expected: all quota tests PASS, build succeeds with no new warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/quota src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(quota): classify usage responses and expose quota_fetch command"
```

---

### Task 4: Frontend types, IPC wrapper and pure quota modules

**Files:**
- Modify: `src/lib/types.ts` (append quota types)
- Modify: `src/lib/ipc.ts` (append `quotaFetch`)
- Create: `src/quota/schedule.ts`, `src/quota/entry.ts`, `src/quota/format.ts`
- Test: `src/quota/schedule.test.ts`, `src/quota/entry.test.ts`, `src/quota/format.test.ts`

**Interfaces:**
- Consumes: the wire format of Task 3 (`QuotaOutcome` JSON).
- Produces:
  - `src/lib/types.ts`:
    ```ts
    export type QuotaProvider = "claude" | "codex" | "opencodeGo" | "grok";
    export interface QuotaWindow { label: string; usedPercent: number; resetsAt: number | null; durationSecs: number | null }
    export type QuotaOutcome =
      | { kind: "ok"; windows: QuotaWindow[]; fetchedAt: number }
      | { kind: "notSignedIn" } | { kind: "signInExpired" } | { kind: "noSubscription" }
      | { kind: "rateLimited"; until: number } | { kind: "failed"; reason: string };
    ```
  - `src/lib/ipc.ts`: `export const quotaFetch = (provider: QuotaProvider) => invoke<QuotaOutcome>("quota_fetch", { provider });`
  - `src/quota/schedule.ts`: `export type QuotaTrigger = "tick" | "shown" | "manual"; export const POLL_MS = 300_000; export const SHOW_DEBOUNCE_MS = 60_000; export function isDue(trigger: QuotaTrigger, lastStarted: number | null, rateLimitedUntil: number | null, now: number): boolean`
  - `src/quota/entry.ts`:
    ```ts
    export const QUOTA_PROVIDERS: QuotaProvider[] = ["claude", "codex", "opencodeGo", "grok"];
    export const PROVIDER_INFO: Record<QuotaProvider, { name: string; cli: string; agent: string }>;
    export interface QuotaReport { windows: QuotaWindow[]; fetchedAt: number }
    export type QuotaEntry =
      | { kind: "loading" } | { kind: "notSignedIn" } | { kind: "ok"; report: QuotaReport }
      | { kind: "problem"; message: string; last: QuotaReport | null };
    export function applying(entry: QuotaEntry, outcome: QuotaOutcome, provider: QuotaProvider): QuotaEntry;
    ```
  - `src/quota/format.ts`: `percent(n: number): string`, `untilReset(resetsAt: number | null, now: number): string | null`, `updatedAgo(fetchedAt: number, now: number): string`, `elapsedFraction(resetsAt: number | null, durationSecs: number | null, now: number): number | null`, `export type Tone = "muted" | "ok" | "warn"; tone(w: QuotaWindow, now: number): Tone`, `export const WARN_PERCENT = 90`.

- [ ] **Step 1: Write the failing tests**

`src/quota/schedule.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isDue } from "./schedule";

const now = 1_789_651_000_000;

describe("isDue", () => {
  it("is due when never fetched", () => {
    expect(isDue("tick", null, null, now)).toBe(true);
    expect(isDue("shown", null, null, now)).toBe(true);
  });
  it("tick waits five minutes", () => {
    expect(isDue("tick", now - 299_000, null, now)).toBe(false);
    expect(isDue("tick", now - 300_000, null, now)).toBe(true);
  });
  it("shown waits one minute", () => {
    expect(isDue("shown", now - 59_000, null, now)).toBe(false);
    expect(isDue("shown", now - 60_000, null, now)).toBe(true);
  });
  it("manual is due at once", () => {
    expect(isDue("manual", now, null, now)).toBe(true);
  });
  it("waits out a rate limit whatever the trigger", () => {
    for (const t of ["tick", "shown", "manual"] as const) expect(isDue(t, null, now + 1, now)).toBe(false);
    expect(isDue("shown", null, now, now)).toBe(true);
  });
});
```

`src/quota/entry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { QuotaWindow } from "../lib/types";
import { applying, type QuotaEntry } from "./entry";

const then = 1_789_650_000_000;
const windows: QuotaWindow[] = [{ label: "week", usedPercent: 28, resetsAt: null, durationSecs: null }];
const ok: QuotaEntry = { kind: "ok", report: { windows, fetchedAt: then } };
const last = { windows, fetchedAt: then };

describe("applying", () => {
  it("a report replaces whatever was there", () => {
    const fresh: QuotaWindow[] = [{ label: "week", usedPercent: 30, resetsAt: null, durationSecs: null }];
    const starts: QuotaEntry[] = [{ kind: "loading" }, { kind: "notSignedIn" }, ok, { kind: "problem", message: "rate limited", last: null }];
    for (const s of starts)
      expect(applying(s, { kind: "ok", windows: fresh, fetchedAt: then + 1 }, "claude")).toEqual({ kind: "ok", report: { windows: fresh, fetchedAt: then + 1 } });
  });
  it("not signed in replaces everything", () => {
    expect(applying(ok, { kind: "notSignedIn" }, "claude")).toEqual({ kind: "notSignedIn" });
  });
  it("problems keep the last report", () => {
    expect(applying(ok, { kind: "signInExpired" }, "claude")).toEqual({ kind: "problem", message: "sign-in expired — run claude", last });
    expect(applying(ok, { kind: "rateLimited", until: then }, "claude")).toEqual({ kind: "problem", message: "rate limited", last });
    expect(applying(ok, { kind: "failed", reason: "HTTP 500" }, "claude")).toEqual({ kind: "problem", message: "HTTP 500", last });
    const twice = applying(applying(ok, { kind: "failed", reason: "HTTP 500" }, "grok"), { kind: "signInExpired" }, "grok");
    expect(twice).toEqual({ kind: "problem", message: "sign-in expired — run grok", last });
  });
  it("no subscription drops the last report", () => {
    expect(applying(ok, { kind: "noSubscription" }, "opencodeGo")).toEqual({ kind: "problem", message: "no Go subscription", last: null });
  });
  it("names the CLI to run", () => {
    expect(applying({ kind: "loading" }, { kind: "signInExpired" }, "opencodeGo")).toEqual({ kind: "problem", message: "sign-in expired — run opencode", last: null });
  });
});
```

`src/quota/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { QuotaWindow } from "../lib/types";
import { elapsedFraction, percent, tone, untilReset, updatedAgo } from "./format";

const now = 1_789_650_000_000;
const until = (s: number) => untilReset(now + s * 1000, now);

describe("format", () => {
  it("percent rounds", () => {
    expect(percent(19)).toBe("19%");
    expect(percent(42.5)).toBe("43%");
    expect(percent(0)).toBe("0%");
  });
  it("until reset", () => {
    expect(until(4 * 86_400 + 7_200)).toBe("4d2h");
    expect(until(6 * 86_400 + 23 * 3_600 + 59 * 60)).toBe("6d23h");
    expect(until(2 * 86_400)).toBe("2d");
    expect(until(86_400 + 5 * 3_600 + 59)).toBe("1d5h");
    expect(until(86_400)).toBe("1d");
    expect(until(3_600 + 36 * 60)).toBe("1h36m");
    expect(until(5 * 3_600)).toBe("5h");
    expect(until(36 * 60 + 30)).toBe("36m");
    expect(until(59)).toBe("<1m");
    expect(until(0)).toBe("reset pending");
    expect(until(-600)).toBe("reset pending");
    expect(untilReset(null, now)).toBeNull();
  });
  it("updated ago", () => {
    expect(updatedAgo(now - 30_000, now)).toBe("updated just now");
    expect(updatedAgo(now - 23 * 60_000, now)).toBe("updated 23m ago");
    expect(updatedAgo(now - 3 * 3_600_000, now)).toBe("updated 3h ago");
    expect(updatedAgo(now - 2 * 86_400_000, now)).toBe("updated 2d ago");
  });
  it("elapsed fraction stays on the bar and needs reset and length", () => {
    expect(elapsedFraction(now + 3_600_000, 18_000, now)).toBeCloseTo(0.8);
    expect(elapsedFraction(now + 18_000_000, 18_000, now)).toBeCloseTo(0);
    expect(elapsedFraction(now + 20_000_000, 18_000, now)).toBe(0);
    expect(elapsedFraction(now - 60_000, 18_000, now)).toBe(1);
    expect(elapsedFraction(null, 18_000, now)).toBeNull();
    expect(elapsedFraction(now + 3_600_000, null, now)).toBeNull();
    expect(elapsedFraction(now + 3_600_000, 0, now)).toBeNull();
  });
  it("tone", () => {
    const w = (used: number, resetIn: number | null, dur: number | null): QuotaWindow => ({
      label: "5h", usedPercent: used, resetsAt: resetIn === null ? null : now + resetIn * 1000, durationSecs: dur,
    });
    expect(tone(w(30, 3_600, 18_000), now)).toBe("ok");
    expect(tone(w(80, 3_600, 18_000), now)).toBe("ok");
    expect(tone(w(81, 3_600, 18_000), now)).toBe("warn");
    expect(tone(w(1, 18_000, 18_000), now)).toBe("warn");
    expect(tone(w(90, 60, 18_000), now)).toBe("warn");
    expect(tone(w(95, null, null), now)).toBe("warn");
    expect(tone(w(50, null, 18_000), now)).toBe("muted");
    expect(tone(w(50, 3_600, null), now)).toBe("muted");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/quota`
Expected: FAIL (modules not found).

- [ ] **Step 3: Add types and `quotaFetch`, then implement the three modules** per Interfaces.

- `isDue`: `rateLimitedUntil !== null && now < rateLimitedUntil` → false; `manual` → true; `lastStarted === null` → true; else `now - lastStarted >=` `POLL_MS` (tick) / `SHOW_DEBOUNCE_MS` (shown).
- `applying`: `ok` → new report from `windows`/`fetchedAt`; `notSignedIn` → `notSignedIn`; `noSubscription` → problem `"no Go subscription"`, `last: null`; others → problem with message (`sign-in expired — run ${cli}`, `rate limited`, `reason`) and `last` = current `ok` report, or the current problem's `last`, else `null`.
- `untilReset`: whole seconds `Math.floor((resetsAt - now) / 1000)`; `<= 0` → `reset pending`; `< 60` → `<1m`; days → `${d}d` + `${h}h` if h > 0; hours → `${h}h` + `${m}m` if m > 0; else `${m}m`.
- `elapsedFraction`: `null` if either input is null or duration ≤ 0; `1 - (resetsAt - now) / (durationSecs * 1000)` clamped to 0…1.
- `tone`: `usedPercent >= WARN_PERCENT` → `warn`; no elapsed fraction → `muted`; `usedPercent > fraction * 100` → `warn`; else `ok`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/quota && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/ipc.ts src/quota
git commit -m "feat(quota): frontend types, IPC wrapper, schedule, entry and format"
```

---

### Task 5: Quota store

The spec puts this slice in `src/store/app.ts`; it lives in its own store instead so `app.ts` (and every test that imports it) does not pull in IPC. Behaviour is the same: entries survive the dashboard closing and reopening.

**Files:**
- Create: `src/quota/store.ts`
- Test: `src/quota/store.test.ts`

**Interfaces:**
- Consumes: `quotaFetch` (`src/lib/ipc.ts`), `isDue`/`QuotaTrigger` (`schedule.ts`), `applying`/`QUOTA_PROVIDERS`/`QuotaEntry` (`entry.ts`).
- Produces:
  ```ts
  export interface QuotaSlot { entry: QuotaEntry; lastStarted: number | null; rateLimitedUntil: number | null; inFlight: boolean }
  export interface QuotaState { slots: Record<QuotaProvider, QuotaSlot>; refresh: (trigger: QuotaTrigger) => Promise<void> }
  export const initialSlots: () => Record<QuotaProvider, QuotaSlot>;   // every entry { kind: "loading" }, nulls, inFlight false
  export const useQuota: UseBoundStore<StoreApi<QuotaState>>;
  ```

- [ ] **Step 1: Write the failing test** `src/quota/store.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ quotaFetch: vi.fn() }));
import { quotaFetch } from "../lib/ipc";
import type { QuotaOutcome } from "../lib/types";
import { initialSlots, useQuota } from "./store";

const fetchMock = vi.mocked(quotaFetch);
const okWindows = [{ label: "5h", usedPercent: 19, resetsAt: null, durationSecs: 18_000 }];
const okOutcome: QuotaOutcome = { kind: "ok", windows: okWindows, fetchedAt: 1 };

describe("useQuota", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useQuota.setState({ slots: initialSlots() });
  });

  it("fetches every Provider once and stores the outcomes", async () => {
    fetchMock.mockImplementation(async (p) => (p === "claude" ? okOutcome : { kind: "notSignedIn" }));
    await useQuota.getState().refresh("shown");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const s = useQuota.getState().slots;
    expect(s.claude.entry).toEqual({ kind: "ok", report: { windows: okWindows, fetchedAt: 1 } });
    expect(s.codex.entry).toEqual({ kind: "notSignedIn" });
    expect(s.claude.inFlight).toBe(false);
    expect(s.claude.lastStarted).not.toBeNull();
  });

  it("does not start a second fetch while one is in flight", async () => {
    let release!: () => void;
    fetchMock.mockImplementation(() => new Promise<QuotaOutcome>((r) => (release = () => r({ kind: "notSignedIn" }))));
    void useQuota.getState().refresh("manual");
    void useQuota.getState().refresh("manual");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(useQuota.getState().slots.grok.inFlight).toBe(true);
    release();
    fetchMock.mockResolvedValue({ kind: "notSignedIn" });
  });

  it("respects the schedule: shown twice within a minute fetches once", async () => {
    fetchMock.mockResolvedValue({ kind: "notSignedIn" });
    await useQuota.getState().refresh("shown");
    await useQuota.getState().refresh("shown");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("remembers a rate limit and waits it out even for manual refresh", async () => {
    fetchMock.mockResolvedValue({ kind: "rateLimited", until: Date.now() + 60_000 });
    await useQuota.getState().refresh("manual");
    expect(useQuota.getState().slots.claude.rateLimitedUntil).not.toBeNull();
    await useQuota.getState().refresh("manual");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a rejected invoke becomes a problem and clears in-flight", async () => {
    fetchMock.mockRejectedValue(new Error("command quota_fetch not found"));
    await useQuota.getState().refresh("manual");
    const slot = useQuota.getState().slots.claude;
    expect(slot.inFlight).toBe(false);
    expect(slot.entry).toEqual({ kind: "problem", message: "command quota_fetch not found", last: null });
  });
});
```

Note: the in-flight test leaves the first `refresh` pending until `release()`; it must not await it before releasing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/quota/store.test.ts`
Expected: FAIL (module `./store` not found).

- [ ] **Step 3: Implement `src/quota/store.ts`**

`refresh(trigger)`: `now = Date.now()`; for each Provider in `QUOTA_PROVIDERS` whose slot is not `inFlight` and `isDue(trigger, lastStarted, rateLimitedUntil, now)`: mark `inFlight: true, lastStarted: now`, call `quotaFetch(p)`; on resolve set `entry = applying(entry, outcome, p)`, `rateLimitedUntil = outcome.kind === "rateLimited" ? outcome.until : null`, `inFlight: false`; on reject apply `{ kind: "failed", reason: err instanceof Error ? err.message : String(err) }` the same way. Return `Promise.all` of the started fetches. Always read the latest slot with `get()` inside the callbacks.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/quota && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/quota/store.ts src/quota/store.test.ts
git commit -m "feat(quota): store that fetches due Providers in parallel"
```

---

### Task 6: Quota column on the dashboard

**Files:**
- Create: `src/dashboard/QuotaColumn.tsx`
- Test: `src/dashboard/QuotaColumn.test.tsx`
- Modify: `src/dashboard/AgentDashboard.tsx:196-217` (render `<QuotaColumn />` after the `BUCKETS.map`, inside `.dash-board`)
- Modify: `src/dashboard/AgentDashboard.test.tsx` (mock IPC; add one test)
- Modify: `src/ui/icons.tsx` (add `RefreshIcon`)
- Modify: `src/styles.css` (`.dash-board` grid → 5 columns; new `.dash-quota-*` rules after the `.dash-card-tag` rules)

**Interfaces:**
- Consumes: `useQuota`, `initialSlots` (`src/quota/store.ts`); `QUOTA_PROVIDERS`, `PROVIDER_INFO`, `QuotaEntry` (`entry.ts`); `percent`, `untilReset`, `updatedAgo`, `elapsedFraction`, `tone`, `WARN_PERCENT` (`format.ts`); `AgentIcon` (`src/agents/AgentIcon.tsx`).
- Produces: `export function QuotaColumn(): JSX.Element` and `export const RefreshIcon` in `icons.tsx` (same `Icon` wrapper as the others; a circular-arrow path).

DOM contract the tests rely on:
- Column: `<section className="dash-col dash-col-quota" role="region" aria-label="Quota">`; head has title text `Quota` and `<button className="icon-btn dash-quota-refresh" aria-label="Refresh quota">` with class `spinning` added while any slot is `inFlight`.
- One `<li className="dash-quota-card">` per Provider in `QUOTA_PROVIDERS` order, containing `AgentIcon` and the display name.
- Window row `<div className="dash-quota-window tone-{tone}">`: label, `<span className="dash-quota-bar"><span className="fill" style={{width: pct%}}/><span className="tick" style={{left: frac%}}/></span>` (tick only when `elapsedFraction` is not null), percent text (bold class `strong` at ≥ `WARN_PERCENT`), and ` · <untilReset>` when not null.
- `notSignedIn` → `<p className="dash-quota-note">not signed in</p>`; `problem` → note `"<message>"` plus, when `last`, ` · <updatedAgo>` and the last windows wrapped in `<div className="dash-quota-stale">`; `loading` → name only.

- [ ] **Step 1: Write the failing tests**

`src/dashboard/QuotaColumn.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ quotaFetch: vi.fn() }));
import { quotaFetch } from "../lib/ipc";
import type { QuotaOutcome, QuotaProvider } from "../lib/types";
import { initialSlots, useQuota } from "../quota/store";
import { QuotaColumn } from "./QuotaColumn";

const fetchMock = vi.mocked(quotaFetch);
const card = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

describe("QuotaColumn", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useQuota.setState({ slots: initialSlots() });
  });

  it("shows every Provider with its state after fetching on mount", async () => {
    const now = Date.now();
    const outcomes: Record<QuotaProvider, QuotaOutcome> = {
      claude: { kind: "ok", fetchedAt: now, windows: [
        { label: "5h", usedPercent: 19, resetsAt: now + (3_600 + 36 * 60) * 1000 + 500, durationSecs: 18_000 },
        { label: "week", usedPercent: 95, resetsAt: null, durationSecs: null },
      ] },
      codex: { kind: "notSignedIn" },
      opencodeGo: { kind: "noSubscription" },
      grok: { kind: "signInExpired" },
    };
    fetchMock.mockImplementation(async (p) => outcomes[p]);
    render(<QuotaColumn />);
    const col = screen.getByRole("region", { name: "Quota" });
    await waitFor(() => expect(within(col).getByText("19%")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const names = within(col).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(names[0]).toContain("Claude");
    expect(names[1]).toContain("Codex");
    expect(names[2]).toContain("OpenCode Go");
    expect(names[3]).toContain("Grok");
    expect(within(card("Claude")).getByText(/1h36m/)).toBeTruthy();
    expect(within(card("Claude")).getByText("95%").className).toContain("strong");
    expect(within(card("Codex")).getByText("not signed in")).toBeTruthy();
    expect(within(card("OpenCode Go")).getByText("no Go subscription")).toBeTruthy();
    expect(within(card("Grok")).getByText("sign-in expired — run grok")).toBeTruthy();
  });

  it("keeps the last numbers dimmed when sign-in expires", async () => {
    const fetchedAt = Date.now() - 3 * 3_600_000;
    useQuota.setState((s) => ({ slots: { ...s.slots, grok: { ...s.slots.grok, entry: { kind: "ok", report: { fetchedAt, windows: [
      { label: "week", usedPercent: 100, resetsAt: null, durationSecs: null } ] } } } } }));
    fetchMock.mockImplementation(async (p) => (p === "grok" ? { kind: "signInExpired" } : { kind: "notSignedIn" }));
    render(<QuotaColumn />);
    await waitFor(() => expect(within(card("Grok")).getByText(/sign-in expired — run grok/)).toBeTruthy());
    expect(within(card("Grok")).getByText(/updated 3h ago/)).toBeTruthy();
    expect(within(card("Grok")).getByText("100%").closest(".dash-quota-stale")).toBeTruthy();
  });

  it("refreshes by hand", async () => {
    fetchMock.mockResolvedValue({ kind: "notSignedIn" });
    render(<QuotaColumn />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(useQuota.getState().slots.grok.inFlight).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh quota" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
  });
});
```

In `src/dashboard/AgentDashboard.test.tsx` add, directly below the existing imports' first line block (before importing the component):

```tsx
import { vi } from "vitest";
vi.mock("../lib/ipc", () => ({ quotaFetch: vi.fn().mockResolvedValue({ kind: "notSignedIn" }) }));
```

(merge `vi` into the existing `vitest` import instead of a second import line), and add this test inside `describe("AgentDashboard")`:

```tsx
  it("keeps the Quota column when search hides every agent", () => {
    render(<AgentDashboard />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "zzz-no-match" } });
    expect(screen.getByRole("region", { name: "Quota" })).toBeTruthy();
    expect(within(column(/needs you/i)).getByText("None")).toBeTruthy();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/dashboard`
Expected: FAIL (`./QuotaColumn` not found; no "Quota" region).

- [ ] **Step 3: Implement `QuotaColumn`, `RefreshIcon`, and mount it in `AgentDashboard`**

`QuotaColumn` effects: on mount `refresh("shown")`; `setInterval(() => refresh("tick"), 30_000)`; a `now` state updated by `setInterval(1_000)`; clear both on unmount. The Refresh button calls `refresh("manual")`. Cards are plain `<li>`s, not buttons.

- [ ] **Step 4: Styles in `src/styles.css`**

- `.dash-board`: `grid-template-columns: repeat(5, minmax(200px, 1fr));`
- `.dash-quota-refresh.spinning .icon { animation: spin 0.8s linear infinite; }` and `@keyframes spin { to { transform: rotate(360deg); } }` next to the other keyframes.
- `.dash-quota-card`: same surface as `.dash-card` (`--surface-2`, `--line-2` border, `--r-md`, padding `9px 10px`) without hover/cursor; head reuses the 18px `.agent-tile` sizing of `.dash-card-head`.
- `.dash-quota-window`: grid `auto 1fr auto`, gap 8px, font-size 12px, label in `--fg-3`.
- `.dash-quota-bar`: relative, height 4px, radius 2px, background `--line-2`; `.fill` absolute left, height 100%, background by tone (`tone-ok` → `var(--green)`, `tone-warn` → `var(--amber)`, `tone-muted` → `var(--fg-3)`); `.tick` absolute 1px × 8px, top -2px, background `var(--fg-2)`.
- `.strong { font-weight: 600; color: var(--fg); }` scoped under `.dash-quota-window`. Percent text never uses amber.
- `.dash-quota-note { margin: 0; color: var(--fg-3); font-size: 12px; }`; `.dash-quota-stale { opacity: 0.45; }`.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (existing dashboard tests included); no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard src/ui/icons.tsx src/styles.css
git commit -m "feat(dashboard): Quota column with per-Provider windows"
```

---

### Task 7: Verify in the running app

**Files:** none (fixes found here go in the task that owns the code, as a new commit).

- [ ] **Step 1: Full test suites**

Run: `npm test && npm run typecheck && (cd src-tauri && cargo test)`
Expected: all PASS.

- [ ] **Step 2: Launch the app and check by hand, with the user**

Run: `npm run tauri dev`

Check, and ask the user to confirm what the agent cannot see:
- Opening the dashboard shows the Quota column as the fifth column; all four Providers listed in order.
- Numbers match herdpet's Quota card for each signed-in Provider.
- Renaming `~/.grok/auth.json` then pressing Refresh shows "not signed in" for Grok; rename it back.
- With the dashboard closed for over 5 minutes, the app log (`~/Library/Logs/<bundle id>/`) has no new `quota ` lines; on reopen there are four.
- At a narrow window width the board scrolls horizontally rather than squashing columns below 200px.
- A macOS Keychain prompt, if shown on first fetch, is answered with "Always Allow" and does not recur.
