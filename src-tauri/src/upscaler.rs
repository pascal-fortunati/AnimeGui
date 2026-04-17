use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::OnceLock;

use tokio::fs;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration, Instant};

use crate::app_paths::ToolPaths;
use crate::command_utils::{std_command, tokio_command};
use crate::models::{JobStatus, ProcessingSettings};

// Erreur d'annulation de job
pub const JOB_CANCELED: &str = "__JOB_CANCELED__";
pub const JOB_PAUSED:   &str = "__JOB_PAUSED__";
static GPU_COUNT_CACHE: OnceLock<usize> = OnceLock::new();

// Compatibilité de modèle
fn allowed_denoise_levels(model: &str, scale: u8) -> Option<&'static [i8]> {
    match (model, scale) {
        ("models-se",   2) => Some(&[-1, 0, 1, 2, 3]),
        ("models-se",   3) => Some(&[-1, 0, 3]),
        ("models-se",   4) => Some(&[-1, 0, 3]),
        ("models-pro",  2) => Some(&[-1, 0, 3]),
        ("models-pro",  3) => Some(&[-1, 0, 3]),
        ("models-nose", 2) => Some(&[-1]),
        _                  => None,
    }
}

// Validation des paramètres de RealCUGAN
pub fn validate_realcugan_settings(settings: &ProcessingSettings) -> Result<(), String> {
    let model   = settings.realcugan_model.as_str();
    let scale   = settings.upscale_factor;
    let denoise = settings.denoise_level;

    let allowed = allowed_denoise_levels(model, scale).ok_or_else(|| {
        format!("RealCUGAN: model='{model}' ne supporte pas scale='{scale}'")
    })?;

    if !allowed.contains(&denoise) {
        return Err(format!(
            "RealCUGAN: model='{model}' scale='{scale}' n'accepte pas denoise='{denoise}'"
        ));
    }

    // Validation de la configuration GPU
    // Le champ GPU doit être vide, "auto", "cpu" ou une liste de nombres non négatifs (par exemple " "0,1").
    let gpu = settings.realcugan_gpu.trim();
    if !gpu.is_empty() {
        let is_keyword = matches!(gpu, "auto" | "cpu");
        let is_id_list = !gpu.is_empty()
            && gpu.split(',').all(|part| part.trim().parse::<u32>().is_ok());
        if !is_keyword && !is_id_list {
            return Err(format!(
                "RealCUGAN: gpu='{gpu}' invalide (attendu: auto, cpu, ou liste comme 0,1)"
            ));
        }
    }

    Ok(())
}

// Détection du nombre de GPUs disponibles
pub fn detect_available_gpu_count() -> usize {
    *GPU_COUNT_CACHE.get_or_init(|| {
        #[cfg(target_os = "windows")]
        {
            let result = std_command("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    "(Get-CimInstance Win32_VideoController \
                     | Where-Object { $_.Name -and \
                       $_.Name -notmatch 'Microsoft Basic|Remote Display Adapter' \
                     }).Count",
                ])
                .output();

            if let Ok(out) = result {
                if let Ok(n) = String::from_utf8_lossy(&out.stdout).trim().parse::<usize>() {
                    return n;
                }
            }
            0
        }
        #[cfg(not(target_os = "windows"))]
        {
            0
        }
    })
}

// Résolution de la configuration GPU
fn resolve_gpu_target(settings: &ProcessingSettings) -> String {
    let raw = settings.realcugan_gpu.trim();

    if raw.eq_ignore_ascii_case("cpu") {
        return "-1".to_string();
    }

    if raw.is_empty() || raw.eq_ignore_ascii_case("auto") {
        // Si aucun GPU n'est disponible, utilisez CPU
        return if detect_available_gpu_count() >= 1 {
            "0".to_string()
        } else {
            "-1".to_string()
        };
    }

    raw.to_string()
}

// Résolution de la configuration de RealCUGAN
pub fn resolve_realcugan_runtime(settings: &ProcessingSettings) -> (String, String) {
    (
        resolve_gpu_target(settings),
        settings.realcugan_threads.trim().to_string(),
    )
}

// Ajout des arguments de RealCUGAN à la commande FFmpeg
pub fn apply_realcugan_runtime_args(command: &mut Command, settings: &ProcessingSettings) {
    let (gpu, threads) = resolve_realcugan_runtime(settings);
    append_gpu_and_threads(command, &gpu, &threads);
}

// Ajout des arguments de RealCUGAN à la commande FFmpeg avec une configuration GPU pré-resolue
fn apply_runtime_args_with_gpu(command: &mut Command, settings: &ProcessingSettings, gpu: &str) {
    let threads = settings.realcugan_threads.trim();
    append_gpu_and_threads(command, gpu, threads);
}

// Ajout des arguments de `-g` et `-j` à une commande FFmpeg
fn append_gpu_and_threads(command: &mut Command, gpu: &str, threads: &str) {
    command.arg("-g").arg(gpu);
    if !threads.is_empty() {
        command.arg("-j").arg(threads);
    }
}

// Génération de la liste de fallback GPU
fn gpu_fallback_candidates(default_gpu: &str) -> Vec<String> {
    let mut candidates = vec![default_gpu.to_string()];

    // Si une liste de GPUs est donnée, essayez également le premier GPU de la liste.
    if default_gpu.contains(',') {
        if let Some(first) = default_gpu
            .split(',')
            .map(str::trim)
            .find(|v| !v.is_empty())
        {
            candidates.push(first.to_string());
        }
    }

    // Si aucun GPU n'est disponible, essayez également CPU.
    for fallback in ["0", "-1"] {
        if default_gpu != fallback {
            candidates.push(fallback.to_string());
        }
    }

    candidates.dedup();
    candidates
}

// Extraction de la valeur de tile-size pour le flag `-t` de RealCUGAN
fn tile_value(tile_size: &serde_json::Value) -> String {
    match tile_size {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0).to_string(),
        _ => "0".to_string(),
    }
}

// Compte le nombre de fichiers PNG (insensible à la casse) directement dans le répertoire donné
async fn count_png_files(dir: &Path) -> Result<u64, String> {
    let mut count = 0u64;
    let mut entries = fs::read_dir(dir).await.map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let is_png = entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("png"))
            .unwrap_or(false);
        if is_png {
            count += 1;
        }
    }
    Ok(count)
}

// Effectue l'upscale d'un répertoire d'images avec un GPU spécifique
pub async fn upscale_directory(
    tools: &ToolPaths,
    settings: &ProcessingSettings,
    input_frames_dir: &Path,
    output_frames_dir: &Path,
    job_id: &str,
    control_map: Arc<Mutex<HashMap<String, JobStatus>>>,
    mut on_progress: impl FnMut(u64, f64),
) -> Result<(), String> {
    validate_realcugan_settings(settings)?;

    let model = settings.realcugan_model.as_str();
    let tile  = tile_value(&settings.tile_size);

    let default_gpu   = resolve_gpu_target(settings);
    let gpu_candidates = gpu_fallback_candidates(&default_gpu);
    let total_attempts = gpu_candidates.len();

    for (attempt, gpu) in gpu_candidates.iter().enumerate() {
        // Si c'est une tentative de réessai, supprimez le répertoire de sortie et recrééz-le.
        if attempt > 0 {
            let _ = fs::remove_dir_all(output_frames_dir).await;
            fs::create_dir_all(output_frames_dir).await.map_err(|e| {
                format!(
                    "Impossible de recréer '{}': {e}",
                    output_frames_dir.display()
                )
            })?;
        }

        match try_upscale_with_gpu(
            tools,
            settings,
            model,
            &tile,
            gpu,
            input_frames_dir,
            output_frames_dir,
            job_id,
            &control_map,
            &mut on_progress,
        )
        .await
        {
            // Si l'upscale a réussi, retournez immédiatement.
            Ok(()) => return Ok(()),
            Err(e) if e == JOB_CANCELED || e == JOB_PAUSED => return Err(e),

            // Si l'upscale a échoué, essayez la prochain GPU si il existe.
            Err(_) if attempt + 1 < total_attempts => continue,

            // Si tous les candidats GPU ont échoué, retournez une erreur.
            Err(_) => {
                return Err(format!(
                    "RealCUGAN a échoué sur tous les GPU candidats (dernier: {gpu})"
                ))
            }
        }
    }

    // Si aucun GPU n'est disponible, retournez une erreur.
    Err("RealCUGAN: aucun candidat GPU disponible".to_string())
}

// Effectue l'upscale d'une directory d'images avec un GPU spécifique
async fn try_upscale_with_gpu(
    tools: &ToolPaths,
    settings: &ProcessingSettings,
    model: &str,
    tile: &str,
    gpu: &str,
    input_dir: &Path,
    output_dir: &Path,
    job_id: &str,
    control_map: &Arc<Mutex<HashMap<String, JobStatus>>>,
    on_progress: &mut impl FnMut(u64, f64),
) -> Result<(), String> {
    let mut cmd = tokio_command(&tools.realcugan_exe);
    cmd.current_dir(&tools.realcugan_dir)
        .arg("-i").arg(input_dir)
        .arg("-o").arg(output_dir)
        .arg("-s").arg(settings.upscale_factor.to_string())
        .arg("-n").arg(settings.denoise_level.to_string())
        .arg("-m").arg(model)
        .arg("-t").arg(tile);

    apply_runtime_args_with_gpu(&mut cmd, settings, gpu);
    if settings.tta_mode {
        cmd.arg("-x");
    }

    let mut child      = cmd.spawn().map_err(|e| e.to_string())?;
    let started_at     = Instant::now();
    let mut was_paused = false;

    loop {
        // Vérifiez le statut de la tâche.
        let job_status = {
            control_map
                .lock()
                .await
                .get(job_id)
                .cloned()
                .unwrap_or(JobStatus::Processing)
        };

        match job_status {
            JobStatus::Canceled => {
                let _ = child.kill().await;
                return Err(JOB_CANCELED.to_string());
            }
            JobStatus::Paused => was_paused = true,
            _ => {}
        }

        // Vérifiez si le processus a terminé.
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(exit) => {
                // Si le processus a terminé, comptez le nombre de fichiers PNG dans le répertoire de sortie.
                // Si l'upscale a réussi, retournez immédiatement.
                let count = count_png_files(output_dir).await?;
                on_progress(count, started_at.elapsed().as_secs_f64());

                if !exit.success() {
                    return Err(format!("RealCUGAN a échoué (gpu={gpu}, code={:?})", exit.code()));
                }
                if was_paused {
                    return Err(JOB_PAUSED.to_string());
                }
                return Ok(());
            }
            None => {
                // Si le processus n'a pas terminé, reportez la progression et yield.
                let count = count_png_files(output_dir).await?;
                on_progress(count, started_at.elapsed().as_secs_f64());
                sleep(Duration::from_millis(400)).await;
            }
        }
    }
}
