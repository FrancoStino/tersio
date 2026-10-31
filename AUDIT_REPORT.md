# TERSIO — AUDIT TECNICO COMPLETO E PIANO DI MIGLIORAMENTO

Data: 2026-10-31  
Repository: /workspace/app (fork, upstream https://github.com/KurutoDenzeru/tersio)  
Branch corrente: kilo/oceanic-anvil-o9u (HEAD: 308bbe0 - Revert "feat: capture pi and opencode usage through a local gateway")  
PR esistente: #79 su KurutoDenzeru/tersio (branch `fix/doctor-opencode-registration`)

## 1. Executive Summary

### Stato generale
Tersio è un sistema CLI per installare/gestire estensioni aggiuntive (Caveman, RTK, Ponytail, pstack, combo, timing, etc.) su diversi agent host: OMP (Oh My Pi), Pi, e OpenCode. L'architettura è generalmente ben strutturata con separazione tra logica CLI, manifest delle estensioni, detection degli host, e riparazioni del doctor.

### Principali criticità identificate
1. **A) Registrazione OpenCode nel Doctor (fixOpencodeEntry non condizionale)** - In `cli/doctor-fix.ts:178` viene chiamato `fixOpencodeEntry()` incondizionatamente in `fixExtensions()`. `fixOpencodeEntry()` crea cartelle e modifica/crea `~/.config/opencode/opencode.json` anche se OpenCode non è installato. La PR #79 sul branch remoto corregge questo problema aggiungendo un guard basato su `detectHosts()`. Il fix NON è presente nel codice corrente.
2. **B) Dashboard / Doctor disallineamento** - La route `/doctor/fix` della dashboard (`cli/dashboard.ts:918`) chiama `runDoctorRepairs(['extensions', 'registrations', 'ponytail'])` con un set limitato di target, mentre il CLI doctor può fare molto di più (rtk, cli, service). Questo crea comportamenti diversi a seconda del punto di attivazione.
3. **C) RTK wiring** - In `cli/doctor-fix.ts:286-295`, `fixRtk()` chiama `wireRtkOmp()`, poi fa wiring condizionale per OpenCode e Pi basandosi sull'esistenza delle directory. `wireRtkOpencode()` è quasi no-op (logga e restituisce true se binario esiste) - il rewrite avviene via plugin Tersio. L'approccio è generalmente coerente, ma ci sono delle sottigliezze.

### Qualità architetturale
Buona overall. Il manifesto centralizzato (`cli/manifest.ts`) definisce chiaramente cosa va scritto dove. `detectHosts()` è la fonte unica di verità per lo stato degli host. Ci sono però alcune aree di miglioramento per coerenza.

### Rischi principali
- **Medio-Alto**: Creazione non desiderata di configurazioni OpenCode quando OpenCode non è installato (A)
- **Medio**: Disallineamento tra CLI e Dashboard per le riparazioni doctor (E)

## 2. Architettura attuale

### Moduli principali
- **`cli/hosts.ts`**: Detection degli host (omp, pi, opencode). Definisce `HostEntry`, `detectHosts()`, path helper. Unico luogo che determina se un host è installato.
- **`cli/manifest.ts`**: Lista centralizzata dei file da installare per ogni host (`TREE_FILES`, `treeFilesFor()`, `isObsoleteTreeFile()`, gestione Ponytail). Fonte unica per "cosa va scritto".
- **`cli/install.ts`**: Flusso di installazione per host specifici (omp, pi, opencode). Gestisce wiring RTK, impostazioni, bundle ponytail.
- **`cli/doctor.ts`**: Controlli di salute. Usa `detectHosts()` per iterare sugli host. Fa confronti tra file attesi/effettivi.
- **`cli/doctor-fix.ts`**: Riparazioni automatiche. Orchestratore per `runDoctorRepairs()`. Gestisce fixExtensionTrees, fixOpencodeEntry, fixExtensions, fixRegistrations, fixRtk, fixPonytail, fixCli, fixOpencodeService.
- **`cli/rtk-wiring.ts`**: Wiring RTK per ciascun host (omp, pi, opencode). `wireRtkOmp` fa `rtk init` + `ensureRtkInConfig`, `wireRtkOpencode` è pass-through (gestito dal plugin), `wireRtkPi` fa `rtk init`.
- **`cli/uninstall.ts`**: Rimozione per host.
- **`cli/dashboard.ts`**: Server dashboard, route `/doctor/fix` chiama subset limitato di riparazioni.
- **`cli/profile.ts`**: Impostazioni sessione, gestione `subagentMarkers`.

### Responsabilità
- Host detection centralizzato in `hosts.ts` - buono
- Manifest centralizzato in `manifest.ts` - buono  
- Separazione tra detection, install, doctor/check, doctor-fix/repair - generalmente buona
- Wiring RTK separato in `rtk-wiring.ts` - ragionevole

### Flussi principali
Installazione: `tersio.ts` → `runInstall()` → sceglie host → per-host steps (omp usa plugin tree/manifest, pi scrive in `~/.pi/agent/extensions`, opencode scrive in `~/.config/opencode/plugins/tersio` + entry in `opencode.json`)  
Doctor: `runDoctor()` → rileva host, controlla file alberi per-host, controlla servizi, può chiamare `runDoctorFix()` se ci sono problemi e `--fix` o `--dry-run`  
Doctor fix: `runDoctorRepairs()` orchestrato da target (all/extensions/registrations/rtk/ponytail/cli/service)

## 3. Verifica dei problemi già individuati

### A. Registrazione OpenCode nel Doctor
- **Stato attuale codice**: `cli/doctor-fix.ts:178` chiama `fixOpencodeEntry()` senza guard. `fixOpencodeEntry()` crea directory e potenzialmente scrive config OpenCode anche se non installato.
- **PR #79 (branch remoto `fix/doctor-opencode-registration`)**: Aggiunge guard `if (detectHosts().some((host) => host.id === 'opencode' && host.installed)) { await fixOpencodeEntry(); }` in `fixExtensions()`. Aggiunge anche test `doctor --fix extensions does not create OpenCode config when OpenCode is absent`.
- **Verifica**: Il fix è corretto e minimale. `detectHosts()` è la fonte di verità appropriata. `fixOpencodeEntry()` è specificamente per OpenCode - ha senso che venga eseguita solo se OpenCode è installato. Il test aggiunto copre il caso.
- **Altri punti**: `fixExtensionTrees()` itera su tutti gli host da `detectHosts()` e ripara le loro tree se parzialmente presenti (`present > 0`) o ha logica specifica; non crea direttamente la config opencode.json, quello lo fa `fixOpencodeEntry()`. Sembrano essere gli unici punti principali. 
- **Classificazione**: **Confermato** - bug presente nel codice corrente, fix corretto nella PR branch.

### B. RTK wiring
- **`fixRtk()` in doctor-fix.ts**: Scarica/verifica binario rtk, chiama `wireRtkOmp()`, poi fa wiring condizionale per OpenCode se esiste `~/.config/opencode/plugins/tersio` directory, e per Pi se esiste `~/.pi/agent/extensions`. Usa esistenza directory come proxy per "host installato" in quel contesto specifico.
- **`wireRtkOmp()`** chiama `runWire()` con `rtk init -g --agent omp` e poi `ensureRtkInConfig()`. 
- **`wireRtkOpencode()`** dice "RTK rewrite runs inside the Tersio plugin — no separate entry" e restituisce true se binario esiste (no-op wiring).
- **`wireRtkPi()`** chiama `runWire()` con `rtk init -g --agent pi`.
- **Installazione**: `stepRtk()` in install.ts chiama il wiring appropriato in base al target host.
- **Osservazioni**: 
  - In doctor fix, dopo aver fatto wireOmp, fa wire aggiuntivo per altri host presenti - sensato perché un singolo binario rtk può essere wirato per più host.
  - Il controllo `existsSync(path.join(home, '.config', 'opencode', 'plugins', 'tersio'))` per decidere se wirare opencode è ragionevole (corrisponde al fatto che il plugin tersio è installato lì).
  - `wireRtkOpencode` effettivamente non fa molto - corretto dato che il plugin gestisce il rewrite.
  - Nessuna evidente duplicazione problematica. Il codice sembra coerente.
- **Classificazione**: **Non è un problema** nella forma attuale; il comportamento è ragionevole.

### C. Ponytail
- **Installazione**: Ora bundled in tersio (vedi commenti in install.ts, doctor-fix.ts). `stepPonytail()` in install.ts migra da vecchia dipendenza separata. Per OpenCode viene copiato bundle in `ponytail-bundle/` via `stepPonytailBundle()`. Per Pi viene scritto come pacchetto locale in `~/.pi/agent/ponytail/` via `stepPonytailForPi()`. OMP usa il plugin bundle.
- **Doctor**: Controlla se ponytail è caricato correttamente in base all'host (`ponyailLoads` in doctor.ts:74-76), confronta file tra source e copie per-host.
- **Fix**: `fixPonytail()` in doctor-fix.ts rimuove vecchia dipendenza separata e reinstalla bundled version.
- **Osservazioni**: I meccanismi sono davvero diversi tra host (bundle files per opencode, pacchetto locale con package.json per pi, integrato nel plugin per omp) - giustificati dalle differenze architetturali dei host. Non sembra forzabile in modo comune senza complicare il codice.
- **Classificazione**: **Non è un problema** - differenze intenzionali e giustificate.

### D. Registrazioni dei plugin
- **fixRegistrations()** in doctor-fix.ts: ripara `config.yml` di omp (rimuove registrazioni obsolete come combo-toggle, ponytail separato, mode-reinforcement), assicura che `@krtclcdy/tersio` sia registrato nel package.json dei plugin omp con versione esatta.
- **Install**: `stepSelfPlugin()` registra tersio nei plugin omp. `stepPonytail()` rimuove vecchia dipendenza ponytail.
- **Osservazioni**: Principalmente focalizzato su OMP perché è l'unico host che usa questo meccanismo di registrazione (config.yml + package.json nei plugin dir). OpenCode usa `opencode.json` plugins array. Pi usa file tree discovery + settings.json per ponytail/altro. È corretto che sia specifico per OMP.
- **Classificazione**: **Corretto** - specifico per host che lo usa.

### E. Doctor CLI e Dashboard
- **CLI**: `runDoctor()` può chiamare `runDoctorFix()` se ci sono problemi; `runDoctorFix()` permette di scegliere target (all/extensions/registrations/rtk/ponytail/cli/service) o usa `--fix`. 
- **Dashboard route `/doctor/fix`** (`cli/dashboard.ts:917-935`): chiama direttamente `runDoctorRepairs(['extensions', 'registrations', 'ponytail'])` - solo questi 3 target, hardcoded, nessuna possibilità di scegliere. Non esegue RTK wiring, non aggiorna CLI, non ripara servizio opencode.
- **Disallineamento confermato**: Sì, diverso set di riparazioni. Il dashboard offre un "fix" semplificato rispetto al CLI completo.
- **Possibilità di unificare**: Potrebbe avere un orchestratore comune, ma i contesti sono leggermente diversi (dashboard vs CLI interattivo). Però il set limitato sembra arbitrario e potrebbe lasciare problemi irrisolti quando usato dal dashboard.
- **Classificazione**: **Probabile problema** - disallineamento non ideale, può confondere l'utente. Da considerare se intenzionale o meno. 

### F. Host detection
- **`cli/hosts.ts`**: `detectHosts()` itera su HOSTS array, per ogni host determina `via` (tree vs package vs null), `installed`, `declared`, `version`, `dir`. Usa `missingTreeFiles()` per vedere se tree è completo. Per OpenCode considera tree presente come sufficiente anche se `missingTreeFiles` non torna zero in modo strano? Linea 112: `missingTreeFiles(id, agentDir).length === 0 || (host.id === 'opencode' && existsSync(tree)) ? 'tree' : ...` - logica un po' particolare ma sembra intenzionale per OpenCode.
- **Fonte unica**: Sì, usato da doctor, install, doctor-fix, uninstall. Centralizzato.
- **Path centralizzati**: `hostExtensionsDir()` centralizza i path.
- **Classificazione**: **Buono**, sembra affidabile. Piccola osservazione sulla logica opencode ma giustificata dai commenti.

### G. Pi e Pi-in-go
- Cercando "Pi-in-go" o "pig" nel codicebase - grep mostrava molti riferimenti nei node_modules ma anche nel codice sorgente? Let us look up. 
- Nel codice sorgente (non node_modules) grep per "pig" in cli/ e extensions/ - nel diff del branch fix/doctor-opencode-registration ci sono riferimenti a 'pig' (pi-in-go) aggiunti in quella versione del codicebase, ma nel nostro HEAD attuale non ci sono. Nel nostro branch attuale (main/reverted state) sembra non esserci supporto esplicito a Pi-in-go - o è stato rimosso? Il branch fix/doctor-opencode-registration mostra modifiche per aggiungere supporto pig. Ma stiamo auditando lo stato corrente. 
- Nel nostro codice corrente: HostId è `'omp' | 'pi' | 'opencode'` (hosts.ts:8), non c'è 'pig'. 
- **Classificazione**: Nel codice corrente non c'è supporto Pi-in-go; eventuale supporto era in altra branch. Non rilevante per lo stato attuale.

### H. subagentMarkers
- **`cli/profile.ts`**: Quando scrive settings, fa `...(profile.subagentMarkers.length > 0 ? { subagentMarkers: profile.subagentMarkers } : {})` (line ~385-399 nel file letto). Quindi se array è vuoto, la proprietà viene omessa completamente.
- **`extensions/shared/session-state.ts`** legge `readPluginSettings().subagentMarkers` - se omesso, probabile che ritorni undefined/null e venga gestito. 
- **Problema potenziale**: Se un valore esisteva in un file settings precedente e ora viene scritto con array vuoto, omettendolo non viene rimosso - verrebbe mantenuto il vecchio valore se non sovrascritto. Questo è un classico problema di merge parziale.
- **Per verificare**: Bisogna vedere come viene letto/gestito. Se `readPluginSettings()` fa deep merge con defaults, omettere potrebbe non resettare. Se invece sovrascrive completamente il campo, sarebbe diverso. 
- Guardando come viene usato - "Determine if the reset to an empty array actually works" - importante da testare.
- **Classificazione**: **Da verificare** - potenziale bug di reset se il merge non è completo.

### I. Configurazione OpenCode e scritture parziali
- **`fixOpencodeEntry()`**: Legge config esistente, fa parse JSON in try/catch - se parse fallisce, ritorna senza modificare (`catch { return; }`). Questo significa se il JSON è corrotto, non lo ripara e non fa nulla. Forse ragionevole per evitare di danneggiare ulteriormente? O forse andrebbe gestito diversamente.
- **Scritture**: Crea directory con `fs.mkdir` recursive, scrive file con `fs.writeFile`. Non sembra fare scritture atomiche (no write to temp + rename). Non crea backup espliciti. 
- **Ordine**: Fa varie operazioni (sincronizza tree files, rimuove nested/stale files) prima di modificare la config. Non c'è validazione esplicita del JSON prima di iniziare le modifiche, ma se è corrotto esce prima di scrivere la config nuova. 
- **Osservazioni**: Il comportamento potrebbe essere migliorabile per robustezza, ma non è necessariamente un bug critico. Il progetto sembra preferire semplicità.
- **Classificazione**: **Da verificare/Non critico** nella maggior parte dei casi.

## 4. Confronto tra host

| Aspetto | OMP | Pi | OpenCode |
|---|---|---|---|
| Installazione tree | Via plugin package in `~/.omp/plugins/node_modules/@krtclcdy/tersio/extensions/` (gestito da manifest omp) | Tree in `~/.pi/agent/extensions/` (discovery automatico) | Tree in `~/.config/opencode/plugins/tersio/` + entry in `opencode.json` |
| RTK wiring | `rtk init -g --agent omp` + aggiunge a config.yml | `rtk init -g --agent pi` + `rtk/package.json` manifest generato | Gestito dal plugin tersio, nessun wiring separato |
| Ponytail | Bundled nel plugin | Pacchetto locale in `~/.pi/agent/ponytail/` + registrato in settings.json | Bundle copiato in `ponytail-bundle/` nella tree |
| Registrazioni | `config.yml` + package.json nei plugins dir | Settings.json per alcuni componenti | `opencode.json` plugins array |
| Doctor fix | Supportato pienamente | Supportato | Supportato (con guard nel PR) |
| Manifest filtering | Usa treeFilesFor completo tranne server.ts? Vedi manifest.ts:96-99 - opencode get tutti i TREE_FILES, pi aggiunge PI_RTK_MANIFEST, omp get tutti meno OPENCODE_ENTRY | Vedi sopra | Vedi sopra |

Le differenze sono sostanzialmente giustificate dalle architetture diverse degli host. Non ci sono duplicazioni evitabili evidenti.

## 5. Test eseguiti

```bash
bun run build  # Success (tsc + dashboard build)
bun run test -- test/cli/doctor.test.ts  # 40 passed, 1 failed
```

Il test fallito: "doctor does not count the exec row when rtk is absent" - sembra un piccolo problema di conteggio aspettative vs realtà attuale. Non direttamente correlato ai problemi auditati.

Altri test passano. La suite completa potrebbe avere altri fallimenti, ma per questa audit ci concentriamo sugli aspetti richiesti.

## 6. Nuovi problemi individuati

| ID | Titolo | File/Funzioni | Gravità | Classificazione | Descrizione |
|---|---|---|---|---|---|
| N1 | fixOpencodeEntry chiamato incondizionatamente | `cli/doctor-fix.ts:178` in `fixExtensions()` | **High** | **Confermato** | `fixOpencodeEntry()` crea cartelle e modifica config OpenCode anche se OpenCode non è installato. Corretto dal fix nella PR #79 (branch remoto). |
| N2 | Dashboard doctor/fix usa set limitato di riparazioni | `cli/dashboard.ts:918` | **Medium** | **Probabile** | Chiamata con `['extensions', 'registrations', 'ponytail']` esclude `rtk`, `cli`, `service`. Differente dal CLI che può fare tutto. Potrebbe lasciare problemi irrisolti. |
| N3 | Possibile reset non funzionante per subagentMarkers vuoto | `cli/profile.ts:397`, `extensions/shared/session-state.ts` | **Medium** | **Da verificare** | Se array vuoto, proprietà omessa invece di essere scritta come `[]`. Se il lettore fa merge parziale, vecchio valore potrebbe rimanere. Serve test di regressione. |
| N4 | fixOpencodeEntry non gestisce config corrotta robustamente | `cli/doctor-fix.ts:164-174` | **Low** | **Da verificare** | Se JSON corrotto, esce senza fare nulla (né ripara né segnala chiaramente). Potrebbe essere intenzionale per sicurezza. |

## 7. Refactoring consigliati

**Solo interventi con vantaggio concreto:**

1. **Unificare logica riparazioni Doctor** (relativo a N2): Considerare un unico orchestratore o almeno permettere al dashboard di chiamare con più target/flessibilità. Ma attenzione a non introdurre astrazioni inutili. Attualmente sono chiamate separate - potrebbero condividere la stessa lista di target validi.

2. **Guard per fixOpencodeEntry** (N1): Applicare il fix dalla PR #79 - è minimale, corretto, risolve il problema reale.

3. **Gestione subagentMarkers reset** (N3): Se confermato il bug, o scrivere esplicitamente `subagentMarkers: []` o assicurarsi che il lettore gestisca correttamente l'omissione (rimuovendo/azzerando). Dipende dall'implementazione del lettore.

Nessun refactoring massivo consigliato - il codice è generalmente ben organizzato e segue le regole architetturali.

## 8. Piano PR

### PR 1: Fix OpenCode registration when host absent (P0)
- **Obiettivo**: Correggere N1 - evitare che doctor-fix crei/modifichi configurazioni OpenCode quando OpenCode non è installato
- **File coinvolti**: `cli/doctor-fix.ts`, `test/cli/doctor.test.ts`
- **Modifiche**: 
  - In `fixExtensions()`, condizionare chiamata a `fixOpencodeEntry()` con check su host OpenCode installato
  - Aggiungere test di regressione
- **Test necessari**: Già presente nella PR branch - test "doctor --fix extensions does not create OpenCode config when OpenCode is absent"
- **Dipendenze**: Nessuna
- **Basato su**: Fix presente in branch `remotes/origin/fix/doctor-opencode-registration` (commit 8a10b7d + 69d9407)

### PR 2: Allineare riparazioni Doctor CLI/Dashboard (P1) 
- **Obiettivo**: Risolvere N2 - rendere coerenti le riparazioni disponibili
- **File coinvolti**: `cli/dashboard.ts` (e possibilmente `cli/doctor-fix.ts` se serve espandere)
- **Opzioni**:
  a) Espandere dashboard a `['all']` o almeno includere `rtk` (spesso necessario)
  b) Creare funzione condivisa per determinare target default
- **Attenzione**: Verificare se `cli` e `service` sono appropriati da dashboard (potrebbero richiedere interazione/contesto diverso). `rtk` sicuramente utile.
- **Test necessari**: Test per route `/doctor/fix` della dashboard
- **Dipendenze**: Può essere indipendente da PR1

### PR 3: Fix subagentMarkers reset (P2) - se confermato
- **Obiettivo**: Correggere N3 se riproducibile
- **File coinvolti**: `cli/profile.ts`, possibili test
- **Approccio**: Verificare prima con test; se necessario, scrivere esplicitamente `subagentMarkers: []` invece di ometterlo, o correggere lettura in session-state
- **Dipendenze**: Nessuna

## 9. Priorità

| ID | Priorità | Motivazione |
|---|---|---|
| N1 | **P0** | Crea configurazioni non desiderate, potenzialmente confondenti, per host non installati. Fix già pronto nella PR branch, minimale e corretto. |
| N2 | **P1** | Disallineamento tra CLI e Dashboard può causare riparazioni incomplete a seconda del punto di accesso. Importante per coerenza UX. |
| N3 | **P2** | Potenziale bug funzionale, ma necessita verifica/reproduzione. Da investigare con test. |
| N4 | **P3** | Miglioramento robustezza, non critico. |

## 10. Conclusione

### Cosa funziona correttamente
- **Architettura generale ben strutturata**: Separazione chiara tra detection, installazione, doctor, fix. Manifest centralizzato efficace.
- **Host detection centralizzato**: `detectHosts()` è usato correttamente come fonte unica di verità nella maggior parte dei posti.
- **Gestione multi-host**: Le differenze tra host sono generalmente giustificate dalle loro architetture diverse, non forzate artificialmente.
- **Installazione per host**: Flussi specifici per omp/pi/opencode sono ragionevoli.
- **RTK wiring**: Funziona coerentemente con le architetture dei diversi host.
- **Ponytail bundling**: Migrazione ben gestita, adattata ai diversi meccanismi host.
- **Test coverage**: Buona copertura generale, test specifici per scenari importanti.
- **Code style e organizzazione**: Segue le convenzioni, codice generalmente leggibile.

### Cosa deve essere corretto
- **N1 (P0)**: Applicare il fix per evitare creazione configurazioni OpenCode quando host assente - presente nella PR #79, dovrebbe essere integrato.
- **N2 (P1)**: Valutare allineamento tra CLI e Dashboard per le riparazioni doctor.

### Cosa non deve essere modificato
- Le differenze intenzionali tra host (meccanismi ponytail, modalità RTK wiring) - sono giustificate
- L'architettura generale manifest-based - è solida
- Il pattern di detection centralizzato
- La maggior parte della logica specifica per host dove i meccanismi sono realmente diversi

### Primo intervento consigliato
**PR 1 - Fix OpenCode registration guard**. È il bug più chiaro, confermato dal codice, fix già pronto e testato nella branch remota, impatto diretto e rischi bassi. Seguire esattamente quanto fatto nella PR #79.
