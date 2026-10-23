#!/usr/bin/env node
// Install Tersio add-ons on any OMP device; see help for commands.
import {
  PACKAGE_BIN, PACKAGE_VERSION, applyUpdate, args, commandArg, dashboard, dashboardExport, dashboardOpen, dashboardPort, doctor, mcp, showHelp, showVersion, uninstall, unknownCommand, update, upstream,
  currency,
} from './cli/common.ts';
import { closeRL } from './cli/interactive.ts';
import { runInstall } from './cli/install.ts';
import { runDoctor } from './cli/doctor.ts';
import { runMcpHttpServer, runMcpServer } from './cli/mcp.ts';
import { runLatestUpdate } from './cli/update.ts';
import { runUninstall } from './cli/uninstall.ts';
import { runUpstream } from './cli/upstream.ts';
import { runDashboard } from './cli/dashboard.ts';

function printHelp(): void {
  console.log(`Usage: ${PACKAGE_BIN} [command] [options]

Commands:
  install      Install the add-ons for one agent (--host omp|pi|opencode, or ask at a terminal)
  update       Refresh the CLI and add-ons (RTK binary, Caveman rule, Ponytail; --host limits to one agent)
  doctor       Check the current installation (--fix repairs, --dry-run previews)
  dashboard     Open the Dashboard (localhost only)
  mcp           Start the Tersio MCP server on stdio; --http serves a local URL with a Bearer header (--port, default 7677)
  uninstall    Remove the managed extensions
  version      Print the package version
  help         Show this help

Options:
  --fix (doctor: repairs all; --fix=<scope> repairs one of extensions, registrations, rtk, ponytail, cli, service)
  --scope user (legacy; accepted and ignored — user scope is the only scope)
  --host omp|pi|opencode (install|uninstall|update: target agent; a terminal asks instead)
  --keep-ponytail (uninstall: keep the bundled Ponytail copy — removed by default)
  --remove-rtk (uninstall: also remove the RTK binary; its OMP wiring always goes)
  --combo-default off|lite|balanced|max (implies caveman, rtk, ponytail)
  --caveman-default off|lite|full|ultra|megacave-lite|megacave-full|megacave-ultra (override; default follows combo)
  --ponytail-default off|lite|full|ultra (override; default follows combo)
  --rtk-default on|off (override; default follows combo)
  --yes, -y
  --dry-run
  --verbose
  --port <n> (dashboard: pin port, default ephemeral)
  --open (dashboard: open browser)
  --export <file> (dashboard: write HTML file instead of serving)
  --currency <code> (dashboard: display currency; flag wins, then tersio settings default, then USD)
  --version, -v
  --help, -h`);
}

async function main(): Promise<void> {
  if (showVersion) {
    console.log(PACKAGE_VERSION);
    closeRL();
    return;
  }

  if (showHelp) {
    printHelp();
    closeRL();
    return;
  }

  if (unknownCommand) {
    console.error(`Unknown command: ${commandArg}`);
    printHelp();
    process.exitCode = 1;
    closeRL();
    return;
  }

  if (update && !applyUpdate) {
    await runLatestUpdate();
    closeRL();
    return;
  }

  if (mcp) {
    // HTTP serves the URL-and-header form a static mcp.json wants; stdio is the default a client spawns itself.
    if (args.includes('--http')) await runMcpHttpServer(dashboardPort || 7677);
    else await runMcpServer();
    closeRL();
    return;
  }

  if (doctor) {
    await runDoctor();
    closeRL();
    return;
  }

  if (upstream) {
    await runUpstream();
    closeRL();
    return;
  }

  if (dashboard) {
    await runDashboard({ port: dashboardPort, open: dashboardOpen, exportFile: dashboardExport, currency });
    closeRL();
    return;
  }


  if (uninstall) {
    await runUninstall();
    closeRL();
    return;
  }
  await runInstall();
}

main().catch((e) => { closeRL(); console.error(e); process.exitCode = 1; });
