//! Sidebar layout file (Groups and Bookmarks). The UI owns its shape; this side only stores the JSON.
use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct LayoutStore {
    path: PathBuf,
    write: Mutex<()>,
}

impl LayoutStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write: Mutex::new(()),
        }
    }

    /// `None` when the file is missing or corrupt (corruption is logged).
    pub fn load(&self) -> Option<Value> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("cannot read {}: {e}", self.path.display());
                }
                return None;
            }
        };
        serde_json::from_str(&text)
            .map_err(|e| tracing::error!("corrupt sidebar layout {}: {e}", self.path.display()))
            .ok()
    }

    /// Write to a temp file next to the layout, then rename over it.
    pub fn save(&self, layout: &Value) -> AppResult<()> {
        let json =
            serde_json::to_string_pretty(layout).map_err(|e| AppError::new("io", e.to_string()))?;
        let _guard = self.write.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_file_loads_as_none() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(LayoutStore::new(d.path().join("l.json")).load(), None);
    }

    #[test]
    fn round_trips() {
        let d = tempfile::tempdir().unwrap();
        let s = LayoutStore::new(d.path().join("l.json"));
        let l = json!({"tree": [{"kind": "session", "key": "local/x"}], "bookmarks": ["local/x"]});
        s.save(&l).unwrap();
        assert_eq!(s.load(), Some(l));
        assert!(!d.path().join("l.json.tmp").exists());
    }

    #[test]
    fn corrupt_file_loads_as_none() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("l.json");
        std::fs::write(&p, "{nope").unwrap();
        assert_eq!(LayoutStore::new(p).load(), None);
    }
}
