pub mod catalog;
pub mod config;
mod control;
pub mod daemon_log;
mod fsutil;
pub mod lifecycle;
pub mod model;
pub mod security;
pub mod server;
mod streaming;
pub mod targets;
mod transfer;
pub mod validation;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
