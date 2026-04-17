import { useCallback, useEffect, useMemo, useState } from "react";
import { desktopDir, join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  exportDvdOcrSrt,
  extractDvdSubtitleTracks,
  loadDvdSubImages,
  listOcrUserReplacements,
  recordOcrCorrection,
  resolveVideoInputs,
  scanDvdSubtitleTracks,
  startDvdOcr,
} from "../../api";
import type {
  DvdOcrLine,
  DvdSubtitleExtractResult,
  DvdSubtitleTrackCandidate,
} from "../../types";
import { t } from "../../i18n";

interface DvdSubsContext {
  inputPaths?: string[];
  audioSelection?: string;
  subtitleSelection?: string;
  settings?: Record<string, any>;
  previewWindowLabel?: string;
}

interface DvdOcrProgressEvent {
  kind: "started" | "line" | "done";
  processed: number;
  total: number;
  line?: DvdOcrLine | null;
  message?: string | null;
}

const SUSPICIOUS_CHARACTERS = new Set([
  "�",
  "□",
  "■",
  "◆",
  "◇",
  "¤",
  "[",
  "]",
  "{",
  "}",
  "|",
]);

function collectUnknownTokens(text: string): string[] {
  const out: string[] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (!SUSPICIOUS_CHARACTERS.has(char)) {
      const prev = chars[i - 1] ?? "";
      const next = chars[i + 1] ?? "";
      const midWordUppercase =
        /[A-ZÀÂÄÇÉÈÊËÎÏÔÙÛÜŸ]/.test(char) &&
        /[a-zàâäçéèêëîïôùûüÿ]/.test(prev) &&
        /[a-zàâäçéèêëîïôùûüÿ]/.test(next);
      if (!midWordUppercase) {
        continue;
      }
    }
    if (!out.includes(char)) {
      out.push(char);
    }
  }
  if (text.includes("C'") && !out.includes("C'")) {
    out.push("C'");
  }
  if (text.trim() === "?" && !out.includes("?")) {
    out.push("?");
  }
  return out;
}

function renderOcrText(text: string) {
  const lines = text.split("\n");
  return lines.map((line, idx) => (
    <div key={idx} style={{ display: "inline" }}>
      {line}
      {idx < lines.length - 1 && <br />}
    </div>
  ));
}

function withUpdatedFlags(line: DvdOcrLine, text: string): DvdOcrLine {
  const unknown = collectUnknownTokens(text);
  return {
    ...line,
    ocr_text: text,
    unknown_tokens: unknown,
    needs_manual:
      text.trim().length === 0 || line.confidence < 70 || unknown.length > 0,
  };
}

function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function formatDurationMs(startMs: number, endMs: number): string {
  const delta = Math.max(0, endMs - startMs);
  const seconds = Math.floor(delta / 1000);
  const millis = delta % 1000;
  return `${seconds},${String(millis).padStart(3, "0")}`;
}

function unescapeNewlines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

function readStoredContext(): DvdSubsContext {
  try {
    const raw = localStorage.getItem("animegui-dvdsubs-context");
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as DvdSubsContext;
  } catch {
    return {};
  }
}

export function DvdSubtitleWindowPage() {
  const appWindow = getCurrentWindow();
  const [dvdSubsContext, setDvdSubsContext] = useState<DvdSubsContext | null>(null);
  const [inputPaths, setInputPaths] = useState<string[]>([]);
  const [outputDir, setOutputDir] = useState("");
  const [scanRows, setScanRows] = useState<DvdSubtitleTrackCandidate[]>([]);
  const [extractRows, setExtractRows] = useState<DvdSubtitleExtractResult[]>(
    [],
  );
  const [loadingScan, setLoadingScan] = useState(false);
  const [loadingExtract, setLoadingExtract] = useState(false);
  const [loadingOcr, setLoadingOcr] = useState(false);
  const [ocrCompleted, setOcrCompleted] = useState(false);
  const [log, setLog] = useState<string>("");
  const [ocrLines, setOcrLines] = useState<DvdOcrLine[]>([]);
  const [selectedLineId, setSelectedLineId] = useState<number | null>(null);
  const [selectedTrackKey, setSelectedTrackKey] = useState<string>("");
  const [ocrLanguage, setOcrLanguage] = useState("fra");
  const [ocrUpscaleFactor, setOcrUpscaleFactor] = useState<2 | 3>(3);
  const [manualText, setManualText] = useState("");
  const [ocrProgress, setOcrProgress] = useState<{
    processed: number;
    total: number;
  }>({ processed: 0, total: 0 });
  const [loadingSubImages, setLoadingSubImages] = useState(false);

  const hasTracks = scanRows.length > 0;
  const hasInput = inputPaths.length > 0;
  const sourceName = inputPaths[0]?.split("\\").pop() ?? "-";
  const extractOkCount = useMemo(
    () => extractRows.filter((item) => item.success).length,
    [extractRows],
  );
  const ocrReadyCount = extractRows.filter((item) => item.success).length;
  const selectedLine = useMemo(
    () => ocrLines.find((line) => line.id === selectedLineId) ?? null,
    [ocrLines, selectedLineId],
  );
  const manualCount = useMemo(
    () => ocrLines.filter((line) => line.needs_manual).length,
    [ocrLines],
  );
  const avgConfidence = useMemo(() => {
    if (ocrLines.length === 0) {
      return 0;
    }
    const sum = ocrLines.reduce((acc, line) => acc + line.confidence, 0);
    return Math.round(sum / ocrLines.length);
  }, [ocrLines]);

  const appendLog = useCallback((message: string) => {
    const at = new Date().toLocaleTimeString("fr-FR", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setLog((prev) => `${prev}\n[${at}] ${message}`.trim());
  }, []);

  useEffect(() => {
    const context = readStoredContext();
    setDvdSubsContext(context);
    const initialInputs = context.inputPaths ?? [];
    setInputPaths(initialInputs);
    void (async () => {
      try {
        const desktop = await desktopDir();
        const dir = await join(desktop, "AnimeGui", "dvd_subtitles");
        setOutputDir(dir);
      } catch {
        // ignore
      }
    })();
    if (initialInputs.length > 0) {
      setLoadingScan(true);
      void scanDvdSubtitleTracks(initialInputs)
        .then((rows) => {
          setScanRows(rows);
          appendLog(t("dvd.log.scanDone", { count: rows.length }));
        })
        .catch((error) => {
          appendLog(t("dvd.log.scanError", { error: String(error) }));
        })
        .finally(() => {
          setLoadingScan(false);
        });
    }
  }, [appendLog]);

  useEffect(() => {
    if (scanRows.length === 0) {
      return;
    }
    if (!selectedTrackKey) {
      const first = scanRows[0];
      setSelectedTrackKey(`${first.input_path}::${first.stream_index}`);
    }
  }, [scanRows, selectedTrackKey]);

  useEffect(() => {
    if (ocrLines.length === 0) {
      setSelectedLineId(null);
      return;
    }
    if (selectedLineId !== null && ocrLines.some((line) => line.id === selectedLineId)) {
      return;
    }
    const firstNeedsFix = ocrLines.find((line) => line.needs_manual) ?? ocrLines[0];
    setSelectedLineId(firstNeedsFix.id);
    setManualText(firstNeedsFix.ocr_text);
  }, [ocrLines, selectedLineId]);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;
    void listen<DvdOcrProgressEvent>("dvd-ocr-progress", (event) => {
      if (!mounted) return;
      const payload = event.payload;
      setOcrProgress({
        processed: payload.processed ?? 0,
        total: payload.total ?? 0,
      });
      if (payload.kind === "line" && payload.line) {
        const line = payload.line;
        setOcrLines((prev) => {
          const next = [...prev];
          const index = next.findIndex((item) => item.id === line.id);
          if (index >= 0) {
            next[index] = line;
          } else {
            next.push(line);
          }
          next.sort((a, b) => a.id - b.id);
          return next;
        });
        setSelectedLineId((current) => {
          if (current !== null) {
            return current;
          }
          setManualText(unescapeNewlines(line.ocr_text));
          return line.id;
        });
      }
      if (payload.kind === "started" && payload.message) {
        appendLog(payload.message);
      }
      if (payload.kind === "done" && payload.message) {
        appendLog(payload.message);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      mounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, [appendLog]);

  useEffect(() => {
    void listOcrUserReplacements()
      .then((rows) => {
        appendLog(`Dictionnaire OCR utilisateur: ${rows.length} règle(s)`);
      })
      .catch(() => {
        // ignore
      });
  }, [appendLog]);

  function focusLine(line: DvdOcrLine | null) {
    if (!line) {
      return;
    }
    setSelectedLineId(line.id);
    setManualText(unescapeNewlines(line.ocr_text));
  }

  function pickLineToFocus(lines: DvdOcrLine[], preferredId: number | null): DvdOcrLine | null {
    if (lines.length === 0) {
      return null;
    }
    if (preferredId !== null) {
      const same = lines.find((line) => line.id === preferredId);
      if (same) {
        return same;
      }
    }
    return lines.find((line) => line.needs_manual) ?? lines[0];
  }

  async function pickSingleVideo() {
    try {
      const selected = await open({
        multiple: false,
        title: t("dvd.pickVideo"),
        filters: [
          { name: "Vidéos", extensions: ["mkv", "mp4", "avi", "mov", "ts"] },
        ],
      });
      if (typeof selected !== "string") {
        return;
      }
      const resolved = await resolveVideoInputs(selected);
      setInputPaths(resolved);
      appendLog(t("dvd.log.inputsLoaded", { count: resolved.length }));
    } catch (error) {
      appendLog(t("dvd.log.inputError", { error: String(error) }));
    }
  }

  async function pickVideoFolder() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("dvd.pickFolder"),
      });
      if (typeof selected !== "string") {
        return;
      }
      const resolved = await resolveVideoInputs(selected);
      setInputPaths(resolved);
      appendLog(t("dvd.log.inputsLoaded", { count: resolved.length }));
    } catch (error) {
      appendLog(t("dvd.log.inputError", { error: String(error) }));
    }
  }

  async function pickOutputFolder() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("dvd.pickOutput"),
      });
      if (typeof selected === "string") {
        setOutputDir(selected);
      }
    } catch (error) {
      appendLog(t("dvd.log.outputError", { error: String(error) }));
    }
  }

  async function runScan() {
    if (!hasInput) {
      appendLog(t("dvd.log.noInputs"));
      return;
    }
    setLoadingScan(true);
    setExtractRows([]);
    try {
      const rows = await scanDvdSubtitleTracks(inputPaths);
      setScanRows(rows);
      appendLog(t("dvd.log.scanDone", { count: rows.length }));
    } catch (error) {
      appendLog(t("dvd.log.scanError", { error: String(error) }));
    } finally {
      setLoadingScan(false);
    }
  }

  async function runExtract() {
    if (!hasInput) {
      appendLog(t("dvd.log.noInputs"));
      return;
    }
    if (!outputDir.trim()) {
      appendLog(t("dvd.log.noOutput"));
      return;
    }
    setLoadingExtract(true);
    try {
      const rows = await extractDvdSubtitleTracks({
        input_paths: inputPaths,
        output_dir: outputDir.trim(),
      });
      setExtractRows(rows);
      appendLog(
        t("dvd.log.extractDone", {
          ok: rows.filter((item) => item.success).length,
          total: rows.length,
        }),
      );

      const preferred = selectedTrackKey
        ? rows.find(
          (row) =>
            row.success &&
            `${row.input_path}::${row.stream_index}` === selectedTrackKey,
        )
        : undefined;
      const firstOk = preferred ?? rows.find((row) => row.success);
      if (firstOk) {
        setLoadingSubImages(true);
        setOcrCompleted(false);
        try {
          const previousSelectedId = selectedLineId;
          const loaded = await loadDvdSubImages({
            idx_path: firstOk.idx_path,
            output_dir: outputDir.trim(),
            language: ocrLanguage,
            ocr_upscale_factor: ocrUpscaleFactor,
          });
          setOcrLines(loaded.lines);
          focusLine(pickLineToFocus(loaded.lines, previousSelectedId));
          appendLog(`Images SUB chargées: ${loaded.lines.length} ligne(s)`);
        } finally {
          setLoadingSubImages(false);
        }
      }
    } catch (error) {
      appendLog(t("dvd.log.extractError", { error: String(error) }));
    } finally {
      setLoadingExtract(false);
    }
  }

  useEffect(() => {
    if (loadingExtract || loadingOcr) {
      return;
    }
    const idxPath = pickDefaultIdxPath();
    if (!idxPath || !outputDir.trim()) {
      return;
    }
    setLoadingSubImages(true);
    const previousSelectedId = selectedLineId;
    void loadDvdSubImages({
      idx_path: idxPath,
      output_dir: outputDir.trim(),
      language: ocrLanguage,
      ocr_upscale_factor: ocrUpscaleFactor,
    })
      .then((loaded) => {
        setOcrLines(loaded.lines);
        focusLine(pickLineToFocus(loaded.lines, previousSelectedId));
      })
      .catch(() => {
        // ignore auto-refresh errors
      })
      .finally(() => {
        setLoadingSubImages(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTrackKey]);

  function pickDefaultIdxPath(): string | null {
    if (selectedTrackKey) {
      const selected = extractRows.find(
        (row) =>
          row.success && `${row.input_path}::${row.stream_index}` === selectedTrackKey,
      );
      if (selected) {
        return selected.idx_path;
      }
    }
    const firstOk = extractRows.find((row) => row.success);
    return firstOk?.idx_path ?? null;
  }

  async function runOcr() {
    const idxPath = pickDefaultIdxPath();
    if (!idxPath) {
      appendLog("Aucun IDX extrait disponible pour OCR");
      return;
    }
    if (!outputDir.trim()) {
      appendLog(t("dvd.log.noOutput"));
      return;
    }
    setLoadingOcr(true);
    setOcrCompleted(false);
    setOcrProgress({ processed: 0, total: 0 });
    try {
      const result = await startDvdOcr({
        idx_path: idxPath,
        output_dir: outputDir.trim(),
        language: ocrLanguage,
        ocr_upscale_factor: ocrUpscaleFactor,
      });
      setOcrLines(result.lines);
      const firstNeeds =
        result.lines.find((l) => l.needs_manual) ?? result.lines[0];
      focusLine(firstNeeds ?? null);
      setOcrCompleted(true);
      appendLog(`OCR terminé: ${result.lines.length} image(s)`);
    } catch (error) {
      appendLog(`Erreur OCR: ${String(error)}`);
    } finally {
      setLoadingOcr(false);
    }
  }

  function applyManual() {
    if (!selectedLine) return;
    const text = manualText.trim();

    // Record correction and auto-learn
    if (selectedLine.ocr_text !== text) {
      void recordOcrCorrection(selectedLine.ocr_text, text)
        .then(() => {
          appendLog(`Auto-apprentissage: correction enregistrée pour ligne #${selectedLine.id}`);
        })
        .catch((error) => {
          appendLog(`Erreur auto-apprentissage: ${String(error)}`);
        });
    }

    setOcrLines((prev) =>
      prev.map((line) =>
        line.id === selectedLine.id ? withUpdatedFlags(line, text) : line,
      ),
    );
    const updatedLine = withUpdatedFlags(selectedLine, text);
    focusLine(updatedLine);
  }

  async function exportSrt() {
    if (ocrLines.length === 0) {
      appendLog("Aucune ligne OCR à exporter");
      return;
    }
    if (!outputDir.trim()) {
      appendLog(t("dvd.log.noOutput"));
      return;
    }
    const idxPath = pickDefaultIdxPath();
    if (!idxPath) {
      appendLog("Aucun IDX extrait disponible");
      return;
    }
    // Extraire le nom de base du fichier idx
    const basename = idxPath.split("\\").pop()?.replace(".idx", "") || "dvd_ocr";
    const outPath = `${outputDir.trim()}\\${basename}.srt`;
    try {
      const written = await exportDvdOcrSrt({
        output_srt_path: outPath,
        lines: ocrLines,
      });
      appendLog(`SRT exporté: ${written}`);

      // Sauvegarder le chemin du SRT dans le contexte Preview
      if (dvdSubsContext?.previewWindowLabel) {
        // Mettre à jour AUSSI le contexte Preview directement (important!)
        const previewRaw = localStorage.getItem("animegui-preview-context");
        if (previewRaw) {
          try {
            const previewContext = JSON.parse(previewRaw);
            previewContext.srtPath = outPath;
            localStorage.setItem("animegui-preview-context", JSON.stringify(previewContext));
            appendLog(`SRT path sauvegardé dans preview-context: ${outPath}`);
          } catch {
            appendLog("Erreur mise à jour preview-context");
          }
        }

        const updatedContext = {
          ...dvdSubsContext,
          srtPath: outPath,
        };
        localStorage.setItem(
          "animegui-dvdsubs-context",
          JSON.stringify(updatedContext),
        );

        // Fermer la fenêtre DVD
        await appWindow.close();

        // Réafficher la fenêtre Preview
        try {
          const previewWindow = await WebviewWindow.getByLabel(dvdSubsContext.previewWindowLabel);
          if (previewWindow) {
            await previewWindow.show();
            await previewWindow.setFocus();
          }
        } catch {
          // ignore if preview window not found
        }
      }
    } catch (error) {
      appendLog(`Erreur export SRT: ${String(error)}`);
    }
  }

  return (
    <main className="dvdx-page">
      <div className="dvdx-win">
        <header className="preview-titlebar">
          <div
            className="preview-titlebar-left"
            onMouseDown={(e) => {
              if (e.button === 0) void appWindow.startDragging();
            }}
            onDoubleClick={() => void appWindow.toggleMaximize()}
          >
            <span className="preview-title">DVD Subtitle Extractor - OCR</span>
            <span className="preview-filepath" title={inputPaths.join(" | ")}>
              {sourceName}
            </span>
            {inputPaths.length > 1 ? (
              <span className="preview-filepath">+{inputPaths.length - 1} fichiers</span>
            ) : null}
          </div>
          <div
            className="window-controls"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="window-btn window-btn-min"
              type="button"
              aria-label="Minimize"
              onClick={() => void appWindow.minimize()}
            />
            <button
              className="window-btn window-btn-max"
              type="button"
              aria-label="Maximize"
              onClick={() => void appWindow.toggleMaximize()}
            />
            <button
              className="window-btn window-btn-close"
              type="button"
              aria-label="Close"
              onClick={() => void appWindow.close()}
            />
          </div>
        </header>

        <div className="dvdx-toolbar">
          <button className="dvdx-btn dvdx-btn-sec" type="button" onClick={pickSingleVideo}>
            + Video
          </button>
          <button className="dvdx-btn dvdx-btn-sec" type="button" onClick={pickVideoFolder}>
            + Dossier
          </button>
          <div className="dvdx-sep-v" />
          <button className="dvdx-btn dvdx-btn-sec" type="button" onClick={runScan} disabled={loadingScan}>
            {loadingScan ? t("dvd.scanRunning") : t("dvd.scan")}
          </button>
          <button className="dvdx-btn dvdx-btn-sec" type="button" onClick={runExtract} disabled={loadingExtract}>
            {loadingExtract ? t("dvd.extractRunning") : t("dvd.extract")}
          </button>
          <div className="dvdx-sep-v" />
          <button
            className="dvdx-btn dvdx-btn-green"
            type="button"
            onClick={runOcr}
            disabled={loadingOcr || loadingSubImages || extractOkCount === 0}
          >
            {loadingOcr ? "OCR..." : "Start OCR"}
          </button>
          {ocrCompleted && (
            <button
              className="dvdx-btn dvdx-btn-sec"
              type="button"
              onClick={exportSrt}
            >
              Exporter SRT
            </button>
          )}
          <div className="dvdx-sep-v" />
          <select
            className="dvdx-select"
            value={ocrLanguage}
            onChange={(e) => setOcrLanguage(e.currentTarget.value)}
          >
            <option value="fra">fra</option>
          </select>
          <select
            className="dvdx-select"
            value={ocrUpscaleFactor}
            onChange={(e) => setOcrUpscaleFactor(e.currentTarget.value === "2" ? 2 : 3)}
          >
            <option value={2}>x2</option>
            <option value={3}>x3</option>
          </select>
        </div>

        <div className="dvdx-body">
          <div className="dvdx-col-left">
            <div className="dvdx-col-head">
              <span className="dvdx-col-title">Pistes DVD</span>
              <span className="dvdx-col-count">{scanRows.length} tracks</span>
            </div>
            <div className="dvdx-piste-list">
              {hasTracks ? (
                scanRows.map((item) => {
                  const key = `${item.input_path}::${item.stream_index}`;
                  const extracted = extractRows.find(
                    (row) =>
                      row.success &&
                      row.input_path === item.input_path &&
                      row.stream_index === item.stream_index,
                  );
                  const isActive = selectedTrackKey === key;
                  const status = loadingOcr && isActive ? "ocr" : extracted ? "ok" : "idle";
                  return (
                    <button
                      type="button"
                      key={key}
                      className={`dvdx-piste-item ${isActive ? "active" : ""}`}
                      onClick={() => setSelectedTrackKey(key)}
                    >
                      <div className="dvdx-pi-top">
                        <span className="dvdx-pi-idx">S:{item.stream_index}</span>
                        <span className="dvdx-pi-lang">{item.language ?? "-"}</span>
                        <span className="dvdx-pi-codec">{item.codec}</span>
                      </div>
                      <div className="dvdx-pi-file" title={item.input_path}>
                        {item.input_path}
                      </div>
                      <div className="dvdx-pi-status">
                        <span className={`dvdx-pi-dot ${status}`} />
                        <span className={`dvdx-pi-stxt ${status}`}>
                          {status === "ocr"
                            ? "OCR en cours..."
                            : status === "ok"
                              ? "IDX/SUB extrait"
                              : "En attente"}
                        </span>
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="dvdx-empty">{t("dvd.noTracks")}</div>
              )}
            </div>
          </div>

          <div className="dvdx-col-center">
            <div className="dvdx-ocr-topbar">
              <div className="dvdx-ocr-prog-wrap">
                <div
                  className="dvdx-ocr-prog-bar"
                  style={{
                    width: `${(ocrProgress.total || ocrLines.length) > 0
                      ? Math.round(
                        ((ocrProgress.processed || 0) /
                          (ocrProgress.total || ocrLines.length)) *
                        100,
                      )
                      : 0
                      }%`,
                  }}
                />
              </div>
              <span className="dvdx-ocr-prog-txt">
                {ocrProgress.processed}/{ocrProgress.total || ocrLines.length}
              </span>
              {manualCount > 0 ? (
                <span className="dvdx-ocr-needs">{manualCount} a corriger</span>
              ) : null}
            </div>
            <div className="dvdx-lines-head">
              <span>#</span>
              <span>Timecode</span>
              <span>Duree</span>
              <span>Texte OCR</span>
              <span className="right">Conf</span>
            </div>
            <div className="dvdx-lines-list">
              {ocrLines.length === 0 ? (
                <div className="dvdx-empty">
                  {loadingSubImages ? (
                    <div className="dvdx-spinner-container">
                      <div className="dvdx-spinner" />
                      <span>Chargement des images SUB...</span>
                    </div>
                  ) : (
                    "Lance Start OCR pour generer les textes des lignes à partir des images SUB extraites"
                  )}
                </div>
              ) : (
                ocrLines.map((line) => (
                  <button
                    key={line.id}
                    type="button"
                    className={`dvdx-line-row ${line.id === selectedLineId ? "active" : ""} ${line.needs_manual ? "fix" : ""}`}
                    onClick={() => focusLine(line)}
                  >
                    <span className="dvdx-lr-id">{line.id}</span>
                    <span className="dvdx-lr-tc">{formatTimecode(line.start_ms)}</span>
                    <span className="dvdx-lr-dur">{formatDurationMs(line.start_ms, line.end_ms)}s</span>
                    <span className={`dvdx-lr-text ${line.needs_manual ? "fix" : ""}`}>
                      {line.ocr_text ? renderOcrText(line.ocr_text) : "-"}
                    </span>
                    <span
                      className={`dvdx-lr-conf ${line.confidence >= 85 ? "hi" : line.confidence >= 65 ? "mid" : "lo"
                        }`}
                    >
                      {Math.round(line.confidence)}%
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="dvdx-col-right">
            <div className="dvdx-ed-img">
              {selectedLine ? (
                <>
                  <img src={selectedLine.image_data_url} alt="subtitle" />
                  <span className="dvdx-ed-tc">{formatTimecode(selectedLine.start_ms)}</span>
                </>
              ) : (
                <span className="dvdx-ed-img-placeholder">Image sous-titre</span>
              )}
            </div>
            <div className="dvdx-ed-body">
              <div className="dvdx-ed-meta">
                <span className="dvdx-ed-meta-info">
                  {selectedLine
                    ? `#${selectedLine.id} · ${formatTimecode(selectedLine.start_ms)} · ${Math.round(selectedLine.confidence)}% conf`
                    : "- Selectionne une ligne"}
                </span>
                {selectedLine ? (
                  <span
                    className={`dvdx-ed-meta-badge ${selectedLine.needs_manual ? "badge-fix" : "badge-ok"}`}
                  >
                    {selectedLine.needs_manual ? "A corriger" : "OK"}
                  </span>
                ) : null}
              </div>
              <div className="dvdx-ed-section">
                <div className="dvdx-ed-label">Texte (editable)</div>
                <textarea
                  className="dvdx-ed-textarea"
                  value={manualText}
                  onChange={(e) => setManualText(e.currentTarget.value)}
                  placeholder="Texte généré..."
                  disabled={!selectedLine}
                />
              </div>
              <div className="dvdx-ed-actions">
                <button
                  className="dvdx-btn dvdx-btn-sec"
                  type="button"
                  onClick={applyManual}
                  disabled={!selectedLine}
                >
                  Appliquer
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="dvdx-out-row">
        <span className="dvdx-out-lbl">Sortie</span>
        <input
          className="dvdx-out-input"
          value={outputDir}
          onChange={(event) => setOutputDir(event.currentTarget.value)}
          placeholder={t("dvd.outputPlaceholder")}
        />
        <button className="dvdx-btn dvdx-btn-sec" type="button" onClick={pickOutputFolder}>
          {t("app.browse")}
        </button>
      </div>

      <div className="dvdx-stats-bar">
        <div className="dvdx-stat">
          <span className="dvdx-stat-lbl">Sources</span>
          <span className="dvdx-stat-val">{inputPaths.length}</span>
        </div>
        <div className="dvdx-stat">
          <span className="dvdx-stat-lbl">Pistes</span>
          <span className="dvdx-stat-val gold">{scanRows.length}</span>
        </div>
        <div className="dvdx-stat">
          <span className="dvdx-stat-lbl">IDX/SUB</span>
          <span className="dvdx-stat-val">{extractOkCount}</span>
        </div>
        <div className="dvdx-stat">
          <span className="dvdx-stat-lbl">Lignes OCR</span>
          <span className="dvdx-stat-val">{ocrLines.length}</span>
        </div>
        <div className="dvdx-stat">
          <span className="dvdx-stat-lbl">A corriger</span>
          <span className="dvdx-stat-val red">{manualCount}</span>
        </div>
        <div className="dvdx-stat">
          <span className="dvdx-stat-lbl">Confiance moy.</span>
          <span className="dvdx-stat-val green">{avgConfidence}%</span>
        </div>
      </div>

      <div className="dvdx-log-strip">
        <span className="dvdx-log-dot" />
        <span>{(log || t("monitor.empty")).split("\n").slice(-1)[0]}</span>
      </div>
    </main>
  );
}
