pub mod catalog;
pub mod config;
mod fsutil;
pub mod lifecycle;
pub mod model;
pub mod server;
pub mod targets;
pub mod validation;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
