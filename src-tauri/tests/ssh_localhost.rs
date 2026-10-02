//! Needs Remote Login enabled and a real herdr. Run with
//! `HERDR_APP_SSH_TEST=1 cargo test --test ssh_localhost -- --ignored --test-threads=1`.
use herdr_app_lib::herdr::rpc;
use herdr_app_lib::transport::ssh::{master_alive, master_argv, master_exit, SshTransport};
use herdr_app_lib::transport::{exec, parse_session_list, probe_argv, Transport};
use serde_json::json;
use std::process::{Command, Stdio};
use std::time::Duration;

const HERDR: &str = "/opt/homebrew/bin/herdr";
const SESSION: &str = "herdrapp-test-ssh";

fn herdr(args: &[&str]) -> std::process::Output {
    Command::new(HERDR).args(args).stdin(Stdio::null()).output().unwrap()
}

/// Stops and deletes the test session, even when the test fails.
struct SessionGuard;
impl Drop for SessionGuard {
    fn drop(&mut self) {
        herdr(&["--session", SESSION, "server", "stop"]);
        herdr(&["session", "delete", SESSION]);
    }
}

#[tokio::test]
#[ignore]
async fn ssh_localhost_master_exec_and_forward() {
    if std::env::var("HERDR_APP_SSH_TEST").as_deref() != Ok("1") {
        eprintln!("HERDR_APP_SSH_TEST != 1; skipping");
        return;
    }
    let ssh = SshTransport::new("sshtest", "localhost").unwrap();
    let _ = std::fs::remove_file(&ssh.ctl);
    let argv = master_argv(&ssh.ctl, &ssh.target, true);
    let st = Command::new(&argv[0]).args(&argv[1..]).stdin(Stdio::null()).status().unwrap();
    assert!(st.success(), "ssh master failed to start");
    assert!(master_alive(&ssh.ctl, &ssh.target).await);

    let out = exec(&ssh, &probe_argv(None)).await.unwrap();
    assert!(out.stdout.contains("HOME="), "{}", out.stdout);

    let _guard = SessionGuard;
    Command::new(HERDR)
        .args(["--session", SESSION, "server"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn herdr server");
    let mut entry = None;
    for _ in 0..100 {
        let list = herdr(&["session", "list"]);
        let found = parse_session_list(&String::from_utf8_lossy(&list.stdout))
            .into_iter()
            .find(|s| s.name == SESSION);
        if let Some(e) = found {
            if rpc::call(std::path::Path::new(&e.socket), "session.snapshot", json!({})).await.is_ok() {
                entry = Some(e);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let entry = entry.expect("test session never became ready");

    let local = ssh.local_socket(&entry).await.unwrap();
    let snap = rpc::snapshot(&local).await;
    // A second call must reuse the live forward, not unlink it.
    let again = ssh.local_socket(&entry).await.unwrap();
    assert_eq!(again, local);
    let snap2 = rpc::snapshot(&again).await;
    ssh.release_socket(&entry).await.unwrap();
    master_exit(&ssh.ctl, &ssh.target).await;
    assert!(snap.is_ok(), "{snap:?}");
    assert!(snap2.is_ok(), "{snap2:?}");
}
