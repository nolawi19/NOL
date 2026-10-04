// Integration pollers — the Rust side of StripePoller / GithubPoller /
// VercelPoller / N8nPoller / ResendPoller / NotionPoller / CalcomPoller.
//
// Same endpoints, same first-run delays and intervals as the Swift pollers. Each
// one emits an `integration` event; the island owns the badge, the sound and the
// 60 s auto-clear, exactly as the Swift handlers do.
//
// Nothing is polled until its key exists in the Credential Manager, and no
// request goes anywhere the user has not configured.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::log;
use crate::secrets;

const TIMEOUT: Duration = Duration::from_secs(10);

/// What the island receives. `event` is only set when something actually changed,
/// which is what drives the pill badge and the sound.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationUpdate {
    pub id: &'static str,
    pub data: Value,
    pub error: Option<String>,
    pub event: Option<IntegrationEvent>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationEvent {
    pub success: bool,
    pub label: String,
    pub detail: Option<String>,
}

fn emit(app: &AppHandle, update: IntegrationUpdate) {
    let _ = app.emit_to(WINDOW_LABEL, "integration", update);
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// Set from the tray's Pause item. While it is on, nothing reaches the network:
/// pausing Coucou has to mean pausing Coucou, not just hiding the island.
pub static PAUSED: AtomicBool = AtomicBool::new(false);

pub fn set_paused(on: bool) {
    PAUSED.store(on, Ordering::Relaxed);
}

/// Spawns every poller with the macOS delays and intervals.
pub fn start(app: AppHandle) {
    spawn(app.clone(), "integration_n8n", 3, 15, poll_n8n);
    spawn(app.clone(), "integration_vercel", 5, 30, poll_vercel);
    spawn(app.clone(), "integration_stripe", 6, 30, poll_stripe);
    spawn(app.clone(), "integration_resend", 6, 60, poll_resend);
    spawn(app.clone(), "integration_github", 7, 300, poll_github);
    spawn(app.clone(), "integration_calcom", 8, 300, poll_calcom);
    spawn(app.clone(), "integration_notion", 9, 300, poll_notion);
    spawn(app.clone(), "integration_sentry", 10, 120, poll_sentry);
    spawn(app.clone(), "integration_linear", 11, 300, poll_linear);
    spawn(app, "integration_jira", 12, 300, poll_jira);
}

/// True when the user has this integration switched on in settings.
fn enabled(app: &AppHandle, id: &str) -> bool {
    app.try_state::<crate::Shared>()
        .map(|shared| {
            let settings = shared.settings.lock().unwrap();
            settings.active_integrations.iter().any(|x| x == id)
        })
        .unwrap_or(false)
}

fn spawn<F, Fut>(app: AppHandle, id: &'static str, delay_secs: u64, every_secs: u64, poll: F)
where
    F: Fn(AppHandle) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(delay_secs)).await;
        let mut ticker = tokio::time::interval(Duration::from_secs(every_secs));
        loop {
            ticker.tick().await;
            // The ticker keeps its cadence; we just decline to do the work. An
            // integration the user switched off, or a paused app, must make no
            // network calls at all — CLAUDE.md allows talking only to services
            // the user configured, and a disabled one is not configured.
            if PAUSED.load(Ordering::Relaxed) || !enabled(&app, id) {
                continue;
            }
            poll(app.clone()).await;
        }
    });
}

/// One-shot refresh from the Refresh buttons in the island.
pub async fn poll_once(app: AppHandle, id: &str) {
    match id {
        "integration_stripe" => poll_stripe(app).await,
        "integration_github" => poll_github(app).await,
        "integration_vercel" => poll_vercel(app).await,
        "integration_n8n" => poll_n8n(app).await,
        "integration_resend" => poll_resend(app).await,
        "integration_notion" => poll_notion(app).await,
        "integration_calcom" => poll_calcom(app).await,
        "integration_sentry" => poll_sentry(app).await,
        "integration_linear" => poll_linear(app).await,
        "integration_jira" => poll_jira(app).await,
        _ => {}
    }
}

/// Remembers the newest id per integration so an event fires once, not on every poll.
struct Seen(Mutex<std::collections::HashMap<String, String>>);

static SEEN: std::sync::LazyLock<Seen> =
    std::sync::LazyLock::new(|| Seen(Mutex::new(std::collections::HashMap::new())));

/// Returns true the first time a given id is seen (and false on the very first
/// load, which only fills the card).
fn is_new(key: &str, id: &str) -> bool {
    let mut map = SEEN.0.lock().unwrap();
    match map.insert(key.to_string(), id.to_string()) {
        Some(previous) => previous != id,
        None => false, // first poll: populate silently, like the Swift pollers
    }
}

fn status_error(code: u16, unauthorised_hint: &str) -> String {
    match code {
        401 => "Invalid API key (401)".into(),
        403 => unauthorised_hint.into(),
        _ => format!("API error {code}"),
    }
}

// ── Stripe ────────────────────────────────────────────────────────────────────

async fn poll_stripe(app: AppHandle) {
    let Some(key) = secrets::get("stripe-api-key") else { return };
    let auth = format!("Basic {}", crate::claude::base64_for(format!("{key}:").as_bytes()));
    let http = client();

    let balance = http
        .get("https://api.stripe.com/v1/balance")
        .header("Authorization", &auth)
        .send()
        .await;

    let (amount, currency) = match balance {
        Ok(r) if r.status().is_success() => {
            let json: Value = r.json().await.unwrap_or(json!({}));
            let mut buckets: Vec<Value> = Vec::new();
            for k in ["available", "pending"] {
                if let Some(arr) = json.get(k).and_then(Value::as_array) {
                    buckets.extend(arr.iter().cloned());
                }
            }
            let currency = buckets
                .first()
                .and_then(|b| b.get("currency"))
                .and_then(Value::as_str)
                .unwrap_or("eur")
                .to_string();
            let amount: i64 = buckets
                .iter()
                .filter_map(|b| b.get("amount").and_then(Value::as_i64))
                .sum();
            (amount, currency)
        }
        Ok(r) => {
            let code = r.status().as_u16();
            emit(&app, IntegrationUpdate {
                id: "integration_stripe",
                data: json!({}),
                error: Some(status_error(code, "Use a secret key (sk_live_… not pk_live_…)")),
                event: None,
            });
            return;
        }
        Err(e) => {
            emit(&app, IntegrationUpdate {
                id: "integration_stripe",
                data: json!({}),
                error: Some(format!("No connection: {e}")),
                event: None,
            });
            return;
        }
    };

    let charges = http
        .get("https://api.stripe.com/v1/charges?limit=3")
        .header("Authorization", &auth)
        .send()
        .await;
    let Ok(response) = charges else { return };
    if !response.status().is_success() {
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let payments: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|c| {
                    let description = c
                        .get("description")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            c.get("billing_details")
                                .and_then(|b| b.get("name"))
                                .and_then(Value::as_str)
                        })
                        .map(str::to_string);
                    Some(json!({
                        "id": c.get("id")?.as_str()?,
                        "amount": c.get("amount")?.as_i64()?,
                        "currency": c.get("currency")?.as_str()?,
                        "description": description,
                        "createdAt": c.get("created").and_then(Value::as_i64).unwrap_or(0) * 1000,
                        "status": c.get("status").and_then(Value::as_str).unwrap_or("succeeded"),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let newest = payments
        .first()
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let event = if !newest.is_empty() && is_new("stripe", &newest) {
        let label = payments[0]
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let cents = payments[0].get("amount").and_then(Value::as_i64).unwrap_or(0);
                format!("{:.2}", cents as f64 / 100.0)
            });
        Some(IntegrationEvent { success: true, label, detail: None })
    } else {
        None
    };

    emit(&app, IntegrationUpdate {
        id: "integration_stripe",
        data: json!({ "balance": amount, "currency": currency, "payments": payments }),
        error: None,
        event,
    });
}

// ── GitHub ────────────────────────────────────────────────────────────────────

async fn poll_github(app: AppHandle) {
    let Some(token) = secrets::get("github-token") else { return };
    let http = client();

    let user = http
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Coucou")
        .send()
        .await;
    let Ok(response) = user else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_github",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Token lacks the needed scope")),
            event: None,
        });
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let public = json.get("public_repos").and_then(Value::as_i64).unwrap_or(0);
    let private = json
        .get("owned_private_repos")
        .or_else(|| json.get("total_private_repos"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let repos = http
        .get("https://api.github.com/user/repos?per_page=100&affiliation=owner&sort=pushed")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Coucou")
        .send()
        .await;
    let repo_list: Vec<Value> = match repos {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default(),
        _ => vec![],
    };
    let stars: i64 = repo_list
        .iter()
        .filter_map(|r| r.get("stargazers_count").and_then(Value::as_i64))
        .sum();

    // GitHub Actions: the latest workflow run of the five most recently pushed
    // repositories. Needs Actions read access on the token; without it the
    // list is just empty.
    let mut runs = Vec::new();
    let mut event = None;
    for repo in repo_list.iter().take(5) {
        let Some(full) = repo.get("full_name").and_then(Value::as_str) else { continue };
        let url = format!("https://api.github.com/repos/{full}/actions/runs?per_page=1");
        let resp = http
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "Coucou")
            .send()
            .await;
        let Ok(resp) = resp else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let v: Value = resp.json().await.unwrap_or(json!({}));
        let Some(run) = v.get("workflow_runs").and_then(Value::as_array).and_then(|a| a.first()) else { continue };
        let s = |k: &str| run.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let run_id = run.get("id").map(|x| x.to_string()).unwrap_or_default();
        let conclusion = s("conclusion");
        // One event per finished run, the first time it's seen finished.
        // Every finished run is marked seen; the first new one becomes the event.
        let fresh = !conclusion.is_empty() && is_new(&format!("gh-run-{full}"), &format!("{run_id}:{conclusion}"));
        if fresh && event.is_none() {
            let ok = conclusion == "success";
            event = Some(IntegrationEvent {
                success: ok,
                label: if ok { "Workflow passed".into() } else { format!("Workflow {conclusion}") },
                detail: Some(format!("{} · {}", repo.get("name").and_then(Value::as_str).unwrap_or(full), s("name"))),
            });
        }
        runs.push(json!({
            "repo": repo.get("name").and_then(Value::as_str).unwrap_or(full),
            "name": s("name"),
            "status": s("status"),
            "conclusion": conclusion,
            "branch": s("head_branch"),
            "url": s("html_url"),
            "updatedAt": s("updated_at"),
        }));
    }

    emit(&app, IntegrationUpdate {
        id: "integration_github",
        data: json!({ "totalRepos": public + private, "totalStars": stars, "runs": runs }),
        error: None,
        event,
    });
}

// ── Vercel ────────────────────────────────────────────────────────────────────

async fn poll_vercel(app: AppHandle) {
    let Some(token) = secrets::get("vercel-token") else { return };
    let response = client()
        .get("https://api.vercel.com/v6/deployments?limit=5")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_vercel",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Token lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let terminal = ["READY", "ERROR", "CANCELED"];
    let deployments: Vec<Value> = json
        .get("deployments")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|d| {
                    let state = d.get("state")?.as_str()?;
                    if !terminal.contains(&state) {
                        return None;
                    }
                    let meta = d.get("meta");
                    let pick = |keys: [&str; 3]| {
                        meta.and_then(|m| keys.iter().find_map(|k| m.get(*k).and_then(Value::as_str)))
                            .map(str::to_string)
                    };
                    Some(json!({
                        "id": d.get("uid")?.as_str()?,
                        "projectName": d.get("name")?.as_str()?,
                        "url": d.get("url").and_then(Value::as_str).unwrap_or(""),
                        "state": state,
                        "createdAt": d.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0),
                        "commitMessage": pick(["githubCommitMessage", "gitlabCommitMessage", "bitbucketCommitMessage"]),
                        "branch": pick(["githubCommitRef", "gitlabCommitRef", "bitbucketBranch"]),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let event = deployments.first().and_then(|latest| {
        let id = latest.get("id")?.as_str()?;
        if !is_new("vercel", id) {
            return None;
        }
        let success = latest.get("state")?.as_str()? == "READY";
        Some(IntegrationEvent {
            success,
            label: latest.get("projectName")?.as_str()?.to_string(),
            detail: None,
        })
    });

    emit(&app, IntegrationUpdate {
        id: "integration_vercel",
        data: json!({ "deployments": deployments }),
        error: None,
        event,
    });
}

// ── Resend ────────────────────────────────────────────────────────────────────

async fn poll_resend(app: AppHandle) {
    let Some(key) = secrets::get("resend-api-key") else { return };
    let response = client()
        .get("https://api.resend.com/emails?limit=100")
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_resend",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Key lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let total = json
        .get("total")
        .or_else(|| json.get("count"))
        .and_then(Value::as_i64);
    let emails: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(5)
                .filter_map(|e| {
                    let to = match e.get("to") {
                        Some(Value::Array(a)) => a.clone(),
                        Some(Value::String(s)) => vec![Value::String(s.clone())],
                        _ => vec![],
                    };
                    Some(json!({
                        "id": e.get("id")?.as_str()?,
                        "to": to,
                        "subject": e.get("subject").and_then(Value::as_str).unwrap_or(""),
                        "createdAt": e.get("created_at").and_then(Value::as_str).unwrap_or(""),
                        "lastEvent": e.get("last_event").and_then(Value::as_str).unwrap_or(""),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    emit(&app, IntegrationUpdate {
        id: "integration_resend",
        data: json!({ "emails": emails, "total": total }),
        error: None,
        event: None,
    });
}

// ── Notion ────────────────────────────────────────────────────────────────────

async fn poll_notion(app: AppHandle) {
    let Some(token) = secrets::get("notion-api-key") else { return };
    let response = client()
        .post("https://api.notion.com/v1/search")
        .header("Authorization", format!("Bearer {token}"))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json")
        .json(&json!({
            "sort": { "direction": "descending", "timestamp": "last_edited_time" },
            "page_size": 3
        }))
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_notion",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Integration lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let pages: Vec<Value> = json
        .get("results")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_notion_page).collect())
        .unwrap_or_default();

    emit(&app, IntegrationUpdate {
        id: "integration_notion",
        data: json!({ "pages": pages }),
        error: None,
        event: None,
    });
}

fn parse_notion_page(obj: &Value) -> Option<Value> {
    let id = obj.get("id")?.as_str()?;
    let is_database = obj.get("object").and_then(Value::as_str) == Some("database");

    let mut title = "Untitled".to_string();
    if is_database {
        if let Some(text) = obj
            .get("title")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|t| t.get("plain_text"))
            .and_then(Value::as_str)
        {
            if !text.is_empty() {
                title = text.to_string();
            }
        }
    } else if let Some(props) = obj.get("properties").and_then(Value::as_object) {
        for prop in props.values() {
            if prop.get("type").and_then(Value::as_str) != Some("title") {
                continue;
            }
            if let Some(text) = prop
                .get("title")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|t| t.get("plain_text"))
                .and_then(Value::as_str)
            {
                if !text.is_empty() {
                    title = text.to_string();
                    break;
                }
            }
        }
    }

    let emoji = obj
        .get("icon")
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("emoji"))
        .and_then(|i| i.get("emoji"))
        .and_then(Value::as_str);

    Some(json!({
        "id": id,
        "title": title,
        "emoji": emoji,
        "lastEditedAt": obj.get("last_edited_time").and_then(Value::as_str)?,
        "url": obj.get("url").and_then(Value::as_str).unwrap_or("https://notion.so"),
    }))
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

async fn poll_calcom(app: AppHandle) {
    let Some(key) = secrets::get("calcom-api-key") else { return };
    let response = client()
        .get("https://api.cal.com/v2/bookings?status=upcoming")
        .header("Authorization", format!("Bearer {key}"))
        .header("cal-api-version", "2024-08-13")
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_calcom",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Key lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let bookings: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|b| {
                    let start = b
                        .get("start")
                        .or_else(|| b.get("startTime"))
                        .and_then(Value::as_str)?;
                    let attendee = b.get("attendees").and_then(Value::as_array).and_then(|a| a.first());
                    let notes = b
                        .get("responses")
                        .and_then(|r| r.get("notes"))
                        .and_then(|n| n.get("value"))
                        .and_then(Value::as_str)
                        .or_else(|| b.get("description").and_then(Value::as_str))
                        .filter(|s| !s.is_empty());
                    Some(json!({
                        "id": b.get("id").map(|v| v.to_string()).unwrap_or_default(),
                        "title": b.get("title").and_then(Value::as_str).unwrap_or("Meeting"),
                        "start": start,
                        "status": b.get("status").and_then(Value::as_str).unwrap_or("accepted"),
                        "attendeeName": attendee.and_then(|a| a.get("name")).and_then(Value::as_str),
                        "attendeeEmail": attendee.and_then(|a| a.get("email")).and_then(Value::as_str),
                        "attendeeNotes": notes,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    emit(&app, IntegrationUpdate {
        id: "integration_calcom",
        data: json!({ "bookings": bookings }),
        error: None,
        event: None,
    });
}

// ── n8n ───────────────────────────────────────────────────────────────────────

async fn poll_n8n(app: AppHandle) {
    let (Some(key), Some(raw_base)) = (secrets::get("n8n-api-key"), secrets::get("n8n-url")) else {
        return;
    };
    let base = raw_base.trim_end_matches('/').to_string();
    let http = client();

    // Same two shapes as the Swift poller: the public API first, then /rest.
    let list_urls = [
        format!("{base}/api/v1/executions?limit=1&includeData=false"),
        format!("{base}/rest/executions?limit=1&includeData=false"),
    ];

    let mut items: Option<Vec<Value>> = None;
    for url in &list_urls {
        let Ok(response) = http.get(url).header("X-N8N-API-KEY", &key).header("Accept", "application/json").send().await
        else {
            continue;
        };
        if !response.status().is_success() {
            // Only the status: a self-hosted base URL can carry credentials.
            log::line(format!("n8n list HTTP {}", response.status()));
            continue;
        }
        let Ok(json) = response.json::<Value>().await else { continue };
        items = match &json {
            Value::Object(o) => o.get("data").and_then(Value::as_array).cloned(),
            Value::Array(a) => Some(a.clone()),
            _ => None,
        };
        if items.is_some() {
            break;
        }
    }

    let Some(first) = items.and_then(|list| list.into_iter().next()) else { return };
    let id = match first.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return,
    };

    let status = first.get("status").and_then(Value::as_str).unwrap_or("");
    if !["success", "error", "crashed", "canceled", "failed"].contains(&status) {
        return;
    }
    if !is_new("n8n", &id) {
        return;
    }
    let success = status == "success";

    let detail_urls = [
        format!("{base}/api/v1/executions/{id}?includeData=true"),
        format!("{base}/api/v1/executions/{id}"),
        format!("{base}/rest/executions/{id}?includeData=true"),
        format!("{base}/rest/executions/{id}"),
    ];
    let mut name = "Workflow".to_string();
    let mut detail = None;
    for url in &detail_urls {
        let Ok(response) = http.get(url).header("X-N8N-API-KEY", &key).header("Accept", "application/json").send().await
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(json) = response.json::<Value>().await else { continue };
        name = json
            .get("workflowData")
            .and_then(|w| w.get("name"))
            .and_then(Value::as_str)
            .or_else(|| json.get("name").and_then(Value::as_str))
            .unwrap_or("Workflow")
            .to_string();
        detail = n8n_detail(&json, success);
        break;
    }

    log::line(format!("n8n execution {id} {status} · {name}"));
    emit(&app, IntegrationUpdate {
        id: "integration_n8n",
        data: json!({ "workflow": name, "status": status }),
        error: None,
        event: Some(IntegrationEvent { success, label: name, detail }),
    });
}

fn n8n_detail(json: &Value, success: bool) -> Option<String> {
    let result = json.get("data")?.get("resultData")?;
    if !success {
        if let Some(error) = result.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("");
            if let Some(node) = error.get("node").and_then(|n| n.get("name")).and_then(Value::as_str) {
                if !node.is_empty() {
                    return Some(format!("{node}\n{message}"));
                }
            }
            return Some(message.to_string());
        }
        let runs = result.get("runData")?.as_object()?;
        for (node, value) in runs {
            if let Some(message) = value
                .as_array()
                .and_then(|a| a.first())
                .and_then(|r| r.get("error"))
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
            {
                return Some(format!("{node}\n{message}"));
            }
        }
        return None;
    }

    let last_node = result.get("lastNodeExecuted")?.as_str()?;
    let items = result
        .get("runData")?
        .get(last_node)?
        .as_array()?
        .first()?
        .get("data")?
        .get("main")?
        .as_array()?
        .first()?
        .as_array()?;
    let count = items.len();
    let header = format!("→ {last_node} · {count} item{}", if count == 1 { "" } else { "s" });

    let fields = items
        .first()
        .and_then(|i| i.get("json"))
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .take(4)
                .map(|(k, v)| format!("{k}: {}", fmt_value(v)))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|s| !s.is_empty());

    Some(match fields {
        Some(f) => format!("{header}\n{f}"),
        None => header,
    })
}

fn fmt_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.chars().take(50).collect(),
        Value::Array(a) => format!("[{}]", a.len()),
        Value::Object(_) => "{…}".into(),
        other => other.to_string(),
    }
}

// ── Sentry ────────────────────────────────────────────────────────────────────

/// A host or slug safe to put into a URL path: letters, digits, dots, dashes.
pub fn safe_slug(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

async fn poll_sentry(app: AppHandle) {
    let Some(token) = secrets::get("sentry-token") else { return };
    let Some(org) = secrets::get("sentry-org") else { return };
    let org = org.trim().to_string();
    if !safe_slug(&org) {
        emit(&app, IntegrationUpdate { id: "integration_sentry", data: json!({}), error: Some("Organization slug looks wrong".into()), event: None });
        return;
    }
    let response = client()
        .get(format!("https://sentry.io/api/0/organizations/{org}/issues/"))
        .query(&[("query", "is:unresolved"), ("statsPeriod", "24h"), ("limit", "5"), ("sort", "date")])
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_sentry",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Token needs event:read")),
            event: None,
        });
        return;
    }
    let list: Vec<Value> = response.json::<Value>().await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let issues: Vec<Value> = list
        .iter()
        .map(|i| {
            let s = |k: &str| i.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            json!({
                "id": s("id"),
                "title": s("title"),
                "culprit": s("culprit"),
                "level": s("level"),
                "count": s("count"),
                "lastSeen": s("lastSeen"),
                "url": s("permalink"),
                "project": i.get("project").and_then(|p| p.get("slug")).and_then(Value::as_str).unwrap_or(""),
            })
        })
        .collect();
    let event = issues.first().and_then(|first| {
        let id = first.get("id").and_then(Value::as_str).unwrap_or("");
        is_new("sentry", id).then(|| IntegrationEvent {
            success: false,
            label: "New Sentry issue".into(),
            detail: first.get("title").and_then(Value::as_str).map(|t| t.chars().take(80).collect()),
        })
    });
    emit(&app, IntegrationUpdate { id: "integration_sentry", data: json!({ "issues": issues }), error: None, event });
}

// ── Linear ────────────────────────────────────────────────────────────────────

async fn poll_linear(app: AppHandle) {
    let Some(key) = secrets::get("linear-api-key") else { return };
    let query = r#"{ viewer { assignedIssues(first: 6, orderBy: updatedAt, filter: { state: { type: { in: ["started", "unstarted"] } } }) { nodes { identifier title url priority state { name type } } } } }"#;
    let response = client()
        .post("https://api.linear.app/graphql")
        .header("Authorization", key)
        .json(&json!({ "query": query }))
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_linear",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Key lacks read access")),
            event: None,
        });
        return;
    }
    let v: Value = response.json().await.unwrap_or(json!({}));
    let nodes = v.pointer("/data/viewer/assignedIssues/nodes").and_then(Value::as_array).cloned().unwrap_or_default();
    let issues: Vec<Value> = nodes
        .iter()
        .map(|n| {
            json!({
                "key": n.get("identifier").and_then(Value::as_str).unwrap_or(""),
                "title": n.get("title").and_then(Value::as_str).unwrap_or(""),
                "url": n.get("url").and_then(Value::as_str).unwrap_or(""),
                "state": n.pointer("/state/name").and_then(Value::as_str).unwrap_or(""),
                "started": n.pointer("/state/type").and_then(Value::as_str) == Some("started"),
                "priority": n.get("priority").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect();
    emit(&app, IntegrationUpdate { id: "integration_linear", data: json!({ "issues": issues }), error: None, event: None });
}

// ── Jira ──────────────────────────────────────────────────────────────────────

async fn poll_jira(app: AppHandle) {
    let (Some(site), Some(email), Some(token)) = (secrets::get("jira-site"), secrets::get("jira-email"), secrets::get("jira-token")) else {
        return;
    };
    let site = site.trim().trim_start_matches("https://").trim_end_matches('/').to_string();
    if !safe_slug(&site) || !site.contains('.') {
        emit(&app, IntegrationUpdate { id: "integration_jira", data: json!({}), error: Some("Site should look like yourteam.atlassian.net".into()), event: None });
        return;
    }
    let response = client()
        .get(format!("https://{site}/rest/api/3/search/jql"))
        .query(&[
            ("jql", "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"),
            ("maxResults", "6"),
            ("fields", "summary,status,priority"),
        ])
        .basic_auth(email.trim(), Some(token.trim()))
        .header("Accept", "application/json")
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_jira",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Account lacks access")),
            event: None,
        });
        return;
    }
    let v: Value = response.json().await.unwrap_or(json!({}));
    let issues: Vec<Value> = v
        .get("issues")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|i| {
                    let key = i.get("key").and_then(Value::as_str).unwrap_or("");
                    json!({
                        "key": key,
                        "title": i.pointer("/fields/summary").and_then(Value::as_str).unwrap_or(""),
                        "state": i.pointer("/fields/status/name").and_then(Value::as_str).unwrap_or(""),
                        "started": i.pointer("/fields/status/statusCategory/key").and_then(Value::as_str) == Some("indeterminate"),
                        "priority": i.pointer("/fields/priority/name").and_then(Value::as_str).unwrap_or(""),
                        "url": format!("https://{site}/browse/{key}"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    emit(&app, IntegrationUpdate { id: "integration_jira", data: json!({ "issues": issues }), error: None, event: None });
}

#[cfg(test)]
mod slug_tests {
    use super::safe_slug;

    #[test]
    fn slugs() {
        assert!(safe_slug("my-org"));
        assert!(safe_slug("team.atlassian.net"));
        assert!(!safe_slug("evil.com/../x"));
        assert!(!safe_slug("a b"));
        assert!(!safe_slug(""));
    }
}
