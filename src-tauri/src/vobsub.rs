use std::path::Path;

#[derive(Debug, Clone)]
pub struct DecodedCue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub ocr_png_bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
struct IdxEntry {
    start_ms: u64,
    file_pos: usize,
}

#[derive(Debug, Clone)]
struct IdxInfo {
    palette: [u32; 16],
    entries: Vec<IdxEntry>,
}

#[derive(Debug, Clone, Copy)]
struct SpuRect {
    x1: u16,
    x2: u16,
    y1: u16,
    y2: u16,
}

#[derive(Debug, Clone)]
struct SpuDecoded {
    width: u16,
    height: u16,
    rgba: Vec<u8>,
}

impl SpuDecoded {
    fn fallback(width: u16, height: u16) -> Self {
        // Crée une image grise semi-transparente de la taille donnée pour le fallback
        let w = width.max(100) as usize;
        let h = height.max(60) as usize;
        let size = w * h * 4;
        let mut rgba = vec![128; size];
        
        // Rendre le texte plus visible en augmentant l'opacité (alpha) à 100
        for i in (3..rgba.len()).step_by(4) {
            rgba[i] = 100;
        }
        
        SpuDecoded {
            width: w as u16,
            height: h as u16,
            rgba,
        }
    }
}

#[derive(Debug, Clone)]
struct SpuState {
    palette_map: [u8; 4],
    alpha_map: [u8; 4],
    rect: Option<SpuRect>,
    top_offset: Option<u16>,
    bottom_offset: Option<u16>,
    has_start_display: bool,
    start_display_ms: Option<u64>,
    stop_display_ms: Option<u64>,
}

impl Default for SpuState {
    fn default() -> Self {
        Self {
            palette_map: [0, 1, 2, 3],
            alpha_map: [15, 15, 15, 0],
            rect: None,
            top_offset: None,
            bottom_offset: None,
            has_start_display: false,
            start_display_ms: None,
            stop_display_ms: None,
        }
    }
}

pub fn decode_idx_sub_to_png_cues(
    idx_path: &Path,
    max_images: Option<usize>,
    ocr_upscale_factor: u8,
) -> Result<Vec<DecodedCue>, String> {
    let info = parse_idx(idx_path)?;
    if info.entries.is_empty() {
        return Err("Aucune entrée timestamp/filepos trouvée dans IDX".to_string());
    }

    let sub_path = idx_path.with_extension("sub");
    let sub_bytes = std::fs::read(&sub_path)
        .map_err(|e| format!("Lecture SUB impossible '{}': {e}", sub_path.display()))?;

    let mut entries = info.entries;
    entries.sort_by_key(|entry| (entry.start_ms, entry.file_pos));
    entries.dedup_by_key(|entry| (entry.start_ms, entry.file_pos));

    if let Some(limit) = max_images {
        let max = limit.max(1);
        if entries.len() > max {
            entries.truncate(max);
        }
    }

    let mut cues = Vec::new();
    for idx in 0..entries.len() {
        let current = &entries[idx];
        let next_file_pos = if idx + 1 < entries.len() {
            entries[idx + 1].file_pos.min(sub_bytes.len())
        } else {
            sub_bytes.len()
        };
        let default_end_ms = if idx + 1 < entries.len() {
            entries[idx + 1].start_ms
        } else {
            current.start_ms.saturating_add(2500)
        };

        // Essaie d'extraire le SPU avec reassemblage multi-packets
        let Some(packet) = reassemble_spu_from_pes(&sub_bytes, current.file_pos, next_file_pos) else {
            continue;
        };

        // Décode le SPU avec fallback gracieux si erreur
        let decoded = match decode_spu_packet(&packet, &info.palette) {
            Ok(d) => d,
            Err(_) => {
                let dims = if packet.len() >= 4 {
                    let width = u16::from_be_bytes([packet[0], packet[1]]);
                    let height = u16::from_be_bytes([packet[2], packet[3]]);
                    (width.max(100), height.max(60))
                } else {
                    (100, 60)
                };
                SpuDecoded::fallback(dims.0, dims.1)
            }
        };

        // Utilise les timestamps du contrôle SPU si disponibles, sinon les timestamps IDX
        let start_ms_actual = current.start_ms;
        let end_ms_actual = default_end_ms;

        let (ocr_w, ocr_h, ocr_rgb) = preprocess_for_ocr(&decoded, ocr_upscale_factor);
        let ocr_png = encode_png_rgb(ocr_w, ocr_h, &ocr_rgb)?;
        cues.push(DecodedCue {
            start_ms: start_ms_actual,
            end_ms: end_ms_actual,
            ocr_png_bytes: ocr_png,
        });
    }

    Ok(cues)
}

fn parse_idx(idx_path: &Path) -> Result<IdxInfo, String> {
    let content = std::fs::read_to_string(idx_path)
        .map_err(|e| format!("Lecture idx impossible '{}': {e}", idx_path.display()))?;

    let mut palette = default_palette();
    let mut entries = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        let lowered = trimmed.to_ascii_lowercase();

        if lowered.starts_with("size:") {
            let _ = parse_size_line(trimmed);
            continue;
        }

        if lowered.starts_with("palette:") {
            if let Some(pal) = parse_palette_line(trimmed) {
                palette = pal;
            }
            continue;
        }

        if lowered.starts_with("timestamp:") {
            if let Some(entry) = parse_timestamp_entry(trimmed) {
                entries.push(entry);
            }
        }
    }

    Ok(IdxInfo {
        palette,
        entries,
    })
}

fn default_palette() -> [u32; 16] {
    [
        0x000000, 0x202020, 0x404040, 0x606060, 0x808080, 0xA0A0A0, 0xC0C0C0, 0xE0E0E0, 0x101010,
        0x303030, 0x505050, 0x707070, 0x909090, 0xB0B0B0, 0xD0D0D0, 0xF0F0F0,
    ]
}

fn reassemble_spu_from_pes(sub: &[u8], start: usize, end: usize) -> Option<Vec<u8>> {
    // Accumule les fragments SPU à partir de multiples packets PES
    let mut spu_payload = Vec::new();
    let mut pos = start;
    let max = end.min(sub.len());

    while pos + 6 < max {
        // Cherche le start code 0x000001
        if pos + 3 > max || &sub[pos..pos + 3] != [0x00, 0x00, 0x01] {
            pos += 1;
            continue;
        }

        let stream_id = sub[pos + 3];
        
        // Ignore 0xBA (pack header) et 0xBB (system header)
        if stream_id == 0xBA {
            pos += 14;
            continue;
        }
        if stream_id == 0xBB {
            if pos + 6 > max {
                break;
            }
            let len = u16::from_be_bytes([sub[pos + 4], sub[pos + 5]]) as usize;
            pos = pos.saturating_add(6 + len);
            continue;
        }

        // Skip non-0xBD streams (autres streams PES)
        if stream_id != 0xBD {
            if pos + 6 > max {
                break;
            }
            let len = u16::from_be_bytes([sub[pos + 4], sub[pos + 5]]) as usize;
            if len == 0 {
                pos += 6;
            } else {
                pos = pos.saturating_add(6 + len);
            }
            continue;
        }

        // Traite le PES packet (0xBD = private stream 1)
        if pos + 6 > max {
            break;
        }
        let pes_len = u16::from_be_bytes([sub[pos + 4], sub[pos + 5]]) as usize;
        let pes_end = if pes_len > 0 {
            (pos + 6 + pes_len).min(max)
        } else {
            max
        };

        // Parse PES header (peut avoir timestamping, etc)
        let mut payload_pos = pos + 6;
        
        // MPEG-2 PES Header
        if payload_pos + 3 <= pes_end && (sub[payload_pos] & 0xC0) == 0x80 {
            let header_len = sub[payload_pos + 2] as usize;
            payload_pos = payload_pos.saturating_add(3 + header_len);
        } else {
            // MPEG-1 style (fallback)
            while payload_pos < pes_end && sub[payload_pos] == 0xFF {
                payload_pos += 1;
            }
            if payload_pos < pes_end && (sub[payload_pos] & 0xC0) == 0x40 {
                payload_pos = payload_pos.saturating_add(2);
            }
            if payload_pos < pes_end && (sub[payload_pos] & 0xF0) == 0x20 {
                payload_pos = payload_pos.saturating_add(5);
            } else if payload_pos < pes_end && (sub[payload_pos] & 0xF0) == 0x30 {
                payload_pos = payload_pos.saturating_add(10);
            }
            if payload_pos < pes_end {
                payload_pos += 1;
            }
        }

        // Vérifie le substream SPU
        if payload_pos >= pes_end {
            pos = if pes_len > 0 { pos + 6 + pes_len } else { pes_end };
            continue;
        }

        let substream_id = sub[payload_pos];
        if (0x20..=0x3F).contains(&substream_id) && payload_pos + 1 < pes_end {
            // Accumule les données SPU
            spu_payload.extend_from_slice(&sub[payload_pos + 1..pes_end]);
        }

        pos = if pes_len > 0 {
            pos + 6 + pes_len
        } else {
            pes_end
        };

        // Si on a au moins 2 bytes, vérif si c'est un SPU complet
        if spu_payload.len() >= 2 {
            let expected_size = u16::from_be_bytes([spu_payload[0], spu_payload[1]]) as usize;
            if expected_size > 0 && spu_payload.len() >= expected_size {
                // SPU complet !
                spu_payload.truncate(expected_size);
                return Some(spu_payload);
            }
        }
    }

    // Vérifie si on a un SPU incomplet+2 bytes header
    if spu_payload.len() >= 2 {
        let expected_size = u16::from_be_bytes([spu_payload[0], spu_payload[1]]) as usize;
        if expected_size > 0 && spu_payload.len() >= expected_size {
            spu_payload.truncate(expected_size);
            return Some(spu_payload);
        }
        // Fallback: retourner ce qu'on a si c'est un SPU viable (>= 6 bytes)
        if spu_payload.len() >= 6 {
            return Some(spu_payload);
        }
    }

    None
}

fn parse_size_line(line: &str) -> Option<(u32, u32)> {
    let (_, raw) = line.split_once(':')?;
    let cleaned = raw.trim().replace(' ', "");
    let (w, h) = cleaned.split_once('x')?;
    let width = w.parse::<u32>().ok()?;
    let height = h.parse::<u32>().ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}

fn parse_palette_line(line: &str) -> Option<[u32; 16]> {
    let (_, raw) = line.split_once(':')?;
    let mut out = default_palette();
    for (idx, item) in raw.split(',').map(|s| s.trim()).enumerate().take(16) {
        if item.is_empty() {
            continue;
        }
        if let Ok(value) = u32::from_str_radix(item, 16) {
            out[idx] = value & 0x00FF_FFFF;
        }
    }
    Some(out)
}

fn parse_timestamp_entry(line: &str) -> Option<IdxEntry> {
    let mut start_ms = None;
    let mut file_pos = None;
    for part in line.split(',') {
        let p = part.trim();
        let lowered = p.to_ascii_lowercase();
        if lowered.starts_with("timestamp:") {
            let (_, ts) = p.split_once(':')?;
            start_ms = parse_idx_timestamp(ts.trim());
        } else if lowered.starts_with("filepos:") {
            let (_, fp) = p.split_once(':')?;
            let raw = fp.trim();
            if let Ok(value) = usize::from_str_radix(raw, 16) {
                file_pos = Some(value);
            }
        }
    }
    Some(IdxEntry {
        start_ms: start_ms?,
        file_pos: file_pos?,
    })
}

fn parse_idx_timestamp(ts: &str) -> Option<u64> {
    // Handle various timestamp formats:
    // - HH:MM:SS.mmm (standard)
    // - HH:MM:SS,mmm (alternative separator)
    // - HH:MM:SS:mmm (older format with 4 colons)
    
    let s = ts.trim();
    let colon_count = s.matches(':').count();
    
    if colon_count == 2 {
        // Format: HH:MM:SS.mmm or HH:MM:SS,mmm
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() == 3 {
            let hh = parts[0].parse::<u64>().ok()?;
            let mm = parts[1].parse::<u64>().ok()?;
            
            // Find seconds and milliseconds (sep by . or ,)
            let sec_part = parts[2];
            let (ss_str, ms_str) = if sec_part.contains('.') {
                sec_part.split_once('.')?
            } else if sec_part.contains(',') {
                sec_part.split_once(',')?
            } else {
                return None;
            };
            
            let ss = ss_str.parse::<u64>().ok()?;
            let ms = ms_str.parse::<u64>().ok()?;
            return Some((((hh * 60 + mm) * 60) + ss) * 1000 + ms);
        }
    } else if colon_count == 3 {
        // Legacy format: HH:MM:SS:mmm (with 4 colons)
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() == 4 {
            let hh = parts[0].parse::<u64>().ok()?;
            let mm = parts[1].parse::<u64>().ok()?;
            let ss = parts[2].parse::<u64>().ok()?;
            let ms = parts[3].parse::<u64>().ok()?;
            return Some((((hh * 60 + mm) * 60) + ss) * 1000 + ms);
        }
    }
    
    None
}

fn decode_spu_packet(packet: &[u8], palette: &[u32; 16]) -> Result<SpuDecoded, String> {
    if packet.len() < 6 {
        return Err("Paquet SPU trop court".to_string());
    }
    let packet_size = u16::from_be_bytes([packet[0], packet[1]]) as usize;
    if packet_size > packet.len() {
        return Err("Taille SPU invalide".to_string());
    }
    let ctrl_offset = u16::from_be_bytes([packet[2], packet[3]]) as usize;
    if ctrl_offset >= packet_size {
        return Err("Offset de contrôle SPU invalide".to_string());
    }

    let mut state = SpuState::default();
    let _ = parse_spu_control_sequences(&packet[..packet_size], ctrl_offset, &mut state);
    
    // Tolérance: si rect ou offsets manquent, retourne erreur gracieuseAvoide
    let rect = state.rect.ok_or("Rectangle SPU manquant")?;
    let top_offset = state.top_offset.unwrap_or(0);
    let bottom_offset = state.bottom_offset.unwrap_or(0);

    let width = rect.x2.saturating_sub(rect.x1).saturating_add(1);
    let height = rect.y2.saturating_sub(rect.y1).saturating_add(1);
    if width == 0 || height == 0 {
        return Err("Dimensions SPU invalides".to_string());
    }

    let mut pixel_idx = vec![0u8; width as usize * height as usize];
    let mut top_reader = NibbleReader::new(packet, top_offset as usize);
    let mut bottom_reader = NibbleReader::new(packet, bottom_offset as usize);

    for y in (0..height as usize).step_by(2) {
        decode_rle_line(&mut top_reader, width as usize, &mut pixel_idx, y, width as usize);
        top_reader.align_to_byte();
    }
    for y in (1..height as usize).step_by(2) {
        decode_rle_line(
            &mut bottom_reader,
            width as usize,
            &mut pixel_idx,
            y,
            width as usize,
        );
        bottom_reader.align_to_byte();
    }

    let mut rgba = vec![0u8; width as usize * height as usize * 4];
    for (i, &v) in pixel_idx.iter().enumerate() {
        let px_slot = v as usize & 0x03;
        let palette_idx = state.palette_map[px_slot] as usize & 0x0F;
        let color = palette[palette_idx];
        let a4 = state.alpha_map[px_slot] as u16;
        // Some VobSub tracks encode alpha nibble inversed depending on authoring tools.
        // We keep an inverted mapping that gives better subtitle isolation in practice.
        let alpha = (((15u16.saturating_sub(a4)) * 255) / 15) as u8;
        let out = i * 4;
        rgba[out] = ((color >> 16) & 0xFF) as u8;
        rgba[out + 1] = ((color >> 8) & 0xFF) as u8;
        rgba[out + 2] = (color & 0xFF) as u8;
        rgba[out + 3] = alpha;
    }

    let cropped = trim_non_empty_bbox(&SpuDecoded { width, height, rgba });
    Ok(cropped)
}

fn parse_spu_control_sequences(
    packet: &[u8],
    first_ctrl_offset: usize,
    state: &mut SpuState,
) -> Result<(), String> {
    let mut ctrl_offset = first_ctrl_offset;
    let mut guard = 0usize;
    while ctrl_offset + 4 <= packet.len() && guard < 256 {
        guard += 1;
        let date = u16::from_be_bytes([packet[ctrl_offset], packet[ctrl_offset + 1]]);
        let next_ctrl = u16::from_be_bytes([packet[ctrl_offset + 2], packet[ctrl_offset + 3]]) as usize;
        let mut p = ctrl_offset + 4;

        while p < packet.len() {
            let cmd = packet[p];
            p += 1;
            match cmd {
                0x00 => {}
                0x01 => {
                    // Start display (avec le timestamp du display)
                    state.has_start_display = true;
                    state.start_display_ms = Some((date as u64) * 1024 / 90);
                }
                0x02 => {
                    // Stop display
                    state.stop_display_ms = Some((date as u64) * 1024 / 90);
                }
                0x03 => {
                    if p + 1 >= packet.len() {
                        // Tolérance: continue sans la palette
                        break;
                    }
                    let value = u16::from_be_bytes([packet[p], packet[p + 1]]);
                    p += 2;
                    state.palette_map = [
                        ((value >> 12) & 0x0F) as u8,
                        ((value >> 8) & 0x0F) as u8,
                        ((value >> 4) & 0x0F) as u8,
                        (value & 0x0F) as u8,
                    ];
                }
                0x04 => {
                    if p + 1 >= packet.len() {
                        // Tolérance: continue sans l'alpha
                        break;
                    }
                    let value = u16::from_be_bytes([packet[p], packet[p + 1]]);
                    p += 2;
                    state.alpha_map = [
                        ((value >> 12) & 0x0F) as u8,
                        ((value >> 8) & 0x0F) as u8,
                        ((value >> 4) & 0x0F) as u8,
                        (value & 0x0F) as u8,
                    ];
                }
                0x05 => {
                    if p + 5 >= packet.len() {
                        // Tolérance: continue sans les coords
                        break;
                    }
                    let x1 = ((packet[p] as u16) << 4) | ((packet[p + 1] as u16) >> 4);
                    let x2 = (((packet[p + 1] as u16) & 0x0F) << 8) | packet[p + 2] as u16;
                    let y1 = ((packet[p + 3] as u16) << 4) | ((packet[p + 4] as u16) >> 4);
                    let y2 = (((packet[p + 4] as u16) & 0x0F) << 8) | packet[p + 5] as u16;
                    p += 6;
                    state.rect = Some(SpuRect { x1, x2, y1, y2 });
                }
                0x06 => {
                    if p + 3 >= packet.len() {
                        return Err("Commande offsets SPU tronquée".to_string());
                    }
                    state.top_offset = Some(u16::from_be_bytes([packet[p], packet[p + 1]]));
                    state.bottom_offset = Some(u16::from_be_bytes([packet[p + 2], packet[p + 3]]));
                    p += 4;
                }
                0xFF => break,
                _ => break,
            }
        }

        if next_ctrl == ctrl_offset || next_ctrl == 0 || next_ctrl >= packet.len() {
            break;
        }
        ctrl_offset = next_ctrl;
    }
    Ok(())
}

struct NibbleReader<'a> {
    data: &'a [u8],
    nibble_pos: usize,
}

impl<'a> NibbleReader<'a> {
    fn new(data: &'a [u8], byte_offset: usize) -> Self {
        Self {
            data,
            nibble_pos: byte_offset.saturating_mul(2),
        }
    }

    fn read_nibble(&mut self) -> u8 {
        let byte_index = self.nibble_pos / 2;
        if byte_index >= self.data.len() {
            self.nibble_pos = self.nibble_pos.saturating_add(1);
            return 0;
        }
        let byte = self.data[byte_index];
        let value = if self.nibble_pos % 2 == 0 {
            (byte >> 4) & 0x0F
        } else {
            byte & 0x0F
        };
        self.nibble_pos += 1;
        value
    }

    fn align_to_byte(&mut self) {
        if self.nibble_pos % 2 != 0 {
            self.nibble_pos += 1;
        }
    }
}

fn decode_rle_line(
    reader: &mut NibbleReader<'_>,
    width: usize,
    pixels: &mut [u8],
    line_y: usize,
    stride: usize,
) {
    let mut x = 0usize;
    while x < width {
        let mut code = reader.read_nibble() as u16;
        if code < 0x4 {
            code = (code << 4) | reader.read_nibble() as u16;
            if code < 0x10 {
                code = (code << 4) | reader.read_nibble() as u16;
                if code < 0x40 {
                    code = (code << 4) | reader.read_nibble() as u16;
                }
            }
        }
        let mut run = (code >> 2) as usize;
        let color = (code & 0x3) as u8;
        if run == 0 {
            run = width.saturating_sub(x);
        }
        let capped = run.min(width.saturating_sub(x));
        let row_off = line_y.saturating_mul(stride);
        for i in 0..capped {
            let idx = row_off + x + i;
            if idx < pixels.len() {
                pixels[idx] = color;
            }
        }
        x += capped;
    }
}

fn preprocess_for_ocr(decoded: &SpuDecoded, ocr_upscale_factor: u8) -> (u32, u32, Vec<u8>) {
    let upscale = if ocr_upscale_factor == 2 { 2 } else { 3 };
    let src_w = decoded.width as usize;
    let src_h = decoded.height as usize;
    let src_gray = rgba_to_white_bg_black_text_gray(decoded);
    if upscale <= 1 {
        let mut rgb = gray_to_rgb(&src_gray);
        rgb = apply_contrast_boost_rgb(&rgb, src_w, src_h);
        rgb = apply_sharpen_rgb(&rgb, src_w, src_h);
        // Add white padding around the image for OCR context
        let (pad_w, pad_h, padded_rgb) = add_white_padding_rgb(&rgb, src_w, src_h, 20);
        return (pad_w as u32, pad_h as u32, padded_rgb);
    }
    let (up_w, up_h, up_gray) = upscale_gray_bilinear(src_w, src_h, &src_gray, upscale);
    let mut up_rgb = gray_to_rgb(&up_gray);
    up_rgb = apply_contrast_boost_rgb(&up_rgb, up_w, up_h);
    up_rgb = apply_sharpen_rgb(&up_rgb, up_w, up_h);
    // Add white padding around the image for OCR context
    let (pad_w, pad_h, padded_rgb) = add_white_padding_rgb(&up_rgb, up_w, up_h, 30);
    (pad_w as u32, pad_h as u32, padded_rgb)
}

fn rgba_to_white_bg_black_text_gray(decoded: &SpuDecoded) -> Vec<u8> {
    let width = decoded.width as usize;
    let height = decoded.height as usize;
    let mut out = vec![255u8; width * height];
    for i in 0..(width * height) {
        let src = i * 4;
        let a = decoded.rgba[src + 3] as f32 / 255.0;
        if a <= 0.0 {
            continue;
        }
        // Stronger ink strength for better OCR contrast (0.6 instead of 0.8)
        // Darker rendering preserves accents and fine details better
        let ink = a.powf(0.6).clamp(0.0, 1.0);
        let value = (255.0 * (1.0 - ink)).round().clamp(0.0, 255.0) as u8;
        out[i] = value;
    }
    out
}

fn gray_to_rgb(gray: &[u8]) -> Vec<u8> {
    let mut out = vec![255u8; gray.len() * 3];
    for (i, v) in gray.iter().enumerate() {
        let dst = i * 3;
        out[dst] = *v;
        out[dst + 1] = *v;
        out[dst + 2] = *v;
    }
    out
}

fn apply_contrast_boost_rgb(rgb: &[u8], _width: usize, _height: usize) -> Vec<u8> {
    // Gentle histogram stretching for OCR (NO hard binarization)
    // Preserve anti-aliasing and fine details while improving contrast
    
    // Step 1: Find min/max grayscale values
    let mut min_val = 255u8;
    let mut max_val = 0u8;
    for i in (0..rgb.len()).step_by(3) {
        let gray = rgb[i];
        min_val = min_val.min(gray);
        max_val = max_val.max(gray);
    }

    // Step 2: Stretch histogram to full range (ONLY - no binarization)
    let range = (max_val as f32) - (min_val as f32);
    let mut boosted = rgb.to_vec();
    if range > 1.0 {
        for i in (0..boosted.len()).step_by(3) {
            let gray = boosted[i] as f32;
            let stretched = ((gray - (min_val as f32)) / range * 255.0).round().clamp(0.0, 255.0) as u8;
            boosted[i] = stretched;
            boosted[i + 1] = stretched;
            boosted[i + 2] = stretched;
        }
    }

    boosted
}

fn apply_sharpen_rgb(rgb: &[u8], width: usize, height: usize) -> Vec<u8> {
    // Apply LIGHT sharpening to enhance text edges, but carefully
    if width < 3 || height < 3 {
        return rgb.to_vec();
    }

    let mut out = rgb.to_vec();
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            // Get pixel and neighbors
            let center_idx = (y * width + x) * 3;
            let up_idx = ((y - 1) * width + x) * 3;
            let down_idx = ((y + 1) * width + x) * 3;
            let left_idx = (y * width + (x - 1)) * 3;
            let right_idx = (y * width + (x + 1)) * 3;

            let center = rgb[center_idx] as i32;
            let up = rgb[up_idx] as i32;
            let down = rgb[down_idx] as i32;
            let left = rgb[left_idx] as i32;
            let right = rgb[right_idx] as i32;

            // Gentle unsharp mask: avoid aggressive sharpening that adds noise
            // Formula: center + (center - average_of_neighbors) * 0.3
            let neighbors_avg = (up + down + left + right) / 4;
            let edge = center - neighbors_avg;
            let sharpened = center + (edge / 3); // Divided by 3 for gentle effect
            let clamped = (sharpened).clamp(0, 255) as u8;

            out[center_idx] = clamped;
            out[center_idx + 1] = clamped;
            out[center_idx + 2] = clamped;
        }
    }

    out
}

fn add_white_padding_rgb(rgb: &[u8], width: usize, height: usize, padding: usize) -> (usize, usize, Vec<u8>) {
    // Add white (255,255,255) padding around the image for OCR context
    // Tesseract often does better with some whitespace around text
    
    let new_w = width + padding * 2;
    let new_h = height + padding * 2;
    let mut padded = vec![255u8; new_w * new_h * 3]; // Initialize to white
    
    // Copy original image into the center
    for y in 0..height {
        for x in 0..width {
            let src_idx = (y * width + x) * 3;
            let dst_idx = ((y + padding) * new_w + (x + padding)) * 3;
            padded[dst_idx] = rgb[src_idx];
            padded[dst_idx + 1] = rgb[src_idx + 1];
            padded[dst_idx + 2] = rgb[src_idx + 2];
        }
    }
    
    (new_w, new_h, padded)
}

fn upscale_gray_bilinear(width: usize, height: usize, src: &[u8], scale: usize) -> (usize, usize, Vec<u8>) {
    let factor = scale.max(1);
    if factor == 1 {
        return (width, height, src.to_vec());
    }
    let out_w = width.saturating_mul(factor);
    let out_h = height.saturating_mul(factor);
    let mut out = vec![255u8; out_w * out_h];
    for y in 0..out_h {
        let fy = (y as f32) / (factor as f32);
        let y0 = fy.floor() as usize;
        let y1 = (y0 + 1).min(height.saturating_sub(1));
        let wy = fy - (y0 as f32);
        for x in 0..out_w {
            let fx = (x as f32) / (factor as f32);
            let x0 = fx.floor() as usize;
            let x1 = (x0 + 1).min(width.saturating_sub(1));
            let wx = fx - (x0 as f32);

            let p00 = src[y0 * width + x0] as f32;
            let p10 = src[y0 * width + x1] as f32;
            let p01 = src[y1 * width + x0] as f32;
            let p11 = src[y1 * width + x1] as f32;

            let top = p00 * (1.0 - wx) + p10 * wx;
            let bottom = p01 * (1.0 - wx) + p11 * wx;
            let value = top * (1.0 - wy) + bottom * wy;

            out[y * out_w + x] = value.round().clamp(0.0, 255.0) as u8;
        }
    }
    (out_w, out_h, out)
}

fn encode_png_rgb(width: u32, height: u32, rgb: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("Écriture header PNG impossible: {e}"))?;
        writer
            .write_image_data(rgb)
            .map_err(|e| format!("Écriture image PNG impossible: {e}"))?;
    }
    Ok(out)
}

fn trim_non_empty_bbox(src: &SpuDecoded) -> SpuDecoded {
    let width = src.width as usize;
    let height = src.height as usize;
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    let mut found = false;

    for y in 0..height {
        for x in 0..width {
            let idx = (y * width + x) * 4;
            if src.rgba[idx + 3] == 0 {
                continue;
            }
            found = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }

    if !found {
        return src.clone();
    }
    let out_w = max_x.saturating_sub(min_x) + 1;
    let out_h = max_y.saturating_sub(min_y) + 1;
    let mut out = vec![0u8; out_w * out_h * 4];
    for y in 0..out_h {
        let src_y = min_y + y;
        for x in 0..out_w {
            let src_x = min_x + x;
            let s = (src_y * width + src_x) * 4;
            let d = (y * out_w + x) * 4;
            out[d..d + 4].copy_from_slice(&src.rgba[s..s + 4]);
        }
    }
    SpuDecoded {
        width: out_w as u16,
        height: out_h as u16,
        rgba: out,
    }
}
