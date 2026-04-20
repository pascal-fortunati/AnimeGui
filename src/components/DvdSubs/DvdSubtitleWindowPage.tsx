import { useCallback, useEffect, useMemo, useState } from "react";
import { desktopDir, join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Progress } from "../ui/progress";
import {
  exportDvdOcrSrt,
  extractDvdSubtitleTracks,
  loadDvdSubImages,
  listOcrUserReplacements,
  recordOcrCorrection,
  upsertOcrUserReplacement,
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
  srtPath?: string;
  srtByInputPath?: Record<string, string>;
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

function trackKey(inputPath: string, streamIndex: number): string {
  return `${inputPath}::${streamIndex}`;
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
  const [ocrLinesByTrack, setOcrLinesByTrack] = useState<Record<string, DvdOcrLine[]>>({});
  const [selectedLineId, setSelectedLineId] = useState<number | null>(null);
  const [selectedLineIdByTrack, setSelectedLineIdByTrack] = useState<Record<string, number>>({});
  const [selectedTrackKey, setSelectedTrackKey] = useState<string>("");
  const [ocrLanguage, setOcrLanguage] = useState("fra");
  const [ocrUpscaleFactor, setOcrUpscaleFactor] = useState<2 | 3>(3);
  const [manualText, setManualText] = useState("");
  const [ocrProgress, setOcrProgress] = useState<{
    processed: number;
    total: number;
  }>({ processed: 0, total: 0 });
  const [loadingSubImages, setLoadingSubImages] = useState(false);
  const [subImagesReadyByTrack, setSubImagesReadyByTrack] = useState<Record<string, boolean>>({});
  const [subImagesBuildProgress, setSubImagesBuildProgress] = useState<{
    done: number;
    total: number;
  }>({ done: 0, total: 0 });
  const [ocrActiveTrackKey, setOcrActiveTrackKey] = useState<string | null>(null);
  const [ocrDoneByTrack, setOcrDoneByTrack] = useState<Record<string, boolean>>({});
  const [exportedSrtByTrack, setExportedSrtByTrack] = useState<Record<string, string>>({});

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

  const extractedTrackKeys = useMemo(
    () =>
      extractRows
        .filter((row) => row.success)
        .map((row) => trackKey(row.input_path, row.stream_index)),
    [extractRows],
  );

  const ocrDoneCount = useMemo(
    () => extractedTrackKeys.filter((key) => ocrDoneByTrack[key]).length,
    [extractedTrackKeys, ocrDoneByTrack],
  );

  const exportedCount = useMemo(
    () => extractedTrackKeys.filter((key) => Boolean(exportedSrtByTrack[key])).length,
    [extractedTrackKeys, exportedSrtByTrack],
  );

  const canExportAllSrt = useMemo(
    () => extractedTrackKeys.length > 0 && ocrDoneCount === extractedTrackKeys.length,
    [extractedTrackKeys, ocrDoneCount],
  );

  const subImagesReadyCount = useMemo(
    () => extractedTrackKeys.filter((key) => subImagesReadyByTrack[key]).length,
    [extractedTrackKeys, subImagesReadyByTrack],
  );

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
    if (selectedTrackKey) {
      setSelectedLineIdByTrack((prev) => ({ ...prev, [selectedTrackKey]: line.id }));
    }
    setManualText(unescapeNewlines(line.ocr_text));
  }

  function selectTrackAndShowLines(key: string) {
    setSelectedTrackKey(key);
    const cached = ocrLinesByTrack[key];
    if (cached && cached.length > 0) {
      setOcrLines(cached);
      const preferredId = selectedLineIdByTrack[key] ?? null;
      focusLine(pickLineToFocus(cached, preferredId));
      return;
    }
    setOcrLines([]);
    setSelectedLineId(null);
    setManualText("");
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
    setSubImagesReadyByTrack({});
    setSubImagesBuildProgress({ done: 0, total: 0 });
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
      setOcrDoneByTrack({});
      setExportedSrtByTrack({});
      setSubImagesReadyByTrack({});
      setSubImagesBuildProgress({ done: 0, total: 0 });
      setOcrLinesByTrack({});
      setOcrLines([]);
      setOcrCompleted(false);
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

      const extractedByKey = new Map(
        rows
          .filter((row) => row.success)
          .map((row) => [trackKey(row.input_path, row.stream_index), row] as const),
      );
      const tracksToPrepare = scanRows
        .map((item) => extractedByKey.get(trackKey(item.input_path, item.stream_index)))
        .filter((row): row is DvdSubtitleExtractResult => Boolean(row));

      if (tracksToPrepare.length > 0) {
        setLoadingSubImages(true);
        setSubImagesBuildProgress({ done: 0, total: tracksToPrepare.length });
        appendLog(`Génération des images SUB pour ${tracksToPrepare.length} piste(s)...`);
        const loadedByKey: Record<string, DvdOcrLine[]> = {};
        try {
          let done = 0;
          for (const row of tracksToPrepare) {
            const key = trackKey(row.input_path, row.stream_index);
            const loaded = await loadDvdSubImages({
              idx_path: row.idx_path,
              output_dir: outputDir.trim(),
              language: ocrLanguage,
              ocr_upscale_factor: ocrUpscaleFactor,
            });
            loadedByKey[key] = loaded.lines;
            done += 1;
            setSubImagesReadyByTrack((prev) => ({ ...prev, [key]: true }));
            setSubImagesBuildProgress({ done, total: tracksToPrepare.length });
            appendLog(`SUB généré piste ${row.stream_index} (${done}/${tracksToPrepare.length})`);
          }

          setOcrLinesByTrack(loadedByKey);
          const preferred = selectedTrackKey
            ? tracksToPrepare.find(
              (row) => trackKey(row.input_path, row.stream_index) === selectedTrackKey,
            )
            : undefined;
          const firstPrepared = preferred ?? tracksToPrepare[0];
          if (firstPrepared) {
            const firstKey = trackKey(firstPrepared.input_path, firstPrepared.stream_index);
            const lines = loadedByKey[firstKey] ?? [];
            setSelectedTrackKey(firstKey);
            setOcrLines(lines);
            focusLine(pickLineToFocus(lines, selectedLineId));
          }
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
    if (!selectedTrackKey) {
      return;
    }
    const cached = ocrLinesByTrack[selectedTrackKey];
    if (cached && cached.length > 0) {
      setOcrLines(cached);
      const preferredId = selectedLineIdByTrack[selectedTrackKey] ?? null;
      focusLine(pickLineToFocus(cached, preferredId));
      return;
    }
    if (loadingExtract || loadingOcr || loadingSubImages) {
      return;
    }
    const idxPath = pickDefaultIdxPath();
    if (!idxPath || !outputDir.trim()) {
      return;
    }
    setLoadingSubImages(true);
    const previousSelectedId = selectedLineIdByTrack[selectedTrackKey] ?? selectedLineId;
    void loadDvdSubImages({
      idx_path: idxPath,
      output_dir: outputDir.trim(),
      language: ocrLanguage,
      ocr_upscale_factor: ocrUpscaleFactor,
    })
      .then((loaded) => {
        setOcrLinesByTrack((prev) => ({ ...prev, [selectedTrackKey]: loaded.lines }));
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
  }, [selectedTrackKey, ocrLinesByTrack, selectedLineIdByTrack, loadingExtract, loadingOcr, loadingSubImages]);

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
    const extractedByKey = new Map(
      extractRows
        .filter((row) => row.success)
        .map((row) => [trackKey(row.input_path, row.stream_index), row] as const),
    );
    const tracksToProcess = scanRows
      .map((item) => extractedByKey.get(trackKey(item.input_path, item.stream_index)))
      .filter((row): row is DvdSubtitleExtractResult => Boolean(row));

    if (tracksToProcess.length === 0) {
      appendLog("Aucun IDX extrait disponible pour OCR");
      return;
    }
    if (!outputDir.trim()) {
      appendLog(t("dvd.log.noOutput"));
      return;
    }
    setLoadingOcr(true);
    setOcrCompleted(false);
    setOcrActiveTrackKey(null);
    setOcrProgress({ processed: 0, total: 0 });
    try {
      let completed = 0;
      for (const row of tracksToProcess) {
        const key = trackKey(row.input_path, row.stream_index);
        setOcrActiveTrackKey(key);
        setSelectedTrackKey(key);
        appendLog(`OCR piste ${row.stream_index} (${row.input_path.split("\\").pop()})...`);

        const result = await startDvdOcr({
          idx_path: row.idx_path,
          output_dir: outputDir.trim(),
          language: ocrLanguage,
          ocr_upscale_factor: ocrUpscaleFactor,
        });
        setOcrLinesByTrack((prev) => ({ ...prev, [key]: result.lines }));
        setOcrDoneByTrack((prev) => ({ ...prev, [key]: true }));
        setOcrLines(result.lines);
        const firstNeeds =
          result.lines.find((l) => l.needs_manual) ?? result.lines[0];
        focusLine(firstNeeds ?? null);
        completed += 1;
        appendLog(`OCR terminé piste ${row.stream_index} (${completed}/${tracksToProcess.length})`);
      }
      setOcrCompleted(true);
      appendLog(`OCR terminé sur ${tracksToProcess.length} piste(s)`);
    } catch (error) {
      appendLog(`Erreur OCR: ${String(error)}`);
    } finally {
      setOcrActiveTrackKey(null);
      setLoadingOcr(false);
    }
  }

  function applyManual() {
    if (!selectedLine) return;
    const originalText = selectedLine.ocr_text.trim();
    const text = manualText.trim();

    // Persist explicit replacement and then auto-learn additional patterns.
    if (originalText !== text) {
      void upsertOcrUserReplacement(originalText, text)
        .then(() => recordOcrCorrection(originalText, text))
        .then(() => {
          appendLog(`Correction enregistrée pour ligne #${selectedLine.id}`);
        })
        .catch((error) => {
          appendLog(`Erreur enregistrement correction: ${String(error)}`);
        });
    }

    const updatedLines = ocrLines.map((line) =>
      line.id === selectedLine.id ? withUpdatedFlags(line, text) : line,
    );
    setOcrLines(updatedLines);
    if (selectedTrackKey) {
      setOcrLinesByTrack((prev) => ({ ...prev, [selectedTrackKey]: updatedLines }));
    }
    const updatedLine = withUpdatedFlags(selectedLine, text);
    focusLine(updatedLine);
  }

  async function exportSrt() {
    const extractedByKey = new Map(
      extractRows
        .filter((row) => row.success)
        .map((row) => [trackKey(row.input_path, row.stream_index), row] as const),
    );
    const tracksToExport = scanRows
      .map((item) => extractedByKey.get(trackKey(item.input_path, item.stream_index)))
      .filter((row): row is DvdSubtitleExtractResult => Boolean(row))
      .map((row) => {
        const key = trackKey(row.input_path, row.stream_index);
        return { row, key, lines: ocrLinesByTrack[key] ?? [] };
      })
      .filter(({ lines }) => lines.length > 0);

    if (tracksToExport.length === 0) {
      appendLog("Aucune piste OCR à exporter");
      return;
    }
    if (!outputDir.trim()) {
      appendLog(t("dvd.log.noOutput"));
      return;
    }

    try {
      const srtByInputPath: Record<string, string> = {};
      let lastOutPath: string | undefined;

      for (const { row, lines } of tracksToExport) {
        const idxPath = row.idx_path;
        const basename = idxPath.split("\\").pop()?.replace(".idx", "") || "dvd_ocr";
        const outPath = `${outputDir.trim()}\\${basename}.srt`;
        const written = await exportDvdOcrSrt({
          output_srt_path: outPath,
          lines,
        });
        srtByInputPath[row.input_path] = outPath;
        lastOutPath = outPath;
        setExportedSrtByTrack((prev) => ({
          ...prev,
          [trackKey(row.input_path, row.stream_index)]: outPath,
        }));
        appendLog(`SRT exporté: ${written}`);
      }

      if (!lastOutPath) {
        appendLog("Aucun SRT généré");
        return;
      }

      // Lire le contexte directement du localStorage (pas du state)
      const currentContext = readStoredContext();
      const previewWindowLabel = currentContext?.previewWindowLabel;

      // Sauvegarder le chemin du SRT dans le contexte Preview
      if (previewWindowLabel) {
        appendLog(`Détecté preview window: ${previewWindowLabel}`);

        // Mettre à jour AUSSI le contexte Preview directement (important!)
        const previewRaw = localStorage.getItem("animegui-preview-context");
        if (previewRaw) {
          try {
            const previewContext = JSON.parse(previewRaw);
            previewContext.srtPath = lastOutPath;
            previewContext.srtByInputPath = {
              ...(previewContext.srtByInputPath ?? {}),
              ...srtByInputPath,
            };
            localStorage.setItem("animegui-preview-context", JSON.stringify(previewContext));
            appendLog(`Mappings SRT sauvegardés dans preview-context (${Object.keys(srtByInputPath).length})`);
          } catch {
            appendLog("Erreur mise à jour preview-context");
          }
        }

        const updatedContext = {
          ...currentContext,
          srtPath: lastOutPath,
          srtByInputPath: {
            ...(currentContext.srtByInputPath ?? {}),
            ...srtByInputPath,
          },
        };
        localStorage.setItem(
          "animegui-dvdsubs-context",
          JSON.stringify(updatedContext),
        );

        // Attendre un peu pour que le localStorage se propage
        await new Promise(resolve => setTimeout(resolve, 200));

        // IMPORTANT: D'abord montrer la Preview, puis fermer la DVD
        try {
          for (const [inputPath, srtPath] of Object.entries(srtByInputPath)) {
            await appWindow.emitTo(previewWindowLabel, "dvd-srt-exported", {
              srtPath,
              inputPath,
            });
          }
          appendLog(`Recherche fenêtre preview: ${previewWindowLabel}...`);
          const previewWindow = await WebviewWindow.getByLabel(previewWindowLabel);
          if (previewWindow) {
            appendLog(`✅ Fenêtre preview trouvée, affichage...`);
            await previewWindow.unminimize();
            await previewWindow.show();
            await previewWindow.setFocus();
            appendLog(`✅ Fenêtre preview affichée avec succès`);
          } else {
            appendLog(`❌ Fenêtre preview introuvable avec le label: ${previewWindowLabel}`);
          }
        } catch (error) {
          appendLog(`❌ Erreur affichage preview: ${String(error)}`);
        }

        // Maintenant seulement fermer la fenêtre DVD
        try {
          appendLog(`Fermeture fenêtre DVD...`);
          await new Promise(resolve => setTimeout(resolve, 100));
          await appWindow.hide();
          appendLog(`Fenêtre DVD fermée`);
        } catch (error) {
          appendLog(`Erreur fermeture DVD: ${String(error)}`);
        }
      } else {
        appendLog(`previewWindowLabel non trouvé dans le contexte`);
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
            disabled={
              loadingOcr
              || loadingSubImages
              || extractOkCount === 0
              || subImagesReadyCount < extractedTrackKeys.length
            }
          >
            {loadingOcr ? "OCR..." : "Start OCR (toutes les pistes)"}
          </button>
          {ocrCompleted && (
            <button
              className="dvdx-btn dvdx-btn-sec"
              type="button"
              onClick={exportSrt}
              disabled={!canExportAllSrt}
            >
              Exporter SRT (toutes les pistes)
            </button>
          )}
          {!canExportAllSrt && extractOkCount > 0 ? (
            <span className="dvdx-flow-hint">
              {t("dvd.flowHint", { done: ocrDoneCount, total: extractedTrackKeys.length })}
            </span>
          ) : null}
          {loadingSubImages ? (
            <span className="dvdx-flow-hint">
              {t("dvd.subBuildHint", {
                done: subImagesBuildProgress.done,
                total: subImagesBuildProgress.total,
              })}
            </span>
          ) : null}
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
                  const status = (() => {
                    if (exportedSrtByTrack[key]) return "exported";
                    if (loadingOcr && ocrActiveTrackKey === key) return "ocr";
                    if (ocrDoneByTrack[key]) return "ocrdone";
                    if (subImagesReadyByTrack[key]) return "subready";
                    if (extracted) return "extracted";
                    return "idle";
                  })();
                  const statusLabel = (() => {
                    if (status === "exported") return t("dvd.statusExported");
                    if (status === "ocr") return t("dvd.statusOcring");
                    if (status === "ocrdone") return t("dvd.statusOcrDone");
                    if (status === "subready") return t("dvd.statusSubReady");
                    if (status === "extracted") return t("dvd.statusExtracted");
                    return t("dvd.statusIdle");
                  })();
                  const progressValue = (() => {
                    if (status === "exported") return 100;
                    if (status === "ocrdone") return 85;
                    if (status === "subready") return 60;
                    if (status === "extracted") return 35;
                    if (status === "ocr" && ocrActiveTrackKey === key && ocrProgress.total > 0) {
                      return 60 + Math.round((ocrProgress.processed / ocrProgress.total) * 25);
                    }
                    return 0;
                  })();
                  return (
                    <button
                      type="button"
                      key={key}
                      className={`dvdx-piste-item ${isActive ? "active" : ""} ${status === "ocr" ? "is-processing" : ""}`}
                      onClick={() => selectTrackAndShowLines(key)}
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
                          {statusLabel}
                        </span>
                      </div>
                      <Progress
                        value={progressValue}
                        className="dvdx-pi-progress"
                        indicatorClassName={`dvdx-pi-progress-indicator ${status}`}
                      />
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
          <span className="dvdx-stat-lbl">OCR pistes</span>
          <span className="dvdx-stat-val gold">{ocrDoneCount}/{extractOkCount}</span>
        </div>
        <div className="dvdx-stat">
          <span className="dvdx-stat-lbl">SRT exportés</span>
          <span className="dvdx-stat-val green">{exportedCount}/{extractOkCount}</span>
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
