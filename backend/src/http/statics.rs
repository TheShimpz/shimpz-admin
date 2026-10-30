//! The compiled Admin SPA: its files indexed once at start, served by exact path with the precompressed sibling a
//! browser accepts, and the shell for every client-routed view.
//!
//! Only regular files inside the build are indexed (a symlink is never followed), so no request path can name anything
//! else; a `.br` or `.gz` file is never a file of its own, only its original's smaller representation.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use data_encoding::BASE64;
use sha2::{Digest, Sha256};

use super::browser;

const ENCODINGS: [(&str, &str); 2] = [("br", ".br"), ("gzip", ".gz")];

struct Asset {
    path: PathBuf,
    size: u64,
    siblings: Vec<(&'static str, PathBuf, u64)>,
    immutable: bool,
}

/// The indexed build.
pub struct Site {
    assets: HashMap<String, Asset>,
    /// The `'sha256-…'` sources of the shell's inline bootstrap scripts.
    pub script_sources: Vec<String>,
    built: bool,
}

fn walk(root: &Path, directory: &Path, found: &mut Vec<(String, PathBuf, u64)>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            walk(root, &path, found);
        } else if kind.is_file()
            && let (Ok(relative), Ok(metadata)) = (path.strip_prefix(root), entry.metadata())
            && let Some(relative) = relative.to_str()
        {
            found.push((relative.to_owned(), path, metadata.len()));
        }
    }
}

/// The inline `<script>` bodies of a document (scripts without `src`), as Python's `HTMLParser` hands them over.
#[must_use]
pub fn inline_scripts(document: &str) -> Vec<String> {
    let lower = document.to_ascii_lowercase();
    let mut scripts = Vec::new();
    let mut position = 0;
    while let Some(start) = lower[position..].find("<script") {
        let open = position + start;
        let Some(tag_end) = lower[open..].find('>') else {
            break;
        };
        let tag = &lower[open + 7..open + tag_end];
        let body_start = open + tag_end + 1;
        let Some(close) = lower[body_start..].find("</script") else {
            break;
        };
        if !tag
            .split_whitespace()
            .any(|attribute| attribute == "src" || attribute.starts_with("src="))
        {
            scripts.push(document[body_start..body_start + close].to_owned());
        }
        position = body_start + close + 8;
    }
    scripts
}

impl Site {
    /// The build at `root`; a missing build serves only a notice.
    #[must_use]
    pub fn index(root: &Path) -> Self {
        let mut found = Vec::new();
        walk(root, root, &mut found);
        let sizes: HashMap<String, (PathBuf, u64)> = found
            .iter()
            .map(|(relative, path, size)| (relative.clone(), (path.clone(), *size)))
            .collect();
        let mut assets = HashMap::new();
        for (relative, path, size) in &found {
            if ENCODINGS
                .iter()
                .any(|(_, suffix)| relative.ends_with(suffix))
            {
                continue;
            }
            let siblings = ENCODINGS
                .iter()
                .filter_map(|(coding, suffix)| {
                    let (sibling, sibling_size) = sizes.get(&format!("{relative}{suffix}"))?;
                    (*sibling_size < *size).then(|| (*coding, sibling.clone(), *sibling_size))
                })
                .collect();
            assets.insert(
                relative.clone(),
                Asset {
                    path: path.clone(),
                    size: *size,
                    siblings,
                    immutable: relative.starts_with("_app/immutable/"),
                },
            );
        }
        let script_sources = std::fs::read_to_string(root.join("index.html"))
            .map(|document| {
                inline_scripts(&document)
                    .iter()
                    .map(|script| {
                        format!(
                            "'sha256-{}'",
                            BASE64.encode(&Sha256::digest(script.as_bytes()))
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            built: assets.contains_key("index.html"),
            assets,
            script_sources,
        }
    }

    /// Serves `path` (without its leading `/`), or the shell for any path that names no file.
    pub async fn serve(&self, method: &Method, path: &str, headers: &HeaderMap) -> Response {
        if *method != Method::GET && *method != Method::HEAD {
            let mut response =
                super::respond::json_response(405, &crate::json::detail("Method Not Allowed"));
            response
                .headers_mut()
                .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
            return response;
        }
        if !self.built {
            return unbuilt(path);
        }
        let Some(asset) = self
            .assets
            .get(path)
            .or_else(|| self.assets.get("index.html"))
        else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let accepted =
            accepted_encodings(browser::header(headers, "accept-encoding").unwrap_or_default());
        let chosen = asset
            .siblings
            .iter()
            .find(|(coding, _, _)| accepted.iter().any(|known| known == coding));
        let (file, size, coding) = chosen.map_or(
            (&asset.path, asset.size, None),
            |(coding, sibling, size)| (sibling, *size, Some(*coding)),
        );
        let Ok(contents) = tokio::fs::read(file).await else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let body = if *method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(contents)
        };
        let mut response = Response::new(body);
        describe(
            response.headers_mut(),
            &asset.path,
            size,
            coding,
            asset.immutable,
        );
        response
    }
}

/// What a missing build serves: a notice at the root, nothing elsewhere.
fn unbuilt(path: &str) -> Response {
    if path.is_empty() {
        return (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "UI not built — build admin/frontend (npm run build).",
        )
            .into_response();
    }
    super::respond::json_response(404, &crate::json::detail("Not Found"))
}

fn describe(
    headers: &mut HeaderMap,
    path: &Path,
    size: u64,
    coding: Option<&'static str>,
    immutable: bool,
) {
    if let Ok(value) = HeaderValue::from_str(&media_type(path)) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    if let Some(coding) = coding {
        headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static(coding));
    }
    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
}

/// The content codings an `Accept-Encoding` value admits: each one named with a quality above zero (RFC 9110).
#[must_use]
pub fn accepted_encodings(header_value: &str) -> Vec<String> {
    header_value
        .split(',')
        .filter_map(|item| {
            let mut parts = item.split(';');
            let coding = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
            let mut quality = 1.0_f64;
            for parameter in parts {
                let (name, value) = parameter.split_once('=').unwrap_or((parameter, ""));
                if name.trim().eq_ignore_ascii_case("q") {
                    quality = value.trim().parse().unwrap_or(0.0);
                }
            }
            (!coding.is_empty() && quality > 0.0).then_some(coding)
        })
        .collect()
}

fn media_type(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let kind = match extension.as_str() {
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/vnd.microsoft.icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "xml" => "application/xml",
        _ => "text/plain",
    };
    if kind.starts_with("text/") {
        format!("{kind}; charset=utf-8")
    } else {
        kind.to_owned()
    }
}

#[cfg(test)]
mod tests;
