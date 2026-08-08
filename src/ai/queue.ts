type Job<T> = {
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

/**
 * Host-side LLM job queue. Concurrency 1 — parallel local Ollama/CUDA calls
 * are a common cause of "illegal memory access" GPU crashes.
 */
export class AiJobQueue {
  private queue: Job<unknown>[] = []
  private active = 0
  readonly maxConcurrency: number

  constructor(maxConcurrency = 1) {
    this.maxConcurrency = Math.max(1, Math.min(2, maxConcurrency))
  }

  get pending(): number {
    return this.queue.length + this.active
  }

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.pump()
    })
  }

  private pump() {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.active += 1
      void job
        .run()
        .then((value) => job.resolve(value))
        .catch((err) => job.reject(err))
        .finally(() => {
          this.active -= 1
          this.pump()
        })
    }
  }
}

export const aiJobQueue = new AiJobQueue(1)
