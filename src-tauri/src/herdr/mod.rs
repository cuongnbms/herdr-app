pub mod codec;
pub mod types;

/// The herdr wire protocol version this app speaks. Anything else is `incompatible`.
pub const REQUIRED_PROTOCOL: u32 = 22;
