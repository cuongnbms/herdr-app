//! Per-session watcher: keeps a `SessionView` fresh from herdr's event stream.
use super::{
    model::{apply_status, pane_ids, session_view},
    rpc::{self, Subscription},
    types::{AgentStatus, AgentStatusChanged, EventFrame, Snapshot},
};
use crate::{
    error::{AppError, AppResult},
    view::SessionView,
};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, time::Duration};
use tokio::{
    sync::mpsc::UnboundedSender,
    task::JoinHandle,
    time::{timeout_at, Instant},
};

const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Debug)]
pub enum WatchEvent {
    View(SessionView),
    Status { pane_id: String, status: AgentStatus, previous: AgentStatus, title: String },
    Closed(AppError),
}

pub const STRUCTURAL: [&str; 13] = [
    "workspace.created", "workspace.updated", "workspace.closed", "workspace.renamed", "workspace.reordered",
    "tab.created", "tab.closed", "tab.renamed", "tab.moved",
    "pane.created", "pane.closed", "pane.exited", "pane.moved",
];

fn closed() -> AppError {
    AppError::new("io", "herdr session closed")
}

async fn subscribe_all(socket: &Path, snap: &Snapshot) -> AppResult<Subscription> {
    let mut subs: Vec<Value> = STRUCTURAL.iter().map(|t| json!({ "type": t })).collect();
    subs.extend(
        pane_ids(snap).into_iter().map(|id| json!({ "type": "pane.agent_status_changed", "pane_id": id })),
    );
    rpc::subscribe(socket, subs).await
}

/// Apply a status event to `snap`; send `View` then `Status` if it changed.
/// Returns `false` when the receiver is gone.
fn handle_status(name: &str, snap: &mut Snapshot, ev: &EventFrame, tx: &UnboundedSender<WatchEvent>) -> bool {
    let Ok(change) = serde_json::from_value::<AgentStatusChanged>(ev.data.clone()) else {
        tracing::warn!("ignoring malformed pane_agent_status_changed: {}", ev.data);
        return true;
    };
    let Some(previous) = apply_status(snap, &change) else { return true };
    let view = session_view(name, snap);
    let title = view
        .workspaces
        .iter()
        .flat_map(|w| &w.tabs)
        .flat_map(|t| &t.panes)
        .find(|p| p.pane_id == change.pane_id)
        .map(|p| p.title.clone())
        .unwrap_or_else(|| change.pane_id.clone());
    tx.send(WatchEvent::View(view)).is_ok()
        && tx
            .send(WatchEvent::Status { pane_id: change.pane_id, status: change.agent_status, previous, title })
            .is_ok()
}

/// Runs until the stream ends, a call fails, or the receiver is dropped (`None`).
async fn run(name: &str, socket: &Path, tx: &UnboundedSender<WatchEvent>) -> Option<AppError> {
    let mut snap = match rpc::snapshot(socket).await {
        Ok(s) => s,
        Err(e) => return Some(e),
    };
    if tx.send(WatchEvent::View(session_view(name, &snap))).is_err() {
        return None;
    }
    let mut sub = match subscribe_all(socket, &snap).await {
        Ok(s) => s,
        Err(e) => return Some(e),
    };
    loop {
        let Some(ev) = sub.rx.recv().await else { return Some(closed()) };
        if ev.event == "pane_agent_status_changed" {
            if !handle_status(name, &mut snap, &ev, tx) {
                return None;
            }
            continue;
        }
        // Structural event: absorb everything for a fixed window, then refetch once.
        let deadline = Instant::now() + DEBOUNCE;
        loop {
            match timeout_at(deadline, sub.rx.recv()).await {
                Err(_) => break,
                Ok(None) => return Some(closed()),
                Ok(Some(e)) if e.event == "pane_agent_status_changed" => {
                    if !handle_status(name, &mut snap, &e, tx) {
                        return None;
                    }
                }
                Ok(Some(_)) => {}
            }
        }
        let fresh = match rpc::snapshot(socket).await {
            Ok(s) => s,
            Err(e) => return Some(e),
        };
        if tx.send(WatchEvent::View(session_view(name, &fresh))).is_err() {
            return None;
        }
        let changed = pane_ids(&fresh) != pane_ids(&snap);
        snap = fresh;
        if changed {
            drop(sub);
            sub = match subscribe_all(socket, &snap).await {
                Ok(s) => s,
                Err(e) => return Some(e),
            };
        }
    }
}

/// Watch one session. Ends after sending `Closed`; the Machine manager owns retries.
pub fn spawn_watcher(name: String, socket: PathBuf, tx: UnboundedSender<WatchEvent>) -> JoinHandle<()> {
    tokio::spawn(async move {
        if let Some(err) = run(&name, &socket, &tx).await {
            let _ = tx.send(WatchEvent::Closed(err));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::{fake::FakeHerdr, types::AgentStatus};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use tokio::{sync::mpsc, time::{timeout, Duration}};

    fn fake_with(snap: Arc<Mutex<Value>>) -> FakeHerdr {
        FakeHerdr::start(Arc::new(move |m, _| match m {
            "session.snapshot" => Ok(json!({"type":"session_snapshot","snapshot": snap.lock().unwrap().clone()})),
            _ => Err(("unknown".into(), m.to_string())),
        }))
    }
    async fn next(rx: &mut mpsc::UnboundedReceiver<WatchEvent>) -> WatchEvent { timeout(Duration::from_secs(3), rx.recv()).await.unwrap().unwrap() }

    #[tokio::test]
    async fn emits_view_then_status_changes() {
        let snap = Arc::new(Mutex::new(serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json")).unwrap()));
        let f = fake_with(snap.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _h = spawn_watcher("default".into(), f.path.clone(), tx);
        assert!(matches!(next(&mut rx).await, WatchEvent::View(v) if v.workspaces.len() == 2));
        tokio::time::sleep(Duration::from_millis(100)).await; // let subscribe land
        let subs = f.calls.lock().unwrap().iter().find(|(m, _)| m == "events.subscribe").unwrap().1.clone();
        assert!(subs["subscriptions"].as_array().unwrap().contains(&json!({"type":"pane.agent_status_changed","pane_id":"w2:p1"})));
        f.emit("pane_agent_status_changed", json!({"pane_id":"w2:p1","workspace_id":"w2","agent_status":"done"}));
        assert!(matches!(next(&mut rx).await, WatchEvent::View(v) if v.workspaces[1].status == AgentStatus::Done));
        match next(&mut rx).await {
            WatchEvent::Status { pane_id, status, previous, .. } => assert_eq!((pane_id.as_str(), status, previous), ("w2:p1", AgentStatus::Done, AgentStatus::Idle)),
            other => panic!("{other:?}"),
        }
    }
    #[tokio::test]
    async fn structural_events_refetch_once_and_resubscribe() {
        let snap = Arc::new(Mutex::new(serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json")).unwrap()));
        let f = fake_with(snap.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _h = spawn_watcher("default".into(), f.path.clone(), tx);
        next(&mut rx).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        snap.lock().unwrap()["panes"].as_array_mut().unwrap().push(json!({"pane_id":"w2:p3","tab_id":"w2:t1","workspace_id":"w2","terminal_id":"term_e","agent_status":"idle"}));
        f.emit("pane_created", json!({"pane_id":"w2:p3"}));
        f.emit("layout_updated", json!({}));
        assert!(matches!(next(&mut rx).await, WatchEvent::View(v) if v.workspaces[1].tabs[0].panes.len() == 2));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(f.calls_of("session.snapshot"), 2, "two events within 150 ms → one refetch");
        assert_eq!(f.calls_of("events.subscribe"), 2, "pane set changed → resubscribe");
    }
    #[tokio::test]
    async fn watcher_reports_closed_when_socket_closes() {
        let snap = Arc::new(Mutex::new(serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json")).unwrap()));
        let f = fake_with(snap);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let h = spawn_watcher("default".into(), f.path.clone(), tx);
        next(&mut rx).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        f.close_subscriptions();
        assert!(matches!(next(&mut rx).await, WatchEvent::Closed(e) if e.code == "io"));
        timeout(Duration::from_secs(1), h).await.unwrap().unwrap();
    }
}
