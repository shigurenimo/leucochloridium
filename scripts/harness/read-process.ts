type Child = {
  stdout: ReadableStream
  stderr: ReadableStream
  exited: Promise<number>
  kill: () => void
}

export async function readProcess(child: Child, timeoutMs: number) {
  const observation = { timedOut: false }
  const timer = setTimeout(() => {
    observation.timedOut = true
    child.kill()
  }, timeoutMs)
  try {
    const outputs = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return {
      stdout: outputs[0],
      stderr: outputs[1],
      exitCode: outputs[2],
      timedOut: observation.timedOut,
    }
  } finally {
    clearTimeout(timer)
  }
}
