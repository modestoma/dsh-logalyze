/**
 * 左侧栏「观象」主区页面：应用仓库、日志下载、分析接口、高级（含 SKILL 改进）四个
 * 分页，共用一份草稿和底部保存条。拉取仓库用的主机与令牌在「插件 → dsh-repo」
 * 页面管理，应用仓库分页提供跳转。
 * 仓库拉取中时每 2 秒刷新状态。
 *
 * @module dsh-logalyze/client/page
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AnalyzeWire, EditableKey, EditableSettings, RepoSpec, RepoStatusWire, StateWire, TokenStatusWire } from '../settings/contract.ts'
import { clearToken, fetchState, messageOf, resetSettings, saveSettings, saveToken, syncRepos } from './api.ts'

/** Sidebar label and page title. */
export const PANEL_TITLE = '观象'

const KB = 1024
const MB = 1024 * 1024
const MINUTE = 60 * 1000

type TabId = 'repos' | 'download' | 'analyze' | 'advanced'

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'repos', label: '应用仓库' },
  { id: 'download', label: '日志下载' },
  { id: 'analyze', label: '分析接口' },
  { id: 'advanced', label: '高级' },
]

/** Editable text form of the settings. */
interface Draft {
  repos: RepoSpec[]
  fetchIntervalMin: string
  maxAppsPerRequest: string
  dispatchTimeoutMin: string
  allowedHosts: string[]
  maxMb: string
  timeoutSec: string
  skillUpdatesEnabled: boolean
  skillMaxFiles: string
  skillMaxKb: string
  analyzeEnabled: boolean
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function toDraft(settings: EditableSettings): Draft {
  return {
    repos: settings.repos.map(repo => ({ ...repo })),
    fetchIntervalMin: trimNumber(settings.fetchIntervalMs / MINUTE),
    maxAppsPerRequest: String(settings.maxAppsPerRequest),
    dispatchTimeoutMin: trimNumber(settings.dispatchTimeoutMs / MINUTE),
    allowedHosts: [...settings.download.allowedHosts],
    maxMb: trimNumber(settings.download.maxBytes / MB),
    timeoutSec: trimNumber(settings.download.timeoutMs / 1000),
    skillUpdatesEnabled: settings.skillUpdates.enabled,
    skillMaxFiles: String(settings.skillUpdates.maxFiles),
    skillMaxKb: trimNumber(settings.skillUpdates.maxFileBytes / KB),
    analyzeEnabled: settings.analyze.enabled,
  }
}

function positive(text: string, label: string, allowZero = false): number {
  const value = Number(text.trim())
  if (text.trim() === '' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw new Error(`${label}必须是${allowZero ? '非负' : '正'}数`)
  return value
}

function fromDraft(draft: Draft): EditableSettings {
  const maxApps = positive(draft.maxAppsPerRequest, '单次应用数上限')
  if (!Number.isInteger(maxApps)) throw new Error('单次应用数上限必须是整数')
  const maxFiles = positive(draft.skillMaxFiles, '改进文件数上限')
  if (!Number.isInteger(maxFiles)) throw new Error('改进文件数上限必须是整数')
  return {
    repos: draft.repos.map(repo => repo.branch === undefined || repo.branch.trim() === '' ? { url: repo.url.trim() } : { url: repo.url.trim(), branch: repo.branch.trim() }),
    fetchIntervalMs: Math.round(positive(draft.fetchIntervalMin, '更新间隔', true) * MINUTE),
    maxAppsPerRequest: maxApps,
    dispatchTimeoutMs: Math.round(positive(draft.dispatchTimeoutMin, '派发超时') * MINUTE),
    download: {
      allowedHosts: draft.allowedHosts.map(host => host.trim()).filter(host => host !== ''),
      maxBytes: Math.round(positive(draft.maxMb, '单文件大小上限') * MB),
      timeoutMs: Math.round(positive(draft.timeoutSec, '下载超时') * 1000),
    },
    skillUpdates: {
      enabled: draft.skillUpdatesEnabled,
      maxFiles,
      maxFileBytes: Math.round(positive(draft.skillMaxKb, '改进单文件大小上限') * KB),
    },
    analyze: { enabled: draft.analyzeEnabled },
  }
}

function sameSettings(draft: Draft, settings: EditableSettings): boolean {
  try {
    return JSON.stringify(fromDraft(draft)) === JSON.stringify(settings)
  } catch {
    // An unparsable draft differs from any saved settings.
    return false
  }
}

function formatTime(iso: string | number | undefined): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

function phasePill(repo: RepoStatusWire | undefined): JSX.Element {
  if (repo === undefined) return <span className="lz__pill"><span className="lz__dot" />保存后拉取</span>
  if (repo.phase === 'syncing') return <span className="lz__pill lz__pill--warn"><span className="lz__dot" />拉取中</span>
  if (repo.available) return <span className="lz__pill lz__pill--ok"><span className="lz__dot" />就绪</span>
  if (repo.phase === 'ready' || repo.phase === 'failed') return <span className="lz__pill lz__pill--bad"><span className="lz__dot" />不可用</span>
  return <span className="lz__pill"><span className="lz__dot" />待拉取</span>
}

function Overridden({ keys, name }: { keys: readonly EditableKey[]; name: EditableKey }): JSX.Element | null {
  return keys.includes(name) ? <span className="lz__tag lz__tag--accent">面板设置</span> : null
}

/** Page props supplied by the client entry. */
export interface LogalyzePageProps {
  /** Opens dsh-repo's page on the Plugins panel; absent hides the link. */
  readonly openRepoSettings?: (() => void) | undefined
}

/**
 * Main-column page for the `main` slot.
 * @param props - navigation supplied by the client entry.
 * @returns the page.
 */
export function LogalyzePage({ openRepoSettings }: LogalyzePageProps): JSX.Element {
  return (
    <section className="lz-page" aria-label={PANEL_TITLE}>
      <div className="lz-page__content">
        <LogalyzePanel openRepoSettings={openRepoSettings} />
      </div>
    </section>
  )
}

/**
 * The `main` slot component, bound to a way of opening dsh-repo's settings.
 * @param openRepoSettings - opens dsh-repo's page on the Plugins panel, or undefined while that panel is unavailable.
 * @returns component rendering {@link LogalyzePage}.
 */
export function boundLogalyzePage(openRepoSettings: () => (() => void) | undefined): () => JSX.Element {
  return () => <LogalyzePage openRepoSettings={openRepoSettings()} />
}

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

/**
 * Panel body: loads state, edits a draft, saves.
 * @param props - navigation supplied by the client entry.
 * @returns the panel.
 */
export function LogalyzePanel({ openRepoSettings }: LogalyzePageProps): JSX.Element {
  const [state, setState] = useState<StateWire | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [draft, setDraft] = useState<Draft | undefined>()
  const [tab, setTab] = useState<TabId>('repos')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()

  const adopt = useCallback((next: StateWire, resetDraft: boolean) => {
    setState(next)
    if (resetDraft) setDraft(toDraft(next.settings))
  }, [])

  const reload = useCallback(async (resetDraft: boolean) => {
    try {
      adopt(await fetchState(), resetDraft)
      setLoadError(undefined)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [adopt])

  useEffect(() => { void reload(true) }, [reload])

  const syncing = state?.repos.some(repo => repo.phase === 'syncing') === true
  useEffect(() => {
    if (!syncing) return
    const timer = setInterval(() => { void reload(false) }, 2000)
    return () => { clearInterval(timer) }
  }, [syncing, reload])

  const dirty = state !== undefined && draft !== undefined && !sameSettings(draft, state.settings)

  const run = async (action: () => Promise<StateWire>, success: string, resetDraft: boolean): Promise<StateWire | undefined> => {
    setBusy(true)
    setNotice(undefined)
    try {
      const next = await action()
      adopt(next, resetDraft)
      setNotice({ kind: 'ok', text: success })
      return next
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    if (draft === undefined) return
    let settings: EditableSettings
    try {
      settings = fromDraft(draft)
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
      return
    }
    void run(() => saveSettings(settings), '已保存，新的仓库会在后台拉取', true)
  }

  if (state === undefined || draft === undefined) {
    return (
      <div className="lz">
        {loadError === undefined
          ? <div className="lz__loading">加载中…</div>
          : <div className="lz__notice lz__notice--error">{loadError} <button type="button" className="lz__btn lz__btn--ghost" onClick={() => { void reload(true) }}>重试</button></div>}
      </div>
    )
  }

  const available = state.repos.filter(repo => repo.available).length
  return (
    <div className="lz">
      <header className="lz__head">
        <div className="lz__headRow">
          <h1 className="lz__title">{PANEL_TITLE}</h1>
          <span className={`lz__pill ${available > 0 ? 'lz__pill--ok' : 'lz__pill--warn'}`}><span className="lz__dot" />{available} 个应用可用</span>
          {syncing ? <span className="lz__pill lz__pill--warn"><span className="lz__dot" />拉取中</span> : null}
        </div>
        <div className="lz__meta">观其象，知其因。在对话中输入 /logalyze 描述问题并附上日志，观象会按应用派发分析。</div>
        <div className="lz__tabs" role="tablist">
          {TABS.map(item => (
            <button key={item.id} type="button" role="tab" className="lz__tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id) }}>{item.label}</button>
          ))}
        </div>
      </header>
      {state.overlayError === undefined ? null : <div className="lz__notice lz__notice--error">面板设置文件未生效：{state.overlayError}。保存一次会用当前内容覆盖它。</div>}
      <div className="lz__body" role="tabpanel">
        {tab === 'repos' ? <ReposTab draft={draft} setDraft={setDraft} state={state} busy={busy || dirty} openRepoSettings={openRepoSettings} onSync={(url) => { void run(() => syncRepos(url), url === undefined ? '已开始重新拉取全部仓库' : '已开始重新拉取', false) }} /> : null}
        {tab === 'download' ? <DownloadTab draft={draft} setDraft={setDraft} overridden={state.overridden} /> : null}
        {tab === 'analyze'
          ? <AnalyzeTab
              draft={draft}
              setDraft={setDraft}
              analyze={state.analyze}
              credentialsAvailable={state.credentialsAvailable}
              overridden={state.overridden}
              busy={busy}
              onSave={async value => await run(() => saveToken(state.analyze.tokenEnv, value), '已保存分析接口令牌，下一个请求起生效', false) !== undefined}
              onClear={() => { void run(() => clearToken(state.analyze.tokenEnv), '已清除面板保存的分析接口令牌', false) }}
            />
          : null}
        {tab === 'advanced' ? <AdvancedTab draft={draft} setDraft={setDraft} overridden={state.overridden} busy={busy} onReset={() => { void run(resetSettings, '已恢复为 cordis.yml 中的配置', true) }} /> : null}
      </div>
      {notice === undefined ? null : <div className={`lz__notice lz__notice--${notice.kind}`}>{notice.text}</div>}
      <div className="lz__saveBar">
        <span className="lz__saveMsg">{dirty ? '有未保存的修改' : '设置已保存'}</span>
        <button type="button" className="lz__btn lz__btn--ghost" disabled={!dirty || busy} onClick={() => { setDraft(toDraft(state.settings)); setNotice(undefined) }}>放弃修改</button>
        <button type="button" className="lz__btn lz__btn--primary" disabled={!dirty || busy} onClick={save}>保存</button>
      </div>
    </div>
  )
}

interface TabProps {
  draft: Draft
  setDraft: (next: Draft) => void
}

function ReposTab({ draft, setDraft, state, busy, openRepoSettings, onSync }: TabProps & LogalyzePageProps & { state: StateWire; busy: boolean; onSync: (url?: string) => void }): JSX.Element {
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const status = useMemo(() => new Map(state.repos.map(repo => [repo.url, repo])), [state.repos])
  const add = (): void => {
    const trimmed = url.trim()
    if (trimmed === '' || draft.repos.some(repo => repo.url === trimmed)) return
    setDraft({ ...draft, repos: [...draft.repos, branch.trim() === '' ? { url: trimmed } : { url: trimmed, branch: branch.trim() }] })
    setUrl('')
    setBranch('')
  }
  return (
    <section className="lz__sec">
      <h2 className="lz__secTitle">应用仓库 <Overridden keys={state.overridden} name="repos" /></h2>
      <div className="lz__list">
        {draft.repos.length === 0 ? <div className="lz__emptyRow">还没有应用仓库。添加 git 地址后保存，观象会把仓库拉取到本机。</div> : null}
        {draft.repos.map((repo, index) => {
          const current = status.get(repo.url)
          const saved = current !== undefined && current.branch === repo.branch
          return (
            <div key={repo.url} className="lz__row lz__row--top">
              <div className="lz__rowText">
                <div className="lz__rowLabel">
                  <span className="lz__mono">{repo.url}</span>
                  {repo.branch === undefined ? null : <span className="lz__tag">{repo.branch}</span>}
                  {phasePill(saved ? current : undefined)}
                </div>
                {saved && current.app !== undefined
                  ? <div className="lz__rowSummary">{current.app.name}（<span className="lz__mono">{current.app.id}</span>）· SKILL <span className="lz__mono">/{current.app.skill}</span>{current.activeRuns > 0 ? ` · ${current.activeRuns} 个分析进行中` : ''}</div>
                  : null}
                {saved && current.app !== undefined ? <div className="lz__rowSummary">{current.app.description}</div> : null}
                {saved && current.commit !== undefined
                  ? <div className="lz__rowSummary">提交 <span className="lz__mono">{current.commit.slice(0, 8)}</span>（{formatTime(current.commitTime)}）· 拉取于 {formatTime(current.syncedAt)}{current.dir === undefined ? null : <> · <span className="lz__mono">{current.dir}</span></>}</div>
                  : null}
                {saved && current.error !== undefined ? <div className="lz__rowError">{current.error}</div> : null}
              </div>
              <div className="lz__rowCtl">
                {saved ? <button type="button" className="lz__btn" disabled={busy || current.phase === 'syncing'} onClick={() => { onSync(repo.url) }}>重新拉取</button> : null}
                <button type="button" className="lz__btn lz__btn--danger" onClick={() => { setDraft({ ...draft, repos: draft.repos.filter((_, position) => position !== index) }) }}>删除</button>
              </div>
            </div>
          )
        })}
        <div className="lz__addRow">
          <input className="lz__input" placeholder="git 地址，例如 git@github.com:example/order-service.git" value={url} onChange={(event) => { setUrl(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') add() }} />
          <input className="lz__input lz__input--branch" placeholder="分支（可选）" value={branch} onChange={(event) => { setBranch(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') add() }} />
          <button type="button" className="lz__btn" disabled={url.trim() === ''} onClick={add}>添加</button>
        </div>
      </div>
      {state.dshRepo.availability === 'ready' ? null : <div className="lz__notice lz__notice--error">{state.dshRepo.availability === 'missing' ? '没有加载 dsh-repo 插件，仓库无法拉取。请安装 dsh-repo。' : 'dsh-repo 版本与观象不兼容，仓库无法拉取。'}</div>}
      <p className="lz__secFoot">由 dsh-repo 拉取到它的镜像目录{state.dshRepo.mirrorDir === undefined ? '' : `（${state.dshRepo.mirrorDir}）`}。https 地址使用 dsh-repo 中对应主机的令牌，主机或令牌变更后会自动重新拉取，ssh 地址和其他主机使用本机已有的 git 凭据（SSH key 或 credential helper）。不留分支时跟随远端默认分支。每个仓库需包含 <span className="lz__mono">.agents/logalyze.yaml</span> 与其中声明的日志分析 SKILL。删除地址不会删除本地镜像。</p>
      <div className="lz__headRow">
        {state.repos.length > 0 ? <button type="button" className="lz__btn" disabled={busy} onClick={() => { onSync() }}>重新拉取全部</button> : null}
        {openRepoSettings === undefined || state.dshRepo.availability === 'missing' ? null : <button type="button" className="lz__btn lz__btn--ghost" onClick={openRepoSettings}>管理主机与令牌</button>}
      </div>
    </section>
  )
}

/** Credential store layers of `@deepseek-ai/dsh-credentials-local` other than its own file. */
const TOKEN_SOURCES: Readonly<Record<string, string>> = { 'env': '启动环境变量', 'project-env': '项目 .env', 'user-env': '$DSH_HOME/.env' }

function tokenPill(token: TokenStatusWire | undefined): JSX.Element {
  if (token === undefined) return <span className="lz__pill"><span className="lz__dot" />保存后设置令牌</span>
  if (token.error !== undefined) return <span className="lz__pill lz__pill--bad"><span className="lz__dot" />无法读取</span>
  if (!token.configured) return <span className="lz__pill lz__pill--warn"><span className="lz__dot" />未设置令牌</span>
  const source = token.source === undefined || token.source === 'file' ? undefined : TOKEN_SOURCES[token.source] ?? token.source
  return <span className="lz__pill lz__pill--ok"><span className="lz__dot" />已设置{source === undefined ? '' : `（来自${source}）`}</span>
}

function DownloadTab({ draft, setDraft, overridden }: TabProps & { overridden: readonly EditableKey[] }): JSX.Element {
  const [host, setHost] = useState('')
  const add = (): void => {
    const trimmed = host.trim().toLowerCase()
    if (trimmed === '' || draft.allowedHosts.includes(trimmed)) return
    setDraft({ ...draft, allowedHosts: [...draft.allowedHosts, trimmed] })
    setHost('')
  }
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">允许下载的域名 <Overridden keys={overridden} name="download" /></h2>
        <div className="lz__list">
          {draft.allowedHosts.length === 0 ? <div className="lz__emptyRow">未配置域名，消息中的日志下载链接不会被下载。</div> : null}
          {draft.allowedHosts.map(item => (
            <div key={item} className="lz__row">
              <div className="lz__rowText"><span className="lz__mono">{item}</span></div>
              <div className="lz__rowCtl"><button type="button" className="lz__btn lz__btn--danger" onClick={() => { setDraft({ ...draft, allowedHosts: draft.allowedHosts.filter(entry => entry !== item) }) }}>删除</button></div>
            </div>
          ))}
          <div className="lz__addRow">
            <input className="lz__input" placeholder="主机名，例如 oss.example.com" value={host} onChange={(event) => { setHost(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') add() }} />
            <button type="button" className="lz__btn" disabled={host.trim() === ''} onClick={add}>添加</button>
          </div>
        </div>
        <p className="lz__secFoot">只填主机名，同时允许它的子域名。下载不携带任何鉴权信息，每次重定向都会重新校验域名。</p>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">限制</h2>
        <div className="lz__list">
          <NumberRow label="单文件大小上限" unit="MB" value={draft.maxMb} onChange={(value) => { setDraft({ ...draft, maxMb: value }) }} />
          <NumberRow label="单文件下载超时" unit="秒" value={draft.timeoutSec} onChange={(value) => { setDraft({ ...draft, timeoutSec: value }) }} />
        </div>
      </section>
    </>
  )
}

const TOPICS_STATUS: Readonly<Record<AnalyzeWire['topics'], { pill: string; text: string }>> = {
  ready: { pill: 'lz__pill--ok', text: '飞书渠道就绪' },
  missing: { pill: 'lz__pill--bad', text: '未找到飞书渠道' },
  incompatible: { pill: 'lz__pill--bad', text: '飞书渠道版本不兼容' },
}

function AnalyzeTab({ draft, setDraft, analyze, credentialsAvailable, overridden, busy, onSave, onClear }: TabProps & {
  analyze: AnalyzeWire
  credentialsAvailable: boolean
  overridden: readonly EditableKey[]
  busy: boolean
  onSave: (value: string) => Promise<boolean>
  onClear: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const token = analyze.token
  const save = (): void => {
    const trimmed = value.trim()
    if (trimmed === '' || busy) return
    void onSave(trimmed).then((ok) => { if (ok) setValue('') })
  }
  const topics = TOPICS_STATUS[analyze.topics]
  const endpoint = new URL(analyze.route.slice(1), document.baseURI).href
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">日志平台分析接口</h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">开启接口 <Overridden keys={overridden} name="analyze" /><span className={`lz__pill ${topics.pill}`}><span className="lz__dot" />{topics.text}</span></div>
              <div className="lz__rowSummary">日志平台调用接口后，观象经飞书渠道（dsh-channels）在目标群发出分析卡片，并在卡片下的话题里开始分析；群内成员都可以在话题里继续追问。关闭时接口回复 404。</div>
              {analyze.topics === 'ready' ? null : <div className="lz__rowError">{analyze.topics === 'missing' ? '接口需要加载 dsh-channels。' : '请把观象与 dsh-channels 升级到相互兼容的版本。'}</div>}
            </div>
            <div className="lz__rowCtl"><input type="checkbox" className="lz__check" aria-label="开启分析接口" checked={draft.analyzeEnabled} onChange={(event) => { setDraft({ ...draft, analyzeEnabled: event.target.checked }) }} /></div>
          </div>
          <div className="lz__row lz__row--top">
            <div className="lz__rowText">
              <div className="lz__rowLabel">访问令牌 <span className="lz__tag lz__mono">{analyze.tokenEnv}</span>{credentialsAvailable ? tokenPill(token) : null}</div>
              <div className="lz__rowSummary">日志平台以 <span className="lz__mono">Authorization: Bearer &lt;令牌&gt;</span> 调用接口。令牌未设置时接口回复 503。</div>
              {credentialsAvailable ? null : <div className="lz__rowError">当前 DSH 组合没有加载凭据服务（@deepseek-ai/dsh-credentials-local），无法保存或读取令牌。</div>}
              {token?.error === undefined ? null : <div className="lz__rowError">{token.error}</div>}
              {token !== undefined && token.writable
                ? (
                    <div className="lz__addRow lz__addRow--flush">
                      <input className="lz__input lz__mono" type="password" autoComplete="new-password" spellCheck={false} placeholder={token.configured ? '输入新令牌以替换' : '粘贴令牌'} value={value} onChange={(event) => { setValue(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') save() }} />
                      <button type="button" className="lz__btn" disabled={busy || value.trim() === ''} onClick={save}>保存令牌</button>
                      {token.configured && token.source === 'file' ? <button type="button" className="lz__btn lz__btn--ghost" disabled={busy} onClick={onClear}>清除</button> : null}
                    </div>
                  )
                : null}
            </div>
          </div>
        </div>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">调用方式</h2>
        <div className="lz__list">
          <div className="lz__row"><div className="lz__rowText"><div className="lz__rowLabel">地址</div><div className="lz__rowSummary lz__mono">POST {endpoint}</div></div></div>
          <div className="lz__row"><div className="lz__rowText"><div className="lz__rowLabel">请求头</div><div className="lz__rowSummary lz__mono">Authorization: Bearer &lt;令牌&gt; · Idempotency-Key: &lt;1-200 个可见 ASCII 字符&gt; · Content-Type: application/json</div></div></div>
          <div className="lz__row"><div className="lz__rowText"><div className="lz__rowLabel">请求体</div><div className="lz__rowSummary lz__mono">requesterUserId, triggeredAt, app, errorCode, logDetails[{'{'}name, url{'}'}], chatId, prompt</div></div></div>
          <div className="lz__row"><div className="lz__rowText"><div className="lz__rowLabel">响应</div><div className="lz__rowSummary">202 已发出分析卡片（同一 Idempotency-Key 重试返回同一张卡片）；400/401/404/405/409/413/415 请求问题；403 目标群未授权；502 卡片发送失败；503 飞书未连接或令牌未设置。字段说明见观象 README。</div></div></div>
        </div>
      </section>
    </>
  )
}

function AdvancedTab({ draft, setDraft, overridden, busy, onReset }: TabProps & { overridden: readonly EditableKey[]; busy: boolean; onReset: () => void }): JSX.Element {
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">仓库</h2>
        <div className="lz__list">
          <NumberRow label="更新间隔" summary="输入 /logalyze 时，距上次拉取超过该时间的仓库会先更新；0 表示每次都更新。" unit="分钟" value={draft.fetchIntervalMin} overridden={overridden.includes('fetchIntervalMs')} onChange={(value) => { setDraft({ ...draft, fetchIntervalMin: value }) }} />
        </div>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">派发</h2>
        <div className="lz__list">
          <NumberRow label="单次应用数上限" summary="一次派发最多同时分析的应用数，不应超过 DSH 的活动子 Agent 上限（默认 8）。" unit="个" value={draft.maxAppsPerRequest} overridden={overridden.includes('maxAppsPerRequest')} onChange={(value) => { setDraft({ ...draft, maxAppsPerRequest: value }) }} />
          <NumberRow label="派发超时" summary="等待全部子 Agent 的最长时间，超时后停止仍在运行的子 Agent。" unit="分钟" value={draft.dispatchTimeoutMin} overridden={overridden.includes('dispatchTimeoutMs')} onChange={(value) => { setDraft({ ...draft, dispatchTimeoutMin: value }) }} />
        </div>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">SKILL 改进</h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">询问是否改进 SKILL <Overridden keys={overridden} name="skillUpdates" /></div>
              <div className="lz__rowSummary">子 Agent 觉得应用的日志分析 SKILL 不够用时记下不足，分析结束后询问用户是否改进；用户同意后，改进子 Agent 把问题整理为案例并修改 SKILL，观象经 dsh-repo 提交到新分支并创建合并请求（GitLab 或 GitHub，需要安装 dsh-repo 并配置该仓库主机的令牌）。</div>
            </div>
            <div className="lz__rowCtl"><input type="checkbox" className="lz__check" aria-label="询问是否改进 SKILL" checked={draft.skillUpdatesEnabled} onChange={(event) => { setDraft({ ...draft, skillUpdatesEnabled: event.target.checked }) }} /></div>
          </div>
          <NumberRow label="改进文件数上限" unit="个" value={draft.skillMaxFiles} onChange={(value) => { setDraft({ ...draft, skillMaxFiles: value }) }} />
          <NumberRow label="改进单文件大小上限" unit="KB" value={draft.skillMaxKb} onChange={(value) => { setDraft({ ...draft, skillMaxKb: value }) }} />
        </div>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">面板设置</h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">恢复 cordis.yml 配置</div>
              <div className="lz__rowSummary">删除面板保存的全部设置（$DSH_HOME/logalyze/settings.json 中的覆盖值）。</div>
            </div>
            <div className="lz__rowCtl"><button type="button" className="lz__btn lz__btn--danger" disabled={busy || overridden.length === 0} onClick={onReset}>恢复</button></div>
          </div>
        </div>
      </section>
    </>
  )
}

function NumberRow({ label, summary, unit, value, overridden = false, onChange }: { label: string; summary?: string; unit: string; value: string; overridden?: boolean; onChange: (value: string) => void }): JSX.Element {
  return (
    <div className="lz__row">
      <div className="lz__rowText">
        <div className="lz__rowLabel">{label}{overridden ? <span className="lz__tag lz__tag--accent">面板设置</span> : null}</div>
        {summary === undefined ? null : <div className="lz__rowSummary">{summary}</div>}
      </div>
      <div className="lz__rowCtl">
        <input className="lz__input lz__input--num" inputMode="decimal" value={value} onChange={(event) => { onChange(event.target.value) }} />
        <span className="lz__unit">{unit}</span>
      </div>
    </div>
  )
}
