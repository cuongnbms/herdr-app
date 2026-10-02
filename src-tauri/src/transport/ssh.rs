use super::local::LocalTransport;
use super::{exec, runtime_dir, secure_runtime_dir, sh_quote, socket_name, SessionEntry, Transport};
use crate::error::{AppError, AppResult};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

/// Runs herdr on a remote Machine through one shared ssh ControlMaster connection.
pub struct SshTransport {
    pub machine_id: String,
    pub target: String,
    pub ctl: PathBuf,
}

impl SshTransport {
    /// Builds the transport, securing the runtime dir that holds the control socket.
    pub fn new(machine_id: &str, target: &str) -> AppResult<SshTransport> {
        let ctl = secure_runtime_dir()?.join(format!("{machine_id}.ctl"));
        Ok(SshTransport { machine_id: machine_id.into(), target: target.into(), ctl })
    }

    /// `ssh -S ctl -O <op> -L <local>:<remote> target`; the -L spec is one literal argv element.
    fn forward_argv(&self, op: &str, local: &Path, session: &SessionEntry) -> Vec<String> {
        vec![
            "ssh".into(),
            "-S".into(),
            self.ctl.to_string_lossy().into_owned(),
            "-O".into(),
            op.into(),
            "-L".into(),
            format!("{}:{}", local.display(), session.socket),
            self.target.clone(),
        ]
    }
}

/// `ssh -S ctl -o BatchMode=yes [-tt] target '<quoted argv>'`; the remote command is one argument.
pub fn ssh_wrap(ctl: &Path, target: &str, argv: &[String], tty: bool) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "ssh".into(),
        "-S".into(),
        ctl.to_string_lossy().into_owned(),
        "-o".into(),
        "BatchMode=yes".into(),
    ];
    if tty {
        v.push("-tt".into());
    }
    v.push(target.into());
    v.push(argv.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" "));
    v
}

#[async_trait]
impl Transport for SshTransport {
    fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
        ssh_wrap(&self.ctl, &self.target, argv, tty)
    }

    async fn local_socket(&self, session: &SessionEntry) -> AppResult<PathBuf> {
        let local = secure_runtime_dir()?.join(socket_name(&self.machine_id, &session.name));
        match std::fs::remove_file(&local) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let out = exec(&LocalTransport, &self.forward_argv("forward", &local, session)).await?;
        if out.status != 0 {
            return Err(classify_ssh_error(&out.stderr));
        }
        Ok(local)
    }

    async fn release_socket(&self, session: &SessionEntry) -> AppResult<()> {
        let local = runtime_dir().join(socket_name(&self.machine_id, &session.name));
        let out = exec(&LocalTransport, &self.forward_argv("cancel", &local, session)).await;
        // The socket file must not outlive the release, whatever ssh said.
        let _ = std::fs::remove_file(&local);
        let out = out?;
        if out.status != 0 {
            return Err(classify_ssh_error(&out.stderr));
        }
        Ok(())
    }
}

/// `ssh -M -S ctl -o ControlPersist=yes [-o BatchMode=yes] -f -N target`.
pub fn master_argv(ctl: &Path, target: &str, batch: bool) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "ssh".into(),
        "-M".into(),
        "-S".into(),
        ctl.to_string_lossy().into_owned(),
        "-o".into(),
        "ControlPersist=yes".into(),
    ];
    if batch {
        v.push("-o".into());
        v.push("BatchMode=yes".into());
    }
    v.extend(["-f".into(), "-N".into(), target.into()]);
    v
}

fn control_argv(ctl: &Path, target: &str, op: &str) -> Vec<String> {
    vec!["ssh".into(), "-S".into(), ctl.to_string_lossy().into_owned(), "-O".into(), op.into(), target.into()]
}

/// True when the ControlMaster for `ctl` is running (`ssh -O check` exits 0).
pub async fn master_alive(ctl: &Path, target: &str) -> bool {
    matches!(exec(&LocalTransport, &control_argv(ctl, target, "check")).await, Ok(o) if o.status == 0)
}

/// Ask the ControlMaster to exit; errors are ignored.
pub async fn master_exit(ctl: &Path, target: &str) {
    let _ = exec(&LocalTransport, &control_argv(ctl, target, "exit")).await;
}

pub fn classify_ssh_error(stderr: &str) -> AppError {
    if stderr.contains("Permission denied") || stderr.contains("Host key verification failed") || stderr.contains("passphrase") {
        return AppError::new("ssh_auth", stderr.trim());
    }
    if stderr.contains("administratively prohibited") || stderr.contains("open failed") {
        return AppError::new("ssh_forward_denied", "the remote sshd refuses Unix socket forwarding (AllowStreamLocalForwarding)");
    }
    let last = stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("ssh failed");
    AppError::new("io", last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    #[test]
    fn wraps_with_quoting() {
        let argv: Vec<String> = ["tail", "-n", "+1", "-F", "/home/u/.claude/projects/-x/it's a file.jsonl"].iter().map(|s| s.to_string()).collect();
        let w = ssh_wrap(Path::new("/tmp/herdr-app-501/devtuf.ctl"), "devtuf", &argv, false);
        assert_eq!(w[..6], ["ssh", "-S", "/tmp/herdr-app-501/devtuf.ctl", "-o", "BatchMode=yes", "devtuf"]);
        assert_eq!(w.len(), 7);
        assert_eq!(w[6], "'tail' '-n' '+1' '-F' '/home/u/.claude/projects/-x/it'\\''s a file.jsonl'");
        let t = ssh_wrap(Path::new("/c"), "u@h", &["herdr".into()], true);
        assert!(t.contains(&"-tt".to_string()));
    }
    #[test]
    fn master_argv_batch_and_interactive() {
        let b = master_argv(Path::new("/c"), "devtuf", true);
        assert_eq!(b, ["ssh", "-M", "-S", "/c", "-o", "ControlPersist=yes", "-o", "BatchMode=yes", "-f", "-N", "devtuf"]);
        assert!(!master_argv(Path::new("/c"), "devtuf", false).contains(&"BatchMode=yes".to_string()));
    }
    #[test]
    fn classifies_errors() {
        assert_eq!(classify_ssh_error("u@h: Permission denied (publickey).").code, "ssh_auth");
        assert_eq!(classify_ssh_error("Host key verification failed.").code, "ssh_auth");
        let f = classify_ssh_error("channel 2: open failed: administratively prohibited: open failed");
        assert_eq!(f.code, "ssh_forward_denied");
        assert!(f.message.contains("AllowStreamLocalForwarding"));
        assert_eq!(classify_ssh_error("boom\nssh: connect to host x port 22: Connection refused").message, "ssh: connect to host x port 22: Connection refused");
    }
}
