// gateway-wire.ts — point pi and opencode providers at the local gateway, stashing each original URL for unwire.
import fs from 'node:fs';
import path from 'node:path';

import { homeDir, piAgentDir } from '../extensions/shared/utils.ts';
import { gatewayRouteKey, readGatewayConfig, writeGatewayConfig } from '../extensions/shared/gateway.ts';
import type { GatewayConfig, GatewayProviderConfig } from '../extensions/shared/gateway.ts';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function writeJson(file: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** The file each host keeps its providers in: pi's models.json, opencode's opencode.json. */
export function gatewayHostConfigPath(host: 'pi' | 'opencode'): string {
  return host === 'pi'
    ? path.join(piAgentDir(), 'models.json')
    : path.join(homeDir(), '.config', 'opencode', 'opencode.json');
}

// pi lists providers at the root and names the URL `baseUrl`; opencode nests it under `provider.<name>.options.baseURL`.
function providersOf(config: Record<string, unknown>, host: 'pi' | 'opencode'): Record<string, unknown> | null {
  return asRecord(config[host === 'pi' ? 'providers' : 'provider']);
}

interface ProviderEntry {
  entry: Record<string, unknown>;
  container: Record<string, unknown>;
  key: string;
}

function entryOf(config: Record<string, unknown>, host: 'pi' | 'opencode', provider: string): ProviderEntry | null {
  const providers = providersOf(config, host);
  const entry = providers ? asRecord(providers[provider]) : null;
  if (!entry) return null;
  if (host === 'pi') return { entry, container: entry, key: 'baseUrl' };
  const options = asRecord(entry.options);
  return options ? { entry, container: options, key: 'baseURL' } : null;
}

function gatewayUrl(cfg: GatewayConfig, key: string): string {
  return `http://127.0.0.1:${cfg.port}/gw/${key}`;
}

/** The URL the host currently points a provider at, so the doctor can spot a stale wiring. */
export function gatewayProviderUrl(host: 'pi' | 'opencode', provider: string): string | null {
  const config = readJson(gatewayHostConfigPath(host));
  const found = config ? entryOf(config, host, provider) : null;
  if (!found) return null;
  const value = found.container[found.key];
  return typeof value === 'string' ? value : null;
}

export async function wireGatewayHost(host: 'pi' | 'opencode', provider: string): Promise<void> {
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
  if (host === 'pi') {
    // Without this, pi sends no session header and every turn would open its own session.
    const compat = asRecord(found.entry.compat) ?? {};
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

export async function unwireGatewayHost(host: 'pi' | 'opencode', provider?: string): Promise<void> {
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
      if (host === 'pi' && entry.compatAdded) {
        const compat = asRecord(found.entry.compat);
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
