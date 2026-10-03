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
    exec_input(t, argv, None).await
}

/// `exec`, feeding `input` to the command's stdin (then closing it) when given.
pub async fn exec_input(
    t: &dyn Transport,
    argv: &[String],
    input: Option<&[u8]>,
) -> AppResult<ExecOutput> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let wrapped = t.wrap(argv, false);
    let program = wrapped
        .first()
        .ok_or_else(|| AppError::new("invalid", "empty command"))?;
    let mut child = Command::new(program)
        .args(&wrapped[1..])
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let run = async {
        if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
            // A command that exits early closes the pipe; its exit status tells why.
            if let Err(e) = stdin.write_all(bytes).await {
                tracing::debug!("exec stdin write: {e}");
            }
        }
        child.wait_with_output().await
    };
    match tokio::time::timeout(EXEC_TIMEOUT, run).await {
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

pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

/// Writes stdin to `<dir>/<name>` (dir: `$2`, else `$TMPDIR`, else /tmp), owner-only and
/// never over an existing file, then prints the path.
const SAVE_IMAGE_SCRIPT: &str = r#"d="${2:-${TMPDIR:-/tmp}}"
f="${d%/}/$1"
umask 077
set -C
cat > "$f" && printf '%s\n' "$f""#;

/// Save a pasted image on the Machine (over ssh for a remote one, so the agent there can
/// read it) and return its path there. `dir` overrides the temp directory (tests).
pub async fn save_image_in(
    t: &dyn Transport,
    bytes: &[u8],
    ext: &str,
    dir: Option<&str>,
) -> AppResult<String> {
    let ext = ext.to_ascii_lowercase();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(AppError::new(
            "invalid",
            format!("unsupported image type: {ext}"),
        ));
    }
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::new(
            "invalid",
            format!(
                "image must be 1 byte to {} MB",
                MAX_IMAGE_BYTES / (1024 * 1024)
            ),
        ));
    }
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = format!("herdr-paste-{nanos}-{}-{seq}.{ext}", std::process::id());
    let argv: Vec<String> = vec![
        "sh".into(),
        "-c".into(),
        SAVE_IMAGE_SCRIPT.into(),
        "sh".into(),
        name,
        dir.unwrap_or("").into(),
    ];
    let out = exec_input(t, &argv, Some(bytes)).await?;
    let path = out.stdout.trim();
    if out.status != 0 || path.is_empty() {
        return Err(AppError::new(
            "io",
            format!("saving the image failed: {}", out.stderr.trim()),
        ));
    }
    Ok(path.to_string())
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

/// Prints each directory argument that holds no herdr server state.
const CLIENT_ONLY_SCRIPT: &str = r#"for d; do
  [ -e "$d/session.json" ] || [ -e "$d/herdr-server.log" ] || [ -e "$d/herdr.sock" ] || printf '%s\n' "$d"
done"#;

/// Drop stopped sessions whose directory holds only client files. `herdr --remote <target>
/// --session <name>` creates such a directory on this side, and `herdr session list` then
/// reports it as a stopped local session; starting it would launch an empty local server.
/// On a failed check the list is returned unchanged.
pub async fn drop_client_only(t: &dyn Transport, list: Vec<SessionEntry>) -> Vec<SessionEntry> {
    let dir = |s: &SessionEntry| {
        let socket = std::path::Path::new(&s.socket);
        socket.parent().map(|p| p.to_string_lossy().into_owned())
    };
    let dirs: Vec<String> = list
        .iter()
        .filter(|s| !s.running && s.name != "default")
        .filter_map(dir)
        .collect();
    if dirs.is_empty() {
        return list;
    }
    let mut argv = vec![
        "sh".into(),
        "-c".into(),
        CLIENT_ONLY_SCRIPT.into(),
        "sh".into(),
    ];
    argv.extend(dirs);
    let client_only: Vec<String> = match exec(t, &argv).await {
        Ok(out) if out.status == 0 => out.stdout.lines().map(str::to_string).collect(),
        _ => return list,
    };
    list.into_iter()
        .filter(|s| {
            s.running || s.name == "default" || !dir(s).is_some_and(|d| client_only.contains(&d))
        })
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

fn not_private(dir: &std::path::Path, why: impl std::fmt::Display) -> AppError {
    AppError::new(
        "io",
        format!(
            "{} is not a private directory owned by this user: {why}",
            dir.display()
        ),
    )
}

/// Confirm `dir` is a real directory (not a symlink), owned by us, with mode 0700.
fn verify_private_dir(dir: &std::path::Path) -> AppResult<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let md = std::fs::symlink_metadata(dir)?;
    if md.file_type().is_symlink() || !md.is_dir() {
        return Err(not_private(dir, "not a real directory"));
    }
    let uid = unsafe { libc::getuid() };
    if md.uid() != uid {
        return Err(not_private(dir, format!("owned by uid {}", md.uid())));
    }
    let mode = md.permissions().mode() & 0o777;
    if mode != 0o700 {
        return Err(not_private(dir, format!("mode is {mode:o}")));
    }
    Ok(())
}

/// Create `dir` (mode 0700) and verify it. Refuses a symlink or non-directory before any
/// chmod, so a planted link can never redirect the permission change to its target.
fn secure_dir(dir: &std::path::Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    let md = std::fs::symlink_metadata(dir)?;
    if md.file_type().is_symlink() || !md.is_dir() {
        return Err(not_private(dir, "not a real directory"));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    verify_private_dir(dir)
}

/// Create (mode 0700) and verify `/tmp/herdr-app-<uid>`, holding ssh control sockets and
/// forwarded herdr sockets. Every caller must go through this; there is no unverified path.
pub fn secure_runtime_dir() -> AppResult<PathBuf> {
    let dir = runtime_dir_path();
    secure_dir(&dir)?;
    Ok(dir)
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
        let p = runtime_dir_path().join(socket_name("devtuf-machine-x", long));
        assert!(p.as_os_str().len() <= 104, "{}", p.display());
        assert_ne!(socket_name("m", "a"), socket_name("m", "b"));
    }
    #[test]
    fn secure_dir_refuses_a_symlink_without_touching_its_target() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = d.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(secure_dir(&link).unwrap_err().code, "io");
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }
    #[test]
    fn secure_dir_creates_a_private_dir_and_tightens_a_loose_one() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("rt");
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        secure_dir(&p).unwrap();
        assert_eq!(mode(&p), 0o700);
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        secure_dir(&p).unwrap();
        assert_eq!(mode(&p), 0o700);
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

    #[tokio::test]
    async fn saves_image_bytes_through_stdin_as_a_private_temp_file() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().to_string_lossy().into_owned();
        let bytes: Vec<u8> = (0..=255u8).cycle().take(300_000).collect();
        let path = save_image_in(&local::LocalTransport, &bytes, "png", Some(&dir))
            .await
            .unwrap();
        assert!(path.starts_with(&dir), "{path}");
        assert!(path.ends_with(".png"), "{path}");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let again = save_image_in(&local::LocalTransport, &bytes, "png", Some(&dir))
            .await
            .unwrap();
        assert_ne!(path, again);
    }

    #[tokio::test]
    async fn rejects_unknown_image_types_and_oversized_images() {
        let t = local::LocalTransport;
        let err = save_image_in(&t, b"x", "sh", None).await.unwrap_err();
        assert_eq!(err.code, "invalid");
        let big = vec![0u8; MAX_IMAGE_BYTES + 1];
        let err = save_image_in(&t, &big, "png", None).await.unwrap_err();
        assert_eq!(err.code, "invalid");
        let err = save_image_in(&t, b"", "png", None).await.unwrap_err();
        assert_eq!(err.code, "invalid");
    }

    #[tokio::test]
    async fn drops_stopped_sessions_that_only_hold_a_client_log() {
        let d = tempfile::tempdir().unwrap();
        let mk = |name: &str, files: &[&str]| {
            let dir = d.path().join(name);
            std::fs::create_dir(&dir).unwrap();
            for f in files {
                std::fs::write(dir.join(f), "").unwrap();
            }
            dir.join("herdr.sock").to_string_lossy().into_owned()
        };
        let entry = |name: &str, running: bool, socket: String| SessionEntry {
            name: name.into(),
            running,
            socket,
        };
        let list = vec![
            entry("default", false, mk("default", &[])),
            entry("live", true, mk("live", &["herdr-client.log"])),
            // `herdr --remote <target> --session ai-radar` leaves only a client log.
            entry("ai-radar", false, mk("ai radar", &["herdr-client.log"])),
            entry(
                "saved",
                false,
                mk("saved", &["herdr-client.log", "session.json"]),
            ),
            entry("ran", false, mk("ran", &["herdr-server.log"])),
        ];
        let names = |l: Vec<SessionEntry>| l.into_iter().map(|s| s.name).collect::<Vec<_>>();
        assert_eq!(
            names(drop_client_only(&local::LocalTransport, list).await),
            ["default", "live", "saved", "ran"]
        );
    }
}
