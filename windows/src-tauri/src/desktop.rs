// Read-only desktop awareness the user asks for with a click: the wallpaper
// (to match a style to it), what's playing (with play / pause), Docker
// containers, and the weather for a place the user typed in.
//
// Nothing here runs in the background. The few helper programs used
// (gsettings, gdbus, docker) are called with fixed arguments — never with
// text from Claude Code, a web page or the user — and only read state, except
// the media keys, which do exactly what the button says.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::platform;

const MAX_WALLPAPER: u64 = 40 * 1024 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Runs a fixed command with a deadline; stdout on success.
pub fn run_fixed(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|_| format!("{program} isn't installed"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_string(&mut out);
                }
                if status.success() {
                    return Ok(out);
                }
                let mut err = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut err);
                }
                let line = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("failed").trim();
                return Err(line.chars().take(160).collect());
            }
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                return Err(format!("{program} didn't answer in time"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

// ── Wallpaper ─────────────────────────────────────────────────────────────────

/// True for the image formats a webview can decode.
pub fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(&[0x89, b'P', b'N', b'G'])
        || bytes.starts_with(b"GIF8")
        || bytes.starts_with(b"BM")
        || (bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

/// "file:///home/me/Pictures/My%20Wall.jpg" → "/home/me/Pictures/My Wall.jpg"
#[cfg_attr(windows, allow(dead_code))] // Windows reports a plain path
pub fn uri_to_path(uri: &str) -> String {
    let s = uri.trim().trim_matches('\'').trim_matches('"');
    let s = s.strip_prefix("file://").unwrap_or(s);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The current wallpaper's bytes. Only image files, at most 40 MB.
pub fn wallpaper() -> Result<Vec<u8>, String> {
    let path = platform::wallpaper_path().ok_or("Couldn't find the desktop wallpaper.")?;
    let meta = std::fs::metadata(&path).map_err(|_| "The wallpaper file can't be read.".to_string())?;
    if !meta.is_file() || meta.len() > MAX_WALLPAPER {
        return Err("The wallpaper isn't a readable image file.".into());
    }
    let bytes = std::fs::read(&path).map_err(|_| "The wallpaper file can't be read.".to_string())?;
    if !is_image(&bytes) {
        return Err("The wallpaper isn't a JPEG, PNG, WebP, GIF or BMP image.".into());
    }
    Ok(bytes)
}

// ── Media ─────────────────────────────────────────────────────────────────────

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub playing: bool,
    /// The app playing it (Spotify, a browser…), when the OS says.
    pub source: String,
}

// ── Docker ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    /// "healthy", "unhealthy", "starting", or "" without a health check.
    pub health: String,
}

pub fn parse_docker_ps(out: &str) -> Vec<Container> {
    out.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .map(|v| {
            let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let status = s("Status");
            let health = ["unhealthy", "healthy", "health: starting"]
                .iter()
                .find(|h| status.contains(*h))
                .map(|h| if *h == "health: starting" { "starting" } else { *h })
                .unwrap_or("")
                .to_string();
            Container { name: s("Names"), image: s("Image"), state: s("State"), status, health }
        })
        .collect()
}

pub fn docker_ps() -> Result<Vec<Container>, String> {
    let out = run_fixed("docker", &["ps", "--all", "--format", "{{json .}}"], Duration::from_secs(5))?;
    let mut list = parse_docker_ps(&out);
    list.truncate(30);
    Ok(list)
}

// ── Weather (Open-Meteo, no key; only once the user sets a place) ────────────

const WEATHER_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    pub country: String,
    pub admin: String,
    pub latitude: f64,
    pub longitude: f64,
}

pub async fn geocode(query: &str) -> Result<Vec<Place>, String> {
    let q: String = query.trim().chars().take(80).collect();
    if q.len() < 2 {
        return Ok(vec![]);
    }
    let client = reqwest::Client::builder().timeout(WEATHER_TIMEOUT).build().map_err(|e| e.to_string())?;
    let v: Value = client
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[("name", q.as_str()), ("count", "6"), ("language", "en"), ("format", "json")])
        .send()
        .await
        .map_err(|_| "Couldn't reach the weather service.".to_string())?
        .json()
        .await
        .map_err(|_| "Unexpected answer from the weather service.".to_string())?;
    Ok(v.get("results")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|p| {
                    Some(Place {
                        name: p.get("name")?.as_str()?.to_string(),
                        country: p.get("country").and_then(Value::as_str).unwrap_or("").to_string(),
                        admin: p.get("admin1").and_then(Value::as_str).unwrap_or("").to_string(),
                        latitude: p.get("latitude")?.as_f64()?,
                        longitude: p.get("longitude")?.as_f64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    pub temperature: f64,
    pub code: i64,
    pub is_day: bool,
    pub wind: f64,
}

pub async fn weather(lat: f64, lon: f64) -> Result<Weather, String> {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err("Invalid place.".into());
    }
    let client = reqwest::Client::builder().timeout(WEATHER_TIMEOUT).build().map_err(|e| e.to_string())?;
    let (la, lo) = (format!("{lat:.3}"), format!("{lon:.3}"));
    let v: Value = client
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", la.as_str()),
            ("longitude", lo.as_str()),
            ("current", "temperature_2m,weather_code,is_day,wind_speed_10m"),
            ("timezone", "auto"),
        ])
        .send()
        .await
        .map_err(|_| "Couldn't reach the weather service.".to_string())?
        .json()
        .await
        .map_err(|_| "Unexpected answer from the weather service.".to_string())?;
    let c = v.get("current").ok_or("No current weather for this place.")?;
    Ok(Weather {
        temperature: c.get("temperature_2m").and_then(Value::as_f64).unwrap_or(0.0),
        code: c.get("weather_code").and_then(Value::as_i64).unwrap_or(0),
        is_day: c.get("is_day").and_then(Value::as_i64).unwrap_or(1) == 1,
        wind: c.get("wind_speed_10m").and_then(Value::as_f64).unwrap_or(0.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_magic() {
        assert!(is_image(&[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(is_image(b"\x89PNG\r\n"));
        assert!(is_image(b"RIFF\0\0\0\0WEBPVP8 "));
        assert!(!is_image(b"#!/bin/sh"));
    }

    #[test]
    fn file_uris() {
        assert_eq!(uri_to_path("'file:///home/me/My%20Wall.jpg'"), "/home/me/My Wall.jpg");
        assert_eq!(uri_to_path("/plain/path.png"), "/plain/path.png");
    }

    #[test]
    fn docker_lines() {
        let out = r#"{"Names":"db","Image":"postgres:16","State":"running","Status":"Up 3 hours (healthy)"}
{"Names":"web","Image":"node","State":"exited","Status":"Exited (1) 2 minutes ago"}"#;
        let list = parse_docker_ps(out);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].health, "healthy");
        assert_eq!(list[1].state, "exited");
        assert_eq!(list[1].health, "");
    }
}
