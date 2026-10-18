// The developer toggle behind Settings > About. It gates the surfaces an operator never needs.
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "tersio-dev";

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // A second tab that flips the toggle carries no local event, so the storage event relays it.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function snapshot(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function setDevMode(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  for (const listener of listeners) listener();
}

export function useDevMode(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
