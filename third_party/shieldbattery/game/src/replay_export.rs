use std::env;

use crate::app_messages::ReplayExportConfig;
use crate::game_thread;

const DEFAULT_TARGET_MULTIPLIER: u32 = 128;

#[derive(Clone, Debug)]
pub struct Config {
    enabled: bool,
    target_multiplier: u32,
    disable_render: bool,
}

pub fn is_enabled() -> bool {
    config().enabled
}

pub fn target_multiplier() -> u32 {
    config().target_multiplier
}

pub fn disable_render() -> bool {
    config().disable_render
}

fn config() -> Config {
    let setup = game_thread::setup_info().and_then(|info| info.replay_export.as_ref());
    let enabled =
        env_bool("SB_REPLAY_EXPORT").unwrap_or_else(|| setup.map(|x| x.enabled).unwrap_or(false));
    let target_multiplier = env_u32("SB_REPLAY_EXPORT_SPEED").unwrap_or_else(|| {
        setup
            .and_then(|x| x.target_multiplier)
            .unwrap_or(DEFAULT_TARGET_MULTIPLIER)
    });
    let disable_render = env_bool("SB_REPLAY_EXPORT_DISABLE_RENDER")
        .unwrap_or_else(|| setup.and_then(|x| x.disable_render).unwrap_or(enabled));
    Config {
        enabled,
        target_multiplier: target_multiplier.max(1),
        disable_render,
    }
}

fn env_bool(key: &str) -> Option<bool> {
    let value = env::var(key).ok()?;
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn env_u32(key: &str) -> Option<u32> {
    env::var(key).ok().and_then(|x| x.parse::<u32>().ok())
}

#[allow(dead_code)]
fn _assert_replay_export_config_send_sync(_: &ReplayExportConfig) {}
