// Pure, testable helpers for the hybrid codex-family RPC input lifecycle. Kept
// out of worker.ts (which auto-registers process handlers on import) so the gate
// and the pane-ownership detection can be unit-tested with injected probes.
import { execFileSync } from 'node:child_process';
import { readCmdline, readComm, getChildPids } from './core/session-discovery.js';
import type { DaemonToWorker } from './types.js';

type InitCfg = Extract<DaemonToWorker, { type: 'init' }>;

/** CLIs that expose the codex-family `app-server --listen` + `--remote resume`
 *  protocol the RPC engine drives. codex + traex are verified identical; coco
 *  diverges (--resume flag) and needs its own verification before inclusion. */
export const RPC_CAPABLE_CLIS = new Set(['codex', 'traex']);

/** All fail-closed gates for codex-family RPC input in ONE place so the worker's
 *  pane-branching and engageCodexRpc agree. Every excluded case degrades to the
 *  normal paste path — never a silent capability/security change:
 *   - disableCliBypass: RPC hardcodes approvalPolicy=never + dangerFullAccess, so
 *     engaging it for an approval-gated bot would silently upgrade it to full
 *     access (P1-1).
 *   - startupCommands: /effort etc. must run in the TUI before the first turn,
 *     but the fresh first turn is sent pre-spawn to persist the rollout — RPC
 *     can't honor that ordering, so fail-closed (P1-4).
 *   - wrapperCli / cliPathOverride: the app-server is launched as `<bin>
 *     app-server`, which a wrapper/alternate launcher won't satisfy the same way
 *     the TUI's buildArgs does — two launchers would diverge, so fail-closed
 *     (P1-2).
 *   - backendType !== 'tmux': the pane-ownership detection + controlled respawn
 *     are only wired for tmux. On herdr/zellij a surviving dead `--remote` pane
 *     would be misjudged as native and reattached, and pty has no persistent
 *     pane at all — so restrict RPC to tmux until each backend's replace path is
 *     built + verified. */
export function codexRpcEligible(cfg: InitCfg): boolean {
  const wantResume = cfg.resume === true && !!cfg.cliSessionId;
  return (
    cfg.codexRpcInput === true && RPC_CAPABLE_CLIS.has(cfg.cliId) &&
    cfg.backendType === 'tmux' &&
    cfg.adoptMode !== true && cfg.readIsolation !== true && cfg.sandbox !== true &&
    cfg.disableCliBypass !== true &&
    !cfg.startupCommands?.length &&
    !cfg.wrapperCli && !cfg.cliPathOverride &&
    (!!cfg.prompt || wantResume)
  );
}

export interface PaneProbes {
  panePidOf?: (sessionName: string) => number | undefined;
  argvOf?: (pid: number) => string[];
  commOf?: (pid: number) => string | undefined;
  childrenOf?: (pid: number) => number[];
}

/** Injected effects for the init-time RPC state machine (real ones wired by the
 *  worker; fakes by tests). */
export interface RpcInitEffects {
  paneInfo: (sessionId: string) => { name: string; live: boolean } | null;
  paneIsRemote: (sessionName: string) => boolean;
  engage: () => Promise<boolean>;          // engageCodexRpc(cfg) — sets the module engine on success
  killVerify: (sessionName: string) => Promise<boolean>; // kill stale pane, VERIFY gone
  teardownEngine: () => void;              // stop engine + clear remote vars
  log: (m: string) => void;
  notify: (m: string) => void;             // user-visible failure notice
}

export interface RpcInitDecision {
  /** RPC is active → spawnCli will launch the `--remote resume` TUI. */
  engaged: boolean;
  /** The init prompt must be QUEUED (resume path: delivered by flushPending →
   *  sendTurn once the TUI is ready) rather than pre-sent (fresh) or pasted. */
  queuePrompt: boolean;
  /** A stale `--remote` pane could not be replaced — the caller MUST NOT run
   *  spawnCli (it would reattach the dead pane against the fresh-port engine). */
  abortSpawn: boolean;
}

/** Pure init-time state machine for codex-family RPC, extracted so the
 *  fresh/resume/kill-failure ORDERING is unit-testable (the worker only wires
 *  real effects + acts on the decision). Mirrors the four cases:
 *   - not eligible                     → nothing (paste).
 *   - no live pane (fresh or resume-  → engage; fresh pre-sends the first turn
 *     without a surviving pane)          inside engage, resume must queue it.
 *   - live RPC-owned pane              → engage, then kill+VERIFY the stale pane;
 *                                         on success respawn (queue the prompt),
 *                                         on failure tear the engine down + abort
 *                                         spawn (never attach a stale remote pane
 *                                         to a fresh-port engine — Codex P0-2).
 *   - live native paste pane           → leave it (fail-closed paste, boundary #3). */
export async function orchestrateCodexRpcInit(cfg: InitCfg, fx: RpcInitEffects): Promise<RpcInitDecision> {
  const NONE: RpcInitDecision = { engaged: false, queuePrompt: false, abortSpawn: false };
  if (!codexRpcEligible(cfg)) return NONE;
  const wantResume = cfg.resume === true && !!cfg.cliSessionId;
  const pane = fx.paneInfo(cfg.sessionId);
  if (!pane || !pane.live) {
    const engaged = await fx.engage();
    // fresh (!wantResume) pre-sends the first turn inside engage (empty threads
    // can't be resumed by the TUI, so the rollout must exist first); resume has
    // no pre-send → its prompt must be queued for post-ready flush.
    return { engaged, queuePrompt: engaged && wantResume, abortSpawn: false };
  }
  if (fx.paneIsRemote(pane.name)) {
    const engaged = await fx.engage();
    if (!engaged) return NONE; // engine didn't come up → paste (nothing touched)
    const gone = await fx.killVerify(pane.name);
    if (gone) return { engaged: true, queuePrompt: true, abortSpawn: false }; // RPC-owned survivor ⇒ always a resume
    fx.teardownEngine();
    fx.notify('Codex RPC 会话恢复失败：无法替换旧 --remote 面板。请重试，或 /close 后重开会话。');
    fx.log(`Codex RPC resume: FAILED to kill stale --remote pane ${pane.name}; aborting init (never attach a stale remote pane to a fresh-port engine)`);
    return { engaged: false, queuePrompt: false, abortSpawn: true };
  }
  fx.log('Codex RPC: surviving pane is native paste (not RPC-owned) — keeping paste for this restore');
  return NONE;
}

function tmuxPanePid(sessionName: string): number | undefined {
  try {
    const out = execFileSync('tmux', ['display', '-t', sessionName, '-p', '#{pane_pid}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    const n = Number(out);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}

/** Does the surviving persistent pane run a botmux RPC `--remote` TUI (vs a
 *  native paste codex/traex)? Walks the pane's process tree and inspects the LEAF
 *  argv (Linux /proc + macOS ps, via readCmdline) — NOT tmux
 *  pane_current_command, which only returns `codex`/`node` without argv. Only a
 *  codex-family process carrying `--remote` in argv counts as RPC-owned; a native
 *  `codex resume`, a bare shell, or an unreadable tree fails-closed to false so a
 *  daemon-restart resume never force-respawns a possibly-mid-turn native pane.
 *  This is a live-argv check, not a persisted marker, so there is no stale-marker
 *  hazard. Probes are injectable for tests (defaults hit the real OS/tmux). */
export function paneRunsRemoteTui(persistentSessionName: string, probes: PaneProbes = {}): boolean {
  const panePidOf = probes.panePidOf ?? tmuxPanePid;
  const argvOf = probes.argvOf ?? readCmdline;
  const commOf = probes.commOf ?? readComm;
  const childrenOf = probes.childrenOf ?? getChildPids;
  const panePid = panePidOf(persistentSessionName);
  if (panePid === undefined || !Number.isInteger(panePid) || panePid <= 0) return false;
  let frontier = [panePid];
  const seen = new Set<number>();
  for (let depth = 0; depth <= 4 && frontier.length; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const argv = argvOf(pid);
      if (argv.length) {
        const comm = commOf(pid) ?? '';
        const isCodexFamily = /^(codex|traex)/i.test(comm) || argv.some(a => /(?:^|\/)(codex|traex)$/i.test(a));
        if (isCodexFamily && argv.includes('--remote')) return true;
      }
      next.push(...childrenOf(pid));
    }
    frontier = next;
  }
  return false;
}
