//! Completion candidates for the Chat lens composer, read on the Pane's Machine.
pub mod commands;
pub mod files;
pub use commands::{list_commands, SlashCommand};
pub use files::list_files;
