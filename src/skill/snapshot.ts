/**
 * 绑定在已持有代码快照上的可选 DSH SKILL 发现与加载封装。
 *
 * @module dsh-logalyze/skill/snapshot
 */

import type { Agent, SkillDefinition, SkillRegistry, SkillSummary } from '../host.ts'

/** Options shared by discovery and loading; scope preserves the main agent's inherited host skills. */
export interface SnapshotSkillOptions {
  readonly scope?: Agent
  readonly signal?: AbortSignal
}

/** Repository and host skills remain separate from filesystem read permissions. */
export class SnapshotSkills {
  /** @param skills - DSH registry; @param cwd - held snapshot root; @param held - lease validity. */
  constructor(
    private readonly skills: SkillRegistry | undefined,
    private readonly cwd: string,
    private readonly held: () => boolean,
  ) {}

  private reader(): Required<Pick<SkillRegistry, 'list' | 'get'>> & Pick<SkillRegistry, 'snapshot'> {
    if (!this.held()) throw new Error('代码快照已释放；请重新准备应用快照后发现或加载 SKILL')
    if (this.skills?.list === undefined || this.skills.get === undefined) {
      throw new Error('宿主未提供 DSH SKILL 发现与加载服务')
    }
    return {
      list: this.skills.list.bind(this.skills),
      get: this.skills.get.bind(this.skills),
      snapshot: this.skills.snapshot?.bind(this.skills),
    }
  }

  /** List model-loadable descriptions and resource paths through DSH's filesystem and host providers. */
  async list(options: SnapshotSkillOptions = {}): Promise<readonly SkillSummary[]> {
    const reader = this.reader()
    const lookup = { ...options, cwd: this.cwd }
    const observed = reader.snapshot === undefined ? undefined : await reader.snapshot(lookup)
    if (observed?.complete === false) {
      throw new Error('DSH SKILL 发现未完成；请检查可读目录和权限后重试，不能据此判断没有 SKILL')
    }
    const result = observed?.skills ?? await reader.list(lookup)
    this.reader()
    return result.filter(skill => skill.invocation.modelInvocable)
  }

  /** Load a selected skill through the same DSH lookup, preserving its resource base and invocation policy. */
  async load(name: string, options: SnapshotSkillOptions = {}): Promise<SkillDefinition | undefined> {
    const result = await this.reader().get(name, { ...options, cwd: this.cwd })
    this.reader()
    return result?.invocation.modelInvocable === true ? result : undefined
  }
}
