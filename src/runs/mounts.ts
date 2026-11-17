/**
 * 会话代码快照挂载：主会话直接读取应用代码时，按会话持有 dsh-repo 的只读
 * 快照（按提交共享、引用计数），多个会话读同一提交时共用同一份文件。
 *
 * - 同一会话再次挂载同一应用时，应用最新同步提交未变就沿用已持有的快照；
 *   提交变了就先取得新快照，再释放旧快照。
 * - 会话最后一次挂载后 `holdMs` 内没有再挂载，释放该会话持有的全部快照；
 *   之后读取需要重新挂载。插件停止时释放全部快照。
 *
 * @module dsh-supervisor/runs/mounts
 */

import type { LeasedApp, RepoLease, RepoRegistry } from '../apps/registry.ts'

/** One application a session holds, with the snapshot directory it reads. */
export type MountedApp = Omit<LeasedApp, 'skills'>

interface Mount {
  readonly app: MountedApp
  readonly lease: RepoLease
}

interface SessionEntry {
  readonly mounts: Map<string, Mount>
  timer?: ReturnType<typeof setTimeout>
}

/** Collaborators of {@link SessionMounts}. */
export interface SessionMountsDeps {
  readonly registry: Pick<RepoRegistry, 'acquire' | 'readyApp'>
  /** Idle time after a session's last mount before its snapshots are released, read on every mount. */
  holdMs(): number
}

/** Snapshot leases held per session for code the session reads itself. */
export class SessionMounts {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly pending = new Map<string, Promise<unknown>>()
  private closed = false

  /** @param deps - registry and hold time. */
  constructor(private readonly deps: SessionMountsDeps) {}

  /**
   * Hold a snapshot of each application's latest synced commit for a session.
   * Mounts of one session run one at a time.
   * @param sessionId - holding session.
   * @param ids - application ids.
   * @returns the mounted applications, in request order.
   * @throws when an id is not a usable application or a snapshot cannot be created; nothing new is held then.
   */
  mount(sessionId: string, ids: readonly string[]): Promise<MountedApp[]> {
    if (this.closed) return Promise.reject(new Error('智能监管已停止，不能挂载应用代码'))
    const previous = this.pending.get(sessionId) ?? Promise.resolve()
    const run = previous.then(() => this.mountNow(sessionId, ids), () => this.mountNow(sessionId, ids))
    const settled = run.then(() => undefined, () => undefined)
    this.pending.set(sessionId, settled)
    void settled.then(() => {
      if (this.pending.get(sessionId) === settled) this.pending.delete(sessionId)
    })
    return run
  }

  /**
   * The applications a session holds now.
   * @param sessionId - holding session.
   * @returns the mounted applications.
   */
  held(sessionId: string): MountedApp[] {
    return [...this.sessions.get(sessionId)?.mounts.values() ?? []].map(mount => mount.app)
  }

  /**
   * Release every snapshot a session holds.
   * @param sessionId - holding session.
   */
  release(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    this.sessions.delete(sessionId)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    for (const mount of entry.mounts.values()) mount.lease.release()
  }

  /** Stop new mounts, wait for running ones, and release every snapshot. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.pending.values()])
    for (const sessionId of [...this.sessions.keys()]) this.release(sessionId)
  }

  private async mountNow(sessionId: string, ids: readonly string[]): Promise<MountedApp[]> {
    const unique = [...new Set(ids)]
    const entry = this.sessions.get(sessionId) ?? { mounts: new Map<string, Mount>() }
    const stale = unique.filter((id) => {
      const current = entry.mounts.get(id)
      return current === undefined || current.app.commit !== this.deps.registry.readyApp(id).commit
    })
    const outcomes = await Promise.allSettled(stale.map(id => this.deps.registry.acquire([id])))
    const acquired = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : [])
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    if (failure !== undefined || this.closed) {
      for (const lease of acquired) lease.release()
      if (failure !== undefined) throw failure.reason
      throw new Error('智能监管已停止，未挂载应用代码')
    }
    for (const [index, id] of stale.entries()) {
      const lease = acquired[index] as RepoLease
      const { skills: _skills, ...app } = lease.apps.get(id) as LeasedApp
      entry.mounts.get(id)?.lease.release()
      entry.mounts.set(id, { app, lease })
    }
    this.sessions.set(sessionId, entry)
    this.schedule(sessionId, entry)
    return unique.map(id => (entry.mounts.get(id) as Mount).app)
  }

  private schedule(sessionId: string, entry: SessionEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      if (this.sessions.get(sessionId) === entry) this.release(sessionId)
    }, Math.max(0, this.deps.holdMs()))
    entry.timer.unref?.()
  }
}
