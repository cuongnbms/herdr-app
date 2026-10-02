use std::collections::HashMap;

use crate::herdr::types::{AgentInfo, AgentStatus, AgentStatusChanged, Snapshot};
use crate::view::{PaneView, SessionView, TabView, WorkspaceView};

/// Build the sidebar tree for a live session. Workspaces and tabs are sorted by
/// `number`, panes keep snapshot order, and every level's status is the rollup of
/// its children. Panes whose tab is missing are dropped.
pub fn session_view(name: &str, snap: &Snapshot) -> SessionView {
    let agents: HashMap<&str, &AgentInfo> =
        snap.agents.iter().map(|a| (a.pane_id.as_str(), a)).collect();

    let mut workspaces: Vec<WorkspaceView> = snap
        .workspaces
        .iter()
        .map(|w| {
            let mut tab_infos: Vec<_> = snap
                .tabs
                .iter()
                .filter(|t| t.workspace_id == w.workspace_id)
                .collect();
            tab_infos.sort_by_key(|t| t.number);
            let tabs: Vec<TabView> = tab_infos
                .into_iter()
                .map(|t| {
                    let panes: Vec<PaneView> = snap
                        .panes
                        .iter()
                        .filter(|p| p.tab_id == t.tab_id)
                        .map(|p| {
                            let agent = agents.get(p.pane_id.as_str()).and_then(|a| a.agent.clone());
                            let title = [&p.label, &p.terminal_title_stripped]
                                .into_iter()
                                .find_map(|s| s.clone().filter(|s| !s.is_empty()))
                                .or_else(|| agent.clone())
                                .unwrap_or_else(|| p.pane_id.clone());
                            PaneView {
                                pane_id: p.pane_id.clone(),
                                terminal_id: p.terminal_id.clone(),
                                title,
                                cwd: p.cwd.clone(),
                                agent,
                                status: p.agent_status,
                            }
                        })
                        .collect();
                    TabView {
                        tab_id: t.tab_id.clone(),
                        label: t.label.clone(),
                        number: t.number,
                        status: AgentStatus::rollup(panes.iter().map(|p| p.status)),
                        panes,
                    }
                })
                .collect();
            WorkspaceView {
                workspace_id: w.workspace_id.clone(),
                label: w.label.clone(),
                number: w.number,
                status: AgentStatus::rollup(tabs.iter().map(|t| t.status)),
                tabs,
            }
        })
        .collect();
    workspaces.sort_by_key(|w| w.number);

    SessionView {
        name: name.to_string(),
        running: true,
        status: AgentStatus::rollup(workspaces.iter().map(|w| w.status)),
        error: None,
        workspaces,
    }
}

/// Apply a `pane_agent_status_changed` event. Returns the pane's previous status
/// when it changed; `None` when unchanged or the pane is unknown.
pub fn apply_status(snap: &mut Snapshot, ev: &AgentStatusChanged) -> Option<AgentStatus> {
    let pane = snap.panes.iter_mut().find(|p| p.pane_id == ev.pane_id)?;
    let previous = pane.agent_status;
    pane.agent_status = ev.agent_status;

    match snap.agents.iter_mut().find(|a| a.pane_id == ev.pane_id) {
        Some(a) => {
            a.agent_status = ev.agent_status;
            if ev.agent.is_some() {
                a.agent = ev.agent.clone();
            }
        }
        None if ev.agent.is_some() => snap.agents.push(AgentInfo {
            pane_id: ev.pane_id.clone(),
            agent: ev.agent.clone(),
            agent_status: ev.agent_status,
        }),
        None => {}
    }

    (previous != ev.agent_status).then_some(previous)
}

/// All pane ids in the snapshot, sorted.
pub fn pane_ids(snap: &Snapshot) -> Vec<String> {
    let mut ids: Vec<String> = snap.panes.iter().map(|p| p.pane_id.clone()).collect();
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::types::*;
    fn fixture() -> Snapshot { serde_json::from_str(include_str!("../../tests/fixtures/snapshot.json")).unwrap() }

    #[test]
    fn builds_tree_with_rollups() {
        let v = session_view("default", &fixture());
        assert_eq!(v.name, "default");
        assert!(v.running);
        assert_eq!(v.status, AgentStatus::Blocked);
        assert_eq!(v.workspaces.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(), ["herdr-app", "api"]);
        let w1 = &v.workspaces[0];
        assert_eq!(w1.status, AgentStatus::Blocked);
        assert_eq!(w1.tabs[0].panes[0].title, "Rewrite");
        assert_eq!(w1.tabs[0].panes[0].agent.as_deref(), Some("claude"));
        assert_eq!(w1.tabs[0].panes[1].title, "pi");
        let w2 = &v.workspaces[1];
        assert_eq!(w2.tabs.iter().map(|t| t.label.as_str()).collect::<Vec<_>>(), ["1", "logs"]);
        assert_eq!(w2.tabs[1].panes[0].title, "w2:p2");
        assert_eq!(w2.status, AgentStatus::Idle);
    }
    #[test]
    fn pane_label_wins_over_terminal_title() {
        let mut s = fixture();
        s.panes[0].label = Some("my pane".into());
        s.panes[1].label = Some(String::new());
        let v = session_view("default", &s);
        assert_eq!(v.workspaces[0].tabs[0].panes[0].title, "my pane");
        assert_eq!(v.workspaces[0].tabs[0].panes[1].title, "pi", "an empty label falls back");
    }
    #[test]
    fn applies_status_changes() {
        let mut s = fixture();
        let ev = AgentStatusChanged { pane_id: "w2:p1".into(), agent_status: AgentStatus::Working, agent: Some("claude".into()) };
        assert_eq!(apply_status(&mut s, &ev), Some(AgentStatus::Idle));
        assert_eq!(apply_status(&mut s, &ev), None);
        let v = session_view("default", &s);
        assert_eq!(v.workspaces[1].tabs[0].panes[0].agent.as_deref(), Some("claude"));
        assert_eq!(v.workspaces[1].status, AgentStatus::Working);
        let unknown = AgentStatusChanged { pane_id: "w9:p9".into(), agent_status: AgentStatus::Done, agent: None };
        assert_eq!(apply_status(&mut s, &unknown), None);
    }
}
