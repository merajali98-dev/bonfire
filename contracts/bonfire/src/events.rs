use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "bonfire";
pub const VERSION: &str = "1.0.0";

/// Emit a NEP-297 event: `EVENT_JSON:{"standard":"bonfire","version":"1.0.0","event":..,"data":[..]}`.
pub fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}
