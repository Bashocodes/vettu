"use client";

/**
 * Board + WORLD data hooks. One fetch path for the hand and the agent: `api.*` from api-client.
 * Re-fetch on window focus and every 15 s; a sequence counter drops stale replies.
 * A timeline 404/500 never breaks the board (timeline stays null).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api-client";
import type { BoardView } from "./contracts/board-view";
import type { Timeline } from "./contracts/timeline";
import type { WorldView } from "./contracts/world-view";

const POLL_MS = 15_000;

function controlledMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  return fallback;
}

export interface FilmData {
  board: BoardView | null;
  timeline: Timeline | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

export function useFilm(filmId: string | null, options: { timeline?: boolean } = {}): FilmData {
  const wantTimeline = options.timeline !== false;
  const [board, setBoard] = useState<BoardView | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(filmId));
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!filmId) return;
    const mine = ++seq.current;
    try {
      const nextBoard = await api.films.board(filmId);
      if (mine !== seq.current) return;
      setBoard(nextBoard);
      setError(null);
      let nextTimeline: Timeline | null = null;
      if (wantTimeline && nextBoard.active) {
        try {
          nextTimeline = await api.cut.timeline(filmId, nextBoard.active);
        } catch {
          nextTimeline = null;
        }
      }
      if (mine !== seq.current) return;
      setTimeline(nextTimeline);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(controlledMessage(e, "Could not load the film board."));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [filmId, wantTimeline]);

  useEffect(() => {
    setBoard(null);
    setTimeline(null);
    setError(null);
    if (!filmId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
      seq.current += 1;
    };
  }, [filmId, refresh]);

  return { board, timeline, loading, error, refresh };
}

export interface WorldData {
  world: WorldView | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

export function useWorld(filmId: string | null): WorldData {
  const [world, setWorld] = useState<WorldView | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(filmId));
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!filmId) return;
    const mine = ++seq.current;
    try {
      const next = await api.films.world(filmId);
      if (mine !== seq.current) return;
      setWorld(next);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(controlledMessage(e, "Could not load the world."));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [filmId]);

  useEffect(() => {
    setWorld(null);
    setError(null);
    if (!filmId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
      seq.current += 1;
    };
  }, [filmId, refresh]);

  return { world, loading, error, refresh };
}
