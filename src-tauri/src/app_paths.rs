use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ToolPaths {
    pub ffmpeg_exe: PathBuf,
    pub ffprobe_exe: PathBuf,
    pub realcugan_exe: PathBuf,
    pub realcugan_dir: PathBuf,
    pub mkvextract_exe: Option<PathBuf>,
    pub tesseract_exe: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct ToolLayout {
    ffmpeg_exe: PathBuf,
    ffprobe_exe: PathBuf,
    realcugan_dir: PathBuf,
    realcugan_exe: PathBuf,
    mkvextract_exe: PathBuf,
    tesseract_exe: PathBuf,
}

fn candidate_layouts(project_root: &Path) -> Vec<ToolLayout> {
    let tools_root = project_root.join("tools");
    let new_layout = ToolLayout {
        ffmpeg_exe: tools_root.join("ffmpeg").join("bin").join("ffmpeg.exe"),
        ffprobe_exe: tools_root.join("ffmpeg").join("bin").join("ffprobe.exe"),
        realcugan_dir: tools_root.join("realcugan"),
        realcugan_exe: tools_root.join("realcugan").join("realcugan-ncnn-vulkan.exe"),
        mkvextract_exe: tools_root.join("mkvextract").join("mkvextract.exe"),
        tesseract_exe: tools_root.join("tesseract").join("tesseract.exe"),
    };
    let legacy_layout = ToolLayout {
        ffmpeg_exe: project_root.join("ffmpeg").join("bin").join("ffmpeg.exe"),
        ffprobe_exe: project_root.join("ffmpeg").join("bin").join("ffprobe.exe"),
        realcugan_dir: project_root.join("realcugan"),
        realcugan_exe: project_root.join("realcugan").join("realcugan-ncnn-vulkan.exe"),
        mkvextract_exe: project_root.join("mkvextract").join("mkvextract.exe"),
        tesseract_exe: project_root.join("tesseract").join("tesseract.exe"),
    };
    vec![new_layout, legacy_layout]
}

fn resolve_layout(project_root: &Path) -> Option<ToolLayout> {
    candidate_layouts(project_root).into_iter().find(|layout| {
        layout.ffmpeg_exe.exists()
            && layout.ffprobe_exe.exists()
            && layout.realcugan_exe.exists()
    })
}

fn has_required_tools(project_root: &Path) -> bool {
    resolve_layout(project_root).is_some()
}

fn collect_candidate_roots(path: &Path, out: &mut Vec<PathBuf>) {
    for ancestor in path.ancestors() {
        let candidate = ancestor.to_path_buf();
        if !out.iter().any(|item| item == &candidate) {
            out.push(candidate);
        }
    }
}

pub fn resolve_project_root() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    collect_candidate_roots(&cwd, &mut candidates);

    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(exe_parent) = exe_path.parent() {
        collect_candidate_roots(exe_parent, &mut candidates);
    }

    for candidate in candidates {
        if has_required_tools(&candidate) {
            return Ok(candidate);
        }
    }

    Err("Impossible de localiser les outils (tools/ffmpeg + tools/realcugan) depuis le binaire actuel".to_string())
}

pub fn resolve_tool_paths() -> Result<ToolPaths, String> {
    let project_root = resolve_project_root()?;
    let Some(layout) = resolve_layout(&project_root) else {
        return Err(format!(
            "Outils introuvables dans '{}' (attendu: tools/ffmpeg/bin + tools/realcugan)",
            project_root.display()
        ));
    };

    if !layout.ffmpeg_exe.exists() {
        return Err(format!("FFmpeg introuvable: {}", layout.ffmpeg_exe.display()));
    }
    if !layout.ffprobe_exe.exists() {
        return Err(format!("FFprobe introuvable: {}", layout.ffprobe_exe.display()));
    }
    if !layout.realcugan_exe.exists() {
        return Err(format!(
            "RealCUGAN introuvable: {}",
            layout.realcugan_exe.display()
        ));
    }

    Ok(ToolPaths {
        ffmpeg_exe: layout.ffmpeg_exe,
        ffprobe_exe: layout.ffprobe_exe,
        realcugan_exe: layout.realcugan_exe,
        realcugan_dir: layout.realcugan_dir,
        mkvextract_exe: if layout.mkvextract_exe.exists() {
            Some(layout.mkvextract_exe)
        } else {
            None
        },
        tesseract_exe: if layout.tesseract_exe.exists() {
            Some(layout.tesseract_exe)
        } else {
            None
        },
    })
}
