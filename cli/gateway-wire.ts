// gateway-wire.ts — point pi and opencode providers at the local gateway, stashing each original URL for unwire.
import fs from 'node:fs';
import path from 'node:path';

import { homeDir, isRecord, piAgentDir } from '../extensions/shared/utils.ts';
import { gatewayRouteKey, readGatewayConfig, writeGatewayConfig } from '../extensions/shared/gateway.ts';
import type { GatewayConfig, GatewayProviderConfig } from '../extensions/shared/gateway.ts';

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Everything Tersio needs to know about a host's provider config. A new host is one row. */
interface HostWiring {
  /** The file the host keeps its providers in. */
  file: () => string;
  /** The root key that holds the providers. */
  root: 'providers' | 'provider';
  /** The key inside a provider entry that holds the base URL. */
  urlKey: 'baseUrl' | 'baseURL';
  /** The provider entry nests its options instead of carrying the URL itself. */
  nested?: true;
  /** This host only names its session when the adapter's compat flag is on. */
  affinity?: true;
}

const WIRED_HOSTS: Record<'pi' | 'opencode', HostWiring> = {
  pi: { file: () => path.join(piAgentDir(), 'models.json'), root: 'providers', urlKey: 'baseUrl', affinity: true },
  opencode: { file: () => path.join(homeDir(), '.config', 'opencode', 'opencode.json'), root: 'provider', urlKey: 'baseURL', nested: true },
};

export type WiredHost = keyof typeof WIRED_HOSTS;

/** The hosts `wire` can edit today; capture itself accepts any host id. */
export const WIRED_HOST_IDS = Object.keys(WIRED_HOSTS) as WiredHost[];

export function isWiredHost(host: string): host is WiredHost {
  return Object.hasOwn(WIRED_HOSTS, host);
}

export function gatewayHostConfigPath(host: WiredHost): string {
  return WIRED_HOSTS[host].file();
}

function providersOf(config: Record<string, unknown>, host: WiredHost): Record<string, unknown> | null {
  const providers = config[WIRED_HOSTS[host].root];
  return isRecord(providers) ? providers : null;
}

interface ProviderEntry {
  entry: Record<string, unknown>;
  container: Record<string, unknown>;
  key: string;
}

function entryOf(config: Record<string, unknown>, host: WiredHost, provider: string): ProviderEntry | null {
  const providers = providersOf(config, host);
  const value = providers ? providers[provider] : undefined;
  const entry = isRecord(value) ? value : null;
  if (!entry) return null;
  const wiring = WIRED_HOSTS[host];
  if (!wiring.nested) return { entry, container: entry, key: wiring.urlKey };
  const options = isRecord(entry.options) ? entry.options : null;
  return options ? { entry, container: options, key: wiring.urlKey } : null;
}

function gatewayUrl(cfg: GatewayConfig, key: string): string {
  return `http://127.0.0.1:${cfg.port}/gw/${key}`;
}

/** The URL the host currently points a provider at, so the doctor can spot a stale wiring. */
export function gatewayProviderUrl(host: string, provider: string): string | null {
  if (!isWiredHost(host)) return null;
  const config = readJson(gatewayHostConfigPath(host));
  const found = config ? entryOf(config, host, provider) : null;
  if (!found) return null;
  const value = found.container[found.key];
  return typeof value === 'string' ? value : null;
}

export async function wireGatewayHost(host: WiredHost, provider: string): Promise<void> {
  const file = gatewayHostConfigPath(host);
  const config = readJson(file);
  if (!config) {
    console.error(`[fail] Cannot read ${file}; wire the provider by hand or run the host once to create it.`);
    process.exitCode = 1;
    return;
  }
  const found = entryOf(config, host, provider);
  if (!found) {
    const names = Object.keys(providersOf(config, host) ?? {});
    const listed = names.length > 0 ? ` (available: ${names.join(', ')})` : '';
    console.error(`[fail] No provider "${provider}" in ${file}${listed}`);
    process.exitCode = 1;
    return;
  }
  const cfg = readGatewayConfig();
  const key = gatewayRouteKey(host, provider);
  const prior = cfg.providers[key];
  // A re-wire after a port change keeps the original upstream: the host now holds the gateway URL.
  const upstream = prior?.url ?? (typeof found.container[found.key] === 'string' ? String(found.container[found.key]) : '');
  if (upstream === '') {
    console.error(`[fail] Provider "${provider}" has no base URL to forward to.`);
    process.exitCode = 1;
    return;
  }
  let compatAdded = prior?.compatAdded === true;
  if (WIRED_HOSTS[host].affinity) {
    // Without this, pi sends no session header and every turn would open its own session.
    const compat = isRecord(found.entry.compat) ? found.entry.compat : {};
    if (compat.sendSessionAffinityHeaders !== true) {
      compat.sendSessionAffinityHeaders = true;
      found.entry.compat = compat;
      compatAdded = true;
    }
  }
  found.container[found.key] = gatewayUrl(cfg, key);
  const wired: GatewayProviderConfig = { host, provider, url: upstream, ...(compatAdded ? { compatAdded: true } : {}) };
  cfg.providers[key] = wired;
  writeJson(file, config);
  writeGatewayConfig(cfg);
  console.log(`[ok] ${host} provider "${provider}" → ${gatewayUrl(cfg, key)} (upstream ${upstream})`);
  console.log("Start the gateway with `tersio gateway` so the host's requests pass through it.");
}

export async function unwireGatewayHost(host: WiredHost, provider?: string): Promise<void> {
  const cfg = readGatewayConfig();
  const keys = Object.keys(cfg.providers).filter((key) => {
    const entry = cfg.providers[key];
    return entry.host === host && (provider === undefined || entry.provider === provider);
  });
  if (keys.length === 0) {
    console.log(`[ok] No gateway wiring for ${host}${provider ? ` provider "${provider}"` : ''}`);
    return;
  }
  const file = gatewayHostConfigPath(host);
  const config = readJson(file);
  for (const key of keys) {
    const entry = cfg.providers[key];
    const found = config ? entryOf(config, host, entry.provider) : null;
    if (found) {
      found.container[found.key] = entry.url;
      if (WIRED_HOSTS[host].affinity && entry.compatAdded) {
        const compat = isRecord(found.entry.compat) ? found.entry.compat : null;
        if (compat) {
          delete compat.sendSessionAffinityHeaders;
          if (Object.keys(compat).length === 0) delete found.entry.compat;
        }
      }
      console.log(`[ok] ${host} provider "${entry.provider}" → ${entry.url}`);
    } else {
      console.log(`[warn] ${host} provider "${entry.provider}" is gone from ${file}; dropped its stash only.`);
    }
    delete cfg.providers[key];
  }
  if (config) writeJson(file, config);
  writeGatewayConfig(cfg);
}

/** One line per wired provider; the health probe is best-effort, so an offline gateway still lists. */
export function printGatewayWiring(): void {
  const cfg = readGatewayConfig();
  const keys = Object.keys(cfg.providers);
  if (keys.length === 0) {
    console.log('No providers are wired through the gateway. Wire one with `tersio gateway wire --host <pi|opencode> --provider <name>`.');
    return;
  }
  for (const key of keys) {
    const entry = cfg.providers[key];
    console.log(`  ${entry.host.padEnd(8)} ${entry.provider.padEnd(16)} → ${gatewayUrl(cfg, key)}  (upstream ${entry.url})`);
  }
  console.log(`Recording: ${cfg.record ? 'on' : 'off'} · retention 7 days / 256 MiB`);
}
