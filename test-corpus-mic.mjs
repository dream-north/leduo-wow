// test-corpus-mic.mjs — 同一段录音，3 组不同 corpus 对比
// 用法: node test-corpus-mic.mjs [录音秒数，默认5]

import WebSocket from 'ws'
import { readFileSync, unlinkSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'

const configPath = join(homedir(), 'Library/Application Support/leduo-wow/config.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const apiKey = config.asrApiKey
const duration = parseInt(process.argv[2]) || 5

console.log(`🎤 录音 ${duration} 秒，请说包含"乐多汪汪"的句子`)
console.log()

// 倒计时
for (let i = 3; i > 0; i--) {
  process.stdout.write(`   ${i}...`)
  execSync('sleep 1')
}
console.log('\n')
console.log('🔴 开始录音!')

const wavPath = '/tmp/test_mic_corpus.wav'
try {
  execSync(
    `ffmpeg -y -f avfoundation -i ":default" -ar 16000 -ac 1 -t ${duration} -acodec pcm_s16le "${wavPath}" 2>/dev/null`,
    { stdio: ['inherit', 'pipe', 'pipe'], timeout: (duration + 5) * 1000 }
  )
} catch {
  if (!existsSync(wavPath)) { console.error('录音失败'); process.exit(1) }
}
console.log('⏹️  录音结束!\n')

const pcmData = readFileSync(wavPath).subarray(44)
console.log(`[音频] ${(pcmData.length / 32000).toFixed(1)} 秒\n`)

const model = 'qwen3-asr-flash-realtime'
const baseUrl = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${model}`

function runASR(label, sessionConfig) {
  return new Promise((resolve) => {
    const ws = new WebSocket(baseUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'realtime=v1' }
    })
    let finalText = ''
    let partials = []

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session.update', session: sessionConfig }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'session.updated') {
        process.stdout.write(`[${label}] 识别中...`)
        const chunkSize = 8192
        for (let i = 0; i < pcmData.length; i += chunkSize) {
          ws.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: pcmData.subarray(i, Math.min(i + chunkSize, pcmData.length)).toString('base64')
          }))
        }
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
        ws.send(JSON.stringify({ type: 'session.finish' }))
      }
      if (msg.type === 'conversation.item.input_audio_transcription.text') {
        const t = msg.transcript || msg.stash || msg.text || msg.delta || ''
        if (t) partials.push(t)
      }
      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        finalText = msg.transcript || msg.text || ''
        console.log(` "${finalText}"`)
      }
      if (msg.type === 'session.finished' || msg.type === 'error') ws.close()
    })
    ws.on('close', () => resolve({ finalText: finalText || partials[partials.length - 1] || '' }))
    ws.on('error', (err) => { console.log(` 错误: ${err.message}`); resolve({ finalText: '' }) })
    setTimeout(() => ws.close(), 30000)
  })
}

const base = {
  modalities: ['text'], input_audio_format: 'pcm', sample_rate: 16000,
  input_audio_transcription: { language: 'zh' }, turn_detection: null
}

async function main() {
  const tests = [
    { label: 'A 无corpus     ', config: { ...base } },
    { label: 'B corpus=乐多汪汪', config: { ...base, corpus: { text: '乐多汪汪' } } },
    { label: 'C corpus=乐多旺旺', config: { ...base, corpus: { text: '乐多旺旺' } } },
  ]

  const results = []
  for (const t of tests) {
    const r = await runASR(t.label, t.config)
    results.push({ label: t.label, text: r.finalText })
    await new Promise(r => setTimeout(r, 1500))
  }

  console.log('\n' + '='.repeat(60))
  console.log('对比结果')
  console.log('='.repeat(60))
  for (const r of results) {
    console.log(`  ${r.label}  →  "${r.text}"`)
  }
  console.log()

  const allSame = results.every(r => r.text === results[0].text)
  if (allSame) {
    console.log('📋 三组结果完全相同 — corpus 参数无效')
  } else {
    console.log('🎉 结果存在差异！corpus 可能影响了识别:')
    const unique = [...new Set(results.map(r => r.text))]
    unique.forEach(t => {
      const which = results.filter(r => r.text === t).map(r => r.label.trim())
      console.log(`  "${t}"  ←  ${which.join(', ')}`)
    })
  }

  try { unlinkSync(wavPath) } catch {}
}

main().catch(console.error)
