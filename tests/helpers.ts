import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The bundled example application repository. */
export const EXAMPLE_APP = fileURLToPath(new URL('../examples/order-service', import.meta.url))

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

/** Run git synchronously in a directory. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' })
}

/** A temporary directory removed by the returned cleanup. */
export async function tempDir(prefix = 'logalyze-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * Create a git repository at `dir` from the example app, optionally replacing
 * files, and commit it on branch `main`.
 */
export async function createAppRepo(dir: string, files: Record<string, string> = {}): Promise<string> {
  await cp(EXAMPLE_APP, dir, { recursive: true })
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

/** Commit a change to an existing repository. */
export async function commitFile(dir: string, path: string, content: string): Promise<string> {
  await writeFile(join(dir, path), content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', `update ${path}`)
  return git(dir, 'rev-parse', 'HEAD').trim()
}

/** Wait until a predicate holds, polling every 10 ms. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!await predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
