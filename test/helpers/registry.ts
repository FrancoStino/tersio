// A registry answer for the update check, as a URL the real `fetch` reads. A data: URL keeps the
// tests listener-free: no port to pick, no firewall prompt on Windows, nothing to tear down.
export function registryUrl(version: string): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ version }))}`;
}
