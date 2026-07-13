"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GradeDraft } from "@/lib/types";

const AUTOSAVE_DELAY_MS = 650;
const DEFAULT_DRAFT_ID = "default";

export type GradeDraftSaveStatus =
  | "loading"
  | "idle"
  | "saving"
  | "saved"
  | "error";

export interface GradeDraftSaveState {
  status: GradeDraftSaveStatus;
  updatedAt?: number;
  message?: string;
  retryable?: boolean;
}

function emptyDraft(id: string): GradeDraft {
  return {
    id,
    revision: 0,
    updatedAt: 0,
    clips: {},
    skippedRunIds: [],
  };
}

export function useGradeDraft(draftId = DEFAULT_DRAFT_ID) {
  const [draft, setDraft] = useState<GradeDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<GradeDraftSaveState>({
    status: "loading",
  });
  const [reloadVersion, setReloadVersion] = useState(0);

  const mountedRef = useRef(true);
  const readyRef = useRef(false);
  const draftRef = useRef<GradeDraft | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const conflictRef = useRef(false);
  const restoreFailedRef = useRef(false);
  const dirtyVersionRef = useRef(0);
  const savedVersionRef = useRef(0);
  const flushRef = useRef<(quiet?: boolean) => Promise<void>>(async () => {});

  const flush = useCallback(async (quiet = false): Promise<void> => {
    if (
      !readyRef.current ||
      !draftRef.current ||
      conflictRef.current ||
      savedVersionRef.current === dirtyVersionRef.current
    ) {
      return;
    }
    if (inFlightRef.current) {
      queuedRef.current = true;
      return;
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    inFlightRef.current = true;
    const snapshot = draftRef.current;
    const saveVersion = dirtyVersionRef.current;
    if (!quiet && mountedRef.current) setSaveState({ status: "saving" });

    try {
      const response = await fetch("/api/grade-drafts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft: snapshot,
          expectedRevision: snapshot.revision,
        }),
        keepalive: quiet,
      });
      const payload = (await response.json().catch(() => null)) as
        | { draft?: GradeDraft; error?: string }
        | null;

      if (response.status === 409) {
        conflictRef.current = true;
        queuedRef.current = false;
        if (mountedRef.current) {
          setSaveState({
            status: "error",
            message:
              "A newer grading draft exists in another tab. Refresh to load it; this tab will not overwrite it.",
            retryable: false,
          });
        }
        return;
      }
      if (!response.ok || !payload?.draft) {
        throw new Error(payload?.error ?? `Draft save failed (${response.status}).`);
      }

      const saved = payload.draft;
      savedVersionRef.current = saveVersion;
      restoreFailedRef.current = false;
      const current = draftRef.current;
      const next =
        dirtyVersionRef.current === saveVersion || !current
          ? saved
          : { ...current, revision: saved.revision, updatedAt: saved.updatedAt };
      draftRef.current = next;
      if (mountedRef.current) {
        setDraft(next);
        setSaveState({ status: "saved", updatedAt: saved.updatedAt });
      }
      if (dirtyVersionRef.current !== saveVersion) queuedRef.current = true;
    } catch (error) {
      if (mountedRef.current) {
        setSaveState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Draft autosave is unavailable. Your work remains in this tab.",
          retryable: true,
        });
      }
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current && !conflictRef.current) {
        queuedRef.current = false;
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void flushRef.current();
        }, 0);
      }
    }
  }, []);
  flushRef.current = flush;

  const scheduleSave = useCallback((immediate = false): void => {
    if (!readyRef.current || conflictRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (mountedRef.current) setSaveState({ status: "saving" });
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flushRef.current();
    }, immediate ? 0 : AUTOSAVE_DELAY_MS);
  }, []);

  const updateDraft = useCallback(
    (update: (current: GradeDraft) => GradeDraft, options?: { immediate?: boolean }) => {
      const current = draftRef.current ?? emptyDraft(draftId);
      const next = update(current);
      draftRef.current = next;
      dirtyVersionRef.current += 1;
      if (mountedRef.current) setDraft(next);
      scheduleSave(options?.immediate);
    },
    [draftId, scheduleSave]
  );

  const retry = useCallback(() => {
    if (conflictRef.current) return;
    if (
      restoreFailedRef.current &&
      dirtyVersionRef.current === savedVersionRef.current
    ) {
      setReloadVersion((version) => version + 1);
      return;
    }
    // If the restore failed and the grader has already typed, retry the save
    // in place. Reloading here would replace that unsaved work with the remote
    // document the first successful GET returns.
    scheduleSave(true);
  }, [scheduleSave]);

  useEffect(() => {
    const controller = new AbortController();
    readyRef.current = false;
    setReady(false);
    setSaveState({ status: "loading" });
    void (async () => {
      try {
        const response = await fetch(`/api/grade-drafts?id=${encodeURIComponent(draftId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Draft restore failed (${response.status}).`);
        const payload = (await response.json()) as { draft?: GradeDraft | null };
        const restored = payload.draft ?? emptyDraft(draftId);
        if (controller.signal.aborted) return;
        draftRef.current = restored;
        dirtyVersionRef.current = 0;
        savedVersionRef.current = 0;
        conflictRef.current = false;
        restoreFailedRef.current = false;
        readyRef.current = true;
        setDraft(restored);
        setReady(true);
        setSaveState(
          restored.updatedAt > 0
            ? { status: "saved", updatedAt: restored.updatedAt }
            : { status: "idle" }
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        const local = emptyDraft(draftId);
        restoreFailedRef.current = true;
        draftRef.current = local;
        readyRef.current = true;
        setDraft(local);
        setReady(true);
        setSaveState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Saved grading work could not be restored.",
          retryable: true,
        });
      }
    })();
    return () => controller.abort();
  }, [draftId, reloadVersion]);

  useEffect(() => {
    mountedRef.current = true;
    const flushQuietly = () => void flushRef.current(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushQuietly();
    };
    window.addEventListener("pagehide", flushQuietly);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", flushQuietly);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timerRef.current) clearTimeout(timerRef.current);
      flushQuietly();
    };
  }, []);

  return { draft, ready, saveState, updateDraft, retry };
}
