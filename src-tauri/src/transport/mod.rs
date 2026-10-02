pub mod local;
pub mod ssh;

use crate::error::{AppError, AppResult};
use crate::herdr::REQUIRED_PROTOCOL;
use async_trait::async_trait;
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

const EXEC_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MachineInfo {
    pub home: String,
    pub herdr: String,
    pub pi_dir: String,
    pub version: String,
    pub protocol: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionEntry {
    pub name: String,
    pub running: bool,
    pub socket: String,
}

pub struct ExecOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

#[async_trait]
pub trait Transport: Send + Sync {
    /// Wrap an argv so it runs on the Machine (`tty` requests a pseudo-terminal).
    fn wrap(&self, argv: &[String], tty: bool) -> Vec<String>;
    /// A local Unix socket path that reaches the session's herdr socket.
    async fn local_socket(&self, session: &SessionEntry) -> AppResult<PathBuf>;
    async fn release_socket(&self, session: &SessionEntry) -> AppResult<()>;
}

/// Run `argv` on the Machine with stdin closed, capturing output, 30 s timeout.
pub async fn exec(t: &dyn Transport, argv: &[String]) -> AppResult<ExecOutput> {
    let wrapped = t.wrap(argv, false);
    let program = wrapped
        .first()
        .ok_or_else(|| AppError::new("invalid", "empty command"))?;
    let child = Command::new(program)
        .args(&wrapped[1..])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    match tokio::time::timeout(EXEC_TIMEOUT, child.wait_with_output()).await {
        Ok(out) => {
            let out = out?;
            Ok(ExecOutput {
                status: out.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            })
        }
        // Dropping the future drops the child, which kills it (kill_on_drop).
        Err(_) => Err(AppError::new(
            "timeout",
            format!("{program} took longer than {}s", EXEC_TIMEOUT.as_secs()),
        )),
    }
}

/// POSIX single-quote `s` for use in a shell command line.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `[info.herdr, "--session", session, ...args]`; the `default` session gets no flag.
pub fn herdr_argv(info: &MachineInfo, session: &str, args: &[&str]) -> Vec<String> {
    let mut v = vec![info.herdr.clone()];
    if session != "default" {
        v.push("--session".into());
        v.push(session.into());
    }
    v.extend(args.iter().map(|a| a.to_string()));
    v
}

pub const PROBE_SCRIPT: &str = r#"H="$1"
[ -n "$H" ] || H=$("${SHELL:-sh}" -lc 'command -v herdr' 2>/dev/null | tail -n 1)
case "$H" in /*) ;; *) H=$("${SHELL:-sh}" -ic 'command -v herdr' 2>/dev/null </dev/null | tail -n 1) ;; esac
case "$H" in /*) ;; *) H="" ;; esac
for c in "$HOME/.local/bin/herdr" "$HOME/.cargo/bin/herdr" /opt/homebrew/bin/herdr /usr/local/bin/herdr; do
  [ -n "$H" ] && break; [ -x "$c" ] && H="$c"
done
echo "HOME=$HOME"
echo "HERDR=$H"
if [ -n "$PI_CODING_AGENT_SESSION_DIR" ]; then echo "PI_DIR=$PI_CODING_AGENT_SESSION_DIR"
elif [ -n "$PI_CODING_AGENT_DIR" ]; then echo "PI_DIR=$PI_CODING_AGENT_DIR/sessions"
else echo "PI_DIR=$HOME/.pi/agent/sessions"; fi
[ -n "$H" ] || exit 0
echo "VERSION=$("$H" --version 2>/dev/null | sed 's/^herdr //')"
echo "PROTOCOL=$("$H" api schema 2>/dev/null | sed -n 's/^protocol: //p')"
"#;

pub fn probe_argv(herdr_override: Option<&str>) -> Vec<String> {
    vec![
        "sh".into(),
        "-c".into(),
        PROBE_SCRIPT.into(),
        "probe".into(),
        herdr_override.unwrap_or("").into(),
    ]
}

pub fn parse_probe(stdout: &str) -> AppResult<MachineInfo> {
    let field = |key: &str| -> String {
        let prefix = format!("{key}=");
        stdout
            .lines()
            .find_map(|l| l.strip_prefix(prefix.as_str()))
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let herdr = field("HERDR");
    if herdr.is_empty() {
        return Err(AppError::new(
            "herdr_not_found",
            "herdr was not found on this machine",
        ));
    }
    let version = field("VERSION");
    let protocol = field("PROTOCOL").parse::<u32>().ok();
    match protocol {
        Some(p) if p == REQUIRED_PROTOCOL => Ok(MachineInfo {
            home: field("HOME"),
            herdr,
            pi_dir: field("PI_DIR"),
            version,
            protocol: p,
        }),
        other => Err(AppError::new(
            "incompatible",
            format!(
                "herdr {version}, protocol {}; need protocol {REQUIRED_PROTOCOL}",
                other.map_or_else(|| "unknown".to_string(), |p| p.to_string())
            ),
        )),
    }
}

/// Parse `herdr session list` output: a header line, then `name status directory socket` rows.
/// Directory and socket may contain spaces, and a long directory overflows its column, so
/// the socket is found as: the part after a whitespace run that starts with the directory
/// plus `/` (herdr keeps the socket inside the session directory), else the text at the
/// header's `socket` column when it starts a field there, else the last token.
pub fn parse_session_list(stdout: &str) -> Vec<SessionEntry> {
    let mut lines = stdout.lines();
    let socket_col = lines.next().and_then(|h| h.find("socket"));
    lines
        .filter_map(|l| parse_session_row(l, socket_col))
        .collect()
}

/// The first whitespace-separated token of `s` and the rest after it.
fn split_token(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    let end = s.find(char::is_whitespace)?;
    Some((&s[..end], &s[end..]))
}

fn parse_session_row(line: &str, socket_col: Option<usize>) -> Option<SessionEntry> {
    let (name, rest) = split_token(line)?;
    let (status, rest) = split_token(rest)?;
    let rest = rest.trim();
    if !rest.contains(char::is_whitespace) {
        return None; // no directory + socket pair
    }
    let socket = socket_under_directory(rest)
        .or_else(|| socket_at_column(line, socket_col?))
        .or_else(|| rest.split_whitespace().last())?;
    Some(SessionEntry {
        name: name.to_string(),
        running: status == "running",
        socket: socket.to_string(),
    })
}

fn socket_under_directory(rest: &str) -> Option<&str> {
    let mut prev_ws = false;
    for (i, c) in rest.char_indices() {
        let ws = c.is_whitespace();
        if ws && !prev_ws {
            let (dir, right) = (&rest[..i], rest[i..].trim_start());
            if right.strip_prefix(dir).is_some_and(|r| r.starts_with('/')) {
                return Some(right);
            }
        }
        prev_ws = ws;
    }
    None
}

fn socket_at_column(line: &str, col: usize) -> Option<&str> {
    if col == 0 || col >= line.len() || !line.is_char_boundary(col) {
        return None;
    }
    let (before, at) = line.split_at(col);
    let starts_field =
        before.ends_with(char::is_whitespace) && !at.starts_with(char::is_whitespace);
    starts_field.then(|| at.trim_end())
}

fn runtime_dir_path() -> PathBuf {
    PathBuf::from(format!("/tmp/herdr-app-{}", unsafe { libc::getuid() }))
}

/// Confirm `dir` is a real directory (not a symlink), owned by us, with mode 0700.
fn verify_private_dir(dir: &std::path::Path) -> AppResult<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let fail = |why: String| {
        AppError::new(
            "io",
            format!(
                "{} is not a private directory owned by this user: {why}",
                dir.display()
            ),
        )
    };
    let md = std::fs::symlink_metadata(dir)?;
    if md.file_type().is_symlink() || !md.is_dir() {
        return Err(fail("not a real directory".into()));
    }
    let uid = unsafe { libc::getuid() };
    if md.uid() != uid {
        return Err(fail(format!("owned by uid {}", md.uid())));
    }
    let mode = md.permissions().mode() & 0o777;
    if mode != 0o700 {
        return Err(fail(format!("mode is {mode:o}")));
    }
    Ok(())
}

/// Create (mode 0700) and verify `/tmp/herdr-app-<uid>`, holding ssh control sockets and
/// forwarded herdr sockets. Call before creating sockets in it.
pub fn secure_runtime_dir() -> AppResult<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let dir = runtime_dir_path();
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    verify_private_dir(&dir)?;
    Ok(dir)
}

/// The runtime dir path; logs (but does not fail) if it cannot be secured.
pub fn runtime_dir() -> PathBuf {
    match secure_runtime_dir() {
        Ok(dir) => dir,
        Err(e) => {
            tracing::error!("runtime dir is not secure: {e}");
            runtime_dir_path()
        }
    }
}

fn fnv1a32(s: &str) -> u32 {
    s.bytes().fold(0x811c_9dc5u32, |h, b| {
        (h ^ b as u32).wrapping_mul(0x0100_0193)
    })
}

pub fn socket_name(machine_id: &str, session: &str) -> String {
    format!("{machine_id}-{:08x}.sock", fnv1a32(session))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn info() -> MachineInfo {
        MachineInfo {
            home: "/home/u".into(),
            herdr: "/home/u/.local/bin/herdr".into(),
            pi_dir: "/home/u/.pi/agent/sessions".into(),
            version: "0.9.3".into(),
            protocol: 22,
        }
    }

    #[test]
    fn quotes_for_posix_shells() {
        assert_eq!(sh_quote("abc"), "'abc'");
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote(""), "''");
    }
    #[test]
    fn herdr_argv_omits_default_session() {
        assert_eq!(
            herdr_argv(&info(), "default", &["api", "schema"]),
            vec!["/home/u/.local/bin/herdr", "api", "schema"]
        );
        assert_eq!(
            herdr_argv(&info(), "ai-radar", &["server"]),
            vec![
                "/home/u/.local/bin/herdr",
                "--session",
                "ai-radar",
                "server"
            ]
        );
    }
    #[test]
    fn parses_probe_output() {
        let out = "HOME=/home/u\nHERDR=/home/u/.local/bin/herdr\nPI_DIR=/home/u/.pi/agent/sessions\nVERSION=0.9.3\nPROTOCOL=22\n";
        assert_eq!(parse_probe(out).unwrap(), info());
    }
    #[test]
    fn probe_errors() {
        assert_eq!(
            parse_probe("HOME=/h\nHERDR=\nPI_DIR=/h/.pi/agent/sessions\n")
                .unwrap_err()
                .code,
            "herdr_not_found"
        );
        let e = parse_probe("HOME=/h\nHERDR=/h/herdr\nPI_DIR=/p\nVERSION=0.8.0\nPROTOCOL=19\n")
            .unwrap_err();
        assert_eq!(e.code, "incompatible");
        assert_eq!(e.message, "herdr 0.8.0, protocol 19; need protocol 22");
    }
    #[test]
    fn parses_session_list() {
        let out = "name                 status   directory                                        socket\n\
default              running  /Users/me/.config/herdr                     /Users/me/.config/herdr/herdr.sock\n\
agent-workspace      stopped  /Users/me/.config/herdr/sessions/agent-workspace /Users/me/.config/herdr/sessions/agent-workspace/herdr.sock\n";
        assert_eq!(
            parse_session_list(out),
            vec![
                SessionEntry {
                    name: "default".into(),
                    running: true,
                    socket: "/Users/me/.config/herdr/herdr.sock".into()
                },
                SessionEntry {
                    name: "agent-workspace".into(),
                    running: false,
                    socket: "/Users/me/.config/herdr/sessions/agent-workspace/herdr.sock".into()
                },
            ]
        );
    }
    #[test]
    fn parses_session_list_with_spaces_in_paths() {
        let out = "name                 status   directory                                        socket\n\
work                 running  /Users/me/My Projects/herdr                      /Users/me/My Projects/herdr/herdr.sock\n\
long                 stopped  /Users/me/My Projects/herdr/sessions/a long name /Users/me/My Projects/herdr/sessions/a long name/herdr.sock\n\
moved                running  /srv/a b                                         /run/x y/herdr.sock\n\
odd                  stopped  /a b /c/d.sock\n\
broken               running  /only-one-path\n";
        assert_eq!(
            parse_session_list(out),
            vec![
                SessionEntry {
                    name: "work".into(),
                    running: true,
                    socket: "/Users/me/My Projects/herdr/herdr.sock".into()
                },
                SessionEntry {
                    name: "long".into(),
                    running: false,
                    socket: "/Users/me/My Projects/herdr/sessions/a long name/herdr.sock".into()
                },
                // Socket outside the directory: located by the header's socket column.
                SessionEntry {
                    name: "moved".into(),
                    running: true,
                    socket: "/run/x y/herdr.sock".into()
                },
                // Neither rule applies: the last token.
                SessionEntry {
                    name: "odd".into(),
                    running: false,
                    socket: "/c/d.sock".into()
                },
            ]
        );
    }
    #[test]
    fn socket_name_is_short() {
        let long = "a-very-long-session-name-that-goes-on-and-on-and-on-forever-and-ever";
        let p = runtime_dir().join(socket_name("devtuf-machine-x", long));
        assert!(p.as_os_str().len() <= 104, "{}", p.display());
        assert_ne!(socket_name("m", "a"), socket_name("m", "b"));
    }
    #[test]
    fn secure_runtime_dir_ok() {
        assert!(secure_runtime_dir().is_ok());
    }
    #[test]
    fn verify_rejects_loose_mode() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(verify_private_dir(d.path()).unwrap_err().code, "io");
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(verify_private_dir(d.path()).is_ok());
    }
    #[tokio::test]
    async fn local_exec_runs_probe() {
        let out = exec(&local::LocalTransport, &probe_argv(None))
            .await
            .unwrap();
        assert_eq!(out.status, 0);
        assert!(out.stdout.contains("HOME="), "{}", out.stdout);
    }
}
