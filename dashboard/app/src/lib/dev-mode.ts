// The developer toggle behind Settings > About. It gates the surfaces an operator never needs.
// The server owns the value, in ~/.tersio/settings.json: the dashboard binds a new port each run, so
// a browser store would forget the switch on the next launch. A file export has no server, so it
// keeps the value in localStorage instead.
import { useSyncExternalStore } from "react";
import { isFileExport } from "./data";

const STORAGE_KEY = "tersio-dev";

const listeners = new Set<() => void>();
let current = false;
let hydrated = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!hydrated) hydrate();
  // A second tab that flips the toggle carries no local event, so the storage event relays it.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function snapshot(): boolean {
  return current;
}

/** Read the saved value once: the server when there is one, else the browser store. */
function hydrate(): void {
  hydrated = true;
  if (isFileExport() || typeof fetch !== "function") {
    current = localStorage.getItem(STORAGE_KEY) === "1";
    emit();
    return;
  }
  fetch("/settings")
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { devTools?: unknown } | null) => {
      if (typeof data?.devTools === "boolean") {
        current = data.devTools;
        emit();
      }
    })
    .catch(() => { /* keep the default; the switch still saves */ });
}

export function setDevMode(on: boolean): void {
  current = on;
  emit();
  // The browser copy is the export fallback, and it makes the next paint correct before the round trip.
  localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  if (isFileExport() || typeof fetch !== "function") return;
  void fetch("/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ devTools: on }),
  }).catch(() => { /* the switch stays on screen; the next load reports the truth */ });
}

export function useDevMode(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
