// Outgoing webhooks for automations: "when Claude asks permission, ping my
// phone" through a service the user already uses (ntfy, Discord, Slack, or any
// JSON endpoint).
//
// The URLs are secrets (anyone holding a Discord or Slack webhook URL can post
// to it), so they live in the OS vault like every other key: the webviews can
// save or clear one, and ask whether it exists — never read it back. Only
// https is accepted. Nothing is sent except by a rule the user created.

use std::time::Duration;

use crate::secrets;

pub const SLOTS: &[&str] = &["webhook-1", "webhook-2", "webhook-3"];
const MAX_TEXT: usize = 1800;

#[derive(Debug, PartialEq)]
pub enum Kind {
    Ntfy,
    Discord,
    Slack,
    Json,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ntfy" => Some(Kind::Ntfy),
            "discord" => Some(Kind::Discord),
            "slack" => Some(Kind::Slack),
            "json" => Some(Kind::Json),
            _ => None,
        }
    }
}

/// Only https, and nothing that would smuggle credentials into a log line.
pub fn valid_url(url: &str) -> bool {
    url.starts_with("https://") && url.len() <= 2048 && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn clip(text: &str) -> String {
    let mut out: String = text.chars().take(MAX_TEXT).collect();
    if text.chars().count() > MAX_TEXT {
        out.push('…');
    }
    out
}

/// Request body and content type, per the services' documented formats:
/// ntfy takes the message as a plain-text body; Discord webhooks take
/// `{"content": …}`; Slack incoming webhooks take `{"text": …}`.
pub fn body(kind: &Kind, text: &str) -> (&'static str, String) {
    let text = clip(text);
    match kind {
        Kind::Ntfy => ("text/plain; charset=utf-8", text),
        Kind::Discord => ("application/json", serde_json::json!({ "content": text }).to_string()),
        Kind::Slack => ("application/json", serde_json::json!({ "text": text }).to_string()),
        Kind::Json => ("application/json", serde_json::json!({ "source": "coucou", "text": text }).to_string()),
    }
}

/// Posts `text` to the webhook saved in `slot`. Errors never contain the URL.
pub async fn send(slot: &str, kind: &str, text: &str) -> Result<u16, String> {
    if !SLOTS.contains(&slot) {
        return Err("Unknown webhook.".into());
    }
    let kind = Kind::parse(kind).ok_or("Unknown webhook kind.")?;
    let url = secrets::get(slot).ok_or("No address saved for this webhook.")?;
    if !valid_url(&url) {
        return Err("The saved address isn't an https:// URL.".into());
    }
    let (content_type, payload) = body(&kind, text);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Could not start a network client.".to_string())?;
    let res = client
        .post(&url)
        .header("content-type", content_type)
        .body(payload)
        .send()
        .await
        .map_err(|_| "Couldn't reach the webhook.".to_string())?;
    let status = res.status().as_u16();
    if (200..300).contains(&status) {
        Ok(status)
    } else {
        Err(format!("The webhook answered {status}."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_urls() {
        assert!(valid_url("https://ntfy.sh/my-topic"));
        assert!(!valid_url("http://ntfy.sh/my-topic"));
        assert!(!valid_url("file:///etc/passwd"));
        assert!(!valid_url("https://x.y/a b"));
        assert!(!valid_url("javascript:alert(1)"));
    }

    #[test]
    fn bodies_match_each_service() {
        assert_eq!(body(&Kind::Ntfy, "hi"), ("text/plain; charset=utf-8", "hi".into()));
        assert_eq!(body(&Kind::Discord, "hi").1, r#"{"content":"hi"}"#);
        assert_eq!(body(&Kind::Slack, "hi").1, r#"{"text":"hi"}"#);
        assert!(body(&Kind::Json, "hi").1.contains(r#""source":"coucou""#));
    }

    #[test]
    fn long_messages_are_clipped() {
        let long = "x".repeat(5000);
        let (_, b) = body(&Kind::Ntfy, &long);
        assert_eq!(b.chars().count(), MAX_TEXT + 1);
    }

    #[test]
    fn unknown_kinds_are_refused() {
        assert_eq!(Kind::parse("smtp"), None);
    }
}
