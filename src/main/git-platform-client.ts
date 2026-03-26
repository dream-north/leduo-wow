import type { GitPlatformInfo } from '../shared/types'

export interface GitFileResult {
  content: string
  sha?: string
}

export interface GitWriteResult {
  success: boolean
  commitUrl?: string
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

async function githubReadFile(info: GitPlatformInfo, token: string): Promise<GitFileResult> {
  const url = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${info.filePath}?ref=${info.branch}`
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json'
    }
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`GitHub GET 失败: ${resp.status} ${resp.statusText} ${text}`)
  }
  const data = (await resp.json()) as { content?: string; sha?: string; encoding?: string }
  if (!data.content) {
    throw new Error('GitHub 返回的文件内容为空')
  }
  const decoded = Buffer.from(data.content, 'base64').toString('utf-8')
  return { content: decoded, sha: data.sha }
}

async function githubWriteFile(
  info: GitPlatformInfo,
  token: string,
  content: string,
  sha?: string
): Promise<GitWriteResult> {
  const url = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${info.filePath}`
  const body: Record<string, string> = {
    message: '更新共享词汇 (via 乐多汪汪)',
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: info.branch
  }
  if (sha) body.sha = sha

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`GitHub PUT 失败: ${resp.status} ${resp.statusText} ${text}`)
  }
  const data = (await resp.json()) as { commit?: { html_url?: string } }
  return { success: true, commitUrl: data.commit?.html_url }
}

// ---------------------------------------------------------------------------
// Aone Code (GitLab style)
// ---------------------------------------------------------------------------

function aoneApiBase(): string {
  return 'https://code.alibaba-inc.com'
}

function aoneProjectId(info: GitPlatformInfo): string {
  return encodeURIComponent(`${info.owner}/${info.repo}`)
}

function aoneHeaders(token: string): Record<string, string> {
  return { 'PRIVATE-TOKEN': token }
}

async function aoneReadFile(info: GitPlatformInfo, token: string): Promise<GitFileResult> {
  // Use the raw URL with PRIVATE-TOKEN header
  const rawUrl = `${aoneApiBase()}/${info.owner}/${info.repo}/raw/${info.branch}/${info.filePath}`
  const resp = await fetch(rawUrl, { headers: aoneHeaders(token) })
  if (!resp.ok) {
    // Fallback: try query param approach
    const fallbackUrl = `${rawUrl}?private_token=${token}`
    const resp2 = await fetch(fallbackUrl)
    if (!resp2.ok) {
      const text = await resp2.text().catch(() => '')
      throw new Error(`Aone Code GET 失败: ${resp2.status} ${resp2.statusText} ${text}`)
    }
    return { content: await resp2.text() }
  }
  return { content: await resp.text() }
}

async function aoneWriteFile(
  info: GitPlatformInfo,
  token: string,
  content: string
): Promise<GitWriteResult> {
  const encodedFilePath = encodeURIComponent(info.filePath)
  const base64Content = Buffer.from(content, 'utf-8').toString('base64')

  // Try V3 API with header auth first
  const v3Url = `${aoneApiBase()}/api/v3/projects/${aoneProjectId(info)}/repository/files`
  const v3Body = {
    file_path: info.filePath,
    branch_name: info.branch,
    commit_message: '更新共享词汇 (via 乐多汪汪)',
    content: base64Content,
    encoding: 'base64'
  }
  const v3Resp = await fetch(v3Url, {
    method: 'PUT',
    headers: { ...aoneHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(v3Body)
  })
  if (v3Resp.ok) return { success: true }

  // If V3 failed, try V4 API (file_path in URL path)
  const v4Url = `${aoneApiBase()}/api/v4/projects/${aoneProjectId(info)}/repository/files/${encodedFilePath}`
  const v4Body = {
    branch: info.branch,
    commit_message: '更新共享词汇 (via 乐多汪汪)',
    content: base64Content,
    encoding: 'base64'
  }
  const v4Resp = await fetch(v4Url, {
    method: 'PUT',
    headers: { ...aoneHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(v4Body)
  })
  if (v4Resp.ok) return { success: true }

  // Both failed, report details from V3 attempt
  const v3Text = await v3Resp.text().catch(() => '')
  const v4Text = await v4Resp.text().catch(() => '')
  throw new Error(
    `Aone Code PUT 失败: V3=${v3Resp.status} ${v3Text.slice(0, 200)}, V4=${v4Resp.status} ${v4Text.slice(0, 200)}`
  )
}

// ---------------------------------------------------------------------------
// Unified entry points
// ---------------------------------------------------------------------------

export async function readGitFile(
  info: GitPlatformInfo,
  token: string
): Promise<GitFileResult> {
  if (info.platform === 'github') return githubReadFile(info, token)
  if (info.platform === 'aone-code') return aoneReadFile(info, token)
  throw new Error(`不支持的平台: ${info.platform}`)
}

export async function writeGitFile(
  info: GitPlatformInfo,
  token: string,
  content: string,
  sha?: string
): Promise<GitWriteResult> {
  if (info.platform === 'github') return githubWriteFile(info, token, content, sha)
  if (info.platform === 'aone-code') return aoneWriteFile(info, token, content)
  throw new Error(`不支持的平台: ${info.platform}`)
}

export async function testGitToken(
  info: GitPlatformInfo,
  token: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await readGitFile(info, token)
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

/**
 * Build a fetch-ready URL for Aone Code sources by appending private_token.
 * For non-Aone-Code URLs, returns the original URL unchanged.
 */
export function buildAuthenticatedUrl(
  url: string,
  info: GitPlatformInfo | null,
  token?: string
): string {
  if (!info || !token) return url
  if (info.platform === 'aone-code') {
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}private_token=${token}`
  }
  return url
}
