//! Read-only file browsing on a Machine: scripts run over the transport, never writing.

pub mod all;
pub mod list;
pub mod paths;
pub mod read;

pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub const BINARY_SNIFF_BYTES: usize = 8192;
pub const MAX_LIST_FILES: usize = 50_000;
pub const MAX_CHANGED: usize = 200;
pub const MAX_DIR_ENTRIES: usize = 5000;
