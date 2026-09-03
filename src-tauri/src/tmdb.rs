use crate::types::{DirMeta, TmdbMovie};
use serde_json::Value;

const API: &str = "https://api.themoviedb.org/3";
const IMG: &str = "https://image.tmdb.org/t/p/w780";

async fn get_json(url: &str, key: &str, extra: &[(&str, &str)]) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .get(url)
        .query(&[("api_key", key), ("language", "zh-CN")]);
    for (k, v) in extra {
        req = req.query(&[(k, v)]);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["status_message"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| text.chars().take(120).collect());
        return Err(format!("TMDB 请求失败 ({}): {}", status, msg));
    }
    serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))
}

fn year_of(date: &str) -> Option<i64> {
    date.get(0..4)?.parse().ok()
}

pub async fn search(key: &str, query: &str) -> Result<Vec<TmdbMovie>, String> {
    let v = get_json(&format!("{}/search/movie", API), key, &[("query", query), ("include_adult", "false")]).await?;
    let mut out = Vec::new();
    if let Some(items) = v["results"].as_array() {
        for it in items {
            out.push(TmdbMovie {
                id: it["id"].as_i64().unwrap_or(0),
                title: it["title"].as_str().unwrap_or("").to_string(),
                original_title: it["original_title"].as_str().map(|s| s.to_string()),
                year: it["release_date"].as_str().and_then(year_of),
                overview: it["overview"].as_str().map(|s| s.to_string()),
                rating: it["vote_average"].as_f64(),
                poster_url: it["poster_path"]
                    .as_str()
                    .map(|p| format!("{}{}", IMG, p)),
            });
        }
    }
    Ok(out)
}

pub async fn movie_detail(key: &str, id: i64) -> Result<(TmdbMovie, Option<String>), String> {
    let v = get_json(&format!("{}/movie/{}", API, id), key, &[]).await?;
    let poster_path = v["poster_path"].as_str().map(|p| format!("{}{}", IMG, p));
    let movie = TmdbMovie {
        id: v["id"].as_i64().unwrap_or(id),
        title: v["title"].as_str().unwrap_or("").to_string(),
        original_title: v["original_title"].as_str().map(|s| s.to_string()),
        year: v["release_date"].as_str().and_then(year_of),
        overview: v["overview"].as_str().map(|s| s.to_string()),
        rating: v["vote_average"].as_f64(),
        poster_url: poster_path.clone(),
    };
    Ok((movie, poster_path))
}

/// 下载海报图片并保存为封面文件，返回封面文件名
pub async fn download_poster(covers_dir: &std::path::Path, dir_path: &str, url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载海报失败: {}", e))?
        .error_for_status()
        .map_err(|e| format!("下载海报失败: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("下载海报失败: {}", e))?;
    let tmp = std::env::temp_dir().join(format!("vtm_poster_{}", crate::util::hash_hex(&[dir_path, url])));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    let name = crate::media::save_cover_image(
        covers_dir
            .parent()
            .and_then(|p| p.parent())
            .unwrap_or_else(|| std::path::Path::new("/")),
        &tmp,
        &format!("tmdb-{}", dir_path),
    );
    let _ = std::fs::remove_file(&tmp);
    name
}

pub fn meta_from_movie(dir_path: &str, m: &TmdbMovie, poster_file: Option<String>) -> DirMeta {
    DirMeta {
        path: dir_path.to_string(),
        title: Some(m.title.clone()),
        year: m.year,
        overview: m.overview.clone(),
        rating: m.rating,
        tmdb_id: Some(m.id),
        poster_file,
    }
}
