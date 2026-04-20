mod analyzer;
mod app_paths;
mod command_utils;
mod encoder;
mod models;
mod monitor;
mod pipeline;
mod preview;
mod queue;
mod remuxer;
mod upscaler;
mod vobsub;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use analyzer::analyze_video_fast;
use app_paths::resolve_tool_paths;
use command_utils::std_command;
use encoder::detect_hardware_encoders;
use models::{ProcessingSettings, QueueJob, RuntimeCapabilities, VideoAnalysis};
use monitor::emit_status;
use preview::PreviewFrameResult;
use queue::QueueManager;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use tokio::time::{sleep, Duration};
use upscaler::detect_available_gpu_count;
use vobsub::decode_idx_sub_to_png_cues;

// ─────────────────────────────────────────────
//  App state
// ─────────────────────────────────────────────

#[derive(Default)]
struct AppState {
    queue: QueueManager,
}

// ─────────────────────────────────────────────
//  Data types
// ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdSubtitleTrackCandidate {
    input_path: String,
    stream_index: u32,
    codec: String,
    language: Option<String>,
    title: Option<String>,
    is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdSubtitleExtractRequest {
    input_paths: Vec<String>,
    output_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdSubtitleExtractResult {
    input_path: String,
    stream_index: u32,
    idx_path: String,
    sub_path: String,
    success: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdOcrStartRequest {
    idx_path: String,
    output_dir: String,
    language: String,
    max_images: Option<u32>,
    ocr_upscale_factor: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdOcrLineRequest {
    id: u32,
    image_path: String,
    start_ms: u64,
    end_ms: u64,
    language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdOcrLine {
    id: u32,
    image_path: String,
    image_data_url: String,
    start_ms: u64,
    end_ms: u64,
    ocr_text: String,
    confidence: f32,
    needs_manual: bool,
    unknown_tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdOcrStartResult {
    lines: Vec<DvdOcrLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdOcrProgressEvent {
    kind: String,
    processed: usize,
    total: usize,
    line: Option<DvdOcrLine>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdOcrExportRequest {
    output_srt_path: String,
    lines: Vec<DvdOcrLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdOcrImageMeta {
    id: u32,
    image_path: String,
    start_ms: u64,
    end_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DvdOcrImagesCache {
    idx_path: String,
    ocr_upscale_factor: u8,
    lines: Vec<DvdOcrImageMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OcrUserReplacement {
    pattern: String,
    replacement: String,
}

// ─────────────────────────────────────────────
//  Helpers — file / path
// ─────────────────────────────────────────────

fn is_supported_video_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|v| v.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mkv" | "mp4" | "avi" | "mov" | "webm" | "m4v" | "ts"
            | "flv" | "wmv" | "mpg" | "mpeg" | "ogv"
    )
}

fn ms_to_srt(ms: u64) -> String {
    let h    = ms / 3_600_000;
    let m    = (ms % 3_600_000) / 60_000;
    let s    = (ms % 60_000) / 1000;
    let msec = ms % 1000;
    format!("{h:02}:{m:02}:{s:02},{msec:03}")
}

fn ocr_cache_path(images_dir: &Path) -> PathBuf {
    images_dir.join(".ocr_images_cache.json")
}

fn ocr_images_dir_for_idx(output_dir: &Path, idx_path: &Path) -> PathBuf {
    let stem = idx_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.replace(' ', "_"))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "track".to_string());
    output_dir.join("ocr_images").join(stem)
}

fn write_ocr_images_cache(images_dir: &Path, cache: &DvdOcrImagesCache) -> Result<(), String> {
    let path    = ocr_cache_path(images_dir);
    let payload = serde_json::to_string(cache)
        .map_err(|e| format!("Sérialisation cache OCR impossible: {e}"))?;
    std::fs::write(&path, payload)
        .map_err(|e| format!("Écriture cache OCR impossible '{}': {e}", path.display()))
}

fn read_ocr_images_cache(images_dir: &Path) -> Option<DvdOcrImagesCache> {
    let path = ocr_cache_path(images_dir);
    let raw  = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<DvdOcrImagesCache>(&raw).ok()
}

// ─────────────────────────────────────────────
//  Helpers — Tesseract configuration
// ─────────────────────────────────────────────

fn prepare_tesseract_command(tesseract: &Path) -> std::process::Command {
    let tessdata_dir = tesseract
        .parent()
        .map(|p| p.join("tessdata"))
        .filter(|p| p.exists());
    let mut cmd = std_command(tesseract);
    if let Some(dir) = tessdata_dir {
        cmd.env("TESSDATA_PREFIX", dir.to_string_lossy().as_ref());
    }
    cmd
}

fn resolve_ocr_language(tesseract: &Path, requested: &str) -> String {
    let tessdata_dir = tesseract
        .parent()
        .map(|p| p.join("tessdata"))
        .filter(|p| p.exists());
    let Some(dir) = tessdata_dir else {
        return "fra".to_string();
    };
    let candidate = requested.trim().to_ascii_lowercase();
    let candidate = if candidate.is_empty() { "fra".to_string() } else { candidate };
    if dir.join(format!("{candidate}.traineddata")).exists() {
        return candidate;
    }
    if dir.join("fra.traineddata").exists() {
        return "fra".to_string();
    }
    "eng".to_string()
}

fn resolve_user_words_file(tesseract: &Path, language: &str) -> Option<PathBuf> {
    let base = tesseract.parent()?.join("dic");
    if !base.exists() {
        return None;
    }
    let lang = language.trim().to_ascii_lowercase();
    let mut candidates = vec![
        base.join(format!("tesseract_user_words_{lang}.txt")),
        base.join("tesseract_user_words_fra.txt"),
        base.join("tesseract_user_words.txt"),
    ];
    candidates.dedup();
    candidates.into_iter().find(|p| p.exists())
}

// ─────────────────────────────────────────────
//  Helpers — user OCR replacement dictionary
// ─────────────────────────────────────────────

fn ocr_user_dict_path() -> Result<PathBuf, String> {
    let tools     = resolve_tool_paths()?;
    let tesseract = tools.tesseract_exe.as_ref()
        .ok_or_else(|| "tesseract.exe introuvable".to_string())?;
    let dic_dir = tesseract.parent()
        .ok_or_else(|| "Chemin tesseract invalide".to_string())?
        .join("dic");
    std::fs::create_dir_all(&dic_dir)
        .map_err(|e| format!("Impossible de créer le dossier dic '{}': {e}", dic_dir.display()))?;
    Ok(dic_dir.join("user_ocr_replacements.json"))
}

fn read_ocr_user_replacements_map() -> Result<HashMap<String, String>, String> {
    let path = ocr_user_dict_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Lecture dictionnaire OCR impossible '{}': {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str::<HashMap<String, String>>(&content)
        .map_err(|e| format!("Format dictionnaire OCR invalide '{}': {e}", path.display()))
}

fn write_ocr_user_replacements_map(map: &HashMap<String, String>) -> Result<(), String> {
    let path    = ocr_user_dict_path()?;
    let payload = serde_json::to_string_pretty(map)
        .map_err(|e| format!("Sérialisation dictionnaire OCR impossible: {e}"))?;
    std::fs::write(&path, payload)
        .map_err(|e| format!("Écriture dictionnaire OCR impossible '{}': {e}", path.display()))
}

/// Apply user replacements (longest-pattern-first to avoid partial overlaps).
fn apply_user_ocr_replacements(text: &str, map: &HashMap<String, String>) -> String {
    if map.is_empty() || text.is_empty() {
        return text.to_string();
    }
    let mut pairs: Vec<(&String, &String)> = map.iter().collect();
    pairs.sort_by(|(a, _), (b, _)| b.len().cmp(&a.len())); // longest first
    let mut out = text.to_string();
    for (pattern, replacement) in pairs {
        if !pattern.trim().is_empty() && !is_risky_single_char_letter_swap(pattern, replacement) {
            out = out.replace(pattern.as_str(), replacement.as_str());
        }
    }
    out
}

fn is_risky_single_char_letter_swap(pattern: &str, replacement: &str) -> bool {
    let mut p = pattern.chars();
    let mut r = replacement.chars();
    let Some(pc) = p.next() else { return false; };
    let Some(rc) = r.next() else { return false; };
    if p.next().is_some() || r.next().is_some() {
        return false;
    }
    pc.is_alphabetic() && rc.is_alphabetic()
}

fn is_safe_single_char_ocr_swap(src: char, dst: char) -> bool {
    let src_alnum = src.is_ascii_alphanumeric();
    let dst_alnum = dst.is_ascii_alphanumeric();
    // Keep only classic OCR confusions (digit/letter and punctuation-like glyphs).
    (src.is_ascii_digit() && dst.is_ascii_alphabetic())
        || (src.is_ascii_alphabetic() && dst.is_ascii_digit())
        || (!src_alnum && dst_alnum)
        || (src_alnum && !dst_alnum)
}

/// Extract character-level changes from corrected text and learn them.
/// Compares original OCR output with user correction to auto-generate replacement rules.
fn auto_learn_from_correction(
    original: &str,
    corrected: &str,
    map: &mut HashMap<String, String>,
) {
    if original.trim() == corrected.trim() {
        return; // No changes
    }
    
    // For simple single-character corrections, learn the mapping
    // E.g.: "5" → "S", "0" → "O", "l" → "1", "1" → "l"
    let orig_chars: Vec<char> = original.chars().collect();
    let corr_chars: Vec<char> = corrected.chars().collect();
    
    if orig_chars.len() == corr_chars.len() && orig_chars.len() <= 50 {
        // Character-by-character alignment for short lines
        for (&o, &c) in orig_chars.iter().zip(corr_chars.iter()) {
            if o != c {
                // Single character change detected
                let pattern = o.to_string();
                let replacement = c.to_string();
                // Learn only safe OCR confusions to avoid poisoning accent substitutions.
                if pattern.len() == 1
                    && replacement.len() == 1
                    && is_safe_single_char_ocr_swap(o, c)
                {
                    map.insert(pattern, replacement);
                }
            }
        }
    } else {
        // For longer text with word-level changes, try to find word boundaries
        let orig_words: Vec<&str> = original.split_whitespace().collect();
        let corr_words: Vec<&str> = corrected.split_whitespace().collect();
        
        if orig_words.len() == corr_words.len() && orig_words.len() <= 20 {
            for (&o_word, &c_word) in orig_words.iter().zip(corr_words.iter()) {
                if o_word != c_word && levenshtein_distance(o_word, c_word) <= 2 {
                    // Close match = likely OCR error, learn it
                    map.insert(o_word.to_string(), c_word.to_string());
                }
            }
        }
    }
}

/// Calculate Levenshtein distance between two strings (simple edit distance).
fn levenshtein_distance(s1: &str, s2: &str) -> usize {
    let len1 = s1.len();
    let len2 = s2.len();
    let mut matrix = vec![vec![0; len2 + 1]; len1 + 1];
    
    for i in 0..=len1 {
        matrix[i][0] = i;
    }
    for j in 0..=len2 {
        matrix[0][j] = j;
    }
    
    for (i, c1) in s1.chars().enumerate() {
        for (j, c2) in s2.chars().enumerate() {
            let cost = if c1 == c2 { 0 } else { 1 };
            matrix[i + 1][j + 1] = *[
                matrix[i][j + 1] + 1,
                matrix[i + 1][j] + 1,
                matrix[i][j] + cost,
            ]
            .iter()
            .min()
            .unwrap_or(&0);
        }
    }
    
    matrix[len1][len2]
}

// ─────────────────────────────────────────────
//  OCR text quality scoring
// ─────────────────────────────────────────────

/// Score an OCR result — higher is better.
/// This is used to pick the best PSM mode result.
fn score_ocr_text(text: &str) -> i32 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return i32::MIN;
    }

    let mut score  = 0i32;
    let mut prev   = '\0';
    let mut run    = 0i32;

    for ch in trimmed.chars() {
        if ch == prev {
            run += 1;
            // Penalise runs of identical characters (OCR noise like "lllll")
            if run >= 3 {
                score -= 4;
            }
        } else {
            run  = 0;
            prev = ch;
        }

        if ch.is_alphabetic() {
            score += 5;
        } else if ch.is_whitespace() {
            score += 2;
        } else if ch.is_ascii_digit() {
            score += 2;
        } else if "!?.,:;-()'\"«»…".contains(ch) {
            score += 1; // valid punctuation
        } else {
            score -= 6; // garbage character
        }
    }

    // Penalise texts that are suspiciously short
    if trimmed.len() < 3 {
        score -= 20;
    }

    score
}

// ─────────────────────────────────────────────
//  OCR text normalisation (minimal, safe)
// ─────────────────────────────────────────────

/// Lightweight normalisation that is safe to apply to any language.
/// Does NOT touch casing — that would destroy proper nouns / acronyms.
fn normalize_ocr_text(text: &str) -> String {
    let mut out = text
        // Whitespace
        .replace('\r', "")
        .replace('\t', " ")
        // Fancy quotes / dashes → ASCII equivalents
        .replace('\u{2018}', "'")  // '
        .replace('\u{2019}', "'")  // '
        .replace('\u{201C}', "\"") // "
        .replace('\u{201D}', "\"") // "
        .replace('\u{2013}', "-")  // –
        .replace('\u{2014}', "-")  // —
        .replace('\u{2026}', "..."); // …

    // Collapse runs of spaces (but preserve newlines)
    while out.contains("  ") {
        out = out.replace("  ", " ");
    }

    // Trim each line individually AND remove empty lines
    out = out.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())  // Remove blank lines
        .collect::<Vec<_>>()
        .join("\n");
    
    // Remove leading apostrophes from line starts (common OCR error)
    out = out.lines()
        .map(|line| {
            let trimmed = line.trim_start_matches('\'');
            if trimmed.is_empty() { line } else { trimmed }
        })
        .collect::<Vec<_>>()
        .join("\n");
    
    out.trim().to_string()
}

/// Collect visually-suspicious characters that are almost certainly OCR noise.
fn collect_unknown_tokens(text: &str) -> Vec<String> {
    const SUSPICIOUS: &[char] = &['□', '■', '◆', '◇', '¤', '\u{FFFD}'];
    let mut out: Vec<String> = text
        .chars()
        .filter(|c| SUSPICIOUS.contains(c))
        .map(|c| c.to_string())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    // A lone "?" as the entire text is almost always a failed decode
    if text.trim() == "?" {
        out.push("?".to_string());
    }
    out.sort();
    out
}

// ─────────────────────────────────────────────
//  Tesseract execution
// ─────────────────────────────────────────────

/// The page-segmentation modes we try, in priority order.
///
/// PSM 6  – assume a single uniform block of text  (best for multi-line subtitles)
/// PSM 7  – treat the image as a single text line  (good for 1-line subtitles)
/// PSM 11 – sparse text, no OSD
/// PSM 13 – raw line, no dictionaries
const PSM_CANDIDATES: &[&str] = &["6", "7", "11", "13"];

/// Run Tesseract for text output and return (best_text, best_psm).
fn run_tesseract_text(
    tesseract: &Path,
    image_path: &Path,
    language: &str,
    user_words_path: Option<&Path>,
) -> Result<(String, String), String> {
    let mut best_text  = String::new();
    let mut best_psm   = PSM_CANDIDATES[0].to_string();
    let mut best_score = i32::MIN;
    let mut last_error = String::new();

    for &psm in PSM_CANDIDATES {
        let mut cmd = prepare_tesseract_command(tesseract);
        cmd.arg(image_path)
            .arg("stdout")
            .args(["-l", language, "--oem", "1", "--psm", psm,
                   "-c", "preserve_interword_spaces=1",
                   "-c", "load_system_dawg=0",
                   "-c", "load_freq_dawg=0"]);
        if let Some(uw) = user_words_path {
            cmd.arg("--user-words").arg(uw);
        }

        let out = match cmd.output() {
            Ok(o) => o,
            Err(e) => {
                last_error = format!("Échec exécution tesseract (text psm={psm}): {e}");
                continue;
            }
        };
        
        // Check for crash signals (abnormal exit codes)
        if !out.status.success() {
            let stderr_msg = String::from_utf8_lossy(&out.stderr);
            last_error = stderr_msg.trim().to_string();
            // Skip this PSM and try the next one instead of crashing
            continue;
        }

        let raw  = String::from_utf8_lossy(&out.stdout);
        let norm = normalize_ocr_text(&raw);
        let score = score_ocr_text(&norm);
        if score > best_score {
            best_score = score;
            best_text  = norm;
            best_psm   = psm.to_string();
        }
    }

    if best_text.is_empty() && !last_error.is_empty() {
        return Err(last_error);
    }
    Ok((best_text, best_psm))
}

/// Run Tesseract for TSV output and return the mean confidence (0–100).
fn run_tesseract_confidence(
    tesseract: &Path,
    image_path: &Path,
    language: &str,
    psm: &str,
    user_words_path: Option<&Path>,
) -> Result<f32, String> {
    let mut cmd = prepare_tesseract_command(tesseract);
    cmd.arg(image_path)
        .arg("stdout")
        .args(["-l", language, "--oem", "1", "--psm", psm,
               "-c", "preserve_interword_spaces=1",
               "-c", "load_system_dawg=0",
               "-c", "load_freq_dawg=0",
               "tsv"]);
    if let Some(uw) = user_words_path {
        cmd.arg("--user-words").arg(uw);
    }

    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            return Err(format!("Échec exécution tesseract (tsv): {e}"));
        }
    };
    
    if !out.status.success() {
        let stderr_msg = String::from_utf8_lossy(&out.stderr);
        return Err(stderr_msg.trim().to_string());
    }

    let tsv = String::from_utf8_lossy(&out.stdout);
    let (mut sum, mut count) = (0.0f32, 0u32);
    for (i, line) in tsv.lines().enumerate() {
        if i == 0 { continue; } // skip header
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 12 { continue; }
        let word = cols[11].trim();
        if word.is_empty() { continue; }
        if let Ok(conf) = cols[10].trim().parse::<f32>() {
            if conf >= 0.0 {
                sum   += conf;
                count += 1;
            }
        }
    }

    if count == 0 { return Ok(0.0); }
    Ok(sum / count as f32)
}

// ─────────────────────────────────────────────
//  Full OCR pipeline for one image
// ─────────────────────────────────────────────

struct OcrResult {
    text: String,
    confidence: f32,
    needs_manual: bool,
    unknown_tokens: Vec<String>,
}

fn ocr_image(
    tesseract: &Path,
    image_path: &Path,
    language: &str,
    user_words: Option<&Path>,
    user_replacements: &HashMap<String, String>,
) -> Result<OcrResult, String> {
    // 1. Run Tesseract (tries all PSM modes, keeps best score)
    let (raw_text, used_psm) = run_tesseract_text(tesseract, image_path, language, user_words)?;

    // 2. Apply user-defined string replacements
    let text = apply_user_ocr_replacements(&raw_text, user_replacements);

    // 3. Get word-level confidence for the winning PSM
    let raw_conf = run_tesseract_confidence(tesseract, image_path, language, &used_psm, user_words)
        .unwrap_or(0.0);

    // Filter out clear noise: single/short characters with very low confidence
    // Examples: "1", "I", "l", "|" when confidence is near 0
    let trimmed = text.trim();
    if trimmed.len() <= 2 && raw_conf < 20.0 {
        // Likely OCR noise, treat as empty
        return Ok(OcrResult {
            text: String::new(),
            confidence: 0.0,
            needs_manual: true,
            unknown_tokens: vec![],
        });
    }

    // If Tesseract returns 0 confidence but we do have text, it is usually correct
    // (Tesseract sometimes reports 0 for images with very high contrast / unusual fonts).
    // BUT only for longer text (>3 chars), to avoid false positives
    let confidence = if raw_conf <= 0.0 && trimmed.len() > 3 {
        98.0
    } else {
        raw_conf
    };

    let unknown_tokens = collect_unknown_tokens(&text);
    let needs_manual   = text.trim().is_empty() || confidence < 70.0 || !unknown_tokens.is_empty();

    Ok(OcrResult { text, confidence, needs_manual, unknown_tokens })
}

// ─────────────────────────────────────────────
//  Tauri commands — video / queue
// ─────────────────────────────────────────────

#[tauri::command]
async fn resolve_video_inputs(input_path: String) -> Result<Vec<String>, String> {
    let target = PathBuf::from(input_path);
    if !target.exists() {
        return Err("Chemin introuvable".to_string());
    }
    if target.is_file() {
        if is_supported_video_file(&target) {
            return Ok(vec![target.to_string_lossy().to_string()]);
        }
        return Err("Le fichier sélectionné n'est pas une vidéo supportée".to_string());
    }
    if !target.is_dir() {
        return Err("Le chemin sélectionné n'est ni un fichier ni un dossier".to_string());
    }

    let mut files: Vec<PathBuf> = std::fs::read_dir(&target)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && is_supported_video_file(p))
        .collect();
    files.sort_by_key(|p| p.file_name().map(|v| v.to_os_string()));

    if files.is_empty() {
        return Err("Aucun fichier vidéo supporté trouvé dans ce dossier".to_string());
    }
    Ok(files.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
}

#[tauri::command]
async fn add_job(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    input_path: String,
    settings: ProcessingSettings,
) -> Result<QueueJob, String> {
    let created = state.queue.add_job(input_path, settings).await?;
    emit_status(&app, &created);
    Ok(created)
}

#[tauri::command]
async fn list_jobs(state: State<'_, AppState>) -> Result<Vec<QueueJob>, String> {
    Ok(state.queue.list_jobs().await)
}

#[tauri::command]
async fn start_job_or_batch(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    job_id: String,
) -> Result<(), String> {
    state.queue.start_job_or_batch(app, &job_id).await
}

#[tauri::command]
async fn pause_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state.queue.pause_job(&job_id).await;
    Ok(())
}

#[tauri::command]
async fn resume_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state.queue.resume_job(&job_id).await;
    Ok(())
}

#[tauri::command]
async fn cancel_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state.queue.cancel_job(&job_id).await;
    Ok(())
}

#[tauri::command]
async fn retry_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state.queue.retry_job(&job_id).await;
    Ok(())
}

#[tauri::command]
async fn clear_done_jobs(state: State<'_, AppState>) -> Result<(), String> {
    state.queue.clear_done_jobs().await;
    Ok(())
}

#[tauri::command]
async fn remove_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state.queue.remove_job(&job_id).await
}

#[tauri::command]
async fn update_job_settings(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    job_id: String,
    settings: ProcessingSettings,
) -> Result<QueueJob, String> {
    let updated = state.queue.update_job_settings(&job_id, settings).await?;
    emit_status(&app, &updated);
    Ok(updated)
}

#[tauri::command]
async fn analyze_file(input_path: String) -> Result<VideoAnalysis, String> {
    let tools = resolve_tool_paths()?;
    analyze_video_fast(&PathBuf::from(input_path), &tools).await
}

// ─────────────────────────────────────────────
//  Tauri commands — DVD subtitle extraction
// ─────────────────────────────────────────────

#[tauri::command]
async fn scan_dvd_subtitle_tracks(
    input_paths: Vec<String>,
) -> Result<Vec<DvdSubtitleTrackCandidate>, String> {
    if input_paths.is_empty() {
        return Ok(Vec::new());
    }
    let tools = resolve_tool_paths()?;
    let mut out = Vec::new();
    for input_path in input_paths {
        let analysis = analyze_video_fast(&PathBuf::from(&input_path), &tools).await?;
        for track in analysis.subtitle_tracks {
            let codec = track.codec.unwrap_or_default();
            if codec.eq_ignore_ascii_case("dvd_subtitle") {
                out.push(DvdSubtitleTrackCandidate {
                    input_path: input_path.clone(),
                    stream_index: track.stream_index,
                    codec,
                    language: track.language,
                    title: track.title,
                    is_default: track.is_default,
                });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
async fn extract_dvd_subtitle_tracks(
    request: DvdSubtitleExtractRequest,
) -> Result<Vec<DvdSubtitleExtractResult>, String> {
    if request.input_paths.is_empty() {
        return Ok(Vec::new());
    }
    let tools = resolve_tool_paths()?;
    let mkvextract = tools.mkvextract_exe.as_ref()
        .ok_or("mkvextract.exe introuvable (attendu: tools/mkvextract/mkvextract.exe)")?;

    let output_dir = PathBuf::from(&request.output_dir);
    std::fs::create_dir_all(&output_dir).map_err(|e| {
        format!("Impossible de créer le dossier de sortie '{}': {e}", output_dir.display())
    })?;

    let mut results = Vec::new();
    for input_path in &request.input_paths {
        let source   = PathBuf::from(input_path);
        let analysis = analyze_video_fast(&source, &tools).await?;
        let stem = source
            .file_stem()
            .map(|s| s.to_string_lossy().replace(' ', "_"))
            .unwrap_or_else(|| "video".to_string());

        for track in analysis.subtitle_tracks {
            let codec = track.codec.unwrap_or_default();
            if !codec.eq_ignore_ascii_case("dvd_subtitle") {
                continue;
            }
            let idx_path  = output_dir.join(format!("{stem}_track{}_dvd.idx", track.stream_index));
            let sub_path  = idx_path.with_extension("sub");
            let track_arg = format!("{}:{}", track.stream_index, idx_path.display());
            let output    = std_command(mkvextract)
                .arg("tracks").arg(&source).arg(&track_arg)
                .output().map_err(|e| e.to_string())?;

            let success = output.status.success() && idx_path.exists() && sub_path.exists();
            results.push(DvdSubtitleExtractResult {
                input_path: input_path.clone(),
                stream_index: track.stream_index,
                idx_path: idx_path.to_string_lossy().into_owned(),
                sub_path: sub_path.to_string_lossy().into_owned(),
                success,
                error: if success {
                    None
                } else {
                    Some(String::from_utf8_lossy(&output.stderr).trim().to_string())
                },
            });
        }
    }
    Ok(results)
}

// ─────────────────────────────────────────────
//  Tauri commands — DVD OCR
// ─────────────────────────────────────────────

/// Validate + load (or regenerate) the cache of extracted subtitle images.
fn load_or_generate_image_cache(
    idx_path: &Path,
    images_dir: &Path,
    idx_path_str: &str,
    max_images: Option<u32>,
    ocr_upscale_factor: u8,
) -> Result<Vec<DvdOcrImageMeta>, String> {
    // Try existing cache first
    if let Some(cache) = read_ocr_images_cache(images_dir) {
        let valid = cache.idx_path.eq_ignore_ascii_case(idx_path_str)
            && cache.ocr_upscale_factor == ocr_upscale_factor
            && !cache.lines.is_empty()
            && cache.lines.iter().any(|l| l.start_ms > 0 || l.end_ms > 0)
            && cache.lines.iter().all(|l| PathBuf::from(&l.image_path).exists());
        if valid {
            return Ok(cache.lines);
        }
    }

    // Re-extract from IDX/SUB
    let cues = decode_idx_sub_to_png_cues(
        idx_path,
        max_images.map(|v| v.max(1) as usize),
        ocr_upscale_factor,
    )?;
    if cues.is_empty() {
        return Err("Aucune image décodée depuis IDX/SUB".to_string());
    }

    let mut lines = Vec::with_capacity(cues.len());
    for (i, cue) in cues.iter().enumerate() {
        let image_path = images_dir.join(format!("line_{:04}.png", i + 1));
        std::fs::write(&image_path, &cue.ocr_png_bytes).map_err(|e| {
            format!("Écriture image OCR impossible '{}': {e}", image_path.display())
        })?;
        lines.push(DvdOcrImageMeta {
            id: (i + 1) as u32,
            image_path: image_path.to_string_lossy().into_owned(),
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
        });
    }

    let _ = write_ocr_images_cache(images_dir, &DvdOcrImagesCache {
        idx_path: idx_path_str.to_string(),
        ocr_upscale_factor,
        lines: lines.clone(),
    });
    Ok(lines)
}

fn read_image_as_data_url(image_path: &Path) -> Result<String, String> {
    let bytes   = std::fs::read(image_path)
        .map_err(|e| format!("Lecture image OCR impossible '{}': {e}", image_path.display()))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/png;base64,{encoded}"))
}

#[tauri::command]
async fn start_dvd_ocr(
    app: tauri::AppHandle,
    request: DvdOcrStartRequest,
) -> Result<DvdOcrStartResult, String> {
    let tools = resolve_tool_paths()?;
    let tesseract = tools.tesseract_exe.as_ref()
        .ok_or("tesseract.exe introuvable (attendu: tools/tesseract/tesseract.exe)")?;

    let idx_path = PathBuf::from(&request.idx_path);
    if !idx_path.exists() {
        return Err(format!("IDX introuvable: {}", idx_path.display()));
    }

    let output_dir  = PathBuf::from(&request.output_dir);
    let images_dir  = ocr_images_dir_for_idx(&output_dir, &idx_path);
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Impossible de créer le dossier images OCR: {e}"))?;

    let upscale = match request.ocr_upscale_factor.unwrap_or(3) { 2 => 2, _ => 3 };
    let metas   = load_or_generate_image_cache(
        &idx_path, &images_dir, &request.idx_path, request.max_images, upscale,
    )?;

    let total             = metas.len();
    let ocr_language      = resolve_ocr_language(tesseract, &request.language);
    let user_words        = resolve_user_words_file(tesseract, &ocr_language);
    let user_replacements = read_ocr_user_replacements_map().unwrap_or_default();

    let _ = app.emit("dvd-ocr-progress", DvdOcrProgressEvent {
        kind: "started".to_string(), processed: 0, total,
        line: None, message: Some(format!("OCR démarré ({total} image(s))")),
    });
    tokio::task::yield_now().await;

    let mut lines = Vec::with_capacity(total);
    for (idx, meta) in metas.iter().enumerate() {
        let image_path = PathBuf::from(&meta.image_path);
        let ocr        = ocr_image(
            tesseract, &image_path, &ocr_language,
            user_words.as_deref(), &user_replacements,
        )?;
        let image_data_url = read_image_as_data_url(&image_path)?;

        let line = DvdOcrLine {
            id: meta.id,
            image_path: meta.image_path.clone(),
            image_data_url,
            start_ms: meta.start_ms,
            end_ms: meta.end_ms,
            ocr_text: ocr.text,
            confidence: ocr.confidence,
            needs_manual: ocr.needs_manual,
            unknown_tokens: ocr.unknown_tokens,
        };

        let _ = app.emit("dvd-ocr-progress", DvdOcrProgressEvent {
            kind: "line".to_string(), processed: idx + 1, total,
            line: Some(line.clone()), message: None,
        });
        tokio::task::yield_now().await;
        lines.push(line);
    }

    let _ = app.emit("dvd-ocr-progress", DvdOcrProgressEvent {
        kind: "done".to_string(), processed: total, total,
        line: None, message: Some("OCR terminé".to_string()),
    });
    tokio::task::yield_now().await;
    Ok(DvdOcrStartResult { lines })
}

#[tauri::command]
async fn load_dvd_sub_images(request: DvdOcrStartRequest) -> Result<DvdOcrStartResult, String> {
    let idx_path = PathBuf::from(&request.idx_path);
    if !idx_path.exists() {
        return Err(format!("IDX introuvable: {}", idx_path.display()));
    }

    let output_dir = PathBuf::from(&request.output_dir);
    let images_dir = ocr_images_dir_for_idx(&output_dir, &idx_path);
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Impossible de créer le dossier images OCR: {e}"))?;

    let upscale = match request.ocr_upscale_factor.unwrap_or(3) { 2 => 2, _ => 3 };
    let cues = decode_idx_sub_to_png_cues(
        &idx_path,
        request.max_images.map(|v| v.max(1) as usize),
        upscale,
    )?;
    if cues.is_empty() {
        return Err("Aucune image décodée depuis IDX/SUB".to_string());
    }

    let mut lines       = Vec::with_capacity(cues.len());
    let mut cache_lines = Vec::with_capacity(cues.len());

    for (i, cue) in cues.iter().enumerate() {
        let image_path = images_dir.join(format!("line_{:04}.png", i + 1));
        std::fs::write(&image_path, &cue.ocr_png_bytes).map_err(|e| {
            format!("Écriture image OCR impossible '{}': {e}", image_path.display())
        })?;
        let encoded        = base64::engine::general_purpose::STANDARD.encode(&cue.ocr_png_bytes);
        let image_data_url = format!("data:image/png;base64,{encoded}");

        lines.push(DvdOcrLine {
            id: (i + 1) as u32,
            image_path: image_path.to_string_lossy().into_owned(),
            image_data_url,
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            ocr_text: String::new(),
            confidence: 0.0,
            needs_manual: true,
            unknown_tokens: Vec::new(),
        });
        cache_lines.push(DvdOcrImageMeta {
            id: (i + 1) as u32,
            image_path: image_path.to_string_lossy().into_owned(),
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
        });
    }

    let _ = write_ocr_images_cache(&images_dir, &DvdOcrImagesCache {
        idx_path: request.idx_path.clone(),
        ocr_upscale_factor: upscale,
        lines: cache_lines,
    });
    Ok(DvdOcrStartResult { lines })
}

#[tauri::command]
async fn ocr_dvd_sub_line(request: DvdOcrLineRequest) -> Result<DvdOcrLine, String> {
    let tools = resolve_tool_paths()?;
    let tesseract = tools.tesseract_exe.as_ref()
        .ok_or("tesseract.exe introuvable (attendu: tools/tesseract/tesseract.exe)")?;

    let image_path = PathBuf::from(&request.image_path);
    if !image_path.exists() {
        return Err(format!("Image OCR introuvable: {}", image_path.display()));
    }

    let ocr_language      = resolve_ocr_language(tesseract, &request.language);
    let user_words        = resolve_user_words_file(tesseract, &ocr_language);
    let user_replacements = read_ocr_user_replacements_map().unwrap_or_default();
    let ocr               = ocr_image(
        tesseract, &image_path, &ocr_language,
        user_words.as_deref(), &user_replacements,
    )?;
    let image_data_url = read_image_as_data_url(&image_path)?;

    Ok(DvdOcrLine {
        id: request.id,
        image_path: request.image_path,
        image_data_url,
        start_ms: request.start_ms,
        end_ms: request.end_ms,
        ocr_text: ocr.text,
        confidence: ocr.confidence,
        needs_manual: ocr.needs_manual,
        unknown_tokens: ocr.unknown_tokens,
    })
}

// ─────────────────────────────────────────────
//  Tauri commands — user replacement dictionary
// ─────────────────────────────────────────────

#[tauri::command]
async fn list_ocr_user_replacements() -> Result<Vec<OcrUserReplacement>, String> {
    let mut out: Vec<OcrUserReplacement> = read_ocr_user_replacements_map()?
        .into_iter()
        .map(|(pattern, replacement)| OcrUserReplacement { pattern, replacement })
        .collect();
    out.sort_by(|a, b| a.pattern.cmp(&b.pattern));
    Ok(out)
}

#[tauri::command]
async fn upsert_ocr_user_replacement(pattern: String, replacement: String) -> Result<(), String> {
    let key   = pattern.trim().to_string();
    let value = replacement.trim().to_string();
    if key.is_empty() || value.is_empty() {
        return Err("Pattern et replacement sont requis".to_string());
    }
    let mut map = read_ocr_user_replacements_map()?;
    map.insert(key, value);
    write_ocr_user_replacements_map(&map)
}

/// Auto-learn from a manual OCR correction.
/// When user manually corrects a line, system extracts the changes and learns them.
#[tauri::command]
async fn record_ocr_correction(original_ocr: String, corrected_text: String) -> Result<Vec<OcrUserReplacement>, String> {
    let mut map = read_ocr_user_replacements_map()?;
    auto_learn_from_correction(&original_ocr, &corrected_text, &mut map);
    write_ocr_user_replacements_map(&map)?;
    
    // Return updated map for frontend awareness
    let mut out: Vec<OcrUserReplacement> = map
        .into_iter()
        .map(|(pattern, replacement)| OcrUserReplacement { pattern, replacement })
        .collect();
    out.sort_by(|a, b| a.pattern.cmp(&b.pattern));
    Ok(out)
}

// ─────────────────────────────────────────────
//  Tauri commands — SRT export
// ─────────────────────────────────────────────

#[tauri::command]
async fn export_dvd_ocr_srt(request: DvdOcrExportRequest) -> Result<String, String> {
    if request.lines.is_empty() {
        return Err("Aucune ligne OCR à exporter".to_string());
    }

    let mut ordered = request.lines;
    ordered.sort_by_key(|l| l.start_ms);

    // Remove duplicate timings
    let mut seen = std::collections::HashSet::new();
    ordered.retain(|l| seen.insert((l.start_ms, l.end_ms)));

    let mut srt = String::new();
    let mut seq = 1u32;
    for line in &ordered {
        let text = line.ocr_text.trim();
        if text.is_empty() { continue; }

        let clean_text = text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        srt.push_str(&seq.to_string());
        srt.push('\n');
        srt.push_str(&format!("{} --> {}\n", ms_to_srt(line.start_ms), ms_to_srt(line.end_ms)));
        srt.push_str(&clean_text);
        srt.push_str("\n\n");
        seq += 1;
    }

    let out_path = PathBuf::from(&request.output_srt_path);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&out_path, &srt)
        .map_err(|e| format!("Écriture SRT impossible: {e}"))?;
    Ok(out_path.to_string_lossy().into_owned())
}

// ─────────────────────────────────────────────
//  Tauri commands — misc
// ─────────────────────────────────────────────

#[tauri::command]
async fn preview_frame(
    input_path: String,
    settings: ProcessingSettings,
    frame_index: u64,
    preview_id: Option<String>,
) -> Result<PreviewFrameResult, String> {
    let tools = resolve_tool_paths()?;
    preview::generate_preview_frame(
        &tools, &PathBuf::from(input_path), &settings, frame_index, preview_id.as_deref(),
    ).await
}

#[tauri::command]
async fn get_runtime_capabilities() -> Result<RuntimeCapabilities, String> {
    let tools       = resolve_tool_paths()?;
    let hw_encoders = detect_hardware_encoders(&tools);
    let gpu_count   = detect_available_gpu_count() as u32;
    let suggested   = match gpu_count {
        0 => "cpu".to_string(),
        1 => "0".to_string(),
        _ => "0,1".to_string(),
    };
    Ok(RuntimeCapabilities {
        hardware_accel_available: !hw_encoders.is_empty(),
        available_hw_encoders: hw_encoders,
        detected_gpu_count: gpu_count,
        suggested_realcugan_gpu: suggested,
    })
}

// ─────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sleep(Duration::from_millis(2500)).await;
                if let Some(main) = handle.get_webview_window("main") {
                    if let Ok(Some(monitor)) = main.current_monitor() {
                        let size  = monitor.size();
                        let scale = monitor.scale_factor();
                        let w = ((size.width  as f64 / scale) - 24.0).clamp(1180.0, 1300.0);
                        let h = ((size.height as f64 / scale) - 24.0).clamp(760.0,  1205.0);
                        let _ = main.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
                        let _ = main.center();
                    }
                    let _ = main.show();
                    let _ = main.set_focus();
                }
                if let Some(boot) = handle.get_webview_window("boot") {
                    let _ = boot.close();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_job,
            list_jobs,
            start_job_or_batch,
            pause_job,
            resume_job,
            cancel_job,
            retry_job,
            clear_done_jobs,
            remove_job,
            update_job_settings,
            analyze_file,
            scan_dvd_subtitle_tracks,
            extract_dvd_subtitle_tracks,
            load_dvd_sub_images,
            start_dvd_ocr,
            ocr_dvd_sub_line,
            list_ocr_user_replacements,
            upsert_ocr_user_replacement,
            record_ocr_correction,
            export_dvd_ocr_srt,
            preview_frame,
            resolve_video_inputs,
            get_runtime_capabilities,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}