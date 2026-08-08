import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * GitHub Pages project sites live under /<repo>/; user/org sites use /.
 * CI sets BASE_PATH; local dev keeps '/'.
 */
function pagesBase(): string {
  const fromEnv = process.env.BASE_PATH
  if (fromEnv) return fromEnv.endsWith('/') ? fromEnv : `${fromEnv}/`

  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY) {
    const repo = process.env.GITHUB_REPOSITORY.split('/')[1] ?? ''
    if (repo.endsWith('.github.io')) return '/'
    return `/${repo}/`
  }

  return '/'
}

const GA_MEASUREMENT_ID = 'G-V6VJKD9PCZ'

/** Inject gtag only into production builds (GitHub Pages), never the Vite dev server. */
function injectGoogleAnalytics(): Plugin {
  const snippet = `
    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', '${GA_MEASUREMENT_ID}');
    </script>
`
  return {
    name: 'inject-google-analytics',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('</head>', `${snippet}</head>`)
    },
  }
}

const BENCH_FILE_RE = /^onw-bench-[a-zA-Z0-9._-]+\.json$/

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

/**
 * Dev-only API for local benchmark logs under ./benchmarks/.
 * Not registered for production builds — benchmark.html is also omitted from rollup input.
 */
function localBenchmarksApi(): Plugin {
  const root = path.resolve(__dirname, 'benchmarks')

  const ensureDir = () => {
    fs.mkdirSync(root, { recursive: true })
  }

  const listFiles = (): string[] => {
    ensureDir()
    return fs
      .readdirSync(root)
      .filter((name) => BENCH_FILE_RE.test(name))
      .sort()
  }

  return {
    name: 'local-benchmarks-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/__onw/benchmarks')) {
          next()
          return
        }

        try {
          const pathname = url.split('?')[0] ?? ''

          if (req.method === 'GET' && pathname === '/__onw/benchmarks') {
            sendJson(res, 200, { files: listFiles() })
            return
          }

          const fileMatch = pathname.match(
            /^\/__onw\/benchmarks\/([^/]+)$/,
          )
          if (req.method === 'GET' && fileMatch) {
            const name = decodeURIComponent(fileMatch[1]!)
            if (!BENCH_FILE_RE.test(name)) {
              sendJson(res, 400, { error: 'Invalid filename' })
              return
            }
            const filePath = path.join(root, name)
            if (!fs.existsSync(filePath)) {
              sendJson(res, 404, { error: 'Not found' })
              return
            }
            const text = fs.readFileSync(filePath, 'utf8')
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.end(text)
            return
          }

          if (req.method === 'POST' && pathname === '/__onw/benchmarks') {
            const raw = await readBody(req)
            let parsed: { filename?: unknown; body?: unknown }
            try {
              parsed = JSON.parse(raw.toString('utf8')) as {
                filename?: unknown
                body?: unknown
              }
            } catch {
              sendJson(res, 400, { error: 'Invalid JSON body' })
              return
            }
            const filename =
              typeof parsed.filename === 'string' ? parsed.filename : ''
            if (!BENCH_FILE_RE.test(filename)) {
              sendJson(res, 400, { error: 'Invalid filename' })
              return
            }
            if (parsed.body == null || typeof parsed.body !== 'object') {
              sendJson(res, 400, { error: 'Missing body object' })
              return
            }
            ensureDir()
            const filePath = path.join(root, filename)
            fs.writeFileSync(
              filePath,
              `${JSON.stringify(parsed.body, null, 2)}\n`,
              'utf8',
            )
            sendJson(res, 200, { ok: true, filename })
            return
          }

          if (req.method === 'DELETE' && pathname === '/__onw/benchmarks') {
            ensureDir()
            let deleted = 0
            for (const name of listFiles()) {
              fs.unlinkSync(path.join(root, name))
              deleted += 1
            }
            sendJson(res, 200, { ok: true, deleted })
            return
          }

          sendJson(res, 405, { error: 'Method not allowed' })
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), injectGoogleAnalytics(), localBenchmarksApi()],
  base: pagesBase(),
  // Production build stays single-page (index.html only). benchmark.html is
  // served in `vite` / `vite --` but never added to rollup input.
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
})
