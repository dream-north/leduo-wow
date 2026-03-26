// test-asr-flash.mjs — 大词汇表召回率测试: DashScope 原生 API + system 词汇
// 用法: node test-asr-flash.mjs [录音秒数，默认8]
//
// 预期说: "我要用ClaudeCode分析PanguSupervisor代码，这是盘古的重要模块，由磐石团队管理"
//
// 测试矩阵:
//   A: 无词汇（对照）
//   B: 仅4个目标词（baseline）
//   C: ~15 词（目标词 + 少量填充）
//   D: ~50 词（目标词埋在大量无关词中）
//   E: ~120 词（压力测试）
//   F: ~120 词但不含目标词（假阳性测试）

import { readFileSync, unlinkSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'

const configPath = join(homedir(), 'Library/Application Support/leduo-wow/config.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const apiKey = config.asrApiKey || config.polishApiKey
const duration = parseInt(process.argv[2]) || 8

// ============ 词汇表定义 ============

// 目标关键词（必须出现在语音中）
const targetWords = ['ClaudeCode', 'PanguSupervisor', '盘古', '磐石']

// 填充词汇 - 真实技术场景中可能出现的各种专有名词
const paddingSmall = [
  'Kubernetes', 'Docker', 'Prometheus', 'Grafana',
  'ElasticSearch', 'MongoDB', 'PostgreSQL', 'Redis',
  '天工', '昆仑', '鸿蒙'
]

const paddingMedium = [
  ...paddingSmall,
  'TensorFlow', 'PyTorch', 'NVIDIA', 'OpenAI', 'Anthropic',
  'WebSocket', 'gRPC', 'GraphQL', 'RESTful', 'OAuth',
  'Jenkins', 'GitLab', 'ArgoCD', 'Terraform', 'Ansible',
  'RabbitMQ', 'Kafka', 'Flink', 'Spark', 'Hadoop',
  '麒麟', '鲲鹏', '昇腾', '欧拉', '高斯',
  'DashScope', 'MaxCompute', 'DataWorks', 'PAI', 'ODPS',
  '通义千问', '百川', '智谱', '文心一言', 'DeepSeek',
  'VSCode', 'IntelliJ', 'Cursor', 'Copilot', 'Windsurf'
]

const paddingLarge = [
  ...paddingMedium,
  // 云服务 & 基础设施
  'CloudFormation', 'Lambda', 'ECS', 'Fargate', 'S3',
  'DynamoDB', 'Aurora', 'Redshift', 'Kinesis', 'SageMaker',
  'AzureDevOps', 'CosmosDB', 'ServiceBus', 'EventGrid',
  'CloudFlare', 'Vercel', 'Netlify', 'Supabase', 'PlanetScale',
  // 编程语言 & 框架
  'TypeScript', 'Rust', 'Golang', 'Kotlin', 'Swift',
  'React', 'Vue', 'Angular', 'Svelte', 'NextJS',
  'NestJS', 'FastAPI', 'Django', 'SpringBoot', 'Gin',
  'Electron', 'Tauri', 'Flutter', 'SwiftUI', 'Jetpack',
  // 安全 & 监控
  'SonarQube', 'Snyk', 'Trivy', 'Falco', 'OPA',
  'Datadog', 'NewRelic', 'Splunk', 'PagerDuty', 'Sentry',
  // 中文技术名词
  '飞桨', '星河', '灵积', '百炼', '魔搭',
  '太初', '紫东', '悟道', '天基', '澜舟',
  '九章', '乾坤', '玄武', '朱雀', '青龙',
  '白泽', '混元', '元象', '序列猴子', '月之暗面',
  // 更多工具
  'Figma', 'Sketch', 'Notion', 'Linear', 'Jira',
  'Confluence', 'Slack', 'Discord', 'Lark', 'DingTalk',
  'GitHub', 'BitBucket', 'Gitee', 'Coding', 'Codeup'
]

// ============ 测试方案 ============

const tests = [
  {
    label: 'A 无词汇(对照)',
    system: undefined,
    wordCount: 0
  },
  {
    label: 'B 仅目标词(4词)',
    system: '以下是可能出现的专有名词：' + targetWords.join('、'),
    wordCount: targetWords.length
  },
  {
    label: 'C 小词汇表(15词)',
    system: '以下是可能出现的专有名词：' + [...targetWords, ...paddingSmall].join('、'),
    wordCount: targetWords.length + paddingSmall.length
  },
  {
    label: 'D 中词汇表(50词)',
    system: '以下是可能出现的专有名词：' + [...targetWords, ...paddingMedium].join('、'),
    wordCount: targetWords.length + paddingMedium.length
  },
  {
    label: 'E 大词汇表(120词)',
    system: '以下是可能出现的专有名词：' + [...targetWords, ...paddingLarge].join('、'),
    wordCount: targetWords.length + paddingLarge.length
  },
  {
    label: 'F 大表无目标(120词)',
    system: '以下是可能出现的专有名词：' + paddingLarge.join('、'),
    wordCount: paddingLarge.length
  },
]

// ============ 录音 ============

console.log('🎤 大词汇表召回率测试 — DashScope 原生 API + system 词汇')
console.log(`   录音 ${duration} 秒`)
console.log()
console.log('   请说: "我要用ClaudeCode分析PanguSupervisor代码，')
console.log('          这是盘古的重要模块，由磐石团队管理"')
console.log()
console.log('   测试方案:')
for (const t of tests) {
  const sysLen = t.system ? t.system.length : 0
  console.log(`     ${t.label}  (${t.wordCount}词, system ${sysLen}字符)`)
}
console.log()

for (let i = 3; i > 0; i--) {
  process.stdout.write(`   ${i}...`)
  execSync('sleep 1')
}
console.log('\n')
console.log('🔴 开始录音!')

const wavPath = '/tmp/test_asr_flash.wav'
try {
  execSync(
    `ffmpeg -y -f avfoundation -i ":default" -ar 16000 -ac 1 -t ${duration} -acodec pcm_s16le "${wavPath}" 2>/dev/null`,
    { stdio: ['inherit', 'pipe', 'pipe'], timeout: (duration + 5) * 1000 }
  )
} catch {
  if (!existsSync(wavPath)) { console.error('录音失败'); process.exit(1) }
}
console.log('⏹️  录音结束!\n')

const wavBuffer = readFileSync(wavPath)
const dataUri = `data:audio/wav;base64,${wavBuffer.toString('base64')}`
console.log(`[音频] ${(wavBuffer.length / 1024).toFixed(0)} KB\n`)

// ============ ASR 调用 ============

async function callDashScopeASR(label, systemText) {
  process.stdout.write(`[${label}] 识别中...`)
  try {
    const messages = []
    if (systemText !== undefined) {
      messages.push({ role: 'system', content: [{ text: systemText }] })
    }
    messages.push({ role: 'user', content: [{ audio: dataUri }] })

    const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen3-asr-flash',
        input: { messages },
        parameters: { result_format: 'message' }
      })
    })
    const json = await resp.json()
    if (json.code) {
      console.log(` 错误: ${json.message}`)
      return { text: '', error: json.message }
    }
    const text = json.output?.choices?.[0]?.message?.content?.[0]?.text || ''
    console.log(` "${text}"`)
    return { text }
  } catch (err) {
    console.log(` 请求失败: ${err.message}`)
    return { text: '', error: err.message }
  }
}

// ============ 主流程 ============

async function main() {
  const results = []
  for (const t of tests) {
    const r = await callDashScopeASR(t.label, t.system)
    results.push({ label: t.label, wordCount: t.wordCount, ...r })
    // 间隔避免限流
    await new Promise(r => setTimeout(r, 800))
  }

  // ---- 全文对比 ----
  console.log('\n' + '='.repeat(80))
  console.log('全文对比')
  console.log('='.repeat(80))
  for (const r of results) {
    const flag = r.error ? '❌' : '  '
    console.log(`${flag} [${r.label}] (${r.wordCount}词)`)
    console.log(`   → "${r.text}"`)
  }

  // ---- 关键词命中矩阵 ----
  console.log('\n' + '='.repeat(80))
  console.log('关键词命中矩阵')
  console.log('='.repeat(80))

  const colW = 20
  const header = '测试组'.padEnd(24) +
    targetWords.map(k => k.padEnd(colW)).join('') +
    '命中率'
  console.log(header)
  console.log('-'.repeat(24 + colW * targetWords.length + 6))

  for (const r of results) {
    if (r.error) continue
    let hits = 0
    const row = r.label.padEnd(24) +
      targetWords.map(kw => {
        // 大小写不敏感匹配
        const hit = r.text.toLowerCase().includes(kw.toLowerCase())
        if (hit) hits++
        const mark = hit ? '✅' : '❌'
        return (mark + ' ' + kw).padEnd(colW)
      }).join('')
    const rate = `${hits}/${targetWords.length}`
    console.log(row + rate)
  }

  // ---- 结论摘要 ----
  console.log('\n' + '='.repeat(80))
  console.log('结论摘要')
  console.log('='.repeat(80))

  const validResults = results.filter(r => !r.error)
  for (const r of validResults) {
    const hits = targetWords.filter(kw =>
      r.text.toLowerCase().includes(kw.toLowerCase())
    ).length
    const rate = ((hits / targetWords.length) * 100).toFixed(0)
    const bar = '█'.repeat(hits) + '░'.repeat(targetWords.length - hits)
    console.log(`  ${r.label}  ${bar}  ${rate}%  (${hits}/${targetWords.length})`)
  }

  // 对照 vs 最佳对比
  const controlHits = targetWords.filter(kw =>
    validResults[0]?.text.toLowerCase().includes(kw.toLowerCase())
  ).length
  const bestResult = validResults.reduce((best, r) => {
    const hits = targetWords.filter(kw =>
      r.text.toLowerCase().includes(kw.toLowerCase())
    ).length
    return hits > best.hits ? { ...r, hits } : best
  }, { hits: 0 })

  console.log()
  if (bestResult.hits > controlHits) {
    console.log(`  📈 最佳方案: ${bestResult.label}`)
    console.log(`     对照组命中 ${controlHits}/${targetWords.length}，最佳方案命中 ${bestResult.hits}/${targetWords.length}`)
    console.log(`     提升 +${bestResult.hits - controlHits} 个关键词`)
  } else if (bestResult.hits === controlHits && controlHits === targetWords.length) {
    console.log('  ✅ 所有方案都全部命中（ASR 本身就能正确识别这些词）')
  } else {
    console.log('  ⚠️  词汇注入未带来显著提升')
  }

  try { unlinkSync(wavPath) } catch {}
}

main().catch(console.error)
