"use client";

/**
 * ChangeOrderStrip — a compact board row of one section's change orders from the Slack review
 * thread (newest first, max 6), read from GET /api/change-orders. Polls every 10 s, unmount-safe.
 * Each cell: kind chip · clipped text · Ambiguous task id (or its honest status) · reviewer name.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { ChangeOrder } from "@/lib/contracts/review";
import {
  clipText,
  CO_POLL_MS,
  kindLabel,
  kindTone,
  reviewerName,
  stripOrders,
  taskLine,
  timeText,
} from "./change-order-logic";
import "./change-order-strip.css";

export function ChangeOrderStrip({ filmId, section }: { filmId: string; section: string }) {
  const key = `${filmId} ${section}`;
  const [shown, setShown] = useState<{ key: string; orders: ChangeOrder[] }>({ key: "", orders: [] });
  const [readError, setReadError] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      timer = undefined;
      try {
        const { changeOrders } = await api.changeOrders.list(filmId);
        if (!alive) return;
        setShown({ key, orders: stripOrders(changeOrders, section) });
        setReadError(null);
      } catch (error) {
        if (!alive) return;
        const message =
          error instanceof Error && error.message.trim()
            ? clipText(error.message, 160)
            : "Could not read the change orders.";
        setReadError({ key, message });
      }
      if (alive) timer = setTimeout(() => void tick(), CO_POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [filmId, section, key]);

  const loaded = shown.key === key;
  const orders = loaded ? shown.orders : [];
  const error = readError && readError.key === key ? readError.message : null;

  return (
    <section className="vco-strip" data-vettu="change-order-strip" aria-label="Change orders in this section">
      <header className="vco-head">
        <span className="vco-label">CHANGE ORDERS</span>
        <span className="vco-count">{orders.length}</span>
      </header>
      {error ? (
        <p className="vco-err" role="alert">
          {error}
        </p>
      ) : null}
      {loaded && orders.length === 0 && !error ? (
        <p className="vco-empty">No change orders from the review thread yet.</p>
      ) : null}
      {orders.length ? (
        <ol className="vco-list" aria-live="polite">
          {orders.map((order) => {
            const task = taskLine(order);
            const who = reviewerName(order.reviewer);
            const text = clipText(order.text, 90);
            const time = timeText(order.createdAt);
            return (
              <li key={order.id} className="vco-cell" data-order={order.id} data-kind={order.kind}>
                <div className="vco-line">
                  <span className="vco-kind" data-tone={kindTone(order.kind)}>
                    {kindLabel(order.kind)}
                  </span>
                  {typeof order.version === "number" ? <span className="vco-meta">v{order.version}</span> : null}
                  {time ? (
                    <time className="vco-meta" dateTime={order.createdAt}>
                      {time}
                    </time>
                  ) : null}
                </div>
                {text ? (
                  <span className="vco-text" title={clipText(order.text, 400)}>
                    {text}
                  </span>
                ) : null}
                <span className="vco-task" data-tone={task.tone}>
                  {task.href ? (
                    <a href={task.href} target="_blank" rel="noreferrer">
                      {task.text}
                    </a>
                  ) : (
                    task.text
                  )}
                </span>
                {task.error ? <span className="vco-err">{task.error}</span> : null}
                {who ? <span className="vco-who">{who}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
