import { createServer } from "node:http"
import type { Server } from "node:http"

export interface CallbackResult {
  code?: string
  error?: string
  errorDescription?: string
}

export interface CallbackServer {
  result: Promise<CallbackResult>
  close: () => void
}

// Starts a one-shot local listener for the redirect leg of the authorization
// code flow. Bound to 127.0.0.1 (not "localhost") to sidestep dual-stack
// resolution mismatches between what the browser dials and what Node binds.
export function startCallbackServer(opts: {
  port: number
  path: string
  state: string
  /** Give up and resolve with {error:"timeout"} if no redirect arrives in time -- otherwise a closed browser tab hangs the login forever. */
  timeoutMs?: number
}): Promise<CallbackServer> {
  return new Promise((resolveReady, rejectReady) => {
    let resolveResult!: (value: CallbackResult) => void
    let settled = false
    let bound = false
    let timeoutHandle: NodeJS.Timeout | undefined

    const result = new Promise<CallbackResult>((res) => {
      resolveResult = res
    })

    const finish = (value: CallbackResult) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      resolveResult(value)
      setImmediate(() => server.close())
    }

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`)
      if (url.pathname !== opts.path) {
        res.writeHead(404).end()
        return
      }

      const error = url.searchParams.get("error")
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")

      if (error) {
        const errorDescription = url.searchParams.get("error_description") ?? undefined
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(renderPage(false, errorDescription ?? error))
        finish({ error, errorDescription })
      } else if (!code || state !== opts.state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(renderPage(false, "Invalid or missing state/code."))
        finish({ error: "invalid_state" })
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(renderPage(true))
        finish({ code })
      }
    })

    // A permanent listener, not `.once()`: a bind failure (port in use) has
    // to reject startup, but an error after that -- a reset connection
    // mid-redirect, say -- must not be left for Node's default "unhandled
    // error crashes the process" behavior. Once bound, treat later errors as
    // a failed login instead.
    server.on("error", (err) => {
      if (!bound) {
        rejectReady(err)
        return
      }
      finish({ error: "server_error", errorDescription: err.message })
    })

    server.listen(opts.port, "127.0.0.1", () => {
      bound = true
      if (opts.timeoutMs) {
        timeoutHandle = setTimeout(() => {
          finish({
            error: "timeout",
            errorDescription: `Timed out waiting ${Math.round(opts.timeoutMs! / 1000)}s for the browser login to complete.`,
          })
        }, opts.timeoutMs)
      }
      resolveReady({ result, close: () => server.close() })
    })
  })
}

function renderPage(success: boolean, detail?: string): string {
  const heading = success ? "Signed in" : "Sign-in failed"
  const body = success ? "You can close this tab and return to opencode." : escapeHtml(detail ?? "Please try again.")
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>opencode</title>
    <style>
      body { font-family: system-ui, sans-serif; display: flex; height: 100vh; align-items: center; justify-content: center; margin: 0; background: #0b0b0c; color: #eee; }
      .card { text-align: center; padding: 2rem; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${heading}</h1>
      <p>${body}</p>
    </div>
  </body>
</html>`
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}
