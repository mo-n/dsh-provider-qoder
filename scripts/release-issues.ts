import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

type Gh = (args: string[]) => string

export function runGh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

export function linkedIssues(body: string): string[] {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  const issues = new Set<string>()
  let inSection = false
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^###\s+Linked Issue\s*$/i.test(line)
      continue
    }
    if (!inSection) continue
    // Only explicit, local issue references; never interpret arbitrary prose or URLs.
    if (!/^\s*(?:[-*]\s+)?(?:refs?|fix(?:es|ed)?|clos(?:e|es|ed)|resolv(?:e|es|ed)):?\s+#\d+(?:\s*(?:,|and)\s*#\d+)*\s*$/i.test(line)) continue
    for (const match of line.matchAll(/#([1-9]\d*)\b/g)) issues.add(match[1])
  }
  return [...issues]
}

export function hasClosingReference(text: string): boolean {
  return /\b(?:fix(?:es|ed)?|clos(?:e|es|ed)|resolv(?:e|es|ed)):?\s+(?:#\d+|[\w.-]+\/[\w.-]+#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i.test(text)
}

export function closeReleaseIssues(repo: string, tag: string, gh: Gh = runGh): void {
  const { body = '' } = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'body']))
  // Restrict release-note PR links to this repository.
  const prefix = `https://github.com/${repo}/pull/`
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const prs = new Set([...body.matchAll(new RegExp(`${escapedPrefix}(\\d+)\\b`, 'g'))].map((m: RegExpMatchArray) => m[1]))
  const issues = new Set<string>()
  const failures: string[] = []
  for (const pr of prs) {
    try {
      const { body: prBody = '' } = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'body']))
      for (const issue of linkedIssues(prBody)) issues.add(issue)
    } catch (error) {
      failures.push(`PR #${pr}: ${error}`)
    }
  }
  for (const issue of issues) {
    try {
      const { state } = JSON.parse(gh(['issue', 'view', issue, '--repo', repo, '--json', 'state']))
      if (state === 'CLOSED') continue
      const url = `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`
      gh(['issue', 'close', issue, '--repo', repo, '--reason', 'completed', '--comment',
        `🎉 Resolved and published in [${tag}](${url}).`])
      console.log(`Closed issue #${issue} for ${tag}.`)
    } catch (error) {
      failures.push(`Issue #${issue}: ${error}`)
    }
  }
  if (failures.length) throw new Error(`Release issue processing failed:\n${failures.join('\n')}`)
  console.log(`Processed ${issues.size} linked issue(s) from ${prs.size} PR(s).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GITHUB_REPOSITORY!
  if (process.argv[2] === 'validate') {
    const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'))
    const commits = runGh(['api', '--paginate', `repos/${repo}/pulls/${pr.number}/commits`, '--jq', '.[].commit.message'])
    if ([pr.title, pr.body ?? '', commits].some(hasClosingReference)) {
      throw new Error('Remove issue-closing keywords from the PR title, body and commit messages. Use Ref #123 under ### Linked Issue; issues close on release.')
    }
  } else if (process.argv[2] === 'close') {
    closeReleaseIssues(repo, process.env.GITHUB_REF_NAME!)
  } else {
    throw new Error('Expected validate or close command')
  }
}
