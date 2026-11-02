/**
 * 运行回传命令：把参数模板里的占位符换成本次的值，不经过 shell 直接启动
 * 可执行文件，超时即结束进程。
 *
 * @module dsh-logalyze/report/command
 */

import { execFile } from 'node:child_process'
import { REPORT_ENTRY } from '../settings/contract.ts'

/** Values substituted into the upload command. */
export interface UploadValues {
  readonly logId: string
  /** Absolute report directory. */
  readonly dir: string
}

/**
 * The argument vector of one upload.
 * @param template - configured command with `{logId}`, `{dir}`, `{entry}` placeholders.
 * @param values - this upload's values.
 * @returns executable and arguments.
 */
export function uploadArgv(template: readonly string[], values: UploadValues): string[] {
  const replacements: Readonly<Record<string, string>> = { '{logId}': values.logId, '{dir}': values.dir, '{entry}': REPORT_ENTRY }
  return template.map(arg => arg.replace(/\{[^{}]*\}/g, token => replacements[token] ?? token))
}

/** Outcome of one command run. */
export type CommandOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** Runs one command; tests replace it. */
export type CommandRunner = (argv: readonly string[], options: { readonly timeoutMs: number; readonly cwd: string }) => Promise<CommandOutcome>

/** Characters of the command's output kept in a failure message. */
const OUTPUT_TAIL = 600

function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= OUTPUT_TAIL ? trimmed : `…${trimmed.slice(-OUTPUT_TAIL)}`
}

/**
 * Run a command without a shell.
 * @param argv - executable and arguments.
 * @param options - timeout and working directory.
 * @returns success, or the exit reason with the tail of the output.
 */
export const runCommand: CommandRunner = async (argv, options) => {
  const [file, ...args] = argv
  if (file === undefined) return { ok: false, error: '回传命令为空' }
  return await new Promise<CommandOutcome>((resolve) => {
    execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true })
        return
      }
      const output = tail(`${String(stderr)}\n${String(stdout)}`)
      const code = (error as NodeJS.ErrnoException).code
      const reason = code === 'ENOENT'
        ? `找不到回传命令 ${file}`
        : error.killed === true ? `回传命令超过 ${options.timeoutMs} ms 未结束，已终止` : `回传命令失败（${error.code === undefined ? error.message : `退出码 ${String(error.code)}`}）`
      resolve({ ok: false, error: output === '' ? reason : `${reason}：${output}` })
    })
  })
}
